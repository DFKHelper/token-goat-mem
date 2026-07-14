import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _clearAnchorMemoForTests, anchorPathWithinRoot, evaluateAnchor } from "../src/anchors.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-anchors-"));
  _clearAnchorMemoForTests();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runGit(args: readonly string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function touch(path: string, when: string): void {
  const d = new Date(when);
  utimesSync(path, d, d);
}

describe("evaluateAnchor", () => {
  describe("null / malformed anchors are unverified, never a guess", () => {
    it("returns unverified for a null anchor", () => {
      expect(evaluateAnchor(null, root)).toBe("unverified");
    });

    it("returns unverified for an empty/whitespace-only anchor", () => {
      expect(evaluateAnchor("   ", root)).toBe("unverified");
    });

    it("returns unverified for an unrecognized predicate", () => {
      expect(evaluateAnchor("shell-out rm -rf /", root)).toBe("unverified");
    });

    it("returns unverified when a fixed-arity predicate is given the wrong number of args", () => {
      expect(evaluateAnchor("file-exists", root)).toBe("unverified");
      expect(evaluateAnchor("file-exists a.txt b.txt", root)).toBe("unverified");
      expect(evaluateAnchor("git-branch-is", root)).toBe("unverified");
    });
  });

  describe("file-exists / file-absent (happy path)", () => {
    it("file-exists affirms when present, contradicts when absent", () => {
      writeFileSync(join(root, "present.txt"), "x");
      expect(evaluateAnchor("file-exists present.txt", root)).toBe("affirmed");
      expect(evaluateAnchor("file-exists absent.txt", root)).toBe("contradicted");
    });

    it("file-absent affirms when missing, contradicts when present", () => {
      writeFileSync(join(root, "present.txt"), "x");
      expect(evaluateAnchor("file-absent present.txt", root)).toBe("contradicted");
      expect(evaluateAnchor("file-absent absent.txt", root)).toBe("affirmed");
    });
  });

  describe("file-newer-than (happy path)", () => {
    it("affirms when a is newer than b", () => {
      writeFileSync(join(root, "a.txt"), "a");
      writeFileSync(join(root, "b.txt"), "b");
      touch(join(root, "b.txt"), "2020-01-01");
      touch(join(root, "a.txt"), "2024-01-01");
      expect(evaluateAnchor("file-newer-than a.txt b.txt", root)).toBe("affirmed");
    });

    it("contradicts when b is newer than a", () => {
      writeFileSync(join(root, "a.txt"), "a");
      writeFileSync(join(root, "b.txt"), "b");
      touch(join(root, "a.txt"), "2020-01-01");
      touch(join(root, "b.txt"), "2024-01-01");
      expect(evaluateAnchor("file-newer-than a.txt b.txt", root)).toBe("contradicted");
    });

    it("is unverified when neither file exists, and when both share the same mtime", () => {
      expect(evaluateAnchor("file-newer-than missing-a.txt missing-b.txt", root)).toBe("unverified");

      writeFileSync(join(root, "c.txt"), "c");
      writeFileSync(join(root, "d.txt"), "d");
      const same = new Date("2022-06-01");
      utimesSync(join(root, "c.txt"), same, same);
      utimesSync(join(root, "d.txt"), same, same);
      expect(evaluateAnchor("file-newer-than c.txt d.txt", root)).toBe("unverified");
    });
  });

  describe("file-contains / file-not-contains (happy path)", () => {
    it("file-contains affirms when the substring is present, contradicts when absent", () => {
      writeFileSync(join(root, "config.json"), '{"packageManager": "pnpm"}');
      expect(evaluateAnchor("file-contains config.json pnpm", root)).toBe("affirmed");
      expect(evaluateAnchor("file-contains config.json yarn", root)).toBe("contradicted");
    });

    it("file-not-contains inverts the same check", () => {
      writeFileSync(join(root, "config.json"), '{"packageManager": "pnpm"}');
      expect(evaluateAnchor("file-not-contains config.json yarn", root)).toBe("affirmed");
      expect(evaluateAnchor("file-not-contains config.json pnpm", root)).toBe("contradicted");
    });

    it("preserves whitespace in the substring by matching against the raw anchor text", () => {
      writeFileSync(join(root, "notes.txt"), "hello there world");
      expect(evaluateAnchor("file-contains notes.txt there world", root)).toBe("affirmed");
      expect(evaluateAnchor("file-contains notes.txt there mars", root)).toBe("contradicted");
    });

    it("is unverified when the file is missing rather than treating a moved file as a denial", () => {
      // S1: a moved/renamed file is the proxy-anchor trap -- must not silently read as "contradicted".
      expect(evaluateAnchor("file-contains moved-away.txt pnpm", root)).toBe("unverified");
    });
  });

  describe("newest-of -- the design plan's headline proxy-anchor example", () => {
    it("affirms when the expected file really is the newest of the candidate set", () => {
      writeFileSync(join(root, "pnpm-lock.yaml"), "lock");
      writeFileSync(join(root, "package-lock.json"), "lock");
      touch(join(root, "package-lock.json"), "2023-01-01");
      touch(join(root, "pnpm-lock.yaml"), "2024-01-01");

      expect(
        evaluateAnchor("newest-of pnpm-lock.yaml package-lock.json yarn.lock", root),
      ).toBe("affirmed");
    });

    it("contradicts a stale lockfile left behind after a package-manager switch", () => {
      // This is exactly the S1 bug a proxy anchor ("package-lock.json exists") cannot catch: the
      // project switched to pnpm, but an old package-lock.json is still sitting on disk. A proposition
      // anchor must contradict "uses npm" (via "newest-of package-lock.json ...") because pnpm-lock.yaml
      // is now the newer, actively-maintained file.
      writeFileSync(join(root, "package-lock.json"), "stale npm lock, left behind after switching to pnpm");
      writeFileSync(join(root, "pnpm-lock.yaml"), "current pnpm lock");
      touch(join(root, "package-lock.json"), "2022-03-01");
      touch(join(root, "pnpm-lock.yaml"), "2024-05-01");

      // "the newest lockfile is package-lock.json" -- false, pnpm-lock.yaml is newer.
      expect(
        evaluateAnchor("newest-of package-lock.json pnpm-lock.yaml yarn.lock", root),
      ).toBe("contradicted");
      // And the true proposition -- "the newest lockfile is pnpm-lock.yaml" -- affirms.
      expect(
        evaluateAnchor("newest-of pnpm-lock.yaml package-lock.json yarn.lock", root),
      ).toBe("affirmed");
    });

    it("is unverified when no candidate exists, and when two candidates tie for newest", () => {
      expect(
        evaluateAnchor("newest-of pnpm-lock.yaml package-lock.json yarn.lock", root),
      ).toBe("unverified");

      writeFileSync(join(root, "pnpm-lock.yaml"), "a");
      writeFileSync(join(root, "package-lock.json"), "b");
      const tie = new Date("2024-01-01");
      utimesSync(join(root, "pnpm-lock.yaml"), tie, tie);
      utimesSync(join(root, "package-lock.json"), tie, tie);
      expect(
        evaluateAnchor("newest-of pnpm-lock.yaml package-lock.json", root),
      ).toBe("unverified");
    });
  });

  describe("glob-exists (happy path)", () => {
    it("affirms on a matching entry and contradicts when the walk completes with no match", () => {
      mkdirSync(join(root, "src", "nested"), { recursive: true });
      writeFileSync(join(root, "src", "nested", "widget.test.ts"), "x");

      expect(evaluateAnchor("glob-exists src/**/*.test.ts", root)).toBe("affirmed");
      expect(evaluateAnchor("glob-exists src/**/*.spec.ts", root)).toBe("contradicted");
    });

    it("rejects an absolute pattern as unverified", () => {
      expect(evaluateAnchor("glob-exists /etc/passwd", root)).toBe("unverified");
    });
  });

  describe("git-branch-is (happy path)", () => {
    it("affirms the checked-out branch and contradicts a different one", () => {
      runGit(["init", "-q", "-b", "main"], root);
      writeFileSync(join(root, "f.txt"), "x");
      runGit(["add", "f.txt"], root);
      runGit(["-c", "user.email=test@test.local", "-c", "user.name=test", "commit", "-q", "-m", "init"], root);

      expect(evaluateAnchor("git-branch-is main", root)).toBe("affirmed");
      expect(evaluateAnchor("git-branch-is develop", root)).toBe("contradicted");
    });

    it("is unverified outside a git working tree", () => {
      expect(evaluateAnchor("git-branch-is main", root)).toBe("unverified");
    });
  });

  describe("git-tracked (happy path)", () => {
    it("is unverified outside a git repository", () => {
      writeFileSync(join(root, "f.txt"), "x");
      expect(evaluateAnchor("git-tracked f.txt", root)).toBe("unverified");
    });

    it("affirms a tracked file and contradicts an untracked file inside a repo", () => {
      runGit(["init", "-q"], root);
      writeFileSync(join(root, "tracked.txt"), "x");
      writeFileSync(join(root, "untracked.txt"), "y");
      runGit(["add", "tracked.txt"], root);
      runGit(["-c", "user.email=test@test.local", "-c", "user.name=test", "commit", "-q", "-m", "init"], root);

      expect(evaluateAnchor("git-tracked tracked.txt", root)).toBe("affirmed");
      expect(evaluateAnchor("git-tracked untracked.txt", root)).toBe("contradicted");
    });

    it("returns unverified once the deadline has already passed", () => {
      runGit(["init", "-q"], root);
      writeFileSync(join(root, "tracked.txt"), "x");
      runGit(["add", "tracked.txt"], root);
      runGit(["-c", "user.email=test@test.local", "-c", "user.name=test", "commit", "-q", "-m", "init"], root);

      expect(evaluateAnchor("git-tracked tracked.txt", root, Date.now() - 1)).toBe("unverified");
    });
  });

  describe("package-version (declared-manifest check only)", () => {
    it("affirms on an exact declared-version match", () => {
      writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { react: "18.2.0" } }));
      expect(evaluateAnchor("package-version package.json react@18.2.0", root)).toBe("affirmed");
    });

    it("affirms a major-version-prefix match against a caret range", () => {
      writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^18.2.0" } }));
      expect(evaluateAnchor("package-version package.json react@18", root)).toBe("affirmed");
    });

    it("checks devDependencies when the name is not in dependencies", () => {
      writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { typescript: "~5.4.0" } }));
      expect(evaluateAnchor("package-version package.json typescript@5", root)).toBe("affirmed");
    });

    it("contradicts a confidently-resolvable mismatch", () => {
      writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { react: "^17.0.2" } }));
      expect(evaluateAnchor("package-version package.json react@18", root)).toBe("contradicted");
    });

    it("is unverified when the dependency key is missing entirely", () => {
      writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { vue: "3.4.0" } }));
      expect(evaluateAnchor("package-version package.json react@18", root)).toBe("unverified");
    });

    it("is unverified on malformed JSON", () => {
      writeFileSync(join(root, "package.json"), "{ not valid json");
      expect(evaluateAnchor("package-version package.json react@18", root)).toBe("unverified");
    });

    it("is unverified when the path is outside root", () => {
      const outside = mkdtempSync(join(tmpdir(), "mem-anchors-outside-"));
      try {
        writeFileSync(join(outside, "package.json"), JSON.stringify({ dependencies: { react: "18.2.0" } }));
        expect(evaluateAnchor(`package-version ${join(outside, "package.json")} react@18.2.0`, root)).toBe("unverified");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("is unverified when the comparison can't confidently resolve (non-numeric expected, complex range)", () => {
      writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { react: ">=17 <19" } }));
      expect(evaluateAnchor("package-version package.json react@18", root)).toBe("unverified");
    });

    it("is unverified for wrong arg count or a malformed name@version token", () => {
      expect(evaluateAnchor("package-version package.json", root)).toBe("unverified");
      expect(evaluateAnchor("package-version package.json react", root)).toBe("unverified");
    });
  });

  describe("path traversal is rejected as unverified, not followed", () => {
    it("rejects a relative path that escapes root", () => {
      expect(evaluateAnchor("file-exists ../outside.txt", root)).toBe("unverified");
      expect(evaluateAnchor("file-newer-than ../../a.txt b.txt", root)).toBe("unverified");
    });

    it("rejects an absolute path pointing outside root", () => {
      const outside = mkdtempSync(join(tmpdir(), "mem-outside-"));
      try {
        writeFileSync(join(outside, "secret.txt"), "x");
        expect(evaluateAnchor(`file-exists ${join(outside, "secret.txt")}`, root)).toBe("unverified");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe("memoization", () => {
    it("returns a consistent verdict for repeated evaluation of the same anchor+root", () => {
      writeFileSync(join(root, "a.txt"), "a");
      expect(evaluateAnchor("file-exists a.txt", root)).toBe("affirmed");
      expect(evaluateAnchor("file-exists a.txt", root)).toBe("affirmed");
    });

    it("does not leak a memoized verdict across a different root", () => {
      const otherRoot = mkdtempSync(join(tmpdir(), "mem-anchors-other-"));
      try {
        writeFileSync(join(root, "a.txt"), "a");
        expect(evaluateAnchor("file-exists a.txt", root)).toBe("affirmed");
        // Same anchor text, a different root where the file does not exist.
        expect(evaluateAnchor("file-exists a.txt", otherRoot)).toBe("contradicted");
      } finally {
        rmSync(otherRoot, { recursive: true, force: true });
      }
    });
  });
});

describe("anchorPathWithinRoot", () => {
  it("resolves a relative path inside root", () => {
    const resolved = anchorPathWithinRoot(root, "sub/file.txt");
    expect(resolved).toBe(join(root, "sub", "file.txt"));
  });

  it("returns null for a path that escapes root", () => {
    expect(anchorPathWithinRoot(root, "../escape.txt")).toBeNull();
  });
});
