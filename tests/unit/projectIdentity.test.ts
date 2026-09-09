/**
 * Unit tests for src/projectIdentity.ts.
 *
 * Real repositories on disk rather than mocks: the module's whole job is reading git's own layout
 * (pointer files, `commondir`, config sections), and a mocked filesystem would only assert that the
 * mock matches this file's idea of that layout. `git init` is cheap enough to use the real thing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearProjectIdentityCache,
  identityMatches,
  normalizeRemoteUrl,
  PROJECT_IDENTITY_ENV,
  resolveProjectIdentity,
} from "../../src/projectIdentity.js";

let dir: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** A repository with one commit and, unless `remote` is null, an `origin` pointing at it. */
function makeRepo(name: string, remote: string | null = "https://github.com/acme/widget.git"): string {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "file.txt"), "x", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  if (remote !== null) {
    git(repo, "remote", "add", "origin", remote);
  }
  return repo;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mem-identity-"));
  delete process.env[PROJECT_IDENTITY_ENV];
  clearProjectIdentityCache();
});

afterEach(() => {
  delete process.env[PROJECT_IDENTITY_ENV];
  clearProjectIdentityCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("normalizeRemoteUrl", () => {
  it("reduces every spelling of one repository to the same string", () => {
    // The three forms a person actually copies out of a host's UI. If these disagreed, whether two
    // clones shared an identity would depend on which button was clicked when cloning.
    const expected = "github.com/acme/widget";
    for (const url of [
      "git@github.com:acme/widget.git",
      "https://github.com/acme/widget.git",
      "https://github.com/acme/widget",
      "ssh://git@github.com/acme/widget.git",
      "https://github.com/ACME/Widget.git",
      "https://github.com/acme/widget/",
    ]) {
      expect(normalizeRemoteUrl(url), url).toBe(expected);
    }
  });

  it("keeps genuinely different repositories apart", () => {
    expect(normalizeRemoteUrl("https://github.com/acme/widget")).not.toBe(normalizeRemoteUrl("https://github.com/acme/gadget"));
    expect(normalizeRemoteUrl("https://github.com/acme/widget")).not.toBe(normalizeRemoteUrl("https://gitlab.com/acme/widget"));
  });

  it("returns null for a URL with nothing left after normalization", () => {
    expect(normalizeRemoteUrl("")).toBeNull();
    expect(normalizeRemoteUrl("   ")).toBeNull();
    expect(normalizeRemoteUrl(".git")).toBeNull();
  });
});

describe("resolveProjectIdentity", () => {
  it("gives two clones of one repository the same identity", () => {
    const a = makeRepo("a");
    const b = makeRepo("b");
    expect(resolveProjectIdentity(a)).toBe("github.com/acme/widget#.");
    expect(resolveProjectIdentity(b)).toBe(resolveProjectIdentity(a));
  });

  it("gives a worktree the same identity as its main checkout", () => {
    // The worktree's own git directory holds no config -- the remote lives in the main repository,
    // reachable only through `commondir`. Without that step every worktree reads as remote-less,
    // and a worktree is one of the three cases this module exists for.
    const repo = makeRepo("repo");
    const worktree = join(dir, "wt");
    git(repo, "worktree", "add", "-q", worktree, "-b", "feature");
    expect(resolveProjectIdentity(worktree)).toBe(resolveProjectIdentity(repo));
  });

  it("keeps two packages of one monorepo distinct", () => {
    // The reason identity is not the remote alone: one remote, many project roots.
    const repo = makeRepo("repo");
    const a = join(repo, "packages", "a");
    const b = join(repo, "packages", "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    expect(resolveProjectIdentity(a)).toBe("github.com/acme/widget#packages/a");
    expect(resolveProjectIdentity(b)).toBe("github.com/acme/widget#packages/b");
    expect(resolveProjectIdentity(a)).not.toBe(resolveProjectIdentity(repo));
  });

  it("returns null where no identity can be established", () => {
    const plain = join(dir, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    expect(resolveProjectIdentity(plain)).toBeNull();
    // A repository with no remote is a local-only checkout: nothing to match another clone against.
    expect(resolveProjectIdentity(makeRepo("local", null))).toBeNull();
  });

  it("refuses to guess between several remotes when none is named origin", () => {
    // Picking one would make identity depend on config file ordering.
    const repo = makeRepo("multi", null);
    git(repo, "remote", "add", "upstream", "https://github.com/acme/widget.git");
    git(repo, "remote", "add", "fork", "https://github.com/me/widget.git");
    clearProjectIdentityCache();
    expect(resolveProjectIdentity(repo)).toBeNull();
    // One unambiguous remote is enough, even when it is not called origin.
    const single = makeRepo("single", null);
    git(single, "remote", "add", "upstream", "https://github.com/acme/widget.git");
    clearProjectIdentityCache();
    expect(resolveProjectIdentity(single)).toBe("github.com/acme/widget#.");
  });

  it("prefers origin when several remotes exist", () => {
    const repo = makeRepo("origin-wins");
    git(repo, "remote", "add", "fork", "https://github.com/me/widget.git");
    clearProjectIdentityCache();
    expect(resolveProjectIdentity(repo)).toBe("github.com/acme/widget#.");
  });

  it("returns null for every root when the path-only opt-out is set", () => {
    const repo = makeRepo("opted-out");
    expect(resolveProjectIdentity(repo)).not.toBeNull();
    process.env[PROJECT_IDENTITY_ENV] = "path";
    clearProjectIdentityCache();
    expect(resolveProjectIdentity(repo)).toBeNull();
  });
});

describe("identityMatches", () => {
  it("requires both sides to carry an identity", () => {
    const repo = makeRepo("repo");
    const identity = resolveProjectIdentity(repo) ?? "";
    expect(identityMatches(identity, repo)).toBe(true);
    // A fact captured before identities existed must fall back to its path binding rather than
    // matching every root that also happens to have none.
    const plain = join(dir, "plain");
    mkdirSync(plain, { recursive: true });
    expect(identityMatches(null, plain)).toBe(false);
    expect(identityMatches(undefined, repo)).toBe(false);
    expect(identityMatches("", repo)).toBe(false);
    expect(identityMatches(identity, plain)).toBe(false);
  });
});
