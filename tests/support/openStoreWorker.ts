/** Worker-thread body for tests/unit/db-contention.test.ts: opens each store path in `paths` in turn, all workers released together at every round by a shared-memory barrier, and reports the outcome of every open. A worker thread is a separate SQLite connection running in parallel, which one thread cannot be. */
import { parentPort, workerData } from "node:worker_threads";

import { openDb } from "../../src/db.js";

interface WorkerInput {
  readonly paths: readonly string[];
  readonly barrier: SharedArrayBuffer;
  readonly parties: number;
}

/** Slot 0 counts arrivals, slot 1 is the round generation the last arrival advances. */
function arriveAndWait(slots: Int32Array, parties: number): void {
  const generation = Atomics.load(slots, 1);
  if (Atomics.add(slots, 0, 1) + 1 === parties) {
    Atomics.store(slots, 0, 0);
    Atomics.add(slots, 1, 1);
    Atomics.notify(slots, 1);
    return;
  }
  while (Atomics.load(slots, 1) === generation) {
    Atomics.wait(slots, 1, generation);
  }
}

const input = workerData as WorkerInput;
const slots = new Int32Array(input.barrier);
const outcomes: string[] = [];
for (const path of input.paths) {
  arriveAndWait(slots, input.parties);
  try {
    openDb(path).close();
    outcomes.push("ok");
  } catch (error) {
    outcomes.push(error instanceof Error ? error.message : String(error));
  }
}
parentPort?.postMessage(outcomes);
