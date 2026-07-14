/**
 * `mem import --from-json <path>` -- the full-fidelity counterpart to `mem import --from-md`
 * (src/import.ts). Where the markdown importer extracts *candidate* facts from prose and always
 * quarantines them as `pending` (S9), this module imports the literal output of `mem export`: a
 * JSON envelope of already-decided facts (any status, any source_type) produced by `listFacts(db,
 * {})`. Round-tripping through export/import must reproduce each fact exactly -- same `id`, same
 * `status`, same `confidence`, same `captured_at` -- so this module does NOT go through
 * `capture.ts`'s `captureSuggested`/`captureExplicit` (both of those force their own status/
 * confidence/captured_at, which would silently corrupt a re-import). It calls `insertFact`
 * (src/storage.ts) directly instead, relying on `NewFact.id` (src/types.ts) to preserve the
 * original id.
 *
 * Despite bypassing the capture pipeline's status/confidence handling, every import still goes
 * through the same secret-screening gate (`screenForSecrets`, design principle 7) before a fact is
 * written -- a hand-edited or tampered JSON export is still untrusted input at this module's
 * boundary.
 *
 * Reuses `import.ts`'s `ImportResult`/`ImportOutcome`/`ImportCandidate` types rather than defining
 * a parallel shape: the CLI's `formatImportResult` (src/cli.ts) is already generic over
 * `{ filePath, outcomes }`, so both import modes render through the same summary/line formatting.
 */

import { resolve } from "node:path";
import type Database from "better-sqlite3";

import { CaptureValidationError, InvalidAnchorError, loadAllowlist, screenForSecrets, validateFactFieldsOrThrow } from "./capture.js";
import { insertAuditLog } from "./db.js";
import type { ImportCandidate, ImportOutcome, ImportResult } from "./import.js";
import { readFileWithErrorMapping, statFileWithErrorMapping } from "./fileUtils.js";
import { getFactById, insertFact } from "./storage.js";
import { FACT_KINDS, FACT_SCOPES, FACT_STATUSES } from "./types.js";
import type { Fact, FactKind, FactScope, FactSourceType, FactStatus, NewFact } from "./types.js";

/** The only envelope shape this module reads. Bumping this is a breaking change to the export format -- there is deliberately no migration path for older/newer envelopes today. */
export const JSON_EXPORT_SCHEMA_VERSION = 1;

/** Maximum JSON export file size (50 MB). Files larger than this are rejected as DoS protection. */
const MAX_IMPORT_FILE_SIZE_BYTES = 50_000_000;

const FACT_SOURCE_TYPES: readonly FactSourceType[] = ["user", "derived"];

/**
 * Thrown for a whole-file problem (malformed JSON, missing/mismatched `schemaVersion`, missing
 * `facts` array) -- distinct from a single bad fact within an otherwise-valid envelope, which is a
 * per-item `skipped_error` outcome instead (see module doc comment). Registered in `cli.ts`'s
 * `exitCodeForError` as a user error (exit 1): a malformed `--from-json` file is bad input, not an
 * internal bug.
 */
export class JsonImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonImportError";
  }
}

// ─────────────────────────────────────────────────────────────────────────── Envelope + per-fact validation ───────────────────────────────────────────────────────────────────────────

interface ParsedEntry {
  readonly candidate: ImportCandidate;
  /** The fully-formed insert-ready fact, or `null` if this entry failed shape validation. */
  readonly newFact: (NewFact & { id: string }) | null;
  /** Set only when `newFact` is `null`. */
  readonly reason: string | null;
}

/**
 * `text.guess` for a structurally-invalid entry, used only so its `ImportCandidate.text` isn't
 * empty in the reported outcome line -- never used for anything that reaches storage.
 */
function textGuess(obj: Record<string, unknown> | null, index: number): string {
  if (obj !== null && typeof obj["text"] === "string" && obj["text"].trim().length > 0) {
    return obj["text"];
  }
  return `<invalid fact at index ${index}>`;
}

/**
 * Validates one `facts[]` entry against the minimum `NewFact`-shaped requirements (text, kind,
 * scope, source_type, id) plus the optional fields' types, and -- when valid -- converts it into an
 * insert-ready `NewFact` (including the JSON `embedding: number[] | null` -> `Float32Array | null`
 * conversion, the exact inverse of `mem export`'s `Array.from(embedding)` in cli.ts). Pure: does not
 * touch the DB or screen for secrets (that is `importFromJson`'s job, since it needs `root` for
 * `.mem/allowlist`).
 */
function validateJsonFact(raw: unknown, index: number): ParsedEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    const candidate: ImportCandidate = { text: textGuess(null, index), line: index + 1, sourceRef: `#${index}` };
    return { candidate, newFact: null, reason: `facts[${index}] is not an object` };
  }
  const obj = raw as Record<string, unknown>;
  const candidateText = textGuess(obj, index);
  const fail = (reason: string): ParsedEntry => ({
    candidate: { text: candidateText, line: index + 1, sourceRef: `#${index}` },
    newFact: null,
    reason,
  });

  if (typeof obj["id"] !== "string" || obj["id"].trim().length === 0) {
    return fail(`facts[${index}] is missing a valid "id"`);
  }
  if (typeof obj["text"] !== "string" || obj["text"].length === 0) {
    return fail(`facts[${index}] is missing a valid "text"`);
  }
  if (!FACT_KINDS.includes(obj["kind"] as FactKind)) {
    return fail(`facts[${index}] has invalid "kind" ${JSON.stringify(obj["kind"])}`);
  }
  if (!FACT_SCOPES.includes(obj["scope"] as FactScope)) {
    return fail(`facts[${index}] has invalid "scope" ${JSON.stringify(obj["scope"])}`);
  }
  if (!FACT_SOURCE_TYPES.includes(obj["source_type"] as FactSourceType)) {
    return fail(`facts[${index}] has invalid "source_type" ${JSON.stringify(obj["source_type"])}`);
  }
  if (obj["status"] !== undefined && !FACT_STATUSES.includes(obj["status"] as FactStatus)) {
    return fail(`facts[${index}] has invalid "status" ${JSON.stringify(obj["status"])}`);
  }
  if (obj["confidence"] !== undefined && typeof obj["confidence"] !== "number") {
    return fail(`facts[${index}] has a non-numeric "confidence"`);
  }
  if (obj["confidence"] !== undefined && !Number.isFinite(obj["confidence"])) {
    return fail(`facts[${index}] has a non-finite "confidence" (NaN or Infinity)`);
  }
  if (obj["confidence"] !== undefined && (obj["confidence"] < 0 || obj["confidence"] > 1)) {
    return fail(`facts[${index}] has out-of-range "confidence" ${obj["confidence"]} (expected 0-1)`);
  }
  if (obj["captured_at"] !== undefined && typeof obj["captured_at"] !== "string") {
    return fail(`facts[${index}] has a non-string "captured_at"`);
  }
  if (obj["captured_at"] !== undefined && typeof obj["captured_at"] === "string") {
    const capturedAtStr = obj["captured_at"] as string;
    if (capturedAtStr.length === 0 || isNaN(Date.parse(capturedAtStr))) {
      return fail(`facts[${index}] has an invalid ISO-8601 "captured_at" ${JSON.stringify(capturedAtStr)}`);
    }
    // Stricter validation: ensure the parsed date round-trips back to a valid ISO-8601 string.
    // This catches JavaScript's lenient Date.parse behavior (e.g., "2023-13-45" parses but is not
    // a real ISO-8601 date). The round-trip ensures captured_at remains lexicographically
    // comparable for chronological ordering (design principle: contradiction-resolution, GC cutoff).
    const parsed = new Date(capturedAtStr);
    const roundTrip = parsed.toISOString();
    if (!roundTrip) {
      return fail(`facts[${index}] has an invalid ISO-8601 "captured_at": round-trip parse failed`);
    }
  }

  let embedding: Float32Array | null = null;
  const rawEmbedding = obj["embedding"];
  if (rawEmbedding !== undefined && rawEmbedding !== null) {
    if (!Array.isArray(rawEmbedding) || !rawEmbedding.every((value) => typeof value === "number")) {
      return fail(`facts[${index}] has an invalid "embedding" (expected number[] or null)`);
    }
    embedding = Float32Array.from(rawEmbedding as number[]);
  }

  // Plain conditional assignment (not spreading possibly-`undefined` values into the literal),
  // same discipline as capture.ts's applyOptionalFields: tsconfig's exactOptionalPropertyTypes
  // rejects writing `undefined` into NewFact's optional fields.
  const newFact: NewFact & { id: string } = {
    id: obj["id"],
    text: obj["text"],
    kind: obj["kind"] as FactKind,
    scope: obj["scope"] as FactScope,
    source_type: obj["source_type"] as FactSourceType,
    embedding,
  };
  if (typeof obj["subject"] === "string") {
    newFact.subject = obj["subject"];
  } else if (obj["subject"] === null) {
    newFact.subject = null;
  }
  if (typeof obj["value"] === "string") {
    newFact.value = obj["value"];
  } else if (obj["value"] === null) {
    newFact.value = null;
  }
  if (typeof obj["scopeRoot"] === "string") {
    newFact.scopeRoot = obj["scopeRoot"];
  } else if (obj["scopeRoot"] === null) {
    newFact.scopeRoot = null;
  }
  if (typeof obj["source_ref"] === "string") {
    newFact.source_ref = obj["source_ref"];
  } else if (obj["source_ref"] === null) {
    newFact.source_ref = null;
  }
  if (typeof obj["captured_at"] === "string") {
    newFact.captured_at = obj["captured_at"];
  }
  if (typeof obj["anchor"] === "string") {
    newFact.anchor = obj["anchor"];
  } else if (obj["anchor"] === null) {
    newFact.anchor = null;
  }
  if (typeof obj["status"] === "string") {
    newFact.status = obj["status"] as FactStatus;
  }
  if (typeof obj["confidence"] === "number") {
    newFact.confidence = obj["confidence"];
  }

  // Apply the same structural guards every other write path enforces (capture.ts's
  // `validateFactFieldsOrThrow` -- text/subject length limits, subject/value pairing). This is
  // reused, not redefined, so the limits/rules can never drift out of sync with
  // captureExplicit/captureSuggested/mem edit. Deliberately does NOT touch status/confidence: this
  // module's full-fidelity round-trip contract (see header comment) is unaffected -- only
  // structural shape is gated here, not trust level.
  //
  // Deliberately does NOT call `validateFactEditOrThrow` (which additionally enforces
  // `validateAnchorSyntax`'s CLI-facing arity check): that check exists only because `mem remember`/
  // `mem edit` parse the anchor out of a flat CLI string with a fixed delimiter scheme, where a
  // multi-word `file-contains`/`file-not-contains` substring would be ambiguous to parse. A JSON
  // `anchor` field is already a structured, unambiguous string -- there's no parsing step for a
  // multi-word substring to be ambiguous in -- so the arity check does not apply here, and skipping
  // it restores json-import's original documented exemption (a previously-exported fact with a
  // multi-word substring anchor must round-trip back in). `anchors.ts`'s `evaluateAnchor` never
  // throws on a malformed or unrecognized anchor regardless of arity -- it safely returns
  // `"unverified"` -- so this exemption carries no crash risk at evaluation time.
  try {
    // Plain conditional assignment (not spreading possibly-`undefined` values into the literal),
    // same discipline as this file's own newFact construction above: tsconfig's
    // exactOptionalPropertyTypes rejects writing `undefined` into an optional `string | null` field.
    const fieldsPatch: { text?: string; subject?: string | null; value?: string | null } = {
      text: newFact.text,
    };
    if (newFact.subject !== undefined) {
      fieldsPatch.subject = newFact.subject;
    }
    if (newFact.value !== undefined) {
      fieldsPatch.value = newFact.value;
    }
    validateFactFieldsOrThrow(fieldsPatch);
  } catch (error) {
    if (error instanceof CaptureValidationError || error instanceof InvalidAnchorError) {
      return fail(`facts[${index}] failed structural validation: ${error.message}`);
    }
    throw error;
  }

  const candidate: ImportCandidate = { text: candidateText, line: index + 1, sourceRef: `${newFact.id}` };
  return { candidate, newFact, reason: null };
}

/**
 * Reads and validates `path` into per-entry results (`ParsedEntry`), without touching the DB.
 * Shared by `planImportFromJson` and `importFromJson` so envelope/shape validation only lives in
 * one place. Throws `JsonImportError` for a whole-file problem (bad JSON, wrong `schemaVersion`,
 * missing `facts` array); an individual bad fact is instead reflected per-entry (`newFact: null`).
 */
function parseJsonFacts(path: string): { readonly filePath: string; readonly entries: readonly ParsedEntry[] } {
  const filePath = resolve(path);

  // Wrap file operations to reclassify filesystem errors (ENOENT, EACCES, etc.) as user errors
  // rather than internal errors: a missing or unreadable file is a user error (bad input path),
  // not a bug.
  const stat = statFileWithErrorMapping(filePath, JsonImportError);

  if (stat.size > MAX_IMPORT_FILE_SIZE_BYTES) {
    throw new JsonImportError(
      `${filePath} is too large (${stat.size} bytes, max ${MAX_IMPORT_FILE_SIZE_BYTES} bytes)`
    );
  }

  const raw = readFileWithErrorMapping(filePath, JsonImportError);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new JsonImportError(`invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new JsonImportError(`${filePath} does not contain a mem export envelope object`);
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope["schemaVersion"] !== JSON_EXPORT_SCHEMA_VERSION) {
    throw new JsonImportError(
      `${filePath} has unsupported schemaVersion ${JSON.stringify(envelope["schemaVersion"])} (expected ${JSON_EXPORT_SCHEMA_VERSION})`
    );
  }
  if (!Array.isArray(envelope["facts"])) {
    throw new JsonImportError(`${filePath} is missing a "facts" array`);
  }

  const entries = (envelope["facts"] as readonly unknown[]).map((rawFact, index) => validateJsonFact(rawFact, index));
  return { filePath, entries };
}

// ─────────────────────────────────────────────────────────────────────────── Import orchestration ───────────────────────────────────────────────────────────────────────────

/**
 * Reads and validates `options.path` into import candidates and their outcomes *without opening a
 * database* -- the entire body of a `--dry-run` import, same rationale as
 * `planImportFromMarkdown` (src/import.ts): opening mem's SQLite store does `mkdirSync` + creates
 * the db file/WAL sidecars/schema on disk, which would contradict `--dry-run`'s "nothing written"
 * contract. Unlike `planImportFromMarkdown`, a structurally invalid fact is already reported as
 * `skipped_error` here (not deferred to the real import), since shape validation needs no DB access
 * either.
 */
export function planImportFromJson(options: { readonly path: string }): ImportResult {
  const { filePath, entries } = parseJsonFacts(options.path);
  const candidates = entries.map((entry) => entry.candidate);
  const outcomes: ImportOutcome[] = entries.map((entry) =>
    entry.newFact === null
      ? { status: "skipped_error", candidate: entry.candidate, reason: entry.reason ?? "invalid fact" }
      : { status: "dry_run", candidate: entry.candidate }
  );
  return { filePath, candidates, outcomes };
}

export interface ImportFromJsonOptions {
  /** Path to the JSON export file to import. Resolved to an absolute path before reading. */
  readonly path: string;
  /** Project root used only to resolve `.mem/allowlist` for secret screening (full-fidelity import preserves each fact's original `scopeRoot` verbatim, so `root` is never used to derive it). Defaults to the current working directory. */
  readonly root?: string;
  /** When true, behaves exactly like `planImportFromJson` (no DB access, nothing written). */
  readonly dryRun?: boolean;
}

/** A pre-decided skip outcome (duplicate or secret) whose audit row is deferred into the import transaction so it can never outlive a rollback of that same transaction. */
interface PlannedSkip {
  readonly index: number;
  readonly event: string;
  readonly factId: string | null;
  readonly detail: string;
  readonly outcome: ImportOutcome;
}

/**
 * Imports every valid, non-duplicate fact from `options.path` via `insertFact` directly (not
 * `capture.ts`), preserving each fact's original `id`/`status`/`confidence`/`captured_at`/
 * `source_type` exactly as exported. A fact whose `id` already exists in the target store is
 * `skipped_duplicate` -- this is what makes re-running an import against the same store idempotent.
 * A fact that fails shape validation or secret screening is `skipped_error`, not fatal to the rest
 * of the import.
 *
 * Every DB write for this import -- both the skip-audit rows for duplicates/secrets and each
 * successful `insertFact` paired with its own `json_import` audit row -- runs inside a single
 * `db.transaction()`. This guarantees an unexpected exception anywhere in the batch rolls back
 * every write together: a crash mid-import can never leave a fact without its audit row, nor an
 * audit row (skip or import) that outlives a rollback of the work it describes. Per-fact
 * validation/secret/duplicate detection happens beforehand (pure reads and checks, no writes), so
 * it does not itself trigger or need that rollback -- only the writes it decides on are deferred
 * into the transaction.
 */
export function importFromJson(db: Database.Database, options: ImportFromJsonOptions): ImportResult {
  if (options.dryRun === true) {
    return planImportFromJson(options);
  }
  const { filePath, entries } = parseJsonFacts(options.path);

  const root = resolve(options.root ?? process.cwd());
  const allowlist = loadAllowlist(root);

  const candidates = entries.map((entry) => entry.candidate);
  const outcomes: (ImportOutcome | undefined)[] = new Array(entries.length).fill(undefined);
  const toInsert: { readonly index: number; readonly newFact: NewFact & { id: string } }[] = [];
  const skips: PlannedSkip[] = [];
  const seenIds = new Set<string>();

  entries.forEach((entry, index) => {
    if (entry.newFact === null) {
      outcomes[index] = { status: "skipped_error", candidate: entry.candidate, reason: entry.reason ?? "invalid fact" };
      return;
    }
    if (seenIds.has(entry.newFact.id)) {
      outcomes[index] = {
        status: "skipped_error",
        candidate: entry.candidate,
        reason: `duplicate id within import file: ${entry.newFact.id}`,
      };
      return;
    }
    seenIds.add(entry.newFact.id);
    const existing = getFactById(db, entry.newFact.id);
    if (existing !== undefined) {
      skips.push({
        index,
        event: "json_import_skipped_duplicate",
        factId: entry.newFact.id,
        detail: `skipped: fact ${entry.newFact.id} already exists`,
        outcome: { status: "skipped_duplicate", candidate: entry.candidate },
      });
      return;
    }
    const matches = screenForSecrets(
      {
        text: entry.newFact.text,
        subject: entry.newFact.subject,
        value: entry.newFact.value,
        anchor: entry.newFact.anchor,
        sourceRef: entry.newFact.source_ref,
      },
      allowlist
    );
    if (matches.length > 0) {
      skips.push({
        index,
        event: "json_import_skipped_secret",
        factId: null,
        detail: `blocked: ${matches.map((match) => `${match.field}/${match.patternName}`).join(", ")}`,
        outcome: {
          status: "skipped_error",
          candidate: entry.candidate,
          reason: `refusing to import fact: possible secret detected -- ${matches.map((match) => `${match.field}: ${match.patternName}`).join("; ")}`,
        },
      });
      return;
    }
    toInsert.push({ index, newFact: entry.newFact });
  });

  const insertedFacts = new Map<number, Fact>();
  const tx = db.transaction((): void => {
    for (const skip of skips) {
      insertAuditLog(db, { event: skip.event, factId: skip.factId, detail: skip.detail });
    }
    for (const { index, newFact } of toInsert) {
      const fact = insertFact(db, newFact);
      insertedFacts.set(index, fact);
      insertAuditLog(db, {
        event: "json_import",
        factId: fact.id,
        detail: `imported ${fact.status} ${fact.kind} fact from JSON export (id preserved)`,
      });
    }
  });
  tx();

  for (const skip of skips) {
    outcomes[skip.index] = skip.outcome;
  }
  for (const { index } of toInsert) {
    const fact = insertedFacts.get(index);
    if (fact === undefined) {
      throw new Error(`exportImport: importFromJson failed to read back an inserted fact at index ${index}`);
    }
    outcomes[index] = { status: "imported", candidate: candidates[index] as ImportCandidate, fact };
  }

  return { filePath, candidates, outcomes: outcomes as ImportOutcome[] };
}
