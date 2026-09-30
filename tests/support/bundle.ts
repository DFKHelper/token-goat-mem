/**
 * Shared harness for tests that drive the built `dist/token-goat-mem.mjs` as a real subprocess --
 * the only way to exercise stdin, exit codes, and cross-process locking as shipped.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
