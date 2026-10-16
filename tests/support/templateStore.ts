/** A store built once per run (tests/setup/template-store.ts, removed in its teardown) and copied per test, for the many tests that need an empty, fully migrated store and do not exercise creating one. A fresh `openStorage` is seven separate fsync-bearing commits plus the migration transaction (src/db.ts's `openDb`), which a loaded machine stretches to tens of milliseconds a test; a file copy of the finished store costs a fraction of that and is byte-for-byte what `openStorage` leaves behind. The template is built through `openStorage` itself, never a hand-written schema, so it cannot drift from src/. A test of store creation, migration or snapshot-on-open keeps a real fresh store. */
import Database from "better-sqlite3";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { inject } from "vitest";

import { openStorage } from "../../src/storage.js";

/** Puts a copy of the template store at `dbPath` (its directory created when absent) and returns `dbPath`. The copy is an existing, empty, fully migrated store at epoch 0, which is what the first open of a fresh one leaves. */
export function copyTemplateStore(dbPath: string): string {
  mkdirSync(dirname(dbPath), { recursive: true });
  copyFileSync(inject("templateStorePath"), dbPath);
  return dbPath;
}

/** Copies the template store to `dbPath` and opens it through `openStorage`, as a test opens its own store. */
export function openTemplateStore(dbPath: string): Database.Database {
  return openStorage(copyTemplateStore(dbPath));
}
