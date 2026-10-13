/** A `mem` process that finds the store's write lock held waits for it, rather than failing with SQLITE_BUSY after better-sqlite3's default five seconds. Another writer can legitimately hold the lock longer than that: on a loaded machine a node start alone takes 5-11 s, so a writer queued behind a stalled sibling process outlives the default. A lock held for longer than the default is simulated deterministically here with one `BEGIN IMMEDIATE` connection, and the waiter is a real bundle process. */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb } from "../../src/db.js";
import { BUNDLE_PATH as BUNDLE } from "../support/bundle.js";
import { SPAWN_TIMEOUT_FLOOR_MS } from "../support/spawnTimeoutFloorMs.js";

/** Longer than better-sqlite3's five second default, with margin for the waiter to reach the lock after its preload ran. */
const LOCK_HELD_MS = 9_000;
const SENTENCE = "the busy timeout outlasts a stalled sibling writer";

let memHome: string;
let root: string;

beforeEach(() => {
  memHome = mkdtempSync(join(tmpdir(), "mem-busy-home-"));
  root = mkdtempSync(join(tmpdir(), "mem-busy-root-"));
});

afterEach(() => {
  rmSync(memHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("the store's busy timeout", { timeout: SPAWN_TIMEOUT_FLOOR_MS }, () => {
  it("opens every connection with a busy timeout above better-sqlite3's five second default", () => {
    const db = openDb(join(memHome, "mem.db"), { autoSnapshot: false });
    try {
      expect(db.pragma("busy_timeout", { simple: true })).toBeGreaterThan(5_000);
    } finally {
      db.close();
    }
  });

  it("lets a capture wait out a write lock held longer than five seconds", async () => {
    const dbPath = join(memHome, "mem.db");
    openDb(dbPath, { autoSnapshot: false }).close();

    // The preload runs before the bundle does, so the marker says when the waiter process is up and about to contend.
    const marker = join(memHome, "waiter-started");
    const preload = join(memHome, "preload.cjs");
    writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1");`);

    const holder = new Database(dbPath);
    let stdout = "";
    let stderr = "";
    let released = false;
    try {
      holder.exec("BEGIN IMMEDIATE");
      const exitCode = new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, ["-r", preload, BUNDLE, "remember", SENTENCE, "--kind", "fact", "--root", root], {
          env: { ...process.env, TOKEN_GOAT_MEM_HOME: memHome },
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? 1));
      });

      while (!existsSync(marker)) {
        await sleep(50);
      }
      await sleep(LOCK_HELD_MS);
      holder.exec("COMMIT");
      released = true;

      expect(await exitCode, `mem remember waited for a lock held ${LOCK_HELD_MS} ms\nstderr: ${stderr}\nstdout: ${stdout}`).toBe(0);
    } finally {
      if (!released) {
        holder.exec("ROLLBACK");
      }
      holder.close();
    }

    const check = new Database(dbPath, { readonly: true });
    try {
      const row = check.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM facts WHERE text = ?").get(SENTENCE);
      expect(row?.n).toBe(1);
    } finally {
      check.close();
    }
  });
});
