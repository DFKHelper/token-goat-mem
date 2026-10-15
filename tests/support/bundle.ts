/** Shared harness for tests that drive the built `dist/token-goat-mem.mjs` as a real subprocess -- the only way to exercise stdin, exit codes, and cross-process locking as shipped. */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";

import { resolveDbPath } from "../../src/db.js";
import { buildHintFormat } from "../../src/integration-seam.js";
import { insertFact, openStorage } from "../../src/storage.js";
import type { FactKind, FactStatus } from "../../src/types.js";
import { copyTemplateStore } from "./templateStore.js";

/** A soft budget no runner reaches, so a slow machine cannot turn an in-process recall into an empty one. */
const NO_TRUNCATION_BUDGET_MS = 3_600_000;

export const BUNDLE_PATH = fileURLToPath(new URL("../../dist/token-goat-mem.mjs", import.meta.url));

export interface BundleResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface BundleRunOptions {
  /** Isolated mem home (`TOKEN_GOAT_MEM_HOME`), so a test never touches a real store. */
  readonly home: string;
  /** Piped to the child's stdin; empty by default, which closes it immediately. */
  readonly stdin?: string;
  /** Extra environment on top of the parent's. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Runs the bundle to completion, capturing both streams and the exit code rather than throwing. */
export function runBundleSync(args: readonly string[], options: BundleRunOptions): BundleResult {
  const result = spawnSync(process.execPath, [BUNDLE_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...options.env, TOKEN_GOAT_MEM_HOME: options.home },
    input: options.stdin ?? "",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
}

/** Runs `use` against the store the bundle reads under `home`, in this process, then closes it. A store that does not exist yet starts as a copy of the finished template, so the bundle's first open is of an existing store, as it is in use; the bundle must not be running meanwhile. */
export function withBundleStore<T>(home: string, use: (db: Database.Database) => T): T {
  const dbPath = resolveDbPath(home);
  const db = openStorage(existsSync(dbPath) ? dbPath : copyTemplateStore(dbPath), { autoSnapshot: false });
  try {
    return use(db);
  } finally {
    db.close();
  }
}

/** Seeds one active global fact per text, oldest first and a second apart, and returns their ids in the same order. In-process store setup for tests whose subject is the bundle's argv, stdin, stdout or exit code, not capture. */
export function seedFacts(home: string, texts: readonly string[], kind: FactKind = "fact"): string[] {
  const oldest = Date.now() - 60_000;
  return withBundleStore(home, (db) =>
    texts.map((text, index) => insertFact(db, { text, kind, scope: "global", source_type: "user", captured_at: new Date(oldest + index * 1000).toISOString() }).id)
  );
}

/** How many facts the store under `home` holds in `status`. */
export function countFactsWithStatus(home: string, status: FactStatus): number {
  return withBundleStore(home, (db) => db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM facts WHERE status = ?").get(status)?.n ?? -1);
}

/** Logs a full recall under `sessionId` in-process, so a bundle `--delta` run starts from a session that has already been shown the store. Returns how many fact-lines that recall emitted. */
export async function logSurfacedInSession(home: string, root: string, sessionId: string): Promise<number> {
  const result = await buildHintFormat({ root, dbPath: resolveDbPath(home), sessionId, retrievalBudgetMs: NO_TRUNCATION_BUDGET_MS });
  return result.lines.filter((line) => /^(pref|dec|fact|corr) {2}/u.test(line)).length;
}
