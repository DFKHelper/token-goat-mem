/**
 * End-to-end tests for src/cli.ts, driven through `run()` (the same entry point src/main.ts calls)
 * rather than by calling the underlying domain modules directly -- these tests exercise the actual
 * argv parsing, CLI-boundary validation, output formatting, and DB lifecycle wiring `cli.ts` owns.
 *
 * Each test gets an isolated `TOKEN_GOAT_MEM_HOME` (a fresh temp dir), matching the isolation
 * discipline tests/setup/isolate-home.ts already establishes at the file level, but re-applied
 * per-test here so facts written by one test can never leak into another within this file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/cli.js";
import { openDb, resolveDbPath } from "../src/db.js";
import { openStorage } from "../src/storage.js";
import { captureSuggested } from "../src/capture.js";

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
}

/**
 * Runs one CLI invocation through the real `run()` entry point, capturing everything written to
 * stdout/stderr instead of letting it hit the real streams, and returning the resulting
 * `process.exitCode`. Resets `process.exitCode` to `undefined` immediately after each call so a
 * command that intentionally exercises the error path (exit code 1) never leaks into the exit code
 * of the vitest process itself.
 */
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

/** Extracts the fact id from `remembered <kind> fact <id>` (the `remember` command's success line). */
function extractRememberedId(result: CliResult): string {
  const match = /remembered \S+ fact (\S+)/u.exec(result.stdout);
  if (match?.[1] === undefined) {
    throw new Error(`could not extract fact id from stdout: ${JSON.stringify(result.stdout)}`);
  }
  return match[1];
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-cli-test-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  rmSync(home, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────── happy path ───────────────────────────────────────────────────────────────────────────

describe("mem CLI happy path", () => {
  it("remember -> list -> show -> recall -> edit -> pin -> forget round-trips through a single fact", async () => {
    const remembered = await runCli([
      "remember",
      "uses pnpm not npm",
      "--kind",
      "preference",
      "--subject",
      "package-manager",
      "--value",
      "pnpm",
    ]);
    expect(remembered.exitCode).toBe(0);
    expect(remembered.stdout).toMatch(/^remembered preference fact \S+\n$/u);
    const id = extractRememberedId(remembered);

    const listed = await runCli(["list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain(id);
    expect(listed.stdout).toContain("[preference/active]");
    expect(listed.stdout).toContain("package-manager=pnpm");

    const shown = await runCli(["show", id]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain(`id: ${id}`);
    expect(shown.stdout).toContain("status: active");
    expect(shown.stdout).toContain("source_type: user");
    // No anchor was set, so freshness can neither confirm nor deny -- always unverified, never a
    // fabricated affirmed/contradicted verdict for a fact with no predicate to evaluate (P3).
    expect(shown.stdout).toContain("freshness=unverified");

    const recalled = await runCli(["recall", "pnpm"]);
    expect(recalled.exitCode).toBe(0);
    expect(recalled.stdout).toContain("uses pnpm not npm");
    // Preferences always carry a caveat regardless of trust level (P6) -- never a bald assertion. No
    // anchor was set, so freshness is "unverified" (not "affirmed"), which buildDisplay renders as an
    // explicit "verify" caveat rather than the terser "(verify)" tag reserved for affirmed facts.
    expect(recalled.stdout).toContain("stored pref (unverified,");
    expect(recalled.stdout).toContain("verify;");

    const edited = await runCli(["edit", id, "--text", "uses pnpm exclusively"]);
    expect(edited.exitCode).toBe(0);
    expect(edited.stdout).toBe(`edited ${id}\n`);
    const afterEdit = await runCli(["show", id]);
    expect(afterEdit.stdout).toContain("text: uses pnpm exclusively");

    const pinned = await runCli(["pin", id]);
    expect(pinned.exitCode).toBe(0);
    expect(pinned.stdout).toBe(`pinned ${id}\n`);
    const afterPin = await runCli(["show", id]);
    expect(afterPin.stdout).toContain("status: pinned");

    const forgotten = await runCli(["forget", id]);
    expect(forgotten.exitCode).toBe(0);
    expect(forgotten.stdout).toBe(`forgot ${id}\n`);
    const afterForget = await runCli(["show", id]);
    expect(afterForget.stdout).toContain("status: superseded");

    const activeList = await runCli(["list", "--status", "active"]);
    expect(activeList.exitCode).toBe(0);
    expect(activeList.stdout).not.toContain(id);
  });

  it("reports the write epoch and bumps it on every write", async () => {
    const initial = await runCli(["epoch"]);
    expect(initial.exitCode).toBe(0);
    expect(initial.stdout.trim()).toBe("0");

    await runCli(["remember", "test fact", "--kind", "fact"]);

    const afterWrite = await runCli(["epoch"]);
    expect(afterWrite.stdout.trim()).toBe("1");
  });

  it("maps an unknown fact id to a single `mem: ...` stderr line and exit code 1, never a stack trace", async () => {
    const result = await runCli(["show", "does-not-exist"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("mem: no such fact: does-not-exist\n");
  });

  it("rejects an invalid --kind at the CLI boundary before any DB write happens", async () => {
    const result = await runCli(["remember", "bogus", "--kind", "not-a-real-kind"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid kind "not-a-real-kind"');

    const listed = await runCli(["list"]);
    expect(listed.stdout).toBe("no facts stored\n");
  });
});

// ─────────────────────────────────────────────────────────────────────────── contradiction.ts via `mem review` / `mem recall` ───────────────────────────────────────────────────────────────────────────

describe("contradiction handling surfaced through the CLI (contradiction.ts, P4)", () => {
  it("two active facts, same subject+scope, conflicting value, tied precedence -> contested: withheld from ground truth, visible in `mem review`, excluded from --hint-format, never silently resolved", async () => {
    const first = await runCli([
      "remember",
      "uses pnpm",
      "--kind",
      "preference",
      "--subject",
      "package-manager",
      "--value",
      "pnpm",
    ]);
    const idA = extractRememberedId(first);
    const second = await runCli([
      "remember",
      "uses npm",
      "--kind",
      "preference",
      "--subject",
      "package-manager",
      "--value",
      "npm",
    ]);
    const idB = extractRememberedId(second);

    // Both facts came from explicit `remember` (source_type=user, tied provenance). Force their
    // captured_at to be byte-identical so precedence is genuinely tied (P4's "same recency/provenance"
    // contested case) rather than depending on which of two rapid-fire CLI calls happened to land in
    // an earlier millisecond -- that would make the test's outcome nondeterministic.
    const db = openDb(resolveDbPath());
    const tiedTimestamp = "2026-01-01T00:00:00.000Z";
    db.prepare("UPDATE facts SET captured_at = ? WHERE id IN (?, ?)").run(tiedTimestamp, idA, idB);
    db.close();

    const review = await runCli(["review"]);
    expect(review.exitCode).toBe(0);
    expect(review.stdout).toContain("contested (ambiguous contradiction -- withheld from ground truth)");
    expect(review.stdout).toContain(idA);
    expect(review.stdout).toContain(idB);

    // Contradiction resolution is re-derived live at read time -- `mem review` surfaces the conflict
    // without mutating either fact's persisted status; a human must resolve it explicitly.
    const activeList = await runCli(["list", "--status", "active"]);
    expect(activeList.stdout).toContain(idA);
    expect(activeList.stdout).toContain(idB);

    // Plain `mem recall` (no --hint-format) still surfaces the contested pair, but caveated as
    // excluded rather than presented as ground truth -- a human using `mem recall` interactively can
    // see the ambiguity; an automated consumer must not.
    const recalled = await runCli(["recall", "package manager"]);
    expect(recalled.stdout).toContain("(contested, excluded)");

    // --hint-format is precision-max: contested facts are excluded entirely, never handed to the
    // agent as an unresolved either/or it would have to gamble on (Section 4).
    const hintFormat = await runCli(["recall", "--hint-format", "--root", home]);
    expect(hintFormat.exitCode).toBe(0);
    expect(hintFormat.stdout.startsWith("TGMEM/1\n")).toBe(true);
    expect(hintFormat.stdout).not.toContain("uses pnpm");
    expect(hintFormat.stdout).not.toContain("uses npm");
  });
});

// ─────────────────────────────────────────────────────────────────────────── capture.ts via `mem review --promote` ───────────────────────────────────────────────────────────────────────────

describe("suggested/derived facts never auto-promote (capture.ts S9, surfaced via `mem review`)", () => {
  it("a derived pending fact stays out of ground truth and --hint-format until an explicit `mem review --promote`", async () => {
    const db = openStorage(resolveDbPath());
    const { fact } = captureSuggested(db, {
      text: "internal service X owns migrations",
      kind: "fact",
      root: home,
      // sourceType intentionally omitted -- captureSuggested defaults to the more heavily
      // quarantined "derived" when the caller doesn't say otherwise (Section 3).
    });
    db.close();
    expect(fact.status).toBe("pending");
    expect(fact.source_type).toBe("derived");

    const activeList = await runCli(["list", "--status", "active"]);
    expect(activeList.stdout).not.toContain(fact.id);

    const pendingList = await runCli(["list", "--status", "pending"]);
    expect(pendingList.stdout).toContain(fact.id);

    const review = await runCli(["review"]);
    expect(review.stdout).toContain("pending (never auto-promoted -- confirm with --promote/--reject)");
    expect(review.stdout).toContain(fact.id);

    // Plain `mem recall` may still surface it, but only as an explicitly unconfirmed candidate.
    const recalled = await runCli(["recall", "migrations"]);
    expect(recalled.stdout).toContain("(pending, unconfirmed)");

    // --hint-format excludes pending/derived candidates entirely -- an automated consumer never sees
    // an unconfirmed suggestion presented as memory.
    const hintFormat = await runCli(["recall", "--hint-format", "--root", home]);
    expect(hintFormat.stdout).not.toContain("internal service X owns migrations");

    // Promotion requires an explicit human action; there is no code path that reaches "active" for a
    // pending fact other than this one.
    const promoted = await runCli(["review", "--promote", fact.id]);
    expect(promoted.exitCode).toBe(0);
    expect(promoted.stdout).toBe(`promoted ${fact.id}\n`);

    const activeAfterPromote = await runCli(["list", "--status", "active"]);
    expect(activeAfterPromote.stdout).toContain(fact.id);
  });

  it("refuses to promote a fact that is not pending", async () => {
    const remembered = await runCli(["remember", "already active", "--kind", "fact"]);
    const id = extractRememberedId(remembered);

    const result = await runCli(["review", "--promote", id]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`fact ${id} is not pending (status=active)`);
  });
});

// ─────────────────────────────────────────────────────────────────────────── exit-code / stream contract ───────────────────────────────────────────────────────────────────────────

describe("exit-code and stderr/stdout contract (cli.ts module doc)", () => {
  it("maps an internal failure (unopenable DB) to exit code 2 with a single `mem: ...` stderr line and no stdout", async () => {
    // TOKEN_GOAT_MEM_HOME points at a *file*, so mkdir/open of mem.db inside it fails -- an
    // environment failure, not a usage error, and must be distinguishable from one (exit 2, not 1).
    const brokenHome = join(mkdtempSync(join(tmpdir(), "mem-cli-internal-")), "not-a-directory");
    writeFileSync(brokenHome, "this is a file, not a mem home directory");
    process.env["TOKEN_GOAT_MEM_HOME"] = brokenHome;

    try {
      const result = await runCli(["list"]);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^mem: /u);
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(join(brokenHome, ".."), { recursive: true, force: true });
    }
  });

  it("maps user errors to exit code 1 with diagnostics on stderr and nothing on stdout", async () => {
    // Unknown fact id.
    const unknownId = await runCli(["forget", "no-such-id"]);
    expect(unknownId.exitCode).toBe(1);
    expect(unknownId.stdout).toBe("");
    expect(unknownId.stderr).toBe("mem: no such fact: no-such-id\n");

    // Invalid option value.
    const badScope = await runCli(["remember", "x", "--kind", "fact", "--scope", "galaxy"]);
    expect(badScope.exitCode).toBe(1);
    expect(badScope.stderr).toContain('invalid scope "galaxy"');

    // Commander-level parse failure (unknown command).
    const unknownCommand = await runCli(["frobnicate"]);
    expect(unknownCommand.exitCode).toBe(1);
    expect(unknownCommand.stdout).toBe("");
    expect(unknownCommand.stderr.length).toBeGreaterThan(0);
  });

  it("treats --help as success (exit 0)", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });

  it("keeps data on stdout and stderr empty on success", async () => {
    const remembered = await runCli(["remember", "stdout only", "--kind", "fact"]);
    expect(remembered.exitCode).toBe(0);
    expect(remembered.stderr).toBe("");

    const listed = await runCli(["list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stderr).toBe("");
    expect(listed.stdout).toContain("stdout only");
  });
});

// ─────────────────────────────────────────────────────────────────────────── mem doctor ───────────────────────────────────────────────────────────────────────────

describe("mem doctor (read-only health check)", () => {
  it("reports db path, WAL mode, schema tables, epoch, and zeroed fact counts on a fresh home", async () => {
    const result = await runCli(["doctor"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`db: ${join(home, "mem.db")}`);
    expect(result.stdout).toContain("journal_mode: wal");
    expect(result.stdout).toContain("foreign_keys: on");
    for (const table of ["audit_log", "facts", "meta", "sources"]) {
      expect(result.stdout).toContain(table);
    }
    expect(result.stdout).toContain("epoch: 0");
    expect(result.stdout).toContain("active=0");
    expect(result.stdout).toContain("(total 0)");
  });

  it("reflects writes in its counts without performing any itself", async () => {
    await runCli(["remember", "doctor sees me", "--kind", "preference"]);

    const result = await runCli(["doctor"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("epoch: 1");
    expect(result.stdout).toContain("active=1");
    expect(result.stdout).toContain("(total 1)");

    // Read-only: a doctor run must not bump the epoch or write anything.
    const epochAfter = await runCli(["epoch"]);
    expect(epochAfter.stdout.trim()).toBe("1");
  });
});

// ─────────────────────────────────────────────────────────────────────────── integration-seam.ts fail-open via `mem recall --hint-format` ───────────────────────────────────────────────────────────────────────────

describe("--hint-format fails open on internal error (integration-seam.ts, review S2/S3)", () => {
  it("returns a well-formed empty TGMEM payload and exit code 0 instead of throwing when the DB cannot be opened", async () => {
    // Point TOKEN_GOAT_MEM_HOME at a path that is a *file*, not a directory. `mem.db` would need to
    // live inside it, so opening the store fails internally -- exactly the class of failure
    // buildHintFormat's outer try/catch exists to absorb (never throws; caller's fail-open path never
    // has to special-case a thrown exception).
    const brokenHome = join(mkdtempSync(join(tmpdir(), "mem-cli-broken-")), "not-a-directory");
    writeFileSync(brokenHome, "this is a file, not a mem home directory");
    process.env["TOKEN_GOAT_MEM_HOME"] = brokenHome;

    try {
      const result = await runCli(["recall", "--hint-format", "--root", home]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("TGMEM/1\n");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(join(brokenHome, ".."), { recursive: true, force: true });
    }
  });

  it("--hint-format requires --root and rejects an empty one at the CLI boundary before touching storage", async () => {
    const missingRoot = await runCli(["recall", "--hint-format"]);
    expect(missingRoot.exitCode).toBe(1);
    expect(missingRoot.stderr).toContain("recall --hint-format requires --root <path>");

    const blankRoot = await runCli(["recall", "--hint-format", "--root", "   "]);
    expect(blankRoot.exitCode).toBe(1);
    expect(blankRoot.stderr).toContain("recall --hint-format requires --root <path>");
  });
});
