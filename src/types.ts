/**
 * Shared domain types for token-goat-mem.
 *
 * Mirrors the `facts` table schema from the design plan (Section 3) and
 * AGENTS.md exactly, field-for-field, so DB row shapes and domain objects
 * stay in lockstep without a translation layer. Kept intentionally narrow:
 * only what current modules need. Extend here, don't duplicate elsewhere.
 */

/** The four fact categories the design distinguishes for recall bias (P6) and decay (Section 6). */
export type FactKind = "preference" | "decision" | "fact" | "correction";

/** Coarse applicability of a fact. Not a literal path — an enum bucket. */
export type FactScope = "global" | "project" | "path";

/**
 * Provenance of how a fact entered the store. `derived` facts (extracted from
 * file/tool content) are quarantined hardest per P7/S9 — never surfaced as
 * ground truth without explicit human confirmation.
 */
export type FactSourceType = "user" | "derived";

/**
 * Lifecycle status of a fact.
 * - `active` — normal, eligible for ground-truth surfacing.
 * - `pending` — suggested candidate, never auto-promoted (S9).
 * - `superseded` — lost a deterministic subject+value contradiction (P4); kept for audit, not surfaced.
 * - `contested` — ambiguous subject+value contradiction; withheld from ground truth entirely (P4).
 * - `pinned` — exempt from time-decay, still eligible for ground-truth surfacing, still subject to
 *   contradiction suppression (Section 6 / S8).
 *
 * NAMING — do not conflate `contested` with `contradicted`. They are near-synonymous words for two
 * entirely different mechanisms:
 * - `contested` is a *status* (this enum): two stored facts share a `subject`+scope with different
 *   `value`s and tied precedence — deterministic fact-vs-fact dedup (P4, src/contradiction.ts).
 * - `contradicted` is a *freshness verdict* (`FreshnessVerdict`, never stored in this column): one
 *   fact's own anchor predicate, re-evaluated against the live filesystem/git, positively denied
 *   its proposition — fact-vs-world re-verification (P3, src/anchors.ts).
 * A fact can be either, both, or neither; both independently exclude it from ground truth.
 */
export type FactStatus = "active" | "pending" | "superseded" | "contested" | "pinned";

/** A single durable memory record. Column order matches the design plan's `facts` table listing. */
export interface Fact {
  readonly id: string;
  readonly text: string;
  readonly kind: FactKind;
  /** Normalized contradiction-detection key (e.g. "package-manager"), or null for free-text facts. */
  readonly subject: string | null;
  /** Normalized value for `subject` (e.g. "pnpm"), or null when `subject` is null. */
  readonly value: string | null;
  readonly scope: FactScope;
  /**
   * Narrow addition (not in the design plan's literal `facts` column list): which project/path a
   * `scope="project"|"path"` fact is bound to. Without this, scope cannot be resolved against a
   * caller-supplied root/context-file at query time. Optional so existing `Fact` object literals
   * that predate this field keep typechecking; readers should treat a missing value the same as
   * `null`. `null`/absent for `scope="global"`. An absolute project root directory for
   * `scope="project"`. An absolute file or directory path for `scope="path"`.
   */
  readonly scopeRoot?: string | null;
  readonly source_type: FactSourceType;
  /** Reference to the originating conversation/message, or null if unavailable. */
  readonly source_ref: string | null;
  /** ISO 8601 timestamp string. Lexically comparable because of the fixed format. */
  readonly captured_at: string;
  /** Read-only filesystem/git predicate string (Section 3), or null if the fact has no anchor. */
  readonly anchor: string | null;
  readonly status: FactStatus;
  /** Confidence in [0, 1]. */
  readonly confidence: number;
  /** Embedding vector for hybrid retrieval, or null when embeddings are unavailable (BM25-only mode). */
  readonly embedding: Float32Array | null;
}

/**
 * Three-valued anchor verdict (design principle P3, review finding S1).
 * Produced by evaluating a fact's `anchor` predicate against a root
 * (see src/anchors.ts). Only `affirmed` is ground truth; `unverified` means
 * the anchor could not confirm or deny the proposition (no anchor, missing
 * file, unparseable predicate, non-git root, etc.) and the fact should
 * surface only as a hint-to-verify; `contradicted` means the anchor
 * positively denied the proposition and the fact must be suppressed from
 * ground-truth surfacing and flagged in `review`.
 *
 * NAMING — `contradicted` (this verdict, computed fresh per query, never persisted) is a different
 * mechanism from the persisted `contested` status: see the note on `FactStatus` above.
 */
export type FreshnessVerdict = "affirmed" | "unverified" | "contradicted";

/**
 * Fields required/allowed to insert a new fact via storage.insertFact
 * (src/storage.ts). `id` is assigned by storage (a fresh `crypto.randomUUID()`,
 * matching the `facts.id TEXT PRIMARY KEY` column owned by src/db.ts).
 * `captured_at` defaults to `new Date().toISOString()`, `status` defaults to
 * `'active'`, and `confidence` defaults to `1.0` when omitted. Field names and
 * casing mirror `Fact` exactly (including the snake_case of `source_type`,
 * `source_ref`, and `captured_at`) so a `Fact` minus `id` is structurally a
 * `NewFact`.
 */
export interface NewFact {
  text: string;
  kind: FactKind;
  scope: FactScope;
  source_type: FactSourceType;
  subject?: string | null;
  value?: string | null;
  scopeRoot?: string | null;
  source_ref?: string | null;
  /** ISO 8601 timestamp. Defaults to `new Date().toISOString()` when omitted. */
  captured_at?: string;
  anchor?: string | null;
  /** Defaults to `'active'` when omitted. */
  status?: FactStatus;
  /** Defaults to `1.0` when omitted. */
  confidence?: number;
  embedding?: Float32Array | null;
}

/**
 * Mutable fields for storage.updateFact (src/storage.ts). Omitted fields are
 * left unchanged; an explicit `null` clears a nullable column. `kind`,
 * `source_type`, and `captured_at` are intentionally not editable here --
 * changing what a fact fundamentally *is* or when it was captured is a new
 * fact, not an edit (see design plan P4: contradiction resolution keys off
 * `captured_at` for precedence, so silently rewriting it would corrupt that
 * history).
 */
export interface FactUpdate {
  text?: string;
  subject?: string | null;
  value?: string | null;
  scope?: FactScope;
  scopeRoot?: string | null;
  anchor?: string | null;
  status?: FactStatus;
  confidence?: number;
  embedding?: Float32Array | null;
}

/** Filter predicate for storage.listFacts / storage.countFacts (src/storage.ts). All provided conditions are AND-ed together. */
export interface FactFilter {
  kind?: FactKind;
  subject?: string;
  scope?: FactScope;
  status?: FactStatus | readonly FactStatus[];
  /** ISO 8601 timestamp, exclusive upper bound on `captured_at`. */
  capturedBefore?: string;
  /** ISO 8601 timestamp, exclusive lower bound on `captured_at`. */
  capturedAfter?: string;
  limit?: number;
}

/**
 * An audit-only excerpt tied to a fact, per the design plan's `sources` table
 * (Section 3): "raw excerpts referenced by fact id ... for audit/provenance
 * only -- never a primary retrieval tier." Never the full source content --
 * callers are responsible for redacting/truncating before calling
 * storage.insertSource; storage.ts does not screen or truncate content itself
 * (secret screening is a capture-pipeline concern, design plan P7).
 */
export interface Source {
  readonly id: string;
  readonly factId: string;
  readonly excerpt: string;
  /** ISO 8601 timestamp. */
  readonly storedAt: string;
}

/** Fields required/allowed to insert a new source row via storage.insertSource. `storedAt` defaults to `new Date().toISOString()` when omitted. */
export interface NewSource {
  factId: string;
  excerpt: string;
  storedAt?: string;
}
