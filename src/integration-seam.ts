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
import type { AnchorVerdict } from "./anchors.js";
import { openDb, resolveDbPath } from "./db.js";
import { retrieve, type RetrievedFact } from "./retrieval.js";
import type { Fact, FactKind } from "./types.js";

/**
 * TGMEM wire-format grammar (normative for this producer; design plan Section 4).
 *
 * A `mem recall --hint-format` response is a UTF-8 text stream of LF-terminated
 * lines (ABNF, RFC 5234 core rules):
 *
 *   response      = header LF *( fact-line LF ) [ footer-line LF ]   ; footer-line is TGMEM/2+ only
 *   header        = "TGMEM/" version        ; version = 1*DIGIT
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
 *
 * Version policy: any change to line shape, field order, the separator, or the
 * escaping of `display` -- and any addition to the closed `tag`/`verdict` sets,
 * since consumers validate against them -- bumps the integer version. Consumers
 * treat versions they don't know as "no hints".
 *
 * TGMEM/1 (superseded default, still fully supported -- see `protocolVersion`
 * below): every fact-line's `display` carries its own trailing
 * `" — <follow-up command>"` CTA (e.g. `— mem show <id>`, `— verify; mem show
 * <id>`, `— resolve via mem review`). No footer-line.
 *
 * TGMEM/2 (current default): this bumped because of two additive-but-
 * grammar-changing facts -- `display` no longer carries a per-line CTA
 * (bare caveated fact text only), and a response with at least one fact-line
 * now ends with exactly one `footer-line` summarizing the available
 * follow-up commands once, instead of repeating one on every line:
 *
 *   footer-line   = "footer" SEP footer-text
 *   footer-text   = "mem show <id> for detail; mem review to resolve contested/pending"
 *
 * A footer-line is only emitted when the response has at least one fact-line
 * (an empty hint set has nothing to follow up on). `footer` is a fixed
 * constant, not JSON-escaped -- callers should treat it as informational
 * text, not something to `JSON.parse`.
 */
export const TGMEM_PROTOCOL_VERSION = 2;

/** Header line every hint-format response starts with, for the default protocol version. */
export const TGMEM_HEADER = `TGMEM/${TGMEM_PROTOCOL_VERSION}`;

/** The one fixed footer line TGMEM/2+ appends after fact-lines, when there is at least one. */
export const TGMEM_FOOTER_LINE = "footer  mem show <id> for detail; mem review to resolve contested/pending";

function tgmemHeaderFor(protocolVersion: number): string {
  return `TGMEM/${protocolVersion}`;
}

/**
 * Self-imposed soft time budget (ms) for a hint-format retrieval (design
 * plan Section 4: the token-goat side applies its own ~150ms hard timeout
 * around the whole subprocess call; this is mem's internal budget for the
 * work it does, so it degrades gracefully well before that outer timeout
 * would fire). Once exceeded, this module truncates its own output rather
 * than trusting an unbounded result set — "truncate ... do not hang".
 */
const RETRIEVAL_BUDGET_MS = 150;

/** Minimum budget handed to `retrieve()`'s own anchor-evaluation deadline, even if most of the soft budget is already spent. */
const MIN_ANCHOR_BUDGET_MS = 20;

/**
 * Kinds recalled aggressively (design plan P6): a miss lets the agent
 * silently fall back to a wrong invented default (e.g. "uses npm" three
 * months after a switch to pnpm), so these get a larger cap than
 * historical, precision-biased kinds.
 */
const AGGRESSIVE_KINDS: ReadonlySet<FactKind> = new Set<FactKind>(["preference", "correction"]);
const AGGRESSIVE_CAP = 8;
const PRECISION_CAP = 4;

/** Caps applied when the soft time budget was exceeded (design plan Section 4: "truncate ... if exceeded"). */
const TRUNCATED_AGGRESSIVE_CAP = 2;
const TRUNCATED_PRECISION_CAP = 1;

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
}

export interface HintFormatResult {
  /** `"TGMEM/<n>"` */
  readonly header: string;
  /** Fully formatted, ready-to-print lines, one per surfaced fact. */
  readonly lines: readonly string[];
  /** True if the soft time budget was exceeded and `lines` was truncated as a result. */
  readonly truncated: boolean;
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
    return { header: tgmemHeaderFor(resolveProtocolVersion(options.protocolVersion)), lines: [], truncated: false };
  }
}

async function buildHintFormatUnsafe(options: HintFormatOptions): Promise<HintFormatResult> {
  const start = Date.now();
  const root = resolvePath(options.root);
  const contextFiles = (options.contextFiles ?? []).map((file) => resolvePath(root, file));
  const now = options.now ?? new Date();
  const protocolVersion = resolveProtocolVersion(options.protocolVersion);
  const stable = options.stable === true;

  const db = openDb(options.dbPath ?? resolveDbPath());
  let allFacts: Fact[];
  try {
    allFacts = queryAllFacts(db);
  } finally {
    db.close();
  }

  const scoped = allFacts.filter((fact) => isInScope(fact, root, contextFiles));

  const anchorTimeBudgetMs = Math.max(MIN_ANCHOR_BUDGET_MS, RETRIEVAL_BUDGET_MS - (Date.now() - start));
  const { results } = await retrieve(scoped, {
    query: "",
    root,
    hintFormat: true,
    now,
    anchorTimeBudgetMs,
    // TGMEM/2 drops the per-line CTA in favor of one shared footer line (see the grammar doc
    // comment above); TGMEM/1 keeps its original per-line CTA verbatim.
    includeDisplayCta: protocolVersion === 1,
    ...(options.hintStyle !== undefined ? { hintStyle: options.hintStyle } : {}),
  });

  const elapsed = Date.now() - start;
  const truncated = elapsed > RETRIEVAL_BUDGET_MS;
  if (truncated) {
    logWarning(`hint-format exceeded its ${RETRIEVAL_BUDGET_MS}ms soft budget (took ${elapsed}ms); truncating output`);
  }
  const aggressiveCap = truncated ? TRUNCATED_AGGRESSIVE_CAP : AGGRESSIVE_CAP;
  const precisionCap = truncated ? TRUNCATED_PRECISION_CAP : PRECISION_CAP;

  const aggressive = results.filter((result) => AGGRESSIVE_KINDS.has(result.fact.kind)).slice(0, aggressiveCap);
  const precision = results.filter((result) => !AGGRESSIVE_KINDS.has(result.fact.kind)).slice(0, precisionCap);

  const ordered = [...aggressive, ...precision];
  if (stable) {
    ordered.sort((a, b) => a.fact.id.localeCompare(b.fact.id));
  }

  const lines = ordered.map(formatLine);
  if (protocolVersion === 2 && lines.length > 0) {
    lines.push(TGMEM_FOOTER_LINE);
  }

  return { header: tgmemHeaderFor(protocolVersion), lines, truncated };
}

interface RawFactRow {
  readonly id: string;
  readonly text: string;
  readonly kind: FactKind;
  readonly subject: string | null;
  readonly value: string | null;
  readonly scope: Fact["scope"];
  readonly scopeRoot: string | null;
  readonly source_type: Fact["source_type"];
  readonly source_ref: string | null;
  readonly captured_at: string;
  readonly anchor: string | null;
  readonly status: Fact["status"];
  readonly confidence: number;
}

function queryAllFacts(db: ReturnType<typeof openDb>): Fact[] {
  const rows = db
    .prepare<
      [],
      RawFactRow
    >(
      `SELECT id, text, kind, subject, value, scope, scope_root as scopeRoot, source_type, source_ref,
              captured_at, anchor, status, confidence
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
    source_type: row.source_type,
    source_ref: row.source_ref,
    captured_at: row.captured_at,
    anchor: row.anchor,
    status: row.status,
    confidence: row.confidence,
    embedding: null,
  };
}

function isInScope(fact: Fact, root: string, contextFiles: readonly string[]): boolean {
  if (fact.scope === "global") {
    return true;
  }
  const scopeRootRaw = fact.scopeRoot ?? null;
  if (scopeRootRaw === null) {
    // A project/path-scoped fact with no binding can never be resolved
    // against a caller's root -- exclude rather than guess (fails toward
    // under-recall, the safe direction).
    return false;
  }
  const scopeRoot = normalizePath(resolvePath(scopeRootRaw));

  if (fact.scope === "project") {
    return normalizePath(root) === scopeRoot;
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
