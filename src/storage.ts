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
  ensureStorageSchema(db);
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
 */
function unpackEmbedding(blob: Buffer): Float32Array {
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
  };
}

function getFactRow(db: Db, id: string): FactRow | undefined {
  return db.prepare<[string], FactRow>("SELECT * FROM facts WHERE id = ?").get(id);
}

/**
 * Inserts a new fact and returns it in full (including the generated `id`
 * and any defaulted fields). Runs inside a transaction with the epoch bump
 * so a crash between the insert and the bump can never happen.
 */
export function insertFact(db: Db, fact: NewFact): Fact {
  const id = fact.id ?? randomUUID();
  const capturedAt = fact.captured_at ?? new Date().toISOString();
  const status = fact.status ?? "active";
  const confidence = fact.confidence ?? 1.0;
  const subject = fact.subject === undefined || fact.subject === null ? null : normalizeSubject(fact.subject);
  const embeddingBlob = fact.embedding === undefined || fact.embedding === null ? null : packEmbedding(fact.embedding);

  const insert = db.prepare(
    `INSERT INTO facts (id, text, kind, subject, value, scope, scope_root, source_type, source_ref, captured_at, anchor, status, confidence, embedding, epoch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      epoch
    );
  });
  tx();

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
const ID_PREFIX_PATTERN = /^[0-9a-fA-F-]+$/;

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
    params.push(patch.text);
  }
  if (patch.subject !== undefined) {
    sets.push("subject = ?");
    params.push(patch.subject === null ? null : normalizeSubject(patch.subject));
  }
  if (patch.value !== undefined) {
    sets.push("value = ?");
    params.push(patch.value);
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

  sets.push("epoch = ?");
  const sql = `UPDATE facts SET ${sets.join(", ")} WHERE id = ?`;

  const tx = db.transaction((): void => {
    const epoch = bumpEpoch(db);
    db.prepare(sql).run(...params, epoch, id);
  });
  tx();

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
    const epoch = bumpEpoch(db);
    db.prepare("UPDATE facts SET status = ?, epoch = ? WHERE id = ?").run(status, epoch, id);
  });
  tx();
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
    bumpEpoch(db);
    return result.changes;
  });
  return tx() > 0;
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

/** Reads the current write epoch (design plan Section 4), defaulting to `0` on a freshly-initialized database. */
export function getEpoch(db: Db): number {
  const row = db.prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'epoch'").get();
  return row === undefined ? 0 : Number(row.value);
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
  db.prepare("INSERT INTO meta (key, value) VALUES ('epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(next));
  return next;
}
