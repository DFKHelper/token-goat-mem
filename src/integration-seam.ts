/**
 * The token-goat integration seam (design plan Section 4).
 *
 * A one-directional, pull-based, pure-CLI contract. This module never
 * imports token-goat and never reads its state -- it only *shapes CLI
 * output* for a caller like token-goat to consume via `mem recall
 * --hint-format`. Context flows in only through the explicit function
 * arguments a caller chooses to pass (`root`, `contextFiles`), never by
 * reaching into another tool's files.
 *
 * The correctness gate itself (freshness re-validation, contradiction
 * re-check, two-gate trust classification, self-caveating display strings)
 * is owned by retrieval.ts (`retrieve()`) -- this module does not
 * re-implement it. What this module owns, specific to the hint-format
 * contract, is:
 *   - resolving which facts are in scope for the caller's `root` /
 *     `contextFiles` (retrieval.ts's `scope` filter is a single exact-match
 *     value; it has no notion of "which project/path does this root bind
 *     to", so pre-filtering the candidate pool by that binding before
 *     handing it to `retrieve()` happens here);
 *   - per-kind recall caps (design plan P6: preferences/corrections
 *     recalled aggressively, decisions/facts precision-biased) -- a
 *     seam-specific output-shaping policy, not a retrieval-ranking concern;
 *   - the versioned `TGMEM/<n>` wire format;
 *   - the self-imposed soft time budget and truncate-on-overrun behavior.
 *
 * Pre-filtering by root/contextFiles before calling `retrieve()` also keeps
 * contradiction detection correctly scoped: `FactScope` is a 3-value enum
 * ("global"/"project"/"path"), not root-aware by itself, so two facts with
 * the same `subject` + `scope="project"` but bound to *different* project
 * roots would otherwise look like the same contradiction bucket. Since this
 * module only ever passes `retrieve()` the facts already bound to the
 * caller's root/context-files, a same-subject fact from an unrelated
 * project is never in the candidate pool at all.
 *
 * Every public entry point here is safe to call with zero setup and MUST
 * NOT throw: any internal failure (missing DB, corrupt row, retrieval
 * exception, malformed home directory, etc.) resolves to an empty,
 * well-formed result so a caller's fail-open path never has to special-case
 * a thrown exception (design plan review S2/S3; CLAUDE.md "Fail-open if
 * binary missing, timeout, or parse error").
 */

import { resolve as resolvePath, sep } from "node:path";
import { clearAnchorCaches, type AnchorVerdict } from "./anchors.js";
import { loadAllowlist } from "./capture.js";
import {
  countEmbeddedFacts,
  getEmbeddingMeta,
  getEntityOverlapForQuery,
  getUsefulnessCounts,
  insertRecallLog,
  listSurfacedFactIds,
  markFactsSurfaced,
  openStorage,
  unpackEmbedding,
} from "./storage.js";
import { resolveDbPath } from "./db.js";
import { planEmbeddingRanking } from "./embeddings.js";
import { identityMatches } from "./projectIdentity.js";
import { retrieve, DEFAULT_EMBEDDING_TIMEOUT_MS, type EmbeddingBackend, type RetrievedFact } from "./retrieval.js";
import type { Fact, FactKind } from "./types.js";

/**
 * TGMEM wire-format grammar (normative for this producer; design plan Section 4).
 *
 * A `mem recall --hint-format` response is a UTF-8 text stream of LF-terminated
 * lines (ABNF, RFC 5234 core rules):
 *
 *   response      = header LF *( fact-line LF ) [ footer-line LF ]   ; footer-line is TGMEM/2+ only
 *   header        = "TGMEM/" version [ SEP delta-flag ]   ; version = 1*DIGIT
 *   delta-flag    = "delta=1"               ; present only on a response the caller
 *                                           ; explicitly requested with `--delta`
 *   fact-line     = tag SEP fresh-field SEP id-field SEP display-field
 *   tag           = "pref" / "dec" / "fact" / "corr"
 *   SEP           = 2%x20                   ; exactly two ASCII spaces
 *   fresh-field   = "fresh=" verdict
 *   verdict       = "affirmed" / "unverified" / "contradicted"
 *   id-field      = "id=" 1*VCHAR           ; the fact id (a UUID); never contains whitespace
 *   display-field = "display=" json-string  ; an RFC 8259 string literal produced by
 *                                           ; JSON.stringify: double-quoted, with all inner
 *                                           ; quotes/backslashes/control characters escaped,
 *                                           ; so it can never contain a raw LF or a bare `"`
 *
 * Consumer parsing rules (token-goat or any other consumer):
 * - An unknown/greater header version, missing binary, timeout, or total parse
 *   failure is treated as "no hints" -- fail-open to no-memory (Section 4).
 * - An individual line not matching the grammar is dropped (and may be
 *   logged), never guessed at.
 * - Field order is fixed. A consumer MAY parse a fact-line with the regex
 *   `^(pref|dec|fact|corr) {2}fresh=(affirmed|unverified|contradicted) {2}id=(\S+) {2}display=(".*")$`
 *   and `JSON.parse` the final capture group to recover `display`.
 * - The decoded `display` string MUST be surfaced verbatim: the trust caveat is
 *   part of the payload, not something the consumer reconstructs (review S3).
 * - `delta=1` on the header marks a response that deliberately omits facts the
 *   same session id was already sent *and* that do not match the current query
 *   (a fact matching the query is re-sent regardless). It appears only when the caller passed
 *   `--delta` with a session id: a consumer that did not ask for a delta never
 *   receives one, because a partial block is otherwise byte-indistinguishable
 *   from a complete one. Consumers parsing the header MAY match it with
 *   `^TGMEM\/(\d+)(?: {2}delta=1)?$`.
 *
 * Version policy: any change to line shape, field order, the separator, or the
 * escaping of `display` -- and any addition to the closed `tag`/`verdict` sets,
 * since consumers validate against them -- bumps the integer version. Consumers
 * treat versions they don't know as "no hints".
 *
 * `footer-text` is the one part explicitly outside that set, along with the
 * condition under which a footer-line appears at all. It is prose for a reader,
 * a consumer is told not to parse it, and bumping the version to reword a
 * sentence would cost every consumer *all* hints -- unknown version means no
 * hints -- to protect a line nobody is allowed to depend on.
 *
 * TGMEM/1 (superseded default, still fully supported -- see `protocolVersion`
 * below): every fact-line's `display` carries its own trailing
 * `" — <follow-up command>"` CTA (e.g. `— mem show <id>`, `— verify; mem show
 * <id>`, `— resolve via mem review`). No footer-line.
 *
 * TGMEM/2 (current default): this bumped because of two additive-but-
 * grammar-changing facts -- `display` no longer carries a per-line CTA
 * (bare caveated fact text only), and a response now ends with at most one
 * `footer-line` summarizing the available follow-up commands once, instead of
 * repeating one on every line:
 *
 *   footer-line   = "footer" SEP footer-text
 *   footer-text   = clause *("; " clause)
 *
 * A footer-line is emitted when the response has anything to follow up on:
 * at least one fact-line, results the caps did not send, or results withheld
 * from ground truth. An empty response over an empty review queue emits none.
 * `footer-text` is prose assembled from those counts -- informational text,
 * not something to `JSON.parse`, and deliberately outside the version-bump
 * set above: its wording and the condition under which it appears are both
 * free to change, because no consumer can parse it without violating that
 * contract. What is pinned is that a footer-line, when present, is last.
 *
 * The counts are there because their absence is unfalsifiable from the wire.
 * A capped payload is byte-indistinguishable from a complete one, and a
 * response with no fact-lines is byte-indistinguishable from a project with
 * no memory -- even when a review queue is filling every session behind it.
 * See `footerLineFor` for the two measured cases.
 */
export const TGMEM_PROTOCOL_VERSION = 2;

/** Header line every hint-format response starts with, for the default protocol version. */
export const TGMEM_HEADER = `TGMEM/${TGMEM_PROTOCOL_VERSION}`;

/** Literal prefix of every footer-line, including its `SEP`. */
const FOOTER_PREFIX = "footer  ";

/**
 * The clause naming how to inspect a fact-line. Exported because plain recall prints the same
 * sentence (src/cli.ts) and the two surfaces were separately-maintained copies of one string.
 */
export const FOLLOW_UP_SHOW_DETAIL = "mem show <id> for detail";

/** The clause naming how to resolve facts held back from ground truth. Shared with plain recall for the same reason. */
export const FOLLOW_UP_REVIEW = "mem review to resolve contested/pending";

/**
 * The footer-line for a response that has fact-lines and nothing else to disclose.
 *
 * Equal to `footerLineFor({ facts: 1, cut: 0, withheld: 0 })` -- pinned by a test so the constant and
 * the composer cannot drift.
 */
export const TGMEM_FOOTER_LINE = `${FOOTER_PREFIX}${FOLLOW_UP_SHOW_DETAIL}`;

/**
 * Composes the footer-line, or `undefined` when the response has nothing to say.
 *
 * Two failures this replaces, both measured against the built bundle:
 *
 *  1. **The review CTA was unconditional.** Every response carrying a fact-line advertised
 *     `mem review to resolve contested/pending`, including the overwhelmingly common case of a store
 *     with neither. A permanent CTA is not a signal -- a consumer that sees it on every call learns
 *     to ignore it, so it was loudest exactly where it meant nothing and indistinguishable from
 *     itself where it mattered.
 *  2. **What was held back was never disclosed.** Six matching decisions emitted four lines and this
 *     footer, with nothing saying two were cut; a store with three pending and nothing active
 *     emitted a bare `TGMEM/2` -- byte-identical to a project with no memory at all. That second
 *     shape is the steady state wherever `mem init` wired the `Stop` hook, since the hook fills the
 *     review queue every session and this is the only surface that runs unprompted.
 *
 * So the counts travel with the payload, and the footer now appears whenever there is something to
 * report -- including with zero fact-lines, which is the only way case 2 can be told from silence.
 * An empty response with an empty queue still emits no footer: nothing withheld, nothing to follow up.
 */
function footerLineFor(counts: { readonly facts: number; readonly cut: number; readonly withheld: number }): string | undefined {
  const clauses: string[] = [];
  if (counts.facts > 0) {
    clauses.push(FOLLOW_UP_SHOW_DETAIL);
  }
  if (counts.cut > 0) {
    clauses.push(`${counts.cut} more in scope, not sent`);
  }
  if (counts.withheld > 0) {
    clauses.push(`${counts.withheld} withheld; ${FOLLOW_UP_REVIEW}`);
  }
  return clauses.length > 0 ? `${FOOTER_PREFIX}${clauses.join("; ")}` : undefined;
}

function tgmemHeaderFor(protocolVersion: number, delta = false): string {
  return delta ? `TGMEM/${protocolVersion}  delta=1` : `TGMEM/${protocolVersion}`;
}

/**
 * Self-imposed soft time budget (ms) for a hint-format retrieval (design
 * plan Section 4: the token-goat side applies its own ~150ms hard timeout
 * around the whole subprocess call; this is mem's internal budget for the
 * work it does, so it degrades gracefully well before that outer timeout
 * would fire). Once exceeded, this module returns an empty hint set rather
 * than trusting an unbounded result set — "do not hang".
 *
 * It returns *empty* rather than a smaller slice because there is nowhere in
 * TGMEM/2 to say "this is partial". The grammar below is closed: an off-grammar
 * line is dropped by a conforming consumer, and adding one bumps the version,
 * at which point consumers that have not upgraded fail open to no hints at all.
 * So a reduced slice is indistinguishable on the wire from a complete one, and
 * a consumer told to surface `display` verbatim would present 2 of 12 facts as
 * though they were all of them -- the exact opposite of the self-caveating
 * guarantee this seam is documented to provide. An empty set is already this
 * module's shape for "I could not deliver" (see the catch in `buildHintFormat`),
 * and the consumer's documented fail-open path already handles it correctly.
 */
const RETRIEVAL_BUDGET_MS = 150;

/** Minimum budget handed to `retrieve()`'s own anchor-evaluation deadline, even if most of the soft budget is already spent. */
const MIN_ANCHOR_BUDGET_MS = 20;

/**
 * Fraction of the *remaining* soft budget an embedding round trip may spend, and the floor below
 * which it is not attempted at all.
 *
 * The soft budget is a promise to token-goat, and blowing it returns an empty hint set -- so a slow
 * endpoint must degrade this path to BM25 well before it costs the whole response, not after. A
 * share of what is left (rather than the flat `DEFAULT_EMBEDDING_TIMEOUT_MS` the CLI uses) is what
 * makes that automatic: the later in the budget the request would start, the less of it the request
 * is allowed to take, and under `MIN_EMBEDDING_BUDGET_MS` there is no longer enough time for a round
 * trip to be worth attempting. Anchors, gating, and formatting all still have to happen afterwards.
 */
const EMBEDDING_BUDGET_SHARE = 0.4;
const MIN_EMBEDDING_BUDGET_MS = 20;

/**
 * Kinds recalled aggressively (design plan P6): a miss lets the agent
 * silently fall back to a wrong invented default (e.g. "uses npm" three
 * months after a switch to pnpm), so these get a larger cap than
 * historical, precision-biased kinds.
 */
const AGGRESSIVE_KINDS: ReadonlySet<FactKind> = new Set<FactKind>(["preference", "correction"]);
const AGGRESSIVE_CAP = 8;
const PRECISION_CAP = 4;

/**
 * Wire slots held for `status="pinned"` facts, taken off the top before the kind caps below see the
 * ranked list at all.
 *
 * A pin is the one status whose whole meaning is "do not lose this", and until this reserve existed
 * it bought a fact nothing on the surface that runs unprompted. `retrieve()` sorts pinned facts
 * first *only in the zero-signal case* (src/retrieval.ts, and deliberately so -- letting a pin
 * outrank a lexical match would make `mem pin` a ranking cheat code). The moment a query carries
 * any signal, a pin is worth exactly zero: a hard user constraint that happens to share no terms
 * with the current prompt ranks below twelve facts that do, and falls off the payload entirely.
 * That is the failure this closes -- not a ranking preference, a floor. Pinned facts are what the
 * user said must always be in context, so a fixed number of them always are.
 *
 * Two, not more: the reserve is subtracted from nothing, so every slot here widens the payload
 * (2 + 8 + 4 = 14 lines at worst, against 12 before). Held to the smallest count that can carry a
 * pin on its own terms, because the cost lands on every prompt of every session and the caps above
 * were sized against a budget this sits on top of. A store with more pins than the reserve still
 * ranks the rest normally through the caps; nothing is hidden, and the footer discloses the
 * shortfall like any other cap.
 */
const PINNED_RESERVE = 2;

/**
 * The most fact lines one `--hint-format` block can carry: the reserve plus both kind caps, since
 * the three sets are disjoint by construction (`reserved`, then `contested` split by kind).
 *
 * Exported for `mem doctor`, which is the only place a user can find out that a store holding
 * hundreds of active facts still sends at most this many per recall. That ceiling is invisible
 * otherwise -- `mem list` shows everything, so a store whose useful facts sit outside the cap looks
 * healthy right up to the point someone wonders why a fact they can see is never in context.
 * Exporting the sum rather than the three parts keeps the arithmetic in one place: a doctor line
 * that re-added the caps itself would silently drift the day one of them changes.
 */
export const HINT_LINE_CEILING = PINNED_RESERVE + AGGRESSIVE_CAP + PRECISION_CAP;

/** Wire slots held for pinned facts, exported for the `mem doctor` line that compares a store's pin count against it. */
export const HINT_PINNED_RESERVE = PINNED_RESERVE;

/**
 * The recall limit this module passes to `retrieve()`, deliberately unbounded.
 *
 * `retrieve()` defaults to `DEFAULT_RECALL_LIMIT` (20) and applies it as a post-ranking slice of
 * the non-withheld set (src/retrieval.ts). That slice lands *before* the kind-split below, so the
 * split sees a top-20 rather than the full ranked list -- and a store whose top 20 all share one
 * kind starves the other cap completely. Measured: 300 preferences + 200 decisions emitted 8
 * preference lines and zero decision lines, in a payload byte-indistinguishable from one saying
 * this project has no decisions at all.
 *
 * The default limit could never bound this module's output anyway -- PINNED_RESERVE plus
 * AGGRESSIVE_CAP plus PRECISION_CAP is 14, already under 20 -- so it only ever distorted
 * composition. The caps above are what bounds the wire; the recall limit must not silently pre-empt
 * them. Costs nothing: the limit is a slice applied after scoring and anchor evaluation have
 * already run over every scoped fact.
 */
const HINT_FORMAT_RECALL_LIMIT = Number.MAX_SAFE_INTEGER;

/** Short wire-protocol tag for the leading column of a TGMEM line (distinct from the prose label embedded inside `display`, which retrieval.ts owns). */
const PROTOCOL_KIND_TAG: Record<FactKind, string> = {
  preference: "pref",
  decision: "dec",
  fact: "fact",
  correction: "corr",
};

export interface HintFormatOptions {
  /** Explicit project root anchors are evaluated against (design plan Section 3: never ambient cwd). */
  readonly root: string;
  /**
   * Free-text query threaded straight through to `retrieve()`'s `RetrievalOptions.query`. An
   * absent or empty query preserves the original recency-only behaviour exactly (all candidates
   * tie at BM25 score 0, so the final sort falls through to `captured_at` descending) -- this is
   * the path `SessionStart` uses and it must not change.
   */
  readonly query?: string | undefined;
  /** File paths (absolute, or relative to `root`) the caller is currently working with; matches `scope="path"` facts. */
  readonly contextFiles?: readonly string[] | undefined;
  /** Test/advanced override: explicit sqlite file path instead of the resolved mem home. */
  readonly dbPath?: string | undefined;
  /** Test override for "now", used for freshness/decay evaluation. */
  readonly now?: Date | undefined;
  /**
   * Which TGMEM wire-format version to emit. Defaults to `TGMEM_PROTOCOL_VERSION` (2). `1` is fully
   * supported for backward-compatible consumers (per-line CTA, no footer-line). Any value other than
   * exactly `1` is treated as the default version -- this function never throws on a bad value.
   */
  readonly protocolVersion?: 1 | 2 | undefined;
  /**
   * When `true`, sorts the emitted fact-lines by fact id (ascending) instead of the default
   * relevance/recency order -- a deterministic, reproducible ordering for callers (tests, snapshot
   * diffing) that need stable output across runs. Strictly additive: only changes ordering, never
   * which facts are included or how caps are applied.
   */
  readonly stable?: boolean | undefined;
  /** Threaded straight through to `retrieve()`'s `RetrievalOptions.hintStyle` -- see retrieval.ts's doc comment. Defaults to `"full"`. */
  readonly hintStyle?: "full" | "terse" | undefined;
  /**
   * Identifier of the consumer session this response is for (a hook's `session_id`). When set and
   * not `stable`, the ids of the facts actually emitted are recorded in `recall_log` best-effort --
   * a failure to log never fails the recall -- so a later `delta` call for the same session can
   * leave them out. `facts.last_surfaced_at` is stamped for the emitted ids regardless of whether
   * `sessionId` is set or `stable` is true (only `recall_log` cares about either): a fact does not
   * need a session id or a `recall_log` row to count as having been surfaced. Nothing is stamped
   * when the budget blew (an empty response surfaced nothing).
   */
  readonly sessionId?: string | undefined;
  /**
   * When `true`, omits every fact already logged as surfaced to `sessionId` *that does not match the
   * current query* (retrieval score of exactly zero), and marks the header `delta=1`. A fact that
   * scores non-zero is always sent, however many times this session has seen it: the host may have
   * compacted it out of context since, and a genuine hit belongs in context every time it is asked
   * for. A `status="pinned"` fact is never suppressed at all, whatever it scores -- see
   * `PINNED_RESERVE`. Requires `sessionId`; the CLI enforces that pairing, and this function treats `delta`
   * without a session id as a plain full response (it cannot know what was already sent). Applied
   * before the per-kind caps, so a session drains the next-best unseen facts rather than receiving
   * an empty block as soon as the top-ranked ones have all been sent once. The recall log itself
   * still records every emitted fact: it is an audit of what was sent, and the decision to re-send
   * lives here, not there.
   */
  readonly delta?: boolean | undefined;
  /**
   * Test override for the soft time budget in {@link RETRIEVAL_BUDGET_MS}, in milliseconds.
   *
   * Budget exhaustion is wall-clock-driven, which makes it the one behaviour here a test cannot
   * pin without control of the clock: a machine slow enough to blow the budget returns an empty
   * hint set, so an assertion about *which* facts came back becomes an assertion about how busy
   * the runner was. Passing a large value takes it out of the picture; passing 0 forces it, so
   * the exhausted path can be tested on purpose rather than only by accident on a slow machine.
   */
  readonly retrievalBudgetMs?: number | undefined;
}

export interface HintFormatResult {
  /** `"TGMEM/<n>"` */
  readonly header: string;
  /** Fully formatted, ready-to-print lines, one per surfaced fact. */
  readonly lines: readonly string[];
  /**
   * True if the soft time budget was exceeded, in which case `lines` is empty.
   *
   * The name is historical: this once selected a smaller set of caps, which put a partial
   * response on a wire that cannot express partialness. It now means "this response carries
   * nothing because the budget blew", and it exists for callers inside this process (the CLI
   * logs against it); on the wire the condition is expressed by the absence of fact-lines,
   * which the consumer's fail-open path already reads correctly.
   */
  readonly truncated: boolean;
  /** True when this response was filtered against the session's recall log (header carries `delta=1`). */
  readonly delta: boolean;
}

/** Resolves the effective protocol version for a call: exactly `1` selects TGMEM/1; anything else (including `undefined`) is the current default. Never throws on a bad value -- fail-open. */
function resolveProtocolVersion(requested: 1 | 2 | undefined): 1 | 2 {
  return requested === 1 ? 1 : TGMEM_PROTOCOL_VERSION;
}

/**
 * Builds the `--hint-format` payload for `mem recall --hint-format`. Never
 * throws: any internal failure resolves to an empty result so the caller's
 * fail-open path has nothing to special-case.
 */
export async function buildHintFormat(options: HintFormatOptions): Promise<HintFormatResult> {
  try {
    return await buildHintFormatUnsafe(options);
  } catch (error) {
    logWarning(`hint-format failed internally, returning empty hint set: ${errorMessage(error)}`);
    const delta = options.delta === true && typeof options.sessionId === "string" && options.sessionId.length > 0;
    return { header: tgmemHeaderFor(resolveProtocolVersion(options.protocolVersion), delta), lines: [], truncated: false, delta };
  }
}

async function buildHintFormatUnsafe(options: HintFormatOptions): Promise<HintFormatResult> {
  const start = Date.now();
  // Anchor verdicts are memoized for the lifetime of the process, which is exactly one query for the
  // `mem` CLI but unbounded for an embedder holding this module across calls -- there, a first-ever
  // verdict would be served forever no matter what changed on disk. One logical hint-format query is
  // the correct cache lifetime, so each call starts from a clean slate.
  clearAnchorCaches();
  const root = resolvePath(options.root);
  const contextFiles = (options.contextFiles ?? []).map((file) => resolvePath(root, file));
  const now = options.now ?? new Date();
  const protocolVersion = resolveProtocolVersion(options.protocolVersion);
  const stable = options.stable === true;
  const sessionId = typeof options.sessionId === "string" && options.sessionId.length > 0 ? options.sessionId : undefined;
  const delta = options.delta === true && sessionId !== undefined;

  // `openStorage`, not the bare `openDb`: this is a library seam an embedder can call against a
  // database mem's CLI has never opened, and `openDb` alone does not guarantee the storage-owned
  // columns (`epoch`, `status_changed_at`, `prior_status`) or the `sources`/`meta` tables exist.
  // Reading a fact through a connection that skipped `ensureStorageSchema` worked only by accident
  // of which columns this path happens to select today.
  const budgetMs = options.retrievalBudgetMs ?? RETRIEVAL_BUDGET_MS;
  const db = openStorage(options.dbPath ?? resolveDbPath());
  let allFacts: Fact[];
  let alreadySurfaced: ReadonlySet<string> = new Set();
  let usefulness: ReadonlyMap<string, { surfaced: number; used: number }>;
  let entityOverlap: ReadonlyMap<string, number>;
  // Decided before the fact query, not after, because it decides the query's row shape: an
  // embedding BLOB is a few kilobytes per fact, and pulling one store-wide inside a ~150ms budget
  // for a signal that is switched off on every install without a configured endpoint is exactly the
  // kind of cost that turns a healthy response into a truncated one. The share-of-remaining-budget
  // rule is EMBEDDING_BUDGET_SHARE's; below MIN_EMBEDDING_BUDGET_MS there is no longer enough time
  // for a round trip and the backend is not wired at all.
  const embeddingBudgetMs = Math.min(DEFAULT_EMBEDDING_TIMEOUT_MS, Math.floor((budgetMs - (Date.now() - start)) * EMBEDDING_BUDGET_SHARE));
  let embeddingBackend: EmbeddingBackend | null;
  try {
    // Silent either way: a stale-model store or an unreachable endpoint is a ranking-quality
    // matter, and this seam's contract is to fail open rather than editorialize on a wire protocol.
    // The unrecorded-vector check is passed here too, not skipped for budget: `mem recall` and this
    // path must reach the same ranking decision about the same store, and this seam's hand-maintained
    // divergences from the rest of the CLI are exactly how three columns went missing from its SELECT.
    // The cost is one `SELECT COUNT(*)` on the connection already open, and only when no model is
    // recorded at all -- cheaper than `getUsefulnessCounts` a few lines below, which this budget
    // already affords.
    const recordedMeta = getEmbeddingMeta(db) ?? null;
    embeddingBackend =
      embeddingBudgetMs >= MIN_EMBEDDING_BUDGET_MS
        ? planEmbeddingRanking(recordedMeta, process.env, { timeoutMs: embeddingBudgetMs }, recordedMeta === null && countEmbeddedFacts(db) > 0)
            .backend
        : null;
    allFacts = queryAllFacts(db, embeddingBackend !== null);
    // One grouped query on the connection already open, not a second `openStorage`: this path runs
    // inside a ~150ms hard budget and a second WAL open plus schema migration is the kind of cost
    // that turns a healthy response into a truncated one.
    usefulness = getUsefulnessCounts(db);
    // On the same open connection, for the same budget reason. One indexed lookup per identifier in
    // the query and none at all when it has none, so the ~150ms budget is safe: this is the path
    // where the ranking matters most, since an agent gets one shot at the context it is handed and
    // never sees the facts that ranked below the cap.
    entityOverlap = getEntityOverlapForQuery(db, options.query ?? "");
    if (delta) {
      alreadySurfaced = listSurfacedFactIds(db, sessionId);
    }
  } finally {
    db.close();
  }

  const scoped = allFacts.filter((fact) => isInScope(fact, root, contextFiles));

  const anchorTimeBudgetMs = Math.max(MIN_ANCHOR_BUDGET_MS, budgetMs - (Date.now() - start));
  const { results, withheldCount } = await retrieve(scoped, {
    query: options.query ?? "",
    root,
    hintFormat: true,
    limit: HINT_FORMAT_RECALL_LIMIT,
    // The `UserPromptSubmit` hook path (`mem recall --hint-format --hook-stdin`) sends every user
    // prompt through here as `query` -- the same screen-before-send invariant `retrieve()` applies
    // to that query has to see this project's own `.mem/allowlist`, not an empty one.
    secretAllowlist: loadAllowlist(root),
    now,
    anchorTimeBudgetMs,
    // TGMEM/2 drops the per-line CTA in favor of one shared footer line (see the grammar doc
    // comment above); TGMEM/1 keeps its original per-line CTA verbatim.
    includeDisplayCta: protocolVersion === 1,
    // Past `mem used` confirmations, fused as a third RRF rank list. Note this changes the meaning of
    // a zero score for the `--delta` filter below only in the direction that filter already tolerates
    // from the embedding list: once any auxiliary list is non-empty, fusion runs and no ranked fact
    // scores exactly 0, so a store with usefulness data suppresses less rather than suppressing
    // something it should have re-sent. On a store nobody has run `mem used` against -- every install
    // until someone does -- the list is empty and the scores are unchanged.
    usefulness,
    // The signal BM25 structurally cannot carry: stemming reduces `src/retrieval.ts` to
    // `src`/`retriev`/`ts`, so a fact naming that file scored no higher than one merely using those
    // three words. Empty whenever the query names no identifier, so it cannot vote on a query it has
    // no signal for.
    ...(entityOverlap.size > 0 ? { entityOverlap } : {}),
    ...(embeddingBackend !== null ? { embeddingBackend, embeddingTimeoutMs: embeddingBudgetMs } : {}),
    ...(options.hintStyle !== undefined ? { hintStyle: options.hintStyle } : {}),
  });

  const elapsed = Date.now() - start;
  // `>=`, not `>`: a budget of N milliseconds is the time available, so having consumed all of it
  // is already an overrun. The strict `>` made a zero budget mean "no budget, unless the work
  // happened to finish inside a single millisecond" -- on a fast machine a 10-fact anchor-free
  // retrieval does exactly that, `elapsed` reads 0, and `0 > 0` reported a healthy response from a
  // caller that had allotted no time at all. That is not a rounding detail: it made the one
  // deterministic handle callers have on this path (pass 0, get the exhausted contract) depend on
  // the runner's clock, which is how it surfaced -- as an intermittent Linux-only CI failure of the
  // very test written to pin the degradation contract "rather than inferred from a flake".
  const truncated = elapsed >= budgetMs;
  if (truncated) {
    // Empty, not a smaller slice: see RETRIEVAL_BUDGET_MS. A partial response is
    // byte-indistinguishable from a complete one in TGMEM/2, so emitting one would
    // hand the consumer a subset while its own contract says it received everything.
    logWarning(`hint-format exceeded its ${budgetMs}ms soft budget (took ${elapsed}ms); returning an empty hint set`);
    return { header: tgmemHeaderFor(protocolVersion, delta), lines: [], truncated: true, delta };
  }

  // Delta filtering happens before the caps (see `HintFormatOptions.delta`): the caps then select
  // from what the session has not seen, so a repeat call surfaces the next-best facts instead of
  // an empty block as soon as the top-ranked ones have all been sent once.
  //
  // "Already sent" suppresses a fact only while it does not match the current query. "Sent" and
  // "still in the agent's context" part ways over a long session -- the host compacts, and a fact
  // surfaced as filler on prompt 1 (swept in by the caps because nothing matched) and evicted since
  // would otherwise never be re-sent when it becomes the exact answer on prompt 9. A genuine hit
  // therefore always re-sends, however often it was sent before; filler -- exactly the set that
  // matched nothing -- stays suppressed, and a query-less call (the SessionStart recency dump)
  // matches nothing at all, so it remains fully suppressible.
  //
  // `matchedQuery` rather than `score !== 0`: the two agree only while BM25 is the sole rank list.
  // Turning on usefulness feedback or an embedding backend makes retrieval fuse via RRF, which
  // floors every ranked fact above zero -- so the old predicate would have quietly declared every
  // filler fact a match and disabled delta suppression store-wide, with no test failing to say so.
  //
  // A pinned fact is exempt from suppression outright, for the reason stated one paragraph up and
  // with more force: the compaction argument that re-sends a genuine hit applies to a standing
  // constraint every time, since a pin is precisely the fact whose absence from context the user
  // said they will not accept. Suppressing it after one send would make PINNED_RESERVE a
  // first-prompt-only guarantee, which is not a guarantee.
  const unseen = delta
    ? results.filter((result) => isPinned(result) || result.matchedQuery || !alreadySurfaced.has(result.fact.id))
    : results;

  // The reserve is taken before the kind caps see the list, and the reserved facts are then removed
  // from what the caps rank -- otherwise a pinned preference would consume one of its own eight
  // aggressive slots and the reserve would guarantee nothing it did not already have.
  const reserved = unseen.filter(isPinned).slice(0, PINNED_RESERVE);
  const reservedIds = new Set(reserved.map((result) => result.fact.id));
  const contested = unseen.filter((result) => !reservedIds.has(result.fact.id));
  const aggressive = contested.filter((result) => AGGRESSIVE_KINDS.has(result.fact.kind)).slice(0, AGGRESSIVE_CAP);
  const precision = contested.filter((result) => !AGGRESSIVE_KINDS.has(result.fact.kind)).slice(0, PRECISION_CAP);

  const ordered = [...reserved, ...aggressive, ...precision];
  if (stable) {
    ordered.sort((a, b) => a.fact.id.localeCompare(b.fact.id));
  }

  const emittable = ordered.filter((result) => {
    if (isWireSafeId(result.fact.id)) {
      return true;
    }
    logWarning(`dropped a fact whose id is not wire-safe for the TGMEM line format: ${JSON.stringify(result.fact.id)}`);
    return false;
  });

  const lines = emittable.map(formatLine);
  // `unseen`, not `results`: a fact the caps dropped was withheld from this payload, but one the
  // delta filter dropped was already sent and the consumer still has it. Counting the latter as
  // "not sent" would report a shortfall that does not exist on a `--delta` call.
  const footer = protocolVersion === 2 ? footerLineFor({ facts: emittable.length, cut: unseen.length - emittable.length, withheld: withheldCount }) : undefined;
  if (footer !== undefined) {
    lines.push(footer);
  }

  const emittedIds = emittable.map((result) => result.fact.id);
  if (sessionId !== undefined && !stable) {
    // Logs to `recall_log` and stamps `facts.last_surfaced_at` together, in one transaction.
    recordSurfaced(options.dbPath ?? resolveDbPath(), sessionId, emittedIds, now);
  } else {
    // No session id to log against, or `--stable` (which only affects output ordering, not
    // whether a fact was actually surfaced): still stamp the durable mark so stale-supersede
    // never treats an emitted fact as never-surfaced.
    markSurfaced(options.dbPath ?? resolveDbPath(), emittedIds, now);
  }

  return { header: tgmemHeaderFor(protocolVersion, delta), lines, truncated, delta };
}

/**
 * Best-effort write of the emitted fact ids to `recall_log`. Any failure -- a read-only store, a
 * locked database, a schema this build does not expect -- is logged to stderr and otherwise
 * ignored: the recall already succeeded, and a bookkeeping failure must not turn it into a failure.
 */
function recordSurfaced(dbPath: string, sessionId: string, factIds: readonly string[], now: Date): void {
  if (factIds.length === 0) {
    return;
  }
  try {
    const db = openStorage(dbPath);
    try {
      insertRecallLog(db, sessionId, factIds, now.toISOString());
    } finally {
      db.close();
    }
  } catch (error) {
    logWarning(`could not record surfaced facts for session ${JSON.stringify(sessionId)}: ${errorMessage(error)}`);
  }
}

/**
 * Best-effort stamp of `facts.last_surfaced_at` for the emitted fact ids, with no `recall_log`
 * row -- used when there is no session id to log against, or under `--stable`. Same fail-open
 * contract as `recordSurfaced`: a bookkeeping failure must not turn a successful recall into one.
 */
function markSurfaced(dbPath: string, factIds: readonly string[], now: Date): void {
  if (factIds.length === 0) {
    return;
  }
  try {
    const db = openStorage(dbPath);
    try {
      markFactsSurfaced(db, factIds, now.toISOString());
    } finally {
      db.close();
    }
  } catch (error) {
    logWarning(`could not mark facts surfaced: ${errorMessage(error)}`);
  }
}

interface RawFactRow {
  readonly id: string;
  readonly text: string;
  readonly kind: FactKind;
  readonly subject: string | null;
  readonly value: string | null;
  readonly scope: Fact["scope"];
  readonly scopeRoot: string | null;
  readonly scopeRepo: string | null;
  readonly captureRoot: string | null;
  readonly source_type: Fact["source_type"];
  readonly source_ref: string | null;
  readonly captured_at: string;
  readonly anchor: string | null;
  readonly status: Fact["status"];
  readonly confidence: number;
  readonly prior_status: Fact["status"] | null;
  readonly embedding?: Buffer | null;
}

/**
 * Every fact in the store, as `Fact`s.
 *
 * `withEmbeddings` is off unless an embedding backend was actually resolved: the BLOB column is
 * kilobytes per row and this path reads the whole table under a ~150ms budget, so it is selected
 * only when something is going to compare it. With it off, every fact carries `embedding: null` and
 * retrieval's embedding list stays empty -- which is the behaviour that shipped before a backend
 * existed at all.
 */
function queryAllFacts(db: ReturnType<typeof openStorage>, withEmbeddings = false): Fact[] {
  const rows = db
    .prepare<
      [],
      RawFactRow
    >(
      // `prior_status` is not decoration here: `resolveContradictions` reinstates a fact whose rival
      // is gone and restores `prior_status` when that fact was `pinned` before it was contested.
      // Selecting without the column made every reinstatement in the hint path land on `active`,
      // quietly stripping a pinned fact of its decay exemption on the one surface another tool
      // consumes programmatically. `scope_repo` had the same defect once already fixed here: omitting
      // it left every project fact invisible to a second clone or worktree of the same repository,
      // because `isInScope` falls back to `identityMatches(undefined, root)`, which is always false.
      // General rule: any `facts` column that a reader downstream of this function depends on --
      // directly or through a helper like `isInScope` or `resolveContradictions` -- must be added to
      // this SELECT, or it silently reads as absent on this path only, with the CLI's own SELECT
      // (storage.ts) unaffected.
      `SELECT id, text, kind, subject, value, scope, scope_root as scopeRoot, scope_repo as scopeRepo,
              capture_root as captureRoot, source_type, source_ref, captured_at, anchor, status, confidence,
              prior_status${withEmbeddings ? ", embedding" : ""}
       FROM facts`
    )
    .all();
  return rows.map(toFact);
}

function toFact(row: RawFactRow): Fact {
  return {
    id: row.id,
    text: row.text,
    kind: row.kind,
    subject: row.subject,
    value: row.value,
    scope: row.scope,
    scopeRoot: row.scopeRoot,
    scopeRepo: row.scopeRepo,
    captureRoot: row.captureRoot,
    source_type: row.source_type,
    source_ref: row.source_ref,
    captured_at: row.captured_at,
    anchor: row.anchor,
    status: row.status,
    confidence: row.confidence,
    prior_status: row.prior_status,
    embedding: row.embedding === undefined || row.embedding === null ? null : unpackEmbedding(row.embedding),
  };
}

function isInScope(fact: Fact, root: string, contextFiles: readonly string[]): boolean {
  if (fact.scope === "global") {
    return true;
  }
  const scopeRootRaw = fact.scopeRoot ?? null;
  if (scopeRootRaw === null || scopeRootRaw.trim().length === 0) {
    // A project/path-scoped fact with no binding can never be resolved
    // against a caller's root -- exclude rather than guess (fails toward
    // under-recall, the safe direction). An empty/whitespace-only string is
    // treated the same as null here to match isBoundToRoot's rule
    // (retrieval.ts) -- otherwise resolvePath("") resolves to process.cwd(),
    // which put a scope="project" fact with scopeRoot: "" in scope for every
    // project whose --root happened to equal the caller's cwd.
    return false;
  }
  const scopeRoot = normalizePath(resolvePath(scopeRootRaw));

  if (fact.scope === "project") {
    // Mirrors retrieval.ts's isBoundToRoot: path binding first, repo identity as a widening.
    return normalizePath(root) === scopeRoot || identityMatches(fact.scopeRepo, root);
  }

  // scope === "path"
  return contextFiles.some((file) => {
    const normalizedFile = normalizePath(file);
    return normalizedFile === scopeRoot || normalizedFile.startsWith(scopeRoot + sep);
  });
}

function normalizePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/**
 * Whether `id` can occupy the unquoted `id=` field without being able to forge a line.
 *
 * `display` is JSON-encoded, so a newline or quote inside it cannot break the consumer's parse.
 * `id` cannot be given the same treatment: the consumer reads it back out as a bare token to hand to
 * `mem show`, so quoting it would be a breaking change to the published TGMEM wire contract. The
 * emitter guarantees the property structurally instead -- one run of characters containing no
 * whitespace and no control character, which is exactly what "cannot forge a second line" means here.
 *
 * Every id mem itself writes is a `randomUUID`, and `import --from-json` validates imported ids
 * against `ID_PREFIX_PATTERN`, so no supported path can produce an unsafe id. This is the emitter
 * declining to trust a database it did not write: one from a pre-0.2.2 version, or edited by hand.
 * Deliberately weaker than `ID_PREFIX_PATTERN`: addressability is storage's and import's boundary to
 * enforce, and an id that is merely unusual should still surface rather than vanish silently.
 */
function isWireSafeId(id: string): boolean {
  if (id.length === 0 || /\s/u.test(id)) {
    return false;
  }
  for (const ch of id) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a result holds a user pin, the predicate both `PINNED_RESERVE` and the delta exemption
 * key on. One function rather than two inline `=== "pinned"` comparisons so the two can never
 * disagree about what a pin is -- a reserve that admitted a status the delta filter still
 * suppressed would hand out a slot and then drop the fact that was meant to fill it.
 */
function isPinned(result: RetrievedFact): boolean {
  return result.fact.status === "pinned";
}

function formatLine(result: RetrievedFact): string {
  const tag = PROTOCOL_KIND_TAG[result.fact.kind];
  // JSON.stringify both quotes and escapes the display string, guaranteeing
  // the emitted line is machine-parseable (design plan Section 4: "A
  // malformed individual line is dropped and logged" on the consumer side --
  // this producer never hands out a line that could become malformed).
  return `${tag}  fresh=${verdictLabel(result.freshness)}  id=${result.fact.id}  display=${JSON.stringify(result.display)}`;
}

function verdictLabel(verdict: AnchorVerdict): AnchorVerdict {
  return verdict;
}

function logWarning(message: string): void {
  console.warn(`[mem] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
