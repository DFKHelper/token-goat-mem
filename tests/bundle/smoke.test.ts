/** A remember/recall/forget round trip and a `doctor` run, executed as a real subprocess against the built `dist/token-goat-mem.mjs`. This tier guards the bundling layer specifically -- everything the in-process `run()` tests cannot see, because they never load the artifact users execute: the esbuild `external` list resolving at runtime, the `__MEM_VERSION__` define, ESM/CJS interop for `better-sqlite3` / `commander` / `jsonc-parser`, native-module loading, process exit codes, and what actually lands on stdout vs stderr. A build can be broken in every one of those ways with all 550-odd in-process tests green. */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { countFactsWithStatus, logSurfacedInSession, runBundleSync, seedFacts, spawnBundle, type BundleResult } from "../support/bundle.js";

let memHome: string;
let root: string;

/** Runs the bundle against an isolated mem home, capturing both streams and the exit code rather than throwing. */
function runBundle(args: readonly string[]): BundleResult {
  return runBundleSync(args, { home: memHome });
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
  // The remember/recall/forget round trip is three tests of one spawn each: every cold start counts against a slow machine's test timeout, and each step starts from a store seeded in-process.
  it("remembers a fact into a database the bundle creates itself", () => {
    const remembered = runBundle(["remember", "uses pnpm not npm", "--kind", "preference", "--root", root]);
    expect(remembered.exitCode, remembered.stderr).toBe(0);
    expect(/remembered (?:\S+ )?fact (\S+)/u.exec(remembered.stdout)?.[1]).toBeDefined();

    // The database file is created by the bundle's own better-sqlite3 load -- a native module that is `external` to the build and resolved from node_modules at runtime.
    expect(existsSync(join(memHome, "mem.db"))).toBe(true);
    expect(countFactsWithStatus(memHome, "active"), "the fact the bundle reported is in the store it created").toBe(1);
  });

  it("recalls a stored fact on stdout", () => {
    seedFacts(memHome, ["uses pnpm not npm"], "preference");

    const recalled = runBundle(["recall", "pnpm", "--root", root]);
    expect(recalled.exitCode, recalled.stderr).toBe(0);
    expect(recalled.stdout).toContain("uses pnpm not npm");
  });

  it("forgets a stored fact, so it is retired in the store and no longer recalled", async () => {
    const [id = ""] = seedFacts(memHome, ["uses pnpm not npm"], "preference");
    // Non-firing guard for the check below: before the forget, an in-process recall over this very store surfaces the fact.
    expect(await logSurfacedInSession(memHome, root, "before-forget")).toBe(1);

    const forgotten = runBundle(["forget", id]);
    expect(forgotten.exitCode, forgotten.stderr).toBe(0);

    // The forget's effect is read from the store and an in-process recall rather than a second recall spawn.
    expect(countFactsWithStatus(memHome, "superseded")).toBe(1);
    expect(await logSurfacedInSession(memHome, root, "after-forget")).toBe(0);
  });

  it("runs doctor without crashing, in a home with no hooks installed and a working directory with no project settings", () => {
    const result = runBundle(["doctor"]);
    expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("emits the hint format token-goat parses, on stdout", () => {
    seedFacts(memHome, ["deploys need a changelog entry"], "decision");

    const hint = runBundle(["recall", "--hint-format", "--root", root]);
    expect(hint.exitCode).toBe(0);
    expect(hint.stdout.startsWith("TGMEM/")).toBe(true);
    // A plain, session-less recall never writes a `recall_log` row (see `markSurfaced` vs `recordSurfaced` in src/integration-seam.ts), so no `mem used` call could mark anything: printing the invocation anyway would earn the "never surfaced in session ..." reply it exists to stop producing.
    const footer = hint.stdout.split("\n").find((line) => line.startsWith("footer  "));
    expect(footer).toBeDefined();
    expect(footer).not.toContain("mem used");
  });

  it("exits non-zero with the diagnostic on stderr, not stdout, for a bad invocation", () => {
    const result = runBundle(["remember", "x", "--kind", "galaxy"]);
    // Positive, not merely non-zero: a child that was killed reports -1 and must not pass as a refusal.
    expect(result.exitCode, result.stderr).toBeGreaterThan(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("reports a version that is not the build-time placeholder", () => {
    const result = runBundle(["--version"]);
    expect(result.exitCode).toBe(0);
    // Guards the esbuild `define`: an unsubstituted `__MEM_VERSION__` would still exit 0.
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
  });

  /** Regression: `mem recall | head -1` and `mem recall | grep -q pnpm` close the pipe as soon as the reader is satisfied. Without an EPIPE handler the next write becomes an unhandled `error` event, so a pipeline that did exactly what the user asked dies with a stack trace and exit code 1. Only reachable from this tier: the handler is installed in `main.ts`, which the in-process `run()` tests never load, and it mutates process-global state so it could not be installed anywhere they would see it. */
  it("exits quietly when the reader of its stdout closes the pipe early", async () => {
    seedFacts(memHome, Array.from({ length: 5 }, (_unused, i) => `piped fact number ${i}`));

    const child = spawnBundle(["recall"], { home: memHome });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // Stand in for `head -1`: take the first chunk, then hang up.
    child.stdout.once("data", () => {
      child.stdout.destroy();
    });

    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.on("close", (code) => {
        resolveExit(code);
      });
    });

    expect(stderr).not.toMatch(/EPIPE|Unhandled|ERR_STREAM/u);
    expect(exitCode).toBe(0);
  });
});
