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
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DB_FILE_NAME = "mem.db";

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
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(FACTS_SCHEMA);
  db.exec(AUDIT_LOG_SCHEMA);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', '0')").run();
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
