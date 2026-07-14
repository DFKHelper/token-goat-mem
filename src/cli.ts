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

import { evaluateAnchor, type AnchorVerdict } from "./anchors.js";
import {
  captureExplicit,
  CaptureValidationError,
  InvalidAnchorError,
  loadAllowlist,
  screenForSecrets,
  SecretDetectedError,
  validateFactEditOrThrow,
  type CaptureExplicitInput,
} from "./capture.js";
import { detectContradictions } from "./contradiction.js";
import { insertAuditLog, resolveDbPath } from "./db.js";
import { importFromMarkdown, planImportFromMarkdown, type ImportOutcome } from "./import.js";
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
import {
  GROUND_TRUTH_CONFIDENCE_FLOOR,
  PREFERENCE_CONFIDENCE_HALF_LIFE_DAYS,
  retrieve,
  type RetrievalOptions,
} from "./retrieval.js";
import {
  countFacts,
  deleteFact,
  deleteSourcesOlderThan,
  getEpoch,
  getFactById,
  listFacts,
  listSourcesForFact,
  openStorage,
  setFactStatus,
  updateFact,
} from "./storage.js";
import type { Fact, FactFilter, FactKind, FactScope, FactStatus, FactUpdate, Source } from "./types.js";

const MS_PER_DAY = 86_400_000;

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
function exitCodeForError(error: unknown): number {
  return error instanceof UsageError ||
    error instanceof CaptureValidationError ||
    error instanceof InvalidAnchorError ||
    error instanceof SecretDetectedError ||
    error instanceof WiringConflictError
    ? EXIT_USER_ERROR
    : EXIT_INTERNAL_ERROR;
}

// ─────────────────────────────────────────────────────────────────────────── CLI-boundary validation ───────────────────────────────────────────────────────────────────────────

const FACT_KINDS: readonly FactKind[] = ["preference", "decision", "fact", "correction"];
const FACT_SCOPES: readonly FactScope[] = ["global", "project", "path"];
const FACT_STATUSES: readonly FactStatus[] = ["active", "pending", "superseded", "contested", "pinned"];

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
  return `${fact.id}  [${fact.kind}/${fact.status}]${kv}  ${fact.text}`;
}

function formatFactDetail(fact: Fact, freshness: AnchorVerdict, sources: readonly Source[]): string {
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
  if (sources.length > 0) {
    lines.push("sources:");
    for (const source of sources) {
      lines.push(`  - [${source.storedAt}] ${source.excerpt}`);
    }
  }
  return lines.join("\n");
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
  const imported = result.outcomes.filter((outcome) => outcome.status === "imported").length;
  return [
    `imported ${imported} of ${result.outcomes.length} candidate fact(s) from ${result.filePath} as pending ` +
      "(never auto-promoted -- confirm each via `mem review --promote <id>`):",
    ...lines,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────── review ───────────────────────────────────────────────────────────────────────────

/** Section 6 / review finding S8: "Pins get a re-confirmation nudge in review after N months so a year-old forgotten pin can't stay maximally-trusted forever." ~6 months. */
const PIN_RECONFIRM_DAYS = 182;

/** The four `mem review` buckets, in listing order. `formatReview`'s `--summary`/`--section` options validate against exactly this set. */
const REVIEW_SECTIONS = ["pending", "contested", "contradicted", "pins"] as const;
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

function promotePending(db: Database.Database, id: string): void {
  const fact = getFactById(db, id);
  if (fact === undefined) {
    throw new UsageError(`no such fact: ${id}`);
  }
  if (fact.status !== "pending") {
    throw new UsageError(`fact ${id} is not pending (status=${fact.status}) -- only pending facts can be promoted`);
  }
  setFactStatus(db, id, "active");
  insertAuditLog(db, { event: "review_promote", factId: id, detail: "promoted pending fact to active via explicit review" });
}

function rejectPending(db: Database.Database, id: string): void {
  const fact = getFactById(db, id);
  if (fact === undefined) {
    throw new UsageError(`no such fact: ${id}`);
  }
  if (fact.status !== "pending") {
    throw new UsageError(`fact ${id} is not pending (status=${fact.status}) -- only pending facts can be rejected`);
  }
  setFactStatus(db, id, "superseded");
  insertAuditLog(db, { event: "review_reject", factId: id, detail: "rejected pending fact (superseded) via explicit review" });
}

/** `formatReview`'s long, human-facing section titles, keyed by the short bucket names `--section`/`--summary` validate against. */
const REVIEW_SECTION_TITLES: Record<ReviewSection, string> = {
  pending: "pending (never auto-promoted -- confirm with --promote/--reject)",
  contested: "contested (ambiguous contradiction -- withheld from ground truth)",
  contradicted: "anchor-contradicted (suppressed from ground truth)",
  pins: "pins due for re-confirmation",
};

/**
 * Builds the `mem review` listing: pending facts (never auto-promoted, S9), contested facts
 * (deterministic contradiction detection re-run fresh over the live active/pinned pool, never
 * trusting a possibly-stale `status` column -- same discipline as retrieval.ts), anchor-contradicted
 * facts (including pins -- S8: a pin is exempt from decay, never from contradiction/anchor
 * suppression), and pins overdue for re-confirmation.
 *
 * `options.sinceEpoch` restricts every bucket to facts with `epoch > sinceEpoch` (applied at the
 * source -- pending/groundTruth queries -- so contested/contradicted/pins, which are derived from
 * groundTruth, inherit the filter automatically). `options.section` restricts the output to one
 * bucket. `options.summary` prints per-bucket counts instead of full listings.
 */
function formatReview(db: Database.Database, root: string, options: ReviewOptions = {}): string {
  const epochFilter: FactFilter = options.sinceEpoch !== undefined ? { epochAfter: options.sinceEpoch } : {};
  const pending = listFacts(db, { status: "pending", ...epochFilter });
  const groundTruth = listFacts(db, { status: ["active", "pinned"], ...epochFilter });

  const { groups } = detectContradictions(groundTruth);
  const contestedIds = new Set(groups.filter((group) => group.resolution === "contested").flatMap((group) => group.factIds));
  const contested = groundTruth.filter((fact) => contestedIds.has(fact.id));

  const contradicted = groundTruth.filter(
    (fact) => !contestedIds.has(fact.id) && evaluateAnchor(fact.anchor, root) === "contradicted"
  );

  const now = Date.now();
  const pinsDue = groundTruth.filter((fact) => {
    if (fact.status !== "pinned") {
      return false;
    }
    const ageDays = (now - Date.parse(fact.captured_at)) / MS_PER_DAY;
    return Number.isFinite(ageDays) && ageDays >= PIN_RECONFIRM_DAYS;
  });

  const buckets: Record<ReviewSection, readonly Fact[]> = { pending, contested, contradicted, pins: pinsDue };
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
 * Reimplements retrieval.ts's private `decayedConfidence`/`isDecayedBelowGroundTruth` formula against
 * the same exported constants (`PREFERENCE_CONFIDENCE_HALF_LIFE_DAYS`, `GROUND_TRUTH_CONFIDENCE_FLOOR`)
 * for a report-only count. Decay itself is never persisted here (Section 6: "never silent deletion" --
 * a decayed preference simply stops being ground-truth-eligible on the *next* `recall`, computed fresh
 * from `captured_at` every time; there is nothing to write back to `confidence`).
 */
function isDecayedBelowFloor(fact: Fact, now: Date): boolean {
  if (fact.kind !== "preference" || fact.status === "pinned") {
    return false;
  }
  const ageDays = (now.getTime() - Date.parse(fact.captured_at)) / MS_PER_DAY;
  if (!Number.isFinite(ageDays) || ageDays <= 0) {
    return false;
  }
  const decayed = fact.confidence * Math.pow(0.5, ageDays / PREFERENCE_CONFIDENCE_HALF_LIFE_DAYS);
  return decayed < GROUND_TRUTH_CONFIDENCE_FLOOR;
}

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

  const groundTruth = listFacts(db, { status: ["active", "pinned"] });
  const { updates } = detectContradictions(groundTruth);
  for (const update of updates) {
    setFactStatus(db, update.factId, update.nextStatus);
    insertAuditLog(db, { event: "epoch_contradiction", factId: update.factId, detail: update.reason });
  }

  const preferences = listFacts(db, { kind: "preference", status: "active" });
  const decayedCount = preferences.filter((fact) => isDecayedBelowFloor(fact, now)).length;

  const supersededCutoff = new Date(now.getTime() - GC_SUPERSEDED_MAX_AGE_DAYS * MS_PER_DAY).toISOString();
  const superseded = listFacts(db, { status: "superseded" }); // newest captured_at first
  let prunedFacts = 0;
  superseded.forEach((fact, index) => {
    if (fact.captured_at < supersededCutoff || index >= GC_SUPERSEDED_MAX_ROWS) {
      if (deleteFact(db, fact.id)) {
        prunedFacts += 1;
      }
    }
  });

  const sourcesCutoff = new Date(now.getTime() - GC_SOURCES_MAX_AGE_DAYS * MS_PER_DAY).toISOString();
  const prunedSources = deleteSourcesOlderThan(db, sourcesCutoff);

  const auditCutoff = new Date(now.getTime() - GC_AUDIT_LOG_MAX_AGE_DAYS * MS_PER_DAY).toISOString();
  const prunedAuditRows = db.prepare("DELETE FROM audit_log WHERE created_at < ?").run(auditCutoff).changes;

  const epoch = getEpoch(db);
  return (
    `epoch=${epoch}  contradictions_resolved=${updates.length}  preferences_decayed_below_floor=${decayedCount}  ` +
    `pruned_superseded_facts=${prunedFacts}  pruned_sources=${prunedSources}  pruned_audit_log_rows=${prunedAuditRows}`
  );
}

// ─────────────────────────────────────────────────────────────────────────── Program assembly ───────────────────────────────────────────────────────────────────────────

interface RememberCliOptions {
  readonly kind: string;
  readonly subject?: string;
  readonly value?: string;
  readonly anchor?: string;
  readonly scope: string;
  readonly sourceRef?: string;
  readonly root?: string;
}

interface ImportCliOptions {
  readonly fromMd: string;
  readonly root?: string;
  readonly scope?: string;
  readonly kind?: string;
  readonly dryRun?: boolean;
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
}

interface ListCliOptions {
  readonly kind?: string;
  readonly status?: string;
  readonly subject?: string;
  readonly scope?: string;
  readonly limit?: number;
}

interface ShowCliOptions {
  readonly root?: string;
}

interface EditCliOptions {
  readonly text?: string;
  readonly subject?: string;
  readonly value?: string;
  readonly anchor?: string;
  readonly scope?: string;
  readonly root?: string;
}

interface ReviewCliOptions {
  readonly promote?: string;
  readonly reject?: string;
  readonly root?: string;
  readonly summary?: boolean;
  readonly section?: string;
  readonly sinceEpoch?: number;
}

interface EpochCliOptions {
  readonly gc?: boolean;
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
export function buildProgram(): Command {
  const program = new Command();
  program.name("mem").description("Long-term conversational memory for AI coding agents").version("0.2.0");

  program
    .command("remember <text>")
    .description("Explicit capture: store a user-stated fact into active storage")
    .requiredOption("--kind <kind>", `preference, decision, fact, or correction`)
    .option("--subject <key>", "Normalized key for contradiction detection (requires --value)")
    .option("--value <value>", "Value for the subject (requires --subject)")
    .option("--anchor <predicate>", "Read-only anchor predicate (filesystem/git)")
    .option("--scope <scope>", "global, project, or path", "global")
    .option("--source-ref <ref>", "Reference to the originating conversation/message")
    .option("--root <path>", "Project root for .mem/allowlist and scope binding (default: current directory)")
    .action(
      guard(async (text: string, options: RememberCliOptions) => {
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
        };
        const { fact } = await withDb((db) => captureExplicit(db, input));
        process.stdout.write(`remembered ${fact.kind} fact ${fact.id}\n`);
      })
    );

  program
    .command("import")
    .description(
      "Advisory import: parse a markdown file (CLAUDE.md-style) for preference/decision-shaped bullets and " +
        "store each as a pending fact -- never auto-promoted, same trust path as any other suggested/derived fact " +
        "(confirm via `mem review --promote <id>`)"
    )
    .requiredOption("--from-md <path>", "Markdown file to import bullet-list candidates from")
    .option("--root <path>", "Project root for .mem/allowlist and scope binding (default: current directory)")
    .option("--scope <scope>", "global, project, or path", "project")
    .option("--kind <kind>", "preference, decision, fact, or correction", "preference")
    .option("--dry-run", "Report what would be imported without writing anything")
    .action(
      guard(async (options: ImportCliOptions) => {
        const root = resolveRoot(options.root);
        const scope = options.scope !== undefined ? parseFactScope(options.scope) : undefined;
        const kind = options.kind !== undefined ? parseFactKind(options.kind) : undefined;
        const dryRun = options.dryRun === true;

        // --dry-run opens no database on purpose: openDb() would mkdirSync + create the db file,
        // WAL sidecars, and schema on disk, which contradicts --dry-run's "nothing written". The
        // dry-run computation (planImportFromMarkdown) needs only the markdown file, no db.
        const result = dryRun
          ? planImportFromMarkdown({ path: options.fromMd })
          : await withDb((db) =>
              importFromMarkdown(db, {
                path: options.fromMd,
                root,
                ...(scope !== undefined ? { scope } : {}),
                ...(kind !== undefined ? { kind } : {}),
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
    .option("--hint-format", "Emit the TGMEM/2 wire format for the token-goat seam")
    .option("--context-files <files>", "Comma-separated file paths for scope=path matching (--hint-format only)")
    .option("--age-days <days>", "Only facts captured within this many days", (v) => parseInt(v, 10))
    .option("--limit <n>", "Limit results", (v) => parseInt(v, 10))
    .option("--root <path>", "Project root for anchor evaluation")
    .option("--stable", "Force deterministic id-sorted output ordering instead of relevance/recency order")
    .option("--hint-style <full|terse>", "Display verbosity: full (default, unchanged) or terse (no CTA, short kind labels)", "full")
    .action(
      guard(async (query: string | undefined, options: RecallCliOptions) => {
        const hintStyle = options.hintStyle !== undefined ? parseHintStyle(options.hintStyle) : "full";

        if (options.hintFormat === true) {
          if (typeof options.root !== "string" || options.root.trim().length === 0) {
            throw new UsageError("recall --hint-format requires --root <path>");
          }
          const contextFiles = parseContextFiles(options.contextFiles);
          const hintOptions: HintFormatOptions = {
            root: options.root,
            ...(contextFiles !== undefined ? { contextFiles } : {}),
            ...(options.stable === true ? { stable: true } : {}),
            ...(hintStyle !== "full" ? { hintStyle } : {}),
          };
          const result = await buildHintFormat(hintOptions);
          process.stdout.write(`${result.header}\n`);
          for (const line of result.lines) {
            process.stdout.write(`${line}\n`);
          }
          return;
        }

        const root = resolveRoot(options.root);
        const facts = await withDb((db) => listFacts(db, {}));
        const retrievalOptions: RetrievalOptions = {
          query: query ?? "",
          root,
          ...(options.kind !== undefined ? { kind: parseFactKind(options.kind) } : {}),
          ...(options.subject !== undefined ? { subject: options.subject } : {}),
          ...(options.scope !== undefined ? { scope: parseFactScope(options.scope) } : {}),
          ...(options.ageDays !== undefined && Number.isFinite(options.ageDays) ? { ageDays: options.ageDays } : {}),
          ...(options.limit !== undefined && Number.isFinite(options.limit) ? { limit: options.limit } : {}),
          ...(hintStyle !== "full" ? { hintStyle } : {}),
        };
        // No embeddingBackend is wired: retrieval is BM25-only in v1 (see the
        // TODO(deferred, spec'd) note on retrieval.ts's EmbeddingBackend).
        const results = await retrieve(facts, retrievalOptions);
        if (results.length === 0) {
          process.stdout.write("no matching facts\n");
          return;
        }
        // --stable is a strictly-additive output-ordering override: same facts, same caps, just a
        // deterministic id order instead of the default relevance/recency order.
        const ordered = options.stable === true ? [...results].sort((a, b) => a.fact.id.localeCompare(b.fact.id)) : results;
        for (const result of ordered) {
          process.stdout.write(`${result.display}\n`);
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
    .option("--limit <n>", "Limit results", (v) => parseInt(v, 10))
    .action(
      guard(async (options: ListCliOptions) => {
        const filter: FactFilter = {
          ...(options.kind !== undefined ? { kind: parseFactKind(options.kind) } : {}),
          ...(options.status !== undefined ? { status: parseFactStatusList(options.status) } : {}),
          ...(options.subject !== undefined ? { subject: options.subject } : {}),
          ...(options.scope !== undefined ? { scope: parseFactScope(options.scope) } : {}),
          ...(options.limit !== undefined && Number.isFinite(options.limit) ? { limit: options.limit } : {}),
        };
        const facts = await withDb((db) => listFacts(db, filter));
        if (facts.length === 0) {
          process.stdout.write("no facts stored\n");
          return;
        }
        for (const fact of facts) {
          process.stdout.write(`${formatFactSummary(fact)}\n`);
        }
      })
    );

  program
    .command("show <id>")
    .description("Show one fact in full, including provenance and anchor freshness")
    .option("--root <path>", "Project root for anchor freshness evaluation (default: fact's scope root, then current directory)")
    .action(
      guard(async (id: string, options: ShowCliOptions) => {
        const output = await withDb((db) => {
          const fact = getFactById(db, id);
          if (fact === undefined) {
            throw new UsageError(`no such fact: ${id}`);
          }
          const root = resolveRoot(options.root ?? fact.scopeRoot ?? undefined);
          const freshness = evaluateAnchor(fact.anchor, root);
          const sources = listSourcesForFact(db, id);
          return formatFactDetail(fact, freshness, sources);
        });
        process.stdout.write(`${output}\n`);
      })
    );

  program
    .command("forget <id>")
    .description("Soft-delete a fact (marks superseded, kept for audit) and audit-log it")
    .action(
      guard(async (id: string) => {
        await withDb((db) => {
          const existing = getFactById(db, id);
          if (existing === undefined) {
            throw new UsageError(`no such fact: ${id}`);
          }
          setFactStatus(db, id, "superseded");
          insertAuditLog(db, { event: "forget", factId: id, detail: `forgot fact (was ${existing.status})` });
        });
        process.stdout.write(`forgot ${id}\n`);
      })
    );

  program
    .command("pin <id>")
    .description("Exempt a fact from time-decay (still subject to contradiction/anchor suppression)")
    .action(
      guard(async (id: string) => {
        await withDb((db) => {
          const existing = getFactById(db, id);
          if (existing === undefined) {
            throw new UsageError(`no such fact: ${id}`);
          }
          setFactStatus(db, id, "pinned");
          insertAuditLog(db, { event: "pin", factId: id, detail: `pinned fact (was ${existing.status})` });
        });
        process.stdout.write(`pinned ${id}\n`);
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
    .action(
      guard(async (id: string, options: EditCliOptions) => {
        const hasSubject = options.subject !== undefined;
        const hasValue = options.value !== undefined;
        if (hasSubject !== hasValue) {
          throw new UsageError("--subject and --value must be provided together");
        }
        const root = resolveRoot(options.root);
        const scope = options.scope !== undefined ? parseFactScope(options.scope) : undefined;
        const patch: FactUpdate = {
          ...(options.text !== undefined ? { text: options.text } : {}),
          ...(hasSubject ? { subject: options.subject } : {}),
          ...(hasValue ? { value: options.value } : {}),
          ...(options.anchor !== undefined ? { anchor: options.anchor } : {}),
          ...(scope !== undefined ? { scope } : {}),
          ...(scope !== undefined ? { scopeRoot: scope === "global" ? null : root } : {}),
        };
        if (Object.keys(patch).length === 0) {
          throw new UsageError("nothing to edit -- provide at least one of --text, --subject/--value, --anchor, --scope");
        }
        validateFactEditOrThrow(patch);

        const updated = await withDb((db) => {
          const existing = getFactById(db, id);
          if (existing === undefined) {
            throw new UsageError(`no such fact: ${id}`);
          }
          const allowlist = loadAllowlist(root);
          const matches = screenForSecrets(
            { text: patch.text, subject: patch.subject, value: patch.value, anchor: patch.anchor },
            allowlist
          );
          if (matches.length > 0) {
            insertAuditLog(db, {
              event: "edit_blocked_secret",
              factId: id,
              detail: `blocked: ${matches.map((match) => `${match.field}/${match.patternName}`).join(", ")}`,
            });
            throw new SecretDetectedError(matches);
          }
          const fact = updateFact(db, id, patch);
          if (fact === undefined) {
            throw new UsageError(`no such fact: ${id}`);
          }
          insertAuditLog(db, { event: "edit", factId: id, detail: `edited fields: ${Object.keys(patch).join(", ")}` });
          return fact;
        });
        process.stdout.write(`edited ${updated.id}\n`);
      })
    );

  program
    .command("review")
    .description("List pending, contested, and anchor-contradicted facts for human resolution")
    .option("--promote <id>", "Promote a pending fact to active")
    .option("--reject <id>", "Reject a pending fact (marks superseded)")
    .option("--root <path>", "Project root for anchor freshness evaluation (default: current directory)")
    .option("--summary", "Print counts per bucket (pending/contested/contradicted/pins) instead of full listings")
    .option("--section <pending|contested|contradicted|pins>", "Only show one bucket's full listing")
    .option("--since-epoch <n>", "Only include facts with epoch greater than n (see `mem epoch`)", (v) => parseInt(v, 10))
    .action(
      guard(async (options: ReviewCliOptions) => {
        if (options.promote !== undefined && options.reject !== undefined) {
          throw new UsageError("--promote and --reject cannot be used together");
        }
        if (options.promote !== undefined) {
          const id = options.promote;
          await withDb((db) => promotePending(db, id));
          process.stdout.write(`promoted ${id}\n`);
          return;
        }
        if (options.reject !== undefined) {
          const id = options.reject;
          await withDb((db) => rejectPending(db, id));
          process.stdout.write(`rejected ${id}\n`);
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
    .command("epoch")
    .description("Print the current write epoch (monotonic, bumped on every write; token-goat's fallback-cache invalidation key)")
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
    .command("doctor")
    .description("Read-only environment/DB health check: db path, WAL mode, schema tables, epoch, fact counts by status")
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
          ].join("\n");
        });
        process.stdout.write(`${output}\n`);
      })
    );

  program
    .command("init <tool>")
    .description(
      `Wire mem into a coding tool's config (one of ${TOOL_NAMES.join(", ")}) -- automates what docs/integrations/*.md ` +
        "otherwise asks you to hand-copy. Idempotent: re-running upgrades mem's own entries in place, never duplicates them."
    )
    .option("--root <path>", "Project root to write project-level config into (default: current directory)")
    .option("--user", "Write to the tool's user-level config instead of project-level, where the tool has both")
    .option("--dry-run", "Print what would be written without touching disk")
    .action(
      guard(async (tool: string, options: InitCliOptions) => {
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
      guard(async (tool: string | undefined, options: UninstallCliOptions) => {
        if (options.all === true && tool !== undefined) {
          throw new UsageError("cannot combine a tool name with --all");
        }
        if (options.all !== true && tool === undefined) {
          throw new UsageError(`uninstall requires a tool name (${TOOL_NAMES.join(", ")}) or --all`);
        }
        const names: readonly ToolName[] = options.all === true ? TOOL_NAMES : [parseToolName(tool as string)];
        const wiringOpts = toWiringOpts(options);
        const lines: string[] = [];
        for (const name of names) {
          const wiring = getToolWiring(name);
          if (options.dryRun === true) {
            lines.push(`${name}:`, formatWiringPlanForUninstall(wiring.describe(wiringOpts)));
          } else {
            lines.push(`${name}:`, formatWiringResult(wiring.uninstall(wiringOpts)));
          }
        }
        process.stdout.write(`${lines.join("\n")}\n`);
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
  program.exitOverride();
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
