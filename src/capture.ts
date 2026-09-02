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

import { anchorPathWithinRoot } from "./anchors.js";
import { insertAuditLog } from "./db.js";
import { insertFact as storageInsertFact } from "./storage.js";
import { FACT_KINDS, FACT_SCOPES } from "./types.js";
import type { Fact, FactKind, FactScope, FactSourceType, NewFact } from "./types.js";

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
 * (file-newer-than, file-exists, file-absent, file-contains, file-not-contains,
 * newest-of, glob-exists, git-branch-is, git-tracked, package-version) — accepting a
 * predicate here that anchors.ts does not recognize would silently downgrade
 * it to permanently "unverified" with no capture-time warning, and no
 * arbitrary-shell anchors are permitted at all (Section 3 / review S4).
 */
export class InvalidAnchorError extends Error {
  constructor(anchor: string, reason: string) {
    super(
      `invalid anchor "${anchor}": ${reason}. Anchors must be a read-only fs/git predicate ` +
        `(file-newer-than, file-exists, file-absent, file-contains, file-not-contains, ` +
        `newest-of, glob-exists, git-branch-is, git-tracked, package-version) — ` +
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
  /**
   * A long hex run written near a credential word, in prose rather than assignment syntax.
   *
   * The entropy fallback below deliberately exempts pure-hex tokens so that quoting a commit SHA in
   * a fact does not read as a credential -- but HMAC signing secrets, webhook secrets, and plenty of
   * API keys are also pure hex, so that exemption doubled as a blanket bypass for an entire common
   * secret format. `password-assignment` above did not close it either: it requires a `:`/`=`
   * separator, and `the webhook signing secret is <64 hex>` has neither.
   *
   * Scoped to hex specifically, and only within a short window of a credential word, because that
   * is exactly the class the exemption creates a hole in: a non-hex high-entropy secret is still
   * caught by the entropy fallback on its own, so widening this pattern past hex would add false
   * positives without adding coverage. A SHA that genuinely appears next to the word "secret" is
   * the accepted cost, and the error message names the `.mem/allowlist` escape hatch.
   */
  {
    name: "secret-keyword-hex",
    regex: /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|signing[_-]?(?:key|secret))\b[^\n]{0,32}?\b[0-9a-fA-F]{32,}\b/gi,
  },
];

/** Generic fallback (design principle 7b: "entropy screening" as its own layer, not just named patterns). Standalone tokens of length >= 32 from a base64/hex-ish alphabet, excluding pure-hex/pure-digit runs (git SHAs, ids — common in legitimate project facts, not secrets) and low-entropy strings. */
const GENERIC_TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;
const HEX_ONLY = /^[0-9a-f]+$/i;
const DIGITS_ONLY = /^[0-9]{32,}$/;

/**
 * Hex-token lengths that correspond to a canonical content hash a project fact legitimately quotes:
 * md5 (32), sha1 (40), sha256 (64). Anything else -- 48, 96, 33 -- is not a hash anyone writes down,
 * and is far likelier an HMAC or API secret, so it gets no exemption from the entropy fallback.
 *
 * The exemption used to be unconditional for any hex run of 32 or more characters, which was
 * strictly broader than its own stated rationale ("git SHAs, ids"): git SHAs are 7-12 characters
 * abbreviated and 40 in full, so nothing under 32 ever reached {@link GENERIC_TOKEN}'s floor and
 * nothing above 64 was ever a SHA. Perfect separation is impossible -- a 64-hex string is
 * genuinely ambiguous between sha256 and an HMAC secret -- so the ambiguous lengths stay exempt
 * here and are covered instead by the `secret-keyword-hex` pattern above, which only fires when the
 * surrounding text says it is a credential.
 */
const CANONICAL_HEX_HASH_LENGTHS: ReadonlySet<number> = new Set([32, 40, 64]);

/** Whether a token is a pure-hex run of a length that plausibly denotes a content hash rather than a secret. */
function isCanonicalHexHash(token: string): boolean {
  return HEX_ONLY.test(token) && CANONICAL_HEX_HASH_LENGTHS.has(token.length);
}
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

/**
 * Fields that legitimately contain long, forward-slash-delimited path-shaped values -- an anchor's
 * fs/git predicate argument, or a `sourceRef` provenance pointer (`<path>:<line>`, but for
 * `mem remember --source-ref` a free-form, user/agent-supplied string, so it is NOT exempt from
 * `SECRET_PATTERNS` or from a slash-free high-entropy token) -- so a slash-containing token is
 * excluded from the *generic* high-entropy-token heuristic below: `GENERIC_TOKEN`'s alphabet
 * includes "/", so any plausible, entirely benign `file-exists <long/nested/path.tsx>` or
 * `src/very/long/path.ts:123` argument over ~32 chars can exceed the entropy threshold purely from
 * directory-name variety, with no secret present at all. The exemption only applies to a matched
 * token that contains "/" -- a prefix-less high-entropy secret with no path separator (an
 * unlabeled credential with no recognized `SECRET_PATTERNS` prefix) is still caught by the entropy
 * fallback. Named `SECRET_PATTERNS` (aws-access-key-id, etc.) always run against these fields
 * regardless.
 */
const GENERIC_ENTROPY_EXEMPT_FIELDS: ReadonlySet<string> = new Set(["anchor", "sourceRef"]);

/** One `/`-delimited segment of a path-shaped token: a lowercase word (or digits) with `.`/`_`/`-` joining further lowercase words -- `agent-self-compaction`, `session_continuity.md`, `v2`. Deliberately rejects uppercase, `+`, and `=`, which is what separates a filename from a base64/random credential. */
const PATH_SEGMENT = /^[a-z0-9]+([._-][a-z0-9]+)*$/;

/** Longest unbroken `[a-z0-9]` run allowed inside a path segment. Real directory and file names this long are written as words joined by `-`/`_`/`.` (`very-long-nested-directory-name`), whereas an unbroken run of this length is the shape of a lowercase random token -- so requiring a separator past this length stops `<long-run>/x9` from buying an exemption on segment count alone. */
const MAX_UNBROKEN_SEGMENT_RUN = 24;

function isPathSegment(segment: string): boolean {
  return PATH_SEGMENT.test(segment) && segment.split(/[._-]/).every((run) => run.length <= MAX_UNBROKEN_SEGMENT_RUN);
}

/**
 * Whether a token is shaped like a relative filesystem path of ordinary lowercase identifiers,
 * which the *generic* entropy heuristic must not flag: the same directory-name variety that the
 * `GENERIC_ENTROPY_EXEMPT_FIELDS` comment above describes for anchors also pushes a perfectly
 * benign path quoted inside a fact's `text` over the threshold (`agent-self-compaction/superman-state`
 * scores 3.88 against a 3.8 cutoff), and a decision fact naturally cites file paths.
 *
 * The exemption is shape-based, never merely slash-based, because real credentials do contain
 * slashes -- an AWS secret access key (`wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`, entropy 4.66)
 * is exactly the prefix-less secret this entropy fallback exists to catch. Requiring every segment
 * to be lowercase-word-shaped rejects it on the uppercase alone, as it does base64 blobs (`+`/`=`)
 * and mixed-case tokens generally. Two or more non-empty segments are required so a single long
 * lowercase run can never buy an exemption just by carrying one slash. Named `SECRET_PATTERNS`
 * still run against every field regardless of this, so a recognized credential format is caught
 * even when it happens to look path-like.
 */
function isPathShapedToken(token: string): boolean {
  if (!token.includes("/")) {
    return false;
  }
  const segments = token.split("/").filter((segment) => segment.length > 0);
  return segments.length >= 2 && segments.every(isPathSegment);
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

  const exemptField = GENERIC_ENTROPY_EXEMPT_FIELDS.has(field);
  GENERIC_TOKEN.lastIndex = 0;
  let g = GENERIC_TOKEN.exec(value);
  while (g !== null) {
    const token = g[0];
    if (
      !(exemptField && token.includes("/")) &&
      !isPathShapedToken(token) &&
      !isCanonicalHexHash(token) &&
      !DIGITS_ONLY.test(token) &&
      shannonEntropy(token) >= GENERIC_ENTROPY_THRESHOLD
    ) {
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

const ANCHOR_ARITY: Readonly<Record<string, number | { readonly min: number }>> = {
  "file-newer-than": 2,
  "file-exists": 1,
  "file-absent": 1,
  "file-contains": 2,
  "file-not-contains": 2,
  "newest-of": { min: 2 },
  "glob-exists": 1,
  "git-branch-is": 1,
  "git-tracked": 1,
  "package-version": 2,
};

const DISALLOWED_ANCHOR_ARG_LITERALS = ";&|`$<>";

/**
 * Placeholder root used only to run {@link anchorPathWithinRoot}'s containment math at syntax-check
 * time, before the real `--root` for a `mem remember`/`mem edit` invocation is even known (this
 * validation runs on the raw CLI string). The actual value is irrelevant to the check: a `..`
 * segment escapes *any* root, and an absolute argument resolves to itself regardless of root, so
 * either always fails containment against this (or any) placeholder. The evaluator (`src/anchors.ts`)
 * re-derives and re-checks containment against the real root on every evaluation regardless -- this
 * is purely an early, capture-time rejection so a doomed-to-`unverified`-forever anchor is refused
 * with an error instead of silently rotting.
 */
const ANCHOR_SYNTAX_CHECK_ROOT = resolve("/mem-anchor-syntax-check-placeholder");

/**
 * Argument indices, for a given predicate, that are filesystem paths and must therefore stay within
 * whatever root the anchor is later evaluated against -- no `..` traversal, no absolute path. Indices
 * outside a predicate's own arity are simply never reached by the caller's loop.
 */
function pathArgIndices(predicate: string, argCount: number): readonly number[] {
  switch (predicate) {
    case "file-newer-than":
      return [0, 1];
    case "file-exists":
    case "file-absent":
    case "file-contains":
    case "file-not-contains":
    case "glob-exists":
    case "git-tracked":
    case "package-version":
      return [0];
    case "newest-of":
      return Array.from({ length: argCount }, (_unused, index) => index);
    case "git-branch-is":
      return [];
    default:
      return [];
  }
}

/** True if `arg` contains a control character or one of the shell-metacharacter literals above. Defense-in-depth only -- anchors.ts never shells out at all (it reads `.git/HEAD`/`.git/index` directly, per its own header comment), so this is not load-bearing for injection safety, but a stray control byte or shell metacharacter in an anchor argument is never legitimate for a plain fs path. */
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
  // `file-contains`/`file-not-contains`'s substring argument may legitimately contain whitespace
  // (anchors.ts's evaluator parses it via a raw-regex pre-pass, not plain whitespace-splitting) --
  // this whitespace-split syntax check only accepts single-token substrings for those two
  // predicates. A multi-word substring anchor must be written via `mem import --from-json`, which
  // bypasses this syntax gate entirely.
  const arityOk = typeof arity === "number" ? args.length === arity : args.length >= arity.min;
  if (!arityOk) {
    const expected = typeof arity === "number" ? `${arity}` : `at least ${arity.min}`;
    throw new InvalidAnchorError(anchor, `"${predicate}" expects ${expected} argument(s), got ${args.length}`);
  }
  for (const arg of args) {
    if (hasDisallowedAnchorChar(arg)) {
      throw new InvalidAnchorError(anchor, `argument "${arg}" contains disallowed characters`);
    }
  }
  // Reject a path argument that can never affirm: one that escapes whatever root it will later be
  // evaluated against (`../x`) or names an absolute location (`/etc/passwd`, `C:\Windows\...`).
  // `resolveWithinRoot`/`anchorPathWithinRoot` would return `null` for these at every future
  // evaluation, forever `unverified` -- tell the user now, at capture time, instead of letting the
  // fact rot silently.
  for (const index of pathArgIndices(predicate, args.length)) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (anchorPathWithinRoot(ANCHOR_SYNTAX_CHECK_ROOT, arg) === null) {
      throw new InvalidAnchorError(
        anchor,
        `argument "${arg}" must be a path within the anchor root (no ".." traversal, no absolute path)`
      );
    }
  }
}

/**
 * Applies the field-level guards `mem remember`/`captureExplicit` enforce (length limits,
 * emptiness, subject/value pairing) to a patch of fact fields, WITHOUT the CLI-facing
 * anchor-syntax arity check (see `validateAnchorSyntax`). Only validates fields actually present in
 * the patch; a `null` clears the field and is not validated (clearing is always safe).
 *
 * Deliberately anchor-syntax-agnostic: this is the shared base used both by `validateFactEditOrThrow`
 * (which adds the arity check back on top, since `mem edit` takes CLI-string input just like `mem
 * remember`) and by JSON import (which must NOT apply the arity check -- a JSON `anchor` field is
 * structured data, not a CLI-parsed string, so there is no parsing ambiguity for a multi-word
 * `file-contains`/`file-not-contains` substring to create). Anchor *correctness* for callers that
 * skip the arity check is still guaranteed: `anchors.ts`'s `evaluateAnchor` never throws on a
 * malformed or unrecognized anchor string regardless of arity -- it just returns `"unverified"`.
 */
export function validateFactFieldsOrThrow(patch: {
  readonly text?: string;
  readonly subject?: string | null;
  readonly value?: string | null;
}): void {
  if (patch.text !== undefined) {
    const text = patch.text.trim();
    if (text.length === 0) {
      throw new CaptureValidationError("fact text must not be empty");
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new CaptureValidationError(
        `fact text exceeds ${MAX_TEXT_LENGTH} characters -- store a short extracted fact, not raw ` +
          `content (design principle 7a: "only short extracted facts are stored, never raw dumps")`
      );
    }
  }
  if (typeof patch.subject === "string") {
    const subject = patch.subject.trim();
    if (subject.length === 0) {
      throw new CaptureValidationError("subject must not be empty");
    }
    if (subject.length > MAX_SUBJECT_LENGTH) {
      throw new CaptureValidationError(`subject exceeds ${MAX_SUBJECT_LENGTH} characters`);
    }
  }
  if (typeof patch.value === "string") {
    const value = patch.value.trim();
    if (value.length === 0) {
      throw new CaptureValidationError("value must not be empty");
    }
    if (value.length > MAX_VALUE_LENGTH) {
      throw new CaptureValidationError(`value exceeds ${MAX_VALUE_LENGTH} characters`);
    }
  }
  // Enforce subject/value pairing: if both are present in the patch and are strings (not null),
  // they must both be non-empty. This mirrors captureExplicit's rule: "subject and value must
  // be provided together or not at all (design P4: contradiction detection keys on subject+value
  // pairs -- a lone key is unusable)".
  const hasSubjectInPatch = typeof patch.subject === "string" && patch.subject.trim().length > 0;
  const hasValueInPatch = typeof patch.value === "string" && patch.value.trim().length > 0;
  if (hasSubjectInPatch !== hasValueInPatch) {
    throw new CaptureValidationError(
      "subject and value must be provided together or not at all (design P4: contradiction " +
        "detection keys on subject+value pairs -- a lone key is unusable)"
    );
  }
}

/**
 * Applies the same field-level guards `mem remember`/`captureExplicit` enforce (length limits,
 * emptiness, anchor syntax) to a `mem edit` patch -- editing is a distinct write path from capture
 * and was previously exempt from all of this, letting an edit store a fact capture would have
 * rejected (an over-length text, an empty text, or a malformed anchor that permanently evaluates
 * "unverified"). Only validates fields actually present in the patch; a `null` clears the field and
 * is not validated (clearing is always safe).
 *
 * `mem edit`, like `mem remember`, takes CLI-string input, so it keeps the anchor-syntax arity
 * check (`validateAnchorSyntax`) that JSON import is exempt from -- see `validateFactFieldsOrThrow`.
 */
export function validateFactEditOrThrow(patch: {
  readonly text?: string;
  readonly subject?: string | null;
  readonly value?: string | null;
  readonly anchor?: string | null;
}): void {
  validateFactFieldsOrThrow(patch);
  if (typeof patch.anchor === "string" && patch.anchor.trim().length > 0) {
    validateAnchorSyntax(patch.anchor.trim());
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
  /**
   * File (or directory) this fact is bound to, required when `scope === "path"` and rejected
   * otherwise. Resolved against `root` -- never against ambient `process.cwd()` -- and stored as
   * `scopeRoot`. Without this, `scope: "path"` had no way to bind to anything narrower than `root`
   * itself, which made a "path" fact behave exactly like a "project" fact (isInScope/isBoundToRoot
   * both resolve `scope="path"`'s binding the same way `scope="project"` resolves its own).
   */
  readonly path?: string;
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

export function screenInputOrThrow(
  db: Database.Database,
  input: CaptureExplicitInput,
  root: string,
  auditEvent: string,
  factId: string | null = null
): void {
  const allowlist = loadAllowlist(root);
  // sourceRef is scanned like any other field: for the `mem import --from-md` path it's a
  // programmatically constructed "<resolved path>:<line>" provenance pointer, but `mem remember
  // --source-ref <ref>` accepts an arbitrary user/agent-supplied string, so it must not be
  // excluded outright. It's in GENERIC_ENTROPY_EXEMPT_FIELDS instead (see that comment): named
  // SECRET_PATTERNS always run, and only a slash-containing token skips the generic entropy
  // fallback, so the legitimate "<path>:<line>" false-positive is still avoided without leaving a
  // prefix-less secret unscreened.
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
      factId,
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
    const trimmedPath = input.path?.trim();
    target.scopeRoot =
      scope === "path" && trimmedPath !== undefined && trimmedPath.length > 0
        ? resolve(root, trimmedPath)
        : resolve(root);
  }
}

/**
 * Inserts a fact and writes its capture audit row atomically -- both run inside a single
 * `db.transaction()` (nesting `storageInsertFact`'s own transaction via savepoint, the same pattern
 * exportImport.ts's `importFromJson` uses) so a crash between the two can never leave a fact with no
 * corresponding audit entry, mirroring 008f60b's json_import fix.
 */
function writeFact(
  db: Database.Database,
  newFact: NewFact,
  auditEvent: string,
  detail: (fact: Fact) => string
): Fact {
  const tx = db.transaction((): Fact => {
    const fact = storageInsertFact(db, newFact);
    insertAuditLog(db, { event: auditEvent, factId: fact.id, detail: detail(fact) });
    return fact;
  });
  // BEGIN IMMEDIATE: the inner `storageInsertFact` reads the epoch before writing, and once this
  // outer transaction is open the inner one degrades to a savepoint -- so the outer variant is the
  // one that decides whether the read-then-write pair is safe against a concurrent writer under WAL.
  // See storage.insertFact for the full SQLITE_BUSY_SNAPSHOT rationale.
  return tx.immediate();
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
