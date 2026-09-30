/**
 * `mem log`: the store-wide audit timeline, newest first.
 *
 * `mem show <id>` reads one fact's audit trail back, but only once you already know which fact to
 * ask about. The question a user actually has after an agent session -- "what did it change in my
 * memory?" -- starts from the other end: from time, not from an id. `mem log` answers that from the
 * same `audit_log` rows, with the same filters `mem list` taught (`--limit`, `--json`, a truncation
 * notice that never lets a capped list read as complete).
 *
 * `--fact` resolves against the audit log as well as the live store. `gc` hard-deletes superseded
 * facts after 90 days but keeps their audit rows for 180, so for that window the log is the only
 * place a forgotten fact's id still means anything.
 */

import type Database from "better-sqlite3";
import type { Command } from "commander";

import {
  ambiguousIdError,
  assertPositiveFlag,
  DEFAULT_LIST_LIMIT,
  guard,
  noSuchFactError,
  SHORT_ID_LENGTH,
  shortFactId,
  truncationNotice,
  withDb,
} from "./cliRuntime.js";
import { countAuditLog, listAuditLog, listAuditLogFactIdsByPrefix, type AuditLogFilter, type AuditLogRow } from "./db.js";
import { isPlausibleIdPrefix, resolveFactIdOrPrefix } from "./storage.js";
import { daysAgoIso } from "./timeUtils.js";

/** Stands in for the short fact id on a store-level event (an import summary) that names no fact, keeping the columns aligned. */
const NO_FACT_PLACEHOLDER = "-".repeat(SHORT_ID_LENGTH);

/**
 * One audit row as a line: `[createdAt] event: detail`, or with `withFactId`, the short fact id
 * between the timestamp and the event. `mem show`'s history block and `mem log` both render through
 * this, so the two views of the same row cannot drift.
 */
export function formatAuditLine(entry: AuditLogRow, options: { readonly withFactId?: boolean } = {}): string {
  const fact = options.withFactId === true ? `${entry.factId === null ? NO_FACT_PLACEHOLDER : shortFactId(entry.factId)}  ` : "";
  return `[${entry.createdAt}] ${fact}${entry.event}: ${entry.detail}`;
}

/**
 * Resolves `--fact` to the one full fact id it names, looking in the live store and the audit log
 * together. An exact live id wins outright; otherwise every id either place knows under that prefix
 * is a candidate, so a prefix shared by a live fact and a gc-deleted one is reported as ambiguous
 * instead of silently showing only the live one's trail.
 */
export function resolveLoggedFactId(db: Database.Database, id: string): string {
  const live = resolveFactIdOrPrefix(db, id);
  if (live.kind === "found" && live.fact.id === id) {
    return id;
  }
  const liveIds = live.kind === "found" ? [live.fact.id] : live.kind === "ambiguous" ? live.matches.map((fact) => fact.id) : [];
  const loggedIds = isPlausibleIdPrefix(id) ? listAuditLogFactIdsByPrefix(db, id) : [];
  const candidates = [...new Set([...liveIds, ...loggedIds])].sort();
  const [only] = candidates;
  if (only === undefined) {
    throw noSuchFactError(id);
  }
  if (candidates.length > 1) {
    throw ambiguousIdError(id, candidates);
  }
  return only;
}

interface LogCliOptions {
  readonly fact?: string;
  readonly event?: string;
  readonly ageDays?: number;
  readonly limit?: number;
  readonly json?: boolean;
}

export function registerLogCommand(program: Command): void {
  program
    .command("log")
    .description("Show the store-wide audit timeline (captures, edits, pins, forgets, imports), newest first")
    .option("--fact <id>", "Only this fact's events (full id or short prefix; also finds facts gc has since deleted)")
    .option("--event <name>", "Only this event, or this event family (capture matches capture_explicit, capture_reaffirmed, ...)")
    .option("--age-days <days>", "Only events from the last N days", (v) => parseInt(v, 10))
    .option("--limit <n>", `Limit results (default ${DEFAULT_LIST_LIMIT})`, (v) => parseInt(v, 10))
    .option("--json", "Output machine-readable JSON (unstable, pre-1.0 -- shape may change)")
    .action(
      guard(async (options: LogCliOptions) => {
        assertPositiveFlag("--limit", options.limit);
        assertPositiveFlag("--age-days", options.ageDays, "a positive number");
        const limit = options.limit ?? DEFAULT_LIST_LIMIT;
        const { entries, total, filtered } = await withDb((db) => {
          const filter: AuditLogFilter = {
            ...(options.fact !== undefined ? { factId: resolveLoggedFactId(db, options.fact) } : {}),
            ...(options.event !== undefined ? { event: options.event } : {}),
            ...(options.ageDays !== undefined ? { since: daysAgoIso(options.ageDays, new Date()) } : {}),
          };
          return {
            entries: listAuditLog(db, filter, { limit, newestFirst: true }),
            total: countAuditLog(db, filter),
            filtered: Object.keys(filter).length > 0,
          };
        });
        const truncated = total > entries.length;
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify({ entries, total, truncated }, null, 2)}\n`);
          return;
        }
        if (entries.length === 0) {
          // Same rule as `mem list`: "empty" is a claim about the whole log, never printed for a
          // run that only filtered everything out.
          process.stdout.write(filtered ? "no audit events match these filters\n" : "audit log is empty\n");
          return;
        }
        for (const entry of entries) {
          process.stdout.write(`${formatAuditLine(entry, { withFactId: true })}\n`);
        }
        if (truncated) {
          process.stdout.write(truncationNotice(entries.length, total));
        }
      })
    );
}
