import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

import { openStorage } from "../../src/storage.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** The path of the finished template store that tests/support/templateStore.ts copies. */
    templateStorePath: string;
  }
}

/** Builds the template store once for the whole run and hands its path to every worker; the returned teardown runs in the main process, which a terminated worker never reaches. A worker-side `process.on("exit")` hook did not fire reliably, so those directories were left in the OS temp folder. The store is built through `openStorage` itself, never a hand-written schema, so it cannot drift from src/. */
export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), "mem-template-store-"));
  const teardown = (): void => {
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const path = join(dir, "mem.db");
    const db = openStorage(path);
    try {
      // Folds the write-ahead log into the main file, so a plain file copy is the whole store.
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
      if (existsSync(sidecar)) {
        throw new Error(`the template store left ${sidecar} behind, so a copy of ${path} alone would not be the whole store`);
      }
    }
    project.provide("templateStorePath", path);
  } catch (error) {
    teardown();
    throw error;
  }
  return teardown;
}
