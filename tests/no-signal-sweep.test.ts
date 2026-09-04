/**
 * A run in which nothing succeeded must be distinguishable from one in which everything did.
 *
 * `src/cli.ts` states the exit-code half of this contract normatively: exit 0 is success, and
 * "nothing found" outcomes are successes rather than errors. That is a deliberate position and it
 * holds -- but it means the exit code deliberately carries *no* signal for an empty result, so the
 * entire burden of distinguishing "found nothing" from "found everything" falls on stdout. Where
 * stdout does not carry it either, the command is silent about having done nothing, which is the
 * same failure class as a seam that withholds facts while claiming to be complete.
 *
 * The sweep at the bottom of this file walks every registered command in that state. Two commands
 * failed it when it was first written, and their regressions are pinned individually above:
 *
 *   - `mem recall <query>` returned the entire store for a query that matched nothing, in output
 *     byte-identical to `mem recall` with no query at all. A query is a ranking input, not a
 *     filter -- BM25 orders the candidate set and never removes from it -- so the existing
 *     `results.length === 0` branch could not fire for a non-matching query, and the "no matching
 *     facts" outcome `src/cli.ts` documents was unreachable by that path.
 *   - `mem list --kind decision` printed "no facts stored" on a store that was not empty. The
 *     message is a claim about the whole store; a filter excluding everything is a different fact
 *     about the world, and reporting it as an empty store is simply false.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/cli.js";

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
}

/** Mirrors tests/cli.test.ts's harness: drives the real `run()` and captures both streams. */
async function runCli(args: readonly string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown): boolean => {
    stdout += chunk instanceof Buffer ? chunk.toString("utf8") : String(chunk);
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
    stderr += chunk instanceof Buffer ? chunk.toString("utf8") : String(chunk);
    return true;
  });
  process.exitCode = undefined;
  await run(["node", "mem", ...args]);
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  return { stdout, stderr, exitCode };
}

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-sweep-home-"));
  root = mkdtempSync(join(tmpdir(), "mem-sweep-root-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

/** Seeds three facts whose text shares no term with the nonsense queries below. */
async function seed(): Promise<void> {
  for (const text of ["uses vitest for tests", "prefers tabs over spaces", "deploys on fridays"]) {
    await runCli(["remember", text, "--kind", "fact", "--scope", "project", "--root", root]);
  }
}

describe("recall reports a query that ranked nothing", () => {
  it("says so, instead of returning the whole store as if it had matched", async () => {
    await seed();
    const result = await runCli(["recall", "xyzzyplughquux", "--root", root]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("query matched no fact text");
    // The facts are still shown -- the fix adds the missing signal, it does not empty the result.
    expect(result.stdout).toContain("uses vitest for tests");
  });

  it("is not byte-identical to the same recall with no query at all", async () => {
    await seed();
    const nonsense = await runCli(["recall", "xyzzyplughquux", "--root", root]);
    const unqueried = await runCli(["recall", "--root", root]);

    // This is the assertion the defect actually violated: before the fix these two were the same
    // bytes, so no consumer -- human or otherwise -- could tell a failed query from no query.
    expect(nonsense.stdout).not.toBe(unqueried.stdout);
  });

  it("stays quiet when the query really did rank something", async () => {
    await seed();
    const result = await runCli(["recall", "vitest", "--root", root]);

    expect(result.stdout).not.toContain("query matched no fact text");
    // Ranked first, which is what makes this a match rather than a coincidence of ordering.
    expect(result.stdout.split("\n")[0]).toContain("uses vitest for tests");
  });

  it("stays quiet when no query was given, since nothing was asked of the ranker", async () => {
    await seed();
    const result = await runCli(["recall", "--root", root]);

    expect(result.stdout).not.toContain("query matched no fact text");
  });

  it("a query that ranks nothing on the TGMEM/2 wire reorders (ties at 0) rather than erroring or emptying the response", async () => {
    await seed();
    const result = await runCli(["recall", "xyzzyplughquux", "--hint-format", "--root", root]);

    // `--hint-format` now honors a query the same way plain `recall` does (see cli.test.ts's
    // hint-format query coverage): BM25 orders the candidate set and never removes from it, and
    // TGMEM/2's grammar has no room for a human-facing "matched nothing" note (its lines are
    // machine-parsed, not prose) -- so a query that matches no fact text still surfaces every
    // fact, tied at score 0, exactly as a bare `--hint-format` would.
    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith("TGMEM/2\n")).toBe(true);
    expect(result.stdout).toContain("uses vitest for tests");
  });
});

describe("list distinguishes an empty store from an empty filter result", () => {
  it("does not claim the store is empty when a filter excluded everything", async () => {
    await seed();
    const result = await runCli(["list", "--kind", "decision"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no facts match these filters");
    expect(result.stdout).not.toContain("no facts stored");
  });

  it("still says the store is empty when it actually is", async () => {
    const result = await runCli(["list"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("no facts stored\n");
  });
});

/**
 * The sweep proper. Each case is a command run in a state where nothing succeeded, paired with the
 * signal that makes that state legible. Commands are grouped by which half of the contract carries
 * the signal, because the two halves fail differently: an exit-code command that regresses to 0
 * starts reporting failure as success, while a stdout command that loses its line goes silent.
 */
describe("no-signal sweep: every command distinguishes total failure from total success", () => {
  const MISSING = "00000000-0000-4000-8000-000000000000";

  // Commands whose "nothing succeeded" state is a user error: the exit code carries it.
  const failsLoudly: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["remember (invalid kind)", ["remember", "x", "--kind", "bogus"]],
    ["remember (secret refused)", ["remember", "api_key = sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "--kind", "fact"]],
    ["show (no such id)", ["show", MISSING]],
    ["forget (no such id)", ["forget", MISSING]],
    ["pin (no such id)", ["pin", MISSING]],
    ["edit (no such id)", ["edit", MISSING, "--text", "new"]],
    ["used (no such id)", ["used", MISSING, "--session-id", "s1"]],
    ["used (no --session-id)", ["used", MISSING]],
  ];

  for (const [label, args] of failsLoudly) {
    it(`${label} exits non-zero and names the reason on stderr`, async () => {
      const result = await runCli([...args]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/^mem: \S/u);
    });
  }

  // Commands whose "nothing found" state is a success by contract: stdout must carry the signal,
  // because the exit code deliberately does not.
  interface StdoutCase {
    readonly label: string;
    /** `list` and `review` take no `--root`, so each case carries its own exact argv. */
    readonly args: () => readonly string[];
    readonly seeded: boolean;
    readonly signal: RegExp;
  }

  const reportsOnStdout: readonly StdoutCase[] = [
    { label: "list (empty store)", args: () => ["list"], seeded: false, signal: /no facts stored/u },
    { label: "list (filter excludes all)", args: () => ["list", "--kind", "decision"], seeded: true, signal: /no facts match these filters/u },
    { label: "review (nothing pending)", args: () => ["review"], seeded: true, signal: /nothing needs review/u },
    { label: "recall (filter excludes all)", args: () => ["recall", "--kind", "decision", "--root", root], seeded: true, signal: /no matching facts/u },
    { label: "recall (query ranks nothing)", args: () => ["recall", "xyzzyplughquux", "--root", root], seeded: true, signal: /query matched no fact text/u },
  ];

  for (const testCase of reportsOnStdout) {
    it(`${testCase.label} exits 0 and says so on stdout`, async () => {
      if (testCase.seeded) {
        await seed();
      }
      const result = await runCli(testCase.args());

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(testCase.signal);
      // The contract reserves stderr for diagnostics; a success must not write one.
      expect(result.stderr).toBe("");
    });
  }

  // Parse errors are the one "nothing succeeded" state Commander owns rather than mem. They were
  // reaching the wrong exit code in-process because `exitOverride()` is per-Command and was set
  // only on the root, so a subcommand threw a plain Error instead of a coded CommanderError and
  // was classified as an internal bug. Production masked it: Commander's own `process.exit(1)`
  // produced the right code before mem's handler ran, at the cost of exiting mid-flush.
  const parseErrors: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["unknown option on a subcommand", ["list", "--bogus"]],
    ["option belonging to a different subcommand", ["list", "--root", "/tmp"]],
    ["unknown command", ["bogus"]],
  ];

  for (const [label, args] of parseErrors) {
    it(`${label} exits 1, the usage-error code, not 2`, async () => {
      const result = await runCli(args);

      expect(result.exitCode).toBe(1);
    });
  }

  it("still exits 0 for help and version, on the root and on a subcommand alike", async () => {
    // exitOverride turns Commander's help/version into thrown control flow, so extending it to
    // subcommands could plausibly have turned `mem list --help` into a failure. It does not.
    for (const args of [["--help"], ["--version"], ["list", "--help"], ["recall", "--help"]]) {
      const result = await runCli(args);
      expect(result.exitCode).toBe(0);
    }
  });

  it("import reports a run that wrote nothing, rather than exiting 0 in silence", async () => {
    await seed();
    const exported = await runCli(["export"]);
    expect(exported.exitCode).toBe(0);

    const path = join(root, "export.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, exported.stdout, "utf8");

    // Re-importing an existing export is the canonical all-rejected run: every candidate is a
    // duplicate. Exit 0 is correct per the contract (nothing failed; the import was idempotent),
    // which is exactly why stdout has to carry the fact that no rows were written.
    const reimported = await runCli(["import", "--from-json", path, "--root", root]);

    expect(reimported.exitCode).toBe(0);
    expect(reimported.stdout).toMatch(/no new facts were written/u);
    expect(reimported.stdout).toMatch(/imported 0 of \d+/u);
  });

  it("export emits a well-formed empty envelope rather than nothing at all", async () => {
    await seed();
    const result = await runCli(["export", "--kind", "decision"]);

    expect(result.exitCode).toBe(0);
    // Silence would be ambiguous with a crashed pipe; an envelope with an empty array is not.
    const envelope = JSON.parse(result.stdout) as { facts: unknown[] };
    expect(envelope.facts).toEqual([]);
  });
});
