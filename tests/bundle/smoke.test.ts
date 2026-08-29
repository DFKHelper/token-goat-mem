/**
 * A remember/recall/forget round trip and a `doctor` run, executed as a real subprocess against the
 * built `dist/token-goat-mem.mjs`.
 *
 * This tier guards the bundling layer specifically -- everything the in-process `run()` tests cannot
 * see, because they never load the artifact users execute: the esbuild `external` list resolving at
 * runtime, the `__MEM_VERSION__` define, ESM/CJS interop for `better-sqlite3` / `commander` /
 * `jsonc-parser`, native-module loading, process exit codes, and what actually lands on stdout vs
 * stderr. A build can be broken in every one of those ways with all 550-odd in-process tests green.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BUNDLE = fileURLToPath(new URL("../../dist/token-goat-mem.mjs", import.meta.url));

interface BundleResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

let memHome: string;
let root: string;

/** Runs the bundle against an isolated mem home, capturing both streams and the exit code rather than throwing. */
function runBundle(args: readonly string[]): BundleResult {
  try {
    const stdout = execFileSync(process.execPath, [BUNDLE, ...args], {
      encoding: "utf8",
      env: { ...process.env, TOKEN_GOAT_MEM_HOME: memHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: failure.status ?? 1 };
  }
}

beforeEach(() => {
  memHome = mkdtempSync(join(tmpdir(), "mem-smoke-home-"));
  root = mkdtempSync(join(tmpdir(), "mem-smoke-root-"));
});

afterEach(() => {
  rmSync(memHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("the shipped bundle runs end to end", () => {
  it("stores, recalls, and forgets a fact against a real SQLite database", () => {
    const remembered = runBundle(["remember", "uses pnpm not npm", "--kind", "preference", "--root", root]);
    expect(remembered.exitCode).toBe(0);

    const match = /remembered (?:\S+ )?fact (\S+)/u.exec(remembered.stdout);
    expect(match?.[1]).toBeDefined();
    const id = match?.[1] ?? "";

    // The database file is created by the bundle's own better-sqlite3 load -- a native module that
    // is `external` to the build and resolved from node_modules at runtime.
    expect(existsSync(join(memHome, "mem.db"))).toBe(true);

    const recalled = runBundle(["recall", "pnpm", "--root", root]);
    expect(recalled.exitCode).toBe(0);
    expect(recalled.stdout).toContain("uses pnpm not npm");

    const forgotten = runBundle(["forget", id]);
    expect(forgotten.exitCode).toBe(0);

    const afterForget = runBundle(["recall", "pnpm", "--root", root]);
    expect(afterForget.exitCode).toBe(0);
    expect(afterForget.stdout).not.toContain("uses pnpm not npm");
  });

  it("runs doctor without crashing", () => {
    const result = runBundle(["doctor"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("emits the hint format token-goat parses, on stdout", () => {
    runBundle(["remember", "deploys need a changelog entry", "--kind", "decision", "--scope", "global"]);

    const hint = runBundle(["recall", "--hint-format", "--root", root]);
    expect(hint.exitCode).toBe(0);
    expect(hint.stdout.startsWith("TGMEM/")).toBe(true);
  });

  it("exits non-zero with the diagnostic on stderr, not stdout, for a bad invocation", () => {
    const result = runBundle(["remember", "x", "--kind", "galaxy"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("reports a version that is not the build-time placeholder", () => {
    const result = runBundle(["--version"]);
    expect(result.exitCode).toBe(0);
    // Guards the esbuild `define`: an unsubstituted `__MEM_VERSION__` would still exit 0.
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
  });
});
