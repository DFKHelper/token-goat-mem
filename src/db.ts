/** SQLite connection and schema for the `facts` table (design plan Section 3), plus two small infra tables every write path shares: `audit_log` (design principle 5 -- "An audit log records what was captured and why. No black box.") and `meta` (the write epoch other modules and the token-goat seam use for cache invalidation, Section 4/6: "every write bumps it"). Kept intentionally narrow: this module only opens the database, ensures its schema exists, and resolves where the database file lives. It does not implement recall, contradiction persistence, GC, or embeddings storage (sqlite-vec) -- those belong to a dedicated storage module and can extend this schema (e.g. a companion vec0 virtual table for embeddings) without conflicting with what is defined here. mem is a short-lived CLI process (Section 3): every `openDb` call opens a fresh connection: no daemon, no long-lived pool, no cross-call caching. */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { hasPendingMigrations, runMigrations } from "./migrations.js";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { snapshotOnOpen } from "./backup.js";
import { MEM_DB_MODE, MEM_HOME_MODE, restrictPermissions } from "./fileUtils.js";

const DB_FILE_NAME = "mem.db";

/** Resolves mem's home directory. `TOKEN_GOAT_MEM_HOME` overrides the default `~/.mem` -- used by tests to isolate the real user home (see tests/setup/isolate-home.ts) and by anyone who wants a non-default location. */
export function resolveMemHome(): string {
  const override = process.env["TOKEN_GOAT_MEM_HOME"];
  if (typeof override === "string" && override.trim().length > 0) {
    return override;
  }
  return join(homedir(), ".mem");
}

/** Resolves the sqlite file path inside a mem home directory (default: `resolveMemHome()`). */
export function resolveDbPath(home: string = resolveMemHome()): string {
  return join(home, DB_FILE_NAME);
}

/** Overrides where snapshots of the store are written (see `resolveBackupDir`). */
export const BACKUP_DIR_ENV = "TOKEN_GOAT_MEM_BACKUP_DIR";

/** Resolves where snapshots of the store live: `TOKEN_GOAT_MEM_BACKUP_DIR` if set, otherwise a sibling of the mem home named after it (`~/.mem-backups` for the default `~/.mem`). A sibling rather than a subdirectory so the backups outlive the thing they back up: deleting `~/.mem` -- or `~/.claude`, which never held the store -- leaves every snapshot where it was. */
export function resolveBackupDir(home: string = resolveMemHome()): string {
  const override = process.env[BACKUP_DIR_ENV];
  if (typeof override === "string" && override.trim().length > 0) {
    return override;
  }
  return join(dirname(home), `${basename(home)}-backups`);
}

/** Two rules bind any edit to the CREATE TABLE below, both because `CREATE TABLE IF NOT EXISTS` does nothing at all to a table that already exists: 1. A new column added here reaches new databases only. Every database already on disk needs a matching migration step in `migrations.ts`'s `MIGRATIONS`, or it opens without the column and the first query naming it fails with `no such column`. 2. Widening one of the `CHECK (... IN (...))` enums cannot be done here at all. A CHECK is frozen into the table at creation and `ALTER TABLE` cannot amend one, so every existing database keeps rejecting the new value with `CHECK constraint failed` while a freshly created database accepts it -- a break invisible to a test suite that starts from an empty file. Widening an enum requires the twelve-step table rebuild (new table, copy, drop, rename), not an ALTER. Both rules are enforced by tests/unit/schema-migration.test.ts, which fails loudly rather than relying on this comment being read. */
const FACTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preference','decision','fact','correction')),
  subject TEXT,
  value TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('global','project','path')) DEFAULT 'global',
  scope_root TEXT,
  scope_repo TEXT,
  capture_root TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('user','derived')),
  source_ref TEXT,
  captured_at TEXT NOT NULL,
  anchor TEXT,
  -- NOTE: 'contested' here (a persisted status from deterministic subject+value fact-vs-fact
  -- contradiction detection, P4) is a different mechanism from the 'contradicted' freshness
  -- verdict (computed per query by re-evaluating a fact's anchor, P3 -- never stored in this
  -- column). See the FactStatus/FreshnessVerdict docs in src/types.ts.
  status TEXT NOT NULL CHECK (status IN ('active','pending','superseded','contested','pinned')) DEFAULT 'active',
  confidence REAL NOT NULL DEFAULT 1.0,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status);
CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope);
`;

const AUDIT_LOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  fact_id TEXT,
  detail TEXT NOT NULL,
  prior_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_fact_id ON audit_log(fact_id);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface OpenDbOptions {
  /** Whether opening an existing store may take its automatic snapshot (src/backup.ts's `snapshotOnOpen`). Default true. src/restore.ts turns it off: a restore takes its own pre-restore snapshot, migrates a staging copy that is nobody's store, and must not prune the auto snapshot it may be restoring from. */
  autoSnapshot?: boolean;
}

/** Opens (creating if absent) the mem sqlite database at `dbPath` (default: the resolved home's `mem.db`), enables WAL mode (Section 3: durability for a short-lived single-writer CLI process), and ensures the schema (`facts`, `audit_log`, `meta`) exists. Callers are responsible for calling `.close()` when done. */
export function openDb(dbPath: string = resolveDbPath(), options: OpenDbOptions = {}): Database.Database {
  const home = dirname(dbPath);
  // Read before `new Database` creates the file: a store this call creates has nothing to snapshot.
  const existed = existsSync(dbPath);
  // `mode` applies only when mkdir actually creates the directory, so an existing home -- including one created 0755 by an earlier version of mem -- is tightened explicitly on the next line.
  mkdirSync(home, { recursive: true, mode: MEM_HOME_MODE });
  restrictPermissions(home, MEM_HOME_MODE);
  const db = new Database(dbPath);
  // Everything past construction is closed on failure. `new Database` connects lazily, so the first statement is what surfaces a damaged file (`SQLITE_NOTADB` on a truncated or non-sqlite path) -- and an escaping error would otherwise leave this handle open with no reference to close it by, which on Windows holds an exclusive lock on the file. That turns a recoverable "your store is corrupt" into an unrecoverable one: the user cannot delete or replace their own database without killing the process, and `mem doctor` -- whose whole job is diagnosing this -- opens through the same path and hangs on the same lock.
  try {
    // Order matters: SQLite creates the `-wal` and `-shm` sidecars with the database file's own permissions, so the database has to already be 0600 when the WAL pragma runs or the sidecars -- which hold the same fact rows -- are born world-readable.
    restrictPermissions(dbPath, MEM_DB_MODE);
    db.pragma("journal_mode = WAL");
    // Belt-and-braces: sidecar creation is SQLite-internal, and a confidentiality guarantee should not rest on an implementation detail of a dependency. Absent sidecars are a no-op here.
    restrictPermissions(`${dbPath}-wal`, MEM_DB_MODE);
    restrictPermissions(`${dbPath}-shm`, MEM_DB_MODE);
    db.exec(FACTS_SCHEMA);
    db.exec(AUDIT_LOG_SCHEMA);
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', '0')").run();
    // Before migrations, so a store about to be migrated is copied as it was (src/backup.ts). Never throws: a snapshot that cannot be written must not cost the caller its database.
    if (existed && options.autoSnapshot !== false) {
      snapshotOnOpen(db, { dir: resolveBackupDir(home), pendingMigrations: hasPendingMigrations(db) });
    }
    // db.ts owns the whole-database `PRAGMA user_version` counter: every table any module adds -- `sources`/`recall_log`/`fact_terms`/`anchor_cache` included -- ends up versioned from the one place every connection passes through, rather than only being migrated by whichever module's own schema-ensure function happens to run next.
    runMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Opens an existing store for inspection and nothing else: no directory creation, no permission changes, no schema DDL, no migrations, no snapshot. `mem doctor` is the caller -- a health check that creates, migrates, or snapshots the store it is asked to examine is not read-only, and one that goes through `openDb` cannot report a store `openDb` itself refuses (corrupt, or one a migration would fail on). Throws if the file is absent or unreadable; the caller owns `.close()`. Spike (better-sqlite3 as installed here, Windows 11, Node 24): a `readonly` open of a WAL store works with no `-shm` present, both after a clean close (no sidecars) and with a leftover `-wal` whose `-shm` is gone, and alongside a live writer. It does create the `-shm`/`-wal` sidecars (not the database file) the first time it reads, so a directory that is not writable can still fail with `SQLITE_CANTOPEN` on platforms where that creation is refused -- not verified on Linux. That case falls back to an ordinary connection with `query_only` on: the same read path, still no DDL, migration, or snapshot, and SQLite itself rejects any write the connection is asked to make. */
export function openDbReadOnly(dbPath: string = resolveDbPath()): Database.Database {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    if (!existsSync(dbPath) || (error as { code?: string }).code !== "SQLITE_CANTOPEN") {
      throw error;
    }
    db = new Database(dbPath, { fileMustExist: true });
    db.pragma("query_only = ON");
  }
  // Same close-on-failure guarantee as `openDb`: the connection is lazy, so this first statement is what surfaces a non-sqlite file (`SQLITE_NOTADB`), and a handle leaked past it would hold the file locked on Windows -- the user could not replace the store doctor just called unreadable.
  try {
    db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
    // A per-connection setting, not a write: it makes the foreign-key state doctor reports the one every other command runs under.
    db.pragma("foreign_keys = ON");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** The two audit-detail phrasings that name the fact a supersession went *to*. They are constants, and the parser below sits beside them, because the audit log is the only record of that edge -- there is no `superseded_by` column, deliberately: an edge stored as a column has to be invalidated whenever either fact changes, a cost mem avoids by recomputing contradictions at recall. That makes these strings load-bearing rather than cosmetic, so a reworded producer and a stale reader must not be able to drift apart in separate modules. Not every supersession names a winner: `forget`, `review_reject`, and consolidate's stale pass retire a fact without one. Those legitimately yield `null` below. */
export const SUPERSEDED_BY_FACT_PREFIX = "Superseded by fact ";
export const SUPERSEDED_AS_DUPLICATE_PREFIX = "superseded as a duplicate of ";

const SUPERSEDING_ID_PATTERN = new RegExp(
  `(?:${SUPERSEDED_BY_FACT_PREFIX}|${SUPERSEDED_AS_DUPLICATE_PREFIX})([0-9a-fA-F-]{1,128})`
);

/** The id of the fact that superseded `factId`, or `null` if nothing did or the reason names no winner. Reads the most recent audit row for the fact, not the first: a fact can be superseded, restored, and superseded again by a different winner, and the current edge is the last one written. `rowid` breaks ties because `created_at` is an ISO string at millisecond resolution and two rows written inside one transaction can share it exactly. Returns an id, never a fact: the winner may itself have been superseded, or pruned by `mem gc`, and the caller is the one positioned to decide how to present either case. */
export function findSupersedingFactId(db: Database.Database, factId: string): string | null {
  // The last audit row for a fact need not be the supersession row -- e.g. `mem used` appends a row after supersession -- so this filters to rows that actually name a superseding fact rather than assuming the last row is that one.
  const row = db
    .prepare<[string, string, string], { detail: string }>(
      `SELECT detail FROM audit_log
       WHERE fact_id = ? AND (detail LIKE ? OR detail LIKE ?)
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(factId, `${SUPERSEDED_BY_FACT_PREFIX}%`, `${SUPERSEDED_AS_DUPLICATE_PREFIX}%`);
  return row === undefined ? null : (SUPERSEDING_ID_PATTERN.exec(row.detail)?.[1] ?? null);
}

export interface AuditLogEntry {
  readonly event: string;
  readonly factId: string | null;
  readonly detail: string;
  /** Reversal payload for an `edit` row: a JSON object of the fields that edit touched, each mapped to the value it held immediately before. Absent for every other event, and absent (not an empty object) rather than present-and-empty is deliberate -- `mem edit --undo` treats a missing value the same as "not an edit with recoverable history", so a row from before this column existed refuses cleanly instead of restoring nothing and reporting success. */
  readonly priorJson?: string;
}

/** One audit row as read back, with the timestamp the writer stamped it with. */
export interface AuditLogRow extends AuditLogEntry {
  readonly createdAt: string;
}

/** Which audit rows a read wants. Every field narrows; an empty filter is the whole log. */
export interface AuditLogFilter {
  readonly factId?: string;
  /** An event name, matched exactly or as a family: `capture` matches `capture` and every `capture_*` event, but not `captured`. Event names are `_`-segmented, so the family is the unit a reader actually asks about ("what did capture do?"). */
  readonly event?: string;
  /** Inclusive ISO-8601 lower bound on `created_at`. */
  readonly since?: string;
}

export interface AuditLogReadOptions {
  readonly limit?: number;
  readonly newestFirst?: boolean;
}

interface AuditLogDbRow {
  event: string;
  fact_id: string | null;
  detail: string;
  created_at: string;
  prior_json: string | null;
}

/** The one WHERE clause both the list and the count build from, so they can never disagree on a total. */
function auditLogWhere(filter: AuditLogFilter): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.factId !== undefined) {
    clauses.push("fact_id = ?");
    params.push(filter.factId);
  }
  if (filter.event !== undefined) {
    clauses.push("(event = ? OR substr(event, 1, length(?) + 1) = ? || '_')");
    params.push(filter.event, filter.event, filter.event);
  }
  if (filter.since !== undefined) {
    clauses.push("created_at >= ?");
    params.push(filter.since);
  }
  return { sql: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`, params };
}

/** Audit rows matching `filter`, oldest first unless `newestFirst`. The audit log has recorded each capture, edit, pin, and status change since the first release, and until `mem show` read it back nothing could: the trail a memory tool keeps so its own output can be trusted was write-only. That is most acute for `mem edit`, which overwrites text in place -- the prior wording lives nowhere else once the row is updated. `rowid` breaks ties because `created_at` is an ISO string at millisecond resolution and two rows written inside one transaction can share it exactly. */
export function listAuditLog(db: Database.Database, filter: AuditLogFilter = {}, options: AuditLogReadOptions = {}): AuditLogRow[] {
  const where = auditLogWhere(filter);
  const direction = options.newestFirst === true ? "DESC" : "ASC";
  const limit = options.limit !== undefined ? " LIMIT ?" : "";
  const params: (string | number)[] = options.limit !== undefined ? [...where.params, options.limit] : where.params;
  return db
    .prepare<(string | number)[], AuditLogDbRow>(
      `SELECT event, fact_id, detail, prior_json, created_at FROM audit_log${where.sql} ORDER BY created_at ${direction}, rowid ${direction}${limit}`
    )
    .all(...params)
    .map((row) => ({
      event: row.event,
      factId: row.fact_id,
      detail: row.detail,
      createdAt: row.created_at,
      ...(row.prior_json !== null ? { priorJson: row.prior_json } : {}),
    }));
}

/** How many audit rows match `filter` -- the `total` a truncated `listAuditLog` read reports against. */
export function countAuditLog(db: Database.Database, filter: AuditLogFilter = {}): number {
  const where = auditLogWhere(filter);
  return db.prepare<string[], { n: number }>(`SELECT COUNT(*) AS n FROM audit_log${where.sql}`).get(...where.params)?.n ?? 0;
}

/** Every audit row for one fact, oldest first -- the `history` block `mem show` prints. */
export function listAuditLogForFact(db: Database.Database, factId: string): AuditLogRow[] {
  return listAuditLog(db, { factId });
}

/** The distinct fact ids the audit log names that start with `prefix`. `gc` hard-deletes superseded facts after 90 days but keeps their audit rows for 180, so for that window the log is the only place a fact id still resolves -- and "what happened to the fact I forgot?" is exactly the question asked about a fact that no longer exists. */
export function listAuditLogFactIdsByPrefix(db: Database.Database, prefix: string): string[] {
  return db
    .prepare<[string, string], { fact_id: string }>(
      "SELECT DISTINCT fact_id FROM audit_log WHERE fact_id IS NOT NULL AND substr(fact_id, 1, length(?)) = ? ORDER BY fact_id"
    )
    .all(prefix, prefix)
    .map((row) => row.fact_id);
}

/** Appends one row to the audit log (design principle 5). Any write path (capture, forget, edit, pin, review resolution) can call this. */
export function insertAuditLog(db: Database.Database, entry: AuditLogEntry): void {
  db.prepare(
    "INSERT INTO audit_log (id, event, fact_id, detail, prior_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(randomUUID(), entry.event, entry.factId, entry.detail, entry.priorJson ?? null, new Date().toISOString());
}

// Note: the write epoch's read/write primitives live in src/epoch.ts, and the policy of when it moves in src/storage.ts (its private `bumpEpoch`) -- storage.ts is the canonical entry point for every fact-table write (insert/update/setStatus/delete) and bumps the epoch atomically alongside each one. The `meta` table (seeded above) is still created here so a caller that opens via bare `openDb()` (without `storage.openStorage()`) still gets a zero-initialized epoch row to read.
