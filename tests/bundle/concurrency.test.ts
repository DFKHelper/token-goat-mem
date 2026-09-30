/**
 * Several real `mem` processes writing and reading one store at the same time.
 *
 * mem has no daemon: every command is a short-lived process that opens the SQLite file, does its
 * work under `BEGIN IMMEDIATE`, and exits. Nothing in-process can exercise the part of that design
 * that matters most -- separate OS processes contending for one WAL database -- because a single
 * `Database` handle serialises everything by construction. The in-process race tests
 * (tests/capture.test.ts, tests/exportImport.test.ts) pin one interleave deterministically; this
 * one lets the scheduler pick thousands of them and checks the invariants that must hold under all.
 *
 * The workers start against a store that does not exist yet, so schema creation and migrations race
 * too: the first-open path is where a concurrent `CREATE`/`ALTER` would surface as a SQLITE_BUSY or
 * a "duplicate column" failure.
 *
 * Invariants asserted:
 *  - every command exits 0, and nothing on stderr names SQLITE_BUSY or a locked database;
 *  - no write is lost: each worker's unique facts are all present exactly once;
 *  - the reaffirm path stays atomic across processes: one sentence stated by every worker, several
 *    times, is one row, and every statement of it after the first is audited as a reaffirm.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BUNDLE = fileURLToPath(new URL("../../dist/token-goat-mem.mjs", import.meta.url));

/** Parallel processes. Enough to keep several writers queued on the lock at once on a 2-core CI runner. */
const WORKERS = 6;
/** Commands per worker; each iteration is a unique remember, a shared remember, and a recall. */
const ITERATIONS = 4;
const SHARED_SENTENCE = "the build uses esbuild not webpack";

interface CommandResult {
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

let memHome: string;
let root: string;

/** Runs one bundle command asynchronously, so commands from different workers genuinely overlap. */
function runAsync(args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], {
      env: { ...process.env, TOKEN_GOAT_MEM_HOME: memHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ args, stdout, stderr, exitCode: code ?? 1 }));
  });
}

function uniqueSentence(worker: number, iteration: number): string {
  return `worker ${worker} observed invariant number ${iteration}`;
}

/** One worker: its commands run in sequence, as one agent session's would; workers run in parallel. */
async function worker(index: number): Promise<CommandResult[]> {
  const results: CommandResult[] = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    results.push(await runAsync(["remember", uniqueSentence(index, iteration), "--kind", "fact", "--root", root]));
    results.push(await runAsync(["remember", SHARED_SENTENCE, "--kind", "decision", "--root", root]));
    results.push(await runAsync(["recall", "invariant", "--root", root]));
  }
  return results;
}

beforeEach(() => {
  memHome = mkdtempSync(join(tmpdir(), "mem-concurrency-home-"));
  root = mkdtempSync(join(tmpdir(), "mem-concurrency-root-"));
});

afterEach(() => {
  rmSync(memHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("concurrent mem processes against one store", () => {
  it("loses no write, duplicates no reaffirm, and never surfaces SQLITE_BUSY", async () => {
    const perWorker = await Promise.all(Array.from({ length: WORKERS }, (_unused, index) => worker(index)));
    const results = perWorker.flat();

    for (const result of results) {
      expect(result.exitCode, `mem ${result.args.join(" ")} failed:\n${result.stderr}`).toBe(0);
      expect(result.stderr).not.toMatch(/SQLITE_BUSY|database is locked/iu);
    }

    const db = new Database(join(memHome, "mem.db"), { readonly: true });
    try {
      for (let index = 0; index < WORKERS; index++) {
        for (let iteration = 0; iteration < ITERATIONS; iteration++) {
          const count = db
            .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM facts WHERE text = ?")
            .get(uniqueSentence(index, iteration));
          expect(count?.n, `lost or duplicated: ${uniqueSentence(index, iteration)}`).toBe(1);
        }
      }

      const shared = db
        .prepare<[string], { id: string }>("SELECT id FROM facts WHERE text = ?")
        .all(SHARED_SENTENCE);
      expect(shared).toHaveLength(1);

      const reaffirms = db
        .prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM audit_log WHERE fact_id = ? AND event = 'capture_reaffirmed'"
        )
        .get(shared[0]?.id ?? "");
      expect(reaffirms?.n).toBe(WORKERS * ITERATIONS - 1);
    } finally {
      db.close();
    }
  });
});
