import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _clearAnchorMemoForTests, clearAnchorCaches, evaluateAnchor } from "../../src/anchors.js";

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

describe("evaluateAnchor", () => {
  it("returns unverified for a null anchor", () => {
    expect(evaluateAnchor(null, root)).toBe("unverified");
  });

  it("returns unverified for an empty/whitespace anchor", () => {
    expect(evaluateAnchor("   ", root)).toBe("unverified");
  });

  it("returns unverified for an unrecognized predicate", () => {
    expect(evaluateAnchor("shell-out rm -rf /", root)).toBe("unverified");
  });

  describe("file-newer-than", () => {
    it("affirms when a is newer than b", () => {
      writeFileSync(join(root, "a.txt"), "a");
      writeFileSync(join(root, "b.txt"), "b");
      utimesSync(join(root, "b.txt"), new Date("2020-01-01"), new Date("2020-01-01"));
      utimesSync(join(root, "a.txt"), new Date("2024-01-01"), new Date("2024-01-01"));
      expect(evaluateAnchor("file-newer-than a.txt b.txt", root)).toBe("affirmed");
    });

    it("contradicts when b is newer than a", () => {
      writeFileSync(join(root, "a.txt"), "a");
      writeFileSync(join(root, "b.txt"), "b");
      utimesSync(join(root, "a.txt"), new Date("2020-01-01"), new Date("2020-01-01"));
      utimesSync(join(root, "b.txt"), new Date("2024-01-01"), new Date("2024-01-01"));
      expect(evaluateAnchor("file-newer-than a.txt b.txt", root)).toBe("contradicted");
    });

    it("affirms when only a exists", () => {
      writeFileSync(join(root, "a.txt"), "a");
      expect(evaluateAnchor("file-newer-than a.txt missing-b.txt", root)).toBe("affirmed");
    });

    it("contradicts when only b exists", () => {
      writeFileSync(join(root, "b.txt"), "b");
      expect(evaluateAnchor("file-newer-than missing-a.txt b.txt", root)).toBe("contradicted");
    });

    it("is unverified when neither file exists", () => {
      expect(evaluateAnchor("file-newer-than missing-a.txt missing-b.txt", root)).toBe("unverified");
    });
  });

  describe("file-exists / file-absent", () => {
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

  describe("path traversal", () => {
    it("rejects paths escaping root as unverified", () => {
      expect(evaluateAnchor("file-exists ../outside.txt", root)).toBe("unverified");
      expect(evaluateAnchor("file-newer-than ../../a.txt b.txt", root)).toBe("unverified");
    });
  });

  describe("a symlink inside root pointing outside root is refused, not followed", () => {
    it("file-exists contradicts, file-absent affirms, for a symlink to a file outside root", () => {
      const outside = mkdtempSync(join(tmpdir(), "mem-anchors-outside-"));
      try {
        const target = join(outside, "secret.txt");
        writeFileSync(target, "outside content");
        symlinkSync(target, join(root, "link.txt"), "file");
        expect(evaluateAnchor("file-exists link.txt", root)).toBe("contradicted");
        expect(evaluateAnchor("file-absent link.txt", root)).toBe("affirmed");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("file-newer-than contradicts, does not follow, for a symlink to a file outside root", () => {
      const outside = mkdtempSync(join(tmpdir(), "mem-anchors-outside-"));
      try {
        const target = join(outside, "secret.txt");
        writeFileSync(target, "outside content");
        symlinkSync(target, join(root, "link.txt"), "file");
        writeFileSync(join(root, "b.txt"), "b");
        expect(evaluateAnchor("file-newer-than link.txt b.txt", root)).toBe("contradicted");
        expect(evaluateAnchor("file-newer-than b.txt link.txt", root)).toBe("contradicted");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("newest-of contradicts, does not follow, for a symlinked candidate outside root", () => {
      const outside = mkdtempSync(join(tmpdir(), "mem-anchors-outside-"));
      try {
        const target = join(outside, "pnpm-lock.yaml");
        writeFileSync(target, "outside content");
        symlinkSync(target, join(root, "pnpm-lock.yaml"), "file");
        writeFileSync(join(root, "package-lock.json"), "inside content");
        expect(evaluateAnchor("newest-of pnpm-lock.yaml package-lock.json", root)).toBe("contradicted");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe("git-tracked", () => {
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

    it("returns unverified once the deadline has passed", () => {
      runGit(["init", "-q"], root);
      writeFileSync(join(root, "tracked.txt"), "x");
      runGit(["add", "tracked.txt"], root);
      runGit(["-c", "user.email=test@test.local", "-c", "user.name=test", "commit", "-q", "-m", "init"], root);

      expect(evaluateAnchor("git-tracked tracked.txt", root, Date.now() - 1)).toBe("unverified");
    });
  });

  describe("memoization", () => {
    it("returns a consistent verdict for repeated evaluation of the same anchor+root", () => {
      writeFileSync(join(root, "a.txt"), "a");
      const first = evaluateAnchor("file-exists a.txt", root);
      const second = evaluateAnchor("file-exists a.txt", root);
      expect(first).toBe("affirmed");
      expect(second).toBe("affirmed");
    });

    it("does not memoize a budget-limited unverified verdict, so a later unbudgeted call re-evaluates for real", () => {
      writeFileSync(join(root, "a.txt"), "a");
      // Already-expired deadline forces the budget bailout before the real file-exists check runs.
      const expiredDeadline = Date.now() - 1;
      expect(evaluateAnchor("file-exists a.txt", root, expiredDeadline)).toBe("unverified");
      // Same anchor + root, no deadline: must re-evaluate for real rather than reuse the stale
      // budget-limited "unverified" from the call above.
      expect(evaluateAnchor("file-exists a.txt", root)).toBe("affirmed");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────── regression: anchors match the case-sensitivity of the filesystem they run on ───────────────────────────────────────────────────────────────────────────

describe("case sensitivity of glob-exists / git-tracked", () => {
  /**
   * On win32 the filesystem is case-insensitive, so `README.md` and `readme.md` are the same file.
   * Matching case-sensitively there produced a `contradicted` verdict -- P3's strongest claim, one
   * that actively withholds a fact from ground truth -- for a file that plainly exists. Folding is
   * scoped to win32 on purpose: macOS ships case-sensitive APFS volumes too, and folding there
   * would trade a false `contradicted` for a false `affirmed`, which is the worse error.
   */
  const foldsCase = process.platform === "win32";

  it("glob-exists matches a differently-cased filename exactly where the filesystem does", () => {
    writeFileSync(join(root, "README.md"), "x");
    _clearAnchorMemoForTests();
    expect(evaluateAnchor("glob-exists readme.md", root)).toBe(foldsCase ? "affirmed" : "contradicted");
  });

  it("glob-exists is unaffected for an exactly-cased target on every platform", () => {
    writeFileSync(join(root, "README.md"), "x");
    _clearAnchorMemoForTests();
    expect(evaluateAnchor("glob-exists README.md", root)).toBe("affirmed");
  });

  it("glob-exists still contradicts a target that is absent under any casing", () => {
    writeFileSync(join(root, "README.md"), "x");
    _clearAnchorMemoForTests();
    expect(evaluateAnchor("glob-exists CHANGELOG.md", root)).toBe("contradicted");
  });

  it("git-tracked matches a differently-cased path exactly where the filesystem does", () => {
    writeFileSync(join(root, "Tracked.ts"), "x");
    runGit(["init"], root);
    runGit(["add", "Tracked.ts"], root);
    _clearAnchorMemoForTests();

    expect(evaluateAnchor("git-tracked Tracked.ts", root)).toBe("affirmed");
    _clearAnchorMemoForTests();
    expect(evaluateAnchor("git-tracked tracked.ts", root)).toBe(foldsCase ? "affirmed" : "contradicted");
  });

  it("git-tracked still contradicts a path that is in the tree but not in the index", () => {
    writeFileSync(join(root, "Tracked.ts"), "x");
    writeFileSync(join(root, "Untracked.ts"), "x");
    runGit(["init"], root);
    runGit(["add", "Tracked.ts"], root);
    _clearAnchorMemoForTests();

    expect(evaluateAnchor("git-tracked Untracked.ts", root)).toBe("contradicted");
  });
});

describe("clearAnchorCaches", () => {
  it("is the public name for the memo reset, and drops a verdict that is no longer true on disk", () => {
    const anchorPath = join(root, "present.txt");
    writeFileSync(anchorPath, "x");
    expect(evaluateAnchor("file-exists present.txt", root)).toBe("affirmed");

    rmSync(anchorPath);
    // Still memoized: within one CLI process that is correct and is the point of the cache.
    expect(evaluateAnchor("file-exists present.txt", root)).toBe("affirmed");

    clearAnchorCaches();
    expect(evaluateAnchor("file-exists present.txt", root)).toBe("contradicted");
  });
});
