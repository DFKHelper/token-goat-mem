/** A store built once per worker and copied per test, for the many tests that need an empty, fully migrated store and do not exercise creating one. A fresh `openStorage` is seven separate fsync-bearing commits plus the migration transaction (src/db.ts's `openDb`), which a loaded machine stretches to tens of milliseconds a test; a file copy of the finished store costs a fraction of that and is byte-for-byte what `openStorage` leaves behind. The template is built through `openStorage` itself, never a hand-written schema, so it cannot drift from src/. A test of store creation, migration or snapshot-on-open keeps a real fresh store. */
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { openStorage } from "../../src/storage.js";

// The path hangs off globalThis, so a test that reloads the module graph (vi.resetModules) still shares the one template and its cleanup hook.
const STATE_KEY = Symbol.for("token-goat-mem.tests.templateStore");

/** The path of the finished template store, built on first use and removed when the worker exits. */
function templatePath(): string {
  const holder = globalThis as unknown as Record<symbol, string | undefined>;
  const existing = holder[STATE_KEY];
  if (existing !== undefined) {
    return existing;
  }
  const dir = mkdtempSync(join(tmpdir(), "mem-template-store-"));
  process.on("exit", () => {
    rmSync(dir, { recursive: true, force: true });
  });
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
  holder[STATE_KEY] = path;
  return path;
}

/** Puts a copy of the template store at `dbPath` (its directory created when absent) and returns `dbPath`. The copy is an existing, empty, fully migrated store at epoch 0, which is what the first open of a fresh one leaves. */
export function copyTemplateStore(dbPath: string): string {
  mkdirSync(dirname(dbPath), { recursive: true });
  copyFileSync(templatePath(), dbPath);
  return dbPath;
}

/** Copies the template store to `dbPath` and opens it through `openStorage`, as a test opens its own store. */
export function openTemplateStore(dbPath: string): Database.Database {
  return openStorage(copyTemplateStore(dbPath));
}
