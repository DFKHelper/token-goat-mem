/**
 * Hybrid retrieval (design plan Section 3 "Retrieval", P8, review S10).
 *
 * Pipeline: BM25 lexical search always runs (a small in-process implementation, no external search
 * engine dependency). Embedding search is optional and pluggable — a caller may inject an
 * `EmbeddingBackend` (or a lazy loader for one); if none is given, or the injected backend fails or
 * times out, embedding search is skipped entirely and the BM25 ranking stands alone. When both
 * signals are available they are fused via Reciprocal Rank Fusion (RRF).
 *
 * This module never imports or dynamically loads any concrete embedding package itself — the design
 * doc names no specific model/package/local-cache path for the "local ONNX/transformers.js-class
 * backend", and mem is local-only, zero-network by design (P7, Section 3). Owning that discovery here
 * would mean either inventing unspecified architecture or risking a network-capable dependency being
 * pulled in implicitly. Instead, `EmbeddingBackend` is a narrow interface a caller plugs in; this
 * module only ever calls into an already-resolved (or explicitly lazy) backend under a hard timeout.
 *
 * After ranking, every candidate goes through a correctness gate (P1/P3/P4/P8) before it can be
 * surfaced:
 *   1. Contradiction re-check (contradiction.ts) — recomputed fresh against the live candidate pool,
 *      never trusting a possibly-stale `status` column alone.
 *   2. Freshness re-check (anchors.ts) — the fact's anchor is re-evaluated against `root` right now.
 *   3. Two-gate trust classification (P8) — relevance (from ranking) decides what is considered;
 *      trust (provenance x freshness x contradiction x, for preferences, age-decay) decides how it
 *      may be surfaced: ground-truth, hint-to-verify, or withheld.
 *   4. A self-caveating `display` string is generated per fact so a consumer can never present a
 *      hint as unconditional truth by accident (S3) — the caveat travels with the payload.
 */

import { evaluateAnchor, type AnchorVerdict } from "./anchors.js";
import { resolveContradictions } from "./contradiction.js";
import type { Fact, FactKind, FactScope, FactStatus } from "./types.js";

const MS_PER_DAY = 86_400_000;

/**
 * A local embedding backend, injected by the caller. `embed` may be sync or async; implementations
 * are expected to run fully offline (no network) — mem's zero-network guarantee is a property of
 * what the caller chooses to inject, not something this module can enforce, so callers building a
 * concrete backend must honor it themselves.
 *
 * TODO(deferred, spec'd): no concrete embedding backend ships in v1 — the CLI never wires one, so
 * retrieval runs BM25-only in practice. This is deliberate, per the locked "BM25-first, embeddings
 * optional" decision: a real local ONNX/transformers.js-class provider is a heavyweight
 * native/model dependency the design plan names no spec for (model, cache path, license), and a
 * half-wired one risks pulling a network-capable package into a zero-network tool (P7) or blocking
 * `remember`/`recall` when the model is unavailable. When one is added, it must be injected
 * through this interface (lazy, optional, timeout-bounded — the fail-open behavior is already
 * enforced by tests/unit/retrieval.test.ts), never imported eagerly by this module.
 */
export interface EmbeddingBackend {
  embed(text: string): Promise<Float32Array> | Float32Array;
}

/** A lazy loader for an embedding backend. Invoked at most once per `retrieve` call. */
export type EmbeddingBackendLoader = () => Promise<EmbeddingBackend | null> | EmbeddingBackend | null;

export type TrustLevel = "ground-truth" | "hint" | "withheld";

/** Contradiction outcome re-derived at read time (never taken on faith from a stored status alone). */
export type ContradictionOutcome = "none" | "superseded" | "contested";

export interface RetrievalOptions {
  /** Free-text query. Pass `""` to browse/filter without lexical ranking (all candidates tie at score 0). */
  readonly query: string;
  /** Explicit project root anchors are evaluated against (Section 3 — never ambient cwd). */
  readonly root: string;
  readonly kind?: FactKind;
  readonly subject?: string;
  readonly scope?: FactScope;
  /** Exclude facts captured more than this many days ago. */
  readonly ageDays?: number;
  /** Cap on the number of results returned, applied after ranking and gating. */
  readonly limit?: number;
  /** When true, drop every `trust === "withheld"` result (contested/pending/anchor-contradicted) — the `--hint-format` contract (Section 4). */
  readonly hintFormat?: boolean;
  /** Injectable clock, for deterministic freshness/decay tests. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Optional pluggable embedding backend or lazy loader for one. Omitted = BM25-only. */
  readonly embeddingBackend?: EmbeddingBackend | EmbeddingBackendLoader;
  /** Hard budget for loading/calling the embedding backend. Default `DEFAULT_EMBEDDING_TIMEOUT_MS`. */
  readonly embeddingTimeoutMs?: number;
  /** Hard overall budget for anchor re-evaluation across all candidates. Default `DEFAULT_ANCHOR_TIME_BUDGET_MS`. */
  readonly anchorTimeBudgetMs?: number;
  /**
   * When `false`, `display` omits its trailing `" — <follow-up command>"` suffix (the "CTA"),
   * emitting only the bare caveated fact text. Defaults to `true` (today's exact display format,
   * unchanged). integration-seam.ts's TGMEM/2 wire format sets this `false` and instead emits one
   * shared footer line summarizing follow-up commands once, rather than repeating the same CTA on
   * every line (see integration-seam.ts's version-2 grammar doc comment).
   */
  readonly includeDisplayCta?: boolean;
  /**
   * Controls `display`'s verbosity. `"full"` (default) is today's exact format: the full-word kind
   * label (`decision`, `correction`; `pref`/`fact` were already short) plus, when `includeDisplayCta`
   * allows it, the trailing CTA. `"terse"` drops the CTA unconditionally (the caller is assumed to
   * already know the follow-up commands) and shortens every kind label to its 4-character wire tag
   * (`pref`/`dec`/`fact`/`corr`, matching integration-seam.ts's `PROTOCOL_KIND_TAG`) for a
   * single-line-per-fact recall a human can scan quickly.
   */
  readonly hintStyle?: "full" | "terse";
}

export interface RetrievedFact {
  readonly fact: Fact;
  readonly score: number;
  readonly freshness: AnchorVerdict;
  readonly contradiction: ContradictionOutcome;
  readonly trust: TrustLevel;
  /** Ready-to-surface, self-caveating string. Consumers should present this verbatim (S3). */
  readonly display: string;
}

/**
 * Default overall anchor-evaluation budget for one `retrieve` call. Kept well under the token-goat
 * seam's ~150ms hard timeout (Section 4) so anchor re-validation never becomes the reason a
 * `--hint-format` call blows its budget; the remainder is left for BM25/ranking/formatting.
 */
export const DEFAULT_ANCHOR_TIME_BUDGET_MS = 100;

/** Default budget for loading and calling an injected embedding backend before giving up on it. */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 200;

/** Preferences only decay (Section 6) — a confidence half-life, in days, before a preference stops being ground-truth-eligible on freshness alone. */
export const PREFERENCE_CONFIDENCE_HALF_LIFE_DAYS = 180;

/** Below this decayed confidence, an otherwise-affirmed preference downgrades from ground-truth to hint (Section 6). */
export const GROUND_TRUTH_CONFIDENCE_FLOOR = 0.5;

/** Preferences/corrections are recalled aggressively (P6) — a small ranking boost relative to precision-biased decisions/facts. */
export const AGGRESSIVE_RECALL_BOOST = 1.15;

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const RRF_K = 60;

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length > 0);
}

/**
 * Scores each document against `query` using BM25 (Robertson/Sparck-Jones, `+1`-smoothed IDF so
 * common terms never produce a negative score). Corpus statistics (document frequency, average
 * length) are computed over `docs` itself, i.e. the already-filtered candidate pool — the searchable
 * universe for this call, not the whole store. Each document's text is `text` plus, if present,
 * `subject`/`value`, so structured facts also match on their normalized key/value.
 */
export function computeBm25Scores(docs: readonly Fact[], query: string): Map<string, number> {
  const scores = new Map<string, number>();
  const queryTerms = [...new Set(tokenize(query))];
  if (docs.length === 0 || queryTerms.length === 0) {
    for (const doc of docs) {
      scores.set(doc.id, 0);
    }
    return scores;
  }

  const docTokens = new Map<string, string[]>();
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;

  for (const doc of docs) {
    const tokens = tokenize(`${doc.text} ${doc.subject ?? ""} ${doc.value ?? ""}`);
    docTokens.set(doc.id, tokens);
    totalLength += tokens.length;
    for (const term of new Set(tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const n = docs.length;
  const avgDocLength = totalLength / n || 1;

  for (const doc of docs) {
    const tokens = docTokens.get(doc.id) ?? [];
    const termFrequency = new Map<string, number>();
    for (const token of tokens) {
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
    }
    const docLength = tokens.length;
    let score = 0;
    for (const term of queryTerms) {
      const tf = termFrequency.get(term);
      if (tf === undefined) {
        continue;
      }
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgDocLength));
      score += idf * ((tf * (BM25_K1 + 1)) / denom);
    }
    scores.set(doc.id, score);
  }

  return scores;
}

/** Cosine similarity between two vectors, using the shorter length if they differ. Returns 0 for a zero vector. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Fuses multiple rank-ordered id lists via Reciprocal Rank Fusion: `score(d) = sum(1 / (k + rank))`
 * over every list `d` appears in (1-indexed rank). An id missing from a list simply contributes
 * nothing from that list — lists need not cover the same ids.
 */
export function reciprocalRankFusion(rankLists: ReadonlyArray<readonly string[]>, k: number = RRF_K): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of rankLists) {
    list.forEach((id, index) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return fused;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((settle, fail) => {
    const timer = setTimeout(() => fail(new Error("embedding backend timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        settle(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        fail(error);
      },
    );
  });
}

async function resolveEmbeddingBackend(
  source: EmbeddingBackend | EmbeddingBackendLoader | undefined,
  timeoutMs: number,
): Promise<EmbeddingBackend | null> {
  if (source === undefined) {
    return null;
  }
  try {
    const resolved = typeof source === "function" ? await withTimeout(Promise.resolve(source()), timeoutMs) : source;
    return resolved ?? null;
  } catch {
    return null;
  }
}

async function embedQuery(backend: EmbeddingBackend, query: string, timeoutMs: number): Promise<Float32Array | null> {
  try {
    const vector = await withTimeout(Promise.resolve(backend.embed(query)), timeoutMs);
    return vector ?? null;
  } catch {
    return null;
  }
}

function contradictionFromStatus(status: FactStatus): ContradictionOutcome {
  if (status === "superseded") {
    return "superseded";
  }
  if (status === "contested") {
    return "contested";
  }
  return "none";
}

function decayedConfidence(fact: Fact, now: Date): number {
  if (fact.kind !== "preference" || fact.status === "pinned") {
    return fact.confidence;
  }
  const capturedAtMs = Date.parse(fact.captured_at);
  const ageDays = (now.getTime() - capturedAtMs) / MS_PER_DAY;
  if (!Number.isFinite(ageDays) || ageDays <= 0) {
    return fact.confidence;
  }
  return fact.confidence * Math.pow(0.5, ageDays / PREFERENCE_CONFIDENCE_HALF_LIFE_DAYS);
}

/** Section 6: only preferences decay, and only from ground-truth to hint — never to a silent deletion. */
function isDecayedBelowGroundTruth(fact: Fact, now: Date): boolean {
  return fact.kind === "preference" && fact.status !== "pinned" && decayedConfidence(fact, now) < GROUND_TRUTH_CONFIDENCE_FLOOR;
}

/**
 * Two-gate trust classification (P8). Relevance already decided this fact was worth considering;
 * this decides how it may be surfaced.
 *
 * Precedence spec (normative): when the three trust signals -- lifecycle `status`/contradiction
 * outcome, anchor `freshness`, and decay-adjusted `confidence` -- conflict, they are consulted in
 * this strict order, and an earlier rule always wins over every later one:
 *
 *   1. status / contradiction (strongest): `status="pending"` (S9), or a contradiction outcome of
 *      `superseded`/`contested` (P4) => "withheld". No freshness verdict or confidence can rescue a
 *      fact the lifecycle/dedup layer has excluded. (`superseded` facts are also filtered out of
 *      the candidate pool by `retrieve()` before this function runs; the check here is defensive
 *      for any direct caller.)
 *   2. anchor freshness `contradicted` (P3/S1) => "withheld" -- including for `pinned` facts
 *      (S8: a pin exempts a fact from time-decay only, never from anchor suppression).
 *   3. anchor freshness `affirmed` => "ground-truth", unless the decay-adjusted confidence of a
 *      non-pinned preference has fallen below `GROUND_TRUTH_CONFIDENCE_FLOOR` (Section 6), in
 *      which case => "hint". Confidence/decay is the weakest signal: it can only ever downgrade an
 *      affirmed fact to a hint -- it never withholds, and never upgrades anything.
 *   4. anchor freshness `unverified` (the fallthrough) => "hint" regardless of confidence: a fact
 *      whose proposition cannot currently be confirmed is never ground truth, no matter how
 *      confident (P1/P3).
 *
 * `buildDisplay` mirrors this exact precedence order when choosing its caveat wording, so the
 * trust level and the self-caveating display string can never disagree about which signal won.
 */
function classifyTrust(fact: Fact, freshness: AnchorVerdict, contradiction: ContradictionOutcome, now: Date): TrustLevel {
  if (fact.status === "pending" || contradiction !== "none") {
    return "withheld";
  }
  if (freshness === "contradicted") {
    return "withheld";
  }
  if (freshness === "affirmed") {
    return isDecayedBelowGroundTruth(fact, now) ? "hint" : "ground-truth";
  }
  return "hint";
}

const KIND_LABEL: Record<FactKind, string> = {
  preference: "pref",
  decision: "decision",
  fact: "fact",
  correction: "correction",
};

/** `hintStyle: "terse"`'s shortest-unambiguous-label set, matching integration-seam.ts's wire-format `PROTOCOL_KIND_TAG`. */
const TERSE_KIND_LABEL: Record<FactKind, string> = {
  preference: "pref",
  decision: "dec",
  fact: "fact",
  correction: "corr",
};

/**
 * Builds the self-caveating `display` string for a fact (S3). Preferences and corrections always
 * carry a "(verify)"-style caveat regardless of trust level (P6 — under-recall is unsafe for these
 * kinds, so they are always presented as hints-to-verify, never as a bald assertion) — decisions and
 * facts, which the agent won't invent a wrong default for on a miss, are shown plainly once affirmed.
 */
function buildDisplay(
  fact: Fact,
  freshness: AnchorVerdict,
  contradiction: ContradictionOutcome,
  includeCta: boolean = true,
  terse: boolean = false
): string {
  const label = terse ? TERSE_KIND_LABEL[fact.kind] : KIND_LABEL[fact.kind];
  const showCommand = `mem show ${fact.id}`;
  const withCta = (body: string, cta: string): string => (includeCta ? `${body} — ${cta}` : body);

  if (fact.status === "pending") {
    return withCta(`${label} (pending, unconfirmed): ${fact.text}`, "confirm via mem review");
  }
  if (contradiction === "superseded") {
    return withCta(`${label} (superseded, excluded): ${fact.text}`, "see mem review for history");
  }
  if (contradiction === "contested") {
    return withCta(`${label} (contested, excluded): ${fact.text}`, "resolve via mem review");
  }
  if (freshness === "contradicted") {
    const tag = fact.status === "pinned" ? "pinned but contradicted" : "contradicted, excluded";
    return withCta(`${label} (${tag}): ${fact.text}`, "resolve via mem review");
  }

  const alwaysCaveat = fact.kind === "preference" || fact.kind === "correction";

  if (freshness === "affirmed") {
    return alwaysCaveat ? withCta(`stored ${label} (verify): ${fact.text}`, showCommand) : withCta(`${label}: ${fact.text}`, showCommand);
  }

  const month = fact.captured_at.slice(0, 7);
  return withCta(`stored ${label} (unverified, ${month}): ${fact.text}`, `verify; ${showCommand}`);
}

function applyKindBoost(fact: Fact, score: number): number {
  return fact.kind === "preference" || fact.kind === "correction" ? score * AGGRESSIVE_RECALL_BOOST : score;
}

/**
 * Mirrors storage.ts's `normalizeSubject` (trim + lowercase) exactly. Duplicated rather than
 * imported: every stored `Fact.subject` already passed through storage.ts's normalization at
 * write time, but an `options.subject` filter value comes straight from a caller (e.g. the CLI's
 * raw `--subject` string) and is never normalized before reaching this module. Without this, a
 * naturally-cased `--subject Package-Manager` would silently match zero facts against a subject
 * stored as `"package-manager"` -- an exact `!==` comparison, no error, just an empty result.
 */
function normalizeSubjectForFilter(subject: string): string {
  return subject.trim().toLowerCase();
}

function matchesFilters(fact: Fact, options: RetrievalOptions, now: Date): boolean {
  if (options.kind !== undefined && fact.kind !== options.kind) {
    return false;
  }
  if (options.subject !== undefined && fact.subject !== normalizeSubjectForFilter(options.subject)) {
    return false;
  }
  if (options.scope !== undefined && fact.scope !== options.scope) {
    return false;
  }
  if (options.ageDays !== undefined) {
    const ageDays = (now.getTime() - Date.parse(fact.captured_at)) / MS_PER_DAY;
    if (!Number.isFinite(ageDays) || ageDays > options.ageDays) {
      return false;
    }
  }
  return true;
}

/**
 * Runs the full hybrid-retrieval + correctness-gate pipeline over `facts` and returns ranked,
 * trust-annotated, self-caveating results. `facts` may be the full store contents — this function
 * does its own status filtering (never surfacing `superseded` facts, recomputing contradictions
 * fresh) so callers do not need to pre-filter by status.
 */
export async function retrieve(facts: readonly Fact[], options: RetrievalOptions): Promise<RetrievedFact[]> {
  const now = options.now ?? new Date();
  const anchorDeadline = Date.now() + (options.anchorTimeBudgetMs ?? DEFAULT_ANCHOR_TIME_BUDGET_MS);

  // Superseded facts are excluded up front — "kept for audit, not surfaced" (P4) is unconditional,
  // unlike pending/contested which can still appear (caveated) outside --hint-format.
  const liveCandidates = facts.filter((fact) => fact.status !== "superseded");
  const { facts: resolved } = resolveContradictions(liveCandidates);
  const pool = resolved.filter((fact) => fact.status !== "superseded");

  const filtered = pool.filter((fact) => matchesFilters(fact, options, now));
  if (filtered.length === 0) {
    return [];
  }

  const bm25Scores = computeBm25Scores(filtered, options.query);
  const bm25Ranked = [...filtered].sort((a, b) => {
    const delta = (bm25Scores.get(b.id) ?? 0) - (bm25Scores.get(a.id) ?? 0);
    return delta !== 0 ? delta : b.captured_at.localeCompare(a.captured_at);
  });
  const bm25RankIds = bm25Ranked.map((fact) => fact.id);

  let embeddingRankIds: string[] = [];
  if (options.query.trim().length > 0) {
    const backend = await resolveEmbeddingBackend(options.embeddingBackend, options.embeddingTimeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS);
    if (backend !== null) {
      const embeddable = filtered.filter((fact): fact is Fact & { embedding: Float32Array } => fact.embedding !== null);
      if (embeddable.length > 0) {
        const queryVector = await embedQuery(backend, options.query, options.embeddingTimeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS);
        if (queryVector !== null) {
          const similarity = new Map<string, number>(embeddable.map((fact) => [fact.id, cosineSimilarity(queryVector, fact.embedding)]));
          embeddingRankIds = [...embeddable].sort((a, b) => (similarity.get(b.id) ?? -1) - (similarity.get(a.id) ?? -1)).map((fact) => fact.id);
        }
      }
    }
  }

  const fusedScores =
    embeddingRankIds.length > 0
      ? reciprocalRankFusion([bm25RankIds, embeddingRankIds])
      : new Map<string, number>(bm25RankIds.map((id) => [id, bm25Scores.get(id) ?? 0]));

  const results: RetrievedFact[] = filtered.map((fact) => {
    const freshness = evaluateAnchor(fact.anchor, options.root, anchorDeadline);
    const contradiction = contradictionFromStatus(fact.status);
    const trust = classifyTrust(fact, freshness, contradiction, now);
    return {
      fact,
      score: applyKindBoost(fact, fusedScores.get(fact.id) ?? 0),
      freshness,
      contradiction,
      trust,
      display: buildDisplay(
        fact,
        freshness,
        contradiction,
        (options.includeDisplayCta ?? true) && options.hintStyle !== "terse",
        options.hintStyle === "terse"
      ),
    };
  });

  const visible = options.hintFormat === true ? results.filter((result) => result.trust !== "withheld") : results;
  visible.sort((a, b) => {
    const delta = b.score - a.score;
    return delta !== 0 ? delta : b.fact.captured_at.localeCompare(a.fact.captured_at);
  });

  return options.limit !== undefined ? visible.slice(0, options.limit) : visible;
}
