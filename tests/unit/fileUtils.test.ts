/**
 * `src/fileUtils.ts` is the shared boundary where a raw filesystem errno becomes a message a user
 * reads, and it had no test file of its own -- its branches were only ever reached incidentally,
 * through whichever importer happened to hit a missing file. That leaves the messages themselves
 * unpinned: the module's whole job is that `mem import --from-md /nope` says "file not found" and
 * not "ENOENT: no such file or directory, open '/nope'", and nothing asserted it.
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { readFileWithErrorMapping, statFileWithErrorMapping } from "../../src/fileUtils.js";

class TestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestError";
  }
}

/** A second class, so "the thrown error is the caller's class" cannot pass by coincidence. */
class OtherError extends Error {}

const isWindows = process.platform === "win32";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mem-fileutils-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readFileWithErrorMapping", () => {
  it("returns the file's contents unchanged when the read succeeds", () => {
    const path = join(dir, "ok.txt");
    writeFileSync(path, "line one\nline two\n", "utf8");
    expect(readFileWithErrorMapping(path, TestError)).toBe("line one\nline two\n");
  });

  it("maps ENOENT to 'file not found' and throws the caller's error class", () => {
    const path = join(dir, "missing.txt");
    expect(() => readFileWithErrorMapping(path, TestError)).toThrow(TestError);
    expect(() => readFileWithErrorMapping(path, TestError)).toThrow(`file not found: ${path}`);
    // Same input, different class in: the class is the caller's, not a hard-coded one.
    expect(() => readFileWithErrorMapping(path, OtherError)).toThrow(OtherError);
  });

  it("maps EISDIR to 'is a directory, not a file'", () => {
    expect(() => readFileWithErrorMapping(dir, TestError)).toThrow(/is a directory, not a file|cannot read file/u);
  });

  it.skipIf(isWindows)("maps EACCES to 'permission denied'", () => {
    const path = join(dir, "locked.txt");
    writeFileSync(path, "secret", "utf8");
    chmodSync(path, 0o000);
    try {
      expect(() => readFileWithErrorMapping(path, TestError)).toThrow(`permission denied reading file: ${path}`);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("falls back to the underlying message for an error with no recognised code", () => {
    // A NUL in the path is rejected by node before any syscall, so the thrown error carries
    // ERR_INVALID_ARG_VALUE rather than an errno -- the branch no filesystem state can produce.
    expect(() => readFileWithErrorMapping(join(dir, "a\u0000b"), TestError)).toThrow(TestError);
    expect(() => readFileWithErrorMapping(join(dir, "a\u0000b"), TestError)).toThrow(/^cannot read file: /u);
  });
});

describe("statFileWithErrorMapping", () => {
  it("returns real stats for a file that exists", () => {
    const path = join(dir, "sized.txt");
    writeFileSync(path, "12345", "utf8");
    const stats = statFileWithErrorMapping(path, TestError);
    expect(stats.isFile()).toBe(true);
    expect(stats.size).toBe(5);
  });

  it("stats a directory without error, since statting one is legal", () => {
    expect(statFileWithErrorMapping(dir, TestError).isDirectory()).toBe(true);
  });

  it("maps ENOENT through the same message as the read path", () => {
    const path = join(dir, "missing.txt");
    expect(() => statFileWithErrorMapping(path, TestError)).toThrow(`file not found: ${path}`);
  });
});
