/** Concurrent connections to one store, in one test process. `tests/bundle/concurrency.test.ts` once carried this contract with six real `mem` processes; the contract lives here, where a connection costs milliseconds instead of a node start. Two properties: opening a store that does not exist yet from several connections at once never fails (the first-open race: `PRAGMA journal_mode = WAL` fails at once, without waiting out the busy timeout, when another connection holds the write lock while it converts a fresh file), and writes through several connections to one store lose nothing and duplicate no reaffirm. */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureExplicit } from "../../src/capture.js";
import { openDb } from "../../src/db.js";
import { openStorage } from "../../src/storage.js";
import { useRealFsync } from "../support/realFsync.js";

useRealFsync();

const WORKER_FILE = new URL("../support/openStoreWorker.ts", import.meta.url);

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "mem-db-contention-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Runs one worker thread per entry of `pathLists`, each opening its paths in turn, released together at every round. The barrier has no timeout by design: the main thread watches every worker, and the first one to error or exit without reporting releases all the others (slot 2 of the barrier), terminates them, and rejects with that worker's own failure, so a worker that never started cannot strand the rest. */
async function runOpeners(pathLists: readonly (readonly string[])[]): Promise<string[][]> {
  const barrier = new SharedArrayBuffer(12);
  const slots = new Int32Array(barrier);
  const workers: Worker[] = [];
  const outcomes: (string[] | undefined)[] = pathLists.map(() => undefined);
  let failure: Error | undefined;
  const fail = (error: Error): void => {
    if (failure !== undefined) {
      return;
    }
    failure = error;
    Atomics.store(slots, 2, 1);
    Atomics.add(slots, 1, 1);
    Atomics.notify(slots, 1);
  };
  const done = pathLists.map(
    (paths, index) =>
      new Promise<void>((resolve) => {
        const worker = new Worker(WORKER_FILE, { workerData: { paths, barrier, parties: pathLists.length }, execArgv: ["--import", "tsx"] });
        workers.push(worker);
        worker.once("message", (reported: string[]) => {
          outcomes[index] = reported;
        });
        worker.once("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
        worker.once("exit", (code) => {
          if (outcomes[index] === undefined) {
            fail(new Error(`worker ${index} exited with code ${code} before reporting`));
          }
          resolve();
        });
      })
  );
  await Promise.all(done);
  await Promise.all(workers.map((worker) => worker.terminate()));
  if (failure !== undefined) {
    throw failure;
  }
  return outcomes.map((reported) => reported ?? []);
}

describe("opening a store that does not exist yet from several connections at once", () => {
  const OPENERS = 4;
  const ROUNDS = 12;

  it("never fails with a locked database, whichever connection converts the new file to WAL", async () => {
    const rounds = Array.from({ length: ROUNDS }, (_unused, round) => join(scratch, `round-${round}`, "mem.db"));
    const outcomes = (await runOpeners(Array.from({ length: OPENERS }, () => rounds))).flat();

    expect(outcomes.filter((outcome) => outcome !== "ok")).toEqual([]);
    expect(outcomes).toHaveLength(OPENERS * ROUNDS);
    for (const dbPath of rounds) {
      const store = openDb(dbPath);
      try {
        expect(store.pragma("journal_mode", { simple: true })).toBe("wal");
      } finally {
        store.close();
      }
      expect(readdirSync(dirname(dbPath)).filter((name) => name.includes(".seed-"))).toEqual([]);
    }
  });
});

describe("writes through several connections to one store", () => {
  const CONNECTIONS = 3;
  const ROUNDS = 4;
  const SHARED_SENTENCE = "the build uses esbuild not webpack";

  it("loses no write and audits every restatement of a shared sentence after the first as one reaffirm", () => {
    const root = join(scratch, "root");
    const dbPath = join(scratch, "home", "mem.db");
    const connections = Array.from({ length: CONNECTIONS }, () => openStorage(dbPath));
    try {
      for (let round = 0; round < ROUNDS; round++) {
        connections.forEach((db, index) => {
          captureExplicit(db, { text: `connection ${index} observed invariant number ${round}`, kind: "fact", root });
          captureExplicit(db, { text: SHARED_SENTENCE, kind: "decision", root });
        });
      }

      const reader = connections[0];
      expect(reader).toBeDefined();
      const count = (sql: string, ...params: string[]): number =>
        (reader?.prepare<string[], { n: number }>(sql).get(...params) ?? { n: -1 }).n;
      for (let index = 0; index < CONNECTIONS; index++) {
        for (let round = 0; round < ROUNDS; round++) {
          expect(count("SELECT COUNT(*) AS n FROM facts WHERE text = ?", `connection ${index} observed invariant number ${round}`)).toBe(1);
        }
      }
      expect(count("SELECT COUNT(*) AS n FROM facts WHERE text = ?", SHARED_SENTENCE)).toBe(1);
      expect(
        count(
          "SELECT COUNT(*) AS n FROM audit_log WHERE event = 'capture_reaffirmed' AND fact_id = (SELECT id FROM facts WHERE text = ?)",
          SHARED_SENTENCE
        )
      ).toBe(CONNECTIONS * ROUNDS - 1);
    } finally {
      connections.forEach((db) => db.close());
    }
  });
});
