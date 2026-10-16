/** Several real `mem` processes writing and reading one store at the same time. mem has no daemon: every command is a short-lived process that opens the SQLite file, does its work under `BEGIN IMMEDIATE`, and exits. Nothing in-process can exercise the part of that design that matters most -- separate OS processes contending for one WAL database -- because a single `Database` handle serialises everything by construction. The in-process race tests (tests/capture.test.ts, tests/exportImport.test.ts) pin one interleave deterministically; this one is the cross-process smoke (three workers, one iteration, nine commands, no timeout override), and the same invariants over many interleaves, plus the first-open race, are in tests/unit/db-contention.test.ts. The workers start against a store that does not exist yet, so schema creation and migrations race too: the first-open path is where a concurrent `CREATE`/`ALTER` would surface as a SQLITE_BUSY or a "duplicate column" failure. Invariants asserted: - every command exits 0, and nothing on stderr names SQLITE_BUSY or a locked database; - no write is lost: each worker's unique facts are all present exactly once; - the reaffirm path stays atomic across processes: one sentence stated by every worker, several times, is one row, and every statement of it after the first is audited as a reaffirm. */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUNDLE_PATH as BUNDLE } from "../support/bundle.js";

/** Parallel processes: enough for three writers to meet on a store that does not exist yet. */
const WORKERS = 3;
/** Commands per worker; each iteration is a unique remember, a shared remember, and a recall. */
const ITERATIONS = 1;
const SHARED_SENTENCE = "the build uses esbuild not webpack";
/** A diagnostic bound under vitest's 30 s testTimeout so a hung worker fails naming its command and stderr; it is not what makes the test pass. */
const SPAWN_TIMEOUT_MS = 25_000;

interface CommandResult {
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

let memHome: string;
let root: string;

interface TrackedChild {
  readonly child: ChildProcess;
  /** Settles once the child's pipes are closed, which on Windows is when its handles on the store are released. */
  readonly closed: Promise<void>;
}

/** Every child this test started, so afterEach can end and reap one that a failed assertion or a test timeout left running. */
const tracked = new Set<TrackedChild>();

/** Runs one bundle command asynchronously, so commands from different workers genuinely overlap; a child that is killed (the spawn time bound, or afterEach) rejects with its command and stderr instead of resolving as a failed exit. */
function runAsync(args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], {
      env: { ...process.env, TOKEN_GOAT_MEM_HOME: memHome },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SPAWN_TIMEOUT_MS,
    });
    const closed = new Promise<void>((done) => {
      child.once("close", () => done());
      child.once("error", () => done());
    });
    tracked.add({ child, closed });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`mem ${args.join(" ")} was killed by ${signal} (spawn bound ${SPAWN_TIMEOUT_MS} ms)\nstderr: ${trimmed(stderr)}\nstdout: ${trimmed(stdout)}`));
        return;
      }
      resolve({ args, stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

const MAX_DIAGNOSTIC_CHARS = 2000;

function trimmed(text: string): string {
  return text.length > MAX_DIAGNOSTIC_CHARS ? `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}... [${text.length - MAX_DIAGNOSTIC_CHARS} more chars]` : text;
}

/** The bundle's size and mtime, so a failure that coincides with a rebuild mid-run names itself. */
function bundleStat(): string {
  try {
    const stat = statSync(BUNDLE);
    return `${BUNDLE} size=${stat.size} mtime=${stat.mtime.toISOString()}`;
  } catch (error) {
    return `${BUNDLE} unreadable: ${String(error)}`;
  }
}

/** Everything needed to diagnose one failed command from the assertion message alone. */
function describeCommand(result: CommandResult): string {
  return [
    `mem ${result.args.join(" ")} exit=${result.exitCode}`,
    `stderr: ${trimmed(result.stderr)}`,
    `stdout: ${trimmed(result.stdout)}`,
    bundleStat(),
  ].join("\n");
}

/** Every command that did not exit 0, for the messages of the store-level assertions: a missing write or reaffirm is usually the echo of a command that failed. */
function failedCommands(results: readonly CommandResult[]): string {
  const failed = results.filter((result) => result.exitCode !== 0);
  return failed.length === 0 ? `all ${results.length} commands exited 0; ${bundleStat()}` : failed.map(describeCommand).join("\n---\n");
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

afterEach(async () => {
  // Kill and reap every child before the rmSync below: a live worker holds the store's files open, and on Windows that fails the removal.
  const children = [...tracked];
  tracked.clear();
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
  await Promise.all(children.map(({ closed }) => closed));
  rmSync(memHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("concurrent mem processes against one store", () => {
  it("loses no write, duplicates no reaffirm, and never surfaces SQLITE_BUSY", async () => {
    const perWorker = await Promise.all(Array.from({ length: WORKERS }, (_unused, index) => worker(index)));
    const results = perWorker.flat();

    for (const result of results) {
      expect(result.exitCode, describeCommand(result)).toBe(0);
      expect(result.stderr, describeCommand(result)).not.toMatch(/SQLITE_BUSY|database is locked/iu);
    }

    const db = new Database(join(memHome, "mem.db"), { readonly: true });
    try {
      for (let index = 0; index < WORKERS; index++) {
        for (let iteration = 0; iteration < ITERATIONS; iteration++) {
          const count = db
            .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM facts WHERE text = ?")
            .get(uniqueSentence(index, iteration));
          expect(count?.n, `lost or duplicated: ${uniqueSentence(index, iteration)}\n${failedCommands(results)}`).toBe(1);
        }
      }

      const shared = db
        .prepare<[string], { id: string }>("SELECT id FROM facts WHERE text = ?")
        .all(SHARED_SENTENCE);
      expect(shared, `shared sentence rows\n${failedCommands(results)}`).toHaveLength(1);

      const reaffirms = db
        .prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM audit_log WHERE fact_id = ? AND event = 'capture_reaffirmed'"
        )
        .get(shared[0]?.id ?? "");
      expect(reaffirms?.n, `capture_reaffirmed count\n${failedCommands(results)}`).toBe(WORKERS * ITERATIONS - 1);
    } finally {
      db.close();
    }
  });
});
