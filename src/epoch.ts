/**
 * The write epoch's read and write primitives (design plan Section 4: "every write bumps it").
 *
 * Kept apart from src/storage.ts, which owns *when* the epoch moves (every fact write bumps it in the
 * same transaction), so that src/db.ts and src/backup.ts can read it while a connection is being
 * opened -- before migrations run -- without importing storage.ts, which itself imports db.ts.
 * Nothing outside storage.ts should call `writeEpoch`: an epoch moved without an accompanying write
 * no longer describes the store it stamps.
 */

import type Database from "better-sqlite3";

/** Reads the current write epoch, defaulting to `0` on a freshly-initialized database. */
export function getEpoch(db: Database.Database): number {
  const row = db.prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'epoch'").get();
  return row === undefined ? 0 : Number(row.value);
}

/** Upserts the epoch row to `next`. Callers own the transaction and the monotonicity of `next`. */
export function writeEpoch(db: Database.Database, next: number): void {
  db.prepare("INSERT INTO meta (key, value) VALUES ('epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(next));
}
