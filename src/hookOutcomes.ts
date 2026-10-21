/** The hook outcome log: a tiny, best-effort JSONL file beside the store that records how each hook run ended, so `mem doctor` can say how often a hook ran out of time, met an unreadable store, or failed inside. A file rather than a table on purpose: a hook must never wait on the store's busy timeout, and an unreadable store cannot be written at all. A record holds no query, fact id, or session id. */

import { appendFileSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { MEM_DB_MODE } from "./fileUtils.js";

export const HOOK_OUTCOME_HOOKS = ["prompt", "session-start", "other"] as const;
export const HOOK_OUTCOME_KINDS = ["ok", "out-of-time", "store-unreadable", "internal-error"] as const;

export type HookOutcomeHook = (typeof HOOK_OUTCOME_HOOKS)[number];
export type HookOutcomeKind = (typeof HOOK_OUTCOME_KINDS)[number];

/** One line of the log. `at` is an ISO timestamp the caller supplies, `ms` how long the hook ran, `cut` how many anchor checks the retrieval budget cut short. */
export interface HookOutcomeRecord {
  readonly v: 1;
  readonly at: string;
  readonly hook: HookOutcomeHook;
  readonly outcome: HookOutcomeKind;
  readonly ms: number;
  readonly cut: number;
}

export const HOOK_OUTCOMES_FILE = "hook-outcomes.log";
export const HOOK_OUTCOMES_ROTATED_FILE = "hook-outcomes.log.1";

/** The size at which the live file is renamed over the rotated one before the next append: at most about twice this is ever on disk. */
export const HOOK_OUTCOMES_MAX_BYTES = 256 * 1024;

/** Moves the live file to the rotated name only if it is still over the cap once it is ours. The size seen before this call can be stale (another process may have rotated in between), and renaming a fresh small file over the rotated one would erase the retained history, so the live file is first renamed to a private name, re-measured, and either promoted to the rotated name or merged back into a new live file. */
function rotateLive(dir: string, live: string): void {
  const claimed = join(dir, `${HOOK_OUTCOMES_ROTATED_FILE}.${process.pid}.tmp`);
  renameSync(live, claimed);
  if (statSync(claimed).size >= HOOK_OUTCOMES_MAX_BYTES) {
    renameSync(claimed, join(dir, HOOK_OUTCOMES_ROTATED_FILE));
    return;
  }
  appendFileSync(live, readFileSync(claimed), { mode: MEM_DB_MODE });
  unlinkSync(claimed);
}

/** Appends one record next to the store at `dbPath`. Never throws and never logs: a hook has a hard time budget, and a log that cannot be written (missing directory, read-only disk, a rename lost to another process) is not worth failing it for. */
export function appendHookOutcome(dbPath: string, record: HookOutcomeRecord): void {
  try {
    const dir = dirname(dbPath);
    const live = join(dir, HOOK_OUTCOMES_FILE);
    let size = 0;
    try {
      size = statSync(live).size;
    } catch {
      // No live file yet: nothing to rotate.
    }
    if (size >= HOOK_OUTCOMES_MAX_BYTES) {
      rotateLive(dir, live);
    }
    appendFileSync(live, `${JSON.stringify(record)}\n`, { mode: MEM_DB_MODE });
  } catch {
    // Best effort by design: see the doc comment above.
  }
}

/** The tallies for one slice of the log (one hook, or all of them). `p95Ms` is the nearest-rank 95th percentile of `ms`, 0 for an empty slice. */
export interface HookOutcomeTally {
  readonly runs: number;
  readonly ok: number;
  readonly outOfTime: number;
  readonly storeUnreadable: number;
  readonly internalErrors: number;
  readonly cut: number;
  readonly p95Ms: number;
}

export interface HookOutcomeSummary {
  readonly total: HookOutcomeTally;
}

function isHook(value: unknown): value is HookOutcomeHook {
  return (HOOK_OUTCOME_HOOKS as readonly unknown[]).includes(value);
}

function isKind(value: unknown): value is HookOutcomeKind {
  return (HOOK_OUTCOME_KINDS as readonly unknown[]).includes(value);
}

function parseRecord(line: string): HookOutcomeRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const fields = parsed as Record<string, unknown>;
  const { v, at, hook, outcome, ms, cut } = fields;
  if (v !== 1 || typeof at !== "string" || !isHook(hook) || !isKind(outcome)) {
    return null;
  }
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || typeof cut !== "number" || !Number.isInteger(cut) || cut < 0) {
    return null;
  }
  return { v, at, hook, outcome, ms, cut };
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }
}

function tally(records: readonly HookOutcomeRecord[]): HookOutcomeTally {
  const sorted = records.map((record) => record.ms).sort((a, b) => a - b);
  // Nearest rank: the smallest value with at least 95% of the runs at or below it.
  const p95Ms = sorted.length === 0 ? 0 : (sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0);
  const count = (kind: HookOutcomeKind): number => records.filter((record) => record.outcome === kind).length;
  return {
    runs: records.length,
    ok: count("ok"),
    outOfTime: count("out-of-time"),
    storeUnreadable: count("store-unreadable"),
    internalErrors: count("internal-error"),
    cut: records.reduce((sum, record) => sum + record.cut, 0),
    p95Ms,
  };
}

/** Reads the rotated and the live log under the mem home `home` (older first), skipping any line that is not a well-formed record, and tallies them. A missing file reads as empty. */
export function summarizeHookOutcomes(home: string): HookOutcomeSummary {
  const records = [...readLines(join(home, HOOK_OUTCOMES_ROTATED_FILE)), ...readLines(join(home, HOOK_OUTCOMES_FILE))]
    .map((line) => parseRecord(line))
    .filter((record): record is HookOutcomeRecord => record !== null);
  return { total: tally(records) };
}
