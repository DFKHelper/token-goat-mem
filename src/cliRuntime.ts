/**
 * The runtime every `mem` command action shares: the exit-code contract, the error-to-exit-code
 * mapping, the `guard` wrapper, and the handful of helpers each command needs to reach the store.
 *
 * It lives apart from cli.ts so a command can be registered from its own module (timeline.ts,
 * reflect.ts, ...) without importing cli.ts, which would make the dependency circular. cli.ts
 * re-exports the public part (`EXIT_*`, `UsageError`) so its own importers are unaffected. The
 * normative exit-code contract is documented in cli.ts's module doc comment.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type Database from "better-sqlite3";

import { CaptureValidationError, InvalidAnchorError, SecretDetectedError } from "./capture.js";
import { DreamConfigError } from "./dream.js";
import { JsonImportError } from "./exportImport.js";
import { MarkdownImportError } from "./import.js";
import { openStorage, resolveFactIdOrPrefix } from "./storage.js";
import type { Fact } from "./types.js";
import { WiringConflictError, WiringUserUnsupportedError } from "./wiring.js";

// ─────────────────────────────────────────────────────────────────────────── Exit-code contract ───────────────────────────────────────────────────────────────────────────

/** See cli.ts's module doc comment for the full normative contract. */
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
export function exitCodeForError(error: unknown): number {
  return error instanceof UsageError ||
    error instanceof CaptureValidationError ||
    error instanceof InvalidAnchorError ||
    error instanceof SecretDetectedError ||
    error instanceof WiringConflictError ||
    error instanceof WiringUserUnsupportedError ||
    error instanceof JsonImportError ||
    error instanceof MarkdownImportError ||
    // A misconfigured dream endpoint is a typo in an environment variable the user set, so it is
    // theirs to fix and exits 1. `DreamRequestError` deliberately stays at 2: an endpoint that is
    // down, slow, or answering with nonsense is neither a bad invocation nor a bug in mem, and 2 is
    // the closer of the two codes this CLI has -- a caller should retry it, not re-read its flags.
    error instanceof DreamConfigError
    ? EXIT_USER_ERROR
    : EXIT_INTERNAL_ERROR;
}

export function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function err(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Wraps a command action so any thrown error maps to one `mem: <message>` stderr line + the contract exit code (1 user error, 2 internal -- see `exitCodeForError`), and success to exit code 0 (unless the handler already set a different `process.exitCode`). Mirrors token-goat's own `cli.ts` guard. */
export function guard(fn: (...args: never[]) => void | Promise<void>): (...args: unknown[]) => Promise<void> {
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

// ─────────────────────────────────────────────────────────────────────────── Store access ───────────────────────────────────────────────────────────────────────────

export async function withDb<T>(fn: (db: Database.Database) => T | Promise<T>): Promise<T> {
  const db = openStorage();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/** Never defaults to ambient `process.cwd()` silently for anchor evaluation inside anchors.ts itself (Section 3) -- but a human-invoked, short-lived CLI command needs *some* root when the caller omits `--root`, and "the directory the command was invoked from" is the only reasonable one. Explicit `--root` always wins. */
export function resolveRoot(explicit: string | undefined): string {
  return resolvePath(explicit ?? process.cwd());
}

/**
 * Throws a `UsageError` when a transcript the caller named with `--transcript` cannot be read. Only
 * for an explicit path: there a missing file is a typo in *this* invocation, whereas a hook's
 * envelope path is background convenience that must fail open (`scanTranscript` swallows the same
 * error for it, deliberately). Checked up front so "nothing found" can never stand in for a scan
 * that never ran.
 */
export function assertTranscriptReadable(command: string, transcriptPath: string): void {
  try {
    readFileSync(transcriptPath, "utf8");
  } catch (error) {
    throw new UsageError(`${command}: cannot read transcript "${transcriptPath}" (${extractErrorMessage(error)})`);
  }
}

/**
 * Resolves a fact id argument (full id or git-style short prefix, `resolveFactIdOrPrefix` in
 * storage.ts) to the fact it names, or throws the same `UsageError` shape every id-accepting command
 * already used before short prefixes existed (`no such fact: <id>`), plus a new ambiguity error
 * listing every matching id. Every id-accepting command (`show`, `forget`, `pin`, `edit`, `review
 * --promote`, `review --reject`, `log --fact`) should use the resolved fact's own `.id` for any
 * subsequent write/lookup, never the raw user-typed argument.
 */
export function resolveIdArgOrThrow(db: Database.Database, id: string): Fact {
  const resolution = resolveFactIdOrPrefix(db, id);
  if (resolution.kind === "not-found") {
    throw noSuchFactError(id);
  }
  if (resolution.kind === "ambiguous") {
    throw ambiguousIdError(id, resolution.matches.map((fact) => fact.id));
  }
  return resolution.fact;
}

/** The `no such fact` usage error, shared by every resolver so the wording cannot fork. */
export function noSuchFactError(id: string): UsageError {
  return new UsageError(`no such fact: ${id}`);
}

/** The ambiguous-prefix usage error, listing every candidate so the user can pick a longer prefix. */
export function ambiguousIdError(id: string, matches: readonly string[]): UsageError {
  return new UsageError(`ambiguous id prefix "${id}" matches ${matches.length} facts: ${matches.join(", ")} -- use more characters`);
}

// ─────────────────────────────────────────────────────────────────────────── Listing output ───────────────────────────────────────────────────────────────────────────

/** Rows a listing command (`list`, `recall`, `log`) prints when `--limit` is not given. */
export const DEFAULT_LIST_LIMIT = 20;

/**
 * Characters of a fact id a listing (`recall`, `log`) prints ahead of each line.
 *
 * Recall's footer says `mem show <id> for detail`, but the 0.2.2 change that replaced the per-line
 * CTA with one shared footer also removed the only place an id was ever printed -- leaving the
 * footer instructing the user to use something the command never showed them. Eight hex characters
 * is the same git-style prefix `resolveFactIdOrPrefix` already resolves, so the printed handle can
 * be pasted straight back into `show`, `forget`, `edit`, or `log --fact`; an ambiguous prefix is
 * reported with its candidates rather than silently resolving to the wrong fact.
 */
export const SHORT_ID_LENGTH = 8;

export function shortFactId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

/** The line a listing appends when `--limit` cut it short, so a capped list never reads as complete. */
export function truncationNotice(shown: number, total: number): string {
  return `showing ${shown} of ${total} -- use --limit to see more\n`;
}

// ─────────────────────────────────────────────────────────────────────────── Flag validation ───────────────────────────────────────────────────────────────────────────

/**
 * Rejects a numeric flag below 1. Numeric flags are parsed with `parseInt`, so a non-numeric
 * argument arrives as `NaN` and is rejected here too; `undefined` -- the flag was not given -- passes.
 * `expected` completes the message ("--limit must be a positive integer") so each flag keeps the
 * wording its users and tests already see.
 */
export function assertPositiveFlag(flag: string, value: number | undefined, expected = "a positive integer"): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 1)) {
    throw new UsageError(`${flag} must be ${expected}`);
  }
}

/** `assertPositiveFlag` for a flag where 0 is meaningful (an epoch, a count to skip). */
export function assertNonNegativeFlag(flag: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new UsageError(`${flag} must be a non-negative integer`);
  }
}
