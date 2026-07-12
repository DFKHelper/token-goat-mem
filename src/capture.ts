/**
 * The two-mode capture pipeline (design plan Section 3, principles P1/P7,
 * review findings S7/S9).
 *
 * - `captureExplicit` — the user (or agent, on the user's behalf) said
 *   "remember X". Always `source_type: "user"`, always `status: "active"`
 *   immediately. This is the primary path.
 * - `captureSuggested` — a conservative extractor proposes a candidate fact.
 *   Always `status: "pending"`, no matter what the caller asks for: a
 *   pending fact NEVER auto-promotes via time, repetition, or a confidence
 *   number alone (S9 — the old "auto-confirm low-risk preferences" carve-out
 *   was exactly the injection hole and stays removed). Promotion happens
 *   only through an explicit `mem review` / `pin` / `edit` action elsewhere
 *   in the codebase; this module has no code path that can write
 *   `status: "active"` for a suggested candidate. `source_type: "derived"`
 *   facts (extracted from file/tool content, not something the user said)
 *   are quarantined hardest: capture defaults to the more suspicious
 *   `"derived"` when the caller doesn't say otherwise, and — because both
 *   modes force their own status regardless of input — a derived fact can
 *   never enter storage as anything but `pending`.
 *
 * Every capture is secret-screened first (design principle 7: "NEVER
 * persisted by default: secrets/credentials, high-entropy tokens... ").
 * Screening is deny-by-default: a match blocks the write outright (not a
 * redact-and-store) unless the exact matched value is listed in the
 * project's `.mem/allowlist`. There is no broad "disable this pattern"
 * escape hatch — the allowlist is a narrow, per-value, auditable override.
 *
 * The actual fact row is written via src/storage.ts's `insertFact` (the
 * canonical typed CRUD entry point per src/types.ts's own doc comments on
 * `NewFact`) rather than raw SQL here, so subject normalization, embedding
 * packing, `scope_root` handling, and epoch bumping all go through the one
 * place that owns them. Every successful or blocked capture is additionally
 * recorded in `audit_log` (design principle 5), which storage.ts does not
 * touch — that stays this module's responsibility.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";

import { insertAuditLog } from "./db.js";
import { insertFact as storageInsertFact } from "./storage.js";
import type { Fact, FactKind, FactScope, FactSourceType, NewFact } from "./types.js";

const FACT_KINDS: readonly FactKind[] = ["preference", "decision", "fact", "correction"];
const FACT_SCOPES: readonly FactScope[] = ["global", "project", "path"];
const SOURCE_TYPES: readonly FactSourceType[] = ["user", "derived"];

const MAX_TEXT_LENGTH = 500;
const MAX_SUBJECT_LENGTH = 100;
const MAX_VALUE_LENGTH = 500;
const MAX_SOURCE_REF_LENGTH = 500;

/** Suggested facts are never fully trusted by confidence number alone, no matter what a caller requests (S9): the stored value is clamped below this even if the caller asks for more. */
const SUGGESTED_CONFIDENCE_CAP = 0.6;
const SUGGESTED_CONFIDENCE_DEFAULT = 0.4;

// ─────────────────────────────────────────────────────────────────────────── Errors ───────────────────────────────────────────────────────────────────────────

export class CaptureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureValidationError";
  }
}

/**
 * Anchor predicates capture accepts, syntax-only (arg count and character
 * safety — not existence or semantics; that is evaluated later by
 * src/anchors.ts against real fs/git state at recall time). Must stay in
 * sync with the predicate set src/anchors.ts actually evaluates
 * (file-newer-than, file-exists, file-absent, git-tracked) — accepting a
 * predicate here that anchors.ts does not recognize would silently downgrade
 * it to permanently "unverified" with no capture-time warning, and no
 * arbitrary-shell anchors are permitted at all (Section 3 / review S4).
 */
export class InvalidAnchorError extends Error {
  constructor(anchor: string, reason: string) {
    super(
      `invalid anchor "${anchor}": ${reason}. Anchors must be a read-only fs/git predicate ` +
        `(file-newer-than <a> <b>, file-exists <a>, file-absent <a>, git-tracked <a>) — ` +
        `Section 3: no arbitrary-shell anchors.`
    );
    this.name = "InvalidAnchorError";
  }
}

/**
 * Thrown when a captured value matches a secret pattern that is not covered
 * by an explicit `.mem/allowlist` entry. Deny-by-default (design principle
 * 7): the write is refused outright, not redacted-and-stored.
 */
export class SecretDetectedError extends Error {
  readonly matches: readonly SecretMatch[];

  constructor(matches: readonly SecretMatch[]) {
    const summary = matches
      .map((match) => `${match.field}: ${match.patternName} (${redactPreview(match.matched)})`)
      .join("; ");
    super(
      `refusing to store fact: possible secret detected -- ${summary}. If this is not a secret, ` +
        `add the exact value to .mem/allowlist in the project root.`
    );
    this.name = "SecretDetectedError";
    this.matches = matches;
  }
}

// ─────────────────────────────────────────────────────────────────────────── Secret screening ───────────────────────────────────────────────────────────────────────────

export interface SecretMatch {
  readonly patternName: string;
  readonly field: string;
  readonly matched: string;
}

interface SecretPattern {
  readonly name: string;
  readonly regex: RegExp;
}

/** Named, well-known secret formats. Zero-effort to reason about, near-zero false-positive rate. */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "aws-access-key-id", regex: /AKIA[0-9A-Z]{16}/g },
  { name: "github-token", regex: /gh[pousr]_[A-Za-z0-9]{36,255}/g },
  { name: "slack-token", regex: /xox[baprs]-[0-9A-Za-z-]{10,72}/g },
  { name: "google-api-key", regex: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "stripe-key", regex: /sk_(?:live|test)_[0-9a-zA-Z]{16,}/g },
  { name: "anthropic-api-key", regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-style-key", regex: /sk-[A-Za-z0-9]{20,}/g },
  { name: "private-key-block", regex: /-----BEGIN[ A-Z]*PRIVATE KEY-----/g },
  { name: "jwt", regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    name: "password-assignment",
    regex: /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[^\s'"]{6,}['"]?/gi,
  },
];

/** Generic fallback (design principle 7b: "entropy screening" as its own layer, not just named patterns). Standalone tokens of length >= 32 from a base64/hex-ish alphabet, excluding pure-hex/pure-digit runs (git SHAs, ids — common in legitimate project facts, not secrets) and low-entropy strings. */
const GENERIC_TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;
const HEX_ONLY = /^[0-9a-f]{32,}$/i;
const DIGITS_ONLY = /^[0-9]{32,}$/;
const GENERIC_ENTROPY_THRESHOLD = 3.8;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function scanField(field: string, value: string): SecretMatch[] {
  const matches: SecretMatch[] = [];

  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let m = pattern.regex.exec(value);
    while (m !== null) {
      matches.push({ patternName: pattern.name, field, matched: m[0] });
      if (m[0].length === 0) {
        pattern.regex.lastIndex += 1;
      }
      m = pattern.regex.exec(value);
    }
  }

  GENERIC_TOKEN.lastIndex = 0;
  let g = GENERIC_TOKEN.exec(value);
  while (g !== null) {
    const token = g[0];
    if (!HEX_ONLY.test(token) && !DIGITS_ONLY.test(token) && shannonEntropy(token) >= GENERIC_ENTROPY_THRESHOLD) {
      matches.push({ patternName: "generic-high-entropy-token", field, matched: token });
    }
    g = GENERIC_TOKEN.exec(value);
  }

  return matches;
}

function redactPreview(matched: string): string {
  if (matched.length <= 8) {
    return "*".repeat(matched.length);
  }
  const masked = "*".repeat(Math.max(matched.length - 6, 3));
  return `${matched.slice(0, 4)}${masked}${matched.slice(-2)}`;
}

/**
 * Scans a set of named fields against the secret-pattern and entropy
 * heuristics, dropping any match whose exact text is covered by
 * `allowlist`. Exported so a `mem doctor` / `review` command can reuse the
 * same screening logic to audit already-stored allowlist entries.
 */
export function screenForSecrets(
  fields: Readonly<Record<string, string | null | undefined>>,
  allowlist: readonly string[]
): SecretMatch[] {
  const allowed = new Set(allowlist);
  const matches: SecretMatch[] = [];
  for (const [field, value] of Object.entries(fields)) {
    if (value === null || value === undefined || value.length === 0) {
      continue;
    }
    for (const match of scanField(field, value)) {
      if (!allowed.has(match.matched)) {
        matches.push(match);
      }
    }
  }
  return matches;
}

/**
 * Loads the narrow, explicit secret-screening override list from
 * `<root>/.mem/allowlist` (design principle 7 / Open Question 1). One exact
 * value per line; blank lines and lines starting with `#` are ignored.
 * Entries are exact-match strings, not patterns or category names — the
 * allowlist can only exempt specific, already-reviewed values, never
 * silently disable a whole detector. Missing file means an empty allowlist,
 * not an error: most projects will never need one.
 */
export function loadAllowlist(root: string): string[] {
  const allowlistPath = join(root, ".mem", "allowlist");
  if (!existsSync(allowlistPath)) {
    return [];
  }
  const raw = readFileSync(allowlistPath, "utf8");
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

// ─────────────────────────────────────────────────────────────────────────── Anchor syntax ───────────────────────────────────────────────────────────────────────────

const ANCHOR_ARITY: Readonly<Record<string, number>> = {
  "file-newer-than": 2,
  "file-exists": 1,
  "file-absent": 1,
  "git-tracked": 1,
};

const DISALLOWED_ANCHOR_ARG_LITERALS = ";&|`$<>";

/** True if `arg` contains a control character or one of the shell-metacharacter literals above. Defense-in-depth only -- anchors.ts always shells out via execFileSync's argv-array form (never shell-string interpolation), so this is not load-bearing for injection safety, but a stray control byte or shell metacharacter in an anchor argument is never legitimate for a plain fs path. */
function hasDisallowedAnchorChar(arg: string): boolean {
  for (const ch of arg) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || DISALLOWED_ANCHOR_ARG_LITERALS.includes(ch)) {
      return true;
    }
  }
  return false;
}

function validateAnchorSyntax(anchor: string): void {
  const tokens = anchor.trim().split(/\s+/u).filter((token) => token.length > 0);
  const [predicate, ...args] = tokens;
  if (predicate === undefined) {
    throw new InvalidAnchorError(anchor, "empty anchor");
  }
  const arity = ANCHOR_ARITY[predicate];
  if (arity === undefined) {
    throw new InvalidAnchorError(
      anchor,
      `unknown predicate "${predicate}" (expected one of ${Object.keys(ANCHOR_ARITY).join(", ")})`
    );
  }
  if (args.length !== arity) {
    throw new InvalidAnchorError(anchor, `"${predicate}" expects ${arity} argument(s), got ${args.length}`);
  }
  for (const arg of args) {
    if (hasDisallowedAnchorChar(arg)) {
      throw new InvalidAnchorError(anchor, `argument "${arg}" contains disallowed characters`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────── Capture pipeline ───────────────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface CaptureExplicitInput {
  readonly text: string;
  readonly kind: FactKind;
  readonly subject?: string;
  readonly value?: string;
  readonly anchor?: string;
  readonly scope?: FactScope;
  readonly sourceRef?: string;
  /** Project root, used to resolve `.mem/allowlist` and (for project/path scope) recorded as the fact's `scopeRoot`. Required, never defaulted to ambient `process.cwd()` (matches src/anchors.ts's explicit-root discipline). */
  readonly root: string;
}

export interface CaptureSuggestedInput extends CaptureExplicitInput {
  /** Defaults to `"derived"` — the more suspicious option — when omitted, per the quarantine-hardest rule (Section 3). */
  readonly sourceType?: FactSourceType;
  /** Advisory only: always clamped to `[0, SUGGESTED_CONFIDENCE_CAP]` regardless of what is requested, since a pending/suggested fact can never carry full trust (S9). */
  readonly confidence?: number;
}

export interface CaptureResult {
  readonly fact: Fact;
}

function validateCommonInput(input: CaptureExplicitInput): { text: string; root: string } {
  const text = input.text.trim();
  if (text.length === 0) {
    throw new CaptureValidationError("fact text must not be empty");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new CaptureValidationError(
      `fact text exceeds ${MAX_TEXT_LENGTH} characters -- store a short extracted fact, not raw ` +
        `content (design principle 7a: "only short extracted facts are stored, never raw dumps")`
    );
  }
  if (!FACT_KINDS.includes(input.kind)) {
    throw new CaptureValidationError(`invalid kind "${input.kind}" (expected one of ${FACT_KINDS.join(", ")})`);
  }
  if (input.scope !== undefined && !FACT_SCOPES.includes(input.scope)) {
    throw new CaptureValidationError(`invalid scope "${input.scope}" (expected one of ${FACT_SCOPES.join(", ")})`);
  }

  const hasSubject = input.subject !== undefined && input.subject.trim().length > 0;
  const hasValue = input.value !== undefined && input.value.trim().length > 0;
  if (hasSubject !== hasValue) {
    throw new CaptureValidationError(
      "subject and value must be provided together or not at all (design P4: contradiction " +
        "detection keys on subject+value pairs -- a lone key is unusable)"
    );
  }
  if (input.subject !== undefined && input.subject.trim().length > MAX_SUBJECT_LENGTH) {
    throw new CaptureValidationError(`subject exceeds ${MAX_SUBJECT_LENGTH} characters`);
  }
  if (input.value !== undefined && input.value.trim().length > MAX_VALUE_LENGTH) {
    throw new CaptureValidationError(`value exceeds ${MAX_VALUE_LENGTH} characters`);
  }
  if (input.sourceRef !== undefined) {
    if (input.sourceRef.trim().length === 0) {
      throw new CaptureValidationError("sourceRef, if provided, must not be empty");
    }
    if (input.sourceRef.trim().length > MAX_SOURCE_REF_LENGTH) {
      throw new CaptureValidationError(`sourceRef exceeds ${MAX_SOURCE_REF_LENGTH} characters`);
    }
  }
  if (input.anchor !== undefined && input.anchor.trim().length > 0) {
    validateAnchorSyntax(input.anchor.trim());
  }

  const root = input.root.trim();
  if (root.length === 0) {
    throw new CaptureValidationError("root must not be empty");
  }

  return { text, root };
}

function screenInputOrThrow(
  db: Database.Database,
  input: CaptureExplicitInput,
  root: string,
  auditEvent: string
): void {
  const allowlist = loadAllowlist(root);
  const matches = screenForSecrets(
    {
      text: input.text,
      subject: input.subject,
      value: input.value,
      anchor: input.anchor,
      sourceRef: input.sourceRef,
    },
    allowlist
  );
  if (matches.length > 0) {
    insertAuditLog(db, {
      event: `${auditEvent}_blocked_secret`,
      factId: null,
      detail: `blocked: ${matches.map((match) => `${match.field}/${match.patternName}`).join(", ")}`,
    });
    throw new SecretDetectedError(matches);
  }
}

/**
 * Builds the shared, always-present part of a `NewFact` for either capture
 * mode, then lets each caller layer on its mode-specific fields (subject,
 * anchor, sourceRef, scopeRoot) -- kept as plain conditional assignment
 * (rather than spreading possibly-`undefined` values into the literal)
 * because `NewFact`'s optional fields are typed without an explicit
 * `| undefined`, and `exactOptionalPropertyTypes` (tsconfig.json) rejects
 * writing `undefined` into them.
 */
function applyOptionalFields(
  target: NewFact,
  input: CaptureExplicitInput,
  scope: FactScope,
  root: string
): void {
  if (input.subject !== undefined && input.subject.trim().length > 0) {
    target.subject = input.subject.trim();
    // validateCommonInput already enforced subject/value pairing, so `value` is guaranteed present here.
    target.value = (input.value ?? "").trim();
  }
  if (input.anchor !== undefined && input.anchor.trim().length > 0) {
    target.anchor = input.anchor.trim();
  }
  if (input.sourceRef !== undefined && input.sourceRef.trim().length > 0) {
    target.source_ref = input.sourceRef.trim();
  }
  if (scope !== "global") {
    target.scopeRoot = resolve(root);
  }
}

function writeFact(
  db: Database.Database,
  newFact: NewFact,
  auditEvent: string,
  detail: (fact: Fact) => string
): Fact {
  const fact = storageInsertFact(db, newFact);
  insertAuditLog(db, { event: auditEvent, factId: fact.id, detail: detail(fact) });
  return fact;
}

/**
 * Explicit capture: the user (or an agent on the user's behalf) said
 * "remember X". Stored `active` immediately, `source_type: "user"` always
 * (there is no parameter to override either — explicit capture is
 * definitionally user-stated, maximal-trust input, design principle P1).
 */
export function captureExplicit(db: Database.Database, input: CaptureExplicitInput): CaptureResult {
  const { text, root } = validateCommonInput(input);
  screenInputOrThrow(db, input, root, "capture_explicit");

  const scope = input.scope ?? "global";
  const newFact: NewFact = {
    text,
    kind: input.kind,
    scope,
    source_type: "user",
    status: "active",
    confidence: 1,
  };
  applyOptionalFields(newFact, input, scope, root);

  const fact = writeFact(db, newFact, "capture_explicit", (f) => `stored active ${f.kind} fact (scope=${f.scope})`);
  return { fact };
}

/**
 * Suggested capture: a conservative extractor proposes a candidate fact.
 * Always stored `pending` — there is no parameter to request `active`, so
 * no caller (however it phrases the request) can make a suggested candidate
 * skip human confirmation (S9). `source_type` defaults to `"derived"`, the
 * more heavily quarantined option, when the caller does not specify it.
 */
export function captureSuggested(db: Database.Database, input: CaptureSuggestedInput): CaptureResult {
  const { text, root } = validateCommonInput(input);
  screenInputOrThrow(db, input, root, "capture_suggested");

  const sourceType = input.sourceType ?? "derived";
  if (!SOURCE_TYPES.includes(sourceType)) {
    throw new CaptureValidationError(`invalid sourceType "${sourceType}" (expected one of ${SOURCE_TYPES.join(", ")})`);
  }
  if (input.confidence !== undefined && !Number.isFinite(input.confidence)) {
    throw new CaptureValidationError("confidence must be a finite number");
  }
  const confidence = clamp(input.confidence ?? SUGGESTED_CONFIDENCE_DEFAULT, 0, SUGGESTED_CONFIDENCE_CAP);

  const scope = input.scope ?? "global";
  const newFact: NewFact = {
    text,
    kind: input.kind,
    scope,
    source_type: sourceType,
    // Never active, never anything else: this is the single place a suggested fact's status is
    // decided, and it is hardcoded so no caller input can reach "active" through this path.
    status: "pending",
    confidence,
  };
  applyOptionalFields(newFact, input, scope, root);

  const fact = writeFact(
    db,
    newFact,
    "capture_suggested",
    (f) => `stored pending ${f.kind} fact (source_type=${f.source_type}, scope=${f.scope})`
  );
  return { fact };
}
