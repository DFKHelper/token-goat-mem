/**
 * `mem import --from-md <path>` -- the mem-side half of the "advisory CLAUDE.md->mem migration
 * probe" (the other half, `token-goat baseline --suggest-mem`, lives in the token-goat repo and is
 * not this module's concern; this module only needs to be a well-behaved producer of `pending`
 * facts through the existing trust path).
 *
 * Parses a markdown file (CLAUDE.md-style) for bullet-list lines that look like preference/
 * decision-shaped statements, and hands each qualifying bullet to `capture.ts`'s `captureSuggested`
 * -- the exact same `pending`, never-auto-promoted trust path any other suggested/derived fact goes
 * through (S9). There is deliberately no code path here that can write `status: "active"`; this
 * module does not call `captureExplicit` or `setFactStatus` at all. Promotion is exclusively `mem
 * review --promote`, already wired in cli.ts -- this module does not add a second one.
 *
 * The heuristic for "looks like a preference/decision statement" is intentionally shallow (a
 * classifier is out of scope): a single-line `-`/`*` bullet, outside a fenced code block, that is
 * not a *nested* sub-bullet under an obviously structural/non-preference heading (e.g.
 * "Architecture", "File Structure"). Ambiguous cases are imported rather than filtered out -- the
 * safety property comes from every candidate landing as `pending` (human confirmation required via
 * `mem review --promote`), not from pre-filtering cleverness.
 */

import { resolve } from "node:path";
import type Database from "better-sqlite3";

import { CaptureValidationError, SecretDetectedError, captureSuggested, type CaptureSuggestedInput } from "./capture.js";
import { readFileWithErrorMapping } from "./fileUtils.js";
import { listFacts } from "./storage.js";
import type { Fact, FactKind, FactScope } from "./types.js";

/**
 * Thrown for a file-read problem (missing file, permission denied, etc.) -- distinct from
 * per-bullet candidate problems which are reported as `skipped_error` outcomes instead.
 * Registered in `cli.ts`'s `exitCodeForError` as a user error (exit 1): a missing `--from-md`
 * file is bad input, not an internal bug.
 */
export class MarkdownImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownImportError";
  }
}

// ─────────────────────────────────────────────────────────────────────────── Markdown bullet extraction ───────────────────────────────────────────────────────────────────────────

export interface MarkdownBullet {
  /** Bullet text with the leading `-`/`*` marker and surrounding whitespace stripped. */
  readonly text: string;
  /** 1-based line number within the source file, for provenance (`source_ref`). */
  readonly line: number;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/u;
const BULLET_RE = /^(\s*)[-*]\s+(.+)$/u;
const FENCE_RE = /^\s*(```|~~~)/u;

/**
 * Headings whose *nested* bullets describe file/directory layout or system structure rather than a
 * preference or decision a human stated -- not a general topic blocklist, and only excludes nested
 * (indented) bullets under one of these headings. Top-level bullets and bullets under any other
 * heading are still candidates; per this module's doc comment, the review gate (not this list) is
 * the actual safety boundary.
 */
const NON_PREFERENCE_HEADING_RE = /\b(architecture|file structure|file organization|directory structure)\b/iu;

/**
 * Extracts candidate bullets from raw markdown text. Pure and file-IO-free so it can be unit-tested
 * against synthetic fixtures without touching disk.
 */
export function extractMarkdownBullets(markdown: string): MarkdownBullet[] {
  const lines = markdown.split(/\r?\n/u);
  const bullets: MarkdownBullet[] = [];
  /** The fence character (`` ` `` or `~`) that opened the current fence, or `null` when not inside one. Per CommonMark/GFM, a backtick fence can only be closed by a backtick fence and a tilde fence only by a tilde fence -- the two marker types don't close each other. */
  let fenceChar: string | null = null;
  let currentHeading = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      const marker = (fence[1] ?? "").charAt(0);
      if (fenceChar === null) {
        fenceChar = marker;
      } else if (marker === fenceChar) {
        fenceChar = null;
      }
      // A fence line using the non-matching marker while already inside a fence is just
      // ordinary content of that fence (e.g. a `~~~` line inside a ``` block) -- fall through
      // to the `inFence` check below rather than treating it as a close/reopen.
      continue;
    }
    if (fenceChar !== null) {
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      currentHeading = (heading[2] ?? "").trim();
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet === null) {
      continue;
    }
    const indent = (bullet[1] ?? "").length;
    const text = (bullet[2] ?? "").trim();
    if (text.length === 0) {
      continue;
    }
    if (indent > 0 && NON_PREFERENCE_HEADING_RE.test(currentHeading)) {
      continue;
    }
    bullets.push({ text, line: i + 1 });
  }

  return bullets;
}

// ─────────────────────────────────────────────────────────────────────────── Import orchestration ───────────────────────────────────────────────────────────────────────────

/** Every imported fact defaults to this kind: CLAUDE.md-style bullets are, per the feature spec, "preference/decision-shaped statements", and `preference` is the broader/safer of the two default `FactKind`s for free-text, unverified candidates. */
const IMPORT_KIND: FactKind = "preference";
/** CLAUDE.md-style files are almost always project-specific instructions; `project` (bound to `root`) is the more accurate default than `global`. Callers can still override via `ImportFromMarkdownOptions.scope`. */
const IMPORT_SCOPE_DEFAULT: FactScope = "project";

export interface ImportFromMarkdownOptions {
  /** Path to the markdown file to import. Resolved to an absolute path before reading/hashing for dedup. */
  readonly path: string;
  /** Project root, forwarded to `captureSuggested` for `.mem/allowlist` resolution and (for non-global scope) `scopeRoot` binding. */
  readonly root: string;
  readonly scope?: FactScope;
  readonly kind?: FactKind;
  /** When true, extracts and reports candidates but writes nothing (`captureSuggested` is never called). */
  readonly dryRun?: boolean;
}

export interface ImportCandidate {
  readonly text: string;
  readonly line: number;
  /** `<resolved file path>:<line>` -- stored verbatim as the imported fact's `source_ref` for provenance. */
  readonly sourceRef: string;
}

export type ImportOutcome =
  | { readonly status: "imported"; readonly candidate: ImportCandidate; readonly fact: Fact }
  | { readonly status: "skipped_duplicate"; readonly candidate: ImportCandidate }
  | { readonly status: "skipped_error"; readonly candidate: ImportCandidate; readonly reason: string }
  | { readonly status: "dry_run"; readonly candidate: ImportCandidate };

export interface ImportResult {
  readonly filePath: string;
  readonly candidates: readonly ImportCandidate[];
  readonly outcomes: readonly ImportOutcome[];
}

/** Dedup key: same source location *and* same text. A file edited between imports (bullet text changed at that line, or line numbers shifted) is treated as a new candidate rather than silently dropped -- only an exact re-import of unchanged content is a duplicate. */
function dedupKey(sourceRef: string, text: string): string {
  return `${sourceRef}::${text}`;
}

/**
 * Reuses the same in-memory-filter pattern cli.ts's own `recall`/`review` commands already use for
 * `listFacts(db, {})` -- there is no `source_ref`/`source_type` column in `FactFilter` (storage.ts),
 * so filtering after a full list is the existing convention here, not a new mechanism invented for
 * this command.
 */
function existingImportKeys(db: Database.Database): Set<string> {
  const keys = new Set<string>();
  for (const fact of listFacts(db, {})) {
    if (fact.source_type === "derived" && fact.source_ref !== null) {
      keys.add(dedupKey(fact.source_ref, fact.text));
    }
  }
  return keys;
}

/**
 * Reads and parses `options.path` into import candidates and their `dry_run` outcomes *without
 * opening a database*. This is the entire body of a `--dry-run` import, factored out so the CLI can
 * preview an import without side effects: opening mem's SQLite store (`openDb`) does `mkdirSync` +
 * creates the db file, WAL sidecars, and schema on disk, which would contradict `--dry-run`'s
 * documented "nothing written" contract for a project that has no store yet.
 */
export function planImportFromMarkdown(options: Pick<ImportFromMarkdownOptions, "path">): ImportResult {
  const filePath = resolve(options.path);

  // Wrap file read to reclassify filesystem errors (ENOENT, EACCES, etc.) as user errors
  // rather than internal errors: a missing or unreadable file is a user error (bad input path),
  // not a bug.
  const markdown = readFileWithErrorMapping(filePath, MarkdownImportError);

  const candidates: ImportCandidate[] = extractMarkdownBullets(markdown).map((bullet) => ({
    text: bullet.text,
    line: bullet.line,
    sourceRef: `${filePath}:${bullet.line}`,
  }));
  return { filePath, candidates, outcomes: candidates.map((candidate) => ({ status: "dry_run", candidate })) };
}

/**
 * Parses `options.path` for qualifying bullets and, unless `options.dryRun`, imports each
 * non-duplicate candidate as a `pending`, `source_type: "derived"` fact via `captureSuggested` --
 * the identical trust path every other suggested/derived fact goes through. A candidate that fails
 * capture-time validation (e.g. text too long) or secret screening is skipped and reported, not
 * fatal to the rest of the import; any other error propagates.
 */
export function importFromMarkdown(db: Database.Database, options: ImportFromMarkdownOptions): ImportResult {
  const plan = planImportFromMarkdown(options);
  if (options.dryRun === true) {
    return plan;
  }
  const { filePath, candidates } = plan;

  const seen = existingImportKeys(db);
  const kind = options.kind ?? IMPORT_KIND;
  const scope = options.scope ?? IMPORT_SCOPE_DEFAULT;

  const outcomes: ImportOutcome[] = [];
  for (const candidate of candidates) {
    const key = dedupKey(candidate.sourceRef, candidate.text);
    if (seen.has(key)) {
      outcomes.push({ status: "skipped_duplicate", candidate });
      continue;
    }

    const input: CaptureSuggestedInput = {
      text: candidate.text,
      kind,
      scope,
      sourceRef: candidate.sourceRef,
      sourceType: "derived",
      root: options.root,
    };
    try {
      const { fact } = captureSuggested(db, input);
      seen.add(key);
      outcomes.push({ status: "imported", candidate, fact });
    } catch (error) {
      if (error instanceof CaptureValidationError || error instanceof SecretDetectedError) {
        outcomes.push({ status: "skipped_error", candidate, reason: error.message });
        continue;
      }
      throw error;
    }
  }

  return { filePath, candidates, outcomes };
}
