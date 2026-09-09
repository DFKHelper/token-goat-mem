/**
 * Repository-relative identity for a project root, so a project-scoped fact survives the path it
 * was captured at.
 *
 * `scopeRoot` is an absolute path, and every reader compares it by string equality. That binding is
 * correct but brittle in exactly the cases a memory tool is supposed to cover: the same repository
 * checked out at a second path, a git worktree (a different root by construction), a clone on
 * another machine reached through `mem export`/`mem import`. In all three the facts are about the
 * same project and none of them surface.
 *
 * The identity here is deliberately *not* just the remote URL. A monorepo has one remote and many
 * project roots, so remote-only identity would make `packages/a` and `packages/b` the same project
 * and leak each one's decisions into the other. Keying on the remote *plus the root's path relative
 * to the working-tree root* keeps those distinct while still matching across clones:
 *
 * | case                                  | remote | relative path | same identity? |
 * |---------------------------------------|--------|---------------|----------------|
 * | same repo cloned to a different path  | same   | same          | yes            |
 * | git worktree of the same repo         | same   | same          | yes            |
 * | two packages in one monorepo          | same   | differs       | no             |
 * | unrelated repos                       | differs| --            | no             |
 *
 * Like src/anchors.ts, this module never shells out: `git` need not be installed, and evaluating an
 * identity can have no side effects on the repository. It reads `.git` (following a `gitdir:`
 * pointer for worktrees and submodules), `commondir` where present, and `config`.
 *
 * Everything degrades to `null`, never to a throw or a guess. `null` means "no identity available"
 * and every caller treats it as "fall back to the path binding", so a directory that is not a
 * repository, has no remote, or has several ambiguous ones behaves exactly as it did before this
 * module existed.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Set to `path` to switch project binding back to absolute paths only, at both capture and recall.
 *
 * The case for it: two clones of one repository that are deliberately *not* the same project -- a
 * fork kept for experiments, a customer-specific branch checkout -- where sharing decisions between
 * them is wrong rather than convenient. Nothing else re-creates a path-only binding once identities
 * are being written, so this is the opt-out rather than a tuning knob.
 */
export const PROJECT_IDENTITY_ENV = "TOKEN_GOAT_MEM_PROJECT_IDENTITY";

/** Cap on bytes read from `.git/config`. A repository config is a small text file; anything larger is not one. */
const MAX_GIT_CONFIG_BYTES = 512 * 1024;

/** Cap on bytes read from a `.git` pointer file or `commondir`. Both are a single short line. */
const MAX_POINTER_BYTES = 4096;

/** Upper bound on directories walked upward looking for the working-tree root, so a pathological path cannot loop. */
const MAX_UPWARD_STEPS = 64;

/**
 * Cache keyed by the *resolved* root. Identity is derived from repository layout, which does not
 * change within the life of a short-lived CLI process; recall asks for the same root once per fact
 * without it.
 */
const identityCache = new Map<string, string | null>();

/** Drops the memoized identities. Tests that move a repository under a root need this; nothing in normal operation does. */
export function clearProjectIdentityCache(): void {
  identityCache.clear();
}

/** Whether repo identity is switched off for this process. Read per call rather than at import so tests (and a hook host) can set it late. */
function pathIdentityOnly(): boolean {
  return (process.env[PROJECT_IDENTITY_ENV] ?? "").trim().toLowerCase() === "path";
}

/** Reads a small text file, returning `null` for anything missing, oversized, or unreadable. */
function readSmallFile(path: string, maxBytes: number): string | null {
  try {
    if (statSync(path).size > maxBytes) {
      return null;
    }
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The `.git` directory for a working tree at `dir`, following a `gitdir:` pointer file.
 *
 * A worktree and a submodule both replace `.git` with a one-line file pointing elsewhere, so the
 * pointer case is the normal case for exactly the layouts this module exists to serve.
 */
function gitDirOf(dir: string): string | null {
  const dotGit = join(dir, ".git");
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    return dotGit;
  }
  if (!stat.isFile()) {
    return null;
  }
  const content = readSmallFile(dotGit, MAX_POINTER_BYTES);
  if (content === null) {
    return null;
  }
  const pointer = /^gitdir:\s*(.+)$/mu.exec(content.trim())?.[1]?.trim();
  if (pointer === undefined || pointer.length === 0) {
    return null;
  }
  const resolved = isAbsolute(pointer) ? resolve(pointer) : resolve(dir, pointer);
  try {
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/** The working-tree root at or above `root`, and its `.git` directory, or `null` when there is no repository. */
function findWorkingTree(root: string): { readonly treeRoot: string; readonly gitDir: string } | null {
  let dir = resolve(root);
  for (let step = 0; step < MAX_UPWARD_STEPS; step += 1) {
    const gitDir = gitDirOf(dir);
    if (gitDir !== null) {
      return { treeRoot: dir, gitDir };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
  return null;
}

/**
 * The directory holding the shared `config`.
 *
 * A worktree's own git directory carries only that worktree's state; `config` lives in the main
 * repository, named by a `commondir` file. Without this step every worktree reads as having no
 * remote -- and a worktree is one of the three cases this module exists for.
 */
function commonDirOf(gitDir: string): string {
  const content = readSmallFile(join(gitDir, "commondir"), MAX_POINTER_BYTES);
  const pointer = content?.trim();
  if (pointer === undefined || pointer.length === 0) {
    return gitDir;
  }
  return isAbsolute(pointer) ? resolve(pointer) : resolve(gitDir, pointer);
}

/**
 * The remote URL to identify a repository by: `origin` when it exists, otherwise the only remote if
 * there is exactly one.
 *
 * Several remotes with no `origin` is genuinely ambiguous -- picking one would make identity depend
 * on config file ordering -- so that yields `null` and the caller falls back to the path binding.
 */
function remoteUrlFrom(configText: string): string | null {
  const remotes = new Map<string, string>();
  let current: string | null = null;
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      // Both `[remote "origin"]` and the (legal) subsection-less `[remote]` reset the section.
      current = /^\[remote\s+"([^"]*)"\]$/u.exec(line)?.[1] ?? null;
      continue;
    }
    if (current === null) {
      continue;
    }
    const url = /^url\s*=\s*(.+)$/u.exec(line)?.[1]?.trim();
    // First `url` in a section wins, matching git's own "last one set" only loosely -- but a second
    // url line in one remote section is a pushurl-style edge case, not something to guess at.
    if (url !== undefined && url.length > 0 && !remotes.has(current)) {
      remotes.set(current, url);
    }
  }
  const origin = remotes.get("origin");
  if (origin !== undefined) {
    return origin;
  }
  return remotes.size === 1 ? ([...remotes.values()][0] ?? null) : null;
}

/**
 * Reduces a remote URL to a comparable host+path.
 *
 * `git@github.com:owner/repo.git`, `https://github.com/owner/repo`, and
 * `ssh://git@github.com/owner/repo.git` are the same repository and must produce the same string.
 * Case is folded because the hosts people actually use treat owner/repo case-insensitively, and an
 * identity that changed with how a URL was typed would be worse than no identity at all.
 */
export function normalizeRemoteUrl(url: string): string | null {
  let rest = url.trim();
  if (rest.length === 0) {
    return null;
  }
  // scp-style `user@host:path` (no scheme, single colon before a non-numeric path).
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/u.exec(rest);
  if (scp !== null && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(rest)) {
    rest = `${scp[1] ?? ""}/${scp[2] ?? ""}`;
  } else {
    rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "").replace(/^[^@/]+@/u, "");
  }
  rest = rest
    .replace(/\.git$/iu, "")
    .replace(/\/+$/u, "")
    .replace(/\\/gu, "/")
    .toLowerCase();
  return rest.length > 0 ? rest : null;
}

/**
 * A stable identity for the project rooted at `root`, or `null` when none is available.
 *
 * The shape is `<host>/<path>#<root relative to the working tree>`, with `.` for the working-tree
 * root itself. The `#` separator cannot appear in the relative-path component after normalization
 * of `\` to `/`, so the two halves never blur into each other.
 *
 * `null` is the honest and common answer -- no repository, no remote, several ambiguous remotes,
 * identity switched off -- and every caller must treat it as "compare paths as before".
 */
export function resolveProjectIdentity(root: string): string | null {
  if (pathIdentityOnly()) {
    return null;
  }
  const key = resolve(root);
  const cached = identityCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const identity = computeProjectIdentity(key);
  identityCache.set(key, identity);
  return identity;
}

function computeProjectIdentity(root: string): string | null {
  const tree = findWorkingTree(root);
  if (tree === null) {
    return null;
  }
  const configText = readSmallFile(join(commonDirOf(tree.gitDir), "config"), MAX_GIT_CONFIG_BYTES);
  if (configText === null) {
    return null;
  }
  const remote = remoteUrlFrom(configText);
  if (remote === null) {
    return null;
  }
  const host = normalizeRemoteUrl(remote);
  if (host === null) {
    return null;
  }
  const within = relative(tree.treeRoot, root);
  // `..` means the caller handed us a root the working tree does not contain, which findWorkingTree
  // should make impossible; refusing beats emitting an identity that escapes its own repository.
  if (within.startsWith("..")) {
    return null;
  }
  const suffix = within.length === 0 ? "." : within.split(sep).join("/").toLowerCase();
  return `${host}#${suffix}`;
}

/**
 * Whether a stored identity and a querying root name the same project.
 *
 * Both halves must be present: a fact captured before identities existed (or with them switched
 * off) has `null` and is matched by path alone, never by "this root has no identity either".
 */
export function identityMatches(stored: string | null | undefined, root: string): boolean {
  if (stored === null || stored === undefined || stored.trim().length === 0) {
    return false;
  }
  return stored === resolveProjectIdentity(root);
}
