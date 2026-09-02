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
 * must stay within `root` (no traversal, no symlink escapes) — root-containment alone does not stop a
 * symlink *inside* `root` from pointing *outside* it, so every path-based predicate additionally
 * refuses to follow a symlink at the target path or at any directory component between `root` and the
 * target (`glob-exists` does this by skipping symlinked entries during its directory walk; every
 * other path-based predicate — `file-exists`, `file-absent`, `file-contains`/`file-not-contains`,
 * `package-version`, `file-newer-than`, `newest-of` — does it via an explicit `lstatSync`-based check
 * before any `statSync`/`readFileSync` of the resolved path(s)) — an anchor string can originate from a `derived`
 * (lower-trust) fact, so a malformed or adversarial anchor is rejected as unverified. A detected
 * symlink escape is *not* uniformly `contradicted`: `file-exists`/`file-absent` return `unverified`
 * (a symlink means mem cannot safely resolve the path, so it can assert neither presence nor absence —
 * `contradicted` would be a lie for whichever of the pair asserts absence, per P3), while
 * `file-newer-than`/`newest-of` still return `contradicted` for a symlinked comparison target.
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

import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/**
 * Cap on bytes read for `.git/index`. Generous on purpose — a 100k-file working tree indexes at
 * roughly 10 MB, so this bounds a pathological or adversarial file without rejecting a real repo.
 * Enforced by `statSync` before `readFileSync`, since `MAX_GIT_INDEX_ENTRIES` can only be checked
 * after the whole file is already resident.
 */
const MAX_GIT_INDEX_READ_BYTES = 32_000_000;

/** Cap on bytes read for a `.git` *file*: a `gitdir:` pointer is one short line, never kilobytes. */
const MAX_GIT_DIR_POINTER_BYTES = 4_096;

/** Sanity bound on `.git/index` entry count — guards against a corrupt/hostile header, not real repos. */
const MAX_GIT_INDEX_ENTRIES = 2_000_000;

/**
 * Whether this platform's filesystem resolves paths case-insensitively.
 *
 * Matters because mem's predicates split into two families that would otherwise disagree about the
 * same file. The stat-based ones (`file-exists`, `file-newer-than`, `newest-of`) inherit the OS's
 * own resolution and so already tolerate a casing difference; the two *string-matching* ones --
 * `glob-exists` (regex against directory entries) and `git-tracked` (comparison against
 * `.git/index` bytes) -- did not. On Windows that made `git-tracked SRC/Db.TS` return
 * `contradicted` for a file `file-exists src/db.ts` affirms, and `contradicted` suppresses a fact
 * from ground truth entirely: a casing typo became silent fact suppression, on the platform this
 * project is developed on.
 *
 * win32 only, deliberately. macOS is case-insensitive by default but supports case-sensitive APFS
 * volumes, so folding there would trade a false `contradicted` for a false `affirmed` -- the worse
 * error, because P3 forbids fabricating a verdict but permits declining to give one.
 */
const FS_CASE_INSENSITIVE = process.platform === "win32";

const memo = new Map<string, AnchorVerdict>();
const gitDirCache = new Map<string, string | null>();
const gitIndexCache = new Map<string, GitIndexParseResult | null>();
/** Lazily-built lowercase view of `gitIndexCache`, only ever populated on {@link FS_CASE_INSENSITIVE} platforms, so a case-folded lookup stays O(1) instead of rescanning the index set on every miss. */
const gitIndexFoldedCache = new Map<string, Set<string>>();

/**
 * Clears all in-process anchor memoization and caches.
 *
 * The memo has no invalidation and no size bound by design -- a `mem` CLI invocation is a
 * short-lived process, so "cache for the lifetime of the process" and "cache for the lifetime of
 * one command" are the same thing. That equivalence breaks for any embedder that keeps the module
 * loaded across calls (`buildHintFormat` is exported as a library seam for exactly that), where a
 * first-ever verdict would otherwise be served forever regardless of what changed on disk. Callers
 * that span more than one logical query must call this at the start of each.
 */
export function clearAnchorCaches(): void {
  memo.clear();
  gitDirCache.clear();
  gitIndexCache.clear();
  gitIndexFoldedCache.clear();
}

/** Test-only alias of {@link clearAnchorCaches}, kept for the existing test suite's call sites. */
export function _clearAnchorMemoForTests(): void {
  clearAnchorCaches();
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

/**
 * Returns `true` if `path` is itself a symlink. Unlike {@link containsSymlink} this checks the single
 * final component and takes no root, so it is usable on the `.git` machinery — whose resolved
 * location is legitimately outside `root` for submodules and worktrees, and therefore cannot be
 * root-contained without breaking them. Refusing a symlink is the containment that *is* available
 * there: it stops a planted `.git` from redirecting a read, while leaving every real layout working.
 */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Returns the file's mtime in ms, or `null` if it does not exist / cannot be stat'd. */
function mtimeOrNull(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Returns `true` if `target` itself, or any directory component between `root` and `target`, is a
 * symlink. Root-containment (`resolveWithinRoot`) only guarantees the *resolved* path stays inside
 * `root` — it says nothing about whether a symlink somewhere along that path hops outside `root`
 * before the filesystem gets there, so this is a separate, additional check. Mirrors `glob-exists`'s
 * own symlink refusal (it skips any `entry.isSymbolicLink()` encountered while walking, at every
 * directory level and for the final matched entry) for callers that stat/read a single resolved path
 * directly instead of walking a directory tree: every path component from `root` down to `target` is
 * `lstatSync`'d in turn, so a symlink anywhere in the chain — not just at the final component — is
 * caught. A missing component (nothing to detect, nothing to leak) is treated as "no symlink found"
 * and left for the caller's own `statSync`/`readFileSync` to report as missing.
 */
function containsSymlink(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    return false;
  }
  const segments = rel.split(sep).filter((segment) => segment.length > 0);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

/**
 * `file-exists <path>` / `file-absent <path>` — affirmed/contradicted based on whether `path` exists
 * as a plain entity reachable through `root` alone. Symlink refusal is handled by the caller
 * ({@link evaluateTokens}), which checks {@link containsSymlink} *before* calling this function and
 * returns `unverified` rather than treating the path as absent — this function is never reached for a
 * symlinked path or intermediate directory, so it performs a plain `statSync`.
 */
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
 * Mutable out-of-band signal threaded through a single {@link evaluateAnchor} call: set to `true`
 * only when a `deadlineMs` time-budget check (never the unrelated `MAX_GLOB_ENTRIES_SCANNED` scan
 * cap) is the reason evaluation bailed out to `"unverified"`. `evaluateAnchor` uses this to decide
 * whether the resulting `"unverified"` is a genuine predicate outcome (safe to memoize) or merely
 * "ran out of time this call" (must not be memoized, since a later call with a different/absent
 * deadline could reach a different, real verdict for the same anchor+root).
 */
interface BudgetState {
  hit: boolean;
}

/**
 * `file-newer-than <a> <b>` — tests whether `a` is the currently-active file relative to `b`.
 * affirmed: `a` exists and is newer than `b`.
 * contradicted: `b` exists and is newer than `a`, or `a` does not exist while `b` does, or `a`/`b`
 * (or a directory component between `root` and either) is a symlink ({@link containsSymlink}) —
 * refused rather than followed, for the same reason as `file-contains`.
 * unverified: neither file exists, both exist with identical mtimes (ambiguous), or `b` does not
 * exist (whether or not `a` does) — you cannot compare two files when one of them is missing, so
 * this can assert neither "newer" nor "older" (P3: never fabricate a verdict). Concretely: a fact
 * anchored `file-newer-than generated.ts schema.prisma` must not stay `affirmed` forever once
 * `schema.prisma` is deleted or moved — that is exactly the moment the fact stops being true, and
 * silently reporting "b does not exist" as "a is newer" would hide the staleness this anchor exists
 * to catch.
 */
function evaluateFileNewerThan(mtimeA: number | null, mtimeB: number | null): AnchorVerdict {
  if (mtimeB === null) {
    return "unverified";
  }
  if (mtimeA === null) {
    return "contradicted";
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
 * contradicted if `path` (or a directory component between `root` and `path`) is a symlink
 * ({@link containsSymlink}) — refused rather than followed, since a symlink inside `root` could point
 * outside it, and following it here would turn this predicate into a content-read oracle for
 * arbitrary filesystem locations.
 */
function evaluateFileContains(root: string, path: string, substring: string, negate: boolean): AnchorVerdict {
  if (containsSymlink(root, path)) {
    return "contradicted";
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
 * contradicted: `path` (or a directory component between `root` and `path`) is a symlink
 * ({@link containsSymlink}) — refused rather than followed, for the same reason as `file-contains`.
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

function evaluatePackageVersion(root: string, path: string, expected: string): AnchorVerdict {
  const atIdx = expected.lastIndexOf("@");
  if (atIdx <= 0) {
    return "unverified";
  }
  const name = expected.slice(0, atIdx);
  const version = expected.slice(atIdx + 1);
  if (name.length === 0 || version.length === 0) {
    return "unverified";
  }
  if (containsSymlink(root, path)) {
    return "contradicted";
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
 * contradicted if a different existing candidate is the sole newest, or if `expected` or any
 * candidate (or a directory component between `root` and any of them) is a symlink
 * ({@link containsSymlink}) — refused rather than followed, since trusting a symlinked candidate's
 * mtime (or silently dropping it) could make this predicate affirm based on a file outside `root`;
 * unverified if none of the candidates exist, or two or more candidates tie for newest (ambiguous —
 * P3: never guess). This is the direct implementation of the design plan's headline example (P3):
 * "the newest lockfile is pnpm-lock.yaml" — unlike a proxy check ("does pnpm-lock.yaml exist"), a
 * stale lockfile left behind after a package-manager switch cannot make this affirm, because it will
 * not be the newest.
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
  // See FS_CASE_INSENSITIVE: on Windows the walk below compares against real directory entries the
  // OS itself would resolve case-insensitively, so a case-sensitive regex reports `contradicted`
  // for a file that demonstrably exists.
  return new RegExp(pattern, FS_CASE_INSENSITIVE ? "i" : "");
}

/**
 * `glob-exists <pattern>` — pattern segments are separated by `/` (and, on {@link FS_CASE_INSENSITIVE}
 * platforms, also by `\` — Windows paths are routinely typed with either) and support `*`, `?`, and a
 * recursive `**` segment. A `.` segment (e.g. a leading `./`) is dropped rather than rejected, so
 * `./src/*.ts` and `src/*.ts` are the same pattern. Affirmed if at least one filesystem entry under
 * `root` matches; contradicted if the walk completes with no match; unverified if the walk exceeds its
 * entry-count or time budget before resolving (S4: never guess under a budget cutoff). Symlinks are
 * never followed (root-scoping — a symlink could otherwise point outside `root`). `.git`/`node_modules`
 * are skipped *only* when reached via a wildcard segment (`*`, `?`, or `**`) — that is the S4 cost
 * guard against walking those large, usually-irrelevant trees when the pattern didn't ask for them.
 * A pattern that *literally* names `.git` or `node_modules` as a segment (e.g.
 * `node_modules/pkg/index.js`, or `node_modules/**` to search inside it) is an explicit request to
 * descend there and is honored — contradicting a pattern that plainly names a file that exists is
 * exactly the fabrication P3 forbids.
 */
function evaluateGlobExists(
  root: string,
  pattern: string,
  deadlineMs: number | undefined,
  budgetState: BudgetState,
): AnchorVerdict {
  const segments = pattern
    .split(FS_CASE_INSENSITIVE ? /[/\\]/u : "/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    return "unverified";
  }

  let scanned = 0;
  let budgetHit = false;
  const stack: Array<{ dir: string; segIdx: number }> = [{ dir: root, segIdx: 0 }];

  walk: while (stack.length > 0) {
    if (budgetExceeded(deadlineMs)) {
      budgetHit = true;
      budgetState.hit = true;
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
      const trailing = restIdx >= segments.length;
      if (!trailing) {
        stack.push({ dir: top.dir, segIdx: restIdx });
      }
      for (const entry of entries) {
        scanned += 1;
        if (scanned > MAX_GLOB_ENTRIES_SCANNED) {
          budgetHit = true;
          break walk;
        }
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.name === ".git" || entry.name === "node_modules") {
          continue;
        }
        if (trailing) {
          // A trailing `**` matches everything under this directory, including this entry
          // itself (file or directory) — standard glob semantics for a trailing `/**` — so
          // any surviving entry here is an immediate affirm; no need to look deeper.
          return "affirmed";
        }
        if (entry.isDirectory()) {
          stack.push({ dir: join(top.dir, entry.name), segIdx: top.segIdx });
        }
      }
      continue;
    }

    const isLast = top.segIdx === segments.length - 1;
    const regex = segmentToRegExp(segment);
    // A literal segment (no `*`/`?`) names its target explicitly, so it is exempt from the
    // .git/node_modules skip below -- only a wildcard segment matched an entry it didn't ask for by
    // name.
    const segmentIsWildcard = /[*?]/u.test(segment);
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
      const skipCostlyDir = segmentIsWildcard && (entry.name === ".git" || entry.name === "node_modules");
      if (entry.isDirectory() && !skipCostlyDir) {
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
  // A symlinked `.git` would let anything that can write inside `root` redirect every subsequent
  // `HEAD`/`index` read at a path of its choosing. `statSync` follows the link, so the refusal has to
  // come first. Yields "unverified", never a fabricated verdict — matching `existsFile`'s stance.
  if (isSymlink(dotGitPath)) {
    return null;
  }
  let stat;
  try {
    stat = statSync(dotGitPath);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    return dotGitPath;
  }
  if (!stat.isFile() || stat.size > MAX_GIT_DIR_POINTER_BYTES) {
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
  if (isSymlink(gitDir)) {
    return null;
  }
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
  const headPath = join(gitDir, "HEAD");
  if (isSymlink(headPath)) {
    return "unverified";
  }
  let head: string;
  try {
    head = readFileSync(headPath, "utf8").trim();
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
 * Result of parsing `.git/index`'s entry table. `complete` is `false` when the index carries a
 * mandatory extension this parser does not understand — see {@link walkGitIndexExtensions} — meaning
 * `paths` reflects only what the entry table itself lists, not necessarily every path the index
 * actually tracks (a split index's main-index entry table omits paths unchanged since the last
 * split; a sparse index's collapsed directory entries omit paths outside the sparse cone). A miss
 * against `paths` when `complete` is `false` is not evidence of absence.
 */
interface GitIndexParseResult {
  readonly paths: Set<string>;
  readonly complete: boolean;
}

/** SHA-1 and SHA-256 digest lengths, in bytes — the two possible index-file trailers (`git-index-format`). */
const GIT_INDEX_TRAILER_LENGTHS = [20, 32] as const;

/**
 * Walks `.git/index`'s optional trailing extensions, starting at `startOffset` (immediately after
 * the last parsed entry), for one candidate trailer length. Returns `null` if the walk cannot be
 * made to land exactly on the trailer boundary with this trailer length (signaling the caller to
 * retry with the other length, or give up); otherwise returns whether every extension encountered
 * was safely skippable.
 *
 * Git's index-extension format (`git-index-format` documentation) reserves the case of an
 * extension's 4-byte signature to mean something: an uppercase first letter is optional -- a reader
 * that does not recognize it is free to skip the extension's `size` bytes and move on, which is
 * exactly what this walker always does, for every signature, known or not. A *lowercase* first
 * letter marks the extension mandatory: a reader that does not understand it is supposed to refuse
 * the whole index rather than silently proceed as if the extension were not there. `link` (split
 * index -- the main index holds only entries that differ from a `sharedindex.*` file, so the entry
 * table alone understates what is tracked) and `sdir` (sparse index -- an entire directory outside
 * the sparse-checkout cone collapses into one entry, so files under it never appear individually)
 * are the two mandatory extensions real repositories produce; both are lowercase for exactly this
 * reason. Skipping their bytes without reading their content is safe -- this parser makes no attempt
 * to resolve a delta or expand a collapsed directory -- but the *caller* must treat a lowercase-only
 * skip as "the entry table is not the whole truth" (`complete: false`) rather than "there are no
 * more tracked paths" (P3: a miss must not read as a fabricated absence).
 */
function walkGitIndexExtensionsWithTrailer(buf: Buffer, startOffset: number, trailerLength: number): boolean | null {
  let offset = startOffset;
  let sawMandatoryExtension = false;
  const end = buf.length - trailerLength;
  while (offset + 8 <= end) {
    const signature = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32BE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > end) {
      return null;
    }
    if (/^[a-z]/u.test(signature)) {
      sawMandatoryExtension = true;
    }
    offset = dataEnd;
  }
  if (offset !== end) {
    return null;
  }
  return !sawMandatoryExtension;
}

/**
 * Tries both possible trailer lengths ({@link GIT_INDEX_TRAILER_LENGTHS}) and accepts the first one
 * whose extension walk lands exactly on the trailer boundary. Returns `null` if neither does --
 * an index this parser cannot confidently account for byte-for-byte is one it refuses to trust at
 * all (P3), consistent with every other anomaly in {@link readGitIndexPathsUncached} aborting the
 * whole parse rather than returning a partial answer.
 */
function walkGitIndexExtensions(buf: Buffer, startOffset: number): boolean | null {
  for (const trailerLength of GIT_INDEX_TRAILER_LENGTHS) {
    const result = walkGitIndexExtensionsWithTrailer(buf, startOffset, trailerLength);
    if (result !== null) {
      return result;
    }
  }
  return null;
}

/**
 * Parses `.git/index` (version 2 or 3 only — version 4 uses path-prefix compression, a materially
 * different byte layout, and is deliberately not supported) and returns the set of tracked path
 * strings the entry table lists (POSIX-style, relative to the working tree root), plus whether that
 * set is the *complete* set of tracked paths ({@link GitIndexParseResult}) — or `null` if the index
 * cannot be confidently parsed. Every offset is bounds-checked before use; any anomaly aborts the
 * whole parse and returns `null` rather than risk silently misreading a later entry (P3: never
 * fabricate a verdict from an uncertain read).
 */
function readGitIndexPathsUncached(gitDir: string): GitIndexParseResult | null {
  const indexPath = join(gitDir, "index");
  if (isSymlink(indexPath)) {
    return null;
  }
  let size: number;
  try {
    size = statSync(indexPath).size;
  } catch {
    // No index file yet (freshly initialized, empty repo) — correctly "nothing tracked", not an error.
    return { paths: new Set(), complete: true };
  }
  if (size > MAX_GIT_INDEX_READ_BYTES) {
    return null;
  }
  let buf: Buffer;
  try {
    buf = readFileSync(indexPath);
  } catch {
    return { paths: new Set(), complete: true };
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
  const complete = walkGitIndexExtensions(buf, offset);
  if (complete === null) {
    return null;
  }
  return { paths, complete };
}

function readGitIndexPaths(gitDir: string): GitIndexParseResult | null {
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
 * (relative to `root`) appears in the index's entry table; unverified if `root` is not a git working
 * tree, the index cannot be confidently parsed (e.g. index format version 4, corrupt header), or
 * `path` is absent from the entry table but the index carries a mandatory extension this parser
 * cannot account for ({@link GitIndexParseResult.complete}) — a split index's `link` extension means
 * the main index's entry table omits paths unchanged since the last split, and a sparse index's
 * `sdir` extension means an entire directory outside the sparse-checkout cone collapses into one
 * entry, so a path under it never appears individually; either way, "not listed" is not "not
 * tracked" and asserting `contradicted` here would be exactly the fabrication P3 forbids. Only when
 * the entry table is the *complete* set of tracked paths does an absence become `contradicted`.
 */
function evaluateGitTracked(root: string, resolvedPath: string): AnchorVerdict {
  const gitDir = resolveGitDir(root);
  if (gitDir === null) {
    return "unverified";
  }
  const index = readGitIndexPaths(gitDir);
  if (index === null) {
    return "unverified";
  }
  const { paths, complete } = index;
  const relPath = relative(root, resolvedPath).split(sep).join("/");
  if (paths.has(relPath)) {
    return "affirmed";
  }
  // See FS_CASE_INSENSITIVE. `.git/index` stores one exact casing per path, but on Windows the
  // anchor's casing and the index's casing both resolve to the same file, so an exact-bytes miss is
  // not evidence the path is untracked.
  if (FS_CASE_INSENSITIVE && foldedGitIndexPaths(gitDir, paths).has(relPath.toLowerCase())) {
    return "affirmed";
  }
  return complete ? "contradicted" : "unverified";
}

function foldedGitIndexPaths(gitDir: string, paths: ReadonlySet<string>): ReadonlySet<string> {
  const cached = gitIndexFoldedCache.get(gitDir);
  if (cached !== undefined) {
    return cached;
  }
  const folded = new Set<string>();
  for (const path of paths) {
    folded.add(path.toLowerCase());
  }
  gitIndexFoldedCache.set(gitDir, folded);
  return folded;
}

/** Parses an anchor string into whitespace-separated tokens. No quoting support (not needed for fs/git paths). */
function tokenize(anchor: string): string[] {
  return anchor.trim().split(/\s+/u).filter((token) => token.length > 0);
}

function evaluateTokens(
  tokens: readonly string[],
  root: string,
  deadlineMs: number | undefined,
  budgetState: BudgetState,
): AnchorVerdict {
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
      if (containsSymlink(resolvedRoot, a) || containsSymlink(resolvedRoot, b)) {
        return "contradicted";
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
      if (containsSymlink(resolvedRoot, a)) {
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
      if (containsSymlink(resolvedRoot, a)) {
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
      if (containsSymlink(resolvedRoot, expectedResolved)) {
        return "contradicted";
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
        if (containsSymlink(resolvedRoot, resolved)) {
          return "contradicted";
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
      return evaluateGlobExists(resolvedRoot, pattern, deadlineMs, budgetState);
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
        budgetState.hit = true;
        return "unverified";
      }
      return evaluatePackageVersion(resolvedRoot, resolved, expected);
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
        budgetState.hit = true;
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
function evaluateFileContainsRaw(
  trimmed: string,
  resolvedRoot: string,
  deadlineMs: number | undefined,
  budgetState: BudgetState,
): AnchorVerdict | undefined {
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
    budgetState.hit = true;
    return "unverified";
  }
  return evaluateFileContains(resolvedRoot, resolvedPath, substring, predicate === "file-not-contains");
}

/**
 * Evaluates a fact's anchor predicate against `root`.
 *
 * `anchor === null` is always `unverified` (P3: no predicate means the proposition can neither be
 * confirmed nor denied — a hint-to-verify, never ground truth). `deadlineMs`, if given, is an
 * absolute `Date.now()`-based deadline; once passed, evaluation stops attempting further work and
 * returns `unverified` — the safe direction (never fabricate `affirmed`, never falsely claim
 * `contradicted`) rather than risk an unbounded directory walk or index parse in the recall hot path.
 *
 * `budgetHit`, if given, is an out-parameter: set to `true` when the returned `"unverified"` is a
 * "ran out of time this call" bailout rather than a genuine predicate outcome (mirrors the internal
 * `BudgetState` this function already threads through `evaluateFileContainsRaw`/`evaluateTokens`,
 * surfaced here so a caller iterating many facts under one shared deadline -- `retrieve`'s
 * `anchorTimeBudgetMs` -- can count how many verdicts are budget artifacts rather than real ones,
 * instead of every caller having to duplicate the "already expired on entry" / cache-hit reasoning
 * needed to infer it from the outside. Left untouched (`false` is never written back) when the
 * verdict is genuine, including a memo hit -- a budget-limited verdict is never memoized (see below),
 * so a cache hit can only ever be a real one.
 */
export function evaluateAnchor(anchor: string | null, root: string, deadlineMs?: number, budgetHit?: { hit: boolean }): AnchorVerdict {
  if (anchor === null || anchor.trim().length === 0) {
    return "unverified";
  }
  if (budgetExceeded(deadlineMs)) {
    // Already-expired deadline on entry: never a genuine predicate outcome, so never memoized —
    // there is nothing to cache under `key` since we return before ever reading/writing `memo`.
    if (budgetHit) {
      budgetHit.hit = true;
    }
    return "unverified";
  }

  const resolvedRoot = resolve(root);
  const trimmed = anchor.trim();
  const key = `${resolvedRoot} ${trimmed}`;
  const cached = memo.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const budgetState: BudgetState = { hit: false };
  const containsResult = evaluateFileContainsRaw(trimmed, resolvedRoot, deadlineMs, budgetState);
  const verdict = containsResult ?? evaluateTokens(tokenize(trimmed), resolvedRoot, deadlineMs, budgetState);
  // A budget-limited "unverified" is a "ran out of time this call" bailout, not a genuine
  // predicate outcome — memoizing it under a key that doesn't encode the deadline would let a
  // later, differently-budgeted (or unbudgeted) call for the same anchor+root incorrectly reuse
  // it instead of actually re-evaluating. Genuine verdicts (affirmed/contradicted, and unverified
  // that stems from the predicate itself rather than the time budget) are cached as before.
  if (!budgetState.hit) {
    memo.set(key, verdict);
  } else if (budgetHit) {
    budgetHit.hit = true;
  }
  return verdict;
}

/** Re-exported for callers building safe path arguments elsewhere (e.g. a future `mem remember --anchor` builder). */
export function anchorPathWithinRoot(root: string, pathArg: string): string | null {
  return resolveWithinRoot(resolve(root), pathArg);
}

/**
 * Bare filenames conventionally referenced without a directory component. A fact saying "the pin
 * lives in package.json" names a checkable target just as concretely as one saying "src/db.ts",
 * but carries no path separator for {@link ANCHORABLE_PATTERNS} to key on.
 *
 * Deliberately an explicit list rather than a general "word + known extension" rule: the general
 * form also matches "Node.js", "asyncio.gather", and "v1.2.js"-shaped prose, and a review bucket
 * that cries wolf on ordinary sentences is one nobody reads. Under-matching here is recoverable
 * (the fact simply is not nominated); over-matching is not (the bucket degrades into noise).
 */
const ANCHORABLE_BARE_FILENAMES: readonly string[] = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "CLAUDE.md",
  "AGENTS.md",
  "README.md",
  "CHANGELOG.md",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "requirements.txt",
  "Gemfile",
  "Gemfile.lock",
  "Makefile",
  "Dockerfile",
  "docker-compose.yml",
  ".gitignore",
  ".env",
];

/** Lower-cased lookup set for {@link mentionsAnchorableTarget}'s bare-filename pass. */
const ANCHORABLE_BARE_FILENAME_SET: ReadonlySet<string> = new Set(
  ANCHORABLE_BARE_FILENAMES.map((filename) => filename.toLowerCase()),
);

/** Splits prose into candidate tokens for the bare-filename pass — whitespace plus the punctuation that commonly brackets a filename mid-sentence. */
const TOKEN_SPLIT_RE = /[\s()[\]{}<>"'`,;:]+/u;

/** Trailing sentence punctuation to shave off a token before the bare-filename lookup, so "…in package.json." still matches. */
const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/u;

/**
 * Shapes that denote a concrete, re-checkable target. Each alternative is kept simple and
 * independently testable rather than fused into one omnibus expression.
 *
 * The `relative-with-extension` case requires the final segment to carry a dot-extension precisely
 * so that separator-bearing English ("and/or", "24/7", "he/she") cannot match; the rooted and
 * absolute cases require a leading marker or two segments for the same reason.
 */
const ANCHORABLE_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: "url", re: /https?:\/\/[^\s)>\]"']+/iu },
  { name: "windows-path", re: /(?:^|[\s"'`([<])[A-Za-z]:[\\/][^\s)>\]"']+/u },
  { name: "rooted-path", re: /(?:^|[\s"'`([<])(?:~|\.{1,2})\/[\w.@+-]+(?:\/[\w.@+-]+)*/u },
  { name: "absolute-path", re: /(?:^|[\s"'`([<])\/[\w.@+-]+(?:\/[\w.@+-]+)+/u },
  {
    name: "relative-with-extension",
    re: /(?:^|[\s"'`([<])[\w.@+-]+\/(?:[\w.@+-]+\/)*[\w@+-]+\.[A-Za-z]\w{0,9}(?=$|[\s)>\]"',;:.])/u,
  },
];

/**
 * Reports whether `text` names something an anchor predicate could plausibly be written against —
 * a path, a URL, or a conventionally-bare config filename.
 *
 * This is a *nomination* predicate for `mem review --section unanchored`, not a verification one:
 * a true result means "a human could write an anchor for this", never "this fact is stale". It
 * deliberately performs no filesystem I/O, so it stays pure, synchronous, and cheap enough to run
 * over every ground-truth fact on every `mem review`.
 *
 * Motivation: an anchorless fact can never be `contradicted` — {@link evaluateAnchor} short-circuits
 * a `null` anchor to `unverified` — so before this predicate existed such a fact could not reach any
 * `mem review` bucket at all. It sat at `unverified` indefinitely, invisible to both `mem review`
 * and `mem doctor`, however thoroughly the world had moved on beneath it.
 */
export function mentionsAnchorableTarget(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }
  if (ANCHORABLE_PATTERNS.some((pattern) => pattern.re.test(text))) {
    return true;
  }
  return text
    .split(TOKEN_SPLIT_RE)
    .some((token) => ANCHORABLE_BARE_FILENAME_SET.has(token.replace(TRAILING_PUNCTUATION_RE, "").toLowerCase()));
}
