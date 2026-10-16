/** A `mem` process that finds the store's write lock held waits for it, rather than failing with SQLITE_BUSY after better-sqlite3's default five seconds. Another writer can legitimately hold the lock longer than that: on a loaded machine a node start alone takes 5-11 s, so a writer queued behind a stalled sibling process outlives the default. That a waiter outlasts a real lock is SQLite's contract once the connection carries the timeout, and a test could only watch it by holding a lock for longer than five seconds and guessing when the waiter had reached it, which is a sleep that passes vacuously whenever the waiter is late. So the contract is pinned at the connection instead, with no clock: `openDb` sets the timeout, and the connection a real bundle process opens carries it. Several real processes contending for one store are in tests/bundle/concurrency.test.ts. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb } from "../../src/db.js";
import { runBundleSync, withBundleStore } from "../support/bundle.js";
import { useRealFsync } from "../support/realFsync.js";

useRealFsync();

/** better-sqlite3's own default busy timeout, in milliseconds. */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const SENTENCE = "the busy timeout outlasts a stalled sibling writer";
const BETTER_SQLITE3 = createRequire(import.meta.url).resolve("better-sqlite3");

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

describe("the store's busy timeout", () => {
  it("opens every connection with a busy timeout above better-sqlite3's five second default", () => {
    const db = openDb(join(memHome, "mem.db"), { autoSnapshot: false });
    try {
      expect(db.pragma("busy_timeout", { simple: true })).toBeGreaterThan(DEFAULT_BUSY_TIMEOUT_MS);
    } finally {
      db.close();
    }
  });

  it("gives the connection a real bundle process opens a busy timeout above the default", () => {
    // Loaded into the bundle's node before it runs: every connection reports its busy timeout as it closes, so what is asserted is what the shipped artifact opened, not what the source says.
    const log = join(memHome, "busy-timeouts.log");
    const preload = join(memHome, "record-busy-timeout.cjs");
    writeFileSync(
      preload,
      [
        `const Database = require(${JSON.stringify(BETTER_SQLITE3)});`,
        "const close = Database.prototype.close;",
        `Database.prototype.close = function () { require("node:fs").appendFileSync(${JSON.stringify(log)}, this.pragma("busy_timeout", { simple: true }) + ","); return close.call(this); };`,
      ].join("\n")
    );

    // An existing store, so the only connection is the one `openDb` opens (a fresh store also opens a private seed connection that nothing can contend for).
    withBundleStore(memHome, () => undefined);
    const result = runBundleSync(["remember", SENTENCE, "--kind", "fact", "--root", root], {
      home: memHome,
      env: { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
    });
    expect(result.exitCode, result.stderr).toBe(0);

    const reported = readFileSync(log, "utf8").split(",").filter((entry) => entry !== "").map(Number);
    // Non-firing guard: the preload really saw a connection, so the bound below is not satisfied by an empty log.
    expect(reported.length).toBeGreaterThan(0);
    expect(Math.min(...reported), `busy timeouts the bundle's connections reported: ${reported.join(", ")}`).toBeGreaterThan(DEFAULT_BUSY_TIMEOUT_MS);
  });
});
