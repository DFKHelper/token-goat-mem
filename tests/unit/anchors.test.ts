import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _clearAnchorMemoForTests, evaluateAnchor } from "../../src/anchors.js";

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
  });
});
