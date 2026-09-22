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
 * epoch is never observably out of sync with the data it describes. The same
 * applies to writes that change what recall would return without touching the
 * `facts` table itself (`replaceFactTerms`, `markRecallUsed`). Writes to
 * `sources` do not bump it: `sources` is audit-only and never feeds the
 * `--hint-format` seam output the epoch exists to guard (Section 4).
 */

import { randomUUID } from "node:crypto";
import type { AnchorCacheStore, AnchorVerdict } from "./anchors.js";
import { openDb, resolveDbPath } from "./db.js";
import type { EmbeddingMeta } from "./embeddings.js";
import { extractFacets, normalizeTermKey, type FactFacets } from "./facets.js";
import { hashFactText, normalizeFactText } from "./factText.js";
import { runMigrations } from "./migrations.js";
import type { Fact, FactFilter, FactLink, FactUpdate, NewFact, NewSource, Source, FactStatus } from "./types.js";

/** Connection type, borrowed from db.ts's own return type rather than importing better-sqlite3's types directly -- keeps this module's public surface in lockstep with whatever db.ts actually opens. */
type Db = ReturnType<typeof openDb>;

/**
 * Ensures every table/column this module and `migrations.ts`'s steps are responsible for exists on
 * an already-open connection, and enables foreign-key enforcement so `sources`'s `ON DELETE CASCADE`
 * actually fires -- `PRAGMA foreign_keys` is per-connection and off by default in SQLite, and
 * db.ts's `openDb` does not set it (it does not need to: `facts` has no foreign keys of its own).
 *
 * The schema work itself lives in `migrations.ts`'s `runMigrations`, keyed on `PRAGMA user_version`;
 * this is now just that module's entry point for callers that only hold a connection opened via
 * `openDb` rather than `openStorage`. `openDb` already runs the same migrations, so on a connection
 * opened through `openStorage` (below) this call is a same-version no-op every time -- cheap, and
 * kept rather than skipped so a bare `openDb` handle passed here directly still ends up fully
 * migrated. Idempotent: safe to call on every connection open.
 */
export function ensureStorageSchema(db: Db): void {
  db.pragma("foreign_keys = ON");
  runMigrations(db);
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

/**
 * The one `anchor_cache` upsert statement, shared by {@link createAnchorCacheStore} (writes as it
 * goes) and {@link persistAnchorVerdicts} (flushes a batch) -- both write the same row shape, so
 * there is exactly one place that knows it.
 */
const ANCHOR_CACHE_UPSERT_SQL = `
INSERT INTO anchor_cache (root, anchor, verdict, verified_at, witness) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(root, anchor) DO UPDATE SET verdict = excluded.verdict, verified_at = excluded.verified_at, witness = excluded.witness
`;

/**
 * SQLite-backed {@link AnchorCacheStore} (anchors.ts): the concrete implementation for the
 * `anchor_cache` table `migrations.ts` creates. anchors.ts stays free of any storage-specific
 * import by depending only on the narrow interface -- this is the one place that translates it into
 * SQL, so callers construct this from an open `Db` and pass it into `evaluateAnchor`/`retrieve`.
 *
 * `INSERT ... ON CONFLICT DO UPDATE` rather than a read-then-write: `(root, anchor)` is the table's
 * primary key, so this is a single statement either way, and avoids a race between two `mem`
 * processes evaluating the same anchor+root at once.
 */
export function createAnchorCacheStore(db: Db): AnchorCacheStore {
  const getStmt = db.prepare<[string, string], { verdict: AnchorVerdict; witness: string | null }>(
    "SELECT verdict, witness FROM anchor_cache WHERE root = ? AND anchor = ?"
  );
  const setStmt = db.prepare<[string, string, AnchorVerdict, string, string | null]>(ANCHOR_CACHE_UPSERT_SQL);
  return {
    get(root, anchor) {
      const row = getStmt.get(root, anchor);
      return row === undefined ? undefined : { verdict: row.verdict, witness: row.witness };
    },
    set(root, anchor, verdict, witness) {
      setStmt.run(root, anchor, verdict, new Date().toISOString(), witness);
    },
  };
}

/**
 * Test convenience: clears every persisted anchor verdict, mirroring anchors.ts's own
 * `clearAnchorCaches`/`_clearAnchorMemoForTests` for the in-process memo. Not needed by production
 * code -- a real store's rows are meant to persist -- but tests sharing one on-disk db across cases
 * need a way to stop one case's verdicts leaking into the next.
 */
export function clearAnchorCacheStore(db: Db): void {
  db.exec("DELETE FROM anchor_cache");
}

/** One buffered verdict, keyed by its own `(root, anchor)` pair -- see {@link BufferedAnchorCacheStore}. */
export interface BufferedAnchorVerdict {
  readonly root: string;
  readonly anchor: string;
  readonly verdict: AnchorVerdict;
  readonly witness: string | null;
}

/** Composite key for the prefetch snapshot and the write buffer below -- `root` and `anchor` are both free-form strings, so a delimiter absent from either is required; `\u0000` cannot appear in a resolved filesystem path or an anchor token. */
function anchorCacheKey(root: string, anchor: string): string {
  return `${root}\u0000${anchor}`;
}

/**
 * An `AnchorCacheStore` for callers that must not hold a DB handle open across `retrieve()`
 * (integration-seam.ts's hint-format path, `mem recall`): both load-all-then-rank, closing the
 * connection before ranking runs, so holding a WAL read connection across `retrieve()`'s embedding
 * round trip risks lock pileups on the hook path, which can fire concurrently across sessions.
 *
 * `get` is reused by `prefetchAnchorCache` below (see its doc comment) -- rows read while the
 * connection was open, before `retrieve()` starts. `set` never touches SQLite: it buffers in
 * memory, and the caller flushes with {@link persistAnchorVerdicts} once a connection is available
 * again (see integration-seam.ts's post-retrieve bookkeeping write). A verdict already in the
 * buffer wins over the prefetched snapshot for the same key, so a second `evaluateAnchor` call for
 * the same anchor within one `retrieve()` (a different fact anchored to the same file) sees its own
 * fresh write rather than the value that was true before this query started.
 */
export interface BufferedAnchorCacheStore extends AnchorCacheStore {
  /** Verdicts written via `set()` during this query, not yet persisted. Drained by `persistAnchorVerdicts`, never mutated by anything else. */
  readonly buffer: ReadonlyMap<string, BufferedAnchorVerdict>;
}

/**
 * Snapshots every `anchor_cache` row for `root` while `db` is open, for {@link createBufferedAnchorCacheStore}
 * to hydrate from. `root` is a primary-key prefix (`PRIMARY KEY (root, anchor)`), so this is one
 * indexed range scan -- not the full table, and not one query per anchor.
 */
export function prefetchAnchorCache(db: Db, root: string): ReadonlyMap<string, { verdict: AnchorVerdict; witness: string | null }> {
  const rows = db
    .prepare<[string], { anchor: string; verdict: AnchorVerdict; witness: string | null }>(
      "SELECT anchor, verdict, witness FROM anchor_cache WHERE root = ?"
    )
    .all(root);
  const snapshot = new Map<string, { verdict: AnchorVerdict; witness: string | null }>();
  for (const row of rows) {
    snapshot.set(anchorCacheKey(root, row.anchor), { verdict: row.verdict, witness: row.witness });
  }
  return snapshot;
}

/** Builds the disconnected store described on {@link BufferedAnchorCacheStore}, hydrated from `prefetched` (see {@link prefetchAnchorCache}). */
export function createBufferedAnchorCacheStore(
  prefetched: ReadonlyMap<string, { verdict: AnchorVerdict; witness: string | null }>
): BufferedAnchorCacheStore {
  const buffer = new Map<string, BufferedAnchorVerdict>();
  return {
    get buffer(): ReadonlyMap<string, BufferedAnchorVerdict> {
      return buffer;
    },
    get(root, anchor) {
      const key = anchorCacheKey(root, anchor);
      const pending = buffer.get(key);
      if (pending !== undefined) {
        return { verdict: pending.verdict, witness: pending.witness };
      }
      return prefetched.get(key);
    },
    set(root, anchor, verdict, witness) {
      buffer.set(anchorCacheKey(root, anchor), { root, anchor, verdict, witness });
    },
  };
}

/**
 * Flushes a {@link BufferedAnchorCacheStore}'s buffer to `anchor_cache` in one transaction, using
 * the same upsert `createAnchorCacheStore` writes with (`ANCHOR_CACHE_UPSERT_SQL`). A no-op --
 * opens no statement, starts no transaction -- when the buffer is empty, so a query that evaluated
 * no anchors (or reused every verdict from the prefetch) costs this function nothing.
 */
export function persistAnchorVerdicts(db: Db, buffer: ReadonlyMap<string, BufferedAnchorVerdict>): void {
  if (buffer.size === 0) {
    return;
  }
  const setStmt = db.prepare<[string, string, AnchorVerdict, string, string | null]>(ANCHOR_CACHE_UPSERT_SQL);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const entry of buffer.values()) {
      setStmt.run(entry.root, entry.anchor, entry.verdict, now, entry.witness);
    }
  });
  tx.immediate();
}

/** Normalizes a subject key for deterministic contradiction detection (design plan P4): trims surrounding whitespace and lowercases, so "Package-Manager", "package-manager ", and "package-manager" all key to the same bucket regardless of how a caller typed `--subject`. */
export function normalizeSubject(subject: string): string {
  return subject.trim().toLowerCase();
}

/**
 * Normalizes a value for agreement comparison ONLY -- trims, collapses internal whitespace, and
 * lowercases, so "pnpm", "Pnpm", and "pnpm  " (or "pnpm workspace" vs "pnpm workspace") all compare
 * as the same value regardless of how a caller typed `--value`. Mirrors `normalizeSubject`'s shape,
 * with one addition: unlike a subject key, a value can legitimately contain internal whitespace a
 * caller varies without meaning anything by it. Callers must keep storing and displaying the raw
 * `fact.value` -- this exists only for the comparisons in `detectContradictions` and
 * `reaffirmMatch` that decide whether two facts agree, never for what gets written to a row or
 * printed by `mem show`.
 */
export function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

// `normalizeFactText`/`hashFactText` live in factText.ts (see that module's own doc comment for
// why) and are re-exported here so every existing `from "./storage.js"` caller keeps working.
export { normalizeFactText, hashFactText } from "./factText.js";

/**
 * Whether `fact` is the same statement as `candidate`, for the purposes of an explicit restatement.
 *
 * Every part of the identity must match, not just the text: same scope *binding* (a project fact in
 * one repo is not a restatement of the same sentence in another), and same subject/value. Subject
 * and value are what contradiction resolution keys on, so identical text carrying a different value
 * is a correction to be recorded, never a repeat to be collapsed. Kind and status are filtered by
 * the caller's SQL, not here.
 */
function reaffirmMatch(fact: Fact, candidate: NewFact, wanted: string, subject: string | null, candidateScopeRoot: string | null, candidateScopeRepo: string | null): boolean {
  return (
    normalizeFactText(fact.text) === wanted &&
    scopeBindingMatchesCandidate(fact, candidate.scope, candidateScopeRoot, candidateScopeRepo) &&
    (fact.subject ?? null) === subject &&
    normalizeValueOrNull(fact.value) === normalizeValueOrNull(candidate.value)
  );
}

/** `normalizeValue`, threaded through the `null`/`undefined` a fact's optional `value` can carry. */
function normalizeValueOrNull(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : normalizeValue(value);
}

/**
 * The live fact that `candidate` is a restatement of, if there is one.
 *
 * A user who says the same thing twice means it more, not less -- but with no dedup the second
 * `mem remember` wrote a second row and left the first one's decay clock running, so the facts a
 * user cared enough to repeat were the ones drifting out of ground truth. This finds the row to
 * reaffirm instead.
 *
 * Only `active` and `pinned` facts are candidates here. A `pending` match must not be reaffirmed by
 * this function -- that would promote a suggested fact to a refreshed clock without review, the side
 * door the capture module exists to keep shut -- and a `superseded` one must not be silently
 * resurrected by a sentence that happens to match. `captureExplicit` resolves a matching `pending`
 * fact through the separate, explicit path in {@link findReaffirmablePendingFacts} instead.
 */
export function findReaffirmableFact(db: Db, candidate: NewFact): Fact | undefined {
  const wanted = normalizeFactText(candidate.text);
  const subject = candidate.subject === undefined || candidate.subject === null ? null : normalizeSubject(candidate.subject);
  const candidateScopeRoot = candidate.scopeRoot ?? null;
  const candidateScopeRepo = candidate.scopeRepo ?? null;
  const rows = db
    .prepare<[string, string], FactRow>(
      "SELECT * FROM facts WHERE kind = ? AND scope = ? AND status IN ('active', 'pinned')"
    )
    .all(candidate.kind, candidate.scope);
  return rows.map(rowToFact).find((fact) => reaffirmMatch(fact, candidate, wanted, subject, candidateScopeRoot, candidateScopeRepo));
}

/**
 * Every `pending` fact that an explicit restatement of `candidate` would resolve -- plural, because
 * `mem suggest` (or a JSON import) can file the identical sentence more than once before any of it
 * is reviewed. `captureExplicit` only reaffirms the single live (active/pinned) match above; without
 * this, an explicit restatement resolved at most one of several duplicate pending rows and left the
 * rest sitting in the review queue asking about a sentence the user had already answered.
 *
 * Ordered oldest-`captured_at`-first (ties broken by id) so promotion is deterministic: the
 * earliest-suggested duplicate is the one kept and promoted, later duplicates are superseded.
 */
export function findReaffirmablePendingFacts(db: Db, candidate: NewFact): Fact[] {
  const wanted = normalizeFactText(candidate.text);
  const subject = candidate.subject === undefined || candidate.subject === null ? null : normalizeSubject(candidate.subject);
  const candidateScopeRoot = candidate.scopeRoot ?? null;
  const candidateScopeRepo = candidate.scopeRepo ?? null;
  const rows = db
    .prepare<[string, string], FactRow>(
      // Use rowid as the tiebreaker instead of id: `id` is a random UUID (no ordering semantics),
      // so when two facts share a `captured_at` timestamp (routine when captured in the same
      // millisecond, e.g., during `mem import --from-md` or `mem scan-session`), `id ASC` turns
      // the documented "earliest-captured fact is promoted" rule into a coin flip. `rowid` increases
      // with insertion order, making the tiebreaker deterministic: the first-inserted fact wins.
      // Note: Without AUTOINCREMENT, SQLite may reuse a rowid from a deleted row, but a reused
      // rowid comes from a row predating both tied captures, so it cannot land between them.
      "SELECT * FROM facts WHERE kind = ? AND scope = ? AND status = 'pending' ORDER BY captured_at ASC, rowid ASC"
    )
    .all(candidate.kind, candidate.scope);
  return rows.map(rowToFact).filter((fact) => reaffirmMatch(fact, candidate, wanted, subject, candidateScopeRoot, candidateScopeRepo));
}

/**
 * Whether `fact` and a reaffirm candidate share the same scope binding, per this file's own
 * `findReaffirmableFact` doc comment ("a project fact in one repo is not a restatement of the same
 * sentence in another") -- which is a statement about the *repository*, not about the literal path
 * a fact happened to be captured at. An exact AND of `scopeRoot` and `scopeRepo` equality is
 * stricter than that: restating identical text from a second clone or a worktree of the same
 * project changes `scopeRoot` (a different absolute path) while `scopeRepo` (the repository
 * identity) stays the same, and the AND check failed that match and inserted a duplicate row
 * instead of reaffirming. Recall's own `isBoundToRoot` (src/retrieval.ts) treats a project fact's
 * `scopeRoot`/`scopeRepo` as an OR for exactly this reason, and AGENTS.md documents reaffirm's own
 * match as "scope binding" -- the same widening contradiction bucketing now uses too
 * (`computeProjectIdentityGroups`, src/contradiction.ts), so this is no longer a stricter, separate
 * rule from that one.
 *
 * `path` scope carries no identity (`scopeRepo` is always null there), so exact `scopeRoot`
 * equality is already "the same binding" for it; `global` has no binding to compare at all, and
 * both sides are always null by construction.
 */
function scopeBindingMatchesCandidate(
  fact: Fact,
  scope: NewFact["scope"],
  candidateScopeRoot: string | null,
  candidateScopeRepo: string | null
): boolean {
  if ((fact.scopeRoot ?? null) === candidateScopeRoot) {
    return true;
  }
  const factScopeRepo = fact.scopeRepo ?? null;
  return scope === "project" && factScopeRepo !== null && factScopeRepo === candidateScopeRepo;
}

/**
 * Restarts a fact's clock: `captured_at` moves to now and confidence is restored to full.
 *
 * `captured_at` is what time-decay measures age against and what contradiction resolution breaks
 * ties on, so this is the whole substance of a reaffirmation -- the fact was true then and is true
 * again now, and it should rank and decay as though it had just been stated.
 *
 * Narrow on purpose rather than a `captured_at` field on {@link FactUpdate}: that clock decides
 * decay and precedence, and `mem edit` has no business moving it.
 *
 * Also applies `updates.anchor`/`updates.sourceRef` when the caller restates the same fact
 * carrying a new one.
 *
 * The user's latest statement wins, for the same reason `captured_at` and `confidence` already
 * refresh here: `mem remember "uses pnpm"` followed by `mem remember "uses pnpm" --anchor
 * "file-exists pnpm-lock.yaml"` used to print "reaffirmed" while silently discarding the anchor,
 * leaving the fact caveated `unverified` forever with no way to ever reach `contradicted`. An
 * `updates` field left `undefined` means the incoming capture carried nothing for that field --
 * the existing value (including an existing anchor) is left untouched, never cleared.
 */
export function reaffirmFact(
  db: Db,
  id: string,
  at: Date = new Date(),
  updates: { anchor?: string; sourceRef?: string } = {}
): Fact | undefined {
  const tx = db.transaction((): Fact | undefined => {
    const epoch = bumpEpoch(db);
    const sets = ["captured_at = ?", "confidence = 1.0", "epoch = ?"];
    const params: unknown[] = [at.toISOString(), epoch];
    if (updates.anchor !== undefined) {
      sets.push("anchor = ?");
      params.push(updates.anchor);
    }
    if (updates.sourceRef !== undefined) {
      sets.push("source_ref = ?");
      params.push(updates.sourceRef);
    }
    params.push(id);
    const changed = db.prepare(`UPDATE facts SET ${sets.join(", ")} WHERE id = ?`).run(...params).changes;
    return changed === 0 ? undefined : getFactById(db, id);
  });
  return tx.immediate();
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
  scope_repo: string | null;
  capture_root: string | null;
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
  last_surfaced_at: string | null;
  terms_checked_at: string | null;
  sightings: number;
  text_hash: string | null;
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
    scopeRepo: row.scope_repo,
    captureRoot: row.capture_root,
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
    last_surfaced_at: row.last_surfaced_at,
    terms_checked_at: row.terms_checked_at,
    sightings: row.sightings,
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
    `INSERT INTO facts (id, text, kind, subject, value, scope, scope_root, scope_repo, capture_root, source_type, source_ref, captured_at, anchor, status, confidence, embedding, epoch, status_changed_at, prior_status, last_surfaced_at, terms_checked_at, sightings, text_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      fact.scopeRepo ?? null,
      fact.captureRoot ?? null,
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
      status === "active" ? capturedAt : new Date().toISOString(),
      // Preserved verbatim rather than defaulted, for the same restore-from-export reason as
      // `status === "active" ? capturedAt : ...` above: a fact restored via full-fidelity JSON
      // import must keep the status it held immediately before its current one (see
      // `Fact.prior_status`), or `mem review --undo`/contradiction reinstatement land it on the
      // wrong state. The capture path never supplies this -- a freshly captured fact has no prior
      // state -- so it stays NULL there, matching the old hardcoded default.
      fact.prior_status ?? null,
      // Preserved verbatim for the same reason: an export that dropped this made a restored fact
      // look never-surfaced (see `Fact.last_surfaced_at`), so the stale-supersede pass would
      // re-supersede a fact that was in daily use on the source store.
      fact.last_surfaced_at ?? null,
      // Always NULL here, whatever the caller passed: the `replaceFactTerms` call just below runs
      // in this same transaction and stamps the real value, so a value threaded through this
      // parameter would only ever be immediately overwritten -- see that function's own extraction
      // rationale.
      null,
      // Always 0: a freshly captured fact has not been restated yet, whatever status it starts in
      // -- `NewFact` carries no `sightings` field to thread through here, unlike `prior_status`/
      // `last_surfaced_at` above, because there is no restore path (export/import round trip) that
      // needs to preserve a nonzero count. Only `recordSighting` (src/capture.ts) increments it,
      // strictly after this row already exists.
      0,
      hashFactText(fact.text)
    );
    replaceFactTermsInternal(db, id, extractFacets(fact.text), false);
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

/**
 * Every stored fact whose text normalizes the same as `text` -- a single-text-lookup: "does a fact
 * with this normalized text already exist?", asked once per candidate rather than indexing the
 * whole store, for a caller that only ever looks up a handful of candidates against one that may
 * hold many more facts than that.
 *
 * Feeds `mem scan-session`'s cross-scan idempotency guard: the Stop hook fires at the end of every
 * assistant turn, so the same sentence is re-extracted for the rest of the session, and matching on
 * text rather than a session marker is what keeps a *rejected* candidate rejected -- a rejected
 * fact is still in the store as `superseded`, so re-filing it would resurrect a decision the user
 * already made.
 *
 * Narrows via `idx_facts_text_hash` first, then re-checks `normalizeFactText` equality in JS on the
 * (small) candidate set -- a `text_hash` collision must never be treated as a text match on its
 * own, and SQL `LOWER()` folds ASCII only, so a clause built on it can miss a stored row outright
 * when the two sides disagree on the case of a non-ASCII letter ("Émacs" stored, "émacs" queried).
 */
export function factsByTextHash(db: Db, text: string): Fact[] {
  const normalized = normalizeFactText(text);
  const hash = hashFactText(text);
  return db
    .prepare<[string], FactRow>("SELECT * FROM facts WHERE text_hash = ?")
    .all(hash)
    .filter((row) => normalizeFactText(row.text) === normalized)
    .map(rowToFact);
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
    // Kept in lockstep with `text` on every write that changes it -- see factText.ts's own comment
    // on why a stale hash is a silent-miss bug, not a cosmetic one.
    sets.push("text_hash = ?");
    params.push(hashFactText(patch.text.trim()));
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
  if (patch.scopeRepo !== undefined) {
    sets.push("scope_repo = ?");
    params.push(patch.scopeRepo);
  }
  if (patch.captureRoot !== undefined) {
    sets.push("capture_root = ?");
    params.push(patch.captureRoot);
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
        replaceFactTermsInternal(db, id, extractFacets(patch.text.trim()), false);
        // Embedding describes `facts.text` too, and for the same reason cannot be left in place: a
        // vector computed from the old text is a stale claim about the new one, not a missing
        // embedding -- and unlike the terms above, nothing here can cheaply recompute it (that needs
        // a network call to the configured embeddings endpoint, which an edit transaction must not
        // make). Nulling it instead routes the fact back through `listFactsNeedingEmbedding`, so the
        // next plain `mem embed` backfills it against the current text. Only when the patch doesn't
        // already carry a fresher `embedding` of its own (none of today's callers pass both `text`
        // and `embedding` in one patch, but this keeps the precedence unambiguous if one ever does).
        if (patch.embedding === undefined) {
          db.prepare("UPDATE facts SET embedding = NULL WHERE id = ?").run(id);
        }
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

/**
 * Increments `facts.sightings` for `factId` by one -- the counter `mem review`'s pending bucket
 * sorts by (`capture.ts`'s `recordSighting`, called when a scan/import candidate restates a
 * `pending` fact instead of writing a new one). Does not bump the write epoch, for the same reason
 * writes to `sources` do not (see this module's doc comment): a sighting count is audit-adjacent
 * evidence for a human reading the pending bucket, never part of the ground-truth surface the epoch
 * exists to guard -- a `pending` fact is excluded from `--hint-format` output whether it has been
 * sighted once or a hundred times.
 */
export function incrementSightings(db: Db, factId: string): void {
  db.prepare("UPDATE facts SET sightings = sightings + 1 WHERE id = ?").run(factId);
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

interface FactLinkRow {
  fact_id_a: string;
  fact_id_b: string;
  similarity: number;
  discovered_at: string;
}

function rowToFactLink(row: FactLinkRow): FactLink {
  return { factIdA: row.fact_id_a, factIdB: row.fact_id_b, similarity: row.similarity, discoveredAt: row.discovered_at };
}

/**
 * Writes (or refreshes) one discovered relation between two facts -- `mem consolidate --related
 * --apply`'s only writer. Canonicalizes the pair order itself (`factIdA <= factIdB` lexicographically)
 * regardless of which side the caller names first, so `fact_links`'s `(fact_id_a, fact_id_b)` primary
 * key sees exactly one row per unordered pair no matter how many times either ordering is offered --
 * a caller cannot store a pair twice by swapping the arguments. Re-running the pass over the same
 * pair updates `similarity`/`discoveredAt` in place rather than erroring, since a link is a current
 * observation, not a history to preserve. Does not bump the write epoch, for the same reason writes
 * to `sources` do not (see this module's doc comment): a discovered relation is audit-adjacent
 * evidence about the store's shape, never part of the ground-truth surface the epoch exists to guard.
 */
export function upsertFactLink(db: Db, factIdA: string, factIdB: string, similarity: number, discoveredAt: string): FactLink {
  const [a, b] = factIdA <= factIdB ? [factIdA, factIdB] : [factIdB, factIdA];
  db.prepare(
    `INSERT INTO fact_links (fact_id_a, fact_id_b, similarity, discovered_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (fact_id_a, fact_id_b) DO UPDATE SET similarity = excluded.similarity, discovered_at = excluded.discovered_at`
  ).run(a, b, similarity, discoveredAt);
  return { factIdA: a, factIdB: b, similarity, discoveredAt };
}

/** Every discovered relation in the store, canonical pair order, then newest first. */
export function listFactLinks(db: Db): FactLink[] {
  return db
    .prepare<[], FactLinkRow>("SELECT * FROM fact_links ORDER BY discovered_at DESC, fact_id_a, fact_id_b")
    .all()
    .map(rowToFactLink);
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
  const tx = db.transaction(() => {
    for (const factId of factIds) {
      insert.run(factId, sessionId, atIso);
    }
    // Same transaction as the log rows it summarizes, so the two can never disagree about whether
    // a fact was ever surfaced.
    markFactsSurfaced(db, factIds, atIso);
  });
  tx.immediate();
}

/**
 * Stamps `facts.last_surfaced_at` for `factIds` at `atIso`, independent of `recall_log` -- a fact
 * can be surfaced (and so ineligible for stale-supersede) without a `recall_log` row existing for
 * it, e.g. a caller with no session id to log against. Monotonic (`MAX`) rather than
 * last-write-wins: a backdated replay must not walk the mark backwards.
 */
export function markFactsSurfaced(db: Db, factIds: readonly string[], atIso: string): void {
  if (factIds.length === 0) {
    return;
  }
  const mark = db.prepare(
    "UPDATE facts SET last_surfaced_at = MAX(COALESCE(last_surfaced_at, ''), ?) WHERE id = ?"
  );
  const tx = db.transaction(() => {
    for (const factId of factIds) {
      mark.run(atIso, factId);
    }
  });
  tx.immediate();
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
 * Bumps the write epoch when it actually stamps a row. The epoch exists so a token-goat-side cache
 * can never serve recall output the store has already moved past, and a usefulness stamp feeds the
 * usefulness rank list -- so a cached response computed before the stamp is stale in the only sense
 * the epoch is meant to catch, even though no fact's text, status, or freshness changed.
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
    if (updated > 0) {
      bumpEpoch(db);
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
 * Bumps the write epoch. Terms are derived from `facts.text` and change nothing about a fact's
 * content, status, or freshness, but they decide which `--entity` queries reach it and feed the
 * entity-overlap rank list -- so recall output changes underneath any cache keyed on the epoch.
 *
 * Always stamps `terms_checked_at`, whether or not `facets` yields anything to insert: that is what
 * lets `listFactsNeedingTerms` and `countFactsWithTerms` tell "never extracted" apart from
 * "extracted, text is entirely stopwords" -- both look like zero rows in `fact_terms` on their own.
 */
export function replaceFactTerms(db: Db, factId: string, facets: FactFacets): void {
  replaceFactTermsInternal(db, factId, facets, true);
}

/**
 * The term-replacement body, with the epoch bump made optional.
 *
 * `insertFact` and `updateFact` re-extract terms inside their own write transaction, which has
 * already bumped the epoch for the fact write itself. A second bump there would be double-counting
 * one logical write, and the `facts.epoch` stamp those callers wrote would no longer equal the
 * store epoch they committed under. Only a standalone term write (`mem facets`) owns the bump.
 */
function replaceFactTermsInternal(db: Db, factId: string, facets: FactFacets, bump: boolean): void {
  const remove = db.prepare("DELETE FROM fact_terms WHERE fact_id = ?");
  const insert = db.prepare("INSERT INTO fact_terms (fact_id, term, term_key, kind) VALUES (?, ?, ?, ?)");
  const markChecked = db.prepare("UPDATE facts SET terms_checked_at = ? WHERE id = ?");
  const tx = db.transaction((): void => {
    remove.run(factId);
    markChecked.run(new Date().toISOString(), factId);
    for (const entity of facets.entities) {
      insert.run(factId, entity, normalizeTermKey(entity), "entity");
    }
    for (const topic of facets.topics) {
      insert.run(factId, topic, normalizeTermKey(topic), "topic");
    }
    if (bump) {
      bumpEpoch(db);
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
 * For every other fact sharing at least one normalized term key with `factId`, how many entity keys
 * and how many topic keys it shares -- the raw counts `mem show --related` weights into a single
 * score. The weighting itself (an entity match outranking a topic match) is a ranking judgment, not
 * a storage fact, so it stays with the caller rather than living here.
 *
 * Self-joins `fact_terms` on `(term_key, kind)`, both sides served by `idx_fact_terms_lookup`: one
 * indexed scan per term key `factId` carries, not a table scan.
 */
export interface SharedTermCounts {
  readonly entity: number;
  readonly topic: number;
}

export function getSharedTermCounts(db: Db, factId: string): Map<string, SharedTermCounts> {
  const rows = db
    .prepare<[string], { fact_id: string; kind: FactTermKind; cnt: number }>(
      `SELECT ft2.fact_id AS fact_id, ft2.kind AS kind, COUNT(*) AS cnt
       FROM fact_terms ft1
       JOIN fact_terms ft2 ON ft1.term_key = ft2.term_key AND ft1.kind = ft2.kind
       WHERE ft1.fact_id = ? AND ft2.fact_id != ft1.fact_id
       GROUP BY ft2.fact_id, ft2.kind`
    )
    .all(factId);
  const byFact = new Map<string, SharedTermCounts>();
  for (const row of rows) {
    const existing = byFact.get(row.fact_id) ?? { entity: 0, topic: 0 };
    byFact.set(row.fact_id, row.kind === "entity" ? { ...existing, entity: row.cnt } : { ...existing, topic: row.cnt });
  }
  return byFact;
}

/**
 * Every fact's entity lookup keys, for `RetrievalOptions.factEntityKeys`.
 *
 * One grouped read rather than a query per candidate, for the reason `getUsefulnessCounts` gives:
 * recall filters the whole store, so a per-fact round trip would land inside the `--hint-format`
 * seam's ~150ms budget. Topics are excluded -- `--entity` is an entity filter, and the topic facet
 * is already what BM25 ranks on.
 */
/**
 * How many of the query's own entities each fact carries: `fact_id` -> overlap count.
 *
 * Backs the entity rank list in `retrieval.ts`. Deliberately *not* built from
 * {@link getEntityKeysByFact}: that is a full scan of `fact_terms`, and its caller only pays for it
 * when `--entity` was passed. This runs on every recall, so the cost has to scale with the query
 * rather than with the store -- one indexed lookup per entity the query actually contains, against
 * `idx_fact_terms_lookup(term_key, kind)`.
 *
 * A query with no identifier in it therefore costs nothing and returns an empty map, which is also
 * the behaviour the ranking wants: no signal, no vote.
 */
export function getEntityOverlapForQuery(db: Db, query: string): Map<string, number> {
  const overlap = new Map<string, number>();
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return overlap;
  }
  // The same extractor that wrote these rows at capture time, so "does the query name this thing"
  // is asked in exactly the vocabulary the store answers in -- a second, looser parser here would
  // match rows the write path never creates.
  for (const entity of new Set(extractFacets(trimmed).entities.map(normalizeTermKey))) {
    for (const factId of listFactIdsForTerm(db, entity, "entity")) {
      overlap.set(factId, (overlap.get(factId) ?? 0) + 1);
    }
  }
  return overlap;
}

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
 * ones. "Needs extraction" is `terms_checked_at IS NULL`, not the absence of a `fact_terms` row: a
 * fact whose text is entirely stopwords legitimately extracts zero terms, and keying off row
 * absence would re-offer that fact on every run forever (`replaceFactTerms` stamps the column
 * whether or not it has anything to insert).
 */
export function listFactsNeedingTerms(db: Db, options: { readonly all?: boolean } = {}): Array<{ id: string; text: string }> {
  const where = options.all === true ? "" : "WHERE terms_checked_at IS NULL";
  return db
    .prepare<[], { id: string; text: string }>(`SELECT id, text FROM facts ${where} ORDER BY captured_at ASC, id ASC`)
    .all();
}

/** GC primitive: deletes recall-log rows surfaced before `beforeIso` (ISO 8601). Returns the number of rows deleted. */
/**
 * The population `mem consolidate --stale` proposes: `active` facts captured before `beforeIso`
 * that recall has gone unsurfaced on since `beforeIso` and nobody has ever marked useful, oldest
 * first.
 *
 * `pinned` facts are excluded by construction, not by a caller-side filter -- a pin is a standing
 * instruction that this fact matters regardless of whether it has been read yet. So are `pending`,
 * `contested`, and `superseded` facts: none of them is live ground truth, and each already has its
 * own resolution path (`mem review`, the retention pass).
 *
 * `COALESCE(last_surfaced_at, '') < beforeIso` is a *windowed* question -- "unsurfaced for at least
 * this long", not "never surfaced, ever" -- so a fact surfaced once, long before the window, is
 * eligible again once it goes quiet for the window's length. The empty-string floor treats a NULL
 * (never surfaced, or captured before the column existed) as older than any real timestamp. The
 * `recall_log` NOT EXISTS is windowed to the same cutoff for the matching reason: a fact whose
 * `last_surfaced_at` predates the column but was actually surfaced inside the rotation window still
 * has a live `recall_log` row saying so.
 *
 * The `used_at IS NOT NULL` half of that same NOT EXISTS is deliberately *not* windowed -- a fact
 * the user explicitly confirmed useful must not lose that protection just because the confirming
 * surfacing itself falls outside the stale window. This is bounded by `recall_log` retention, not
 * by this query: `mem epoch --gc` rotates rows past `surfaced_at` regardless of `used_at` (see
 * `deleteRecallLogOlderThan`), so a usefulness mark old enough to have been rotated away has no
 * surviving evidence here. When that happens the fact does not silently fall out of protection into
 * "propose immediately" -- it was surfaced too (every `used_at` row is also a surfacing), so
 * `last_surfaced_at` is still set to that same date and the COALESCE branch above governs it exactly
 * like any other surfaced-but-quiet fact. That is the intended end state rather than a gap worked
 * around: usefulness is a decaying signal everywhere it is read -- `getUsefulnessCounts` ranks from
 * these same rotating rows -- so granting it permanent retention in this one query would put it at
 * odds with every other consumer of the same evidence. Permanence has its own mechanism, `mem pin`,
 * which this query excludes by construction. A fact that must outlive its own recall history should
 * be pinned, not kept alive indefinitely by a confirmation no surviving row can still attest to.
 *
 * Keying on `captured_at` (never edited) rather than `status_changed_at` is deliberate: this pass
 * asks how long a fact has gone unread, and a fact that has never changed status has no
 * `status_changed_at` at all.
 */
export function listStaleUnsurfacedFacts(db: Db, beforeIso: string): Fact[] {
  const rows = db
    .prepare<[string, string, string], FactRow>(
      `SELECT * FROM facts AS f
       WHERE f.status = 'active'
         AND f.captured_at < ?
         AND COALESCE(f.last_surfaced_at, '') < ?
         AND NOT EXISTS (
           SELECT 1 FROM recall_log AS r
           WHERE r.fact_id = f.id
             AND (r.surfaced_at >= ? OR r.used_at IS NOT NULL)
         )
       ORDER BY f.captured_at ASC, f.id ASC`
    )
    .all(beforeIso, beforeIso, beforeIso);
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
 * see `planEmbeddingRanking` in embeddings.ts, which is the reason this exists. Also read by
 * cli.ts (doctor, export, embed status), exportImport.ts (import compatibility), and
 * integration-seam.ts (recall ranking), so it is not that function's only consumer.
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

/**
 * Counts facts that currently carry an embedding vector.
 *
 * `excludeSuperseded` narrows this to the same scope `listFactsNeedingEmbedding` backfills:
 * without it, `mem doctor`'s coverage line pairs a numerator that (rightly) never counts a
 * superseded fact's vector against a denominator that (wrongly) counts the fact itself, so a
 * store that has ever superseded an unembedded fact could never show 100% coverage -- no command
 * would ever close that gap. Other callers check only "does any vector exist at all" and want the
 * unnarrowed count.
 */
export function countEmbeddedFacts(db: Db, options: { readonly excludeSuperseded?: boolean } = {}): number {
  const where = options.excludeSuperseded === true
    ? "WHERE embedding IS NOT NULL AND status != 'superseded'"
    : "WHERE embedding IS NOT NULL";
  return db.prepare<[], { count: number }>(`SELECT COUNT(*) AS count FROM facts ${where}`).get()?.count ?? 0;
}

/**
 * Counts facts that have been through facet extraction, for `mem doctor`'s coverage line.
 *
 * `terms_checked_at IS NOT NULL`, not "carries a `fact_terms` row": a fact whose text is entirely
 * stopwords is checked and legitimately has no row, and counting only rows would report it as an
 * unclosable shortfall (see `listFactsNeedingTerms`).
 */
export function countFactsWithTerms(db: Db): number {
  return db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM facts WHERE terms_checked_at IS NOT NULL").get()?.count ?? 0;
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
  const where = options.all === true ? "WHERE status != 'superseded'" : "WHERE embedding IS NULL AND status != 'superseded'";
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
