/**
 * Ordered schema migrations for the mem database, keyed on SQLite's own `PRAGMA user_version`.
 *
 * This replaces the mechanism `storage.ts`'s `applyIdempotentAlter` used to rely on: running every
 * `ALTER TABLE` on every open and swallowing the "duplicate column" error SQLite raises when it was
 * already applied. That worked, but it detected "already applied" by matching an error message --
 * a string SQLite does not contract to keep stable, and the only thing standing between a real
 * schema bug and a silently swallowed one. This module detects "already applied" by asking the
 * schema itself (`PRAGMA table_info`), never by parsing an error.
 *
 * `runMigrations` is called once per connection, from `db.ts`'s `openDb`, so `db.ts` owns the
 * whole-database version counter and every table this module touches -- `facts`/`audit_log`/`meta`
 * (created just before this runs) and `sources`/`recall_log`/`fact_terms`/`anchor_cache` (created by
 * the steps below) -- ends up on the same counter. `storage.ts`'s `ensureStorageSchema` still exists
 * for its existing callers, but now just calls back into this module.
 *
 * Each step's `version` is dense and starts at 1; `runMigrations` runs every step whose version
 * exceeds the database's current `user_version`, in ascending order, then stamps `user_version` to
 * the highest version applied. A fresh database and a database that predates this module entirely
 * (real installs already have every baseline column but have never had `user_version` set, i.e. it
 * reads `0`) both take the same path: every step from `1` runs, and each step is written so that
 * running it against a database that already has its columns/tables is a silent no-op rather than
 * an error, because that "already has everything, version 0" shape is the common case, not an edge
 * one.
 */

import type Database from "better-sqlite3";
import { hashFactText } from "./factText.js";

/** One migration: a dense, ascending version number, a name for `runMigrations`' `applied` list, and the DDL/DML it runs. */
export interface MigrationStep {
  readonly version: number;
  readonly name: string;
  up(db: Database.Database): void;
}

/** The result of a `runMigrations` call, for `mem doctor` and tests to report on. */
export interface MigrationResult {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly string[];
}

/** True if `table` currently has a column named `column`. The idempotency check every step below uses instead of parsing a SQLite error message. */
export function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.pragma(`table_info(${table})`) as { name: string }[];
  return columns.some((entry) => entry.name === column);
}

/** Adds `column` to `table` with `declaration` if it is not already present; a silent no-op otherwise. */
export function addColumn(db: Database.Database, table: string, column: string, declaration: string): void {
  if (hasColumn(db, table, column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

/**
 * Everything `applyIdempotentAlter`'s call sequence in `storage.ts` used to cover, in the same
 * order and with the same declarations: the `sources`/`recall_log`/`fact_terms` tables and indexes
 * that used to live in `STORAGE_SCHEMA`, plus every column `ensureStorageSchema` used to `ALTER` in.
 */
function baselineUp(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  excerpt TEXT NOT NULL,
  stored_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_fact_id ON sources(fact_id);
CREATE INDEX IF NOT EXISTS idx_sources_stored_at ON sources(stored_at);

CREATE TABLE IF NOT EXISTS recall_log (
  fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  surfaced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recall_log_session_fact ON recall_log(session_id, fact_id);
CREATE INDEX IF NOT EXISTS idx_recall_log_surfaced_at ON recall_log(surfaced_at);

CREATE TABLE IF NOT EXISTS fact_terms (
  fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  term_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('entity','topic'))
);
CREATE INDEX IF NOT EXISTS idx_fact_terms_fact_id ON fact_terms(fact_id);
CREATE INDEX IF NOT EXISTS idx_fact_terms_lookup ON fact_terms(term_key, kind);
`);

  // `mem review --since-epoch <n>` (design plan Section 4/6) needs to know which write epoch each
  // fact was last touched at. A `NOT NULL DEFAULT 0` backfill is deliberate, not just SQLite's usual
  // ADD COLUMN behavior: rows written before this migration existed have no recorded epoch, and `0`
  // is the correct "predates every real write" sentinel -- the epoch counter itself starts at `0` and
  // only strictly increases (`bumpEpoch`), so no real write can ever be stamped `0` again, and
  // `epoch > n` for any `n >= 0` correctly excludes pre-migration rows without a separate NULL case.
  addColumn(db, "facts", "epoch", "INTEGER NOT NULL DEFAULT 0");
  // Repository-relative project identity (src/projectIdentity.ts). Nullable with no backfill: the
  // value is derived from a repository's layout, and inventing one during a migration would mean
  // touching the filesystem for every stored row -- including roots that have since been deleted or
  // moved, where any answer would be a fabrication. NULL is exactly "this fact predates identities",
  // and every reader falls back to the absolute-path binding for it, which is what it was captured
  // with. A re-capture in the same project fills it in naturally.
  addColumn(db, "facts", "scope_repo", "TEXT");
  // Status bookkeeping (types.ts `status_changed_at` / `prior_status`). Both are nullable with no
  // backfill, unlike the `epoch` column above: there is no correct value to invent for a row whose
  // status history predates the columns, and NULL is the honest "unknown" every reader falls back
  // on (`status_changed_at ?? captured_at`) rather than a sentinel that would silently look like a
  // real, very old status change and drag pre-migration rows into the GC window on first pass.
  addColumn(db, "facts", "status_changed_at", "TEXT");
  addColumn(db, "facts", "prior_status", "TEXT");
  // Capture-time root (retrieval.ts's `anchorRootFor`). Nullable with no backfill, same reasoning
  // as `scope_repo` above: a row written before this column existed recorded no capture root at
  // all, and there is no honest value to invent for it -- the directory a `path`/`global` fact's
  // anchor was meant to be evaluated against is simply unrecoverable from the row itself. NULL is
  // exactly "capture root unknown", and every reader must treat it as `unverified` rather than
  // guessing `affirmed` or `contradicted` off whatever directory the query happened to run from.
  addColumn(db, "facts", "capture_root", "TEXT");
  // Usefulness feedback (`mem used`). Nullable with no backfill for the same reason as the two
  // columns above and one of its own: `recall_log` rows written before this column existed record
  // only that a fact was *surfaced*, and no value invented for them would be honest. A `0`-style
  // sentinel is not available here either -- the column holds the timestamp a fact was confirmed
  // useful, so any non-NULL value is itself the claim. NULL is exactly "nobody ever said", which is
  // what `getUsefulnessCounts` needs to keep a never-confirmed fact out of the usefulness ranking
  // rather than ranking it as confirmed-unhelpful.
  addColumn(db, "recall_log", "used_at", "TEXT");
  // Durable "this fact has been surfaced at least once" mark, for `mem consolidate --stale`.
  //
  // `recall_log` alone cannot answer that question: `mem epoch --gc` rotates its rows after
  // GC_RECALL_LOG_MAX_AGE_DAYS (30), so a fact surfaced two months ago has no row left and reads as
  // never-surfaced -- exactly the fact the stale pass would then propose superseding. Rotating the
  // log is correct (its only reader is a same-session `--delta` recall); losing the one bit that
  // outlives the session is not. This column is that bit, written alongside every `recall_log`
  // insert and never rotated.
  //
  // Nullable with no backfill, same reasoning as the three columns above: for a fact captured
  // before this column existed there is no honest value to invent. `listStaleUnsurfacedFacts`
  // covers that window by *also* requiring no surviving `recall_log` row, so a pre-migration fact
  // surfaced inside the rotation window is still excluded.
  addColumn(db, "facts", "last_surfaced_at", "TEXT");
  // `mem edit --undo`'s reversal payload (cli.ts `buildEditPriorPayload`/`undoEdit`). Nullable with
  // no backfill, same reasoning as the columns above: an `edit` row written before this column
  // existed recorded only a previewed `detail` string, and there is no prior value to reconstruct
  // from that -- reconstructing one would be exactly the truncation defect this column exists to
  // fix, wearing a different hat. NULL is exactly "this edit predates undo", and `undoEdit` refuses
  // cleanly on it rather than treating a stale row as reversible.
  addColumn(db, "audit_log", "prior_json", "TEXT");
  // Marks that facet extraction has run for a fact at all, independent of whether it found
  // anything to store. Nullable with no backfill, same NULL-means-unknown convention as the
  // columns above: a fact this predates has genuinely never been checked and belongs in the
  // backfill queue, same as today. Without this column, `listFactsNeedingTerms` had to infer
  // "never extracted" from "no row in fact_terms" -- indistinguishable from "extracted, and its
  // text is entirely stopwords", so a fact of that shape was re-offered by `mem facets --backfill`
  // forever: the command runs, finds nothing to write, and the shortfall never closes.
  addColumn(db, "facts", "terms_checked_at", "TEXT");
  // Repeat-sighting counter for a `pending` fact (`mem review`'s pending bucket sort, `mem
  // scan-session`/`mem import --from-md`'s `recordSighting`). `NOT NULL DEFAULT 0`, matching
  // `epoch` above rather than the nullable "unknown" convention most of this block uses: unlike
  // `status_changed_at` or `last_surfaced_at`, there is an honest value to backfill here -- a row
  // written before this column existed has, by construction, zero sightings *recorded*, which is
  // exactly what `0` means. Backdating it to NULL would only force every reader to treat "never
  // sighted again" and "predates the column" as two states needing the same `?? 0` fallback anyway.
  addColumn(db, "facts", "sightings", "INTEGER NOT NULL DEFAULT 0");
}

/**
 * The normalized-text hash that will replace a full-table scan in the dedup path (a future phase).
 * Nullable with no backfill in this phase: pre-existing rows have not been hashed yet, so NULL means
 * "unknown, fall back to the scan" rather than "no duplicates" -- a later phase populates it and
 * only then can a reader treat NULL as authoritative.
 */
function textHashUp(db: Database.Database): void {
  addColumn(db, "facts", "text_hash", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_facts_text_hash ON facts(text_hash)");
}

/**
 * Cache of anchor verification verdicts, keyed on the capture root and the anchor string itself.
 * `witness` holds whatever the evaluator recorded as the thing it verified against (an mtime, a
 * hash, a git ref) so a later phase can treat any mismatch as a cache miss; nullable because not
 * every predicate has one. No reader or writer is wired to this table in this phase -- it exists so
 * a later phase can add both without also needing a migration.
 */
function anchorCacheUp(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS anchor_cache (
  root TEXT NOT NULL,
  anchor TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('affirmed','unverified','contradicted')),
  verified_at TEXT NOT NULL,
  witness TEXT,
  PRIMARY KEY (root, anchor)
);
CREATE INDEX IF NOT EXISTS idx_anchor_cache_verified_at ON anchor_cache(verified_at);
`);
}

/**
 * Backfills `facts.text_hash` for every row `textHashUp` (v2) left NULL -- everything written
 * before that migration existed. Deliberately a separate step rather than folded into v2: v2 is
 * already applied on every store that has reached `user_version >= 2`, and `runMigrations` only
 * ever replays steps whose version exceeds the database's current one, so editing v2 in place would
 * silently skip the backfill on exactly the databases that need it.
 *
 * Hashed in JS, not SQL: `normalizeFactText` (factText.ts) collapses whitespace and folds case in a
 * way SQLite's own functions cannot soundly reproduce, and `hashFactText` is the single place that
 * turns that normalized form into the value `text_hash` stores -- the same function every write
 * path (`insertFact`/`updateFact`) calls, so a backfilled row and a freshly-written one are keyed
 * identically. Runs inside `runMigrations`' existing transaction, so a mid-backfill failure rolls
 * back the whole migration rather than leaving some rows hashed and others not.
 */
function textHashBackfillUp(db: Database.Database): void {
  const rows = db.prepare<[], { id: string; text: string }>("SELECT id, text FROM facts WHERE text_hash IS NULL").all();
  const update = db.prepare<[string, string]>("UPDATE facts SET text_hash = ? WHERE id = ?");
  for (const row of rows) {
    update.run(hashFactText(row.text), row.id);
  }
}

/** Every migration, in the order `runMigrations` applies them. Version numbers are dense and start at 1. */
export const MIGRATIONS: readonly MigrationStep[] = [
  { version: 1, name: "baseline", up: baselineUp },
  { version: 2, name: "facts.text_hash", up: textHashUp },
  { version: 3, name: "anchor_cache", up: anchorCacheUp },
  { version: 4, name: "facts.text_hash backfill", up: textHashBackfillUp },
];

/**
 * Stamps `PRAGMA user_version`. `PRAGMA user_version = N` cannot be parameterised -- SQLite only
 * accepts a literal there -- so this is the one place that pragma is ever written, and it refuses
 * anything but a non-negative integer this module produced itself (a `MigrationStep.version`),
 * never a value that could have come from outside.
 */
function setUserVersion(db: Database.Database, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`refusing to set PRAGMA user_version to ${String(version)}: not a non-negative integer`);
  }
  db.pragma(`user_version = ${version}`);
}

/**
 * Runs every migration step `db` is behind on, in one immediate transaction (`tx.immediate()`,
 * required by tests/guards/transactions.test.ts: this reads `user_version` and `table_info` before
 * it writes, so a deferred `BEGIN` could lose its snapshot to a concurrent writer under WAL and fail
 * with `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` does not retry).
 *
 * A fresh database and a database already at the latest baseline columns but with `user_version`
 * still at its default `0` take the same path here: every step runs, and every step is written to
 * be a no-op against a table/column that already exists.
 */
export function runMigrations(db: Database.Database): MigrationResult {
  const from = db.pragma("user_version", { simple: true }) as number;
  const pending = MIGRATIONS.filter((step) => step.version > from);
  if (pending.length === 0) {
    return { from, to: from, applied: [] };
  }
  const applied: string[] = [];
  let to = from;
  const tx = db.transaction((): void => {
    for (const step of pending) {
      step.up(db);
      applied.push(step.name);
      to = step.version;
    }
    setUserVersion(db, to);
  });
  tx.immediate();
  return { from, to, applied };
}
