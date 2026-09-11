import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _clearAnchorMemoForTests, clearAnchorCaches, evaluateAnchor, isGenuineAbsence } from "../../src/anchors.js";

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

    it("is unverified when b is missing, even though a exists", () => {
      // You cannot compare two files when one of them does not exist -- affirming here would let
      // "generated.ts is current with schema.prisma" stay ground truth forever after schema.prisma
      // is deleted or moved, exactly the moment the fact stops being true (P3: never fabricate a
      // verdict; unverified, not affirmed, is the honest answer for a missing comparison target).
      writeFileSync(join(root, "a.txt"), "a");
      expect(evaluateAnchor("file-newer-than a.txt missing-b.txt", root)).toBe("unverified");
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
    it("file-exists and file-absent both refuse (unverified) for a symlink to a file outside root", () => {
      const outside = mkdtempSync(join(tmpdir(), "mem-anchors-outside-"));
      try {
        const target = join(outside, "secret.txt");
        writeFileSync(target, "outside content");
        symlinkSync(target, join(root, "link.txt"), "file");
        // Neither predicate can safely resolve through the symlink, so neither can assert presence
        // or absence -- "contradicted"/"affirmed" here would fabricate a verdict mem cannot back up.
        expect(evaluateAnchor("file-exists link.txt", root)).toBe("unverified");
        expect(evaluateAnchor("file-absent link.txt", root)).toBe("unverified");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("file-newer-than is unverified, does not follow, for a symlink to a file outside root", () => {
      // `file-newer-than <a> <b>` contradicted asserts a positive comparison result ("a is not
      // newer than b") that mem refused to actually compute once it detected the symlink -- exactly
      // the P3 violation the header comment now documents uniformly across all path-based
      // predicates (Fix 3).
      const outside = mkdtempSync(join(tmpdir(), "mem-anchors-outside-"));
      try {
        const target = join(outside, "secret.txt");
        writeFileSync(target, "outside content");
        symlinkSync(target, join(root, "link.txt"), "file");
        writeFileSync(join(root, "b.txt"), "b");
        expect(evaluateAnchor("file-newer-than link.txt b.txt", root)).toBe("unverified");
        expect(evaluateAnchor("file-newer-than b.txt link.txt", root)).toBe("unverified");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("newest-of is unverified, does not follow, for a symlinked candidate outside root", () => {
      const outside = mkdtempSync(join(tmpdir(), "mem-anchors-outside-"));
      try {
        const target = join(outside, "pnpm-lock.yaml");
        writeFileSync(target, "outside content");
        symlinkSync(target, join(root, "pnpm-lock.yaml"), "file");
        writeFileSync(join(root, "package-lock.json"), "inside content");
        expect(evaluateAnchor("newest-of pnpm-lock.yaml package-lock.json", root)).toBe("unverified");
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

  it("glob-exists matches a differently-cased filename exactly where the filesystem does, and is unverified rather than contradicted elsewhere (Item 4)", () => {
    // Item 4: an exact-bytes miss on a literal segment doesn't prove absence on a platform whose
    // filesystem this process cannot confirm is case-sensitive (macOS ships both case-sensitive and
    // case-insensitive APFS volumes) -- "can't confirm or deny" is the honest verdict there, not
    // "confirmed untracked" (the old `contradicted`, a fabrication on a case-insensitive volume) or
    // "confirmed present" (a false `affirmed`, the other extreme this must not swing to either).
    writeFileSync(join(root, "README.md"), "x");
    _clearAnchorMemoForTests();
    expect(evaluateAnchor("glob-exists readme.md", root)).toBe(foldsCase ? "affirmed" : "unverified");
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

  it("git-tracked matches a differently-cased path exactly where the filesystem does, and is unverified rather than contradicted elsewhere (Item 4)", () => {
    writeFileSync(join(root, "Tracked.ts"), "x");
    runGit(["init"], root);
    runGit(["add", "Tracked.ts"], root);
    _clearAnchorMemoForTests();

    expect(evaluateAnchor("git-tracked Tracked.ts", root)).toBe("affirmed");
    _clearAnchorMemoForTests();
    // Item 4: `.git/index` stores one exact casing per path. A case-folded hit on a non-win32
    // platform means the index disagrees with the anchor only in casing -- honestly unverified, not
    // a fabricated `contradicted` (the file is right there under a different case) nor a fabricated
    // `affirmed` (this process cannot tell a case-sensitive APFS volume from a case-insensitive one).
    expect(evaluateAnchor("git-tracked tracked.ts", root)).toBe(foldsCase ? "affirmed" : "unverified");
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

/**
 * The `.git` machinery is the one part of anchor evaluation that cannot be root-contained --
 * submodules and worktrees legitimately point their gitdir outside the working tree, so
 * `resolveWithinRoot` would break real repositories. Symlink refusal is the containment that *is*
 * available there, and a size cap is what keeps an adversarial `index` from being read whole.
 *
 * Symlink creation needs SeCreateSymbolicLinkPrivilege on Windows, so those cases are POSIX-only.
 */
describe("git anchors: untrusted .git machinery", () => {
  const isWindows = process.platform === "win32";

  it.skipIf(isWindows)("refuses a symlinked .git rather than following it to another repository", () => {
    // A real repository somewhere else on disk, standing in for whatever a planted link would target.
    const elsewhere = mkdtempSync(join(tmpdir(), "mem-anchors-elsewhere-"));
    try {
      runGit(["init", "--initial-branch=main"], elsewhere);
      // Sanity: read directly, the branch is knowable -- so a later "unverified" is the refusal
      // talking, not an unreadable fixture.
      expect(evaluateAnchor("git-branch-is main", elsewhere)).toBe("affirmed");

      symlinkSync(join(elsewhere, ".git"), join(root, ".git"), "dir");
      clearAnchorCaches();
      expect(evaluateAnchor("git-branch-is main", root)).toBe("unverified");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it.skipIf(isWindows)("refuses a .git file whose gitdir: pointer resolves to a symlink", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "mem-anchors-elsewhere-"));
    try {
      runGit(["init", "--initial-branch=main"], elsewhere);
      const linkPath = join(root, "linked-gitdir");
      symlinkSync(join(elsewhere, ".git"), linkPath, "dir");
      writeFileSync(join(root, ".git"), `gitdir: ${linkPath}\n`);
      clearAnchorCaches();
      expect(evaluateAnchor("git-branch-is main", root)).toBe("unverified");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses a .git pointer file too large to be a gitdir: line", () => {
    // A real gitdir the pointer resolves to, so the pre-cap behaviour is a genuine "affirmed" and the
    // post-cap "unverified" can only be the size check talking.
    const elsewhere = mkdtempSync(join(tmpdir(), "mem-anchors-gitdir-"));
    try {
      runGit(["init", "--initial-branch=main"], elsewhere);
      const pointer = `gitdir: ${join(elsewhere, ".git")}\n`;
      writeFileSync(join(root, ".git"), pointer);
      clearAnchorCaches();
      expect(evaluateAnchor("git-branch-is main", root)).toBe("affirmed");

      // Same pointer, padded past the cap: a real pointer is one short line, so kilobytes of it is a
      // file being used as something other than a gitdir pointer.
      writeFileSync(join(root, ".git"), pointer + "x".repeat(8192));
      clearAnchorCaches();
      expect(evaluateAnchor("git-branch-is main", root)).toBe("unverified");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses an oversized .git/index instead of reading it whole into memory", () => {
    runGit(["init", "--initial-branch=main"], root);
    writeFileSync(join(root, "tracked.txt"), "content");
    runGit(["add", "tracked.txt"], root);
    clearAnchorCaches();
    // A genuinely parseable index, so the assertion below is about size alone.
    expect(evaluateAnchor("git-tracked tracked.txt", root)).toBe("affirmed");

    // Extend past the cap. `truncate` grows sparsely and leaves the real entries at the front, so a
    // parser that ignores the tail would still succeed -- only the pre-read size check stops it.
    truncateSync(join(root, ".git", "index"), 33_000_000);
    clearAnchorCaches();
    // Nothing can be confidently reported as tracked, so the verdict is withheld, never fabricated.
    expect(evaluateAnchor("git-tracked tracked.txt", root)).toBe("unverified");
  });
});

describe("valid-until", () => {
  /** A date this far out cannot be reached by clock skew or a slow test run. */
  function yearsFromNow(years: number): string {
    const when = new Date();
    when.setFullYear(when.getFullYear() + years);
    return when.toISOString();
  }

  it("affirms before the date and contradicts after it", () => {
    expect(evaluateAnchor(`valid-until ${yearsFromNow(5)}`, root)).toBe("affirmed");
    expect(evaluateAnchor(`valid-until ${yearsFromNow(-5)}`, root)).toBe("contradicted");
  });

  it("reads a bare date as the end of that day, not its midnight start", () => {
    // Anyone writing `valid-until 2026-12-31` means "through the 31st", not "expired the instant
    // the 31st began". Today's own date must therefore still affirm.
    const today = new Date().toISOString().slice(0, 10);
    expect(evaluateAnchor(`valid-until ${today}`, root)).toBe("affirmed");
  });

  it("is unverified for a date it cannot parse, never contradicted", () => {
    // A typo must not read as "this fact has expired" and suppress a true fact.
    expect(evaluateAnchor("valid-until next friday", root)).toBe("unverified");
    expect(evaluateAnchor("valid-until 2026-13-45", root)).toBe("unverified");
    expect(evaluateAnchor("valid-until", root)).toBe("unverified");
  });

  it("reads no filesystem state at all", () => {
    // The only predicate with no path argument: it must behave identically against a root that does
    // not exist, since there is nothing for it to look at there or anywhere else.
    expect(evaluateAnchor(`valid-until ${yearsFromNow(5)}`, join(root, "no", "such", "dir"))).toBe("affirmed");
  });

  describe("Item 2: a bare date expires at the end of the user's local day, not UTC end-of-day", () => {
    const originalTZ = process.env.TZ;

    beforeEach(() => {
      // UTC-8 (UTC-7 during DST). A user here reaches local 4pm on the target date at 23:59:59.999Z
      // -- exactly the moment the old `${raw}T23:59:59.999Z` construction expired the fact, hours
      // before this user's own day was over.
      process.env.TZ = "America/Los_Angeles";
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      process.env.TZ = originalTZ;
    });

    it("is still affirmed after UTC end-of-day has passed, while it is still the 15th locally", () => {
      // 2026-06-16T05:00:00.000Z is already past UTC end-of-day for the 15th
      // (2026-06-15T23:59:59.999Z), but only 2026-06-15T22:00:00 local (America/Los_Angeles is
      // UTC-7 in June, DST) -- still squarely inside the local day the anchor promises to hold
      // through. The old `${raw}T23:59:59.999Z` construction would have contradicted here, hours
      // before this user's own day was over.
      vi.setSystemTime(new Date("2026-06-16T05:00:00.000Z"));
      expect(evaluateAnchor("valid-until 2026-06-15", root)).toBe("affirmed");
    });

    it("contradicts only once local end-of-day has actually passed", () => {
      // Local midnight starting the 16th is 07:00:00.000Z (UTC-7 DST offset) -- one second past
      // local end-of-day for the 15th.
      vi.setSystemTime(new Date("2026-06-16T07:00:00.001Z"));
      expect(evaluateAnchor("valid-until 2026-06-15", root)).toBe("contradicted");
    });

    it("is unverified for an out-of-range calendar date rather than silently rolling into a neighboring day", () => {
      expect(evaluateAnchor("valid-until 2026-02-30", root)).toBe("unverified");
    });
  });
});

/**
 * Item 3: `existsFile`/`mtimeOrNull`/the `glob-exists` directory walk used to catch *every*
 * `statSync`/`readdirSync` error -- permission denied, an I/O error, anything -- and report it as
 * absence, turning a check that never ran into a fabricated `contradicted` (or, for `file-absent`,
 * a fabricated `affirmed`). `isGenuineAbsence` is the classification that fix depends on: only
 * `ENOENT`/`ENOTDIR` actually mean "nothing is there".
 *
 * Unit-testing the classification directly against synthetic errors is this task's stated first
 * preference over a real unreadable-filesystem fixture: `chmod 000` does not deny read access on
 * Windows the way it does on POSIX, so a real-permissions test can only ever run on POSIX CI.
 */
describe("isGenuineAbsence (Item 3: errno classification)", () => {
  it("treats ENOENT and ENOTDIR as genuine absence", () => {
    expect(isGenuineAbsence(Object.assign(new Error("no such file"), { code: "ENOENT" }))).toBe(true);
    expect(isGenuineAbsence(Object.assign(new Error("not a directory"), { code: "ENOTDIR" }))).toBe(true);
  });

  it("treats every other errno as unknown, not absence", () => {
    expect(isGenuineAbsence(Object.assign(new Error("permission denied"), { code: "EACCES" }))).toBe(false);
    expect(isGenuineAbsence(Object.assign(new Error("operation not permitted"), { code: "EPERM" }))).toBe(false);
    expect(isGenuineAbsence(Object.assign(new Error("i/o error"), { code: "EIO" }))).toBe(false);
    expect(isGenuineAbsence(Object.assign(new Error("too many symlinks"), { code: "ELOOP" }))).toBe(false);
  });

  it("treats a codeless error, or a non-error value, as unknown rather than absence", () => {
    expect(isGenuineAbsence(new Error("something went wrong"))).toBe(false);
    expect(isGenuineAbsence("a plain string")).toBe(false);
    expect(isGenuineAbsence(undefined)).toBe(false);
    expect(isGenuineAbsence(null)).toBe(false);
  });
});

/**
 * Real-permissions counterpart to the unit tests above, gated `skipIf(isWindows)` per this file's own
 * `git anchors: untrusted .git machinery` precedent: `chmod` on Windows only toggles the read-only
 * bit and carries no read-permission meaning, so it cannot reproduce EACCES there. CI runs
 * ubuntu-latest, so this executes on every push despite the local dev machine being Windows.
 */
describe("Item 3: a permission error is unverified, not fabricated absence", () => {
  const isWindows = process.platform === "win32";
  const isRoot = process.getuid?.() === 0;

  // Root ignores directory permission bits entirely, so this suite is also meaningless (and would
  // false-negative) under a root-run CI container.
  it.skipIf(isWindows || isRoot)(
    "file-exists / file-absent are unverified, not contradicted/affirmed, for a file behind an unreadable directory",
    () => {
      const blocked = join(root, "blocked");
      mkdirSync(blocked);
      writeFileSync(join(blocked, "target.txt"), "x");
      chmodSync(blocked, 0o000);
      try {
        clearAnchorCaches();
        // Neither predicate ever actually ran the check -- both must decline, not assert opposite
        // fabricated verdicts.
        expect(evaluateAnchor("file-exists blocked/target.txt", root)).toBe("unverified");
        clearAnchorCaches();
        expect(evaluateAnchor("file-absent blocked/target.txt", root)).toBe("unverified");
      } finally {
        chmodSync(blocked, 0o700);
      }
    },
  );

  it.skipIf(isWindows || isRoot)(
    "file-newer-than is unverified, not contradicted, when one side is behind an unreadable directory",
    () => {
      const blocked = join(root, "blocked");
      mkdirSync(blocked);
      writeFileSync(join(blocked, "a.txt"), "a");
      writeFileSync(join(root, "b.txt"), "b");
      chmodSync(blocked, 0o000);
      try {
        clearAnchorCaches();
        // The old behaviour treated a's unreadable mtime as `null` (same as "does not exist"), which
        // `evaluateFileNewerThan` turns into `contradicted` -- a comparison mem never performed.
        expect(evaluateAnchor("file-newer-than blocked/a.txt b.txt", root)).toBe("unverified");
      } finally {
        chmodSync(blocked, 0o700);
      }
    },
  );

  it.skipIf(isWindows || isRoot)(
    "glob-exists is unverified, not contradicted, when the walk cannot read a directory it must descend into",
    () => {
      const blocked = join(root, "blocked");
      mkdirSync(blocked);
      writeFileSync(join(blocked, "widget.test.ts"), "x");
      chmodSync(blocked, 0o000);
      try {
        clearAnchorCaches();
        // The walk never actually looked inside `blocked`, so it cannot positively deny a match
        // lives there -- the same "skipped, so unverified" rule this file's `.git`/`node_modules`
        // test already covers for a different reason (Fix 2).
        expect(evaluateAnchor("glob-exists **/*.test.ts", root)).toBe("unverified");
      } finally {
        chmodSync(blocked, 0o700);
      }
    },
  );
});
