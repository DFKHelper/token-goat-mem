/**
 * Commander-based CLI wiring for `mem` (design plan Sections 3/4/5/6, AGENTS.md's command list).
 *
 * This module owns argument parsing, input validation at the CLI boundary (raw `string` -> `FactKind`
 * /`FactScope`/`FactStatus`), output formatting, and orchestration across the already-built domain
 * modules (storage.ts, capture.ts, retrieval.ts, contradiction.ts, anchors.ts, integration-seam.ts). It
 * does not reimplement any of their logic -- every command is a thin composition of the exported
 * functions those modules already provide.
 *
 * `buildProgram()` is exported separately from `run()` so tests can construct and introspect a fresh
 * Commander program without going through `process.argv`/`process.exit` (mirrors token-goat's own
 * `src/cli.ts` convention). `run()` is the actual entry point `src/main.ts` calls.
 *
 * Exit-code / stream contract (normative for every command):
 *   - exit 0 -- success. All requested data goes to **stdout**; stderr is empty. "Nothing found"
 *     outcomes (`no matching facts`, `no facts stored`, `nothing needs review`) are successes, not
 *     errors. `--hint-format` additionally *always* exits 0, even on internal failure -- the seam
 *     fails open to an empty, well-formed TGMEM payload by design (Section 4).
 *   - exit 1 -- user/usage error: invalid arguments or option values, unknown fact id, an invalid
 *     state transition (e.g. promoting a non-pending fact), input rejected by secret screening, or
 *     a Commander parse error (unknown command, missing argument). The input was wrong; retrying
 *     the same invocation will fail the same way.
 *   - exit 2 -- internal/unexpected error: DB open/IO failure, or any bug-class exception. The
 *     input may have been fine; the environment or mem itself is what failed.
 *   Diagnostics always go to **stderr** as a single `mem: <message>` line (Commander writes its own
 *   usage diagnostics to stderr in its own format); stdout carries data only, so piping stdout is
 *   always safe. `--help`/`--version` are successes (exit 0).
 *
 * Every action is wrapped in `guard()`, which enforces that contract: it maps a thrown error to a
 * single `mem: <message>` stderr line and `process.exitCode` 1 or 2 (`UsageError` and the capture
 * module's validation/secret errors are user errors; everything else is internal) -- never a
 * partial stack trace, never a hard `process.exit()` (that would truncate buffered stdout on
 * Windows pipes; letting the event loop drain naturally, same as token-goat's `main.ts` shim,
 * guarantees output flushes first).
 */

import { Command } from "commander";
import { resolve as resolvePath } from "node:path";
import type Database from "better-sqlite3";

import { evaluateAnchor, mentionsAnchorableTarget, type AnchorVerdict } from "./anchors.js";
import type { FactStatusUpdate } from "./contradiction.js";
import {
  captureExplicit,
  captureSuggested,
  CaptureValidationError,
  InvalidAnchorError,
  screenInputOrThrow,
  SecretDetectedError,
  validateFactEditOrThrow,
  type CaptureExplicitInput,
  type CaptureSuggestedInput,
} from "./capture.js";
import { detectContradictions, sameContradictionBucket } from "./contradiction.js";
import {
  DEFAULT_DUPLICATE_THRESHOLD,
  DEFAULT_STALE_AGE_DAYS,
  findDuplicateClusters,
  findStaleFacts,
  staleCutoff,
  type DuplicateCluster,
} from "./consolidate.js";
import {
  findSupersedingFactId,
  insertAuditLog,
  resolveDbPath,
  SUPERSEDED_AS_DUPLICATE_PREFIX,
  SUPERSEDED_BY_FACT_PREFIX,
} from "./db.js";
import {
  EMBED_API_KEY_ENV,
  EMBED_MODEL_ENV,
  EMBED_URL_ENV,
  EmbeddingConfigError,
  endpointLabelFor,
  planEmbeddingRanking,
  readEmbeddingConfig,
  resolveConfiguredEmbeddingBackend,
  type EmbeddingMeta,
} from "./embeddings.js";
import { importFromJson, JsonImportError, JSON_EXPORT_SCHEMA_VERSION, planImportFromJson } from "./exportImport.js";
import { importFromMarkdown, MarkdownImportError, planImportFromMarkdown, type ImportOutcome } from "./import.js";
import {
  getToolWiring,
  TOOL_NAMES,
  WiringConflictError,
  type ToolName,
  type WiringOpts,
  type WiringPlan,
  type WiringResult,
} from "./wiring.js";
import { buildHintFormat, type HintFormatOptions } from "./integration-seam.js";
import { parseHookEnvelope, readStreamWithTimeout, type HookEnvelope } from "./hook-envelope.js";
import { anchorRootFor, isDecayedBelowGroundTruth, retrieve, DEFAULT_EMBEDDING_TIMEOUT_MS, type RetrievalOptions } from "./retrieval.js";
import {
  clearAllEmbeddings,
  countEmbeddedFacts,
  countFactsWithTerms,
  countFacts,
  deleteFact,
  deleteRecallLogOlderThan,
  deleteSourcesOlderThan,
  getEmbeddingMeta,
  getEntityKeysByFact,
  getEpoch,
  getFactById,
  getUsefulnessCounts,
  listEntityCounts,
  listFacts,
  listFactsNeedingEmbedding,
  listFactsNeedingTerms,
  listSourcesForFact,
  listTermsForFact,
  markRecallUsed,
  openStorage,
  replaceFactTerms,
  resolveFactIdOrPrefix,
  setEmbeddingMeta,
  setFactStatus,
  updateFact,
} from "./storage.js";
import { extractFacets } from "./facets.js";
import { FACT_KINDS, FACT_SCOPES, FACT_STATUSES } from "./types.js";
import type { Fact, FactFilter, FactKind, FactScope, FactStatus, FactUpdate, Source } from "./types.js";

const MS_PER_DAY = 86_400_000;

/** Default cap on `mem list` output when `--limit` is not given -- see the module doc comment on `retrieve()`'s own `DEFAULT_RECALL_LIMIT` in retrieval.ts for the recall-side analog. */
const DEFAULT_LIST_LIMIT = 20;

/**
 * How much of a fact id `mem recall` prints ahead of each result line.
 *
 * Recall's footer says `mem show <id> for detail`, but the 0.2.2 change that replaced the per-line
 * CTA with one shared footer also removed the only place an id was ever printed -- leaving the
 * footer instructing the user to use something the command never showed them. Eight hex characters
 * is the same git-style prefix `resolveFactIdOrPrefix` already resolves, so the printed handle is
 * directly pasteable; an ambiguous prefix is reported by that resolver with its candidates rather
 * than silently resolving to the wrong fact.
 */
const RECALL_SHORT_ID_LENGTH = 8;

// ─────────────────────────────────────────────────────────────────────────── Exit-code contract ───────────────────────────────────────────────────────────────────────────

/** See the module doc comment for the full normative contract. */
export const EXIT_SUCCESS = 0;
export const EXIT_USER_ERROR = 1;
export const EXIT_INTERNAL_ERROR = 2;

/**
 * A user/usage error: the invocation itself was wrong (bad option value, unknown fact id, invalid
 * state transition, ...). Maps to `EXIT_USER_ERROR`; anything else thrown from a command action is
 * treated as internal (`EXIT_INTERNAL_ERROR`).
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Classifies a thrown error per the exit-code contract: deliberate input-rejection errors are user errors; everything else (sqlite failures, bugs) is internal. */
/** Renders a stored fact's noun phrase for CLI confirmations. Every kind reads naturally as "<kind> fact" -- "decision fact", "correction fact" -- except `fact` itself, where the template degenerates into "fact fact". */
function factNounPhrase(kind: FactKind): string {
  return kind === "fact" ? "fact" : `${kind} fact`;
}

function exitCodeForError(error: unknown): number {
  return error instanceof UsageError ||
    error instanceof CaptureValidationError ||
    error instanceof InvalidAnchorError ||
    error instanceof SecretDetectedError ||
    error instanceof WiringConflictError ||
    error instanceof JsonImportError ||
    error instanceof MarkdownImportError
    ? EXIT_USER_ERROR
    : EXIT_INTERNAL_ERROR;
}

// ─────────────────────────────────────────────────────────────────────────── CLI-boundary validation ───────────────────────────────────────────────────────────────────────────


function parseFactKind(raw: string): FactKind {
  if (!FACT_KINDS.includes(raw as FactKind)) {
    throw new UsageError(`invalid kind "${raw}" (expected one of ${FACT_KINDS.join(", ")})`);
  }
  return raw as FactKind;
}

function parseFactScope(raw: string): FactScope {
  if (!FACT_SCOPES.includes(raw as FactScope)) {
    throw new UsageError(`invalid scope "${raw}" (expected one of ${FACT_SCOPES.join(", ")})`);
  }
  return raw as FactScope;
}

const HINT_STYLES = ["full", "terse"] as const;
type HintStyle = (typeof HINT_STYLES)[number];

function parseHintStyle(raw: string): HintStyle {
  if (!HINT_STYLES.includes(raw as HintStyle)) {
    throw new UsageError(`invalid --hint-style "${raw}" (expected one of ${HINT_STYLES.join(", ")})`);
  }
  return raw as HintStyle;
}

function parseFactStatusList(raw: string): FactStatus | readonly FactStatus[] {
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  for (const value of values) {
    if (!FACT_STATUSES.includes(value as FactStatus)) {
      throw new UsageError(`invalid status "${value}" (expected one of ${FACT_STATUSES.join(", ")})`);
    }
  }
  const [only] = values;
  return values.length === 1 && only !== undefined ? only as FactStatus : (values as FactStatus[]);
}

function parseToolName(raw: string): ToolName {
  if (!TOOL_NAMES.includes(raw as ToolName)) {
    throw new UsageError(`invalid tool "${raw}" (expected one of ${TOOL_NAMES.join(", ")})`);
  }
  return raw as ToolName;
}

/**
 * `--hook-stdin`: the hook envelope from stdin, or an empty envelope when stdin is a TTY, unreadable,
 * not JSON, or simply slow to close. Never throws -- see hook-envelope.ts for why a hook that
 * errors is worse than one that returns unranked facts.
 */
async function readHookEnvelope(): Promise<HookEnvelope> {
  try {
    return parseHookEnvelope(await readStreamWithTimeout(process.stdin));
  } catch {
    return {};
  }
}

/**
 * `TOKEN_GOAT_MEM_RETRIEVAL_BUDGET_MS`: test/advanced override for the hint-format soft time budget
 * (`RETRIEVAL_BUDGET_MS` in integration-seam.ts). Subprocess-level tests drive the built bundle
 * under a fully loaded runner, where the 150ms default blows and turns a selection assertion into a
 * timing one; the in-process seam tests already override it the same way through `HintFormatOptions`.
 * Ignored unless it parses as a positive integer.
 */
function retrievalBudgetOverride(): number | undefined {
  const raw = process.env["TOKEN_GOAT_MEM_RETRIEVAL_BUDGET_MS"];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 && String(parsed) === raw.trim() ? parsed : undefined;
}

function parseContextFiles(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const files = raw
    .split(",")
    .map((file) => file.trim())
    .filter((file) => file.length > 0);
  return files.length > 0 ? files : undefined;
}

/** Never defaults to ambient `process.cwd()` silently for anchor evaluation inside anchors.ts itself (Section 3) -- but a human-invoked, short-lived CLI command needs *some* root when the caller omits `--root`, and "the directory the command was invoked from" is the only reasonable one. Explicit `--root` always wins. */
function resolveRoot(explicit: string | undefined): string {
  return resolvePath(explicit ?? process.cwd());
}

// ─────────────────────────────────────────────────────────────────────────── DB lifecycle + error handling ───────────────────────────────────────────────────────────────────────────

/** Opens a fresh connection for one command invocation and always closes it, even on throw (mem is a short-lived, single-shot CLI process -- Section 3). */
/**
 * Wall clock for the post-capture embedding round trip.
 *
 * Small on purpose: `mem remember` is an interactive command whose real work is already finished by
 * the time this runs, so the vector is worth waiting a moment for and not worth waiting on. An
 * endpoint slower than this loses the vector, which `mem embed` picks up later.
 */
const CAPTURE_EMBED_TIMEOUT_MS = 2_000;

/** Texts per `mem embed` request. One round trip per batch rather than per fact is the whole reason `embedBatch` exists; 32 keeps a batch small enough that a failure loses little work. */
const EMBED_BATCH_SIZE = 32;

/**
 * The embedding lines of `mem doctor`'s report.
 *
 * Unconfigured is a healthy state and reads like one -- "off", with the two variables that would
 * turn it on -- because the overwhelming majority of installs never configure an endpoint and a
 * health check that flags the default as a problem trains people to ignore it.
 *
 * The API key is reported as configured or absent and never printed, echoed, or hinted at by
 * length. So is the endpoint: only its host reaches stdout, so a URL carrying userinfo cannot leak
 * through a health check someone pastes into an issue.
 */
/**
 * `mem doctor`'s term-coverage line. Worth a line of its own because a store captured before terms
 * existed carries none, and the only symptom is `mem recall --entity` quietly matching nothing --
 * indistinguishable, from the outside, from a store that genuinely has no fact mentioning that
 * entity. Naming the shortfall here points at `mem facets --backfill` instead of leaving the user to
 * conclude the filter is broken.
 */
function describeFacets(factsWithTerms: number, totalFacts: number): string {
  const line = `term coverage: ${factsWithTerms}/${totalFacts} facts`;
  return factsWithTerms < totalFacts ? `${line} (run \`mem facets --backfill\` -- \`mem recall --entity\` cannot match the rest)` : line;
}

function describeEmbeddings(recorded: EmbeddingMeta | null, embeddedFacts: number, totalFacts: number): string[] {
  const coverage = `embedding coverage: ${embeddedFacts}/${totalFacts} facts`;
  const stored = recorded === null ? "embedding store: nothing embedded yet" : `embedding store: model ${recorded.model}, dim ${recorded.dimension}`;
  let config;
  try {
    config = readEmbeddingConfig();
  } catch (error) {
    return [`embeddings: misconfigured -- ${extractErrorMessage(error)}`, stored, coverage];
  }
  if (config === null) {
    return [`embeddings: off (set ${EMBED_URL_ENV} and ${EMBED_MODEL_ENV} to enable)`, stored, coverage];
  }
  const lines = [`embeddings: ${endpointLabelFor(config.url)}, model ${config.model}, api key ${config.apiKey === undefined ? "absent" : "configured"}`, stored];
  if (recorded !== null && recorded.model !== config.model) {
    lines.push(`embedding ranking: disabled -- stored vectors are ${recorded.model}'s; run \`mem embed --all\` to re-embed`);
  }
  lines.push(coverage);
  return lines;
}

/**
 * Reads the embeddings config for a command that owes the user a diagnosis rather than a shrug.
 *
 * The fail-open callers (recall, the seam, post-capture) go through
 * `resolveConfiguredEmbeddingBackend`, which returns `null` for both "off" and "misconfigured". For
 * `mem embed` those are different answers and both are user errors worth naming: running it with no
 * endpoint set is not a silent no-op.
 */
function readEmbeddingConfigForCommand(): { readonly url: string; readonly model: string } {
  let config;
  try {
    config = readEmbeddingConfig();
  } catch (error) {
    throw new UsageError(error instanceof EmbeddingConfigError ? error.message : extractErrorMessage(error));
  }
  if (config === null) {
    throw new UsageError(
      `embeddings are not configured; set ${EMBED_URL_ENV} to an OpenAI-compatible endpoint and ${EMBED_MODEL_ENV} to a model name (${EMBED_API_KEY_ENV} is optional)`
    );
  }
  return config;
}

/**
 * Best-effort: computes and stores an embedding for a fact that was just captured.
 *
 * Lives here rather than in capture.ts deliberately. `writeFact` inserts the fact and its audit row
 * inside a single synchronous transaction; awaiting a network call there would put an HTTP round
 * trip inside a write transaction and turn every capture path async to buy nothing -- the vector is
 * a ranking optimization, not part of the fact.
 *
 * Running after capture also means running strictly after capture.ts's secret screening, and that
 * ordering is a security property rather than an accident: text that fails screening is never
 * stored, never returned, and so can never be handed to a configured embeddings endpoint.
 *
 * Nothing here may fail the capture. The fact is already durable and its id already printed, so
 * every failure -- unconfigured, unreachable, slow, malformed, or a model that disagrees with the
 * store's -- is swallowed without touching the exit code or stdout.
 */
async function attachEmbeddingBestEffort(fact: Fact): Promise<void> {
  const backend = resolveConfiguredEmbeddingBackend(process.env, { timeoutMs: CAPTURE_EMBED_TIMEOUT_MS });
  if (backend === null) {
    return;
  }
  try {
    const vector = await backend.embed(fact.text);
    await withDb((db) => {
      const recorded = getEmbeddingMeta(db);
      if (recorded === undefined) {
        updateFact(db, fact.id, { embedding: vector });
        setEmbeddingMeta(db, { model: backend.model, dimension: vector.length });
        return;
      }
      // A store whose vectors came from another model stays untouched: adding one vector from a
      // second model is exactly the mixed-vector-space corruption `mem embed --all` exists to
      // resolve, and it would be permanent and invisible.
      if (recorded.model === backend.model && recorded.dimension === vector.length) {
        updateFact(db, fact.id, { embedding: vector });
      }
    });
  } catch {
    // Intentionally silent: see the doc comment above.
  }
}

async function withDb<T>(fn: (db: Database.Database) => T | Promise<T>): Promise<T> {
  const db = openStorage();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function err(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Resolves a fact id argument (full id or git-style short prefix, `resolveFactIdOrPrefix` in
 * storage.ts) to the fact it names, or throws the same `UsageError` shape every id-accepting command
 * already used before short prefixes existed (`no such fact: <id>`), plus a new ambiguity error
 * listing every matching id. Every id-accepting command (`show`, `forget`, `pin`, `edit`, `review
 * --promote`, `review --reject`) should use the resolved fact's own `.id` for any subsequent
 * write/lookup, never the raw user-typed argument.
 */
function resolveIdArgOrThrow(db: Database.Database, id: string): Fact {
  const resolution = resolveFactIdOrPrefix(db, id);
  if (resolution.kind === "not-found") {
    throw new UsageError(`no such fact: ${id}`);
  }
  if (resolution.kind === "ambiguous") {
    const ids = resolution.matches.map((fact) => fact.id).join(", ");
    throw new UsageError(`ambiguous id prefix "${id}" matches ${resolution.matches.length} facts: ${ids} -- use more characters`);
  }
  return resolution.fact;
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wraps a command action so any thrown error maps to one `mem: <message>` stderr line + the contract exit code (1 user error, 2 internal -- see `exitCodeForError`), and success to exit code 0 (unless the handler already set a different `process.exitCode`). Mirrors token-goat's own `cli.ts` guard. */
function guard(fn: (...args: never[]) => void | Promise<void>): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]): Promise<void> => {
    process.exitCode = undefined;
    try {
      await fn(...(args as never[]));
      if (process.exitCode === undefined) {
        process.exitCode = EXIT_SUCCESS;
      }
    } catch (error) {
      err(`mem: ${extractErrorMessage(error)}`);
      process.exitCode = exitCodeForError(error);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────── Formatting ───────────────────────────────────────────────────────────────────────────

function formatFactSummary(fact: Fact): string {
  const kv = fact.subject !== null ? ` ${fact.subject}=${fact.value ?? ""}` : "";
  const scopeRoot = fact.scope !== "global" ? (fact.scopeRoot ?? null) : null;
  const binding = scopeRoot !== null ? ` @${scopeRoot}` : "";
  return `${fact.id}  [${fact.kind}/${fact.status}${binding}]${kv}  ${fact.text}`;
}

/**
 * What `mem show` knows about the fact that replaced this one: the id recovered from the audit log,
 * and the winner itself when it is still in the store (`mem gc` can prune it, and it may since have
 * been superseded in turn -- its own `status` is what says so).
 */
interface SupersessionEdge {
  readonly winnerId: string;
  readonly winner: Fact | undefined;
}

/**
 * Renders the supersession edge, or nothing when the fact was not superseded.
 *
 * A superseded fact with no named winner is stated rather than omitted: "retired, and nothing
 * replaced it" is a different and equally useful answer to "what happened to this?" than silence,
 * which the reader would otherwise have to disambiguate from a missing feature.
 */
function formatSupersessionLine(fact: Fact, edge: SupersessionEdge | null): string | null {
  if (fact.status !== "superseded") {
    return null;
  }
  if (edge === null) {
    return "superseded_by: (nothing -- retired by forget, reject, or staleness)";
  }
  if (edge.winner === undefined) {
    return `superseded_by: ${edge.winnerId} (no longer in the store -- pruned by mem gc)`;
  }
  return `superseded_by: ${edge.winnerId} (${edge.winner.status}): ${edge.winner.text}`;
}

function formatFactDetail(
  fact: Fact,
  freshness: AnchorVerdict,
  sources: readonly Source[],
  edge: SupersessionEdge | null
): string {
  const scopeRoot = fact.scopeRoot ?? null;
  const lines: string[] = [
    `id: ${fact.id}`,
    `kind: ${fact.kind}`,
    `status: ${fact.status}`,
    `text: ${fact.text}`,
    `subject: ${fact.subject ?? "(none)"}`,
    `value: ${fact.value ?? "(none)"}`,
    `scope: ${fact.scope}${scopeRoot !== null ? ` (${scopeRoot})` : ""}`,
    `source_type: ${fact.source_type}`,
    `source_ref: ${fact.source_ref ?? "(none)"}`,
    `captured_at: ${fact.captured_at}`,
    `anchor: ${fact.anchor ?? "(none)"}  freshness=${freshness}`,
    `confidence: ${fact.confidence}`,
  ];
  const supersession = formatSupersessionLine(fact, edge);
  if (supersession !== null) {
    lines.push(supersession);
  }
  if (sources.length > 0) {
    lines.push("sources:");
    for (const source of sources) {
      lines.push(`  - [${source.storedAt}] ${source.excerpt}`);
    }
  }
  return lines.join("\n");
}

/** Plain-JSON projection of a `Fact`, shared by `mem export`, `mem list --json`, and `mem show --json`. */
interface ExportedFactJson {
  readonly id: string;
  readonly text: string;
  readonly kind: FactKind;
  readonly subject: string | null;
  readonly value: string | null;
  readonly scope: FactScope;
  readonly scopeRoot: string | null;
  readonly source_type: Fact["source_type"];
  readonly source_ref: string | null;
  readonly captured_at: string;
  readonly anchor: string | null;
  readonly status: FactStatus;
  readonly confidence: number;
  readonly embedding?: number[] | null;
}

/**
 * Projects a `Fact` to its plain-JSON shape. `includeEmbedding` defaults to `true` (matching `mem
 * export`'s existing full-fidelity behavior, unchanged by this extraction); `mem list --json` / `mem
 * show --json` pass `false` to drop the field entirely (large, usually null, an internal
 * retrieval-only detail -- see the design plan's council/GLM synthesis).
 */
function factToExportJson(fact: Fact, options: { readonly includeEmbedding?: boolean } = {}): ExportedFactJson {
  const includeEmbedding = options.includeEmbedding ?? true;
  return {
    id: fact.id,
    text: fact.text,
    kind: fact.kind,
    subject: fact.subject,
    value: fact.value,
    scope: fact.scope,
    scopeRoot: fact.scopeRoot ?? null,
    source_type: fact.source_type,
    source_ref: fact.source_ref,
    captured_at: fact.captured_at,
    anchor: fact.anchor,
    status: fact.status,
    confidence: fact.confidence,
    ...(includeEmbedding ? { embedding: fact.embedding === null ? null : Array.from(fact.embedding) } : {}),
  };
}

function formatSection(title: string, facts: readonly Fact[]): string {
  if (facts.length === 0) {
    return "";
  }
  return [`-- ${title} (${facts.length}) --`, ...facts.map(formatFactSummary)].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────── init / uninstall ───────────────────────────────────────────────────────────────────────────

function formatWiringResult(result: WiringResult): string {
  if (result.changes.length === 0) {
    return "nothing to do";
  }
  return result.changes.map((change) => `  ${change.action.padEnd(6)} ${change.path}  (${change.detail})`).join("\n");
}

function formatWiringPlanForInit(plan: WiringPlan): string {
  if (plan.entries.every((entry) => entry.installAction === "noop")) {
    return "  already installed; nothing would change";
  }
  return plan.entries.map((entry) => `  ${entry.installAction.padEnd(6)} ${entry.path}  (${entry.detail})`).join("\n");
}

function formatWiringPlanForUninstall(plan: WiringPlan): string {
  if (plan.entries.every((entry) => entry.uninstallAction === "noop")) {
    return "  nothing to remove";
  }
  return plan.entries.map((entry) => `  ${entry.uninstallAction.padEnd(6)} ${entry.path}  (${entry.detail})`).join("\n");
}

// ─────────────────────────────────────────────────────────────────────────── import ───────────────────────────────────────────────────────────────────────────

function formatImportOutcomeLine(outcome: ImportOutcome): string {
  const { candidate } = outcome;
  const where = `${candidate.sourceRef}`;
  switch (outcome.status) {
    case "dry_run":
      return `  would-import  ${where}  "${candidate.text}"`;
    case "imported":
      return `  imported      ${where}  ${outcome.fact.id}  "${candidate.text}"`;
    case "skipped_duplicate":
      return `  skipped (duplicate)  ${where}  "${candidate.text}"`;
    case "skipped_error":
      return `  skipped (${outcome.reason})  ${where}  "${candidate.text}"`;
  }
}

function formatImportResult(result: { filePath: string; outcomes: readonly ImportOutcome[] }, dryRun: boolean): string {
  if (result.outcomes.length === 0) {
    return `no qualifying bullets found in ${result.filePath}`;
  }
  const lines = result.outcomes.map(formatImportOutcomeLine);
  if (dryRun) {
    return [`would import ${result.outcomes.length} candidate fact(s) from ${result.filePath} (dry run -- nothing written):`, ...lines].join("\n");
  }
  const importedFacts = result.outcomes.flatMap((outcome) => (outcome.status === "imported" ? [outcome.fact] : []));
  const imported = importedFacts.length;
  // `--from-md` lands every bullet in `pending` (advisory source, S9), but `--from-json` is a full-fidelity restore that preserves each exported fact's own status -- so a fixed "as pending" line contradicted the rows printed directly beneath it and sent users to a `mem review` that had nothing to show. Derive the wording from what was actually written rather than from which flag was passed, so a mixed or future import mode cannot reintroduce the mismatch.
  const disposition =
    imported === 0
      ? "-- no new facts were written"
      : importedFacts.every((fact) => fact.status === "pending")
        ? "as pending (never auto-promoted -- confirm each via `mem review --promote <id>`)"
        : "preserving each fact's exported status (nothing was auto-promoted; `mem list` shows them)";
  return [`imported ${imported} of ${result.outcomes.length} candidate fact(s) from ${result.filePath} ${disposition}:`, ...lines].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────── review ───────────────────────────────────────────────────────────────────────────

/** Section 6 / review finding S8: "Pins get a re-confirmation nudge in review after N months so a year-old forgotten pin can't stay maximally-trusted forever." ~6 months. */
const PIN_RECONFIRM_DAYS = 182;

/**
 * When a fact entered the status it currently holds -- the basis for every "how long has it been
 * like *this*" retention clock (the superseded-fact GC window, the pin re-confirmation nudge).
 *
 * These clocks previously read `captured_at`, which never moves, so both were wrong by
 * construction: a fact captured 91 days ago and superseded yesterday was GC'd on the next pass
 * despite the 90-day audit window it was supposed to get, and a pin's re-confirmation nudge could
 * never be cleared because re-pinning does not change when the fact was captured. Falls back to
 * `captured_at` for rows written before `status_changed_at` existed -- the same value those rows
 * were already being judged by, so the migration changes nothing for them.
 */
function statusChangedAt(fact: Fact): string {
  const changed = fact.status_changed_at;
  return typeof changed === "string" && changed.length > 0 ? changed : fact.captured_at;
}

/** The five `mem review` buckets, in listing order. `formatReview`'s `--summary`/`--section` options validate against exactly this set. */
const REVIEW_SECTIONS = ["pending", "contested", "contradicted", "pins", "unanchored"] as const;
type ReviewSection = (typeof REVIEW_SECTIONS)[number];

function parseReviewSection(raw: string): ReviewSection {
  if (!REVIEW_SECTIONS.includes(raw as ReviewSection)) {
    throw new UsageError(`invalid --section "${raw}" (expected one of ${REVIEW_SECTIONS.join(", ")})`);
  }
  return raw as ReviewSection;
}

interface ReviewOptions {
  /** Print counts per bucket instead of full listings. */
  readonly summary?: boolean;
  /** Restrict output to a single bucket's full listing (still full, just skips the other buckets). */
  readonly section?: ReviewSection;
  /** Only include facts with `epoch > sinceEpoch` -- see storage.ts's `epoch` column / `mem epoch`. */
  readonly sinceEpoch?: number;
}

/**
 * Flips a fact's status and writes its audit-log row inside a single transaction, so a crash
 * between the two never leaves a persisted status change with no audit trail (the crash-window
 * class commit bb38b1e closed for remember/suggest/edit/forget/pin/promote/reject). All status-
 * changing commands (and the retention pass's per-contradiction resolution) funnel through here.
 */
function setStatusWithAudit(
  db: Database.Database,
  factId: string,
  nextStatus: FactStatus,
  event: string,
  detail: string
): void {
  const tx = db.transaction((): void => {
    setFactStatus(db, factId, nextStatus);
    insertAuditLog(db, { event, factId, detail });
  });
  // BEGIN IMMEDIATE: `setFactStatus` reads the current status and epoch before writing, and once
  // this outer transaction is open it degrades to a savepoint -- so the outer variant is what
  // decides whether the read-then-write pair survives a concurrent writer under WAL. See
  // storage.insertFact for the SQLITE_BUSY_SNAPSHOT rationale.
  tx.immediate();
}

/**
 * Statuses `mem review --promote/--reject` can act on. Both are review-resolvable *withheld* states
 * -- a fact recall refuses to surface until a human decides -- which is the whole population the
 * review loop exists to drain.
 */
const REVIEW_RESOLVABLE_STATUSES: readonly FactStatus[] = ["pending", "contested"];

/**
 * Re-runs deterministic contradiction detection over the full detection pool and persists every
 * transition it produces, including reinstatements of facts no longer contested.
 *
 * Shared by `mem epoch --gc` and by review's contested resolution so both agree, by construction,
 * on which facts are still contested -- the divergence that let a `contested` status outlive the
 * contradiction that caused it.
 */
function reconcileContradictions(db: Database.Database, event: string): readonly FactStatusUpdate[] {
  const pool = listFacts(db, { status: ["active", "pinned", "contested"] });
  const { updates } = detectContradictions(pool);
  for (const update of updates) {
    setStatusWithAudit(db, update.factId, update.nextStatus, event, update.reason);
  }
  return updates;
}

/**
 * `mem review --promote <id>`: accept a withheld fact.
 *
 * For a `pending` fact that means activating it. For a `contested` one it means declaring it the
 * winner of its ambiguous contradiction, which requires superseding exactly its bucket rivals --
 * without that, the next detection pass would find the same tied precedence and re-contest the
 * whole group, making the promotion silently self-undoing. The winner returns to `prior_status`
 * where that was `pinned`, so resolving a contradiction never quietly discards a user's pin.
 */
function promotePending(db: Database.Database, id: string): string {
  const fact = resolveIdArgOrThrow(db, id);
  if (!REVIEW_RESOLVABLE_STATUSES.includes(fact.status)) {
    throw new UsageError(
      `fact ${fact.id} is not pending or contested (status=${fact.status}) -- only withheld facts can be promoted`
    );
  }
  if (fact.status === "contested") {
    const restored: FactStatus = fact.prior_status === "pinned" ? "pinned" : "active";
    setStatusWithAudit(
      db,
      fact.id,
      restored,
      "review_promote",
      `resolved contested contradiction in this fact's favor via explicit review (restored to ${restored})`
    );
    const rivals = listFacts(db, { status: "contested" }).filter(
      (other) => other.id !== fact.id && sameContradictionBucket(other, fact)
    );
    for (const rival of rivals) {
      setStatusWithAudit(
        db,
        rival.id,
        "superseded",
        "review_promote",
        `${SUPERSEDED_BY_FACT_PREFIX}${fact.id}: contested contradiction resolved in that fact's favor via explicit review.`
      );
    }
    return fact.id;
  }
  setStatusWithAudit(db, fact.id, "active", "review_promote", "promoted pending fact to active via explicit review");
  return fact.id;
}

/**
 * `mem review --reject <id>`: discard a withheld fact (soft-delete, kept for audit).
 *
 * Rejecting one side of a contested group can leave the group unambiguous, so the reconciliation
 * pass runs afterwards to reinstate any survivor that is no longer contested -- otherwise the
 * survivor would stay withheld with nothing left to contest it until the next `mem epoch --gc`.
 */
function rejectPending(db: Database.Database, id: string): string {
  const fact = resolveIdArgOrThrow(db, id);
  if (!REVIEW_RESOLVABLE_STATUSES.includes(fact.status)) {
    throw new UsageError(
      `fact ${fact.id} is not pending or contested (status=${fact.status}) -- only withheld facts can be rejected`
    );
  }
  const wasContested = fact.status === "contested";
  setStatusWithAudit(
    db,
    fact.id,
    "superseded",
    "review_reject",
    `rejected ${fact.status} fact (superseded) via explicit review`
  );
  if (wasContested) {
    reconcileContradictions(db, "review_reject");
  }
  return fact.id;
}

/** `formatReview`'s long, human-facing section titles, keyed by the short bucket names `--section`/`--summary` validate against. */
const REVIEW_SECTION_TITLES: Record<ReviewSection, string> = {
  pending: "pending (never auto-promoted -- confirm with --promote/--reject)",
  contested: "contested (ambiguous contradiction -- withheld from ground truth; resolve with --promote/--reject)",
  contradicted: "anchor-contradicted (suppressed from ground truth)",
  pins: "pins due for re-confirmation",
  unanchored: "unanchored but checkable (names a path/URL/config file; consider `mem edit <id> --anchor`)",
};

/**
 * Kinds eligible for the `unanchored` nomination. `preference` is excluded by construction: a
 * preference is a judgment claim ("prefer tabs over spaces"), and no filesystem predicate can
 * confirm or deny one — mentioning a path incidentally does not make it environment-dependent.
 * The remaining kinds all assert something about the world that an anchor could test.
 */
const UNANCHORED_ELIGIBLE_KINDS: ReadonlySet<FactKind> = new Set<FactKind>(["decision", "fact", "correction"]);

/**
 * Builds the `mem review` listing: pending facts (never auto-promoted, S9), contested facts
 * (deterministic contradiction detection re-run fresh over the live active/pinned pool, never
 * trusting a possibly-stale `status` column -- same discipline as retrieval.ts), anchor-contradicted
 * facts (including pins -- S8: a pin is exempt from decay, never from contradiction/anchor
 * suppression), pins overdue for re-confirmation, and unanchored-but-checkable facts (ground-truth
 * facts carrying no anchor whose text names a path/URL/config file an anchor could be written
 * against -- the one bucket that is a nudge rather than a pending decision).
 *
 * `options.sinceEpoch` restricts every bucket to facts with `epoch > sinceEpoch` (applied at the
 * source -- pending/groundTruth queries -- so contested/contradicted/pins, which are derived from
 * groundTruth, inherit the filter automatically). `options.section` restricts the output to one
 * bucket. `options.summary` prints per-bucket counts instead of full listings.
 */
function formatReview(db: Database.Database, root: string, options: ReviewOptions = {}): string {
  const epochFilter: FactFilter = options.sinceEpoch !== undefined ? { epochAfter: options.sinceEpoch } : {};
  const pending = listFacts(db, { status: "pending", ...epochFilter });
  // Persisted-`contested` facts are part of the detection pool, not just live ground truth. Querying
  // only active/pinned meant a fact `mem epoch --gc` had already marked contested vanished from the
  // one bucket that exists to surface it: `mem review --summary` reported `contested: 0` while
  // `mem recall` was still withholding that fact as contested, and `--promote` refused to touch it.
  //
  // The epoch window is deliberately NOT applied here. `detectContradictions` decides by comparing
  // rivals, so a pool narrowed to one epoch reports a survivor whose rival fell outside the window as
  // uncontested -- `mem review --since-epoch N` would call clean exactly the fact `mem recall` is
  // still withholding. The window narrows what the user is asked to review, not what the detector is
  // allowed to see, so it is applied to the derived buckets at display time instead.
  const detectionPool = listFacts(db, { status: ["active", "pinned", "contested"] });

  const { groups } = detectContradictions(detectionPool);
  const contestedIds = new Set(groups.filter((group) => group.resolution === "contested").flatMap((group) => group.factIds));
  // Both genuinely-contested facts and any stranded in the status after their rival was forgotten or
  // edited away. The latter are cleared automatically by the next `mem epoch --gc` reconciliation,
  // and immediately by `--promote`; either way they are withheld right now, so they belong here.
  const contested = detectionPool.filter((fact) => contestedIds.has(fact.id) || fact.status === "contested");
  const contestedShownIds = new Set(contested.map((fact) => fact.id));
  const groundTruth = detectionPool.filter((fact) => !contestedShownIds.has(fact.id));

  // `anchorRootFor`, not the bare caller root: a project-scoped fact carries the root its anchor is
  // meaningful relative to, and evaluating it against wherever `mem review` happened to be run
  // resolves the predicate inside an unrelated checkout. That produced a confident `contradicted`
  // for a perfectly valid fact -- listed here, under the one heading that invites the user to forget
  // it, while `mem recall` simultaneously affirmed the same fact. Retrieval has resolved roots this
  // way since the scope_root fix; review is the path that fix did not reach.
  const contradicted = groundTruth.filter(
    (fact) => !contestedIds.has(fact.id) && evaluateAnchor(fact.anchor, anchorRootFor(fact, root)) === "contradicted"
  );

  const now = Date.now();
  const pinsDue = groundTruth.filter((fact) => {
    if (fact.status !== "pinned") {
      return false;
    }
    const ageDays = (now - Date.parse(statusChangedAt(fact))) / MS_PER_DAY;
    return Number.isFinite(ageDays) && ageDays >= PIN_RECONFIRM_DAYS;
  });

  // An anchorless fact short-circuits to `unverified` (anchors.ts), so it can never reach the
  // `contradicted` bucket above and, before this bucket existed, reached no bucket at all — it was
  // invisible to both `mem review` and `mem doctor` no matter how stale it had become. Nominating
  // only facts that actually name a checkable target keeps this a short, actionable list rather
  // than a restatement of "everything without an anchor".
  const unanchored = groundTruth.filter(
    (fact) =>
      !contestedIds.has(fact.id) &&
      (fact.anchor === null || fact.anchor.trim().length === 0) &&
      UNANCHORED_ELIGIBLE_KINDS.has(fact.kind) &&
      mentionsAnchorableTarget(fact.text)
  );

  // `pending` is already narrowed at its own query and takes no part in contradiction detection, so
  // it needs no second pass; every other bucket is derived from the unfiltered detection pool and is
  // narrowed here.
  const withinEpoch = (fact: Fact): boolean => options.sinceEpoch === undefined || (fact.epoch ?? 0) > options.sinceEpoch;
  const buckets: Record<ReviewSection, readonly Fact[]> = {
    pending,
    contested: contested.filter(withinEpoch),
    contradicted: contradicted.filter(withinEpoch),
    pins: pinsDue.filter(withinEpoch),
    unanchored: unanchored.filter(withinEpoch),
  };
  const shown: readonly ReviewSection[] = options.section !== undefined ? [options.section] : REVIEW_SECTIONS;

  if (options.summary === true) {
    return shown.map((name) => `${name}: ${buckets[name].length}`).join(", ");
  }

  const sections = shown.map((name) => formatSection(REVIEW_SECTION_TITLES[name], buckets[name])).filter((section) => section.length > 0);

  return sections.length === 0 ? "nothing needs review" : sections.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────── epoch / retention pass ───────────────────────────────────────────────────────────────────────────

/** Section 6: "superseded facts and offloaded sources are GC'd after N days or M rows (whichever first)." */
const GC_SUPERSEDED_MAX_AGE_DAYS = 90;
const GC_SUPERSEDED_MAX_ROWS = 1000;
const GC_SOURCES_MAX_AGE_DAYS = 90;
/**
 * Section 6: "Audit log rotates." Deliberately an *independent* retention window from the
 * superseded-fact/sources GC bounds above -- and intentionally longer -- so that pruning a fact or
 * its source excerpts never silently prunes the audit history describing how that fact was
 * captured, edited, contradicted, and eventually GC'd. Audit rows outlive the rows they describe
 * (design principle 5: "No black box"); only age rotates them, never a fact-side GC decision.
 */
const GC_AUDIT_LOG_MAX_AGE_DAYS = 180;
/**
 * The recall log (`recall_log`: which facts were surfaced to which hook session) is session
 * bookkeeping, not history: its only reader is a `--delta` recall for the *same* session id, and a
 * coding-tool session does not live for weeks. Same age-only shape as the audit-log window above,
 * with a shorter horizon because nothing consults these rows once their session is over.
 */
const GC_RECALL_LOG_MAX_AGE_DAYS = 30;

/**
 * Runs the retention/GC pass (design plan Section 6): persists deterministic contradiction
 * resolutions over the live ground-truth pool (pinned facts included -- S8), reports (never rewrites)
 * preference decay, prunes superseded facts and offloaded sources past their GC bounds, and rotates
 * the audit log. Gated behind `mem epoch --gc` rather than running on every plain `mem epoch` call:
 * the design plan's Section 4 explicitly defines `mem epoch` as token-goat's cheap, frequently-polled
 * fallback-cache-invalidation read ("a monotonic mem epoch ... readable via `mem epoch`") -- doing
 * write-heavy GC work on every read would defeat that contract.
 */
function runRetentionPass(db: Database.Database): string {
  const now = new Date();

  // Includes persisted-`contested` facts, so this pass both detects new contradictions and clears
  // stale ones: a fact whose rival has since been forgotten or edited into agreement is reinstated
  // (to `pinned` where it was pinned before) instead of staying withheld forever.
  const updates = reconcileContradictions(db, "epoch_contradiction");

  const preferences = listFacts(db, { kind: "preference", status: "active" });
  // The single definition of the decay curve, shared with `recall`'s correctness gate -- this pass
  // reports only, and must report on exactly the facts recall will actually downgrade.
  const decayedCount = preferences.filter((fact) => isDecayedBelowGroundTruth(fact, now)).length;

  const supersededCutoff = new Date(now.getTime() - GC_SUPERSEDED_MAX_AGE_DAYS * MS_PER_DAY).toISOString();
  // Ordered and cut by when each fact *became* superseded, not when it was captured. Keying the
  // 90-day window on `captured_at` deleted a fact superseded yesterday purely because it had been
  // captured 91 days ago -- destroying the audit trail the soft delete exists to preserve -- and
  // made the 1000-row cap keep the most recently *authored* facts rather than the most recently
  // superseded ones.
  const superseded = [...listFacts(db, { status: "superseded" })].sort((a, b) =>
    statusChangedAt(b).localeCompare(statusChangedAt(a))
  );
  let prunedFacts = 0;
  superseded.forEach((fact, index) => {
    if (statusChangedAt(fact) < supersededCutoff || index >= GC_SUPERSEDED_MAX_ROWS) {
      if (deleteFact(db, fact.id)) {
        prunedFacts += 1;
      }
    }
  });

  const sourcesCutoff = new Date(now.getTime() - GC_SOURCES_MAX_AGE_DAYS * MS_PER_DAY).toISOString();
  const prunedSources = deleteSourcesOlderThan(db, sourcesCutoff);

  const auditCutoff = new Date(now.getTime() - GC_AUDIT_LOG_MAX_AGE_DAYS * MS_PER_DAY).toISOString();
  const prunedAuditRows = db.prepare("DELETE FROM audit_log WHERE created_at < ?").run(auditCutoff).changes;

  const recallLogCutoff = new Date(now.getTime() - GC_RECALL_LOG_MAX_AGE_DAYS * MS_PER_DAY).toISOString();
  const prunedRecallLogRows = deleteRecallLogOlderThan(db, recallLogCutoff);

  const epoch = getEpoch(db);
  return (
    `epoch=${epoch}  contradictions_resolved=${updates.length}  preferences_decayed_below_floor=${decayedCount}  ` +
    `pruned_superseded_facts=${prunedFacts}  pruned_sources=${prunedSources}  pruned_audit_log_rows=${prunedAuditRows}  ` +
    `pruned_recall_log_rows=${prunedRecallLogRows}`
  );
}

// ─────────────────────────────────────────────────────────────────────────── Program assembly ───────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────── consolidate ───────────────────────────────────────────────────────────────────

/**
 * Audit events for the two `mem consolidate` passes. Separate strings, not one shared
 * `"consolidate"`: the audit log is the only record of *why* a fact was superseded, and "it
 * restated fact X" and "nothing ever read it" are different reasons that a later reader must be
 * able to tell apart without re-deriving them.
 */
const CONSOLIDATE_DUPLICATE_EVENT = "consolidate_duplicate";
const CONSOLIDATE_STALE_EVENT = "consolidate_stale";

function parseThreshold(raw: string): number {
  const value = Number.parseFloat(raw);
  // `0` is rejected along with the out-of-range values: every pair of facts with any topics at all
  // clears a threshold of 0, so it would not mean "loosest" -- it would mean "collapse the store".
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new UsageError(`--threshold must be a number greater than 0 and at most 1 (got "${raw}")`);
  }
  return value;
}

function parseStaleDays(raw: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new UsageError(`--stale-days must be a whole number of days, at least 1 (got "${raw}")`);
  }
  return value;
}

/**
 * The one line every applied pass ends on. Says where the superseded facts went in commands the
 * user can actually run, because "reversible" is a claim, and an unbacked claim about a destructive
 * operation is worse than no claim.
 */
const CONSOLIDATE_REVERSIBLE_NOTE =
  "superseded facts stay in the store -- `mem list --status superseded`, `mem show <id>`, " +
  "`mem export --status superseded` -- and every change is in the audit log";

function formatDuplicateClusters(clusters: readonly DuplicateCluster[], threshold: number, applied: boolean): string {
  const floor = threshold.toFixed(2);
  if (clusters.length === 0) {
    return `no duplicate clusters at Jaccard >= ${floor} over topic terms`;
  }
  const lines: string[] = [];
  const total = clusters.reduce((sum, cluster) => sum + cluster.duplicates.length, 0);
  lines.push(
    `${clusters.length} duplicate cluster${clusters.length === 1 ? "" : "s"} at Jaccard >= ${floor} over topic terms` +
      (applied ? "" : " (dry run, nothing changed)")
  );
  clusters.forEach((cluster, index) => {
    lines.push("");
    lines.push(`cluster ${index + 1}`);
    lines.push(`  keep    ${formatFactSummary(cluster.keep)}`);
    for (const member of cluster.duplicates) {
      lines.push(`  ${member.similarity.toFixed(2)}    ${formatFactSummary(member.fact)}`);
    }
    for (const pinned of cluster.retainedPinned) {
      // Listed, but as an explicit non-action: a pinned duplicate is part of the cluster the user
      // is being shown, and silently dropping it would make the cluster look smaller than it is.
      lines.push(`  pinned  ${formatFactSummary(pinned)}  (left alone)`);
    }
  });
  lines.push("");
  lines.push(
    applied
      ? `superseded ${total} ${total === 1 ? "fact as a duplicate" : "facts as duplicates"}; ${CONSOLIDATE_REVERSIBLE_NOTE}`
      : `${total} fact${total === 1 ? "" : "s"} would be superseded -- re-run with --apply to act`
  );
  return lines.join("\n");
}

function formatStaleFacts(facts: readonly Fact[], cutoffIso: string, ageDays: number, applied: boolean): string {
  const window = `older than ${ageDays} day${ageDays === 1 ? "" : "s"}`;
  if (facts.length === 0) {
    return `no stale facts ${window}`;
  }
  const lines: string[] = [];
  lines.push(
    `${facts.length} stale fact${facts.length === 1 ? "" : "s"}: active, captured before ${cutoffIso}, ` +
      `never surfaced by recall, never marked used` +
      (applied ? "" : " (dry run, nothing changed)")
  );
  lines.push("");
  for (const fact of facts) {
    lines.push(`  captured ${fact.captured_at}  ${formatFactSummary(fact)}`);
  }
  lines.push("");
  lines.push(
    applied
      ? `superseded ${facts.length} stale fact${facts.length === 1 ? "" : "s"}; ${CONSOLIDATE_REVERSIBLE_NOTE}`
      : `re-run with --apply to supersede ${facts.length === 1 ? "it" : "them"}`
  );
  return lines.join("\n");
}

interface ConsolidateCliOptions {
  readonly apply?: boolean;
  readonly threshold?: string;
  readonly stale?: boolean;
  readonly staleDays?: string;
}

/**
 * `mem consolidate` in full: pick the pass, run it read-only, and -- only under `--apply` -- route
 * every loser through `setStatusWithAudit` so the transition is transactional and audit-logged.
 *
 * The two passes deliberately share one command rather than joining `mem epoch --gc`. That pass is
 * the non-interactive retention job a polling consumer may run unattended; giving it the power to
 * supersede *active* facts would make an existing, already-wired invocation newly destructive with
 * no dry run in front of it. `mem consolidate` is the opposite contract: nothing happens until a
 * human has seen the listing and typed `--apply`.
 */
function runConsolidate(db: Database.Database, options: ConsolidateCliOptions, now: Date): string {
  const stale = options.stale === true;
  const applied = options.apply === true;
  // Each flag belongs to exactly one pass and they do not compose (`mem facets` takes the same
  // line): silently ignoring the one that does not apply would make it look honoured.
  if (stale && options.threshold !== undefined) {
    throw new UsageError("--threshold applies to the duplicate pass; --stale is bounded by --stale-days");
  }
  if (!stale && options.staleDays !== undefined) {
    throw new UsageError("--stale-days applies to --stale; the duplicate pass is bounded by --threshold");
  }

  if (stale) {
    const ageDays = options.staleDays !== undefined ? parseStaleDays(options.staleDays) : DEFAULT_STALE_AGE_DAYS;
    const cutoff = staleCutoff(ageDays, now);
    const facts = findStaleFacts(db, cutoff);
    if (applied) {
      for (const fact of facts) {
        setStatusWithAudit(
          db,
          fact.id,
          "superseded",
          CONSOLIDATE_STALE_EVENT,
          `superseded as stale: captured ${fact.captured_at}, never surfaced by recall, never marked used`
        );
      }
    }
    return formatStaleFacts(facts, cutoff, ageDays, applied);
  }

  const threshold = options.threshold !== undefined ? parseThreshold(options.threshold) : DEFAULT_DUPLICATE_THRESHOLD;
  const clusters = findDuplicateClusters(db, threshold);
  if (applied) {
    for (const cluster of clusters) {
      for (const member of cluster.duplicates) {
        setStatusWithAudit(
          db,
          member.fact.id,
          "superseded",
          CONSOLIDATE_DUPLICATE_EVENT,
          `${SUPERSEDED_AS_DUPLICATE_PREFIX}${cluster.keep.id} (Jaccard ${member.similarity.toFixed(2)} over topic terms)`
        );
      }
    }
  }
  return formatDuplicateClusters(clusters, threshold, applied);
}

interface RememberCliOptions {
  readonly kind: string;
  readonly subject?: string;
  readonly value?: string;
  readonly anchor?: string;
  readonly scope: string;
  readonly sourceRef?: string;
  readonly root?: string;
  readonly path?: string;
}

interface ImportCliOptions {
  readonly fromMd?: string;
  readonly fromJson?: string;
  readonly root?: string;
  readonly scope?: string;
  readonly kind?: string;
  readonly dryRun?: boolean;
  readonly path?: string;
}

/**
 * `--scope path` and `--path` are required together: a `scope="path"` fact with no `--path` binds
 * to `root` itself (the exact bug this pairing exists to close -- a "path" fact behaving as a
 * "project" fact), and a bare `--path` with no `--scope path` is a flag the caller almost certainly
 * meant to pair but did not, so it is rejected rather than silently ignored.
 */
function validateScopePathPairing(rawScope: string | undefined, rawPath: string | undefined): void {
  if (rawScope === "path" && rawPath === undefined) {
    throw new UsageError("--scope path requires --path <file-or-dir>");
  }
  if (rawScope !== "path" && rawPath !== undefined) {
    throw new UsageError("--path requires --scope path");
  }
}

interface RecallCliOptions {
  readonly kind?: string;
  readonly subject?: string;
  readonly scope?: string;
  readonly hintFormat?: boolean;
  readonly contextFiles?: string;
  readonly ageDays?: number;
  readonly limit?: number;
  readonly root?: string;
  readonly stable?: boolean;
  readonly hintStyle?: string;
  readonly sinceEpoch?: number;
  readonly hookStdin?: boolean;
  readonly delta?: boolean;
  readonly sessionId?: string;
  readonly entity?: readonly string[];
}

interface FacetsCliOptions {
  readonly backfill?: boolean;
  readonly all?: boolean;
  readonly fact?: string;
  readonly listEntities?: boolean;
}

/** Commander's collector for a repeatable option: appends each occurrence instead of keeping only the last. */
function collectRepeated(value: string, previous: readonly string[]): string[] {
  return [...previous, value];
}

interface ExportCliOptions {
  readonly kind?: string;
  readonly status?: string;
  readonly subject?: string;
  readonly scope?: string;
}

interface ListCliOptions {
  readonly kind?: string;
  readonly status?: string;
  readonly subject?: string;
  readonly scope?: string;
  readonly limit?: number;
  readonly json?: boolean;
}

interface ShowCliOptions {
  readonly root?: string;
  readonly json?: boolean;
}

interface EditCliOptions {
  readonly text?: string;
  readonly subject?: string;
  readonly value?: string;
  readonly anchor?: string;
  readonly scope?: string;
  readonly root?: string;
  readonly path?: string;
}

interface ReviewCliOptions {
  readonly promote?: string;
  readonly reject?: string;
  readonly root?: string;
  readonly summary?: boolean;
  readonly section?: string;
  readonly sinceEpoch?: number;
}

interface EmbedCliOptions {
  readonly all?: boolean;
  readonly limit?: number;
}

interface EpochCliOptions {
  readonly gc?: boolean;
}

interface UsedCliOptions {
  readonly sessionId?: string;
}

interface InitCliOptions {
  readonly root?: string;
  readonly user?: boolean;
  readonly dryRun?: boolean;
}

interface UninstallCliOptions {
  readonly all?: boolean;
  readonly root?: string;
  readonly user?: boolean;
  readonly dryRun?: boolean;
}

/** `TOKEN_GOAT_MEM_WIRING_HOME` overrides the home directory user-level wiring (Claude Code's user `settings.json`, VS Code's user `keybindings.json`) resolves under -- same override-for-tests purpose as `TOKEN_GOAT_MEM_HOME` in db.ts, kept as a separate variable since it names a different directory (a coding tool's home, not mem's own data home). */
function toWiringOpts(options: { readonly root?: string; readonly user?: boolean }): WiringOpts {
  const homeOverride = process.env["TOKEN_GOAT_MEM_WIRING_HOME"];
  return {
    ...(options.root !== undefined ? { root: options.root } : {}),
    ...(options.user === true ? { user: true } : {}),
    ...(typeof homeOverride === "string" && homeOverride.trim().length > 0 ? { homeDir: homeOverride } : {}),
  };
}

/** Builds the Commander program. Exported so tests can introspect/parse it without going through `process.argv`. */
/** Replaced at build time by esbuild's `define` with package.json's version. Declared (not imported) so the bundle stays a single file with no runtime JSON read; `typeof` on an undeclared identifier is safe in JS, so an unbundled `tsx src/main.ts` dev run falls back instead of throwing. */
declare const __MEM_VERSION__: string | undefined;

/** The version `mem --version` reports. Never hand-edit: it comes from package.json via the build. The `-dev` fallback only appears when running from source without the bundler. */
const CLI_VERSION: string = typeof __MEM_VERSION__ === "string" ? __MEM_VERSION__ : "0.0.0-dev";

/**
 * Shared because `remember` and `suggest` must describe the key identically -- two wordings drift,
 * and this one carries an invariant the user cannot otherwise discover.
 *
 * A subject holds exactly one value at a time. `detectContradictions` treats every keyed subject as
 * single-valued by design (that determinism is the point), so capturing a second value against the
 * same subject is read as a correction and supersedes the first rather than adding to a set. A user
 * recording set membership -- supported versions, enabled flags -- wants a distinct subject per
 * member, and nothing but this string tells them so before the first value is silently superseded.
 */
const SUBJECT_KEY_HELP =
  "Normalized key for contradiction detection; holds one value at a time, so a later --value " +
  "supersedes the earlier rather than joining it (requires --value)";

export function buildProgram(): Command {
  const program = new Command();
  program.name("mem").description("Long-term conversational memory for AI coding agents").version(CLI_VERSION);

  program
    .command("remember <text>")
    .description("Explicit capture: store a user-stated fact into active storage")
    .requiredOption("--kind <kind>", `preference, decision, fact, or correction`)
    .option("--subject <key>", SUBJECT_KEY_HELP)
    .option("--value <value>", "Value for the subject (requires --subject)")
    .option("--anchor <predicate>", "Read-only anchor predicate (filesystem/git)")
    .option("--scope <scope>", "global, project, or path", "global")
    .option("--source-ref <ref>", "Reference to the originating conversation/message")
    .option("--root <path>", "Project root for .mem/allowlist and scope binding (default: current directory)")
    .option("--path <file>", "File or directory this fact is bound to, resolved against --root (required when --scope path, rejected otherwise)")
    .action(
      guard(async (text: string, options: RememberCliOptions) => {
        validateScopePathPairing(options.scope, options.path);
        const kind = parseFactKind(options.kind);
        const scope = parseFactScope(options.scope);
        const root = resolveRoot(options.root);
        const input: CaptureExplicitInput = {
          text,
          kind,
          scope,
          root,
          ...(options.subject !== undefined ? { subject: options.subject } : {}),
          ...(options.value !== undefined ? { value: options.value } : {}),
          ...(options.anchor !== undefined ? { anchor: options.anchor } : {}),
          ...(options.sourceRef !== undefined ? { sourceRef: options.sourceRef } : {}),
          ...(options.path !== undefined ? { path: options.path } : {}),
        };
        const { fact } = await withDb((db) => captureExplicit(db, input));
        process.stdout.write(`remembered ${factNounPhrase(fact.kind)} ${fact.id}\n`);
        await attachEmbeddingBestEffort(fact);
      })
    );

  program
    .command("suggest <text>")
    .description(
      "Suggested capture: propose a candidate fact into pending storage -- never auto-promoted, same trust " +
        "path as any other suggested/derived fact (confirm via `mem review --promote <id>`)"
    )
    .requiredOption("--kind <kind>", `preference, decision, fact, or correction`)
    .option("--subject <key>", SUBJECT_KEY_HELP)
    .option("--value <value>", "Value for the subject (requires --subject)")
    .option("--anchor <predicate>", "Read-only anchor predicate (filesystem/git)")
    .option("--scope <scope>", "global, project, or path", "global")
    .option("--source-ref <ref>", "Reference to the originating conversation/message")
    .option("--root <path>", "Project root for .mem/allowlist and scope binding (default: current directory)")
    .option("--path <file>", "File or directory this fact is bound to, resolved against --root (required when --scope path, rejected otherwise)")
    .action(
      guard(async (text: string, options: RememberCliOptions) => {
        validateScopePathPairing(options.scope, options.path);
        const kind = parseFactKind(options.kind);
        const scope = parseFactScope(options.scope);
        const root = resolveRoot(options.root);
        const input: CaptureSuggestedInput = {
          text,
          kind,
          scope,
          root,
          ...(options.subject !== undefined ? { subject: options.subject } : {}),
          ...(options.value !== undefined ? { value: options.value } : {}),
          ...(options.anchor !== undefined ? { anchor: options.anchor } : {}),
          ...(options.sourceRef !== undefined ? { sourceRef: options.sourceRef } : {}),
          ...(options.path !== undefined ? { path: options.path } : {}),
        };
        const { fact } = await withDb((db) => captureSuggested(db, input));
        process.stdout.write(`suggested ${factNounPhrase(fact.kind)} ${fact.id} (pending)\n`);
        await attachEmbeddingBestEffort(fact);
      })
    );

  program
    .command("export")
    .description("Export stored facts as a full-fidelity JSON envelope, for `mem import --from-json`")
    .option("--kind <kind>", "Filter by kind")
    .option("--status <status>", "Filter by status (comma-separated for multiple)")
    .option("--subject <key>", "Filter by subject")
    .option("--scope <scope>", "Filter by scope")
    .action(
      guard(async (options: ExportCliOptions) => {
        const filter: FactFilter = {
          ...(options.kind !== undefined ? { kind: parseFactKind(options.kind) } : {}),
          ...(options.status !== undefined ? { status: parseFactStatusList(options.status) } : {}),
          ...(options.subject !== undefined ? { subject: options.subject } : {}),
          ...(options.scope !== undefined ? { scope: parseFactScope(options.scope) } : {}),
        };
        const facts = await withDb((db) => listFacts(db, filter));
        const envelope = {
          schemaVersion: JSON_EXPORT_SCHEMA_VERSION,
          exportedAt: new Date().toISOString(),
          facts: facts.map((fact) => factToExportJson(fact)),
        };
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      })
    );

  program
    .command("import")
    .description(
      "Import facts from either a markdown file (--from-md, advisory: bullets always land pending, never " +
        "auto-promoted) or a JSON export (--from-json, full-fidelity: preserves original id/status/confidence/" +
        "captured_at, safe to re-run idempotently) -- exactly one of the two is required"
    )
    .option("--from-md <path>", "Markdown file (CLAUDE.md-style) to import preference/decision-shaped bullets from, always as pending facts")
    .option("--from-json <path>", "JSON file produced by `mem export` to import full-fidelity (id, status, confidence, captured_at preserved)")
    .option("--root <path>", "Project root for .mem/allowlist and scope binding (default: current directory)")
    .option("--scope <scope>", "--from-md only: global, project, or path", "project")
    .option("--kind <kind>", "--from-md only: preference, decision, fact, or correction", "preference")
    .option("--path <file>", "--from-md only: file or directory this fact is bound to, resolved against --root (required when --scope path, rejected otherwise)")
    .option("--dry-run", "Report what would be imported without writing anything")
    .action(
      guard(async (options: ImportCliOptions) => {
        const hasFromMd = options.fromMd !== undefined;
        const hasFromJson = options.fromJson !== undefined;
        if (hasFromMd === hasFromJson) {
          throw new UsageError("import requires exactly one of --from-md or --from-json");
        }
        validateScopePathPairing(options.scope, options.path);
        const dryRun = options.dryRun === true;

        // --dry-run opens no database on purpose in either mode: openDb() would mkdirSync + create
        // the db file, WAL sidecars, and schema on disk, which contradicts --dry-run's "nothing
        // written". Both plan* functions need only the source file, no db.
        if (hasFromJson) {
          const fromJson = options.fromJson;
          const result = dryRun
            ? planImportFromJson({ path: fromJson })
            : await withDb((db) => importFromJson(db, { path: fromJson, root: resolveRoot(options.root) }));
          process.stdout.write(`${formatImportResult(result, dryRun)}\n`);
          return;
        }

        const fromMd = options.fromMd as string;
        const root = resolveRoot(options.root);
        const scope = options.scope !== undefined ? parseFactScope(options.scope) : undefined;
        const kind = options.kind !== undefined ? parseFactKind(options.kind) : undefined;
        const result = dryRun
          ? planImportFromMarkdown({ path: fromMd })
          : await withDb((db) =>
              importFromMarkdown(db, {
                path: fromMd,
                root,
                ...(scope !== undefined ? { scope } : {}),
                ...(kind !== undefined ? { kind } : {}),
                ...(options.path !== undefined ? { boundPath: options.path } : {}),
              })
            );
        process.stdout.write(`${formatImportResult(result, dryRun)}\n`);
      })
    );

  program
    .command("recall [query]")
    .description("Retrieve facts by relevance, with trust levels and freshness verdicts")
    .option("--kind <kind>", "Filter by kind")
    .option("--subject <key>", "Filter by subject")
    .option("--scope <scope>", "Filter by scope")
    .option(
      "--entity <value>",
      "Only facts carrying this extracted entity (file path, flag, constant, version, identifier), matched case-insensitively. Repeatable, and repeats AND together: --entity src/cli.ts --entity --hint-format keeps only facts mentioning both. See `mem facets --list-entities`",
      collectRepeated,
      [] as readonly string[]
    )
    .option("--hint-format", "Emit the TGMEM/2 wire format for the token-goat seam")
    .option("--context-files <files>", "Comma-separated file paths for scope=path matching (--hint-format only)")
    .option("--age-days <days>", "Only facts captured within this many days", (v) => parseInt(v, 10))
    .option("--limit <n>", "Limit non-withheld results (default 20; pending/contested/contradicted facts are never subject to this cap)", (v) => parseInt(v, 10))
    .option("--root <path>", "Project root for anchor evaluation")
    .option("--stable", "Force deterministic id-sorted output ordering instead of relevance/recency order")
    .option("--hint-style <full|terse>", "Display verbosity: full (default, unchanged) or terse (no CTA, short kind labels)", "full")
    .option("--since-epoch <n>", "Only include facts with epoch greater than n (see `mem epoch`)", (v) => parseInt(v, 10))
    .option("--hook-stdin", "Read a coding-tool hook's JSON envelope from stdin: its session_id becomes the session id and its prompt the query (--hint-format only; fails open to no query)")
    .option("--session-id <id>", "Session id to log surfaced facts under, and for --delta to filter against (--hint-format only; overrides the envelope's session_id)")
    .option("--delta", "Emit only facts not already surfaced to this session id; header becomes `TGMEM/2  delta=1` (--hint-format only; requires --hook-stdin or --session-id)")
    .action(
      guard(async (query: string | undefined, options: RecallCliOptions) => {
        const hintStyle = options.hintStyle !== undefined ? parseHintStyle(options.hintStyle) : "full";

        if (options.limit !== undefined && (!Number.isFinite(options.limit) || options.limit < 1)) {
          throw new UsageError("--limit must be a positive integer");
        }

        if (options.ageDays !== undefined && (!Number.isFinite(options.ageDays) || options.ageDays <= 0)) {
          throw new UsageError("--age-days must be a positive number");
        }

        if (options.sinceEpoch !== undefined && (!Number.isFinite(options.sinceEpoch) || options.sinceEpoch < 0)) {
          throw new UsageError("--since-epoch must be a non-negative integer");
        }

        if (options.contextFiles !== undefined && options.hintFormat !== true) {
          throw new UsageError("--context-files requires --hint-format");
        }
        if (options.hintFormat !== true) {
          if (options.hookStdin === true) {
            throw new UsageError("--hook-stdin requires --hint-format");
          }
          if (options.sessionId !== undefined) {
            throw new UsageError("--session-id requires --hint-format");
          }
          if (options.delta === true) {
            throw new UsageError("--delta requires --hint-format");
          }
        }
        if (options.sessionId !== undefined && options.sessionId.trim().length === 0) {
          throw new UsageError("--session-id must not be empty");
        }
        // Delta is opt-in per call and needs a session to be relative to. Without one there is nothing
        // to subtract, and silently answering with a full block would hand the caller a response whose
        // header says what it is -- but not what it was asked for.
        if (options.delta === true && options.sessionId === undefined && options.hookStdin !== true) {
          throw new UsageError("--delta requires a session id: pass --hook-stdin (session_id from the hook envelope) or --session-id <id>");
        }

        if (options.hintFormat === true) {
          const incompatibleFlags = [];
          if (options.kind !== undefined) {
            incompatibleFlags.push("--kind");
          }
          if (options.subject !== undefined) {
            incompatibleFlags.push("--subject");
          }
          if (options.scope !== undefined) {
            incompatibleFlags.push("--scope");
          }
          if (options.ageDays !== undefined) {
            incompatibleFlags.push("--age-days");
          }
          if (options.limit !== undefined) {
            incompatibleFlags.push("--limit");
          }
          if (options.sinceEpoch !== undefined) {
            incompatibleFlags.push("--since-epoch");
          }
          if (options.entity !== undefined && options.entity.length > 0) {
            incompatibleFlags.push("--entity");
          }

          if (incompatibleFlags.length > 0) {
            throw new UsageError(
              `--hint-format cannot be combined with ${incompatibleFlags.join("/")}; pass only --hint-format, an optional query, --root, --context-files, --stable, and --hint-style`
            );
          }

          if (typeof options.root !== "string" || options.root.trim().length === 0) {
            throw new UsageError("recall --hint-format requires --root <path>");
          }
          const contextFiles = parseContextFiles(options.contextFiles);
          const envelope: HookEnvelope = options.hookStdin === true ? await readHookEnvelope() : {};
          // The envelope's prompt is what the user just asked, so it outranks a positional query the
          // hook command may have baked in; an explicit --session-id likewise outranks the envelope.
          const effectiveQuery = envelope.prompt ?? (query !== undefined && query !== "" ? query : undefined);
          const sessionId = options.sessionId ?? envelope.sessionId;
          if (options.delta === true && sessionId === undefined) {
            // Only reachable via --hook-stdin (the usage check above covers the rest): the envelope
            // arrived without a session_id. A hook must not exit non-zero over that, and a full
            // block is a superset of the delta the caller asked for, so degrade to it -- but say so.
            err("mem: --delta ignored: the hook envelope on stdin carried no session_id; returning the full hint set");
          }
          const hintOptions: HintFormatOptions = {
            root: options.root,
            ...(retrievalBudgetOverride() !== undefined ? { retrievalBudgetMs: retrievalBudgetOverride() } : {}),
            ...(effectiveQuery !== undefined ? { query: effectiveQuery } : {}),
            ...(contextFiles !== undefined ? { contextFiles } : {}),
            ...(options.stable === true ? { stable: true } : {}),
            ...(hintStyle !== "full" ? { hintStyle } : {}),
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(options.delta === true && sessionId !== undefined ? { delta: true } : {}),
          };
          const result = await buildHintFormat(hintOptions);
          process.stdout.write(`${result.header}\n`);
          for (const line of result.lines) {
            process.stdout.write(`${line}\n`);
          }
          return;
        }

        const root = resolveRoot(options.root);
        // The whole store, unfiltered. `--since-epoch` is deliberately NOT applied here: `retrieve`
        // resolves contradictions across its entire input pool before any filter runs, and a
        // pre-filtered pool is a partial one -- the reinstatement pass then reads a rival's absence
        // as "nothing left to contest this" and un-contests the survivor. Narrowing in SQL therefore
        // surfaced a genuinely contested fact as clean ground truth. The bound now rides in
        // `RetrievalOptions.epochAfter` with every other filter, applied after resolution.
        // Both reads share one connection: `openStorage` is not free (WAL open plus the schema
        // migrations `ensureStorageSchema` runs), and splitting them would pay that twice per recall.
        const wantedEntities = options.entity ?? [];
        const { facts, usefulness, embeddingMeta, entityKeys } = await withDb((db) => ({
          facts: listFacts(db, {}),
          usefulness: getUsefulnessCounts(db),
          embeddingMeta: getEmbeddingMeta(db) ?? null,
          // Read only when something asks for it: this is a full scan of `fact_terms`, and every
          // recall that passes no `--entity` would pay for a map nothing reads.
          entityKeys: wantedEntities.length > 0 ? getEntityKeysByFact(db) : null,
        }));
        // `null` unless the user configured an embeddings endpoint, in which case ranking fuses a
        // dense list alongside BM25. `planEmbeddingRanking` withholds the backend when the store's
        // vectors came from a different model, because `cosineSimilarity` would compare the two
        // vector spaces without complaint and rank on noise.
        const embeddingPlan = planEmbeddingRanking(embeddingMeta, process.env, { timeoutMs: DEFAULT_EMBEDDING_TIMEOUT_MS });
        const retrievalOptions: RetrievalOptions = {
          // Past `mem used` confirmations, fused as a third RRF rank list (see
          // RetrievalOptions.usefulness). Empty on a store nobody has ever run `mem used` against,
          // in which case the ranking is byte-for-byte today's BM25 ordering.
          usefulness,
          query: query ?? "",
          root,
          // Facts bind to the project they were captured in. Without this, `--root` reached only
          // anchor evaluation and `--scope project` matched the scope *label* rather than the
          // binding, so `mem recall --root . --scope project` run in one project surfaced another
          // project's decisions. `global` facts are unaffected; see RetrievalOptions.restrictToRoot
          // for why this is a filter inside `retrieve` rather than a narrower `listFacts` query.
          restrictToRoot: true,
          ...(options.kind !== undefined ? { kind: parseFactKind(options.kind) } : {}),
          ...(options.subject !== undefined ? { subject: options.subject } : {}),
          ...(options.scope !== undefined ? { scope: parseFactScope(options.scope) } : {}),
          ...(options.ageDays !== undefined && Number.isFinite(options.ageDays) ? { ageDays: options.ageDays } : {}),
          ...(options.limit !== undefined && Number.isFinite(options.limit) ? { limit: options.limit } : {}),
          ...(options.sinceEpoch !== undefined && Number.isFinite(options.sinceEpoch) ? { epochAfter: options.sinceEpoch } : {}),
          // Both halves ride into `retrieve` rather than narrowing `listFacts` above, for the reason
          // `RetrievalOptions.entities` documents: an entity-narrowed pool hides a contested fact's
          // rival from `resolveContradictions`, which then reinstates the survivor and surfaces it
          // as clean ground truth.
          ...(wantedEntities.length > 0 && entityKeys !== null ? { entities: wantedEntities, factEntityKeys: entityKeys } : {}),
          ...(hintStyle !== "full" ? { hintStyle } : {}),
          // Default (full) output drops the per-line CTA in favor of one shared trailing footer
          // line, printed below when results were shown (mirrors integration-seam.ts's TGMEM/2
          // footer precedent) -- terse already omits the CTA on its own, so nothing to override.
          ...(hintStyle !== "terse" ? { includeDisplayCta: false } : {}),
          ...(embeddingPlan.backend !== null ? { embeddingBackend: embeddingPlan.backend } : {}),
        };
        const { results, totalNonWithheld, shownNonWithheld, anchorBudgetHits } = await retrieve(facts, retrievalOptions);
        // Printed before the results rather than after: it is a caveat on the ranking that produced
        // them, and it has to appear on the empty listing below too -- silently ranking lexically
        // while the user believes their configured endpoint is in play is the failure this guards.
        if (embeddingPlan.incomparable !== null) {
          process.stdout.write(`note: embedding search skipped -- ${embeddingPlan.incomparable}\n`);
        }
        if (results.length === 0) {
          process.stdout.write("no matching facts\n");
          return;
        }
        // --stable is a strictly-additive output-ordering override: same facts, same caps, just a
        // deterministic id order instead of the default relevance/recency order.
        const ordered = options.stable === true ? [...results].sort((a, b) => a.fact.id.localeCompare(b.fact.id)) : results;
        // A query is a *ranking* input, not a filter: BM25 orders the candidate set and never
        // removes from it, so `results.length === 0` above cannot fire for a query that simply
        // matched nothing -- only for one whose filters excluded everything. Without the line
        // below, `mem recall xyzzy` on a three-fact store returns all three facts in an output
        // byte-identical to `mem recall` with no query at all: the reader is shown unrelated facts
        // with no cue that their query contributed nothing to the ordering.
        //
        // Every result scoring 0 is the exact signal, and it is the documented meaning of an empty
        // query ("all candidates tie at score 0", src/retrieval.ts). It also covers the case of a
        // term so common it appears in every fact -- zero discriminating power, so "did not narrow
        // these results" is true there too, which is why the wording claims that rather than
        // claiming the term is absent.
        if (query !== undefined && query !== "" && ordered.every((result) => result.score === 0)) {
          process.stdout.write("note: query matched no fact text -- showing most recent instead\n");
        }
        for (const result of ordered) {
          process.stdout.write(`${result.fact.id.slice(0, RECALL_SHORT_ID_LENGTH)}  ${result.display}\n`);
        }
        if (hintStyle !== "terse") {
          process.stdout.write("mem show <id> for detail; mem review to resolve contested/pending\n");
        }
        if (shownNonWithheld < totalNonWithheld) {
          process.stdout.write(`showing ${shownNonWithheld} of ${totalNonWithheld} -- use --limit to see more\n`);
        }
        // Silent otherwise: a budget-limited "unverified" looks identical on the line above to a
        // genuine one, and without this an affirmed fact that silently degraded to a hint (or a
        // contradicted one withheld only by luck of the clock) gives no clue the verdict is a
        // time-budget artifact rather than a real re-check of its anchor.
        if (anchorBudgetHits > 0) {
          process.stdout.write(`note: anchor budget exhausted; ${anchorBudgetHits} freshness verdict${anchorBudgetHits === 1 ? "" : "s"} reported as unverified\n`);
        }
      })
    );

  program
    .command("list")
    .description("List fact IDs and one-line summaries, filtered by status/kind")
    .option("--kind <kind>", "Filter by kind")
    .option("--status <status>", "Filter by status (comma-separated for multiple)")
    .option("--subject <key>", "Filter by subject")
    .option("--scope <scope>", "Filter by scope")
    .option("--limit <n>", "Limit results (default 20)", (v) => parseInt(v, 10))
    .option(
      "--json",
      "Output machine-readable JSON (unstable, pre-1.0 -- shape may change; mem export is the stable machine-readable surface)"
    )
    .action(
      guard(async (options: ListCliOptions) => {
        if (options.limit !== undefined && (!Number.isFinite(options.limit) || options.limit < 1)) {
          throw new UsageError("--limit must be a positive integer");
        }
        const filter: FactFilter = {
          ...(options.kind !== undefined ? { kind: parseFactKind(options.kind) } : {}),
          ...(options.status !== undefined ? { status: parseFactStatusList(options.status) } : {}),
          ...(options.subject !== undefined ? { subject: options.subject } : {}),
          ...(options.scope !== undefined ? { scope: parseFactScope(options.scope) } : {}),
        };
        const facts = await withDb((db) => listFacts(db, filter));
        const total = facts.length;
        const effectiveLimit = options.limit !== undefined && Number.isFinite(options.limit) ? options.limit : DEFAULT_LIST_LIMIT;
        const shown = facts.slice(0, effectiveLimit);
        const truncated = total > shown.length;
        if (options.json === true) {
          const envelope = {
            schemaVersion: JSON_EXPORT_SCHEMA_VERSION,
            facts: shown.map((fact) => factToExportJson(fact, { includeEmbedding: false })),
            total,
            truncated,
          };
          process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
          return;
        }
        if (facts.length === 0) {
          // "no facts stored" is a claim about the whole store, so it must not be printed for a run
          // that only excluded everything with a filter -- `mem list --kind decision` on a store
          // full of preferences would otherwise report the store as empty, which is false and is
          // exactly the shape of failure this contract's "nothing found" outcomes exist to avoid.
          const filtered = Object.keys(filter).length > 0;
          process.stdout.write(filtered ? "no facts match these filters\n" : "no facts stored\n");
          return;
        }
        for (const fact of shown) {
          process.stdout.write(`${formatFactSummary(fact)}\n`);
        }
        if (truncated) {
          process.stdout.write(`showing ${shown.length} of ${total} -- use --limit to see more\n`);
        }
      })
    );

  program
    .command("show <id>")
    .description("Show one fact in full, including provenance and anchor freshness")
    .option("--root <path>", "Project root for anchor freshness evaluation (default: a project-scoped fact's own scope root, else the current directory)")
    .option(
      "--json",
      "Output machine-readable JSON (unstable, pre-1.0 -- shape may change; mem export is the stable machine-readable surface). Adds a freshness verdict, which mem export/mem list --json do not. Also carries a sources array, which is reserved and always empty: no capture path writes source rows, so [] here means mem records no sources at all, not that this fact has none. Carries supersededBy: the fact that replaced this one, or null when nothing did -- the fact's own status distinguishes 'not superseded' from 'superseded with no successor'."
    )
    .action(
      guard(async (id: string, options: ShowCliOptions) => {
        const output = await withDb((db) => {
          const fact = resolveIdArgOrThrow(db, id);
          // `anchorRootFor` rather than a bare `?? fact.scopeRoot` fallback. `scopeRoot` is documented
          // as an absolute project root only for `scope="project"`; for `scope="path"` it holds a
          // file, and handing a file path to an anchor predicate as its root is (in retrieval.ts's
          // own words) strictly worse than the status quo. The old fallback did exactly that, so
          // `mem show` and `mem recall` could report different freshness for the same fact -- on the
          // surface the recall footer points the user to for detail.
          const root = anchorRootFor(fact, resolveRoot(options.root));
          const freshness = evaluateAnchor(fact.anchor, root);
          const sources = listSourcesForFact(db, fact.id);
          // Only for a superseded fact: the audit log's most recent row for an active fact says
          // something else entirely (a promotion, a pin), and reading a winner id out of it would
          // be reporting an edge that does not exist.
          const winnerId = fact.status === "superseded" ? findSupersedingFactId(db, fact.id) : null;
          const edge: SupersessionEdge | null =
            winnerId === null ? null : { winnerId, winner: getFactById(db, winnerId) };
          if (options.json === true) {
            const envelope = {
              schemaVersion: JSON_EXPORT_SCHEMA_VERSION,
              fact: factToExportJson(fact, { includeEmbedding: false }),
              freshness,
              sources,
              // null covers both "not superseded" and "superseded with no successor"; the fact's own
              // status distinguishes them, so this stays one nullable field rather than two.
              supersededBy:
                edge === null
                  ? null
                  : { id: edge.winnerId, status: edge.winner?.status ?? null, text: edge.winner?.text ?? null },
            };
            return JSON.stringify(envelope, null, 2);
          }
          return formatFactDetail(fact, freshness, sources, edge);
        });
        process.stdout.write(`${output}\n`);
      })
    );

  program
    .command("forget <id>")
    .description("Soft-delete a fact (marks superseded, kept for audit) and audit-log it")
    .action(
      guard(async (id: string) => {
        const resolved = await withDb((db) => {
          const existing = resolveIdArgOrThrow(db, id);
          setStatusWithAudit(db, existing.id, "superseded", "forget", `forgot fact (was ${existing.status})`);
          return existing.id;
        });
        process.stdout.write(`forgot ${resolved}\n`);
      })
    );

  program
    .command("pin <id>")
    .description("Exempt a fact from time-decay (still subject to contradiction/anchor suppression)")
    .action(
      guard(async (id: string) => {
        const resolved = await withDb((db) => {
          const existing = resolveIdArgOrThrow(db, id);
          // Pinning is a promotion to decay-exempt ground truth, so it is gated exactly like
          // `mem review --promote`. Without this it was a side door around every withheld status:
          // an id copied out of `mem list` would launder a `pending` suggestion -- never reviewed by
          // a human, which is the one invariant `captureSuggested` hardcodes its status to protect --
          // straight into maximal trust, and would equally resurrect a `superseded` or `contested`
          // fact that recall is deliberately withholding.
          if (existing.status !== "active" && existing.status !== "pinned") {
            throw new UsageError(
              `fact ${existing.id} is ${existing.status}, not active -- only an active fact can be pinned. ` +
                (existing.status === "pending" || existing.status === "contested"
                  ? `Resolve it first with \`mem review --promote ${existing.id}\`, then pin it.`
                  : `A ${existing.status} fact is withheld from ground truth; re-capture it with \`mem remember\` if it is still true.`)
            );
          }
          setStatusWithAudit(db, existing.id, "pinned", "pin", `pinned fact (was ${existing.status})`);
          return existing.id;
        });
        process.stdout.write(`pinned ${resolved}\n`);
      })
    );

  program
    .command("used <id...>")
    .description("Record that facts recalled in a session were actually useful, feeding recall ranking")
    .option("--session-id <id>", "Session whose recall to mark (the same session id the facts were surfaced under)")
    .action(
      guard(async (ids: string[], options: UsedCliOptions) => {
        // Required rather than defaulted. `recall_log` rows are keyed on the session they were
        // surfaced under and mem holds no notion of a "current" session (it is a short-lived
        // single-shot process with no daemon and no state between invocations), so any default here
        // would be an invented session id matching no row -- reporting "0 marked" for every correct
        // invocation, which reads as a broken command rather than a missing flag.
        const session = options.sessionId;
        if (session === undefined || session.trim().length === 0) {
          throw new UsageError("--session-id <id> is required: usefulness is recorded against the session a fact was surfaced in");
        }
        const { updated, resolvedIds, unsurfaced } = await withDb((db) => {
          // Resolve every id before writing anything: a typo in the third of three ids should not
          // leave the first two marked, and prefix resolution is exactly where a typo shows up.
          const facts = ids.map((id) => resolveIdArgOrThrow(db, id));
          const factIds = [...new Set(facts.map((fact) => fact.id))];
          const surfacedCount = db.prepare<[string, string], { c: number }>(
            "SELECT COUNT(*) AS c FROM recall_log WHERE session_id = ? AND fact_id = ?"
          );
          const tx = db.transaction(() => {
            // Counted per id, not inferred from the batch total: "0 rows updated" across a batch is
            // ambiguous -- it could mean every id was never surfaced, or that all of them were
            // already marked useful on an earlier run. Only the first needs telling.
            const neverSurfaced = factIds.filter((factId) => (surfacedCount.get(session, factId)?.c ?? 0) === 0);
            const marked = markRecallUsed(db, factIds, session, new Date().toISOString());
            // One row per fact, matching `forget`/`pin`, so the audit log stays queryable by
            // `fact_id` -- a single batch row keyed to one arbitrary id of several would make the
            // other facts' usefulness history invisible to exactly the query the column exists for.
            for (const factId of factIds) {
              insertAuditLog(db, {
                event: "used",
                factId,
                detail: neverSurfaced.includes(factId)
                  ? `not surfaced in session ${session}; nothing marked useful`
                  : `marked useful in session ${session}`,
              });
            }
            return { updated: marked, resolvedIds: factIds, unsurfaced: neverSurfaced };
          });
          // BEGIN IMMEDIATE for the same reason as `setStatusWithAudit`: this reads (the surfaced
          // count, and `markRecallUsed`'s own `used_at IS NULL` predicate) before it writes, and the
          // outer invocation is what decides the whole nest's locking mode -- `markRecallUsed`'s
          // transaction degrades to a savepoint once this one is open.
          return tx.immediate();
        });
        process.stdout.write(`marked ${updated} recall row${updated === 1 ? "" : "s"} useful in session ${session}
`);
        // Not an error: naming a fact that was never surfaced in this session is a plausible mistake
        // (wrong session id, or a fact the user read from `mem list` rather than from a recall), and
        // failing the whole command over it would discard the marks that did land.
        for (const factId of unsurfaced) {
          process.stdout.write(`note: ${factId} was never surfaced in session ${session} -- nothing to mark
`);
        }
        if (unsurfaced.length === 0 && updated === 0) {
          process.stdout.write(`note: ${resolvedIds.length === 1 ? "it was" : "they were"} already marked useful in this session
`);
        }
      })
    );

  program
    .command("edit <id>")
    .description("Change a fact's text, subject/value, anchor, or scope")
    .option("--text <text>", "New fact text")
    .option("--subject <key>", "New normalized subject key (requires --value)")
    .option("--value <value>", "New value for the subject (requires --subject)")
    .option("--anchor <predicate>", "New anchor predicate")
    .option("--scope <scope>", "New scope: global, project, or path")
    .option("--root <path>", "Project root for .mem/allowlist and (if --scope is given) scope binding (default: current directory)")
    .option("--path <file>", "File or directory to bind to, resolved against --root (required when --scope path, rejected otherwise)")
    .action(
      guard(async (id: string, options: EditCliOptions) => {
        const hasSubject = options.subject !== undefined;
        const hasValue = options.value !== undefined;
        if (hasSubject !== hasValue) {
          throw new UsageError("--subject and --value must be provided together");
        }
        validateScopePathPairing(options.scope, options.path);
        const root = resolveRoot(options.root);
        const scope = options.scope !== undefined ? parseFactScope(options.scope) : undefined;
        const patch: FactUpdate = {
          ...(options.text !== undefined ? { text: options.text } : {}),
          ...(hasSubject ? { subject: options.subject } : {}),
          ...(hasValue ? { value: options.value } : {}),
          ...(options.anchor !== undefined ? { anchor: options.anchor } : {}),
          ...(scope !== undefined ? { scope } : {}),
          ...(scope !== undefined
            ? { scopeRoot: scope === "global" ? null : scope === "path" ? resolvePath(root, options.path as string) : root }
            : {}),
        };
        if (Object.keys(patch).length === 0) {
          throw new UsageError("nothing to edit -- provide at least one of --text, --subject/--value, --anchor, --scope");
        }
        validateFactEditOrThrow(patch);

        const updated = await withDb((db) => {
          const existing = resolveIdArgOrThrow(db, id);
          screenInputOrThrow(
            db,
            {
              text: patch.text ?? "",
              kind: "fact",
              subject: patch.subject,
              value: patch.value,
              anchor: patch.anchor,
              root,
            } as CaptureExplicitInput,
            root,
            "edit",
            existing.id
          );
          const tx = db.transaction((): Fact => {
            const fact = updateFact(db, existing.id, patch);
            if (fact === undefined) {
              throw new UsageError(`no such fact: ${existing.id}`);
            }
            insertAuditLog(db, { event: "edit", factId: existing.id, detail: `edited fields: ${Object.keys(patch).join(", ")}` });
            return fact;
          });
          // BEGIN IMMEDIATE: `updateFact` reads before writing; see storage.insertFact.
          return tx.immediate();
        });
        process.stdout.write(`edited ${updated.id}\n`);
      })
    );

  program
    .command("review")
    .description("List pending, contested, anchor-contradicted, and unanchored-but-checkable facts for human resolution")
    .option("--promote <id>", "Promote a pending fact to active")
    .option("--reject <id>", "Reject a pending fact (marks superseded)")
    .option("--root <path>", "Project root for anchor freshness evaluation (default: current directory)")
    .option("--summary", "Print counts per bucket (pending/contested/contradicted/pins/unanchored) instead of full listings")
    .option("--section <pending|contested|contradicted|pins|unanchored>", "Only show one bucket's full listing")
    .option("--since-epoch <n>", "Only include facts with epoch greater than n (see `mem epoch`)", (v) => parseInt(v, 10))
    .action(
      guard(async (options: ReviewCliOptions) => {
        if (options.promote !== undefined && options.reject !== undefined) {
          throw new UsageError("--promote and --reject cannot be used together");
        }

        if (options.sinceEpoch !== undefined && (!Number.isFinite(options.sinceEpoch) || options.sinceEpoch < 0)) {
          throw new UsageError("--since-epoch must be a non-negative integer");
        }

        if (options.promote !== undefined) {
          const id = options.promote;
          const resolved = await withDb((db) => promotePending(db, id));
          process.stdout.write(`promoted ${resolved}\n`);
          return;
        }
        if (options.reject !== undefined) {
          const id = options.reject;
          const resolved = await withDb((db) => rejectPending(db, id));
          process.stdout.write(`rejected ${resolved}\n`);
          return;
        }

        const root = resolveRoot(options.root);
        const reviewOptions: ReviewOptions = {
          ...(options.summary === true ? { summary: true } : {}),
          ...(options.section !== undefined ? { section: parseReviewSection(options.section) } : {}),
          ...(options.sinceEpoch !== undefined && Number.isFinite(options.sinceEpoch) ? { sinceEpoch: options.sinceEpoch } : {}),
        };
        const output = await withDb((db) => formatReview(db, root, reviewOptions));
        process.stdout.write(`${output}\n`);
      })
    );

  program
    .command("consolidate")
    .description("Report near-duplicate facts (or, with --stale, live facts nothing has ever read); --apply supersedes the losers")
    .option("--apply", "Act on the report instead of only printing it: mark every loser superseded -- the same audited soft-delete `mem forget` uses, never a hard delete")
    .option("--threshold <0-1>", `Jaccard floor over topic terms for calling two facts duplicates (default ${DEFAULT_DUPLICATE_THRESHOLD})`)
    .option("--stale", "Run the stale pass instead: active facts nothing has ever surfaced or marked used")
    .option("--stale-days <n>", `How old a fact must be to count as stale, in days (default ${DEFAULT_STALE_AGE_DAYS})`)
    .action(
      guard(async (options: ConsolidateCliOptions) => {
        const output = await withDb((db) => runConsolidate(db, options, new Date()));
        process.stdout.write(`${output}\n`);
      })
    );

  program
    .command("epoch")
    .description("Print the current write epoch (monotonic, bumped on every store write; covers store state only for efficient polling)")
    .option("--gc", "Run the retention pass first: persist contradiction resolutions, prune superseded facts/sources/audit log, report preference decay")
    .action(
      guard(async (options: EpochCliOptions) => {
        if (options.gc !== true) {
          const epoch = await withDb((db) => getEpoch(db));
          process.stdout.write(`${epoch}\n`);
          return;
        }
        const summary = await withDb((db) => runRetentionPass(db));
        process.stdout.write(`${summary}\n`);
      })
    );

  program
    .command("embed")
    .description("Compute and store embedding vectors for facts, using the endpoint named by TOKEN_GOAT_MEM_EMBED_URL")
    .option("--all", "Re-embed every fact, not just the ones missing a vector -- the model-migration path")
    .option("--limit <n>", "Stop after this many facts", (value: string) => Number.parseInt(value, 10))
    .action(
      guard(async (options: EmbedCliOptions) => {
        // Before the config read on purpose: a malformed flag is a mistake in the invocation itself,
        // and reporting the environment problem first hides it behind an error the user cannot act
        // on until they have already fixed this one.
        if (options.limit !== undefined && (!Number.isFinite(options.limit) || options.limit < 1)) {
          throw new UsageError("--limit must be a positive integer");
        }

        const config = readEmbeddingConfigForCommand();
        const backend = resolveConfiguredEmbeddingBackend(process.env);
        if (backend === null) {
          // Unreachable: `readEmbeddingConfigForCommand` already threw for every configuration the
          // resolver rejects. Kept so the narrowing is real rather than asserted away.
          throw new UsageError(`embeddings are not configured; set ${EMBED_URL_ENV} and ${EMBED_MODEL_ENV}`);
        }
        const summary = await withDb(async (db) => {
          const recorded = getEmbeddingMeta(db);
          if (recorded !== undefined && recorded.model !== config.model) {
            if (options.all !== true) {
              throw new UsageError(
                `stored vectors were produced by ${recorded.model}, not ${config.model}; run \`mem embed --all\` to re-embed the store under the new model`
              );
            }
            // Cleared before the first new vector is written, not after the last: an interrupted
            // migration then leaves facts with no vector rather than a store holding two models'
            // vectors under one recorded model, which nothing downstream could tell apart.
            clearAllEmbeddings(db);
          }
          const pending = listFactsNeedingEmbedding(db, {
            ...(options.all === true ? { all: true } : {}),
            ...(options.limit !== undefined ? { limit: options.limit } : {}),
          });
          if (pending.length === 0) {
            return { embedded: 0, skipped: 0, failed: 0, dimension: null as number | null, firstFailure: null as string | null, empty: true };
          }
          let embedded = 0;
          let skipped = 0;
          let failed = 0;
          let dimension: number | null = recorded !== undefined && recorded.model === config.model ? recorded.dimension : null;
          let firstFailure: string | null = null;
          for (let offset = 0; offset < pending.length; offset += EMBED_BATCH_SIZE) {
            const batch = pending.slice(offset, offset + EMBED_BATCH_SIZE);
            let vectors: Float32Array[];
            try {
              vectors = await backend.embedBatch(batch.map((row) => row.text));
            } catch (error) {
              // One bad batch costs that batch only. The batches already written stay written, and
              // the run reports what it managed rather than throwing away completed work.
              failed += batch.length;
              firstFailure ??= extractErrorMessage(error);
              continue;
            }
            for (const [index, row] of batch.entries()) {
              const vector = vectors[index];
              if (vector === undefined) {
                failed += 1;
                continue;
              }
              dimension ??= vector.length;
              if (vector.length !== dimension) {
                // An endpoint that changed dimension mid-run. Writing it would put two vector
                // spaces in one store, which is the corruption this command exists to undo.
                skipped += 1;
                continue;
              }
              updateFact(db, row.id, { embedding: vector });
              embedded += 1;
            }
          }
          if (embedded > 0 && dimension !== null) {
            setEmbeddingMeta(db, { model: config.model, dimension });
          }
          return { embedded, skipped, failed, dimension, firstFailure, empty: false };
        });

        if (summary.empty) {
          process.stdout.write("no facts need embedding\n");
          return;
        }
        if (summary.embedded === 0) {
          // Total failure: nothing was written, so this is not a success with a zero count. The
          // message names the first cause rather than a bare count, which on its own would leave a
          // user with no idea whether the endpoint was down, wrong, or answering nonsense.
          //
          // `UsageError` (exit 1), not a bare `Error` (exit 2): every way this is reached is
          // something about the user's environment -- an endpoint that is down, wrong, or answering
          // a shape mem cannot read -- rather than a bug inside mem, and exit 2 is reserved for the
          // latter.
          throw new UsageError(`embedded 0 facts; ${summary.failed} failed, ${summary.skipped} skipped -- ${summary.firstFailure ?? "no vector returned"}`);
        }
        const dimensionNote = summary.dimension === null ? "" : `, dim ${summary.dimension}`;
        process.stdout.write(
          `embedded ${summary.embedded}, skipped ${summary.skipped}, failed ${summary.failed} (model ${config.model}${dimensionNote})\n`
        );
        if (summary.firstFailure !== null) {
          process.stdout.write(`note: some batches failed -- ${summary.firstFailure}; re-run \`mem embed\` to retry them\n`);
        }
      })
    );

  program
    .command("facets")
    .description("Extract, inspect, and list the structured entity/topic terms behind `mem recall --entity`")
    .option("--backfill", "Extract terms for facts that have none yet (the default when no other mode is given)")
    .option("--all", "Re-extract terms for every fact -- the path to take after an extraction-rule change")
    .option("--fact <id>", "Show the terms stored for one fact (full id or short prefix)")
    .option("--list-entities", "List the distinct entities in the store with fact counts, most frequent first")
    .action(
      guard(async (options: FacetsCliOptions) => {
        // Each mode answers a different question and they do not compose: `--fact` inspects one
        // fact, `--list-entities` reads the whole index, `--all` writes. Silently letting one win
        // would make the ignored flag look honoured.
        const modes = [options.all === true, options.fact !== undefined, options.listEntities === true].filter(Boolean).length;
        if (modes > 1) {
          throw new UsageError("--all, --fact, and --list-entities are mutually exclusive");
        }

        if (options.fact !== undefined) {
          const id = options.fact;
          const output = await withDb((db) => {
            const existing = resolveIdArgOrThrow(db, id);
            const terms = listTermsForFact(db, existing.id);
            const entities = terms.filter((term) => term.kind === "entity").map((term) => term.term);
            const topics = terms.filter((term) => term.kind === "topic").map((term) => term.term);
            return [
              `fact: ${existing.id}`,
              // "none" rather than an empty line: a fact whose text names no identifier legitimately
              // has no entities, and a blank value reads as a failed lookup instead of an answer.
              `entities: ${entities.length > 0 ? entities.join(", ") : "none"}`,
              `topics: ${topics.length > 0 ? topics.join(", ") : "none"}`,
              ...(terms.length === 0 ? ["note: no terms stored yet -- run `mem facets` to backfill"] : []),
            ].join("\n");
          });
          process.stdout.write(`${output}\n`);
          return;
        }

        if (options.listEntities === true) {
          const entities = await withDb((db) => listEntityCounts(db));
          if (entities.length === 0) {
            process.stdout.write("no entities extracted yet\n");
            return;
          }
          for (const entity of entities) {
            process.stdout.write(`${String(entity.facts).padStart(5, " ")}  ${entity.term}\n`);
          }
          return;
        }

        const summary = await withDb((db) => {
          const pending = listFactsNeedingTerms(db, { ...(options.all === true ? { all: true } : {}) });
          let entities = 0;
          let topics = 0;
          for (const row of pending) {
            const facets = extractFacets(row.text);
            replaceFactTerms(db, row.id, facets);
            entities += facets.entities.length;
            topics += facets.topics.length;
          }
          return { facts: pending.length, entities, topics };
        });
        if (summary.facts === 0) {
          // A backfill that found nothing is a success, so the exit code carries no signal and this
          // line is the whole of it -- silence here is indistinguishable from a run that worked.
          process.stdout.write("no facts need facet extraction\n");
          return;
        }
        process.stdout.write(`extracted facets for ${summary.facts} fact${summary.facts === 1 ? "" : "s"}: ${summary.entities} entities, ${summary.topics} topics\n`);
      })
    );

  program
    .command("doctor")
    .description("Read-only environment/DB health check: db path, WAL mode, schema tables, epoch, fact counts by status, embedding configuration and coverage")
    .action(
      guard(async () => {
        const dbPath = resolveDbPath();
        const output = await withDb((db) => {
          const journalMode = db.pragma("journal_mode", { simple: true }) as string;
          const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;
          const tables = db
            .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all()
            .map((row) => row.name)
            .filter((name) => !name.startsWith("sqlite_"));
          const statusCounts = FACT_STATUSES.map((status) => `${status}=${countFacts(db, { status })}`).join("  ");
          const totalFacts = countFacts(db, {});
          const sourceRows = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM sources").get()?.c ?? 0;
          const auditRows = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM audit_log").get()?.c ?? 0;
          const epoch = getEpoch(db);
          return [
            `db: ${dbPath}`,
            `journal_mode: ${journalMode}`,
            `foreign_keys: ${foreignKeys === 1 ? "on" : "off"}`,
            `tables: ${tables.join(", ")}`,
            `epoch: ${epoch}`,
            `facts: ${statusCounts}  (total ${totalFacts})`,
            `sources: ${sourceRows}`,
            `audit_log rows: ${auditRows}`,
            ...describeEmbeddings(getEmbeddingMeta(db) ?? null, countEmbeddedFacts(db), totalFacts),
            describeFacets(countFactsWithTerms(db), totalFacts),
          ].join("\n");
        });
        process.stdout.write(`${output}\n`);
      })
    );

  program
    .command("init <tool>")
    .description(
      `Wire mem into a coding tool's config (one of ${TOOL_NAMES.join(", ")}) -- automates what docs/integrations/*.md ` +
        "otherwise asks you to hand-copy. Idempotent: re-running upgrades mem's own entries in place, never duplicates them. " +
        "A tool with more than one managed file computes every file's next content before writing any of them, so a " +
        "hand-written entry that conflicts with mem's aborts the whole install before a single file is touched -- never a " +
        "partial write. Add `*.token-goat-mem.bak` to this project's .gitignore: install takes a one-time snapshot of any " +
        "pre-existing file before its first write."
    )
    .option("--root <path>", "Project root to write project-level config into (default: current directory)")
    .option("--user", "Write to the tool's user-level config instead of project-level, where the tool has both")
    .option("--dry-run", "Print what would be written without touching disk")
    .action(
      guard((tool: string, options: InitCliOptions) => {
        const wiring = getToolWiring(parseToolName(tool));
        const wiringOpts = toWiringOpts(options);
        if (options.dryRun === true) {
          process.stdout.write(`${formatWiringPlanForInit(wiring.describe(wiringOpts))}\n`);
          return;
        }
        process.stdout.write(`${formatWiringResult(wiring.install(wiringOpts))}\n`);
      })
    );

  program
    .command("uninstall [tool]")
    .description(
      `Remove mem's wiring from a coding tool's config, written by \`mem init\` (one of ${TOOL_NAMES.join(", ")}, or --all). ` +
        "Only removes mem-authored content; a no-op (not an error) if nothing to remove."
    )
    .option("--all", "Uninstall from every supported tool")
    .option("--root <path>", "Project root the project-level config lives under (default: current directory)")
    .option("--user", "Also target the tool's user-level config, where the tool has both")
    .option("--dry-run", "Print what would be removed without touching disk")
    .action(
      guard((tool: string | undefined, options: UninstallCliOptions) => {
        if (options.all === true && tool !== undefined) {
          throw new UsageError("cannot combine a tool name with --all");
        }
        if (options.all !== true && tool === undefined) {
          throw new UsageError(`uninstall requires a tool name (${TOOL_NAMES.join(", ")}) or --all`);
        }
        const names: readonly ToolName[] = options.all === true ? TOOL_NAMES : [parseToolName(tool as string)];
        const wiringOpts = toWiringOpts(options);
        const lines: string[] = [];
        let hadFailure = false;
        for (const name of names) {
          const wiring = getToolWiring(name);
          try {
            if (options.dryRun === true) {
              lines.push(`${name}:`, formatWiringPlanForUninstall(wiring.describe(wiringOpts)));
            } else {
              lines.push(`${name}:`, formatWiringResult(wiring.uninstall(wiringOpts)));
            }
          } catch (error) {
            // Only --all catches and continues: a single named tool's uninstall keeps throwing so
            // guard() reports its real exit code (1 user error, 2 internal). With --all, one tool's
            // conflict must not hide that every tool before it already finished uninstalling.
            if (options.all !== true) {
              throw error;
            }
            hadFailure = true;
            lines.push(`${name}: failed -- ${extractErrorMessage(error)}`);
          }
        }
        process.stdout.write(`${lines.join("\n")}\n`);
        if (hadFailure) {
          process.exitCode = EXIT_USER_ERROR;
        }
      })
    );

  return program;
}

/**
 * Parses `argv` and dispatches. Sets `process.exitCode`; callers (src/main.ts) should let the
 * process exit naturally so buffered stdout flushes first, rather than calling `process.exit()`.
 */
export async function run(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  // Commander's exitOverride lets us catch its internal exits (help, version, unknown command)
  // instead of letting it call process.exit() mid-flush.
  //
  // It is not inherited: a Command applies it to itself alone, so setting it only on the root left
  // all 15 subcommands calling `process.exit()` directly on any parse error of their own -- exactly
  // the mid-flush exit the line above exists to prevent, and the same class as the EPIPE truncation
  // fixed in 0.3.0. It also made the `commander.`-prefixed branch below unreachable for every
  // subcommand: a subcommand parse failure surfaced here as a plain Error with no `code`, so it was
  // classified as an internal bug (exit 2) rather than the usage error (exit 1) the contract
  // specifies. Production masked this -- Commander's own `process.exit(1)` happened to produce the
  // right code before our handler ran -- which is why only the in-process path could reveal it.
  program.exitOverride();
  for (const command of program.commands) {
    command.exitOverride();
  }
  try {
    await program.parseAsync(argv);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "commander.helpDisplayed" || code === "commander.version" || code === "commander.help") {
      process.exitCode = EXIT_SUCCESS;
      return;
    }
    if (code === "commander.unknownCommand" || code === "commander.missingArgument" || code === "commander.missingMandatoryOptionValue") {
      // Commander already wrote its diagnostic to stderr.
      process.exitCode = EXIT_USER_ERROR;
      return;
    }
    if (typeof code === "string" && code.startsWith("commander.")) {
      // Any other Commander parse failure (invalid option, excess arguments, ...) is still a
      // usage error; Commander already wrote its diagnostic to stderr.
      process.exitCode = EXIT_USER_ERROR;
      return;
    }
    // Non-Commander errors escaping an action can only be bugs (guard() catches everything a
    // handler throws), so classify per the contract rather than assuming user error.
    err(`mem: ${extractErrorMessage(error)}`);
    process.exitCode = exitCodeForError(error);
  }
}
