/**
 * Anchor evaluation (design plan P3, Section 3, review S1/S4).
 *
 * An anchor is a read-only predicate string stored on a `Fact` that tests the fact's *proposition*
 * against real filesystem/git state — never a proxy for it (S1: "package-lock.json exists" does not
 * verify "uses npm", because a stale lockfile lingering after a switch is exactly the bug an anchor
 * must catch). Evaluation is three-valued, never a bare boolean:
 *   - `affirmed`     — the predicate positively confirms the proposition. Ground-truth eligible.
 *   - `unverified`    — the predicate cannot confirm or deny (missing files, no git repo, malformed
 *                        anchor, budget exceeded, or `anchor === null`). Hint-to-verify only.
 *   - `contradicted` — the predicate positively denies the proposition. Suppressed from ground truth.
 *
 * v1 supports filesystem/git predicates only (S4) — no "command output contains" / arbitrary-shell
 * anchors, and (deliberately stricter than the plan's minimum) no subprocess execution of any kind:
 * this module never shells out to `git` or anything else. `git-branch-is` and `git-tracked` are
 * answered by reading `.git/HEAD` and parsing `.git/index` directly, so anchor evaluation has zero
 * dependency on an external binary being installed, on PATH, or behaving a particular way across
 * versions — it is pure, synchronous, and bounded by nothing but disk I/O. Every predicate evaluates
 * against an explicit `root` (never ambient `process.cwd()`), and every path argument is resolved and
 * must stay within `root` (no traversal, no symlink escapes for `glob-exists`) — an anchor string can
 * originate from a `derived` (lower-trust) fact, so a malformed or adversarial anchor is rejected as
 * unverified rather than followed.
 *
 * Predicates: `file-exists <path>`, `file-absent <path>`, `file-newer-than <a> <b>`,
 * `file-contains <path> <substring...>`, `file-not-contains <path> <substring...>`,
 * `newest-of <expected> <candidate...>` (the direct implementation of the plan's P3 headline example,
 * "the newest lockfile is pnpm-lock.yaml"), `glob-exists <pattern>` (Section 3's "glob match"),
 * `git-branch-is <branch>`, `git-tracked <path>`, `package-version <path> <name>@<expected>`
 * (declared-manifest check only — see that predicate's own doc comment for the deliberate fence
 * against real semver-range-satisfaction or lockfile parsing).
 *
 * mem is a short-lived, single-shot CLI process (Section 3) — there is no cross-process cache to
 * invalidate. The in-memory memoization here exists only to avoid re-stat'ing / re-reading / re-parsing
 * shared inputs (a fact's full anchor result, a repo's parsed `.git/index`, a resolved `.git` dir) for
 * the common case of many facts sharing one root or one anchor within a single `mem` invocation; it is
 * safe precisely because the process does not live long enough for the underlying mtimes to change
 * under it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FreshnessVerdict } from "./types.js";

/**
 * Alias kept for readability within this module; identical to {@link FreshnessVerdict} in
 * src/types.ts (the shared vocabulary recall/review/hint-format also use), so callers may import
 * either name interchangeably.
 */
export type AnchorVerdict = FreshnessVerdict;

/** Cap on bytes read for `file-contains` / `file-not-contains` — keeps the anchor cheap and bounded (S4). */
const MAX_CONTENT_READ_BYTES = 1_000_000;

/** Cap on directory entries scanned for `glob-exists` — mirrors token-goat's bounded-walk precedent (S4). */
const MAX_GLOB_ENTRIES_SCANNED = 20_000;

/** Sanity bound on `.git/index` entry count — guards against a corrupt/hostile header, not real repos. */
const MAX_GIT_INDEX_ENTRIES = 2_000_000;

const memo = new Map<string, AnchorVerdict>();
const gitDirCache = new Map<string, string | null>();
const gitIndexCache = new Map<string, Set<string> | null>();

/** Test-only: clears all in-process memoization/caches. */
export function _clearAnchorMemoForTests(): void {
  memo.clear();
  gitDirCache.clear();
  gitIndexCache.clear();
}

/**
 * Resolves `pathArg` against `root` and returns the resolved absolute path, or `null` if the
 * resolved path escapes `root` (path traversal) or `pathArg` is itself an absolute path pointing
 * outside `root`. Root-scoping is enforced here so a malformed or adversarial anchor string can
 * never be used to probe files outside the project.
 */
function resolveWithinRoot(root: string, pathArg: string): string | null {
  const resolvedRoot = resolve(root);
  const candidate = isAbsolute(pathArg) ? resolve(pathArg) : resolve(resolvedRoot, pathArg);
  const rel = relative(resolvedRoot, candidate);
  if (rel === "" || (rel !== ".." && !rel.startsWith(".." + "/") && !rel.startsWith(".." + "\\") && !isAbsolute(rel))) {
    return candidate;
  }
  return null;
}

/** Returns the file's mtime in ms, or `null` if it does not exist / cannot be stat'd. */
function mtimeOrNull(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function existsFile(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function budgetExceeded(deadlineMs: number | undefined): boolean {
  return deadlineMs !== undefined && Date.now() >= deadlineMs;
}

/**
 * `file-newer-than <a> <b>` — tests whether `a` is the currently-active file relative to `b`.
 * affirmed: `a` exists and is newer than `b` (or `b` does not exist).
 * contradicted: `b` exists and is newer than `a` (or `a` does not exist while `b` does).
 * unverified: neither file exists, or both exist with identical mtimes (ambiguous).
 */
function evaluateFileNewerThan(mtimeA: number | null, mtimeB: number | null): AnchorVerdict {
  if (mtimeA === null && mtimeB === null) {
    return "unverified";
  }
  if (mtimeA === null) {
    return "contradicted";
  }
  if (mtimeB === null) {
    return "affirmed";
  }
  if (mtimeA === mtimeB) {
    return "unverified";
  }
  return mtimeA > mtimeB ? "affirmed" : "contradicted";
}

/**
 * `file-contains <path> <substring>` / `file-not-contains <path> <substring>` — affirmed if `path`
 * exists, is a plain file within the read budget, and does (or does not, for the negated form)
 * contain `substring`. unverified if the file is missing (S1: a moved/renamed file is the exact
 * proxy-anchor trap, don't guess), is not a plain file, exceeds the read budget, or can't be read.
 */
function evaluateFileContains(path: string, substring: string, negate: boolean): AnchorVerdict {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return "unverified";
  }
  if (!stat.isFile() || stat.size > MAX_CONTENT_READ_BYTES) {
    return "unverified";
  }
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return "unverified";
  }
  const found = content.includes(substring);
  if (negate) {
    return found ? "contradicted" : "affirmed";
  }
  return found ? "affirmed" : "contradicted";
}

/**
 * `package-version <path> <name>@<expected>` — declared-manifest check only, never an
 * installed/lockfile-resolved version check (S1: a predicate that can falsely affirm a version fact
 * is worse than no predicate at all — see the module header comment). Reads `path` (expected to be a
 * `package.json`), looks up `name` in `dependencies` then `devDependencies`, and compares the declared
 * range string against `expected` using only two confidently-resolvable comparisons: an exact string
 * match, or a leftmost-numeric-major-version-prefix match (e.g. declared `^18.2.0` affirms expected
 * `18`). This is deliberately **not** a semver-range-satisfaction check and does **not** consult any
 * lockfile — anything the comparison cannot confidently resolve (a range operator other than a bare
 * leading `^`/`~`/exact, a non-numeric expected value, ...) returns `unverified` rather than guess.
 * unverified: path unreadable/oversized, JSON malformed, or the dependency key is missing entirely.
 */
function comparePackageVersion(declared: string, expected: string): AnchorVerdict {
  if (declared === expected) {
    return "affirmed";
  }
  const declaredMajorMatch = /^[\^~]?(\d+)(?:\.|$)/u.exec(declared.trim());
  const expectedMajorMatch = /^(\d+)$/u.exec(expected.trim());
  if (declaredMajorMatch?.[1] !== undefined && expectedMajorMatch?.[1] !== undefined) {
    return declaredMajorMatch[1] === expectedMajorMatch[1] ? "affirmed" : "contradicted";
  }
  return "unverified";
}

function evaluatePackageVersion(path: string, expected: string): AnchorVerdict {
  const atIdx = expected.lastIndexOf("@");
  if (atIdx <= 0) {
    return "unverified";
  }
  const name = expected.slice(0, atIdx);
  const version = expected.slice(atIdx + 1);
  if (name.length === 0 || version.length === 0) {
    return "unverified";
  }

  let stat;
  try {
    stat = statSync(path);
  } catch {
    return "unverified";
  }
  if (!stat.isFile() || stat.size > MAX_CONTENT_READ_BYTES) {
    return "unverified";
  }
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return "unverified";
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch {
    return "unverified";
  }
  if (typeof manifest !== "object" || manifest === null) {
    return "unverified";
  }
  const deps = (manifest as Record<string, unknown>)["dependencies"];
  const devDeps = (manifest as Record<string, unknown>)["devDependencies"];
  const declared =
    (typeof deps === "object" && deps !== null ? (deps as Record<string, unknown>)[name] : undefined) ??
    (typeof devDeps === "object" && devDeps !== null ? (devDeps as Record<string, unknown>)[name] : undefined);
  if (typeof declared !== "string") {
    return "unverified";
  }
  return comparePackageVersion(declared, version);
}

/**
 * `newest-of <expected> <candidate...>` — among the full candidate set (`expected` plus every other
 * candidate), affirmed if `expected` is the sole existing candidate with the greatest mtime;
 * contradicted if a different existing candidate is the sole newest; unverified if none of the
 * candidates exist, or two or more candidates tie for newest (ambiguous — P3: never guess). This is
 * the direct implementation of the design plan's headline example (P3): "the newest lockfile is
 * pnpm-lock.yaml" — unlike a proxy check ("does pnpm-lock.yaml exist"), a stale lockfile left behind
 * after a package-manager switch cannot make this affirm, because it will not be the newest.
 */
function evaluateNewestOf(mtimes: ReadonlyMap<string, number>, expected: string): AnchorVerdict {
  if (mtimes.size === 0) {
    return "unverified";
  }
  let maxMtime = -Infinity;
  for (const mtime of mtimes.values()) {
    if (mtime > maxMtime) {
      maxMtime = mtime;
    }
  }
  const newest = [...mtimes.entries()].filter(([, mtime]) => mtime === maxMtime).map(([path]) => path);
  const only = newest.length === 1 ? newest[0] : undefined;
  if (only === undefined) {
    return "unverified";
  }
  return only === expected ? "affirmed" : "contradicted";
}

function segmentToRegExp(segment: string): RegExp {
  let pattern = "^";
  for (const ch of segment) {
    if (ch === "*") {
      pattern += "[^/\\\\]*";
    } else if (ch === "?") {
      pattern += "[^/\\\\]";
    } else {
      pattern += /[.*+?^${}()|[\]\\]/u.test(ch) ? `\\${ch}` : ch;
    }
  }
  pattern += "$";
  return new RegExp(pattern);
}

/**
 * `glob-exists <pattern>` — pattern segments are separated by `/` and support `*`, `?`, and a
 * recursive `**` segment. Affirmed if at least one filesystem entry under `root` matches; contradicted
 * if the walk completes with no match; unverified if the walk exceeds its entry-count or time budget
 * before resolving (S4: never guess under a budget cutoff). Symlinks are never followed (root-scoping
 * — a symlink could otherwise point outside `root`) and `.git`/`node_modules` are always skipped
 * (S4: anchors must stay cheap; those trees are large and never what a fact's proposition means).
 */
function evaluateGlobExists(root: string, pattern: string, deadlineMs: number | undefined): AnchorVerdict {
  const segments = pattern.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.includes("..")) {
    return "unverified";
  }

  let scanned = 0;
  let budgetHit = false;
  const stack: Array<{ dir: string; segIdx: number }> = [{ dir: root, segIdx: 0 }];

  walk: while (stack.length > 0) {
    if (budgetExceeded(deadlineMs)) {
      budgetHit = true;
      break;
    }
    const top = stack.pop();
    if (top === undefined) {
      break;
    }
    const segment = segments[top.segIdx];
    if (segment === undefined) {
      continue;
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(top.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    if (segment === "**") {
      const restIdx = top.segIdx + 1;
      if (restIdx < segments.length) {
        stack.push({ dir: top.dir, segIdx: restIdx });
      }
      for (const entry of entries) {
        scanned += 1;
        if (scanned > MAX_GLOB_ENTRIES_SCANNED) {
          budgetHit = true;
          break walk;
        }
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          continue;
        }
        if (entry.name === ".git" || entry.name === "node_modules") {
          continue;
        }
        stack.push({ dir: join(top.dir, entry.name), segIdx: top.segIdx });
      }
      continue;
    }

    const isLast = top.segIdx === segments.length - 1;
    const regex = segmentToRegExp(segment);
    for (const entry of entries) {
      scanned += 1;
      if (scanned > MAX_GLOB_ENTRIES_SCANNED) {
        budgetHit = true;
        break walk;
      }
      if (entry.isSymbolicLink() || !regex.test(entry.name)) {
        continue;
      }
      if (isLast) {
        return "affirmed";
      }
      if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") {
        stack.push({ dir: join(top.dir, entry.name), segIdx: top.segIdx + 1 });
      }
    }
  }

  return budgetHit ? "unverified" : "contradicted";
}

/**
 * Resolves the `.git` metadata directory for `root`, following a worktree/submodule `gitdir:` pointer
 * file when `.git` is a file rather than a directory. Returns `null` if `root` is not a git working
 * tree. Cached per `root` for the lifetime of the process (see module header).
 */
function resolveGitDirUncached(root: string): string | null {
  const dotGitPath = join(root, ".git");
  let stat;
  try {
    stat = statSync(dotGitPath);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    return dotGitPath;
  }
  if (!stat.isFile()) {
    return null;
  }
  let content: string;
  try {
    content = readFileSync(dotGitPath, "utf8");
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+)$/mu.exec(content.trim());
  const pointer = match?.[1]?.trim();
  if (pointer === undefined || pointer.length === 0) {
    return null;
  }
  const gitDir = isAbsolute(pointer) ? resolve(pointer) : resolve(root, pointer);
  try {
    return statSync(gitDir).isDirectory() ? gitDir : null;
  } catch {
    return null;
  }
}

function resolveGitDir(root: string): string | null {
  const cached = gitDirCache.get(root);
  if (cached !== undefined) {
    return cached;
  }
  const result = resolveGitDirUncached(root);
  gitDirCache.set(root, result);
  return result;
}

/**
 * `git-branch-is <branch>` — reads `.git/HEAD` directly (no `git` subprocess). Affirmed if the
 * checked-out branch equals `branch`; contradicted if a different branch is checked out; unverified
 * if `root` is not a git working tree, HEAD is detached (no branch to compare), or HEAD cannot be
 * parsed.
 */
function evaluateGitBranchIs(root: string, branch: string): AnchorVerdict {
  const gitDir = resolveGitDir(root);
  if (gitDir === null) {
    return "unverified";
  }
  let head: string;
  try {
    head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return "unverified";
  }
  const match = /^ref:\s*refs\/heads\/(.+)$/u.exec(head);
  const currentBranch = match?.[1]?.trim();
  if (currentBranch === undefined || currentBranch.length === 0) {
    return "unverified";
  }
  return currentBranch === branch ? "affirmed" : "contradicted";
}

/**
 * Parses `.git/index` (version 2 or 3 only — version 4 uses path-prefix compression, a materially
 * different byte layout, and is deliberately not supported) and returns the set of tracked path
 * strings (POSIX-style, relative to the working tree root), or `null` if the index cannot be
 * confidently parsed. Every offset is bounds-checked before use; any anomaly aborts the whole parse
 * and returns `null` rather than risk silently misreading a later entry (P3: never fabricate a
 * verdict from an uncertain read).
 */
function readGitIndexPathsUncached(gitDir: string): Set<string> | null {
  const indexPath = join(gitDir, "index");
  let buf: Buffer;
  try {
    buf = readFileSync(indexPath);
  } catch {
    // No index file yet (freshly initialized, empty repo) — correctly "nothing tracked", not an error.
    return new Set();
  }
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "DIRC") {
    return null;
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    return null;
  }
  const entryCount = buf.readUInt32BE(8);
  if (entryCount > MAX_GIT_INDEX_ENTRIES) {
    return null;
  }

  const paths = new Set<string>();
  let offset = 12;
  for (let i = 0; i < entryCount; i++) {
    const entryStart = offset;
    const flagsPos = entryStart + 60;
    if (flagsPos + 2 > buf.length) {
      return null;
    }
    const flags = buf.readUInt16BE(flagsPos);
    const extended = (flags & 0x4000) !== 0;
    let pathStart = entryStart + 62;
    if (version === 3 && extended) {
      if (pathStart + 2 > buf.length) {
        return null;
      }
      pathStart += 2;
    }
    const nameLenField = flags & 0x0fff;
    let pathEnd: number;
    if (nameLenField === 0x0fff) {
      pathEnd = buf.indexOf(0, pathStart);
      if (pathEnd === -1) {
        return null;
      }
    } else {
      pathEnd = pathStart + nameLenField;
      if (pathEnd >= buf.length || buf.readUInt8(pathEnd) !== 0) {
        return null;
      }
    }
    paths.add(buf.toString("utf8", pathStart, pathEnd));
    const dataLen = pathEnd + 1 - entryStart;
    offset = entryStart + Math.ceil(dataLen / 8) * 8;
    if (offset > buf.length) {
      return null;
    }
  }
  return paths;
}

function readGitIndexPaths(gitDir: string): Set<string> | null {
  const cached = gitIndexCache.get(gitDir);
  if (cached !== undefined) {
    return cached;
  }
  const result = readGitIndexPathsUncached(gitDir);
  gitIndexCache.set(gitDir, result);
  return result;
}

/**
 * `git-tracked <path>` — parses `.git/index` directly (no `git` subprocess). Affirmed if `path`
 * (relative to `root`) appears in the index; contradicted if the index parses cleanly and `path` is
 * absent from it; unverified if `root` is not a git working tree or the index cannot be confidently
 * parsed (e.g. index format version 4, corrupt header).
 */
function evaluateGitTracked(root: string, resolvedPath: string): AnchorVerdict {
  const gitDir = resolveGitDir(root);
  if (gitDir === null) {
    return "unverified";
  }
  const paths = readGitIndexPaths(gitDir);
  if (paths === null) {
    return "unverified";
  }
  const relPath = relative(root, resolvedPath).split(sep).join("/");
  return paths.has(relPath) ? "affirmed" : "contradicted";
}

/** Parses an anchor string into whitespace-separated tokens. No quoting support (not needed for fs/git paths). */
function tokenize(anchor: string): string[] {
  return anchor.trim().split(/\s+/u).filter((token) => token.length > 0);
}

function evaluateTokens(tokens: readonly string[], root: string, deadlineMs: number | undefined): AnchorVerdict {
  const [predicate, ...args] = tokens;
  const resolvedRoot = resolve(root);

  switch (predicate) {
    case "file-newer-than": {
      if (args.length !== 2) {
        return "unverified";
      }
      const [rawA, rawB] = args;
      if (rawA === undefined || rawB === undefined) {
        return "unverified";
      }
      const a = resolveWithinRoot(resolvedRoot, rawA);
      const b = resolveWithinRoot(resolvedRoot, rawB);
      if (a === null || b === null) {
        return "unverified";
      }
      return evaluateFileNewerThan(mtimeOrNull(a), mtimeOrNull(b));
    }
    case "file-exists": {
      const [rawA] = args;
      if (args.length !== 1 || rawA === undefined) {
        return "unverified";
      }
      const a = resolveWithinRoot(resolvedRoot, rawA);
      if (a === null) {
        return "unverified";
      }
      return existsFile(a) ? "affirmed" : "contradicted";
    }
    case "file-absent": {
      const [rawA] = args;
      if (args.length !== 1 || rawA === undefined) {
        return "unverified";
      }
      const a = resolveWithinRoot(resolvedRoot, rawA);
      if (a === null) {
        return "unverified";
      }
      return existsFile(a) ? "contradicted" : "affirmed";
    }
    case "newest-of": {
      if (args.length < 2) {
        return "unverified";
      }
      const [expectedRaw, ...restRaw] = args;
      if (expectedRaw === undefined) {
        return "unverified";
      }
      const expectedResolved = resolveWithinRoot(resolvedRoot, expectedRaw);
      if (expectedResolved === null) {
        return "unverified";
      }
      const mtimes = new Map<string, number>();
      const expMtime = mtimeOrNull(expectedResolved);
      if (expMtime !== null) {
        mtimes.set(expectedResolved, expMtime);
      }
      for (const rawCandidate of restRaw) {
        const resolved = resolveWithinRoot(resolvedRoot, rawCandidate);
        if (resolved === null) {
          return "unverified";
        }
        const mtime = mtimeOrNull(resolved);
        if (mtime !== null) {
          mtimes.set(resolved, mtime);
        }
      }
      return evaluateNewestOf(mtimes, expectedResolved);
    }
    case "glob-exists": {
      const [pattern] = args;
      if (args.length !== 1 || pattern === undefined || isAbsolute(pattern)) {
        return "unverified";
      }
      return evaluateGlobExists(resolvedRoot, pattern, deadlineMs);
    }
    case "git-branch-is": {
      const [branch] = args;
      if (args.length !== 1 || branch === undefined || branch.length === 0) {
        return "unverified";
      }
      return evaluateGitBranchIs(resolvedRoot, branch);
    }
    case "package-version": {
      const [rawPath, expected] = args;
      if (args.length !== 2 || rawPath === undefined || expected === undefined) {
        return "unverified";
      }
      const resolved = resolveWithinRoot(resolvedRoot, rawPath);
      if (resolved === null) {
        return "unverified";
      }
      if (budgetExceeded(deadlineMs)) {
        return "unverified";
      }
      return evaluatePackageVersion(resolved, expected);
    }
    case "git-tracked": {
      const [rawA] = args;
      if (args.length !== 1 || rawA === undefined) {
        return "unverified";
      }
      const a = resolveWithinRoot(resolvedRoot, rawA);
      if (a === null) {
        return "unverified";
      }
      if (budgetExceeded(deadlineMs)) {
        return "unverified";
      }
      return evaluateGitTracked(resolvedRoot, a);
    }
    default:
      return "unverified";
  }
}

/**
 * `file-contains`/`file-not-contains` take a free-text substring that may itself contain
 * whitespace, so — unlike every other predicate — they are matched against the raw anchor text
 * (predicate name, then one path token, then everything else verbatim) rather than through the
 * generic whitespace tokenizer.
 */
function evaluateFileContainsRaw(trimmed: string, resolvedRoot: string, deadlineMs: number | undefined): AnchorVerdict | undefined {
  const match = /^(file-contains|file-not-contains)\s+(\S+)\s+([\s\S]+)$/u.exec(trimmed);
  if (match === null) {
    return undefined;
  }
  const predicate = match[1];
  const rawPath = match[2];
  const substring = match[3];
  if (predicate === undefined || rawPath === undefined || substring === undefined) {
    return "unverified";
  }
  const resolvedPath = resolveWithinRoot(resolvedRoot, rawPath);
  if (resolvedPath === null) {
    return "unverified";
  }
  if (budgetExceeded(deadlineMs)) {
    return "unverified";
  }
  return evaluateFileContains(resolvedPath, substring, predicate === "file-not-contains");
}

/**
 * Evaluates a fact's anchor predicate against `root`.
 *
 * `anchor === null` is always `unverified` (P3: no predicate means the proposition can neither be
 * confirmed nor denied — a hint-to-verify, never ground truth). `deadlineMs`, if given, is an
 * absolute `Date.now()`-based deadline; once passed, evaluation stops attempting further work and
 * returns `unverified` — the safe direction (never fabricate `affirmed`, never falsely claim
 * `contradicted`) rather than risk an unbounded directory walk or index parse in the recall hot path.
 */
export function evaluateAnchor(anchor: string | null, root: string, deadlineMs?: number): AnchorVerdict {
  if (anchor === null || anchor.trim().length === 0) {
    return "unverified";
  }
  if (budgetExceeded(deadlineMs)) {
    return "unverified";
  }

  const resolvedRoot = resolve(root);
  const trimmed = anchor.trim();
  const key = `${resolvedRoot} ${trimmed}`;
  const cached = memo.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const containsResult = evaluateFileContainsRaw(trimmed, resolvedRoot, deadlineMs);
  const verdict = containsResult ?? evaluateTokens(tokenize(trimmed), resolvedRoot, deadlineMs);
  memo.set(key, verdict);
  return verdict;
}

/** Re-exported for callers building safe path arguments elsewhere (e.g. a future `mem remember --anchor` builder). */
export function anchorPathWithinRoot(root: string, pathArg: string): string | null {
  return resolveWithinRoot(resolve(root), pathArg);
}
