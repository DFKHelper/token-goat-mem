/** Tests for the in-place fallback `writeManagedFile`'s lock takes when the filesystem refuses `linkSync` (no hard links): the lock is created with `wx` and the pid written, and a failure after the create must not leave a pidless lock behind. `node:fs` is mocked for this whole file, so it stays apart from `wiringLock.test.ts`. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeManagedFile } from "../src/wiring.js";

const faults = vi.hoisted(() => ({ linkCode: undefined as string | undefined, linkCalls: 0, failWriteSync: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      faults.linkCalls += 1;
      if (faults.linkCode !== undefined) {
        throw Object.assign(new Error(`${faults.linkCode}: hard links are not supported here`), { code: faults.linkCode });
      }
      return actual.linkSync(...args);
    },
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      if (faults.failWriteSync) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return (actual.writeSync as (...rest: unknown[]) => number)(...args);
    },
  };
});

let dir: string;
let target: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mem-lock-fallback-"));
  target = join(dir, "AGENTS.md");
  lockPath = `${target}.token-goat-mem.lock`;
});

afterEach(() => {
  faults.linkCode = undefined;
  faults.linkCalls = 0;
  faults.failWriteSync = false;
  rmSync(dir, { recursive: true, force: true });
});

describe("writeManagedFile lock without hard links", () => {
  it.each(["EPERM", "ENOTSUP"])("falls back to an in-place lock holding this pid when linkSync fails with %s, and releases it", (code) => {
    faults.linkCode = code;
    writeFileSync(target, "original\n", "utf8");
    let lockWhileHeld: string | undefined;
    let transforms = 0;

    const change = writeManagedFile(
      {
        path: target,
        transform: () => {
          transforms += 1;
          // The second call is the re-check under the lock (the file changed once the lock appeared), so the lock's content here is what a rival would read.
          lockWhileHeld = transforms === 2 ? readFileSync(lockPath, "utf8") : lockWhileHeld;
          return "changed\n";
        },
      },
      { lock: { afterCreate: () => writeFileSync(target, "edited by a rival\n", "utf8") } }
    );

    expect(faults.linkCalls, "the hard-link path was attempted, so the in-place path is the fallback under test").toBeGreaterThan(0);
    expect(transforms, "the transform re-ran under the lock").toBe(2);
    expect(change.action, "the write went through").toBe("update");
    expect(readFileSync(target, "utf8"), "the file holds the transformed content").toBe("changed\n");
    expect(lockWhileHeld, "the fallback lock recorded this process's pid while held").toBe(String(process.pid));
    expect(readdirSync(dir).filter((name) => name.includes(".lock")), "no lock or pending file is left after release").toEqual([]);
  });

  it("removes the lock and propagates the error when writing the pid fails, so no pidless lock stays behind", () => {
    faults.linkCode = "EPERM";
    faults.failWriteSync = true;
    writeFileSync(target, "original\n", "utf8");

    expect(() => writeManagedFile({ path: target, transform: () => "changed\n" }, { lock: { waitMs: 0 } })).toThrow("ENOSPC");

    expect(existsSync(lockPath), "the half-created lock was removed").toBe(false);
    expect(readFileSync(target, "utf8"), "the managed file was never written").toBe("original\n");
  });

  it("removes the lock and propagates the error when the afterCreate hook throws on the in-place path", () => {
    faults.linkCode = "ENOTSUP";
    writeFileSync(target, "original\n", "utf8");
    const hookFailure = new Error("afterCreate failed");

    expect(() =>
      writeManagedFile(
        { path: target, transform: () => "changed\n" },
        {
          lock: {
            waitMs: 0,
            afterCreate: () => {
              throw hookFailure;
            },
          },
        }
      )
    ).toThrow(hookFailure);

    expect(existsSync(lockPath), "the lock whose hook failed was removed").toBe(false);
    expect(readFileSync(target, "utf8"), "the managed file was never written").toBe("original\n");
  });
});
