/** Shared harness for tests that drive the built `dist/token-goat-mem.mjs` as a real subprocess -- the only way to exercise stdin, exit codes, and cross-process locking as shipped. */

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
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

/** How long a bundle child may run before it is killed; a diagnostic bound that names a hung child before vitest's anonymous test timeout does, not a fix for a slow start, and below that test timeout. */
export const BUNDLE_SPAWN_TIMEOUT_MS = 25_000;

/** The prefix of every variable the bundle reads for its own configuration; none of the parent's reaches a child, so a variable exported in a developer's shell cannot change what the shipped artifact does. */
const MEM_ENV_PREFIX = "TOKEN_GOAT_MEM_";

export interface BundleResult {
  readonly stdout: string;
  readonly stderr: string;
  /** The child's exit status, or -1 when it did not exit on its own (killed, or never started), so no expected exit code can match a hung child. */
  readonly exitCode: number;
  /** The signal that ended the child, e.g. SIGTERM after `BUNDLE_SPAWN_TIMEOUT_MS`; null when it exited by itself. */
  readonly signal: NodeJS.Signals | null;
  /** The spawn failure, e.g. an ETIMEDOUT from the time bound; undefined when the child ran and exited. */
  readonly error: Error | undefined;
}

export interface BundleRunOptions {
  /** Isolated mem home (`TOKEN_GOAT_MEM_HOME`), so a test never touches a real store. */
  readonly home: string;
  /** Piped to the child's stdin; empty by default, which closes it immediately. */
  readonly stdin?: string;
  /** Extra environment on top of the isolated defaults, winning over them (except `TOKEN_GOAT_MEM_HOME`). */
  readonly env?: Readonly<Record<string, string>>;
  /** The child's working directory; a fresh empty directory under `home` by default, so no project hooks or settings of the checkout under test are in reach. */
  readonly cwd?: string;
}

/** The environment a bundle child runs in: the parent's, minus every `TOKEN_GOAT_MEM_*` variable and the host's `CLAUDE_PROJECT_DIR`, with the store, snapshots and wiring home (where `doctor` and `init` look for user hooks) all inside `home` and recall never truncated, then `options.env`, then `options.home`. */
function bundleEnv(options: Pick<BundleRunOptions, "home" | "env">): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith(MEM_ENV_PREFIX) && name !== "CLAUDE_PROJECT_DIR") {
      inherited[name] = value;
    }
  }
  return {
    ...inherited,
    TOKEN_GOAT_MEM_BACKUP_DIR: join(options.home, "backups"),
    TOKEN_GOAT_MEM_WIRING_HOME: join(options.home, "wiring-home"),
    TOKEN_GOAT_MEM_RETRIEVAL_BUDGET_MS: String(NO_TRUNCATION_BUDGET_MS),
    ...options.env,
    TOKEN_GOAT_MEM_HOME: options.home,
  };
}

/** The directory a bundle child starts in unless the caller names one: empty, created on demand, and removed with `home`. */
function bundleCwd(options: Pick<BundleRunOptions, "home" | "cwd">): string {
  if (options.cwd !== undefined) {
    return options.cwd;
  }
  const cwd = join(options.home, "bundle-cwd");
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

/** Starts the bundle with piped stdout and stderr and no stdin, in the same isolated environment and working directory as `runBundleSync`, for a test that drives the pipes itself; the child is killed after `BUNDLE_SPAWN_TIMEOUT_MS`, so a hung one ends the test with a non-zero close instead of leaking. */
export function spawnBundle(args: readonly string[], options: Pick<BundleRunOptions, "home" | "env" | "cwd">): ChildProcessByStdio<null, Readable, Readable> {
  return spawn(process.execPath, [BUNDLE_PATH, ...args], {
    cwd: bundleCwd(options),
    env: bundleEnv(options),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: BUNDLE_SPAWN_TIMEOUT_MS,
  });
}

/** Runs the bundle to completion in an isolated environment and working directory, capturing both streams and the exit code rather than throwing. A child that is killed or never starts comes back with `exitCode` -1, its `signal` and `error`, and a note on `stderr` that every `expect(result.exitCode, result.stderr)` shows. */
export function runBundleSync(args: readonly string[], options: BundleRunOptions): BundleResult {
  const result = spawnSync(process.execPath, [BUNDLE_PATH, ...args], {
    encoding: "utf8",
    cwd: bundleCwd(options),
    env: bundleEnv(options),
    input: options.stdin ?? "",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: BUNDLE_SPAWN_TIMEOUT_MS,
  });
  const abnormal = result.error !== undefined || result.signal !== null;
  const note = abnormal ? `\n[runBundleSync] mem ${args.join(" ")} did not exit by itself: error ${String(result.error?.message)}, signal ${String(result.signal)}, bound ${BUNDLE_SPAWN_TIMEOUT_MS} ms` : "";
  return {
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${note}`,
    exitCode: abnormal ? -1 : (result.status ?? -1),
    signal: result.signal,
    error: result.error,
  };
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
