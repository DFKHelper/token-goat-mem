/** Pins the stale-lock takeover interleaving where a taker that judged a lock stale must never disturb the live lock another writer put in its place. The process table is replaced (a fixed dead pid, every other pid live) so each step runs in process, with no sleep and no second process. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEAD_PID = 2147483646;
const LIVE_HOLDER_PID = 4242;

const hooks = vi.hoisted(() => ({ onAliveCheck: undefined as ((pid: number) => void) | undefined }));

vi.mock("../src/processAlive.js", () => ({
  processIsAlive: (pid: number): boolean => {
    hooks.onAliveCheck?.(pid);
    return pid !== 2147483646;
  }
}));

import { WiringLockError, writeManagedFile } from "../src/wiring.js";

let dir: string;
let target: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mem-lock-takeover-"));
  target = join(dir, "AGENTS.md");
  lockPath = `${target}.token-goat-mem.lock`;
});

afterEach(() => {
  hooks.onAliveCheck = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("stale lock takeover", () => {
  it("never lets a third writer acquire while the writer that replaced the stale lock still holds its own", () => {
    writeFileSync(target, "original\n", "utf8");
    writeFileSync(lockPath, String(DEAD_PID), "utf8");
    let thirdWriterAcquired: boolean | undefined;

    // A second writer takes the stale lock over and acquires its own in the window after the first taker judged it stale.
    const beforeTakeover = (): void => {
      rmSync(lockPath, { force: true });
      writeFileSync(lockPath, String(LIVE_HOLDER_PID), "utf8");
    };
    // The first taker checks the pid of whatever lock it is about to remove; a third writer tries to acquire at that moment.
    hooks.onAliveCheck = (pid) => {
      if (pid !== LIVE_HOLDER_PID || thirdWriterAcquired !== undefined) {
        return;
      }
      try {
        writeFileSync(lockPath, String(LIVE_HOLDER_PID + 1), { flag: "wx" });
        thirdWriterAcquired = true;
      } catch {
        thirdWriterAcquired = false;
      }
    };

    expect(() => writeManagedFile({ path: target, transform: () => "changed\n" }, { lock: { waitMs: 0, beforeTakeover } })).toThrow(WiringLockError);

    expect(thirdWriterAcquired, "a third writer cannot acquire while the second still holds the lock").toBe(false);
    expect(readFileSync(lockPath, "utf8"), "the second writer's lock is still the one at the path").toBe(String(LIVE_HOLDER_PID));
    expect(readFileSync(target, "utf8")).toBe("original\n");
    expect(readdirSync(dir).filter((name) => name.includes(".stale-") || name.endsWith(".takeover"))).toEqual([]);
  });

  it("backs off without removing anything while another taker is mid-takeover, then takes over once it is done", () => {
    writeFileSync(target, "original\n", "utf8");
    writeFileSync(lockPath, String(DEAD_PID), "utf8");
    const takeoverPath = `${lockPath}.takeover`;
    writeFileSync(takeoverPath, String(LIVE_HOLDER_PID), "utf8");
    const pauses: number[] = [];
    const pause = (ms: number): void => {
      pauses.push(ms);
      rmSync(takeoverPath, { force: true });
    };

    const change = writeManagedFile({ path: target, transform: () => "changed\n" }, { lock: { waitMs: 1_000, pause } });

    expect(pauses.length, "the taker waited once for the rival's takeover to finish").toBe(1);
    expect(change.action).toBe("update");
    expect(readFileSync(target, "utf8")).toBe("changed\n");
    expect(readdirSync(dir).filter((name) => name.endsWith(".lock") || name.endsWith(".takeover"))).toEqual([]);
  });
});
