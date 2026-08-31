/**
 * Branch coverage for `src/anchors.ts`, aimed at the paths that decide a *verdict* rather than the
 * ones that merely run.
 *
 * Anchors are the only mechanism that turns a stored fact into a claim about present reality, and
 * every recalled fact is annotated with the result. A wrong verdict here does not crash: it labels
 * a stale fact `affirmed` and hands it to an agent as ground truth, or labels a live one
 * `contradicted` and withholds it. So the branches worth testing are the ones where the module
 * decides it *cannot* confirm something -- corrupt input, an escape from the root, an exhausted
 * budget -- because each is a place where "I don't know" could silently become "yes" or "no".
 *
 * The module's stance throughout is that only an affirmative predicate result may become
 * `affirmed`, and anything it cannot verify becomes `unverified` rather than a guess. These tests
 * pin that stance at each decision point.
 *
 * Deliberately not covered here, with reasons rather than silence:
 *   - The `MAX_GLOB_ENTRIES_SCANNED` (20,000) cap. Reaching it means creating 20,000 directory
 *     entries; the assertion it would buy is the same `unverified` the budget tests below already
 *     pin through the other route into that branch.
 *   - `segmentToRegExp`'s case-sensitivity ternary, which reads `FS_CASE_INSENSITIVE`. That is a
 *     per-platform constant, so one side is dead on any single runner and only the CI matrix
 *     covers both.
 *   - Three `=== undefined` narrowing guards: `file-newer-than`'s operands and `newest-of`'s
 *     expected argument in `evaluateTokens`, whose arity checks immediately above already make
 *     them unreachable, and `evaluateFileContainsRaw`'s check on its three capture groups, which
 *     its regex guarantees are present whenever it matched at all. All three exist to satisfy the
 *     type system, and a test for them would assert nothing about behaviour.
 *   - Two defensive guards inside the glob walk (`top === undefined` after a `stack.length > 0`
 *     check, and a segment index past the end of the pattern). Neither is reachable by any input;
 *     both are there so a future change to the traversal cannot silently read past its bounds.
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _clearAnchorMemoForTests, evaluateAnchor } from "../src/anchors.js";

const isWindows = process.platform === "win32";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-anchor-branch-"));
  _clearAnchorMemoForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  _clearAnchorMemoForTests();
  rmSync(root, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────── malformed stored anchors ─────

/**
 * Capture-time validation rejects a malformed anchor, so these strings cannot be stored by
 * `mem remember`. They can still *arrive* -- through `mem import`, a database written by an older
 * version, or a hand-edited row -- and `evaluateAnchor` runs against whatever the row holds. Its
 * contract is that it never fabricates a verdict from input it cannot parse.
 */
describe("an anchor that survived into the database malformed is unverified, never a guess", () => {
  const malformed: ReadonlyArray<readonly [string, string]> = [
    ["file-newer-than with one operand", "file-newer-than a.txt"],
    ["file-newer-than with three operands", "file-newer-than a.txt b.txt c.txt"],
    ["file-absent with no operand", "file-absent"],
    ["file-absent with two operands", "file-absent a.txt b.txt"],
    ["newest-of with a single candidate", "newest-of a.txt"],
    ["git-tracked with no operand", "git-tracked"],
    ["git-tracked with two operands", "git-tracked a.txt b.txt"],
    ["package-version with one operand", "package-version package.json"],
    ["glob-exists with two operands", "glob-exists *.ts *.js"],
  ];

  for (const [label, anchor] of malformed) {
    it(`${label} is unverified`, () => {
      expect(evaluateAnchor(anchor, root)).toBe("unverified");
    });
  }
});

/**
 * Path arguments are resolved against the root and refused if they land outside it. The refusal is
 * `unverified` rather than `contradicted`: mem has no business reading the path, so it has no
 * evidence either way, and reporting "denied" would be a claim it cannot support.
 */
describe("a path argument escaping the root is unverified, not contradicted", () => {
  const escaping: ReadonlyArray<readonly [string, string]> = [
    ["file-absent", "file-absent ../outside.txt"],
    ["newest-of expected", "newest-of ../outside.txt a.txt"],
    ["newest-of candidate", "newest-of a.txt ../outside.txt"],
    ["git-tracked", "git-tracked ../outside.txt"],
    ["file-contains", "file-contains ../outside.txt needle"],
  ];

  for (const [label, anchor] of escaping) {
    it(`${label} refuses to answer for a path outside the root`, () => {
      writeFileSync(join(root, "a.txt"), "a", "utf8");
      expect(evaluateAnchor(anchor, root)).toBe("unverified");
    });
  }

  it("file-contains with no substring is unverified", () => {
    expect(evaluateAnchor("file-contains a.txt", root)).toBe("unverified");
  });

  it("glob-exists refuses a pattern that walks upward", () => {
    // `..` is rejected on the pattern itself rather than after resolution, so no directory above
    // the root is ever read -- the check has to happen before the walk, not during it.
    expect(evaluateAnchor("glob-exists ../*.ts", root)).toBe("unverified");
  });
});

// ───────────────────────────────────────────────────────────── corrupt .git/index ─────

/** Builds one `.git/index` entry: 62 bytes of metadata, then the path, then NUL, padded to 8. */
function indexEntry(path: string, opts: { extended?: boolean; nameLen?: number; omitNul?: boolean; nulByte?: number } = {}): Buffer {
  const pathBuf = Buffer.from(path, "utf8");
  const extended = opts.extended === true;
  // A v3 entry with the extended flag carries two extra bytes between the flags and the path.
  const prefix = extended ? 64 : 62;
  const nameLen = opts.nameLen ?? Math.min(pathBuf.length, 0x0fff);
  const body = opts.omitNul === true ? prefix + pathBuf.length : Math.ceil((prefix + pathBuf.length + 1) / 8) * 8;
  const buf = Buffer.alloc(body);
  buf.writeUInt16BE((extended ? 0x4000 : 0) | nameLen, 60);
  pathBuf.copy(buf, prefix);
  if (opts.nulByte !== undefined) {
    buf.writeUInt8(opts.nulByte, prefix + pathBuf.length);
  }
  return buf;
}

/** The 12-byte `.git/index` header: magic, version, entry count. */
function indexHeader(entryCount: number, version = 2, magic = "DIRC"): Buffer {
  const header = Buffer.alloc(12);
  header.write(magic, 0, 4, "ascii");
  header.writeUInt32BE(version, 4);
  header.writeUInt32BE(entryCount, 8);
  return header;
}

function writeIndex(opts: { magic?: string; version?: number; entryCount?: number; entries?: readonly Buffer[]; truncateTo?: number }): void {
  const gitDir = join(root, ".git");
  mkdirSync(gitDir, { recursive: true });
  const entries = opts.entries ?? [];
  const header = indexHeader(opts.entryCount ?? entries.length, opts.version ?? 2, opts.magic ?? "DIRC");
  let buf = Buffer.concat([header, ...entries]);
  if (opts.truncateTo !== undefined) {
    buf = buf.subarray(0, opts.truncateTo);
  }
  writeFileSync(join(gitDir, "index"), buf);
}

/**
 * `.git/index` is parsed directly rather than by shelling out to git, so mem owns every validation
 * git would otherwise have done. Each malformed shape below must yield `unverified` -- the danger
 * is a parser that reads past its buffer and produces a *path set*, because a path set that is
 * merely incomplete makes `git-tracked` answer `contradicted` for a file that is in fact tracked.
 */
describe("a corrupt .git/index yields unverified, never a partial path set", () => {
  it("rejects a file that is not an index at all", () => {
    writeIndex({ magic: "XXXX", entries: [indexEntry("src/a.ts")] });
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("unverified");
  });

  it("rejects a file too short to hold a header", () => {
    writeIndex({ entries: [], truncateTo: 8 });
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("unverified");
  });

  it("rejects index version 4, whose path-prefix compression this parser does not implement", () => {
    // Guessing at a v4 index would mean emitting wrong paths, which is worse than declining.
    writeIndex({ version: 4, entries: [indexEntry("src/a.ts")] });
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("unverified");
  });

  it("rejects a header claiming more entries than any real repository has", () => {
    writeIndex({ entryCount: 3_000_000, entries: [indexEntry("src/a.ts")] });
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("unverified");
  });

  it("rejects a header that promises an entry the file is too short to contain", () => {
    writeIndex({ entryCount: 1, entries: [], truncateTo: 12 });
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("unverified");
  });

  it("rejects a v3 extended entry truncated before its extra flag bytes", () => {
    const entry = indexEntry("src/a.ts", { extended: true }).subarray(0, 62);
    writeIndex({ version: 3, entryCount: 1, entries: [entry] });
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("unverified");
  });

  it("rejects a long-name entry whose path is never terminated", () => {
    // nameLen 0x0fff means "the length did not fit, scan for the NUL" -- with no NUL to find, the
    // scan would otherwise run to the end of the buffer and emit a path made of trailing garbage.
    writeIndex({ entryCount: 1, entries: [indexEntry("src/a.ts", { nameLen: 0x0fff, omitNul: true })] });
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("unverified");
  });

  it("rejects an entry whose declared name length does not land on a NUL", () => {
    writeIndex({ entryCount: 1, entries: [indexEntry("src/a.ts", { nulByte: 0x41 })] });
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("unverified");
  });

  it("rejects an entry whose padding runs off the end of the file", () => {
    const entry = indexEntry("src/a.ts");
    // Exactly one byte: the path and its NUL both still fit, so parsing succeeds and the entry is
    // added -- and only then does the 8-byte-aligned offset for the next entry land past the end.
    // Dropping more than this trips the earlier NUL check instead and never reaches here.
    writeIndex({ entryCount: 1, entries: [entry.subarray(0, entry.length - 1)] });
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("unverified");
  });
});

/** The positive counterparts, so the rejections above are not passing on a parser that never works. */
describe("a well-formed .git/index is parsed, in each of the three entry shapes", () => {
  it("reads a version 2 entry", () => {
    writeIndex({ entries: [indexEntry("src/a.ts")] });
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("affirmed");
    expect(evaluateAnchor("git-tracked src/b.ts", root)).toBe("contradicted");
  });

  it("reads a version 3 entry carrying the extended flag", () => {
    writeIndex({ version: 3, entries: [indexEntry("src/a.ts", { extended: true })] });
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("affirmed");
  });

  it("reads a long-name entry by scanning to its NUL terminator", () => {
    writeIndex({ entries: [indexEntry("src/a.ts", { nameLen: 0x0fff })] });
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("affirmed");
  });

  it("treats a repository with no index file as tracking nothing, rather than as an error", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    // A freshly-initialized repo has no index yet. "Nothing is tracked" is the true answer here,
    // and it is a different answer from "I could not read the index".
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("contradicted");
  });
});

// ───────────────────────────────────────────────────────────── the .git pointer file ─────

/**
 * In a worktree or submodule, `.git` is a file holding `gitdir: <path>` rather than a directory.
 * Following it is how `git-tracked` works at all in those checkouts, and every way it can fail to
 * resolve has to end at `unverified`.
 */
describe("a .git pointer file is followed, and its failure modes are unverified", () => {
  function writePointer(contents: string): void {
    writeFileSync(join(root, ".git"), contents, "utf8");
  }

  it("follows a relative gitdir pointer", () => {
    const real = join(root, "real-git");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "index"), Buffer.concat([indexHeader(1), indexEntry("src/a.ts")]));
    writePointer("gitdir: real-git\n");
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("affirmed");
  });

  it("follows an absolute gitdir pointer", () => {
    const real = mkdtempSync(join(tmpdir(), "mem-anchor-gitdir-"));
    try {
      writePointer(`gitdir: ${real}\n`);
      // No index inside, so the repo tracks nothing -- but the pointer resolved, which is what
      // separates this from the unresolvable cases below.
      expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("contradicted");
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("is unverified when the pointer file has no gitdir line", () => {
    writePointer("this is not a git pointer\n");
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("unverified");
  });

  it("is unverified when the gitdir line names nothing", () => {
    writePointer("gitdir:   \n");
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("unverified");
  });

  it("is unverified when the pointer resolves to a file rather than a directory", () => {
    writeFileSync(join(root, "not-a-dir"), "x", "utf8");
    writePointer("gitdir: not-a-dir\n");
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("unverified");
  });

  it("is unverified when the pointer target does not exist", () => {
    writePointer("gitdir: nowhere-at-all\n");
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("unverified");
  });

  it("is unverified when the pointer file is larger than any real pointer", () => {
    writePointer("gitdir: real-git\n");
    truncateSync(join(root, ".git"), 8_192);
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("unverified");
  });
});

// ─────────────────────────────────────────────────────────────────── git-branch-is ─────

describe("git-branch-is declines rather than guessing", () => {
  it("is unverified on a detached HEAD, which names a commit and not a branch", () => {
    const gitDir = join(root, ".git");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "9fceb02d0ae598e95dc970b74767f19372d61af8\n", "utf8");
    // There is no current branch to compare against, so neither "yes" nor "no" is supportable.
    expect(evaluateAnchor("git-branch-is main", root)).toBe("unverified");
  });

  it("is unverified when there is no .git at all", () => {
    expect(evaluateAnchor("git-branch-is main", root)).toBe("unverified");
  });
});

// ───────────────────────────────────────────────────────── content and manifest caps ─────

describe("content reads are bounded, and an unreadable shape is unverified", () => {
  it("declines a file-contains target above the read cap instead of reading it", () => {
    const path = join(root, "huge.log");
    writeFileSync(path, "", "utf8");
    // Sparse, so this costs no real bytes -- the cap is on the declared size, which is what the
    // predicate checks before it commits to reading anything.
    truncateSync(path, 1_000_001);
    expect(statSync(path).size).toBeGreaterThan(1_000_000);
    expect(evaluateAnchor("file-contains huge.log needle", root)).toBe("unverified");
  });

  it("declines a directory handed to file-contains", () => {
    mkdirSync(join(root, "adir"), { recursive: true });
    expect(evaluateAnchor("file-contains adir needle", root)).toBe("unverified");
  });

  it("declines a manifest above the read cap", () => {
    const path = join(root, "package.json");
    writeFileSync(path, "{}", "utf8");
    truncateSync(path, 1_000_001);
    expect(evaluateAnchor("package-version package.json pkg@1.0.0", root)).toBe("unverified");
  });

  it("declines a manifest whose JSON root is not an object", () => {
    writeFileSync(join(root, "package.json"), "123", "utf8");
    expect(evaluateAnchor("package-version package.json pkg@1.0.0", root)).toBe("unverified");
  });

  it("declines a package-version argument missing its name or its version", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { pkg: "1.0.0" } }), "utf8");
    expect(evaluateAnchor("package-version package.json @1.0.0", root)).toBe("unverified");
    expect(evaluateAnchor("package-version package.json pkg@", root)).toBe("unverified");
  });
});

// ─────────────────────────────────────────────────────────────────── glob traversal ─────

describe("glob-exists does not descend into .git or node_modules", () => {
  it("will not match through a node_modules directory", () => {
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "target.txt"), "x", "utf8");
    // `*` matches the directory name, but the traversal refuses to enter it, so the file inside is
    // never reached -- contradicted, and specifically not affirmed.
    expect(evaluateAnchor("glob-exists */pkg/target.txt", root)).toBe("contradicted");
  });

  it("will not match through a .git directory", () => {
    mkdirSync(join(root, ".git", "objects"), { recursive: true });
    writeFileSync(join(root, ".git", "objects", "target.txt"), "x", "utf8");
    expect(evaluateAnchor("glob-exists */objects/target.txt", root)).toBe("contradicted");
  });

  it("skips them during a ** walk too, while still finding everything else", () => {
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "hit.txt"), "x", "utf8");
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    writeFileSync(join(root, "src", "deep", "hit.txt"), "x", "utf8");
    expect(evaluateAnchor("glob-exists src/**/hit.txt", root)).toBe("affirmed");
    expect(evaluateAnchor("glob-exists node_modules/**/hit.txt", root)).toBe("contradicted");
  });

  it("supports the single-character wildcard", () => {
    writeFileSync(join(root, "a1.ts"), "x", "utf8");
    expect(evaluateAnchor("glob-exists a?.ts", root)).toBe("affirmed");
    expect(evaluateAnchor("glob-exists a??.ts", root)).toBe("contradicted");
  });
});

// ────────────────────────────────────────────────────────────────── budget exhaustion ─────

/**
 * The soft budget is checked once on entry and again inside the expensive predicates. Reaching the
 * inner checks requires time to pass *during* evaluation, which a real clock cannot be made to do
 * on demand -- so the clock is driven directly: the entry check sees a time inside the budget, and
 * everything after it sees a time past the deadline.
 *
 * The verdict is only half of what matters. A budget-limited `unverified` means "ran out of time",
 * not "the predicate said no", so it must not be memoized -- otherwise one slow call would pin a
 * wrong verdict for every later call at that anchor and root, including unbudgeted ones.
 */
describe("a budget exhausted mid-evaluation yields unverified, and is not remembered as one", () => {
  /** Entry check sees time 0; every subsequent check sees a time past the deadline. */
  function clockThatExpiresAfterEntry(): void {
    let call = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      call += 1;
      return call === 1 ? 0 : 10_000;
    });
  }

  const DEADLINE = 1_000;

  it("bails out of package-version", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { pkg: "1.0.0" } }), "utf8");
    clockThatExpiresAfterEntry();

    expect(evaluateAnchor("package-version package.json pkg@1.0.0", root, DEADLINE)).toBe("unverified");

    vi.restoreAllMocks();
    // Same anchor, same root, no budget: if the bailout had been cached, this would still say
    // unverified. It says affirmed, so the cache was correctly left alone.
    expect(evaluateAnchor("package-version package.json pkg@1.0.0", root)).toBe("affirmed");
  });

  it("bails out of git-tracked", () => {
    writeIndex({ entries: [indexEntry("src/a.ts")] });
    clockThatExpiresAfterEntry();

    expect(evaluateAnchor("git-tracked src/a.ts", root, DEADLINE)).toBe("unverified");

    vi.restoreAllMocks();
    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("affirmed");
  });

  it("bails out of a glob walk, reporting unverified rather than the contradicted it was heading for", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "x", "utf8");
    clockThatExpiresAfterEntry();

    // This is the distinction the branch exists for: an interrupted walk found nothing *yet*, which
    // is not the same as having searched everywhere and found nothing.
    expect(evaluateAnchor("glob-exists src/*.ts", root, DEADLINE)).toBe("unverified");

    vi.restoreAllMocks();
    expect(evaluateAnchor("glob-exists src/*.ts", root)).toBe("affirmed");
  });

  it("bails out of file-contains", () => {
    writeFileSync(join(root, "notes.txt"), "needle", "utf8");
    clockThatExpiresAfterEntry();

    expect(evaluateAnchor("file-contains notes.txt needle", root, DEADLINE)).toBe("unverified");

    vi.restoreAllMocks();
    expect(evaluateAnchor("file-contains notes.txt needle", root)).toBe("affirmed");
  });

  it("is unverified when the deadline had already passed before evaluation began", () => {
    writeFileSync(join(root, "a.txt"), "x", "utf8");
    vi.spyOn(Date, "now").mockReturnValue(10_000);

    expect(evaluateAnchor("file-exists a.txt", root, DEADLINE)).toBe("unverified");

    vi.restoreAllMocks();
    expect(evaluateAnchor("file-exists a.txt", root)).toBe("affirmed");
  });
});

// ─────────────────────────────────────────────────────────────── symlink refusals ─────

/**
 * A symlink anywhere on the path to git metadata would let anything that can write inside the root
 * redirect a `HEAD` or `index` read at a file of its choosing, and `statSync` follows links -- so
 * the refusal has to come before the stat, and it has to be `unverified` rather than a verdict
 * derived from whatever the link pointed at.
 *
 * Skipped on Windows, where creating a symlink needs privileges the test runner does not have.
 * These run on the Linux CI jobs, which is the same split the existing symlink and permission
 * tests already use.
 */
describe("git metadata reached through a symlink is refused", () => {
  it.skipIf(isWindows)("refuses a symlinked .git directory", () => {
    const real = join(root, "real-git");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "HEAD"), "ref: refs/heads/main\n", "utf8");
    symlinkSync(real, join(root, ".git"), "dir");

    expect(evaluateAnchor("git-branch-is main", root)).toBe("unverified");
  });

  it.skipIf(isWindows)("refuses a symlinked .git/HEAD", () => {
    const gitDir = join(root, ".git");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(root, "elsewhere"), "ref: refs/heads/main\n", "utf8");
    symlinkSync(join(root, "elsewhere"), join(gitDir, "HEAD"), "file");

    expect(evaluateAnchor("git-branch-is main", root)).toBe("unverified");
  });

  it.skipIf(isWindows)("refuses a symlinked .git/index", () => {
    const gitDir = join(root, ".git");
    mkdirSync(gitDir, { recursive: true });
    const decoy = join(root, "decoy-index");
    writeFileSync(decoy, Buffer.concat([indexHeader(1), indexEntry("src/a.ts")]));
    symlinkSync(decoy, join(gitDir, "index"), "file");

    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("unverified");
  });

  it.skipIf(isWindows)("refuses a gitdir pointer that resolves to a symlink", () => {
    const real = join(root, "real-git");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(root, "linked-git"), "dir");
    writeFileSync(join(root, ".git"), "gitdir: linked-git\n", "utf8");

    expect(evaluateAnchor("git-tracked src/a.ts", root)).toBe("unverified");
  });

  it.skipIf(isWindows)("does not follow a symlinked entry while walking a ** glob", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "mem-anchor-outside-"));
    try {
      writeFileSync(join(outside, "hit.txt"), "x", "utf8");
      symlinkSync(outside, join(root, "src", "linked"), "dir");

      // Following it would let a link inside the root affirm a fact about a file outside it.
      expect(evaluateAnchor("glob-exists src/**/hit.txt", root)).toBe("contradicted");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────────────────────────────── case-folded index lookups ─────

describe("case-insensitive filesystems fold index paths once and reuse the result", () => {
  it.skipIf(!isWindows)("affirms a differently-cased path, and serves the second lookup from cache", () => {
    writeIndex({ entries: [indexEntry("src/a.ts")] });

    // `.git/index` stores one exact casing, but on this filesystem both spellings name the same
    // file, so an exact-bytes miss is not evidence the path is untracked. Two distinct anchor
    // strings are used deliberately: one string would be served by the verdict memo and would
    // never reach the fold cache at all, so the second lookup would prove nothing.
    expect(evaluateAnchor("git-tracked SRC/A.TS", root)).toBe("affirmed");
    expect(evaluateAnchor("git-tracked Src/A.Ts", root)).toBe("affirmed");
  });
});

// ───────────────────────────────────────────────────────────── the root as a target ─────

describe("a path argument that resolves to the root itself is handled, not mistaken for an escape", () => {
  it("treats the root as symlink-free rather than walking above it", () => {
    const file = join(root, "a.txt");
    writeFileSync(file, "a", "utf8");
    // Backdated so the comparison has a definite answer: created in the same millisecond as the
    // directory, the two mtimes tie and the predicate correctly reports `unverified`, which would
    // mask whether the root was resolved at all.
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(file, old, old);

    // `.` resolves to the root, so the relative path between them is empty. The symlink walk has
    // nothing to inspect and must say so, rather than treating the empty relative path as an
    // escape and refusing, or walking upward out of the root looking for components.
    expect(evaluateAnchor("file-newer-than . a.txt", root)).toBe("affirmed");
  });
});
