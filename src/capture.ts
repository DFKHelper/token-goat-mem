/** The two-mode capture pipeline (design plan Section 3, principles P1/P7, review findings S7/S9). - `captureExplicit` — the user (or agent, on the user's behalf) said "remember X". Always `source_type: "user"`, always `status: "active"` immediately. This is the primary path. - `captureSuggested` — a conservative extractor proposes a candidate fact. Always `status: "pending"`, no matter what the caller asks for: a pending fact NEVER auto-promotes via time, repetition, or a confidence number alone (S9 — the old "auto-confirm low-risk preferences" carve-out was exactly the injection hole and stays removed). Promotion happens only through an explicit `mem review` / `pin` / `edit` action elsewhere in the codebase; this module has no code path that can write `status: "active"` for a suggested candidate. `source_type: "derived"` facts (extracted from file/tool content, not something the user said) are quarantined hardest: capture defaults to the more suspicious `"derived"` when the caller doesn't say otherwise, and — because both modes force their own status regardless of input — a derived fact can never enter storage as anything but `pending`. Every capture is secret-screened first (design principle 7: "NEVER persisted by default: secrets/credentials, high-entropy tokens... "). Screening is deny-by-default: a match blocks the write outright (not a redact-and-store) unless the exact matched value is listed in the project's `.mem/allowlist`. There is no broad "disable this pattern" escape hatch — the allowlist is a narrow, per-value, auditable override. The actual fact row is written via src/storage.ts's `insertFact` (the canonical typed CRUD entry point per src/types.ts's own doc comments on `NewFact`) rather than raw SQL here, so subject normalization, embedding packing, `scope_root` handling, and epoch bumping all go through the one place that owns them. Every successful or blocked capture is additionally recorded in `audit_log` (design principle 5), which storage.ts does not touch — that stays this module's responsibility. */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";

import { anchorPathWithinRoot, parseValidUntilDeadline } from "./anchors.js";
import { parseStrictIsoTimestamp } from "./timeUtils.js";
import { insertAuditLog, listAuditLogForFact, STAMPED_REF_DETAIL_MARKER, SUPERSEDED_AS_DUPLICATE_PREFIX } from "./db.js";
import { resolveProjectIdentity } from "./projectIdentity.js";
import { isBoundToRoot } from "./projectIdentity.js";
import {
  factsByTextHash,
  findReaffirmableFact,
  findReaffirmablePendingFacts,
  incrementSightings,
  insertFact as storageInsertFact,
  insertSource,
  listSourcesForFact,
  normalizeFactText,
  reaffirmFact,
  setFactStatus,
} from "./storage.js";
import type { RestatementUpdates } from "./storage.js";
import { FACT_KINDS, FACT_SCOPES, factNounPhrase } from "./types.js";
import type { Fact, FactKind, FactScope, FactSourceType, NewFact } from "./types.js";

const SOURCE_TYPES: readonly FactSourceType[] = ["user", "derived"];

const MAX_TEXT_LENGTH = 500;
const MAX_SUBJECT_LENGTH = 100;
const MAX_VALUE_LENGTH = 500;
const MAX_SOURCE_REF_LENGTH = 500;
const MAX_RATIONALE_LENGTH = 500;

/** Longest excerpt persisted to `sources.excerpt` (see storage.ts's Source doc: "Never the full source content -- callers are responsible for redacting/truncating"). ~600 chars covers a full user turn or markdown bullet line's causal context without the audit trail becoming a second copy of the transcript/file it was pulled from. */
export const MAX_SOURCE_EXCERPT_LENGTH = 600;

const EXCERPT_TRUNCATION_MARKER = "…";

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

/** Anchor predicates capture accepts, syntax-only (arg count and character safety — not existence or semantics; that is evaluated later by src/anchors.ts against real fs/git state at recall time). Must stay in sync with the predicate set src/anchors.ts actually evaluates (file-newer-than, file-exists, file-absent, file-contains, file-not-contains, newest-of, glob-exists, git-branch-is, git-tracked, package-version, valid-until) — accepting a predicate here that anchors.ts does not recognize would silently downgrade it to permanently "unverified" with no capture-time warning, and no arbitrary-shell anchors are permitted at all (Section 3 / review S4). */
export class InvalidAnchorError extends Error {
  constructor(anchor: string, reason: string) {
    super(
      `invalid anchor "${anchor}": ${reason}. Anchors must be a read-only fs/git predicate ` +
        `(file-newer-than, file-exists, file-absent, file-contains, file-not-contains, ` +
        `newest-of, glob-exists, git-branch-is, git-tracked, package-version, valid-until) — ` +
        `Section 3: no arbitrary-shell anchors.`
    );
    this.name = "InvalidAnchorError";
  }
}

/** A `SecretMatch` reduced to what a caller of `SecretDetectedError` legitimately needs -- which pattern fired, which field, and a masked preview -- with the raw matched literal dropped. The whole purpose of {@link SecretDetectedError} is that the credential must not travel any further; retaining `matched` on a field as public as `matches` would let any `JSON.stringify(err)` or log of the caught error echo the secret straight back out. */
export interface SecretMatchSummary {
  readonly patternName: string;
  readonly field: string;
  readonly preview: string;
  readonly length: number;
}

/** Thrown when a captured value matches a secret pattern that is not covered by an explicit `.mem/allowlist` entry. Deny-by-default (design principle 7): the write is refused outright, not redacted-and-stored. */
export class SecretDetectedError extends Error {
  readonly matches: readonly SecretMatchSummary[];

  constructor(matches: readonly SecretMatch[]) {
    const summaries: SecretMatchSummary[] = matches.map((match) => ({
      patternName: match.patternName,
      field: match.field,
      preview: redactPreview(match.matched),
      length: match.matched.length,
    }));
    const summaryText = summaries.map((s) => `${s.field}: ${s.patternName} (${s.preview})`).join("; ");
    super(
      `refusing to store fact: possible secret detected -- ${summaryText}. If this is not a secret, ` +
        `add the exact value to .mem/allowlist in the project root.`
    );
    this.name = "SecretDetectedError";
    this.matches = summaries;
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
  { name: "aws-access-key-id", regex: /A(?:KIA|SIA)[0-9A-Z]{16}/g },
  { name: "github-token", regex: /gh[pousr]_[A-Za-z0-9]{36,255}/g },
  { name: "slack-token", regex: /xox[baprs]-[0-9A-Za-z-]{10,72}/g },
  { name: "google-api-key", regex: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "stripe-key", regex: /sk_(?:live|test)_[0-9a-zA-Z]{16,}/g },
  { name: "anthropic-api-key", regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-style-key", regex: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: "private-key-block", regex: /-----BEGIN[ A-Z]*PRIVATE KEY-----/g },
  { name: "jwt", regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    name: "password-assignment",
    regex: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[^\s'"]{6,}['"]?/gi,
  },
  /** A long hex run written near a credential word, in prose rather than assignment syntax. The entropy fallback below deliberately exempts pure-hex tokens so that quoting a commit SHA in a fact does not read as a credential -- but HMAC signing secrets, webhook secrets, and plenty of API keys are also pure hex, so that exemption doubled as a blanket bypass for an entire common secret format. `password-assignment` above did not close it either: it requires a `:`/`=` separator, and `the webhook signing secret is <64 hex>` has neither. Scoped to hex specifically, and only within a short window of a credential word, because that is exactly the class the exemption creates a hole in: a non-hex high-entropy secret is still caught by the entropy fallback on its own, so widening this pattern past hex would add false positives without adding coverage. A SHA that genuinely appears next to the word "secret" is the accepted cost, and the error message names the `.mem/allowlist` escape hatch. */
  {
    name: "secret-keyword-hex",
    regex: /(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|signing[_-]?(?:key|secret))\b[^\n]{0,32}?\b[0-9a-fA-F]{32,}\b/gi,
  },
];

/** Generic fallback (design principle 7b: "entropy screening" as its own layer, not just named patterns). Standalone tokens of length >= 32 from a base64/hex-ish alphabet, excluding pure-hex/pure-digit runs (git SHAs, ids — common in legitimate project facts, not secrets) and low-entropy strings. */
const GENERIC_TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;
const HEX_ONLY = /^[0-9a-f]+$/i;
const DIGITS_ONLY = /^[0-9]{32,}$/;

/** Hex-token lengths that correspond to a canonical content hash a project fact legitimately quotes: md5 (32), sha1 (40), sha256 (64). Anything else -- 48, 96, 33 -- is not a hash anyone writes down, and is far likelier an HMAC or API secret, so it gets no exemption from the entropy fallback. The exemption used to be unconditional for any hex run of 32 or more characters, which was strictly broader than its own stated rationale ("git SHAs, ids"): git SHAs are 7-12 characters abbreviated and 40 in full, so nothing under 32 ever reached {@link GENERIC_TOKEN}'s floor and nothing above 64 was ever a SHA. Perfect separation is impossible -- a 64-hex string is genuinely ambiguous between sha256 and an HMAC secret -- so the ambiguous lengths stay exempt here and are covered instead by the `secret-keyword-hex` pattern above, which only fires when the surrounding text says it is a credential. */
const CANONICAL_HEX_HASH_LENGTHS: ReadonlySet<number> = new Set([32, 40, 64]);

/** Whether a token is a pure-hex run of a length that plausibly denotes a content hash rather than a secret. */
function isCanonicalHexHash(token: string): boolean {
  return HEX_ONLY.test(token) && CANONICAL_HEX_HASH_LENGTHS.has(token.length);
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Words that make a neighbouring value look like a credential; a word matches when it starts or ends with one (`Authorization`, `api_key`, `X-Api-Key`), so the check fails closed. */
const UUID_CREDENTIAL_KEYWORDS: readonly string[] = ["key", "token", "secret", "password", "passwd", "auth", "api", "cred", "bearer", "license", "licence", "private", "subscription", "access", "login", "passphrase", "cookie", "recovery", "webhook", "activation", "connection", "passcode", "totp", "mfa", "unlock", "hmac", "jwt", "salt", "nonce", "passwort", "contrasena", "clave", "senha", "kennwort", "geheim", "mdp", "psk", "mnemonic", "vault", "sekret", "reset", "invite", "pairing", "ssh", "seed"];

/** Credential phrases of several words, matched against the folded words of a text joined by single spaces, so line breaks, tabs and repeated spaces inside the phrase do not hide it. */
const UUID_CREDENTIAL_PHRASES: readonly string[] = ["mot de passe", "seed phrase"];

/** Short credential words matched only as a whole word, so `passed`, `spin` and `signal` are not hits. */
const UUID_CREDENTIAL_EXACT_WORDS: ReadonlySet<string> = new Set(["pwd", "pass", "pin", "sas", "sig", "pw", "otp", "conn"]);

/** Whole words that name a UUID as an identifier; one must directly label the UUID (see `isLabelledByIdentifierWord`) for the UUID to be exempt from the generic entropy check. */
const UUID_IDENTIFIER_WORDS: ReadonlySet<string> = new Set([
  "id", "ids", "uuid", "uuids", "guid", "guids", "identifier", "session", "request", "trace", "span", "correlation", "run", "job", "build", "workflow", "instance", "tenant", "project", "ticket", "issue", "record", "fact", "event", "message", "transcript", "conversation", "device", "container", "deployment",
]);

/** Format characters (`\p{Cf}`: zero-width, soft hyphen, directional marks and isolates, invisible operators), the Mongolian vowel separator and the variation selectors, which render as nothing and so can split a keyword (`pass` + U+200B + `word`) or a secret without changing what a reader sees. Used only to normalise text for screening; the stored text is never altered. */
const INVISIBLE_CHARACTERS = /[\p{Cf}\p{Variation_Selector}\u180E]/gu;

/** The text as it reads to a person: invisible characters removed, compatibility forms folded (fullwidth letters), and diacritics stripped (`contrase\u00F1a` reads as `contrasena`). */
function foldForKeywords(text: string): string {
  return text.replace(INVISIBLE_CHARACTERS, "").normalize("NFKC").normalize("NFD").replace(/\p{M}/gu, "");
}

/** The lowercase words of `text` after folding, split on non-alphanumerics and on camelCase lower-to-upper boundaries (`sessionId` gives session, id). */
function splitWords(text: string): string[] {
  return foldForKeywords(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/** Whether one folded lowercase word is a credential keyword: an exact-word keyword, or a word that starts or ends with a keyword. */
function isCredentialWord(word: string): boolean {
  return UUID_CREDENTIAL_EXACT_WORDS.has(word) || UUID_CREDENTIAL_KEYWORDS.some((keyword) => word.startsWith(keyword) || word.endsWith(keyword));
}

/** Whether `text` carries a credential keyword as a word, a word prefix, or a word suffix, or an exact-word keyword, case-insensitively. */
function hasCredentialKeyword(text: string): boolean {
  const words = splitWords(text);
  const spaced = ` ${words.join(" ")} `;
  return UUID_CREDENTIAL_PHRASES.some((phrase) => spaced.includes(` ${phrase} `)) || words.some(isCredentialWord);
}

/** An anchor's arguments with its predicate name dropped (`file-contains password.txt x` gives `password.txt x`): the arguments say what the fact is about, the predicate name is fixed vocabulary. */
function anchorArguments(anchor: string): string {
  const trimmed = anchor.trim();
  const split = trimmed.search(/\s/u);
  return split === -1 ? "" : trimmed.slice(split);
}

/** Whether any content field of a capture, the arguments of its anchor, or any extra context text the caller holds for the fact as it will be stored, carries a credential keyword; `sourceRef` is skipped, since the pointer a capture path stamps itself (a transcript or file path) is not a statement about the fact, and a reference the user typed arrives through `extraContext`. */
function hasCredentialContext(fields: Readonly<Record<string, string | null | undefined>>, extraContext: string): boolean {
  return (
    hasCredentialKeyword(extraContext) ||
    Object.entries(fields).some(([field, value]) => {
      if (typeof value !== "string") {
        return false;
      }
      return field === "anchor" ? hasCredentialKeyword(anchorArguments(value)) : !GENERIC_ENTROPY_EXEMPT_FIELDS.has(field) && hasCredentialKeyword(value);
    })
  );
}
/** Characters trimmed from the front of a whitespace-delimited token before it is compared with the UUID. */
const UUID_LEADING_WRAPPERS = /^[([{"'`]+/;

/** Characters trimmed from the back of a whitespace-delimited token before it is compared with the UUID. */
const UUID_TRAILING_WRAPPERS = /[)\]}"'`.,;:!?]+$/;

/** Whether the whitespace-delimited token enclosing the span `[start, end)`, minus wrapping punctuation, is exactly the span's text. */
function isStandaloneToken(value: string, start: number, end: number): boolean {
  let tokenStart = start;
  while (tokenStart > 0 && !/\s/.test(value[tokenStart - 1] ?? "")) {
    tokenStart -= 1;
  }
  let tokenEnd = end;
  while (tokenEnd < value.length && !/\s/.test(value[tokenEnd] ?? "")) {
    tokenEnd += 1;
  }
  const trimmed = value.slice(tokenStart, tokenEnd).replace(UUID_LEADING_WRAPPERS, "").replace(UUID_TRAILING_WRAPPERS, "");
  return trimmed === value.slice(start, end);
}

/** Characters that may wrap a UUID directly after its label (`id: (<uuid>)`), trimmed from the end of the text before it. */
const UUID_OPENING_WRAPPERS = /[([{"'`]+$/;

/** Whether the text just before a UUID ends in an identifier word that labels it: `<idword> [id|ids] [is|:|=|#] <uuid>`, on one line, so `the session job is done; <uuid>` (an identifier word nearby, but not labelling it) is not a label. */
function isLabelledByIdentifierWord(value: string, index: number): boolean {
  const head = value
    .slice(0, index)
    .normalize("NFKC")
    .replace(UUID_OPENING_WRAPPERS, "")
    .replace(/[^\S\n]+$/, "")
    .replace(/(?:[:=#]|(?:^|[^\S\n])is)$/i, "")
    .replace(/[^\S\n]+$/, "");
  const label = /[A-Za-z0-9_-]+$/.exec(head);
  if (label === null) {
    return false;
  }
  const words = splitWords(label[0]);
  return UUID_IDENTIFIER_WORDS.has(words.at(-1) ?? "");
}

/** The most words before a value that count as directly labelling it for `isCredentialAdjacent` (`api key`, `client secret is`, `token set to`). */
const CREDENTIAL_ADJACENCY_WORDS = 3;

/** Whether a credential keyword is among the last few words before `index`, on the same line, so `api key <hex>` is a credential claim while `md5 checksum <hex>` or a keyword earlier in a long sentence is not. */
function isCredentialAdjacent(value: string, index: number): boolean {
  const line = value.slice(0, index).split("\n").at(-1) ?? "";
  return hasCredentialKeyword(splitWords(line).slice(-CREDENTIAL_ADJACENCY_WORDS).join(" "));
}

/** Whole words that name a hash a mention is about (`commit <hex>`, `md5 checksum <hex>`); one nearer to a hex than any credential keyword marks the hex as a content hash. */
const HASH_WORDS: ReadonlySet<string> = new Set(["commit", "sha", "sha1", "sha256", "sha512", "md5", "checksum", "cksum", "digest", "hash", "rev", "revision", "oid", "blob", "tree", "object"]);

/** The index of the last credential keyword in `words` (a single word, or the second word of a credential phrase), or -1. */
function lastCredentialWordIndex(words: readonly string[]): number {
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const word = words[i] ?? "";
    if (isCredentialWord(word) || (i > 0 && UUID_CREDENTIAL_PHRASES.includes(`${words[i - 1] ?? ""} ${word}`))) {
      return i;
    }
  }
  return -1;
}

/** Whether a credential keyword on the hex's own line or the line before it labels the hex, unless a hash word (`commit`, `md5`, `checksum`) sits nearer to the hex than the keyword: `the api key was then set to <hex>` and `api key:` newline `<hex>` are credential claims while `the token bug was fixed in commit <hex>` is not. */
function isCredentialSentence(value: string, index: number): boolean {
  const words = splitWords(value.slice(0, index).split("\n").slice(-2).join("\n"));
  const credentialIndex = lastCredentialWordIndex(words);
  const hashIndex = words.reduce((last, word, i) => (HASH_WORDS.has(word) ? i : last), -1);
  return credentialIndex !== -1 && credentialIndex > hashIndex;
}

/** The most words after a hex that `isCredentialLabelledAfter` reads: wide enough for `is the production API key` and `was the webhook signing secret` (five words), narrow enough that a keyword later in a long sentence does not label the hex. */
const CREDENTIAL_TRAILING_WORDS = 8;

/** Keywords too ordinary as a whole word after a hex to label it (`<hex> fixed the login page`) that still end a lowercase compound (`sessioncookie`) and count in the before-window checks. */
const CREDENTIAL_TRAILING_COMPOUND_ONLY_KEYWORDS: ReadonlySet<string> = new Set(["auth", "login", "cookie", "salt", "vault"]);

/** Keywords of `UUID_CREDENTIAL_KEYWORDS` too ordinary after a hex to label it (`<hex> fixed the reset`, `<hex> is a private repo`) and inside a longer word to end a compound (`preset` ends in `reset`); they still count in the before-window checks. */
const CREDENTIAL_TRAILING_ORDINARY_KEYWORDS: ReadonlySet<string> = new Set(["api", "access", "private", "reset", "invite", "seed", "ssh", "license", "licence", "subscription", "connection", "recovery", "webhook", "activation", "unlock", "pairing"]);

/** Credential words that label a hex when they follow it, matched only as whole words (plus a plural), derived from the before-window lists so the two cannot drift, because the prefix/suffix rule of `isCredentialWord` would make `keyboard`, `monkey` and `authors` credential words. */
const CREDENTIAL_TRAILING_WORD_SET: ReadonlySet<string> = new Set([...UUID_CREDENTIAL_KEYWORDS.filter((keyword) => !CREDENTIAL_TRAILING_ORDINARY_KEYWORDS.has(keyword) && !CREDENTIAL_TRAILING_COMPOUND_ONLY_KEYWORDS.has(keyword)), ...UUID_CREDENTIAL_EXACT_WORDS, "credential"]);

/** The shortest keyword that also counts as the end of a longer all-lowercase word (`refreshtoken`, `clientsecret`); shorter ones would turn `turkey`, `hockey` or `unsalt`-style words into hits. */
const CREDENTIAL_TRAILING_SUFFIX_MIN_LENGTH = 5;

/** The trailing words long enough to end a lowercase compound. */
const CREDENTIAL_TRAILING_SUFFIX_KEYWORDS: readonly string[] = [...CREDENTIAL_TRAILING_WORD_SET, ...CREDENTIAL_TRAILING_COMPOUND_ONLY_KEYWORDS].filter((keyword) => keyword.length >= CREDENTIAL_TRAILING_SUFFIX_MIN_LENGTH);

/** Words that, directly before `key`, form a lowercase credential compound (`passkey`, `apikey`, `privkey`). */
const CREDENTIAL_KEY_COMPOUND_PREFIXES: ReadonlySet<string> = new Set(["pass", "api", "priv", "private", "access", "secret", "auth", "ssh", "master", "signing", "encryption", "license", "licence"]);

/** Whether one folded lowercase word after a hex is a credential word: a whole keyword (or its plural), a lowercase compound ending in a long keyword, or a `<prefix>key` compound. */
function isTrailingCredentialWord(word: string): boolean {
  if (CREDENTIAL_TRAILING_WORD_SET.has(word) || (word.endsWith("s") && !UUID_CREDENTIAL_EXACT_WORDS.has(word.slice(0, -1)) && CREDENTIAL_TRAILING_WORD_SET.has(word.slice(0, -1)))) {
    return true;
  }
  return isCredentialCompound(word) || (word.length > 1 && word.endsWith("s") && isCredentialCompound(word.slice(0, -1)));
}

/** Whether a word is a `<prefix>key` compound or ends in a long credential keyword. */
function isCredentialCompound(word: string): boolean {
  if (word.endsWith("key") && CREDENTIAL_KEY_COMPOUND_PREFIXES.has(word.slice(0, -3))) {
    return true;
  }
  return CREDENTIAL_TRAILING_SUFFIX_KEYWORDS.some((keyword) => word.length > keyword.length && word.endsWith(keyword));
}

/** The end of a sentence: `.`, `;`, `!` or `?` followed by whitespace or the end of the text. */
const SENTENCE_BOUNDARY = /[.;!?](?:\s|$)/gu;

/** A full stop that ends an abbreviation (`e.g.`, `i.e.`, `etc.`, `vs.`, `Mr.`, `approx.`, `cf.`, `no.`, `fig.`) rather than a sentence, tested against the text up to and including the stop. */
const ABBREVIATION_BEFORE_STOP = /(?:^|[^a-z])(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|approx|cf|no|vol|fig|al|st|v)\.$/iu;

/** Words that open a sentence referring back to the hex before it (`<hex>. This is my API key`). */
const CREDENTIAL_BACK_REFERENCE_WORDS: ReadonlySet<string> = new Set(["this", "that", "it", "its", "these", "those", "which"]);

/** Words that open a back-reference only when a credential label sits in their own clause (`<hex>. Said value is my password`), because they also open ordinary prose (`<hex>. Said Alice, please fix the password form`). */
const CREDENTIAL_CLAUSE_BACK_REFERENCE_WORDS: ReadonlySet<string> = new Set(["said"]);

/** The end of a clause inside a sentence. */
const CLAUSE_SEPARATOR = /[,:]/u;

/** A title abbreviation (`Mr.`, `Mrs.`, `Ms.`, `Dr.`, any letter case) with up to three capitalised name words after it, which together are one name and not words of the label that continues a statement unless one of them is a credential word (`collapseTitledName`); the title alone still collapses when no capitalised word follows. */
const TITLE_ABBREVIATION = /\b(?:[Mm][Rr][Ss]?|[Mm][Ss]|[Dd][Rr])\.(?:\s+\p{Lu}[\p{L}'’-]*){0,3}/gu;

/** Two-word openers that refer back to the hex before them (`<hex>. The above is my password`). */
const CREDENTIAL_BACK_REFERENCE_PHRASES: ReadonlySet<string> = new Set(["the above", "the former", "the latter"]);

/** The most words a next sentence may have and still read as a bare label of the hex (`<hex>. Password`). */
const CREDENTIAL_BARE_LABEL_WORDS = 3;

/** The index and length of the first genuine sentence boundary in `text` at or after `from`, or null; the stop of an abbreviation is not one. */
function nextSentenceBoundary(text: string, from: number): { readonly index: number; readonly length: number } | null {
  SENTENCE_BOUNDARY.lastIndex = from;
  for (let match = SENTENCE_BOUNDARY.exec(text); match !== null; match = SENTENCE_BOUNDARY.exec(text)) {
    if (!ABBREVIATION_BEFORE_STOP.test(text.slice(0, match.index + 1))) {
      return { index: match.index, length: match[0].length };
    }
  }
  return null;
}

/** What a title abbreviation with its name words leaves in the sentence: nothing, unless a name word is a credential word (`Mr. Api Key`, `Mrs. Smith Admin Password`), where the label from that word on stays so it still counts. */
function collapseTitledName(titledName: string): string {
  const names = splitWords(titledName.slice(titledName.indexOf(".") + 1));
  const label = firstCredentialWordIndex(names);
  return label === -1 ? " " : ` ${names.slice(label).join(" ")}`;
}

/** Whether the sentence starting at `start` still describes the hex before it: it opens with a back-reference word, or is a bare label of at most a few words. */
function continuesStatement(text: string, start: number): boolean {
  const boundary = nextSentenceBoundary(text, start);
  const sentence = text.slice(start, boundary === null ? text.length : boundary.index).replace(TITLE_ABBREVIATION, collapseTitledName);
  const words = splitWords(sentence);
  return words.length > 0 && (CREDENTIAL_BACK_REFERENCE_WORDS.has(words[0] ?? "") || (CREDENTIAL_CLAUSE_BACK_REFERENCE_WORDS.has(words[0] ?? "") && firstCredentialWordIndex(splitWords(sentence.split(CLAUSE_SEPARATOR)[0] ?? "")) !== -1) || CREDENTIAL_BACK_REFERENCE_PHRASES.has(`${words[0] ?? ""} ${words[1] ?? ""}`) || words.length <= CREDENTIAL_BARE_LABEL_WORDS);
}

/** The part of `following` that can still label the hex: it ends at the first sentence boundary unless the next sentence continues the statement, and then at the boundary after that sentence, so a chain of short sentences never keeps it open further. */
function labellingWindow(following: string): string {
  let boundary = nextSentenceBoundary(following, 0);
  if (boundary !== null && continuesStatement(following, boundary.index + boundary.length)) {
    boundary = nextSentenceBoundary(following, boundary.index + boundary.length);
  }
  return boundary === null ? following : following.slice(0, boundary.index);
}

/** The index of the first credential word in `words` (a trailing credential word, or the second word of a credential phrase), or -1. */
function firstCredentialWordIndex(words: readonly string[]): number {
  return words.findIndex((word, i) => isTrailingCredentialWord(word) || (i > 0 && UUID_CREDENTIAL_PHRASES.includes(`${words[i - 1] ?? ""} ${word}`)));
}

/** Whether a credential keyword among the first few words after `end` (the rest of the hex's line and the next line) labels the hex that ends there (`<hex> is the production API key`), unless a hash word sits before the keyword or directly before the hex, so `<hex> is the commit that fixed the token parser` and `commit <hex> fixed the token parser` are not credential claims. */
function isCredentialLabelledAfter(value: string, index: number, end: number): boolean {
  const before = splitWords(value.slice(0, index).split("\n").at(-1) ?? "");
  if (HASH_WORDS.has(before.at(-1) ?? "")) {
    return false;
  }
  const following = value.slice(end).split("\n").slice(0, 2).join("\n");
  const words = splitWords(labellingWindow(following)).slice(0, CREDENTIAL_TRAILING_WORDS);
  const credentialIndex = firstCredentialWordIndex(words);
  return credentialIndex !== -1 && !words.slice(0, credentialIndex).some((word) => HASH_WORDS.has(word));
}

/** Whether a canonical 8-4-4-4-12 UUID (either case) stands alone as its own token, an identifier word directly labels it, and the capture and everything known about the fact as stored has no credential keyword, so a record, session, or fact id is not refused as a secret while `token=<uuid>`, `user:<uuid>@host` and `the session job is done; <uuid>` still are. */
function isCanonicalUuid(token: string, value: string, index: number, credentialContext: boolean): boolean {
  if (credentialContext || !CANONICAL_UUID.test(token)) {
    return false;
  }
  return isStandaloneToken(value, index, index + token.length) && isLabelledByIdentifierWord(value, index);
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

/** Fields that legitimately contain long, forward-slash-delimited path-shaped values -- an anchor's fs/git predicate argument, or a `sourceRef` provenance pointer (`<path>:<line>`, but for `mem remember --source-ref` a free-form, user/agent-supplied string, so it is NOT exempt from `SECRET_PATTERNS` or from a slash-free high-entropy token) -- so a slash-containing token is excluded from the *generic* high-entropy-token heuristic below: `GENERIC_TOKEN`'s alphabet includes "/", so any plausible, entirely benign `file-exists <long/nested/path.tsx>` or `src/very/long/path.ts:123` argument over ~32 chars can exceed the entropy threshold purely from directory-name variety, with no secret present at all. The exemption only applies to a matched token that contains "/" (a Windows `\` counts as "/" here, since `mem scan-session` stamps a native transcript path) -- a prefix-less high-entropy secret with no path separator (an unlabeled credential with no recognized `SECRET_PATTERNS` prefix) is still caught by the entropy fallback. Named `SECRET_PATTERNS` (aws-access-key-id, etc.) always run against these fields regardless. Under credential context a `sourceRef` slash alone no longer exempts: the token must also pass `isReferencePathToken`, so a labelled `wJalrXUtnFEMI/K7MDENG/...` in a `sourceRef` is caught. */
const GENERIC_ENTROPY_EXEMPT_FIELDS: ReadonlySet<string> = new Set(["anchor", "sourceRef"]);

/** One `/`-delimited segment of a path-shaped token: a lowercase word (or digits) with `.`/`_`/`-` joining further lowercase words -- `agent-self-compaction`, `session_continuity.md`, `v2`. Deliberately rejects uppercase, `+`, and `=`, which is what separates a filename from a base64/random credential. */
const PATH_SEGMENT = /^[a-z0-9]+([._-][a-z0-9]+)*$/;

/** Longest unbroken `[a-z0-9]` run allowed inside a path segment. Real directory and file names this long are written as words joined by `-`/`_`/`.` (`very-long-nested-directory-name`), whereas an unbroken run of this length is the shape of a lowercase random token -- so requiring a separator past this length stops `<long-run>/x9` from buying an exemption on segment count alone. */
const MAX_UNBROKEN_SEGMENT_RUN = 24;

function isPathSegment(segment: string): boolean {
  return PATH_SEGMENT.test(segment) && segment.split(/[._-]/).every((run) => run.length <= MAX_UNBROKEN_SEGMENT_RUN);
}

/** Whether a token is shaped like a relative filesystem path of ordinary lowercase identifiers, which the *generic* entropy heuristic must not flag: the same directory-name variety that the `GENERIC_ENTROPY_EXEMPT_FIELDS` comment above describes for anchors also pushes a perfectly benign path quoted inside a fact's `text` over the threshold (`agent-self-compaction/superman-state` scores 3.88 against a 3.8 cutoff), and a decision fact naturally cites file paths. The exemption is shape-based, never merely slash-based, because real credentials do contain slashes -- an AWS secret access key (`wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`, entropy 4.66) is exactly the prefix-less secret this entropy fallback exists to catch. Requiring every segment to be lowercase-word-shaped rejects it on the uppercase alone, as it does base64 blobs (`+`/`=`) and mixed-case tokens generally. Two or more non-empty segments are required so a single long lowercase run can never buy an exemption just by carrying one slash. Named `SECRET_PATTERNS` still run against every field regardless of this, so a recognized credential format is caught even when it happens to look path-like. */
function isPathShapedToken(token: string): boolean {
  if (!token.includes("/")) {
    return false;
  }
  const segments = token.split("/").filter((segment) => segment.length > 0);
  return segments.length >= 2 && segments.every(isPathSegment);
}

/** The tail of a `sourceRef` that points into a file or a transcript (`<path>:<line>`, `<path>#turn<n>`), which anyone writing a ref can append to a secret, so it exempts a mixed-case slash token only when that token is also word-shaped (`isWordShapedPathToken`). */
const REFERENCE_POINTER_SUFFIX = /(?::|#turn)\d+\s*$/u;

/** A run of a word-shaped path segment: capitalised or lowercase words joined together (`ApiKeys`, `v2`), or an all-capital acronym (`NOTES`, `C`); a random mixed-case token has capitals mid-run and fails it. */
const WORD_SHAPED_RUN = /^(?:[A-Z]?[a-z0-9]+)+$|^[A-Z]+$/;

/** The `.<extension>` at the end of a path segment, set aside so `<UPPERCASE-UUID>.jsonl` is judged as the UUID it carries. */
const SEGMENT_EXTENSION = /\.[A-Za-z0-9]+$/;

/** Longest alphanumeric run of any letter case accepted in a word-shaped segment: the random suffix of a temp directory or a short user name (`mem-import-kFxnGE`) is this long, and a run this short cannot carry a secret on its own. */
const MAX_OPAQUE_RUN = 6;

/** One component of a camel-cased run that holds an acronym: an all-capital acronym that ends where a capitalised word starts (`API` in `MyAPIClient`), or an optionally capitalised word with trailing digits (`Auth2`, `App`, `i`). */
const CAMEL_COMPONENT = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+\d*/y;

/** Shape bounds of an acronym-bearing run (`MyAPIClient`, `OAuth2Client`, `iOSAppProject`), which keep a random mixed-case string from reading as camel-cased words: measured on fake random secrets of five charsets, at most 0.37% pass (0.17% before acronyms were allowed), and a secret-shaped name such as `bPxRfiCYEXAMPLEKEY` fails on the acronym length. */
const ACRONYM_RUN_BOUNDS = { components: 4, acronyms: 1, acronymLength: 5, singleLetters: 1, digits: 2 } as const;

function isAcronymWordRun(run: string): boolean {
  if ((run.match(/\d/g) ?? []).length > ACRONYM_RUN_BOUNDS.digits) {
    return false;
  }
  CAMEL_COMPONENT.lastIndex = 0;
  let position = 0;
  let components = 0;
  let acronyms = 0;
  let singleLetters = 0;
  while (position < run.length) {
    const component = CAMEL_COMPONENT.exec(run)?.[0];
    if (component === undefined) {
      return false;
    }
    position += component.length;
    components += 1;
    if (/^[A-Z]{2,}$/.test(component)) {
      acronyms += 1;
      if (component.length > ACRONYM_RUN_BOUNDS.acronymLength) {
        return false;
      }
    } else if (/^[A-Za-z]$/.test(component)) {
      singleLetters += 1;
    }
  }
  return components <= ACRONYM_RUN_BOUNDS.components && acronyms <= ACRONYM_RUN_BOUNDS.acronyms && singleLetters <= ACRONYM_RUN_BOUNDS.singleLetters;
}

function isWordShapedRun(run: string): boolean {
  return (run.length <= MAX_UNBROKEN_SEGMENT_RUN && (WORD_SHAPED_RUN.test(run) || isAcronymWordRun(run))) || (run.length <= MAX_OPAQUE_RUN && /^[A-Za-z0-9]+$/.test(run));
}

function isWordShapedSegment(segment: string): boolean {
  if (CANONICAL_UUID.test(segment) || CANONICAL_UUID.test(segment.replace(SEGMENT_EXTENSION, ""))) {
    return true;
  }
  return segment.split(/[._-]/).filter((run) => run.length > 0).every(isWordShapedRun);
}

/** Whether a slash-bearing `sourceRef` token reads as a path of ordinary words (`Users/Zelys/Docs/ApiKeys/NOTES.md`, `<dir>/<UUID>.jsonl`) and not as a mixed-case secret that merely ends in a `:<n>` pointer: two or more segments, each a canonical UUID or a series of short word-shaped runs (or runs of at most `MAX_OPAQUE_RUN` characters). */
function isWordShapedPathToken(token: string): boolean {
  const segments = token.split("/").filter((segment) => segment.length > 0);
  return segments.length >= 2 && segments.every(isWordShapedSegment);
}

/** Whether a slash-bearing `sourceRef` token is a lowercase path that keeps its entropy exemption under credential context: path-shaped, or with a canonical content hash as a directory name (`docs/<md5>/notes`), but never a mixed-case or digit-laced slash token such as an AWS secret access key. */
function isReferencePathToken(token: string): boolean {
  const segments = token.split("/").filter((segment) => segment.length > 0);
  return segments.length >= 2 && segments.every((segment) => PATH_SEGMENT.test(segment) && segment.split(/[._-]/).every((run) => run.length <= MAX_UNBROKEN_SEGMENT_RUN || isCanonicalHexHash(run)));
}

/** One `[._-]`-delimited word of a prose-shaped identifier: pure lowercase letters, no digits, no separators of its own -- deliberately narrower than `PATH_SEGMENT` (which allows digits and internal `[._-]` runs), because a slash-less token has no directory-name convention to lean on and so gets no benefit of the doubt beyond plain English words. */
const PROSE_WORD = /^[a-z]+$/;

/** One `[._-]`-delimited numeric word of a prose-shaped identifier: a version (`v` plus one to three digits: `v2`, `v10`), an ordinal (one or two digits: `1`, `12`), or a plausible year (1900-2099); any other three- or four-digit run (`4821`) is the shape of a random digit group, and a run mixing digits with several letters (`3f9a`, `git2`) is a hex or base64 fragment. */
const PROSE_NUMBER_WORD = /^(?:v\d{1,3}|\d{1,2}|(?:19|20)\d{2})$/;

/** The most number words a prose-shaped identifier may carry, so a random secret cannot be cut into letter groups joined by digit groups and still read as prose. */
const MAX_PROSE_NUMBER_WORDS = 2;

/** The shortest letter word that must carry a vowel to read as a word: a consonant run this long (`xqztkmvb`) is a random string, not prose. */
const MIN_VOWEL_CHECKED_WORD_LENGTH = 5;

/** The vowel half of the prose-shape test in `isProseShapedToken`: every letter word of `MIN_VOWEL_CHECKED_WORD_LENGTH` or more must hold one, so `xqztkmvb` is not prose; it does not stand alone, because the word-count, number-word and unbroken-run rules there reject the other random shapes. */
const PROSE_VOWEL = /[aeiouy]/;

/** Whether a slash-free token is shaped like a kebab/snake/dotted-case prose identifier -- `subagent-git-discard-prohibition`, the kind of descriptive `mem remember --subject`/`--value` key this project's own CLAUDE.md tells agents to pass -- which the generic entropy heuristic must not flag. `isPathShapedToken` above already exempts this shape when it contains a slash; a slash-less kebab identifier never reaches that check (it returns early on `!token.includes("/")`) and so falls straight through to `generic-high-entropy-token` once it clears 32 characters, which a descriptive multi-word subject key does routinely. Every named `SECRET_PATTERNS` entry (aws-access-key-id, github-token, slack-token, jwt, ...) runs unconditionally before this; this exemption only ever reaches the *unlabeled, prefix-less* entropy fallback. A real prefix-less secret is essentially always drawn from a base64/hex alphabet or carries digits/mixed case, so requiring every `[._-]`-delimited word to be pure lowercase letters, or a version, ordinal or year number (`PROSE_NUMBER_WORD`, at most `MAX_PROSE_NUMBER_WORDS` of them) that does not outnumber the letter words, with every letter word of five or more characters holding a vowel, excludes it outright -- a digit glued into a word (`git2`), a hex fragment (`3f9a`) and any uppercase all disqualify the token: it is what keeps a Slack-style `xoxb-1234567890-...` shape (or any base64 `+`/`=`/mixed-case blob) out of the exemption even if its named pattern were ever loosened. Two or more words are required so a single long lowercase run can never buy the exemption on its own, and each word is still capped at `MAX_UNBROKEN_SEGMENT_RUN` (the same bound `isPathSegment` uses for a path segment's internal runs) -- a real English word doesn't reach that length, whereas an unbroken lowercase run that long is the shape of a random token, not prose. */
function isProseShapedToken(token: string): boolean {
  const words = token.split(/[._-]/).filter((word) => word.length > 0);
  const letterWords = words.filter((word) => PROSE_WORD.test(word) && word.length <= MAX_UNBROKEN_SEGMENT_RUN);
  const numberWords = words.filter((word) => PROSE_NUMBER_WORD.test(word));
  const wordLike = letterWords.every((word) => word.length < MIN_VOWEL_CHECKED_WORD_LENGTH || PROSE_VOWEL.test(word));
  return letterWords.length >= 2 && wordLike && letterWords.length + numberWords.length === words.length && numberWords.length <= Math.min(letterWords.length, MAX_PROSE_NUMBER_WORDS);
}

function scanField(field: string, rawValue: string, credentialContext: boolean, stampedReference: boolean): SecretMatch[] {
  const matches: SecretMatch[] = [];
  // Invisible characters split a secret into halves that each fall under the length floors below, so the value is screened as a person reads it.
  const value = rawValue.replace(INVISIBLE_CHARACTERS, "");

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
  // A Windows path's `\` is outside GENERIC_TOKEN's alphabet, so without this a `C:\...\<session-uuid>.jsonl#turn3` sourceRef splits into bare, slash-free segments and a high-entropy session UUID loses the path exemption it gets on POSIX.
  const genericValue = exemptField ? value.replaceAll("\\", "/") : value;
  GENERIC_TOKEN.lastIndex = 0;
  let g = GENERIC_TOKEN.exec(genericValue);
  while (g !== null) {
    const token = g[0];
    // A bare anchor argument (the whole whitespace-delimited argument, no path separator) under credential context gets no UUID or content-hash exemption; a path segment, or a filename such as `<uuid>.jsonl`, is not bare and keeps the path exemption.
    const bareAnchorArgument = field === "anchor" && credentialContext && !token.includes("/") && isStandaloneToken(genericValue, g.index, g.index + token.length);
    // Under credential context a `sourceRef` slash token keeps the path exemption only as a lowercase path or as a word-shaped path inside a `<path>:<line>` or `#turn<n>` pointer; any other mixed-case slash value is entropy-checked, whatever suffix it carries, unless mem stamped the ref itself from a path it chose.
    const labelledBareReference = field === "sourceRef" && credentialContext && !stampedReference && !isReferencePathToken(token) && !(REFERENCE_POINTER_SUFFIX.test(genericValue) && isWordShapedPathToken(token));
    if (((!exemptField && credentialContext) || bareAnchorArgument) && CANONICAL_UUID.test(token)) {
      // A UUID-shaped token beside a credential keyword is refused whatever its entropy: some services issue API keys as UUIDs, and a run of repeated digits is as plausible a key as a random one.
      matches.push({ patternName: "generic-high-entropy-token", field, matched: token });
    } else if (
      !(exemptField && token.includes("/") && !labelledBareReference) &&
      !isPathShapedToken(token) &&
      !isProseShapedToken(token) &&
      // The content-hash exemption yields to a credential keyword among the few words just before the value or earlier in its sentence or the line before it with no hash word nearer, to one in the few words just after it with no hash word nearer, to a bare anchor argument under credential context, and to a whole `value` field under credential context (its subject and text label it), so `api key <32 hex>` is refused while `md5 checksum <32 hex>` is stored.
      !(
        isCanonicalHexHash(token) &&
        !bareAnchorArgument &&
        !(field === "value" && credentialContext && genericValue.trim() === token) &&
        !isCredentialAdjacent(genericValue, g.index) &&
        !isCredentialSentence(genericValue, g.index) &&
        !isCredentialLabelledAfter(genericValue, g.index, g.index + token.length)
      ) &&
      !(!exemptField && isCanonicalUuid(token, genericValue, g.index, credentialContext)) &&
      !DIGITS_ONLY.test(token) &&
      shannonEntropy(token) >= GENERIC_ENTROPY_THRESHOLD
    ) {
      matches.push({ patternName: "generic-high-entropy-token", field, matched: token });
    }
    g = GENERIC_TOKEN.exec(genericValue);
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

/** Options only mem's own capture paths set; no CLI flag or stored value reaches them. */
export interface ScreenOptions {
  /** The `sourceRef` is the pointer `mem scan-session` or `mem import --from-md` built from a path it chose, so the generic entropy heuristic is skipped on it; the named secret patterns still run. */
  readonly stampedSourceRef?: boolean | undefined;
}

/** Scans a set of named fields against the secret-pattern and entropy heuristics, dropping any match whose exact text is covered by `allowlist`. Exported so a `mem doctor` / `review` command can reuse the same screening logic to audit already-stored allowlist entries. */
export function screenForSecrets(
  fields: Readonly<Record<string, string | null | undefined>>,
  allowlist: readonly string[],
  extraContext = "",
  options: ScreenOptions = {}
): SecretMatch[] {
  const allowed = new Set(allowlist);
  const matches: SecretMatch[] = [];
  const credentialContext = hasCredentialContext(fields, extraContext);
  // The stamp is honoured only for a ref with the stamped shape, so a caller that sets it on a typed secret-shaped ref gains nothing.
  const stampedReference = options.stampedSourceRef === true && STAMPED_TRANSCRIPT_REF.test(fields["sourceRef"] ?? "");
  for (const [field, value] of Object.entries(fields)) {
    if (value === null || value === undefined || value.length === 0) {
      continue;
    }
    for (const match of scanField(field, value, credentialContext, stampedReference && field === "sourceRef")) {
      if (!allowed.has(match.matched)) {
        matches.push(match);
      }
    }
  }
  return matches;
}

/** Loads the narrow, explicit secret-screening override list from `<root>/.mem/allowlist` (design principle 7 / Open Question 1). One exact value per line; blank lines and lines starting with `#` are ignored. Entries are exact-match strings, not patterns or category names — the allowlist can only exempt specific, already-reviewed values, never silently disable a whole detector. Missing file means an empty allowlist, not an error: most projects will never need one. */
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

/** Builds a `sources.excerpt` for a derived-capture fact (scan-session, `mem import --from-md`), or `null` when `raw` carries a secret the extracted fact text did not -- the raw material (a whole user turn, a whole file line) is a larger surface than the sentence pulled from it, so screening the sentence alone (already done by `screenInputOrThrow`) is not enough to trust the excerpt. Screened against the *untruncated* text so a secret sitting past `MAX_SOURCE_EXCERPT_LENGTH` cannot slip through by being cut off before the check runs; only a confirmed-clean excerpt is then truncated for storage. Never called for `mem remember`/`mem suggest`: there the user's own text *is* the fact, and a source row echoing it back would be provenance noise, not evidence. When `factText` is provided, the excerpt is windowed around the first occurrence of the fact text in `raw` (matched through `normalizeFactText` to ignore whitespace/case/trailing-period differences), ensuring the source excerpt actually contains the evidence. If the fact text is not found in raw, falls back to head truncation as a safe default. If `factText` is omitted, always truncates from the head (today's behavior). */
export function buildScreenedExcerpt(raw: string, root: string, factText?: string, screenContext = ""): string | null {
  const allowlist = loadAllowlist(root);
  if (screenForSecrets({ excerpt: raw }, allowlist, screenContext).length > 0) {
    return null;
  }

  // If raw fits in the limit, use it as-is without any windowing logic.
  if (raw.length <= MAX_SOURCE_EXCERPT_LENGTH) {
    return raw;
  }

  // If factText is provided, attempt to window the excerpt around it.
  if (factText !== undefined) {
    const factPos = findNormalizedTextPosition(raw, factText);
    if (factPos !== -1) {
      // Window around the found position: try to center it, but stay within bounds.
      const halfWindow = Math.floor((MAX_SOURCE_EXCERPT_LENGTH - factText.length) / 2);
      const targetStart = Math.max(0, factPos - halfWindow);
      const windowEnd = Math.min(raw.length, targetStart + MAX_SOURCE_EXCERPT_LENGTH);
      let windowStart = targetStart;

      // If we're near the end and can't fit the full window, slide the start back.
      if (windowEnd - windowStart < MAX_SOURCE_EXCERPT_LENGTH && windowStart > 0) {
        windowStart = Math.max(0, windowEnd - MAX_SOURCE_EXCERPT_LENGTH);
      }

      const excerpt = raw.slice(windowStart, windowEnd);
      const hasPrefix = windowStart > 0;
      const hasSuffix = windowEnd < raw.length;

      let result = excerpt;
      if (hasPrefix) {
        result = `${EXCERPT_TRUNCATION_MARKER}${result}`;
      }
      if (hasSuffix) {
        result = `${result}${EXCERPT_TRUNCATION_MARKER}`;
      }

      return result;
    }
  }

  // Fallback: truncate from head (today's behavior when fact text not found or not provided).
  return `${raw.slice(0, MAX_SOURCE_EXCERPT_LENGTH)}${EXCERPT_TRUNCATION_MARKER}`;
}

/** Finds the position of a normalized text sequence within a larger string, accounting for whitespace and case differences. Returns the byte position in the original string where the normalized match starts, or -1 if not found. Used to ensure source excerpts contain the actual fact text they provide evidence for. */
function findNormalizedTextPosition(raw: string, factText: string): number {
  const normalizedFact = normalizeFactText(factText);
  const lowerRaw = raw.toLowerCase();

  // Search through the raw text for a match, accounting for normalized whitespace.
  for (let rawPos = 0; rawPos < raw.length; rawPos++) {
    // Check if we have a match starting at rawPos, accounting for normalized text.
    let factIdx = 0;
    let checkPos = rawPos;
    let foundMatch = true;

    while (factIdx < normalizedFact.length && checkPos < raw.length) {
      const factChar = normalizedFact.charAt(factIdx);
      const rawChar = lowerRaw.charAt(checkPos);

      if (factChar === " ") {
        // In the normalized fact, a space can match one or more whitespace in raw.
        if (!/\s/u.test(rawChar)) {
          foundMatch = false;
          break;
        }
        // Skip all whitespace in raw.
        while (checkPos < raw.length && /\s/u.test(lowerRaw.charAt(checkPos))) {
          checkPos++;
        }
        factIdx++;
      } else if (factChar === rawChar) {
        factIdx++;
        checkPos++;
      } else {
        foundMatch = false;
        break;
      }
    }

    if (foundMatch && factIdx === normalizedFact.length) {
      return rawPos;
    }
  }

  return -1;
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
  "valid-until": 1,
};

const DISALLOWED_ANCHOR_ARG_LITERALS = ";&|`$<>";

/** Placeholder root used only to run {@link anchorPathWithinRoot}'s containment math at syntax-check time, before the real `--root` for a `mem remember`/`mem edit` invocation is even known (this validation runs on the raw CLI string). The actual value is irrelevant to the check: a `..` segment escapes *any* root, and an absolute argument resolves to itself regardless of root, so either always fails containment against this (or any) placeholder. The evaluator (`src/anchors.ts`) re-derives and re-checks containment against the real root on every evaluation regardless -- this is purely an early, capture-time rejection so a doomed-to-`unverified`-forever anchor is refused with an error instead of silently rotting. */
const ANCHOR_SYNTAX_CHECK_ROOT = resolve("/mem-anchor-syntax-check-placeholder");

/** Argument indices, for a given predicate, that are filesystem paths and must therefore stay within whatever root the anchor is later evaluated against -- no `..` traversal, no absolute path. Indices outside a predicate's own arity are simply never reached by the caller's loop. */
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

/** Rejects an anchor the real predicates cannot parse. Exported so fixtures that construct `Fact` rows directly -- bypassing `captureFact`, and with it this check -- can still assert their anchors are the syntax `anchors.ts` actually evaluates. `eval/fixtures.ts` carried colon-glued anchors (`"file-exists:package.json"`) for exactly as long as nothing validated them: `tokenize` splits on whitespace, so every one of them was a single unknown token that silently read `unverified`. */
export function validateAnchorSyntax(anchor: string): void {
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
  // `file-contains`/`file-not-contains`'s substring argument may legitimately contain whitespace (anchors.ts's evaluator parses it via a raw-regex pre-pass, not plain whitespace-splitting) -- this whitespace-split syntax check only accepts single-token substrings for those two predicates. A multi-word substring anchor must be written via `mem import --from-json`, which bypasses this syntax gate entirely.
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
  // `valid-until` is the one predicate whose argument is neither a path nor a free string, and a typo in it is silent in the worst direction: anchors.ts reads an unparseable date as `unverified`, so `valid-untill 2026-12-31` (or `valid-until next friday`) would store cleanly and then caveat the fact forever, which is the exact rot this whole gate exists to prevent.
  if (predicate === "valid-until") {
    const [rawDate] = args;
    if (rawDate === undefined || parseValidUntilDeadline(rawDate) === null) {
      throw new InvalidAnchorError(anchor, `"${rawDate ?? ""}" is not a YYYY-MM-DD date or a full ISO 8601 date-time (e.g. 2026-12-31)`);
    }
  }
  // Reject a path argument that can never affirm: one that escapes whatever root it will later be evaluated against (`../x`) or names an absolute location (`/etc/passwd`, `C:\Windows\...`). `resolveWithinRoot`/`anchorPathWithinRoot` would return `null` for these at every future evaluation, forever `unverified` -- tell the user now, at capture time, instead of letting the fact rot silently.
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

/** A rationale (a fact's `why`, a review decision's `reason`) is optional, but one that is present must say something: an empty one would render as `why: ` on every recall, and an over-long one is a pasted transcript, not a rationale (the same design principle 7a limit `text` has). `null` clears a `why` and is always allowed. */
function validateRationaleOrThrow(label: "why" | "reason", rationale: string | null | undefined): void {
  if (typeof rationale !== "string") {
    return;
  }
  if (rationale.trim().length === 0) {
    throw new CaptureValidationError(`${label} (--${label}), if provided, must not be empty`);
  }
  if (rationale.trim().length > MAX_RATIONALE_LENGTH) {
    throw new CaptureValidationError(`${label} exceeds ${MAX_RATIONALE_LENGTH} characters`);
  }
}

/** Validates and secret-screens a `mem review --reason`, returning it trimmed. The reason is stored in the audit log, which is as durable as the fact table, so it gets the same deny-by-default screening (and the same `.mem/allowlist` escape hatch) a fact's own text does. */
export function screenReviewReasonOrThrow(db: Database.Database, reason: string, root: string, screenContext = ""): string {
  validateRationaleOrThrow("reason", reason);
  refuseSecretsOrThrow(db, screenForSecrets({ reason }, loadAllowlist(root), screenContext), "review");
  return reason.trim();
}

/** The free-text fact fields secret screening covers. One list for every whole-fact write path (capture and both JSON-import passes), so a new stored column cannot be screened on one path and stored unscreened by another. `mem edit` screens per edited field instead (cli.ts's `AUDIT_SCREENED_FIELDS`). */
export interface ScreenableFactFields {
  readonly text: string;
  readonly subject?: string | null | undefined;
  readonly value?: string | null | undefined;
  readonly anchor?: string | null | undefined;
  readonly sourceRef?: string | null | undefined;
  readonly why?: string | null | undefined;
  /** The provenance excerpt stored with the fact, if any; scanned like a content field and part of the credential-keyword context. */
  readonly sourceExcerpt?: string | null | undefined;
  /** Further text that belongs to the fact as it will be stored (the rest of a merged edit, the whole turn or section a candidate came from); read for credential keywords only, never scanned or stored. */
  readonly screenContext?: string | null | undefined;
  /** See {@link ScreenOptions}: set only by the `mem scan-session` and `mem import --from-md` capture paths. */
  readonly stampedSourceRef?: boolean | undefined;
}

export function screenFactFields(fields: ScreenableFactFields, allowlist: readonly string[]): SecretMatch[] {
  return screenForSecrets(
    {
      text: fields.text,
      subject: fields.subject,
      value: fields.value,
      anchor: fields.anchor,
      sourceRef: fields.sourceRef,
      why: fields.why,
      sourceExcerpt: fields.sourceExcerpt,
    },
    allowlist,
    fields.screenContext ?? "",
    { stampedSourceRef: fields.stampedSourceRef }
  );
}

/** The marker `mem scan-session` stamps between a transcript path and its turn number in a `source_ref` (`<path>#turn<n>`); sessionCapture.ts writes it and {@link storedSourceRefContext} recognises it, so the format has one definition. */
export const TRANSCRIPT_TURN_MARKER = "#turn";

const STAMPED_TRANSCRIPT_REF = new RegExp(`^(?:[A-Za-z]:|/).*(?:${TRANSCRIPT_TURN_MARKER}\\d+|:\\d+)$`, "su");

/** The `<relative path>:<line>: ` head `mem import --from-md` puts on a source excerpt ahead of the bullet's own line; lazy, so the first `:<digits>: ` ends the path. */
const IMPORT_EXCERPT_HEAD = /^(.+?):\d+: /su;

/** A source excerpt's text as keyword context: an import excerpt (`<path>:<line>: <bullet>`) of a fact whose stamped ref names that same file drops its path head, since a directory or file name is not a statement about the fact, and every other excerpt (a scan-session turn, a typed-ref fact's) is returned whole. */
function excerptKeywordContext(excerpt: string, importRef: string | null): string {
  const head = IMPORT_EXCERPT_HEAD.exec(excerpt);
  if (importRef === null || head === null || head[1] === undefined) {
    return excerpt;
  }
  const refPath = importRef.replaceAll(String.fromCharCode(92), "/").replace(/:\d+$/u, "");
  const headPath = head[1].replaceAll(String.fromCharCode(92), "/");
  return refPath === headPath || refPath.endsWith(`/${headPath}`) ? excerpt.slice(head[0].length) : excerpt;
}

/** A fact's stored `source_ref` as keyword context, or `null` when it is the pointer `mem scan-session` stamped itself: the stamp's shape (an absolute transcript path plus a turn) AND the fact's own creation audit row recording that exact ref, which `writeFact` writes only for a capture that stored the ref with a source excerpt in one transaction. A typed ref, a restatement's overwritten ref, and a sighting's later source row therefore never match, and a `mem gc` that pruned the audit row makes a genuine stamp read as typed, which fails closed. */
function storedSourceRefContext(db: Database.Database, fact: Fact): string | null {
  const ref = fact.source_ref;
  if (typeof ref !== "string") {
    return null;
  }
  return isBoundStampedRef(db, fact, ref) ? null : ref;
}

/** Whether `ref` has the stamped shape (a transcript path plus turn, or an import file path plus line) and the fact's own creation audit row records that exact ref, with no `json_import` row after it: an import is the only writer that recreates a fact row under a caller-supplied id, so a later one means the row is a new incarnation that merely reuses the pruned fact's id and must not inherit its exemption. */
function isBoundStampedRef(db: Database.Database, fact: Fact, ref: string): boolean {
  if (!STAMPED_TRANSCRIPT_REF.test(ref)) {
    return false;
  }
  let bound = false;
  for (const row of listAuditLogForFact(db, fact.id)) {
    if (row.event === "capture_suggested" && row.detail.endsWith(`${STAMPED_REF_DETAIL_MARKER}${ref}]`)) {
      bound = true;
    } else if (row.event === "json_import") {
      bound = false;
    }
  }
  return bound;
}

/** A fact's stored source excerpts as keyword context, each import excerpt without its file path when the fact's stamped ref names that file (see {@link excerptKeywordContext}). */
function keywordExcerpts(db: Database.Database, fact: Fact): string[] {
  const ref = fact.source_ref;
  const importRef = typeof ref === "string" && /:\d+$/u.test(ref) && isBoundStampedRef(db, fact, ref) ? ref : null;
  return listSourcesForFact(db, fact.id).map((source) => excerptKeywordContext(source.excerpt, importRef));
}

/** The text of a stored fact as it will read after `patch` is applied (a `null` in the patch clears that field), plus its stored source excerpts and any typed source ref: the keyword context `mem edit` and `mem review --promote` hand to screening, so a field the edit did not touch still counts as context for the one it did. */
export function mergedFactScreenContext(
  db: Database.Database,
  fact: Fact,
  patch: FactScreenPatch = {}
): string {
  const anchor = patchedOrStored(patch.anchor, fact.anchor);
  return [
    patchedOrStored(patch.text, fact.text),
    patchedOrStored(patch.subject, fact.subject),
    patchedOrStored(patch.value, fact.value),
    patchedOrStored(patch.why, fact.why),
    typeof anchor === "string" ? anchorArguments(anchor) : null,
    storedSourceRefContext(db, fact),
    ...keywordExcerpts(db, fact),
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

/** The fields of a stored fact a `mem edit` or `mem review --promote` may change; `undefined` leaves the stored value in place and `null` clears it. */
export interface FactScreenPatch {
  readonly text?: string | null | undefined;
  readonly subject?: string | null | undefined;
  readonly value?: string | null | undefined;
  readonly anchor?: string | null | undefined;
  readonly why?: string | null | undefined;
}

function patchedOrStored(patched: string | null | undefined, stored: string | null | undefined): string | null | undefined {
  return patched === undefined ? stored : patched;
}

/** Screens the fact as it will read once `patch` is applied: every stored content field and its source excerpts, not only the fields the patch names, so a credential word added to one field also vetoes a UUID an untouched field already holds. `extraContext` (a review reason) is read for credential keywords only. A refusal is recorded against the fact and happens before anything is written. */
export function screenMergedFactOrThrow(
  db: Database.Database,
  fact: Fact,
  patch: FactScreenPatch,
  root: string,
  auditEvent: string,
  extraContext = ""
): void {
  const excerpts = keywordExcerpts(db, fact);
  const matches = screenFactFields(
    {
      text: patchedOrStored(patch.text, fact.text) ?? "",
      subject: patchedOrStored(patch.subject, fact.subject),
      value: patchedOrStored(patch.value, fact.value),
      anchor: patchedOrStored(patch.anchor, fact.anchor),
      why: patchedOrStored(patch.why, fact.why),
      sourceExcerpt: excerpts.length > 0 ? excerpts.join("\n") : null,
      screenContext: [extraContext, storedSourceRefContext(db, fact)].filter((part): part is string => typeof part === "string" && part.length > 0).join("\n"),
    },
    loadAllowlist(root)
  );
  refuseSecretsOrThrow(db, matches, auditEvent, fact.id);
}

/** Applies the field-level guards `mem remember`/`captureExplicit` enforce (length limits, emptiness, subject/value pairing) to a patch of fact fields, WITHOUT the CLI-facing anchor-syntax arity check (see `validateAnchorSyntax`). Only validates fields actually present in the patch; a `null` clears the field and is not validated (clearing is always safe). Deliberately anchor-syntax-agnostic: this is the shared base used both by `validateFactEditOrThrow` (which adds the arity check back on top, since `mem edit` takes CLI-string input just like `mem remember`) and by JSON import (which must NOT apply the arity check -- a JSON `anchor` field is structured data, not a CLI-parsed string, so there is no parsing ambiguity for a multi-word `file-contains`/`file-not-contains` substring to create). Anchor *correctness* for callers that skip the arity check is still guaranteed: `anchors.ts`'s `evaluateAnchor` never throws on a malformed or unrecognized anchor string regardless of arity -- it just returns `"unverified"`. */
export function validateFactFieldsOrThrow(patch: {
  readonly text?: string;
  readonly subject?: string | null;
  readonly value?: string | null;
  readonly why?: string | null;
}): void {
  validateRationaleOrThrow("why", patch.why);
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
  // Enforce subject/value pairing: if both are present in the patch and are strings (not null), they must both be non-empty. This mirrors captureExplicit's rule: "subject and value must be provided together or not at all (design P4: contradiction detection keys on subject+value pairs -- a lone key is unusable)".
  const hasSubjectInPatch = typeof patch.subject === "string" && patch.subject.trim().length > 0;
  const hasValueInPatch = typeof patch.value === "string" && patch.value.trim().length > 0;
  if (hasSubjectInPatch !== hasValueInPatch) {
    throw new CaptureValidationError(
      "subject and value must be provided together or not at all (design P4: contradiction " +
        "detection keys on subject+value pairs -- a lone key is unusable)"
    );
  }
}

/** Applies the same field-level guards `mem remember`/`captureExplicit` enforce (length limits, emptiness, anchor syntax) to a `mem edit` patch -- editing is a distinct write path from capture and was previously exempt from all of this, letting an edit store a fact capture would have rejected (an over-length text, an empty text, or a malformed anchor that permanently evaluates "unverified"). Only validates fields actually present in the patch; a `null` clears the field and is not validated (clearing is always safe). `mem edit`, like `mem remember`, takes CLI-string input, so it keeps the anchor-syntax arity check (`validateAnchorSyntax`) that JSON import is exempt from -- see `validateFactFieldsOrThrow`. */
export function validateFactEditOrThrow(patch: {
  readonly text?: string;
  readonly subject?: string | null;
  readonly value?: string | null;
  readonly anchor?: string | null;
  readonly why?: string | null;
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
  /** The rationale behind the fact -- see `Fact.why`. */
  readonly why?: string;
  /** Project root, used to resolve `.mem/allowlist` and (for project/path scope) recorded as the fact's `scopeRoot`. Required, never defaulted to ambient `process.cwd()` (matches src/anchors.ts's explicit-root discipline). */
  readonly root: string;
  /** File (or directory) this fact is bound to, required when `scope === "path"` and rejected otherwise. Resolved against `root` -- never against ambient `process.cwd()` -- and stored as `scopeRoot`. Without this, `scope: "path"` had no way to bind to anything narrower than `root` itself, which made a "path" fact behave exactly like a "project" fact (isInScope/isBoundToRoot both resolve `scope="path"`'s binding the same way `scope="project"` resolves its own). */
  readonly path?: string;
  /** Further text that belongs to the fact as it will be stored and is read for credential keywords only (never scanned for secrets, never stored): the whole turn or document section a derived candidate was pulled from, or the rest of a fact being edited. */
  readonly screenContext?: string;
}

export interface CaptureSuggestedInput extends CaptureExplicitInput {
  /** ISO 8601 timestamp to record as the fact's `captured_at`, instead of the moment of the call. Offered on the suggested path only, and the asymmetry is the point: `captureExplicit` is the user saying something *now*, so the clock is the truth. A suggested fact is extracted from an artifact that already existed -- a CLAUDE.md whose rules predate this store by years -- and stamping those with today's date tells `captured_at`'s two consumers (time-decay, and contradiction precedence, which prefers the newer fact) that a years-old convention is the freshest thing in the store. Rejected if unparseable or in the future: a future timestamp would win every precedence comparison against facts that have not happened yet. */
  readonly capturedAt?: string;
  /** Defaults to `"derived"` — the more suspicious option — when omitted, per the quarantine-hardest rule (Section 3). */
  readonly sourceType?: FactSourceType;
  /** Advisory only: always clamped to `[0, SUGGESTED_CONFIDENCE_CAP]` regardless of what is requested, since a pending/suggested fact can never carry full trust (S9). */
  readonly confidence?: number;
  /** A pre-screened, pre-truncated excerpt of the raw material the candidate was pulled from (see `buildScreenedExcerpt`), stored as one `sources` row alongside the fact in the same transaction. Only `mem scan-session` and `mem import --from-md` set this -- both extract a short candidate from raw material genuinely larger than the fact (a whole user turn, a whole file line), which is exactly the provenance gap the `sources` table exists to close. `mem suggest <text>` must never set this: there the caller's text *is* the fact, so a source row would just echo it back. */
  readonly sourceExcerpt?: string;
  /** True only for a `sourceRef` that `mem scan-session` or `mem import --from-md` built from a path it chose (see {@link ScreenOptions}); no CLI flag sets it, and `mem suggest --source-ref` never does. */
  readonly stampedSourceRef?: boolean;
}

export interface CaptureResult {
  readonly fact: Fact;
  /** True when the capture matched a live fact and refreshed it instead of writing a second row. See {@link captureExplicit}. */
  readonly reaffirmed?: boolean;
  /** True when the matched fact was a queued `pending` suggestion, promoted to `active` by this restatement rather than left queued. See {@link captureExplicit}. */
  readonly promotedFromPending?: boolean;
  /** Count of additional `pending` duplicates of the same restated sentence superseded alongside the promotion. See {@link captureExplicit}. */
  readonly supersededPendingDuplicateCount?: number;
  /** True when the text matched an existing `pending` fact and this call recorded a sighting on it (see {@link recordSighting}) instead of filing a second row. See {@link captureSuggested}. Never implies promotion or a status change -- `fact` is the pre-existing `pending` row, sighted again, nothing more. */
  readonly sighted?: boolean;
  /** True when the text matched a fact already bound to this root that was *not* `pending` -- `active`, `superseded`, anything -- so no row was filed and no sighting recorded. `fact` is the pre-existing row, untouched. Mutually exclusive with {@link sighted}: a `pending` match takes the sighting path, everything else lands here. See {@link captureSuggested}. */
  readonly alreadyKnown?: boolean;
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
  validateRationaleOrThrow("why", input.why);

  const root = input.root.trim();
  if (root.length === 0) {
    throw new CaptureValidationError("root must not be empty");
  }

  return { text, root };
}

export function screenInputOrThrow(
  db: Database.Database,
  input: CaptureExplicitInput & Pick<CaptureSuggestedInput, "sourceExcerpt" | "stampedSourceRef">,
  root: string,
  auditEvent: string,
  factId: string | null = null
): void {
  const allowlist = loadAllowlist(root);
  // sourceRef is scanned like any other field: for the `mem import --from-md` path it's a programmatically constructed "<resolved path>:<line>" provenance pointer, but `mem remember --source-ref <ref>` accepts an arbitrary user/agent-supplied string, so it must not be excluded outright. It's in GENERIC_ENTROPY_EXEMPT_FIELDS instead (see that comment): named SECRET_PATTERNS always run, and only a slash-containing token skips the generic entropy fallback, so the legitimate "<path>:<line>" false-positive is still avoided, and under credential context a mixed-case slash token is still entropy-checked unless it is word-shaped inside a pointer suffix.
  refuseSecretsOrThrow(db, screenFactFields(input, allowlist), auditEvent, factId);
}

/** The one place a screened write is refused: records `<auditEvent>_blocked_secret` (field and pattern names only, never the matched value) and throws. Shared so every refusal leaves the same trail and `SecretDetectedError` keeps a single message. */
function refuseSecretsOrThrow(
  db: Database.Database,
  matches: readonly SecretMatch[],
  auditEvent: string,
  factId: string | null = null
): void {
  if (matches.length === 0) {
    return;
  }
  insertAuditLog(db, {
    event: `${auditEvent}_blocked_secret`,
    factId,
    detail: `blocked: ${matches.map((match) => `${match.field}/${match.patternName}`).join(", ")}`,
  });
  throw new SecretDetectedError(matches);
}

/** Validates a caller-supplied `capturedAt` and returns it in the canonical ISO form the column stores, so a legal-but-differently-spelled timestamp (`2024-01-02`, an offset other than Z) does not break the lexical comparability `captured_at` is documented to have (types.ts). A future timestamp is refused rather than clamped: it would win every contradiction-precedence comparison and sit permanently at the top of any recency ordering, and silently rewriting the value a caller asked for would hide that they got something other than what they requested. */
export function parseCapturedAtOrThrow(raw: string): string {
  const trimmed = raw.trim();
  const parsedMs = parseStrictIsoTimestamp(trimmed);
  if (parsedMs === null) {
    throw new CaptureValidationError(`invalid capturedAt ${JSON.stringify(raw)}: expected an ISO 8601 timestamp`);
  }
  if (parsedMs > Date.now()) {
    throw new CaptureValidationError(
      `capturedAt ${JSON.stringify(raw)} is in the future; captured_at drives time-decay and contradiction precedence, so a future date would outrank every real fact`
    );
  }
  return new Date(parsedMs).toISOString();
}

/** What a restatement carries onto the fact it reaffirms, and the audit phrase for each field it actually changed. The user's latest statement wins: an anchor, source ref, or why on the restatement replaces the stored one, and a field the restatement omits says nothing new and leaves the stored value alone. Shared by both of `captureExplicit`'s reaffirm paths (a live fact, and a pending one the restatement promotes) so they cannot disagree about which fields that covers. */
function restatementUpdates(newFact: NewFact, prior: Fact): { updates: RestatementUpdates; changed: string[] } {
  const updates: { anchor?: string; sourceRef?: string; why?: string } = {};
  const changed: string[] = [];
  if (typeof newFact.anchor === "string") {
    updates.anchor = newFact.anchor;
    if (newFact.anchor !== prior.anchor) {
      changed.push("anchor updated");
    }
  }
  if (typeof newFact.source_ref === "string") {
    updates.sourceRef = newFact.source_ref;
    if (newFact.source_ref !== prior.source_ref) {
      changed.push("source ref updated");
    }
  }
  if (typeof newFact.why === "string") {
    updates.why = newFact.why;
    if (newFact.why !== (prior.why ?? null)) {
      changed.push("why updated");
    }
  }
  return { updates, changed };
}

/** Layers a capture's optional fields (subject, anchor, sourceRef, why, scopeRoot) onto the shared `NewFact` base -- kept as plain conditional assignment (rather than spreading possibly-`undefined` values into the literal) because `NewFact`'s optional fields are typed without an explicit `| undefined`, and `exactOptionalPropertyTypes` (tsconfig.json) rejects writing `undefined` into them. */
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
  if (input.why !== undefined) {
    target.why = input.why.trim();
  }
  // Recorded for every scope, not just `path`/`project`: `retrieval.ts`'s `anchorRootFor` needs a capture-time root to evaluate a `scope="path"` fact's anchor against (its `scopeRoot` is the bound file, not a directory an anchor predicate can run under) and a `scope="global"` fact has no `scopeRoot` at all, yet its anchor -- if it has one -- still needs a root to mean anything. `scope="project"` already has `scopeRoot` for this, but recording it here too costs nothing and keeps the column meaning "the root this fact was captured under" uniformly across every scope.
  target.captureRoot = resolve(root);
  if (scope !== "global") {
    const trimmedPath = input.path?.trim();
    if (scope === "path" && trimmedPath !== undefined && trimmedPath.length > 0) {
      const bound = anchorPathWithinRoot(root, trimmedPath);
      if (bound === null) {
        throw new CaptureValidationError(`--path ${JSON.stringify(trimmedPath)} resolves outside --root ${JSON.stringify(root)}`);
      }
      target.scopeRoot = bound;
    } else {
      target.scopeRoot = resolve(root);
    }
  }
  const scopeRepo = resolveScopeRepo(scope, root);
  if (scopeRepo !== null) {
    target.scopeRepo = scopeRepo;
  }
}

/** Repository identity to record as a fact's `scopeRepo` for the given scope/root, or null when `scope` never carries one -- every scope but `project` (`path` facts bind to a file rather than to a project, and `global` facts are in scope everywhere already) -- or when no identity is available for `root`, the common case outside a repository with a remote (src/projectIdentity.ts). Recorded alongside `scopeRoot`, never instead of it: the path stays the primary binding (and the anchor evaluation root), and the identity only widens which roots can also claim the fact. Factored out of `applyOptionalFields` so `mem edit --scope` (src/cli.ts) can recompute `scopeRepo` the same way capture does when a fact's scope binding changes, instead of leaving it stuck at whatever identity it held under the fact's previous scope/root. */
export function resolveScopeRepo(scope: FactScope, root: string): string | null {
  return scope === "project" ? resolveProjectIdentity(root) : null;
}

/** Inserts a fact, its capture audit row, and (when given) its one source excerpt atomically -- all run inside a single `db.transaction()` (nesting `storageInsertFact`'s own transaction via savepoint, the same pattern exportImport.ts's `importFromJson` uses) so a crash partway through can never leave a fact with no audit entry, or a source row pointing at a fact that was rolled back. */
function writeFact(
  db: Database.Database,
  newFact: NewFact,
  auditEvent: string,
  detail: (fact: Fact) => string,
  sourceExcerpt?: string
): Fact {
  const tx = db.transaction((): Fact => {
    const fact = storageInsertFact(db, newFact);
    const stampedRef = sourceExcerpt !== undefined && typeof fact.source_ref === "string" && STAMPED_TRANSCRIPT_REF.test(fact.source_ref) ? fact.source_ref : null;
    insertAuditLog(db, { event: auditEvent, factId: fact.id, detail: detail(fact) + (stampedRef !== null ? `${STAMPED_REF_DETAIL_MARKER}${stampedRef}]` : "") });
    if (sourceExcerpt !== undefined) {
      insertSource(db, { factId: fact.id, excerpt: sourceExcerpt });
    }
    return fact;
  });
  // BEGIN IMMEDIATE: the inner `storageInsertFact` reads the epoch before writing, and once this outer transaction is open the inner one degrades to a savepoint -- so the outer variant is the one that decides whether the read-then-write pair is safe against a concurrent writer under WAL. See storage.insertFact for the full SQLITE_BUSY_SNAPSHOT rationale.
  return tx.immediate();
}

/** Records a repeat sighting of a `pending` fact: `mem scan-session`/`mem import --from-md` matched a candidate's text to `factId`, already queued and awaiting `mem review --promote`, instead of finding nothing and writing a second pending row. A restated preference is evidence a human reviewing the queue should see, not noise to drop with a bare `continue` -- which is what both callers did before this existed. Screens `raw` through `buildScreenedExcerpt` exactly like a first capture -- not optional here: a sighting is still raw session/file material, the same secret surface a first capture has, and "it's only a sighting" is not a reason to skip the check that content otherwise always gets. Returns `false`, writing nothing, in the two cases where under-counting is the safe direction: - `buildScreenedExcerpt` returns `null` (screened positive) -- there is no clean excerpt to write and, with no excerpt, no independent evidence to dedup a later real sighting against; - an identical excerpt is already stored for this fact. `sources` carries no locator column (`id, fact_id, excerpt, stored_at`) pointing back at which transcript position or file line produced it, so excerpt equality is the only key available to tell "the same statement, seen again by a second hook firing over the same transcript" (`mem scan-session` runs at both `Stop` and `PreCompact`) from "a genuine restatement" -- and a genuine restatement arrives with different surrounding context, so a different excerpt, every time. Never touches `status`: this function has no path that can promote, demote, or otherwise change a fact's state, however many times it is called. That invariant -- a `pending` fact promotes only through `mem review --promote`, never by time or repetition -- predates this function and nothing here weakens it. */
export function recordSighting(db: Database.Database, factId: string, raw: string, root: string, factText?: string, screenContext = ""): boolean {
  const excerpt = buildScreenedExcerpt(raw, root, factText, screenContext);
  if (excerpt === null) {
    return false;
  }
  if (listSourcesForFact(db, factId).some((source) => source.excerpt === excerpt)) {
    return false;
  }
  // Both writes are two separate columns on two separate rows describing the same event; a crash between them must not leave a source excerpt with no corresponding count, or vice versa. BEGIN IMMEDIATE, matching every other transaction in this module -- see storage.insertFact's SQLITE_BUSY_SNAPSHOT rationale for why a deferred transaction is the wrong default here too.
  const tx = db.transaction((): void => {
    insertSource(db, { factId, excerpt });
    incrementSightings(db, factId);
  });
  tx.immediate();
  return true;
}

/** Explicit capture: the user (or an agent on the user's behalf) said "remember X". Stored `active` immediately, `source_type: "user"` always (there is no parameter to override either — explicit capture is definitionally user-stated, maximal-trust input, design principle P1). */
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

  // Saying the same thing again reaffirms it rather than duplicating it. Without this, a repeated preference wrote a second row while the first one's decay clock kept running -- so the facts a user cared enough to restate were precisely the ones drifting below the ground-truth floor, and `mem recall` showed the same sentence twice with two different confidences. Explicit capture only. `captureSuggested` deliberately does not reaffirm: its candidates come from file and transcript content, and letting derived text refresh a user-stated fact's clock would hand a `CLAUDE.md` the power to keep a fact alive that the user never restated. The lookup and the reaffirm-or-insert it decides between must be one atomic unit: read outside the transaction (as this used to do) let two concurrent `mem remember` of the same sentence both see "nothing to reaffirm" and both insert -- the exact duplicate reaffirm exists to prevent.
  const tx = db.transaction((): CaptureResult => {
    const existing = findReaffirmableFact(db, newFact);
    if (existing !== undefined) {
      // The user's latest statement wins: an anchor or source-ref carried on this restatement replaces whatever the existing row had, rather than being silently discarded (see reaffirmFact's doc comment). Omitted here means "say nothing new" -- the existing value, anchor included, is left untouched.
      const restated = restatementUpdates(newFact, existing);
      const refreshed = reaffirmFact(db, existing.id, new Date(), restated.updates);
      if (refreshed === undefined) {
        throw new CaptureValidationError(`fact ${existing.id} vanished while being reaffirmed`);
      }
      const refreshedFields = ["captured_at and confidence refreshed", ...restated.changed];
      insertAuditLog(db, {
        event: "capture_reaffirmed",
        factId: refreshed.id,
        detail: `restated ${factNounPhrase(refreshed.kind)} (scope=${refreshed.scope}); ${refreshedFields.join("; ")}`,
      });
      return { fact: refreshed, reaffirmed: true };
    }

    // No live fact to reaffirm -- but the same sentence may already be sitting in the review queue as one or more `pending` suggestions (`mem suggest`, or a JSON import, can file the identical sentence more than once; that non-dedup is a separate, deliberately untouched concern). Stating it explicitly answers the queue for this sentence, not just for one row of it: the earliest-suggested match is promoted to `active` -- the only place a `pending` fact turns `active` other than an explicit `mem review --promote`, since restating it *is* that explicit confirmation -- and every other matching pending duplicate is superseded through the same status machinery `mem review`/`mem consolidate` use, so each carries a proper `prior_status`, `status_changed_at`, and audit entry rather than being silently left stranded in the queue.
    const [primary, ...duplicates] = findReaffirmablePendingFacts(db, newFact);
    if (primary !== undefined) {
      const restated = restatementUpdates(newFact, primary);
      // Explicit capture is always source_type "user"; a promoted suggestion was filed as "derived" and would otherwise lose contradiction precedence to an older user fact.
      const refreshed = reaffirmFact(db, primary.id, new Date(), { ...restated.updates, sourceType: "user" });
      if (refreshed === undefined) {
        throw new CaptureValidationError(`fact ${primary.id} vanished while being reaffirmed`);
      }
      const promoted = setFactStatus(db, primary.id, "active");
      if (promoted === undefined) {
        throw new CaptureValidationError(`fact ${primary.id} vanished while being promoted from pending`);
      }
      for (const duplicate of duplicates) {
        const superseded = setFactStatus(db, duplicate.id, "superseded");
        if (superseded === undefined) {
          throw new CaptureValidationError(`fact ${duplicate.id} vanished while being superseded as a duplicate pending suggestion`);
        }
        insertAuditLog(db, {
          event: "capture_reaffirmed_pending_duplicate_superseded",
          factId: duplicate.id,
          detail:
            `${SUPERSEDED_AS_DUPLICATE_PREFIX}${promoted.id}: duplicate pending suggestion of the same restated ` +
            "sentence, superseded when the primary was promoted via explicit restatement.",
        });
      }
      const refreshedFields = ["captured_at and confidence refreshed", "promoted from pending to active", ...(primary.source_type === "user" ? [] : [`source_type ${primary.source_type} -> user`]), ...restated.changed];
      if (duplicates.length > 0) {
        refreshedFields.push(`${duplicates.length} duplicate pending suggestion${duplicates.length === 1 ? "" : "s"} superseded`);
      }
      insertAuditLog(db, {
        event: "capture_reaffirmed_pending_promoted",
        factId: promoted.id,
        detail: `restated ${factNounPhrase(promoted.kind)} (scope=${promoted.scope}); ${refreshedFields.join("; ")}`,
      });
      return {
        fact: promoted,
        reaffirmed: true,
        promotedFromPending: true,
        supersededPendingDuplicateCount: duplicates.length,
      };
    }

    return { fact: writeFact(db, newFact, "capture_explicit", (f) => `stored active ${factNounPhrase(f.kind)} (scope=${f.scope})`) };
  });
  // BEGIN IMMEDIATE, for the same reason as `writeFact`: this reads (`findReaffirmableFact`) before it writes, and once this outer transaction is open, the nested `writeFact` transaction it may call degrades to a savepoint -- so this outer invocation is the one that decides whether the read-then-write pair is safe against a concurrent writer under WAL.
  return tx.immediate();
}

/** Suggested capture: a conservative extractor proposes a candidate fact. Always stored `pending` — there is no parameter to request `active`, so no caller (however it phrases the request) can make a suggested candidate skip human confirmation (S9). `source_type` defaults to `"derived"`, the more heavily quarantined option, when the caller does not specify it. */
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
    // Never active, never anything else: this is the single place a suggested fact's status is decided, and it is hardcoded so no caller input can reach "active" through this path.
    status: "pending",
    confidence,
  };
  if (input.capturedAt !== undefined) {
    newFact.captured_at = parseCapturedAtOrThrow(input.capturedAt);
  }
  applyOptionalFields(newFact, input, scope, root);

  // The same restatement rule `mem scan-session`/`mem import --from-md` apply before ever reaching this function, reused here rather than re-derived, so `mem suggest <text>` called twice counts the repetition identically instead of under-counting it. Those callers draw two different boundaries, and this has to draw both. A bound match of *any* status suppresses the insert (`import.ts`'s `skipped_known`): filing a pending row for a sentence the store already holds as `active` queues a human decision that was already made, which is precisely the noise `mem review` exists to be free of. Only a `pending` match gets a sighting, because only a pending row has anything to record one against.
  const boundMatches = factsByTextHash(db, text).filter((fact) => isBoundToRoot(fact, root));
  const pendingMatch = boundMatches.find((fact) => fact.status === "pending");
  if (pendingMatch !== undefined) {
    // The caller's text already is the fact, so `recordSighting` would only write a source row echoing it (and dedup every repeat after the first away, under-counting); bump the counter alone, atomically, and report what was written.
    db.transaction((): void => {
      incrementSightings(db, pendingMatch.id);
    }).immediate();
    return { fact: pendingMatch, sighted: true };
  }
  const knownMatch = boundMatches[0];
  if (knownMatch !== undefined) {
    return { fact: knownMatch, alreadyKnown: true };
  }

  const fact = writeFact(
    db,
    newFact,
    "capture_suggested",
    (f) => `stored pending ${factNounPhrase(f.kind)} (source_type=${f.source_type}, scope=${f.scope})`,
    input.sourceExcerpt
  );
  return { fact };
}
