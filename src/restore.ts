/** `mem restore`'s engine: replaces the live store's contents with a snapshot's, without ever handing the live file to anything but the live store's own connection. 1. **Stage.** The snapshot is copied (SQLite's online backup API) to a private file beside the live store, so neither the snapshot nor the live store is opened for writing while it is judged. 2. **Validate.** The copy must pass `integrity_check`, carry a schema version this mem can read, and hold a `facts` table with every column mem has always required -- a SQLite file that merely has a table called `facts` is not a mem store. 3. **Migrate.** The copy is brought up to the current schema, so a snapshot an older mem took restores into the columns this one reads. 4. **Swap.** The live store is snapshotted (`pre-restore`), then, in one immediate transaction on the live connection, every table is emptied and refilled from the attached copy and the epoch is moved past both stores. Readers see the old store or the new one, never a mix, and a writer that slipped in after the pre-restore snapshot is detected (the epoch or SQLite's `data_version` moved) and the swap retried, so that snapshot always holds exactly what the restore replaced. A live store that is not a readable database (SQLITE_NOTADB / SQLITE_CORRUPT) is first moved aside to `mem.db.unreadable-<timestamp>` and replaced by a fresh one, so a restore can recover exactly the store that cannot be opened. A failure in steps 1-3 is an {@link UnusableSnapshotError} and leaves the live store and the backup directory untouched. Opens skip the automatic snapshot (`autoSnapshot: false`): its pruning could otherwise delete the very auto snapshot being restored. */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { takeSnapshot, type Snapshot } from "./backup.js";
import { openDb } from "./db.js";
import { MEM_DB_MODE, MEM_HOME_MODE, restrictPermissions } from "./fileUtils.js";
import { LATEST_SCHEMA_VERSION } from "./migrations.js";
import { advanceEpochPast, getEpoch, openStorage } from "./storage.js";

/** The snapshot cannot be restored; nothing was changed. */
export class UnusableSnapshotError extends Error {
  override readonly name = "UnusableSnapshotError";
}

export interface RestoreOptions {
  /** The snapshot file to restore. */
  source: string;
  /** The live store it replaces. */
  dbPath: string;
  /** Where the pre-restore snapshot goes. */
  backupDir: string;
  /** Test seam: runs after each pre-restore snapshot, before the swap checks the store is unchanged. */
  afterPreRestoreSnapshot?: () => void;
}

export interface RestoreResult {
  /** The live store's epoch after the restore: past both the snapshot's and the replaced store's. */
  epoch: number;
  /** The replaced store, restorable to undo this. */
  preRestore: Snapshot;
  /** Where the live store went when it was unreadable and had to be moved aside; absent otherwise. `preRestore` is then a snapshot of the empty replacement, not of that file. */
  unreadable?: string;
}

/** The `facts` columns every mem schema has had since the first: NOT NULL with no migration that adds them. A table missing any of them is someone else's `facts`. */
const REQUIRED_FACT_COLUMNS = ["id", "text", "kind", "scope", "source_type", "captured_at", "status", "confidence"] as const;

/** How many times the swap is retried when the live store changes under the pre-restore snapshot. */
const SWAP_ATTEMPTS = 3;

const RESTORED_SCHEMA = "restored";

export async function restoreStore(options: RestoreOptions): Promise<RestoreResult> {
  const { dbPath } = options;
  const home = dirname(dbPath);
  mkdirSync(home, { recursive: true, mode: MEM_HOME_MODE });
  restrictPermissions(home, MEM_HOME_MODE);
  const staged = join(home, `.restore-${String(process.pid)}-${String(Date.now())}.tmp`);
  try {
    try {
      await stage(options.source, staged);
      validateStore(staged);
      openDb(staged, { autoSnapshot: false }).close();
    } catch (error) {
      if (error instanceof UnusableSnapshotError) {
        throw error;
      }
      throw new UnusableSnapshotError(error instanceof Error ? error.message : String(error));
    }
    return swap(options, staged);
  } finally {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(`${staged}${suffix}`, { force: true });
    }
  }
}

/** Copies `source` to `staged`, a file created owner-only before a single fact row lands in it. */
async function stage(source: string, staged: string): Promise<void> {
  writeFileSync(staged, "", { mode: MEM_DB_MODE, flag: "wx" });
  restrictPermissions(staged, MEM_DB_MODE);
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(staged);
  } finally {
    db.close();
  }
}

function validateStore(path: string): void {
  const db = new Database(path, { fileMustExist: true });
  try {
    const check = db.pragma("integrity_check", { simple: true });
    if (check !== "ok") {
      throw new UnusableSnapshotError(`integrity check failed: ${String(check)}`);
    }
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version > LATEST_SCHEMA_VERSION) {
      throw new UnusableSnapshotError(
        `written by a newer mem (schema v${String(version)}; this mem reads up to v${String(LATEST_SCHEMA_VERSION)}) -- upgrade mem to restore it`
      );
    }
    const columns = new Set(columnNames(db, "main", "facts"));
    if (columns.size === 0) {
      throw new UnusableSnapshotError("no facts table -- not a mem store");
    }
    const missing = REQUIRED_FACT_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new UnusableSnapshotError(`facts table is missing ${missing.join(", ")} -- not a mem store`);
    }
  } finally {
    db.close();
  }
}

/** Opens the live store; when it is not a readable database (SQLITE_NOTADB / SQLITE_CORRUPT), moves it and its sidecars aside and opens a fresh one -- the one case a restore exists for. Any other error propagates. */
function openLive(dbPath: string): { live: Database.Database; unreadable?: string } {
  try {
    return { live: openStorage(dbPath, { autoSnapshot: false }) };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== "SQLITE_NOTADB" && code !== "SQLITE_CORRUPT") {
      throw error;
    }
    const unreadable = `${dbPath}.unreadable-${new Date().toISOString().replaceAll(":", "-")}`;
    renameSync(dbPath, unreadable);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${dbPath}${suffix}`)) {
        renameSync(`${dbPath}${suffix}`, `${unreadable}${suffix}`);
      }
    }
    return { live: openStorage(dbPath, { autoSnapshot: false }), unreadable };
  }
}

function swap(options: RestoreOptions, staged: string): RestoreResult {
  const { live, unreadable } = openLive(options.dbPath);
  try {
    live.prepare(`ATTACH DATABASE ? AS ${RESTORED_SCHEMA}`).run(staged);
    try {
      for (let attempt = 0; attempt < SWAP_ATTEMPTS; attempt += 1) {
        const dataVersion = readDataVersion(live);
        const preRestore = takeSnapshot(live, options.backupDir, "pre-restore");
        options.afterPreRestoreSnapshot?.();
        let epoch: number | undefined;
        try {
          epoch = live
            .transaction(() => (getEpoch(live) === preRestore.epoch && readDataVersion(live) === dataVersion ? replaceContents(live, preRestore.epoch) : undefined))
            .immediate();
        } catch (error) {
          rmSync(preRestore.path, { force: true });
          throw error;
        }
        if (epoch !== undefined) {
          return unreadable === undefined ? { epoch, preRestore } : { epoch, preRestore, unreadable };
        }
        // The store changed after the snapshot was taken: it no longer holds what would be replaced.
        rmSync(preRestore.path, { force: true });
      }
      throw new Error("the store kept changing during the restore; nothing was replaced -- retry");
    } finally {
      try {
        live.exec(`DETACH DATABASE ${RESTORED_SCHEMA}`);
      } catch {
        // Closing the connection below detaches it anyway; never mask the error that got us here.
      }
    }
  } finally {
    live.close();
  }
}

/** SQLite's `data_version`: it moves only when another connection commits a write, which is exactly a concurrent writer that may not have bumped the epoch (a recall-log row, say). */
function readDataVersion(live: Database.Database): number {
  return live.pragma("data_version", { simple: true }) as number;
}

/** Empties every live table and refills it from the attached copy, then moves the epoch past both stores. Runs inside the caller's transaction; foreign keys are checked at its commit, so tables can be filled in any order. */
function replaceContents(live: Database.Database, replacedEpoch: number): number {
  live.pragma("defer_foreign_keys = ON");
  const liveTables = tableNames(live, "main");
  for (const table of liveTables) {
    live.exec(`DELETE FROM main.${quoteIdentifier(table)}`);
  }
  for (const table of tableNames(live, RESTORED_SCHEMA)) {
    if (!liveTables.includes(table)) {
      throw new UnusableSnapshotError(`it has a table this mem does not know: ${table}`);
    }
    const liveColumns = new Set(columnNames(live, "main", table));
    const columns = columnNames(live, RESTORED_SCHEMA, table);
    const unknown = columns.filter((column) => !liveColumns.has(column));
    if (unknown.length > 0) {
      throw new UnusableSnapshotError(`its ${table} table has columns this mem does not know: ${unknown.join(", ")}`);
    }
    const list = columns.map(quoteIdentifier).join(", ");
    live.exec(`INSERT INTO main.${quoteIdentifier(table)} (${list}) SELECT ${list} FROM ${RESTORED_SCHEMA}.${quoteIdentifier(table)}`);
  }
  // The copied `meta` row carries the snapshot's epoch; this moves past it and the replaced store's.
  return advanceEpochPast(live, replacedEpoch);
}

/** The user tables in `schema` (a fixed name this module owns, never input), SQLite's own excluded. */
function tableNames(db: Database.Database, schema: string): string[] {
  return db
    .prepare<[], { name: string }>(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' ORDER BY name`)
    .all()
    .map((row) => row.name);
}

function columnNames(db: Database.Database, schema: string, table: string): string[] {
  return db
    .prepare<[string, string], { name: string }>("SELECT name FROM pragma_table_info(?, ?)")
    .all(table, schema)
    .map((row) => row.name);
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
