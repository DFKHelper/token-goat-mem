/**
 * Storage layer: schema and typed CRUD for the `sources` table plus a write
 * epoch, and typed CRUD for the `facts` table (design plan Section 3).
 *
 * Builds on src/db.ts rather than duplicating it: db.ts already owns opening
 * the sqlite file, enabling WAL mode, and creating the `facts` table with its
 * CHECK constraints (see db.ts's own header comment, which explicitly invites
 * "a dedicated storage module" to extend its schema without conflicting with
 * it). This module adds:
 *   - the `sources` table -- audit-only excerpts referenced by fact id
 *     ("raw excerpts ... for audit/provenance only -- never a primary
 *     retrieval tier", Section 3), foreign-keyed to `facts(id)` with
 *     `ON DELETE CASCADE` so a hard fact delete cannot leave orphaned
 *     sources rows;
 *   - a `meta` key/value table used only to track a monotonic write epoch
 *     (Section 4 / review S2: token-goat's optional fallback cache, if it is
 *     ever added on the caller side, is keyed on this so a `forget`/`edit`
 *     is never masked by a stale TTL);
 *   - the `fact_terms` table -- the structured facet layer (`src/facets.ts`):
 *     the identifier-shaped tokens BM25's stemmer would destroy, kept
 *     verbatim beside a normalized lookup key, so `mem recall --entity
 *     src/retrieval.ts` can find a fact the lexical index only knows as
 *     `src`/`retriev`/`ts`. Foreign-keyed with `ON DELETE CASCADE` like
 *     `sources`: orphaned term rows would silently skew every term statistic
 *     without ever failing a query;
 *   - typed CRUD for both tables, plus `openStorage`, the recommended
 *     connection entry point (`openDb` + this module's schema, in one call).
 *
 * mem is a short-lived, single-shot CLI process (db.ts's own header
 * comment): there is no connection cache here either. Every `openStorage`
 * call opens a fresh connection; callers close it when done.
 *
 * Every fact-table write (`insertFact`, `updateFact`, `setFactStatus`,
 * `deleteFact`) bumps the epoch in the same transaction as the write, so the
 * epoch is never observably out of sync with the data it describes. Writes
 * to `sources` do not bump it: `sources` is audit-only and never feeds the
 * `--hint-format` seam output the epoch exists to guard (Section 4).
 */

import { randomUUID } from "node:crypto";
import { openDb, resolveDbPath } from "./db.js";
import type { EmbeddingMeta } from "./embeddings.js";
import { extractFacets, normalizeTermKey, type FactFacets } from "./facets.js";
import type { Fact, FactFilter, FactUpdate, NewFact, NewSource, Source, FactStatus } from "./types.js";

/** Connection type, borrowed from db.ts's own return type rather than importing better-sqlite3's types directly -- keeps this module's public surface in lockstep with whatever db.ts actually opens. */
type Db = ReturnType<typeof openDb>;

const STORAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  excerpt TEXT NOT NULL,
  stored_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_fact_id ON sources(fact_id);
CREATE INDEX IF NOT EXISTS idx_sources_stored_at ON sources(stored_at);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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
`;

/**
 * Runs an ALTER TABLE that may already have been applied by an earlier
 * version of this module. Swallows exactly a "duplicate column" failure so
 * re-running init against an already-migrated database is a no-op; any other
 * failure propagates. This -- rather than a `PRAGMA user_version` counter --
 * is this module's migration mechanism: `user_version` is not claimed here
 * because db.ts (which creates `facts` and does not use it today) would be
 * the natural owner of a whole-database version counter, and this module
 * only owns `sources`/`meta`. `CREATE TABLE IF NOT EXISTS` (STORAGE_SCHEMA
 * above) already covers the common case of a brand-new table; this covers
 * the rarer case of a column added to an existing one in a future release.
 * Unused today (the schema is at its first version); exported so the first
 * such migration has an obvious, already-tested home.
 */
export function applyIdempotentAlter(db: Db, sql: string): void {
  try {
    db.exec(sql);
  } catch (error) {
    if (!(error instanceof Error) || !/duplicate column/i.test(error.message)) {
      throw error;
    }
  }
}

/**
 * Ensures the `sources` and `meta` tables (and the seeded epoch row) exist on
 * an already-open connection, and enables foreign-key enforcement so
 * `sources`'s `ON DELETE CASCADE` actually fires -- `PRAGMA foreign_keys` is
 * per-connection and off by default in SQLite, and db.ts's `openDb` does not
 * set it (it does not need to: `facts` has no foreign keys of its own).
 * Idempotent: safe to call on every connection open.
 */
export function ensureStorageSchema(db: Db): void {
  db.pragma("foreign_keys = ON");
  db.exec(STORAGE_SCHEMA);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch', '0')").run();
  // `mem review --since-epoch <n>` (design plan Section 4/6) needs to know which write epoch each
  // fact was last touched at. A `NOT NULL DEFAULT 0` backfill is deliberate, not just SQLite's usual
  // ADD COLUMN behavior: rows written before this migration existed have no recorded epoch, and `0`
  // is the correct "predates every real write" sentinel -- the epoch counter itself starts at `0` and
  // only strictly increases (`bumpEpoch`), so no real write can ever be stamped `0` again, and
  // `epoch > n` for any `n >= 0` correctly excludes pre-migration rows without a separate NULL case.
  applyIdempotentAlter(db, "ALTER TABLE facts ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0");
  // Status bookkeeping (types.ts `status_changed_at` / `prior_status`). Both are nullable with no
  // backfill, unlike the `epoch` column above: there is no correct value to invent for a row whose
  // status history predates the columns, and NULL is the honest "unknown" every reader falls back
  // on (`status_changed_at ?? captured_at`) rather than a sentinel that would silently look like a
  // real, very old status change and drag pre-migration rows into the GC window on first pass.
  applyIdempotentAlter(db, "ALTER TABLE facts ADD COLUMN status_changed_at TEXT");
  applyIdempotentAlter(db, "ALTER TABLE facts ADD COLUMN prior_status TEXT");
  // Usefulness feedback (`mem used`). Nullable with no backfill for the same reason as the two
  // columns above and one of its own: `recall_log` rows written before this column existed record
  // only that a fact was *surfaced*, and no value invented for them would be honest. A `0`-style
  // sentinel is not available here either -- the column holds the timestamp a fact was confirmed
  // useful, so any non-NULL value is itself the claim. NULL is exactly "nobody ever said", which is
  // what `getUsefulnessCounts` needs to keep a never-confirmed fact out of the usefulness ranking
  // rather than ranking it as confirmed-unhelpful.
  //
  // Deliberately an ALTER rather than a column on STORAGE_SCHEMA's `CREATE TABLE IF NOT EXISTS`:
  // that statement is a no-op against every database that already has a `recall_log`, so editing it
  // would leave the column missing on every existing install while looking correct on a fresh one.
  // The ALTER is the migration; a fresh database gets the column from the very same line.
  applyIdempotentAlter(db, "ALTER TABLE recall_log ADD COLUMN used_at TEXT");
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
  applyIdempotentAlter(db, "ALTER TABLE facts ADD COLUMN last_surfaced_at TEXT");
}

/**
 * Opens a mem database ready for both `facts` and `sources`/`meta` use: the
 * recommended entry point for any code that needs this module's CRUD
 * functions (as opposed to db.ts's bare `openDb`, which only guarantees
 * `facts`). Callers are responsible for calling `.close()` when done, same
 * contract as `openDb`.
 */
export function openStorage(dbPath: string = resolveDbPath()): Db {
  const db = openDb(dbPath);
  // `openDb` closes its own handle if it fails, but this second phase runs after it has returned
  // successfully, so the same guarantee has to be repeated here or the handle leaks with no
  // reference left to close it by. `ensureStorageSchema` is a real throw site, not a formality: it
  // runs DDL against a table whose shape it did not create, so a store damaged or partially migrated
  // by an older version fails here rather than in `openDb`. On Windows the leaked handle then locks
  // the file, and the user cannot replace the store their next command is about to fail on.
  try {
    ensureStorageSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Normalizes a subject key for deterministic contradiction detection (design plan P4): trims surrounding whitespace and lowercases, so "Package-Manager", "package-manager ", and "package-manager" all key to the same bucket regardless of how a caller typed `--subject`. */
export function normalizeSubject(subject: string): string {
  return subject.trim().toLowerCase();
}

function packEmbedding(vec: Float32Array): Buffer {
  const buf = Buffer.alloc(vec.length * Float32Array.BYTES_PER_ELEMENT);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i] ?? 0, i * Float32Array.BYTES_PER_ELEMENT);
  }
  return buf;
}

/**
 * Reads a BLOB column back into a `Float32Array` one float at a time via
 * `readFloatLE` rather than viewing `blob.buffer` directly -- a `Buffer`
 * handed back by better-sqlite3 is not guaranteed to start at a 4-byte-
 * aligned offset within its underlying `ArrayBuffer`, and `Float32Array`
 * requires alignment. Embedding vectors here are at most a few hundred
 * floats, so the per-element read has no meaningful cost.
 *
 * Exported because integration-seam.ts reads the `facts` table through its
 * own projection (it needs `prior_status`, which `listFacts` does not carry)
 * and would otherwise have to reimplement this alignment-safe read.
 */
export function unpackEmbedding(blob: Buffer): Float32Array {
  const count = Math.floor(blob.byteLength / Float32Array.BYTES_PER_ELEMENT);
  const view = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    view[i] = blob.readFloatLE(i * Float32Array.BYTES_PER_ELEMENT);
  }
  return view;
}

/** Raw `facts` row shape, matching db.ts's `FACTS_SCHEMA` column-for-column. Internal to this module; callers see `Fact` (src/types.ts). */
interface FactRow {
  id: string;
  text: string;
  kind: string;
  subject: string | null;
  value: string | null;
  scope: string;
  scope_root: string | null;
  source_type: string;
  source_ref: string | null;
  captured_at: string;
  anchor: string | null;
  status: string;
  confidence: number;
  embedding: Buffer | null;
  epoch: number;
  status_changed_at: string | null;
  prior_status: string | null;
}

function rowToFact(row: FactRow): Fact {
  return {
    id: row.id,
    text: row.text,
    kind: row.kind as Fact["kind"],
    subject: row.subject,
    value: row.value,
    scope: row.scope as Fact["scope"],
    scopeRoot: row.scope_root,
    source_type: row.source_type as Fact["source_type"],
    source_ref: row.source_ref,
    captured_at: row.captured_at,
    anchor: row.anchor,
    status: row.status as Fact["status"],
    confidence: row.confidence,
    embedding: row.embedding === null ? null : unpackEmbedding(row.embedding),
    epoch: row.epoch,
    status_changed_at: row.status_changed_at,
    prior_status: row.prior_status as FactStatus | null,
  };
}

function getFactRow(db: Db, id: string): FactRow | undefined {
  return db.prepare<[string], FactRow>("SELECT * FROM facts WHERE id = ?").get(id);
}

/**
 * Inserts a new fact and returns it in full (including the generated `id`
 * and any defaulted fields). Runs inside a transaction with the epoch bump
 * so a crash between the insert and the bump can never happen.
 *
 * Facet extraction (`fact_terms`) runs in that same transaction rather than
 * in a caller. It lives here, and not in `capture.ts`'s `writeFact`, because
 * `writeFact` is not the only write path: `exportImport.ts` calls this
 * function directly (deliberately -- see its header), so a facet hook on the
 * capture path would leave every `mem import --from-json` fact silently
 * termless and invisible to `--entity` until someone ran a backfill. Unlike
 * the embedding path, extraction is pure local computation with no network
 * and no failure mode, so there is nothing here that can turn a fact write
 * into a rollback.
 */
export function insertFact(db: Db, fact: NewFact): Fact {
  const id = fact.id ?? randomUUID();
  const capturedAt = fact.captured_at ?? new Date().toISOString();
  const status = fact.status ?? "active";
  const confidence = fact.confidence ?? 1.0;
  const subject = fact.subject === undefined || fact.subject === null ? null : normalizeSubject(fact.subject);
  const embeddingBlob = fact.embedding === undefined || fact.embedding === null ? null : packEmbedding(fact.embedding);

  const insert = db.prepare(
    `INSERT INTO facts (id, text, kind, subject, value, scope, scope_root, source_type, source_ref, captured_at, anchor, status, confidence, embedding, epoch, status_changed_at, prior_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  );

  const tx = db.transaction((): void => {
    const epoch = bumpEpoch(db);
    insert.run(
      id,
      fact.text,
      fact.kind,
      subject,
      fact.value ?? null,
      fact.scope,
      fact.scopeRoot ?? null,
      fact.source_type,
      fact.source_ref ?? null,
      capturedAt,
      fact.anchor ?? null,
      status,
      confidence,
      embeddingBlob,
      epoch,
      // A fact's status clock starts when the fact does -- for an `active` fact those are the same
      // moment, and starting at `capturedAt` keeps a freshly-pinned-on-capture fact from being
      // instantly "due for re-confirmation".
      //
      // Any other status takes the current time instead, because `capturedAt` is caller-supplied and
      // the import path backdates it. A superseded fact restored from a `mem export` written months
      // ago arrived with its 90-day retention window already elapsed and was deleted by the very next
      // `mem epoch --gc` -- silent data loss on the documented backup path. The envelope carries no
      // status timestamp to restore (see exportImport.ts), so the honest clock start is when this
      // store learned of the status, which is now.
      status === "active" ? capturedAt : new Date().toISOString()
    );
    replaceFactTerms(db, id, extractFacets(fact.text));
  });
  // BEGIN IMMEDIATE, not the deferred default: this transaction reads (`bumpEpoch` -> `getEpoch`)
  // before it writes, and in WAL mode a deferred transaction that upgrades to a writer after
  // another connection has committed in between fails with SQLITE_BUSY_SNAPSHOT -- which
  // `busy_timeout` does not retry, because retrying cannot make the stale snapshot valid. Taking
  // the write lock up front makes the read-then-write pair sound for concurrent `mem` processes,
  // which is the tool's normal deployment (two agent sessions in two repos, one shared ~/.mem).
  // Every other write path in this module, and every caller that wraps one in an outer transaction
  // (capture.writeFact, cli's edit/setStatusWithAudit, exportImport's batch), does the same.
  tx.immediate();

  const row = getFactRow(db, id);
  if (row === undefined) {
    throw new Error(`storage: insertFact failed to read back fact ${id}`);
  }
  return rowToFact(row);
}

/** Reads one fact by id, or `undefined` if no such fact exists. */
export function getFactById(db: Db, id: string): Fact | undefined {
  const row = getFactRow(db, id);
  return row === undefined ? undefined : rowToFact(row);
}

/** Result of `resolveFactIdOrPrefix`: exactly one full id matched, no id (or no safely-scannable prefix) matched, or more than one id shares the given prefix. */
export type IdResolution =
  | { readonly kind: "found"; readonly fact: Fact }
  | { readonly kind: "not-found" }
  | { readonly kind: "ambiguous"; readonly matches: readonly Fact[] };

/** Below this length, a partial id is never treated as a prefix -- too likely to collide across an unrelated store, and not worth a table scan. */
const MIN_ID_PREFIX_LEN = 4;

/** Fact ids are UUIDs (hex digits and dashes only); a `--` prefix scan is only attempted for input that could plausibly be one. */
export const ID_PREFIX_PATTERN = /^[0-9a-fA-F-]+$/;

/** Escapes `%`, `_`, and `\` (the SQL `LIKE` wildcard/escape characters) so a caller-supplied prefix can never be interpreted as a wildcard pattern -- defensive, since real UUID characters never contain any of these. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Resolves a fact id argument that may be a full id or a git-style short prefix (`MIN_ID_PREFIX_LEN`
 * characters minimum). Tries an exact match first (the common case, and the only case for a full
 * UUID); only falls back to a `LIKE 'prefix%'` scan when the exact match misses and the input looks
 * like it could plausibly be a hex/dash id prefix.
 */
export function resolveFactIdOrPrefix(db: Db, idOrPrefix: string): IdResolution {
  const exact = getFactRow(db, idOrPrefix);
  if (exact !== undefined) {
    return { kind: "found", fact: rowToFact(exact) };
  }
  if (idOrPrefix.length < MIN_ID_PREFIX_LEN || !ID_PREFIX_PATTERN.test(idOrPrefix)) {
    return { kind: "not-found" };
  }
  const rows = db
    .prepare<[string], FactRow>("SELECT * FROM facts WHERE id LIKE ? ESCAPE '\\'")
    .all(`${escapeLikePattern(idOrPrefix)}%`);
  if (rows.length === 0) {
    return { kind: "not-found" };
  }
  if (rows.length > 1) {
    return { kind: "ambiguous", matches: rows.map(rowToFact) };
  }
  return { kind: "found", fact: rowToFact(rows[0] as FactRow) };
}

/**
 * Builds the shared `WHERE` clause + bind params for `listFacts`/
 * `countFacts`. Returns `null` when the filter can be proven to match zero
 * rows without a query (an empty `status` array) so callers can short-
 * circuit instead of running `status IN ()`, which SQLite would otherwise
 * happily execute as "match nothing" -- correct, but a wasted round trip.
 */
function buildFactFilterClause(filter: FactFilter): { where: string; params: unknown[] } | null {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter.kind !== undefined) {
    clauses.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter.subject !== undefined) {
    clauses.push("subject = ?");
    params.push(normalizeSubject(filter.subject));
  }
  if (filter.scope !== undefined) {
    clauses.push("scope = ?");
    params.push(filter.scope);
  }
  if (filter.status !== undefined) {
    const statuses: readonly FactStatus[] = Array.isArray(filter.status) ? filter.status : [filter.status as FactStatus];
    if (statuses.length === 0) {
      return null;
    }
    clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (filter.capturedBefore !== undefined) {
    clauses.push("captured_at < ?");
    params.push(filter.capturedBefore);
  }
  if (filter.capturedAfter !== undefined) {
    clauses.push("captured_at > ?");
    params.push(filter.capturedAfter);
  }
  if (filter.epochAfter !== undefined) {
    clauses.push("epoch > ?");
    params.push(filter.epochAfter);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, params };
}

/** Lists facts matching `filter` (all conditions AND-ed), newest `captured_at` first. */
export function listFacts(db: Db, filter: FactFilter = {}): Fact[] {
  const clause = buildFactFilterClause(filter);
  if (clause === null) {
    return [];
  }
  const { where, params } = clause;
  let sql = `SELECT * FROM facts ${where} ORDER BY captured_at DESC`;
  const allParams = [...params];
  if (filter.limit !== undefined) {
    sql += " LIMIT ?";
    allParams.push(filter.limit);
  }
  return db.prepare<unknown[], FactRow>(sql).all(...allParams).map(rowToFact);
}

/** Counts facts matching `filter` (same semantics as `listFacts`, ignoring `limit`). */
export function countFacts(db: Db, filter: FactFilter = {}): number {
  const clause = buildFactFilterClause(filter);
  if (clause === null) {
    return 0;
  }
  const { where, params } = clause;
  const row = db.prepare<unknown[], { count: number }>(`SELECT COUNT(*) as count FROM facts ${where}`).get(...params);
  return row === undefined ? 0 : row.count;
}

/**
 * Applies a partial update to an existing fact and returns the updated row,
 * or `undefined` if `id` does not exist. Fields not present on `patch` are
 * left unchanged; a field explicitly set to `null` (where nullable) clears
 * it. `kind`, `source_type`, and `captured_at` are not editable (see
 * `FactUpdate`'s doc comment in src/types.ts for why). A `patch` with no
 * recognized fields is a no-op read (no epoch bump, since nothing changed).
 */
export function updateFact(db: Db, id: string, patch: FactUpdate): Fact | undefined {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.text !== undefined) {
    sets.push("text = ?");
    // Trimmed, matching capture.ts's write path (`validateCommonInput` stores `input.text.trim()`).
    // `mem edit` validated the trimmed form but stored the raw one, so a value that only differed by
    // surrounding whitespace became a distinct `value` to the contradiction detector -- two facts
    // that agree, keyed as rivals, and on a captured_at/provenance tie marked `contested` and
    // withheld from ground truth for disagreeing with themselves.
    params.push(patch.text.trim());
  }
  if (patch.subject !== undefined) {
    sets.push("subject = ?");
    params.push(patch.subject === null ? null : normalizeSubject(patch.subject));
  }
  if (patch.value !== undefined) {
    sets.push("value = ?");
    // Trimmed for the same reason as `text` above: `value` is half the contradiction key, so
    // untrimmed input is the field where the whitespace asymmetry actually does damage.
    params.push(patch.value === null ? null : patch.value.trim());
  }
  if (patch.scope !== undefined) {
    sets.push("scope = ?");
    params.push(patch.scope);
  }
  if (patch.scopeRoot !== undefined) {
    sets.push("scope_root = ?");
    params.push(patch.scopeRoot);
  }
  if (patch.anchor !== undefined) {
    sets.push("anchor = ?");
    params.push(patch.anchor);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.confidence !== undefined) {
    sets.push("confidence = ?");
    params.push(patch.confidence);
  }
  if (patch.embedding !== undefined) {
    sets.push("embedding = ?");
    params.push(patch.embedding === null ? null : packEmbedding(patch.embedding));
  }

  if (sets.length === 0) {
    return getFactById(db, id);
  }

  const tx = db.transaction((): void => {
    const finalSets = [...sets];
    const finalParams = [...params];
    if (patch.status !== undefined) {
      // A status write routed through `updateFact` must keep the same bookkeeping `setFactStatus`
      // does, or the two write paths silently disagree about when a fact last changed state and the
      // GC / pin-reconfirm clocks drift apart depending on which command happened to be used.
      const current = db
        .prepare<[string], { status: string; prior_status: string | null }>("SELECT status, prior_status FROM facts WHERE id = ?")
        .get(id);
      if (current !== undefined) {
        finalSets.push("prior_status = ?");
        finalParams.push(current.status === patch.status ? current.prior_status : current.status);
      }
      finalSets.push("status_changed_at = ?");
      finalParams.push(new Date().toISOString());
    }
    finalSets.push("epoch = ?");
    const next = getEpoch(db) + 1;
    const result = db.prepare(`UPDATE facts SET ${finalSets.join(", ")} WHERE id = ?`).run(...finalParams, next, id);
    if (result.changes > 0) {
      performEpochUpsert(db, next);
      if (patch.text !== undefined) {
        // Terms describe `facts.text`, so an edit that rewrites the text has to re-extract them in
        // the same transaction. Skipping this leaves `mem recall --entity` matching a fact on an
        // identifier its text no longer mentions -- a stale claim rather than a missing one, and
        // nothing downstream could tell it apart from a correct hit. Trimmed to match what was
        // actually stored above, not the raw patch.
        replaceFactTerms(db, id, extractFacets(patch.text.trim()));
      }
    }
  });
  tx.immediate(); // read-then-write under WAL; see insertFact.

  return getFactById(db, id);
}

/**
 * Sets a fact's `status` directly -- the common case for pin/unpin, forget
 * (soft delete via `status = 'superseded'`, kept for audit per design plan
 * Section 3), and persisting contradiction-resolution outcomes (design plan
 * P4; `src/contradiction.ts`'s `detectContradictions` is pure and returns
 * the status transitions to apply, this is where a caller applies them).
 * Narrower and more obviously named than routing a status-only change
 * through `updateFact`. Returns the updated fact, or `undefined` if `id`
 * does not exist.
 */
export function setFactStatus(db: Db, id: string, status: FactStatus): Fact | undefined {
  const tx = db.transaction((): void => {
    const current = db
      .prepare<[string], { status: string; prior_status: string | null }>("SELECT status, prior_status FROM facts WHERE id = ?")
      .get(id);
    if (current === undefined) {
      return;
    }
    // `status_changed_at` advances on every call, including a no-op re-write of the status a fact
    // already holds -- that is exactly what `mem pin` on an already-pinned fact means, and it is
    // how the six-month re-confirmation nudge gets cleared. `prior_status`, by contrast, only moves
    // on a genuine transition, so re-pinning cannot erase the pre-pin status a later contradiction
    // reinstatement needs to restore.
    const priorStatus = current.status === status ? current.prior_status : current.status;
    const next = getEpoch(db) + 1;
    const result = db
      .prepare("UPDATE facts SET status = ?, prior_status = ?, status_changed_at = ?, epoch = ? WHERE id = ?")
      .run(status, priorStatus, new Date().toISOString(), next, id);
    if (result.changes > 0) {
      performEpochUpsert(db, next);
    }
  });
  tx.immediate(); // read-then-write under WAL; see insertFact.
  return getFactById(db, id);
}

/**
 * Permanently removes a fact and (via `ON DELETE CASCADE`) its associated
 * sources rows. This is a hard delete, distinct from the `status =
 * 'superseded'` soft-delete convention `setFactStatus` supports for `mem
 * forget` -- a hard delete is for GC (design plan Section 6: "superseded
 * facts ... are GC'd after N days or M rows") or explicit purge, not the
 * normal user-facing delete path. Returns `true` if a row was deleted.
 */
export function deleteFact(db: Db, id: string): boolean {
  const tx = db.transaction((): number => {
    const result = db.prepare("DELETE FROM facts WHERE id = ?").run(id);
    if (result.changes > 0) {
      bumpEpoch(db);
    }
    return result.changes;
  });
  return tx.immediate() > 0; // read-then-write under WAL (bumpEpoch reads); see insertFact.
}

interface SourceRow {
  id: string;
  fact_id: string;
  excerpt: string;
  stored_at: string;
}

function rowToSource(row: SourceRow): Source {
  return { id: row.id, factId: row.fact_id, excerpt: row.excerpt, storedAt: row.stored_at };
}

/** Inserts a new audit-only source excerpt for a fact and returns it in full. Does not bump the write epoch (see module doc comment). */
export function insertSource(db: Db, source: NewSource): Source {
  const id = randomUUID();
  const storedAt = source.storedAt ?? new Date().toISOString();
  db.prepare("INSERT INTO sources (id, fact_id, excerpt, stored_at) VALUES (?, ?, ?, ?)").run(id, source.factId, source.excerpt, storedAt);
  return { id, factId: source.factId, excerpt: source.excerpt, storedAt };
}

/** Lists every source excerpt for a fact, newest first. */
export function listSourcesForFact(db: Db, factId: string): Source[] {
  return db
    .prepare<[string], SourceRow>("SELECT * FROM sources WHERE fact_id = ? ORDER BY stored_at DESC")
    .all(factId)
    .map(rowToSource);
}

/** Deletes one source row by id. Returns `true` if a row was deleted. */
export function deleteSource(db: Db, id: string): boolean {
  return db.prepare("DELETE FROM sources WHERE id = ?").run(id).changes > 0;
}

/** Deletes every source row for a fact (e.g. before a targeted re-capture). Returns the number of rows deleted. */
export function deleteSourcesForFact(db: Db, factId: string): number {
  return db.prepare("DELETE FROM sources WHERE fact_id = ?").run(factId).changes;
}

/** GC primitive (design plan Section 6): deletes source rows stored before `beforeIso` (ISO 8601). Returns the number of rows deleted. Retention policy (which threshold to pass) is a future GC module's decision, not this function's. */
export function deleteSourcesOlderThan(db: Db, beforeIso: string): number {
  return db.prepare("DELETE FROM sources WHERE stored_at < ?").run(beforeIso).changes;
}

/**
 * Records that `factIds` were surfaced to the consumer identified by `sessionId` at `atIso` -- the
 * ledger `--delta` recalls read to avoid re-sending facts a session already has. One transaction,
 * so a partial write cannot leave a session believing it saw half a response.
 */
export function insertRecallLog(db: Db, sessionId: string, factIds: readonly string[], atIso: string): void {
  if (factIds.length === 0) {
    return;
  }
  const insert = db.prepare("INSERT INTO recall_log (fact_id, session_id, surfaced_at) VALUES (?, ?, ?)");
  // The `facts.last_surfaced_at` mirror is written in the same transaction as the log row it
  // summarizes, so the two can never disagree about whether a fact was ever surfaced. Monotonic
  // (`MAX`) rather than last-write-wins: a backdated replay must not walk the mark backwards.
  const mark = db.prepare(
    "UPDATE facts SET last_surfaced_at = MAX(COALESCE(last_surfaced_at, ''), ?) WHERE id = ?"
  );
  db.transaction(() => {
    for (const factId of factIds) {
      insert.run(factId, sessionId, atIso);
      mark.run(atIso, factId);
    }
  })();
}

/** The set of fact ids already logged as surfaced in `sessionId`. */
export function listSurfacedFactIds(db: Db, sessionId: string): Set<string> {
  const rows = db.prepare<[string], { fact_id: string }>("SELECT DISTINCT fact_id FROM recall_log WHERE session_id = ?").all(sessionId);
  return new Set(rows.map((row) => row.fact_id));
}

/**
 * Marks the recall of `factIds` in `sessionId` as having actually been *useful*, stamping `used_at`.
 * Returns the number of rows updated -- which is how the caller learns that an id it named was never
 * surfaced in that session at all (0 rows for that id), rather than silently accepting the claim.
 *
 * `used_at IS NULL` in the WHERE clause makes a repeat `mem used` on the same ids a no-op instead of
 * a re-stamp. That is not just tidiness: `getUsefulnessCounts` counts rows, so without the guard a
 * user confirming the same fact twice would inflate its used count above its surfaced count and rank
 * it ahead of a fact genuinely used on every surfacing. It also keeps the *first* confirmation's
 * timestamp, which is the one that says how quickly the fact proved out.
 *
 * One transaction, invoked `.immediate()`: the statement reads (`used_at IS NULL`) before it writes,
 * so under WAL a deferred BEGIN could lose its snapshot to a concurrent writer and fail with
 * SQLITE_BUSY_SNAPSHOT, which `busy_timeout` does not retry. See `insertFact` for the same rationale.
 *
 * Does not bump the write epoch, for the reason this module's header gives for `sources`: the epoch
 * exists so a token-goat-side cache can never mask a `forget`/`edit`, and a usefulness stamp changes
 * no fact's text, status, or freshness -- only the order recall would rank them in.
 */
export function markRecallUsed(db: Db, factIds: readonly string[], sessionId: string, atIso: string): number {
  if (factIds.length === 0) {
    return 0;
  }
  const mark = db.prepare("UPDATE recall_log SET used_at = ? WHERE session_id = ? AND fact_id = ? AND used_at IS NULL");
  const tx = db.transaction((): number => {
    let updated = 0;
    for (const factId of factIds) {
      updated += mark.run(atIso, sessionId, factId).changes;
    }
    return updated;
  });
  return tx.immediate();
}

/**
 * How often each fact has been surfaced and how often that surfacing was confirmed useful, across
 * every session. Feeds `RetrievalOptions.usefulness`.
 *
 * One grouped query rather than a lookup per fact: recall ranks the whole candidate pool, so a
 * per-fact query would put a round trip on every fact in the store inside the `--hint-format` seam's
 * ~150ms budget. Facts with no recall_log row are absent from the map rather than present with
 * zeroes -- "never surfaced" and "surfaced and never useful" are different claims, and only the
 * second one should push a fact down the usefulness ranking.
 */
export function getUsefulnessCounts(db: Db): Map<string, { surfaced: number; used: number }> {
  const rows = db
    .prepare<[], { fact_id: string; surfaced: number; used: number }>(
      "SELECT fact_id, COUNT(*) AS surfaced, COUNT(used_at) AS used FROM recall_log GROUP BY fact_id"
    )
    .all();
  return new Map(rows.map((row) => [row.fact_id, { surfaced: row.surfaced, used: row.used }]));
}

/** One extracted facet row: the verbatim term, its lookup key, and which facet it belongs to. */
export interface FactTerm {
  readonly term: string;
  readonly termKey: string;
  readonly kind: FactTermKind;
}

export type FactTermKind = "entity" | "topic";

/**
 * Replaces every stored term for `factId` with the terms of `facets`.
 *
 * Delete-then-insert rather than a merge, so re-running extraction over unchanged text yields
 * byte-identical rows and re-running it after an extraction-rule change leaves nothing behind from
 * the old rules -- a term that stopped qualifying has to actually disappear, or `mem facets --all`
 * would only ever add. Both halves run in one transaction, invoked `.immediate()`: the pair is a
 * read-modify-write on the same rows and a concurrent writer between them would leave a fact with
 * no terms at all. See `insertFact` for the full SQLITE_BUSY_SNAPSHOT rationale.
 *
 * Does not bump the write epoch, for the reason this module's header gives for `sources`: terms are
 * derived from `facts.text` and change nothing about a fact's content, status, or freshness -- only
 * which `--entity` queries reach it.
 */
export function replaceFactTerms(db: Db, factId: string, facets: FactFacets): void {
  const remove = db.prepare("DELETE FROM fact_terms WHERE fact_id = ?");
  const insert = db.prepare("INSERT INTO fact_terms (fact_id, term, term_key, kind) VALUES (?, ?, ?, ?)");
  const tx = db.transaction((): void => {
    remove.run(factId);
    for (const entity of facets.entities) {
      insert.run(factId, entity, normalizeTermKey(entity), "entity");
    }
    for (const topic of facets.topics) {
      insert.run(factId, topic, normalizeTermKey(topic), "topic");
    }
  });
  tx.immediate();
}

/** Every term stored for one fact, entities before topics and in extraction order within each. */
export function listTermsForFact(db: Db, factId: string): FactTerm[] {
  const rows = db
    .prepare<[string], { term: string; term_key: string; kind: FactTermKind }>(
      "SELECT term, term_key, kind FROM fact_terms WHERE fact_id = ? ORDER BY kind DESC, rowid ASC"
    )
    .all(factId);
  return rows.map((row) => ({ term: row.term, termKey: row.term_key, kind: row.kind }));
}

/**
 * Ids of every fact carrying `term` (matched on its normalized key, so the caller may pass the term
 * however the user typed it), optionally restricted to one facet.
 */
export function listFactIdsForTerm(db: Db, term: string, kind?: FactTermKind): string[] {
  const key = normalizeTermKey(term);
  const sql =
    kind === undefined
      ? "SELECT DISTINCT fact_id FROM fact_terms WHERE term_key = ?"
      : "SELECT DISTINCT fact_id FROM fact_terms WHERE term_key = ? AND kind = ?";
  const params = kind === undefined ? [key] : [key, kind];
  return db.prepare<unknown[], { fact_id: string }>(sql).all(...params).map((row) => row.fact_id);
}

/**
 * Every fact's entity lookup keys, for `RetrievalOptions.factEntityKeys`.
 *
 * One grouped read rather than a query per candidate, for the reason `getUsefulnessCounts` gives:
 * recall filters the whole store, so a per-fact round trip would land inside the `--hint-format`
 * seam's ~150ms budget. Topics are excluded -- `--entity` is an entity filter, and the topic facet
 * is already what BM25 ranks on.
 */
export function getEntityKeysByFact(db: Db): Map<string, Set<string>> {
  const rows = db
    .prepare<[], { fact_id: string; term_key: string }>("SELECT fact_id, term_key FROM fact_terms WHERE kind = 'entity'")
    .all();
  const byFact = new Map<string, Set<string>>();
  for (const row of rows) {
    const keys = byFact.get(row.fact_id) ?? new Set<string>();
    keys.add(row.term_key);
    byFact.set(row.fact_id, keys);
  }
  return byFact;
}

/**
 * The distinct entities in the store with how many facts carry each, most frequent first.
 *
 * Grouped on the normalized key but reporting one verbatim spelling (`MIN(term)`, so the answer is
 * stable rather than whichever row SQLite reached last): `PostgreSQL` and `postgresql` are one
 * entity to `--entity` and have to be one line here, or the listing would advertise a distinction
 * lookup does not make.
 */
export function listEntityCounts(db: Db): Array<{ term: string; termKey: string; facts: number }> {
  return db
    .prepare<[], { term: string; term_key: string; facts: number }>(
      `SELECT MIN(term) AS term, term_key, COUNT(DISTINCT fact_id) AS facts
       FROM fact_terms WHERE kind = 'entity'
       GROUP BY term_key
       ORDER BY facts DESC, term_key ASC`
    )
    .all()
    .map((row) => ({ term: row.term, termKey: row.term_key, facts: row.facts }));
}

/**
 * Ids and texts of facts needing facet extraction, oldest first -- `mem facets`' backfill.
 *
 * Oldest first and `all`-gated for the same reasons as `listFactsNeedingEmbedding`: a bounded
 * re-run should chip away at the arrears deterministically, and `--all` is the path after an
 * extraction-rule change, when facts that already have terms are exactly the ones that need new
 * ones. "Needs extraction" is the absence of any row, not the absence of an entity row: a fact
 * whose text contains no identifier legitimately has zero entities and would otherwise be re-offered
 * on every run forever.
 */
export function listFactsNeedingTerms(db: Db, options: { readonly all?: boolean } = {}): Array<{ id: string; text: string }> {
  const where = options.all === true ? "" : "WHERE NOT EXISTS (SELECT 1 FROM fact_terms WHERE fact_terms.fact_id = facts.id)";
  return db
    .prepare<[], { id: string; text: string }>(`SELECT id, text FROM facts ${where} ORDER BY captured_at ASC, id ASC`)
    .all();
}

/** GC primitive: deletes recall-log rows surfaced before `beforeIso` (ISO 8601). Returns the number of rows deleted. */
/**
 * The population `mem consolidate --stale` proposes: `active` facts captured before `beforeIso`
 * that recall has never surfaced and nobody has ever marked useful, oldest first.
 *
 * `pinned` facts are excluded by construction, not by a caller-side filter -- a pin is a standing
 * instruction that this fact matters regardless of whether it has been read yet. So are `pending`,
 * `contested`, and `superseded` facts: none of them is live ground truth, and each already has its
 * own resolution path (`mem review`, the retention pass).
 *
 * Three conditions, not one, because no single one is sufficient. `last_surfaced_at` is the durable
 * mark but is NULL for every fact captured before that column existed; the `recall_log` NOT EXISTS
 * covers those, up to the rotation window; and `used_at` lives on `recall_log` rows, so a fact
 * marked useful is already excluded by the row that carries the mark. Keying on `captured_at`
 * (never edited) rather than `status_changed_at` is deliberate: this pass asks how long a fact has
 * gone unread, and a fact that has never changed status has no `status_changed_at` at all.
 */
export function listStaleUnsurfacedFacts(db: Db, beforeIso: string): Fact[] {
  const rows = db
    .prepare<[string], FactRow>(
      `SELECT * FROM facts AS f
       WHERE f.status = 'active'
         AND f.captured_at < ?
         AND f.last_surfaced_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM recall_log AS r WHERE r.fact_id = f.id)
       ORDER BY f.captured_at ASC, f.id ASC`
    )
    .all(beforeIso);
  return rows.map(rowToFact);
}

export function deleteRecallLogOlderThan(db: Db, beforeIso: string): number {
  return db.prepare("DELETE FROM recall_log WHERE surfaced_at < ?").run(beforeIso).changes;
}

/** Reads the current write epoch (design plan Section 4), defaulting to `0` on a freshly-initialized database. */
export function getEpoch(db: Db): number {
  const row = db.prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'epoch'").get();
  return row === undefined ? 0 : Number(row.value);
}

/** `meta` keys describing the embedding model the vectors in `facts.embedding` were produced by. */
const EMBEDDING_MODEL_KEY = "embedding_model";
const EMBEDDING_DIMENSION_KEY = "embedding_dimension";

function getMetaValue(db: Db, key: string): string | undefined {
  return db.prepare<[string], { value: string }>("SELECT value FROM meta WHERE key = ?").get(key)?.value;
}

function setMetaValue(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/**
 * Reads which embedding model produced the vectors currently stored in `facts.embedding`, or
 * `undefined` on a store nothing has ever been embedded in.
 *
 * Recorded at all because `cosineSimilarity` compares over the shorter of two vectors and therefore
 * cannot tell a genuine similarity from one computed across two different models' vector spaces --
 * see `planEmbeddingRanking` in embeddings.ts, which is this value's only consumer.
 */
export function getEmbeddingMeta(db: Db): EmbeddingMeta | undefined {
  const model = getMetaValue(db, EMBEDDING_MODEL_KEY);
  const dimension = Number(getMetaValue(db, EMBEDDING_DIMENSION_KEY));
  if (model === undefined || !Number.isInteger(dimension) || dimension <= 0) {
    return undefined;
  }
  return { model, dimension };
}

/** Records the model and vector dimension the store's embeddings were produced by. Written by whichever path first populates a vector, and rewritten by `mem embed --all`. Not an epoch bump: no fact's content, status, or freshness changes. */
export function setEmbeddingMeta(db: Db, meta: EmbeddingMeta): void {
  setMetaValue(db, EMBEDDING_MODEL_KEY, meta.model);
  setMetaValue(db, EMBEDDING_DIMENSION_KEY, String(meta.dimension));
}

/** Counts facts that currently carry an embedding vector, for `mem doctor`'s coverage line. */
export function countEmbeddedFacts(db: Db): number {
  return db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM facts WHERE embedding IS NOT NULL").get()?.count ?? 0;
}

/** Counts facts that carry at least one extracted term, for `mem doctor`'s coverage line. Counts distinct facts rather than rows in `fact_terms`, which holds many terms per fact. */
export function countFactsWithTerms(db: Db): number {
  return db.prepare<[], { count: number }>("SELECT COUNT(DISTINCT fact_id) AS count FROM fact_terms").get()?.count ?? 0;
}

/**
 * Drops every stored embedding vector in one statement, returning how many rows were cleared.
 *
 * `mem embed --all` calls this before re-embedding under a different model. Without it a migration
 * interrupted halfway leaves the store holding two models' vectors while `meta` names only one --
 * and if the two models happen to share a dimension, nothing downstream can tell them apart and
 * ranking silently mixes vector spaces. Clearing first makes an interrupted migration lose ranking
 * quality (facts with no vector) instead of correctness.
 *
 * One `UPDATE` and one epoch bump, not `updateFact` per row: this is a single logical store change,
 * and stamping N per-row epochs would say N writes happened when one did.
 */
export function clearAllEmbeddings(db: Db): number {
  const tx = db.transaction((): number => {
    const next = getEpoch(db) + 1;
    const result = db.prepare("UPDATE facts SET embedding = NULL, epoch = ? WHERE embedding IS NOT NULL").run(next);
    if (result.changes > 0) {
      performEpochUpsert(db, next);
    }
    return result.changes;
  });
  return tx.immediate(); // read-then-write under WAL (getEpoch reads); see insertFact.
}

/**
 * Ids and texts of facts still needing a vector, oldest first, for `mem embed`'s backfill.
 *
 * Oldest first, unlike `listFacts`: a `--limit`ed backfill run should chip away at the arrears
 * deterministically, so re-running it makes progress instead of re-offering the same newest slice.
 */
export function listFactsNeedingEmbedding(db: Db, options: { readonly all?: boolean; readonly limit?: number } = {}): Array<{ id: string; text: string }> {
  const where = options.all === true ? "" : "WHERE embedding IS NULL";
  const sql = `SELECT id, text FROM facts ${where} ORDER BY captured_at ASC, id ASC${options.limit !== undefined ? " LIMIT ?" : ""}`;
  const params = options.limit !== undefined ? [options.limit] : [];
  return db.prepare<unknown[], { id: string; text: string }>(sql).all(...params);
}

/**
 * Performs the actual epoch upsert into the meta table. Extracted to eliminate duplication
 * across `bumpEpoch` and the conditional bumps in `updateFact`/`setFactStatus`.
 */
function performEpochUpsert(db: Db, next: number): void {
  db.prepare("INSERT INTO meta (key, value) VALUES ('epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(next));
}

/**
 * Increments the write epoch by 1 and returns the new value. Callers must run this inside the same
 * transaction as the fact write it accompanies (every exported fact-write function in this module
 * already does), and use the returned value to stamp that write's `facts.epoch` column so a fact's
 * recorded epoch is always exactly the epoch its own write produced -- never a stale read from
 * before or after. Not exported: bumping the epoch outside of an actual write would desynchronize it
 * from what it is meant to describe.
 */
function bumpEpoch(db: Db): number {
  const current = getEpoch(db);
  const next = current + 1;
  performEpochUpsert(db, next);
  return next;
}
