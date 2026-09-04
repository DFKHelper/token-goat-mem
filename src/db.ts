/**
 * SQLite connection and schema for the `facts` table (design plan Section 3),
 * plus two small infra tables every write path shares: `audit_log` (design
 * principle 5 -- "An audit log records what was captured and why. No black
 * box.") and `meta` (the write epoch other modules and the token-goat seam
 * use for cache invalidation, Section 4/6: "every write bumps it").
 *
 * Kept intentionally narrow: this module only opens the database, ensures
 * its schema exists, and resolves where the database file lives. It does not
 * implement recall, contradiction persistence, GC, or embeddings storage
 * (sqlite-vec) -- those belong to a dedicated storage module and can extend
 * this schema (e.g. a companion vec0 virtual table for embeddings) without
 * conflicting with what is defined here.
 *
 * mem is a short-lived CLI process (Section 3): every `openDb` call opens a
 * fresh connection: no daemon, no long-lived pool, no cross-call caching.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DB_FILE_NAME = "mem.db";

/**
 * Permissions mem forces on its own home directory and database file on POSIX systems.
 *
 * Facts are exactly the class of data that must not be world-readable: project internals, decisions,
 * and whatever personal detail survived capture-time secret screening (which targets credentials, not
 * PII). Left to a default umask of 022 the directory would be 0755 and the database 0644 -- readable
 * by every local account on a shared host -- so the mode is stated here rather than inherited.
 *
 * Windows is excluded deliberately: `chmod` there only toggles the read-only bit and would say
 * nothing about who can read the file, while the profile ACL `~/.mem` inherits already restricts it
 * to the owning user.
 */
const MEM_HOME_MODE = 0o700;
const MEM_DB_MODE = 0o600;

/**
 * Tightens `path` to `mode`, or does nothing on Windows or if the chmod is refused.
 *
 * Best-effort by design: a database mem can open but cannot chmod (an unusual ownership or mount
 * setup) is still a working database, and failing the whole CLI over a permission hardening step
 * would trade a confidentiality improvement for an availability regression.
 */
function restrictPermissions(path: string, mode: number): void {
  if (process.platform === "win32") {
    return;
  }
  try {
    chmodSync(path, mode);
  } catch {
    // Intentionally silent: see the doc comment above.
  }
}

/**
 * Resolves mem's home directory. `TOKEN_GOAT_MEM_HOME` overrides the default
 * `~/.mem` -- used by tests to isolate the real user home (see
 * tests/setup/isolate-home.ts) and by anyone who wants a non-default
 * location.
 */
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

/**
 * Two rules bind any edit to the CREATE TABLE below, both because
 * `CREATE TABLE IF NOT EXISTS` does nothing at all to a table that already exists:
 *
 *  1. A new column added here reaches new databases only. Every database already on disk needs a
 *     matching `applyIdempotentAlter` in `storage.ensureStorageSchema`, or it opens without the
 *     column and the first query naming it fails with `no such column`.
 *  2. Widening one of the `CHECK (... IN (...))` enums cannot be done here at all. A CHECK is frozen
 *     into the table at creation and `ALTER TABLE` cannot amend one, so every existing database
 *     keeps rejecting the new value with `CHECK constraint failed` while a freshly created database
 *     accepts it -- a break invisible to a test suite that starts from an empty file. Widening an
 *     enum requires the twelve-step table rebuild (new table, copy, drop, rename), not an ALTER.
 *
 * Both rules are enforced by tests/unit/schema-migration.test.ts, which fails loudly rather than
 * relying on this comment being read.
 */
const FACTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preference','decision','fact','correction')),
  subject TEXT,
  value TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('global','project','path')) DEFAULT 'global',
  scope_root TEXT,
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
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_fact_id ON audit_log(fact_id);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Opens (creating if absent) the mem sqlite database at `dbPath` (default:
 * the resolved home's `mem.db`), enables WAL mode (Section 3: durability
 * for a short-lived single-writer CLI process), and ensures the schema
 * (`facts`, `audit_log`, `meta`) exists. Callers are responsible for calling
 * `.close()` when done.
 */
export function openDb(dbPath: string = resolveDbPath()): Database.Database {
  const home = dirname(dbPath);
  // `mode` applies only when mkdir actually creates the directory, so an existing home -- including
  // one created 0755 by an earlier version of mem -- is tightened explicitly on the next line.
  mkdirSync(home, { recursive: true, mode: MEM_HOME_MODE });
  restrictPermissions(home, MEM_HOME_MODE);
  const db = new Database(dbPath);
  // Everything past construction is closed on failure. `new Database` connects lazily, so the first
  // statement is what surfaces a damaged file (`SQLITE_NOTADB` on a truncated or non-sqlite path) --
  // and an escaping error would otherwise leave this handle open with no reference to close it by,
  // which on Windows holds an exclusive lock on the file. That turns a recoverable "your store is
  // corrupt" into an unrecoverable one: the user cannot delete or replace their own database
  // without killing the process, and `mem doctor` -- whose whole job is diagnosing this -- opens
  // through the same path and hangs on the same lock.
  try {
    // Order matters: SQLite creates the `-wal` and `-shm` sidecars with the database file's own
    // permissions, so the database has to already be 0600 when the WAL pragma runs or the sidecars --
    // which hold the same fact rows -- are born world-readable.
    restrictPermissions(dbPath, MEM_DB_MODE);
    db.pragma("journal_mode = WAL");
    // Belt-and-braces: sidecar creation is SQLite-internal, and a confidentiality guarantee should not
    // rest on an implementation detail of a dependency. Absent sidecars are a no-op here.
    restrictPermissions(`${dbPath}-wal`, MEM_DB_MODE);
    restrictPermissions(`${dbPath}-shm`, MEM_DB_MODE);
    db.exec(FACTS_SCHEMA);
    db.exec(AUDIT_LOG_SCHEMA);
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', '0')").run();
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export interface AuditLogEntry {
  readonly event: string;
  readonly factId: string | null;
  readonly detail: string;
}

/**
 * Appends one row to the audit log (design principle 5). Any write path
 * (capture, forget, edit, pin, review resolution) can call this.
 */
export function insertAuditLog(db: Database.Database, entry: AuditLogEntry): void {
  db.prepare(
    "INSERT INTO audit_log (id, event, fact_id, detail, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(randomUUID(), entry.event, entry.factId, entry.detail, new Date().toISOString());
}

// Note: the write-epoch increment/read pair lives in src/storage.ts (`getEpoch` /
// its private `bumpEpoch`), not here -- storage.ts is the canonical entry point for every
// fact-table write (insert/update/setStatus/delete) and bumps the epoch atomically alongside
// each one. An earlier version of this module exported its own `bumpEpoch`; it was removed once
// storage.ts's writers became the sole callers that needed it, to avoid two independent epoch
// implementations drifting apart. The `meta` table (seeded above) is still created here too so a
// caller that opens via bare `openDb()` (without `storage.openStorage()`) still gets a
// zero-initialized epoch row to read.
