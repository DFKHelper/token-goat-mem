/** The private seed file a first open converts to WAL (`mem.db.seed-<pid>-<uuid>`): a seed left by a creator that died is swept by the next open, a seed of a live process is never touched, and a seed that cannot be removed never fails an open that otherwise succeeded. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDb } from "../../src/db.js";

const removalFailures = vi.hoisted(() => ({ failOnSeed: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (removalFailures.failOnSeed && String(args[0]).includes(".seed-")) {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      return actual.rmSync(...args);
    },
  };
});

/** A pid no process holds: above every platform's pid range (Linux tops out at 2^22, Windows hands out far smaller values). */
const DEAD_PID = 2_147_483_646;
const SEED_UUID = "0b9c8d7e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

let home: string;
let dbPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-db-seed-"));
  dbPath = join(home, "mem.db");
});

afterEach(() => {
  removalFailures.failOnSeed = false;
  rmSync(home, { recursive: true, force: true });
});

function seedPath(pid: number, suffix = ""): string {
  return `${dbPath}.seed-${pid}-${SEED_UUID}${suffix}`;
}

describe("a leftover seed file", () => {
  it("is removed, with its sidecars, by the next open when the process that made it is gone", () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      writeFileSync(seedPath(DEAD_PID, suffix), "left by a crashed creator");
    }

    openDb(dbPath).close();

    for (const suffix of ["", "-wal", "-shm"]) {
      expect(existsSync(seedPath(DEAD_PID, suffix))).toBe(false);
    }
  });

  it("is removed on the open of a store that already exists too", () => {
    openDb(dbPath).close();
    writeFileSync(seedPath(DEAD_PID), "left by a crashed creator");

    openDb(dbPath).close();

    expect(existsSync(seedPath(DEAD_PID))).toBe(false);
  });

  it("is kept while the process that made it is alive", () => {
    writeFileSync(seedPath(process.pid), "a concurrent opener still writing");

    openDb(dbPath).close();

    expect(existsSync(seedPath(process.pid))).toBe(true);
  });

  it("is kept when its name does not parse as a seed", () => {
    const unparsed = `${dbPath}.seed-notapid-${SEED_UUID}`;
    writeFileSync(unparsed, "not ours");

    openDb(dbPath).close();

    expect(existsSync(unparsed)).toBe(true);
  });
});

describe("a seed that cannot be removed", () => {
  it("does not fail the first open of a new store", () => {
    removalFailures.failOnSeed = true;

    const db = openDb(dbPath);
    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      db.close();
    }
  });

  it("does not fail an open whose sweep meets a leftover it cannot remove", () => {
    writeFileSync(seedPath(DEAD_PID), "left by a crashed creator");
    removalFailures.failOnSeed = true;

    openDb(dbPath).close();

    removalFailures.failOnSeed = false;
    openDb(dbPath).close();
    expect(existsSync(seedPath(DEAD_PID))).toBe(false);
  });
});
