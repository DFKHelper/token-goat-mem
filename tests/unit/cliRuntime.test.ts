import { describe, expect, it } from "vitest";

import { assertNonNegativeFlag, assertPositiveFlag, EXIT_INTERNAL_ERROR, EXIT_USER_ERROR, exitCodeForError, UsageError } from "../../src/cliRuntime.js";
import { WiringConflictError, WiringLockError } from "../../src/wiring.js";

describe("assertPositiveFlag", () => {
  it("passes an omitted flag and any value of at least 1", () => {
    expect(() => assertPositiveFlag("--limit", undefined)).not.toThrow();
    expect(() => assertPositiveFlag("--limit", 1)).not.toThrow();
    expect(() => assertPositiveFlag("--age-days", 0.5 + 1, "a positive number")).not.toThrow();
  });

  it.each([0, -3, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s as a usage error", (value) => {
    expect(() => assertPositiveFlag("--limit", value)).toThrow(new UsageError("--limit must be a positive integer"));
  });

  it("completes the message with the flag's own wording", () => {
    expect(() => assertPositiveFlag("--timeout", 0, "a positive integer (milliseconds)")).toThrow(
      "--timeout must be a positive integer (milliseconds)"
    );
  });
});

describe("assertNonNegativeFlag", () => {
  it("passes an omitted flag and zero", () => {
    expect(() => assertNonNegativeFlag("--since-epoch", undefined)).not.toThrow();
    expect(() => assertNonNegativeFlag("--since-epoch", 0)).not.toThrow();
  });

  it.each([-1, Number.NaN])("rejects %s as a usage error", (value) => {
    expect(() => assertNonNegativeFlag("--since-epoch", value)).toThrow(
      new UsageError("--since-epoch must be a non-negative integer")
    );
  });
});

describe("exitCodeForError", () => {
  it("exits 2 for a held managed-file lock, which is neither a bad invocation nor a user-fixable conflict: re-running once the other writer finishes is the fix", () => {
    expect(exitCodeForError(new WiringLockError("x.token-goat-mem.lock is held by process 1"))).toBe(EXIT_INTERNAL_ERROR);
  });

  it("exits 1 for a wiring conflict, so the lock error's 2 is a distinction and not the default for every wiring error", () => {
    expect(exitCodeForError(new WiringConflictError("conflict"))).toBe(EXIT_USER_ERROR);
  });
});
