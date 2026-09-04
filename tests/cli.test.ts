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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { run } from "../src/cli.js";
import { openDb, resolveDbPath } from "../src/db.js";
import { deleteFact, insertFact, openStorage } from "../src/storage.js";
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

/** Extracts the fact id from the `remember` command's success line. The noun phrase is `<kind> fact` for every kind except `fact` itself, which collapses to one word rather than printing "fact fact" -- so the kind portion has to be optional here, not a required token. */
function extractRememberedId(result: CliResult): string {
  const match = /remembered (?:\S+ )?fact (\S+)/u.exec(result.stdout);
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
    // "(unverified, <month>)" tag. Default output no longer carries a per-line CTA (footer-ized).
    expect(recalled.stdout).toContain("stored pref (unverified,");
    expect(recalled.stdout).toContain("mem show <id> for detail; mem review to resolve contested/pending");

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

  it("mem edit rejects a malformed anchor the same way mem remember does", async () => {
    const created = await runCli(["remember", "uses pnpm not npm", "--kind", "preference", "--subject", "package-manager", "--value", "pnpm"]);
    const id = extractRememberedId(created);

    const edited = await runCli(["edit", id, "--anchor", "run-shell rm"]);
    expect(edited.exitCode).toBe(1);
    expect(edited.stderr).toContain("unknown predicate");

    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("anchor: (none)");
  });

  it("mem edit still rejects a file-contains anchor with a multi-word substring (CLI arity check is unchanged)", async () => {
    // The CLI-facing anchor-syntax arity check (capture.ts's validateAnchorSyntax) whitespace-splits
    // the anchor string, so a multi-word file-contains/file-not-contains substring is genuinely
    // ambiguous to parse from flat CLI input and must still be rejected here -- json-import's
    // exemption from this check (see exportImport.test.ts) does not extend to mem edit/mem remember,
    // which take the same kind of CLI-string input.
    const created = await runCli(["remember", "uses pnpm not npm", "--kind", "preference", "--subject", "package-manager", "--value", "pnpm"]);
    const id = extractRememberedId(created);

    const edited = await runCli(["edit", id, "--anchor", "file-contains path/to/file.txt multi word value"]);
    expect(edited.exitCode).toBe(1);
    expect(edited.stderr).toContain("expects");

    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("anchor: (none)");
  });

  it("mem edit rejects an over-length text the same way mem remember does", async () => {
    const created = await runCli(["remember", "short fact", "--kind", "fact"]);
    const id = extractRememberedId(created);

    const tooLong = "x".repeat(501);
    const edited = await runCli(["edit", id, "--text", tooLong]);
    expect(edited.exitCode).toBe(1);
    expect(edited.stderr).toContain("exceeds 500 characters");

    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("text: short fact");
  });

  it("a secret blocked by mem edit writes an edit_blocked_secret audit_log entry, same as capture", async () => {
    const created = await runCli(["remember", "short fact", "--kind", "fact"]);
    const id = extractRememberedId(created);

    const edited = await runCli(["edit", id, "--text", "deploy key is AKIAABCDEFGHIJKLMNOP"]);
    expect(edited.exitCode).toBe(1);
    expect(edited.stderr).toContain("secret");

    const db = openStorage(resolveDbPath());
    const events = (
      db.prepare("SELECT event FROM audit_log WHERE fact_id = ?").all(id) as { event: string }[]
    ).map((row) => row.event);
    db.close();
    expect(events).toContain("edit_blocked_secret");

    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("text: short fact");
  });

  it("edit/pin/forget each write their audit_log row atomically with the fact write on the normal path (mirrors 008f60b's json_import atomicity fix)", async () => {
    const created = await runCli(["remember", "audit row check", "--kind", "fact"]);
    const id = extractRememberedId(created);

    const edited = await runCli(["edit", id, "--text", "audit row check v2"]);
    expect(edited.exitCode).toBe(0);

    const pinned = await runCli(["pin", id]);
    expect(pinned.exitCode).toBe(0);

    const forgotten = await runCli(["forget", id]);
    expect(forgotten.exitCode).toBe(0);

    const db = openStorage(resolveDbPath());
    const events = (
      db.prepare("SELECT event FROM audit_log WHERE fact_id = ? ORDER BY rowid").all(id) as { event: string }[]
    ).map((row) => row.event);
    db.close();

    expect(events).toContain("edit");
    expect(events).toContain("pin");
    expect(events).toContain("forget");
  });

  it("mem edit rejects empty-string value (after trim)", async () => {
    const created = await runCli(["remember", "test fact", "--kind", "fact", "--subject", "x", "--value", "y"]);
    const id = extractRememberedId(created);

    const edited = await runCli(["edit", id, "--subject", "x", "--value", ""]);
    expect(edited.exitCode).toBe(1);
    expect(edited.stderr).toContain("value must not be empty");

    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("subject: x");
    expect(shown.stdout).toContain("value: y");
  });

  it("mem edit rejects empty-string subject (after trim)", async () => {
    const created = await runCli(["remember", "test fact", "--kind", "fact", "--subject", "x", "--value", "y"]);
    const id = extractRememberedId(created);

    const edited = await runCli(["edit", id, "--subject", "", "--value", "y"]);
    expect(edited.exitCode).toBe(1);
    expect(edited.stderr).toContain("subject must not be empty");

    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("subject: x");
    expect(shown.stdout).toContain("value: y");
  });

  it("mem edit rejects subject without matching value in patch (pairing violation)", async () => {
    const created = await runCli(["remember", "test fact", "--kind", "fact", "--subject", "x", "--value", "y"]);
    const id = extractRememberedId(created);

    // CLI enforces --subject and --value together, but test the validation directly via pattern
    const edited = await runCli(["edit", id, "--subject", "new_x", "--value", "y"]);
    expect(edited.exitCode).toBe(0); // This should succeed if both are provided
    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("subject: new_x");
    expect(shown.stdout).toContain("value: y");
  });

  it("mem edit allows valid subject/value pair", async () => {
    const created = await runCli(["remember", "test fact", "--kind", "fact", "--subject", "key1", "--value", "val1"]);
    const id = extractRememberedId(created);

    const edited = await runCli(["edit", id, "--subject", "key2", "--value", "val2"]);
    expect(edited.exitCode).toBe(0);
    expect(edited.stdout).toContain("edited");

    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("subject: key2");
    expect(shown.stdout).toContain("value: val2");
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
    expect(review.stdout).toContain("contested (ambiguous contradiction -- withheld from ground truth");
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
    expect(hintFormat.stdout.startsWith("TGMEM/2\n")).toBe(true);
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

  it("refuses to promote a fact that is not in a review-resolvable status", async () => {
    const remembered = await runCli(["remember", "already active", "--kind", "fact"]);
    const id = extractRememberedId(remembered);

    const result = await runCli(["review", "--promote", id]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`fact ${id} is not pending or contested (status=active)`);
  });

  it("review --promote and --reject each write their audit_log row atomically with the status write on the normal path", async () => {
    const db = openStorage(resolveDbPath());
    const promoteCandidate = captureSuggested(db, { text: "promote-audit candidate", kind: "fact", root: home }).fact;
    const rejectCandidate = captureSuggested(db, { text: "reject-audit candidate", kind: "fact", root: home }).fact;
    db.close();

    const promoted = await runCli(["review", "--promote", promoteCandidate.id]);
    expect(promoted.exitCode).toBe(0);

    const rejected = await runCli(["review", "--reject", rejectCandidate.id]);
    expect(rejected.exitCode).toBe(0);

    const dbAfter = openStorage(resolveDbPath());
    const promoteEvents = (
      dbAfter.prepare("SELECT event FROM audit_log WHERE fact_id = ?").all(promoteCandidate.id) as { event: string }[]
    ).map((row) => row.event);
    const rejectEvents = (
      dbAfter.prepare("SELECT event FROM audit_log WHERE fact_id = ?").all(rejectCandidate.id) as { event: string }[]
    ).map((row) => row.event);
    dbAfter.close();

    expect(promoteEvents).toContain("review_promote");
    expect(rejectEvents).toContain("review_reject");
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

  it("warns in --subject help that a subject holds one value, on every command that accepts it", async () => {
    // The invariant is real but silent otherwise: a second --value against the same subject
    // supersedes the first instead of joining it, and the user finds out by losing the first one.
    // Asserted on both commands because a reader consults the help of whichever they are running,
    // and asserted on the behaviour word ("supersedes") rather than the whole sentence so rewording
    // stays free while deleting the warning does not.
    for (const command of ["remember", "suggest"]) {
      const help = await runCli([command, "--help"]);
      expect(help.exitCode).toBe(0);
      // Commander hard-wraps option descriptions to the terminal width, so the phrase arrives split
      // across lines and padded. Collapse whitespace before matching -- asserting on the raw string
      // would pin the wrap column, which is an artifact of the reader's terminal, not of mem.
      const flowed = help.stdout.replace(/\s+/g, " ");
      expect(flowed).toMatch(/holds one value at a time/i);
      expect(flowed).toMatch(/supersedes/i);
    }
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
      expect(result.stdout).toBe("TGMEM/2\n");
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

  it("--hint-format rejects incompatible filter options (--kind, --subject, --scope, --age-days, --limit, --since-epoch)", async () => {
    // --hint-format with --kind should fail
    const withKind = await runCli(["recall", "--hint-format", "--root", home, "--kind", "decision"]);
    expect(withKind.exitCode).toBe(1);
    expect(withKind.stderr).toContain("--hint-format cannot be combined with --kind");

    // --hint-format with --subject should fail
    const withSubject = await runCli(["recall", "--hint-format", "--root", home, "--subject", "foo"]);
    expect(withSubject.exitCode).toBe(1);
    expect(withSubject.stderr).toContain("--hint-format cannot be combined with --subject");

    // --hint-format with --scope should fail
    const withScope = await runCli(["recall", "--hint-format", "--root", home, "--scope", "file"]);
    expect(withScope.exitCode).toBe(1);
    expect(withScope.stderr).toContain("--hint-format cannot be combined with --scope");

    // --hint-format with --limit should fail
    const withLimit = await runCli(["recall", "--hint-format", "--root", home, "--limit", "10"]);
    expect(withLimit.exitCode).toBe(1);
    expect(withLimit.stderr).toContain("--hint-format cannot be combined with --limit");

    // --hint-format with --age-days should fail
    const withAgeDays = await runCli(["recall", "--hint-format", "--root", home, "--age-days", "7"]);
    expect(withAgeDays.exitCode).toBe(1);
    expect(withAgeDays.stderr).toContain("--hint-format cannot be combined with --age-days");

    // --hint-format with --since-epoch should fail
    const withSinceEpoch = await runCli(["recall", "--hint-format", "--root", home, "--since-epoch", "123"]);
    expect(withSinceEpoch.exitCode).toBe(1);
    expect(withSinceEpoch.stderr).toContain("--hint-format cannot be combined with --since-epoch");

    // --hint-format alone (or with allowed options like --context-files, --stable, --hint-style) should still work
    // We already test the basic case above, and the next test should cover this working case.
  });

  it("--hint-format honors a positional query, reordering the emitted lines by relevance instead of pure recency", async () => {
    // Explicit captured_at timestamps (not two back-to-back `remember` calls) so the recency
    // ordering this test pins is deterministic rather than a race against millisecond clock
    // resolution. Older fact mentions "giraffe" nowhere; newer fact is the only one containing
    // "oranges". Bare (query-less) --hint-format has no ranking signal and falls through to
    // recency, so the newer "oranges" fact already leads -- to prove the query is what reorders
    // (not recency doing it by coincidence), query for a term only the *older* fact contains, and
    // assert the older fact now leads despite being less recent.
    const db = openStorage(resolveDbPath());
    insertFact(db, {
      text: "older fact about a distinctive giraffe topic",
      kind: "fact",
      scope: "global",
      source_type: "user",
      captured_at: "2020-01-01T00:00:00.000Z",
    });
    insertFact(db, {
      text: "unrelated newer fact about oranges",
      kind: "fact",
      scope: "global",
      source_type: "user",
      captured_at: "2020-01-02T00:00:00.000Z",
    });
    db.close();

    const bare = await runCli(["recall", "--hint-format", "--root", home]);
    expect(bare.exitCode).toBe(0);
    const bareOranges = bare.stdout.indexOf("oranges");
    const bareGiraffe = bare.stdout.indexOf("giraffe");
    expect(bareOranges).toBeGreaterThanOrEqual(0);
    expect(bareGiraffe).toBeGreaterThanOrEqual(0);
    // Recency-only: the newer "oranges" fact leads the older "giraffe" fact.
    expect(bareOranges).toBeLessThan(bareGiraffe);

    const queried = await runCli(["recall", "giraffe", "--hint-format", "--root", home]);
    expect(queried.exitCode).toBe(0);
    const queriedOranges = queried.stdout.indexOf("oranges");
    const queriedGiraffe = queried.stdout.indexOf("giraffe");
    expect(queriedOranges).toBeGreaterThanOrEqual(0);
    expect(queriedGiraffe).toBeGreaterThanOrEqual(0);
    // Querying "giraffe" reorders: the matching (older) fact now leads the non-matching newer one.
    expect(queriedGiraffe).toBeLessThan(queriedOranges);
  });

  it("--hint-format with an absent or empty query is byte-identical to today's recency-only output", async () => {
    const db = openStorage(resolveDbPath());
    insertFact(db, { text: "unrelated newer fact about oranges", kind: "fact", scope: "global", source_type: "user" });
    insertFact(db, { text: "older fact about a distinctive giraffe topic", kind: "fact", scope: "global", source_type: "user" });
    db.close();

    const absent = await runCli(["recall", "--hint-format", "--root", home]);
    const empty = await runCli(["recall", "", "--hint-format", "--root", home]);
    expect(absent.exitCode).toBe(0);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toBe(absent.stdout);
  });

  it("--hint-format query matching no fact text ranks (ties at 0), never filters", async () => {
    const db = openStorage(resolveDbPath());
    insertFact(db, { text: "fact about apples", kind: "fact", scope: "global", source_type: "user" });
    insertFact(db, { text: "fact about bananas", kind: "fact", scope: "global", source_type: "user" });
    db.close();

    const bare = await runCli(["recall", "--hint-format", "--root", home]);
    const noMatch = await runCli(["recall", "zzzz nonexistent xyzzy", "--hint-format", "--root", home]);
    expect(noMatch.exitCode).toBe(0);
    // Same set of lines either way -- a query that matches nothing reorders, it never removes.
    expect([...noMatch.stdout.split("\n")].sort()).toEqual([...bare.stdout.split("\n")].sort());
  });

  it("--hint-format with allowed options (--context-files, --stable, --hint-style) still works", async () => {
    // This should not fail; we're testing that the allowed options don't trigger the incompatibility error
    // In this test home is already set from the outer describe block, and the DB is populated from prior tests
    const withStable = await runCli(["recall", "--hint-format", "--root", home, "--stable"]);
    expect(withStable.exitCode).toBe(0);
    expect(withStable.stdout).toMatch(/^TGMEM\/2\n/);
  });

  it("--context-files without --hint-format throws an error", async () => {
    // --context-files requires --hint-format to function
    const withoutHintFormat = await runCli(["recall", "--context-files", "file.ts"]);
    expect(withoutHintFormat.exitCode).toBe(1);
    expect(withoutHintFormat.stderr).toContain("--context-files requires --hint-format");
  });

  it("--context-files with --hint-format and --root still works", async () => {
    // This should not fail; we're testing that --context-files works correctly with --hint-format
    const withContextFiles = await runCli(["recall", "--hint-format", "--root", home, "--context-files", "src/cli.ts"]);
    expect(withContextFiles.exitCode).toBe(0);
    expect(withContextFiles.stdout).toMatch(/^TGMEM\/2\n/);
  });
});

// ─────────────────────────────────────────────────────────────────────────── recall --stable ───────────────────────────────────────────────────────────────────────────

describe("recall --stable (deterministic id-sorted ordering, strictly additive)", () => {
  it("sorts plain `mem recall` output by fact id ascending instead of recency", async () => {
    // Default (full) recall output no longer embeds an id in a per-line CTA (footer-ized, Section 4),
    // so ids are captured from `remember`'s own success line and matched back to each fact's line by
    // its distinguishing text, rather than regex-extracted from recall's display text.
    const idEarlier = extractRememberedId(await runCli(["remember", "captured earlier", "--kind", "fact"]));
    const idLater = extractRememberedId(await runCli(["remember", "captured later", "--kind", "fact"]));

    const defaultOrder = await runCli(["recall"]);
    const stableOrder = await runCli(["recall", "--stable"]);

    // Same set of lines either way -- --stable only changes ordering, never which facts are included.
    expect([...stableOrder.stdout.split("\n")].sort()).toEqual([...defaultOrder.stdout.split("\n")].sort());

    const textToId: ReadonlyMap<string, string> = new Map([
      ["captured earlier", idEarlier],
      ["captured later", idLater],
    ]);
    const ids = stableOrder.stdout
      .split("\n")
      .map((line) => [...textToId.entries()].find(([text]) => line.includes(text))?.[1])
      .filter((id): id is string => id !== undefined);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual([idEarlier, idLater].sort());
  });

  it("does not print an anchor-budget note for an ordinary small-store `mem recall`", async () => {
    // The message text itself (and the count) is covered directly against `retrieve()`'s
    // `anchorBudgetHits` in tests/unit/retrieval.test.ts, since there is no CLI flag to force the
    // anchor deadline low enough to reproduce a real budget hit here. This only pins the negative:
    // a normal store small enough to finish every anchor within the default budget stays silent.
    await runCli(["remember", "captured just now", "--kind", "fact"]);
    const result = await runCli(["recall"]);
    expect(result.stdout).not.toContain("anchor budget exhausted");
  });

  it("sorts `mem recall --hint-format --stable` fact-lines by fact id ascending", async () => {
    await runCli(["remember", "fact z", "--kind", "fact", "--scope", "global"]);
    await runCli(["remember", "fact a", "--kind", "fact", "--scope", "global"]);

    const result = await runCli(["recall", "--hint-format", "--root", home, "--stable"]);
    expect(result.exitCode).toBe(0);
    const ids = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("fact  "))
      .map((line) => /id=(\S+)/.exec(line)?.[1] ?? "");
    expect([...ids].sort()).toEqual(ids);
  });
});

// ─────────────────────────────────────────────────────────────────────────── recall --hint-style ───────────────────────────────────────────────────────────────────────────

describe("recall --hint-style full|terse", () => {
  it("defaults to full (byte-identical to omitting the flag), with the per-line CTA replaced by one trailing footer", async () => {
    await runCli(["remember", "chose Postgres over Mongo", "--kind", "decision"]);
    const defaulted = await runCli(["recall"]);
    const explicitFull = await runCli(["recall", "--hint-style", "full"]);
    expect(explicitFull.stdout).toBe(defaulted.stdout);
    expect(defaulted.stdout).toContain("stored decision (unverified,");
    // Section 4: default output drops the per-line CTA in favor of one trailing footer line.
    expect(defaulted.stdout).not.toContain("—");
    const lines = defaulted.stdout.split("\n").filter((line) => line.length > 0);
    expect(lines.at(-1)).toBe("mem show <id> for detail; mem review to resolve contested/pending");
    expect(lines.filter((line) => line === "mem show <id> for detail; mem review to resolve contested/pending")).toHaveLength(1);
  });

  it("terse drops the CTA and shortens the kind label", async () => {
    await runCli(["remember", "chose Postgres over Mongo", "--kind", "decision"]);
    const terse = await runCli(["recall", "--hint-style", "terse"]);
    expect(terse.exitCode).toBe(0);
    expect(terse.stdout).toContain("stored dec (unverified,");
    expect(terse.stdout).toContain("chose Postgres over Mongo");
    expect(terse.stdout).not.toContain("mem show");
    expect(terse.stdout).not.toContain("decision");
  });

  it("rejects an invalid --hint-style value at the CLI boundary", async () => {
    const result = await runCli(["recall", "--hint-style", "verbose"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid --hint-style "verbose"');
  });
});

// ─────────────────────────────────────────────────────────────────────────── review --summary / --section / --since-epoch ───────────────────────────────────────────────────────────────────────────

describe("review --summary, --section, --since-epoch", () => {
  it("--summary prints counts per bucket instead of full listings", async () => {
    const db = openStorage(resolveDbPath());
    captureSuggested(db, { text: "a pending candidate", kind: "fact", root: home });
    db.close();

    const result = await runCli(["review", "--summary"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("pending: 1, contested: 0, contradicted: 0, pins: 0, unanchored: 0");
  });

  it("--section restricts the full listing to a single bucket", async () => {
    const db = openStorage(resolveDbPath());
    captureSuggested(db, { text: "a pending candidate", kind: "fact", root: home });
    db.close();

    const result = await runCli(["review", "--section", "pending"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pending (never auto-promoted -- confirm with --promote/--reject)");
    expect(result.stdout).not.toContain("contested (ambiguous contradiction");
    expect(result.stdout).not.toContain("anchor-contradicted");
    expect(result.stdout).not.toContain("pins due for re-confirmation");
  });

  it("rejects an invalid --section value at the CLI boundary", async () => {
    const result = await runCli(["review", "--section", "bogus"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid --section "bogus"');
  });

  it("--since-epoch only includes facts written after the given epoch", async () => {
    const dbBefore = openStorage(resolveDbPath());
    captureSuggested(dbBefore, { text: "captured before the cutoff", kind: "fact", root: home });
    dbBefore.close();

    const cutoff = await runCli(["epoch"]);
    const cutoffEpoch = cutoff.stdout.trim();

    const dbAfter = openStorage(resolveDbPath());
    captureSuggested(dbAfter, { text: "captured after the cutoff", kind: "fact", root: home });
    dbAfter.close();

    const summarySinceCutoff = await runCli(["review", "--summary", "--since-epoch", cutoffEpoch]);
    expect(summarySinceCutoff.stdout.trim()).toBe("pending: 1, contested: 0, contradicted: 0, pins: 0, unanchored: 0");

    const fullSinceCutoff = await runCli(["review", "--section", "pending", "--since-epoch", cutoffEpoch]);
    expect(fullSinceCutoff.stdout).toContain("captured after the cutoff");
    expect(fullSinceCutoff.stdout).not.toContain("captured before the cutoff");

    const summaryFromZero = await runCli(["review", "--summary", "--since-epoch", "0"]);
    expect(summaryFromZero.stdout.trim()).toBe("pending: 2, contested: 0, contradicted: 0, pins: 0, unanchored: 0");
  });
});

// ─────────────────────────────────────────────────────────────────────────── review --section unanchored ───────────────────────────────────────────────────────────────────────────

describe("review unanchored bucket (environment-dependent facts nobody can verify)", () => {
  it("nominates an active, anchorless fact whose text names a checkable path", async () => {
    const created = await runCli(["remember", "the entry point is src/main.ts", "--kind", "fact"]);
    expect(created.exitCode).toBe(0);

    const summary = await runCli(["review", "--summary"]);
    expect(summary.stdout.trim()).toBe("pending: 0, contested: 0, contradicted: 0, pins: 0, unanchored: 1");

    const listing = await runCli(["review", "--section", "unanchored"]);
    expect(listing.exitCode).toBe(0);
    expect(listing.stdout).toContain("unanchored but checkable");
    expect(listing.stdout).toContain("the entry point is src/main.ts");
  });

  it("does not nominate a fact that already carries an anchor", async () => {
    const created = await runCli([
      "remember",
      "the entry point is src/main.ts",
      "--kind",
      "fact",
      "--anchor",
      "file-exists src/main.ts",
    ]);
    expect(created.exitCode).toBe(0);

    const summary = await runCli(["review", "--summary"]);
    expect(summary.stdout.trim()).toContain("unanchored: 0");
  });

  it("does not nominate a preference, even when it names a path (judgment claims are not environment-checkable)", async () => {
    const created = await runCli(["remember", "always edit src/main.ts with tabs", "--kind", "preference"]);
    expect(created.exitCode).toBe(0);

    const summary = await runCli(["review", "--summary"]);
    expect(summary.stdout.trim()).toContain("unanchored: 0");
  });

  it("does not nominate an anchorless fact whose text names nothing checkable", async () => {
    const created = await runCli(["remember", "the team prefers trunk-based development", "--kind", "fact"]);
    expect(created.exitCode).toBe(0);

    const summary = await runCli(["review", "--summary"]);
    expect(summary.stdout.trim()).toBe("pending: 0, contested: 0, contradicted: 0, pins: 0, unanchored: 0");
  });

  it("does not double-list a pending fact -- the pending bucket already owns it", async () => {
    const db = openStorage(resolveDbPath());
    captureSuggested(db, { text: "the config lives in package.json", kind: "fact", root: home });
    db.close();

    const summary = await runCli(["review", "--summary"]);
    expect(summary.stdout.trim()).toBe("pending: 1, contested: 0, contradicted: 0, pins: 0, unanchored: 0");
  });

  it("accepts unanchored as a --section value and shows only that bucket", async () => {
    const db = openStorage(resolveDbPath());
    captureSuggested(db, { text: "a pending candidate", kind: "fact", root: home });
    db.close();
    await runCli(["remember", "the manifest is package.json", "--kind", "decision"]);

    const listing = await runCli(["review", "--section", "unanchored"]);
    expect(listing.exitCode).toBe(0);
    expect(listing.stdout).toContain("the manifest is package.json");
    expect(listing.stdout).not.toContain("a pending candidate");
    expect(listing.stdout).not.toContain("never auto-promoted");
  });

  it("nominates a correction the same way it nominates a fact", async () => {
    await runCli(["remember", "the lockfile is actually pnpm-lock.yaml", "--kind", "correction"]);

    const summary = await runCli(["review", "--summary"]);
    expect(summary.stdout.trim()).toContain("unanchored: 1");
  });
});

// ─────────────────────────────────────────────────────────────────────────── recall --since-epoch ───────────────────────────────────────────────────────────────────────────

describe("recall --since-epoch", () => {
  it("excludes facts written at or before the given epoch, mirroring review --since-epoch", async () => {
    const dbBefore = openStorage(resolveDbPath());
    insertFact(dbBefore, { text: "captured before the cutoff", kind: "fact", scope: "global", source_type: "user" });
    dbBefore.close();

    const cutoff = await runCli(["epoch"]);
    const cutoffEpoch = cutoff.stdout.trim();

    const dbAfter = openStorage(resolveDbPath());
    insertFact(dbAfter, { text: "captured after the cutoff", kind: "fact", scope: "global", source_type: "user" });
    dbAfter.close();

    const sinceCutoff = await runCli(["recall", "--since-epoch", cutoffEpoch]);
    expect(sinceCutoff.stdout).toContain("captured after the cutoff");
    expect(sinceCutoff.stdout).not.toContain("captured before the cutoff");

    const fromZero = await runCli(["recall", "--since-epoch", "0"]);
    expect(fromZero.stdout).toContain("captured after the cutoff");
    expect(fromZero.stdout).toContain("captured before the cutoff");
  });
});

// ─────────────────────────────────────────────────────────────────────────── short id prefixes ───────────────────────────────────────────────────────────────────────────

describe("short id prefixes (git-style, all 6 id-accepting commands)", () => {
  function seedFactWithId(id: string, overrides: { readonly status?: "active" | "pending" } = {}): void {
    const db = openStorage(resolveDbPath());
    insertFact(db, {
      id,
      text: `fact ${id}`,
      kind: "fact",
      scope: "global",
      source_type: "user",
      ...(overrides.status !== undefined ? { status: overrides.status } : {}),
    });
    db.close();
  }

  it("show/forget/pin/edit accept a unique short prefix (>= 4 chars)", async () => {
    seedFactWithId("aaaa1111-0000-0000-0000-000000000001");

    const shown = await runCli(["show", "aaaa1111"]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("id: aaaa1111-0000-0000-0000-000000000001");

    const edited = await runCli(["edit", "aaaa1111", "--text", "edited via prefix"]);
    expect(edited.exitCode).toBe(0);
    expect(edited.stdout).toBe("edited aaaa1111-0000-0000-0000-000000000001\n");

    const pinned = await runCli(["pin", "aaaa1111"]);
    expect(pinned.exitCode).toBe(0);
    expect(pinned.stdout).toBe("pinned aaaa1111-0000-0000-0000-000000000001\n");

    const forgotten = await runCli(["forget", "aaaa1111"]);
    expect(forgotten.exitCode).toBe(0);
    expect(forgotten.stdout).toBe("forgot aaaa1111-0000-0000-0000-000000000001\n");
  });

  it("review --promote/--reject accept a unique short prefix and echo the resolved full id, not the raw prefix", async () => {
    seedFactWithId("bbbb1111-0000-0000-0000-000000000001", { status: "pending" });
    const promoted = await runCli(["review", "--promote", "bbbb1111"]);
    expect(promoted.exitCode).toBe(0);
    expect(promoted.stdout).toBe("promoted bbbb1111-0000-0000-0000-000000000001\n");
    const afterPromote = await runCli(["show", "bbbb1111"]);
    expect(afterPromote.stdout).toContain("status: active");

    seedFactWithId("cccc1111-0000-0000-0000-000000000001", { status: "pending" });
    const rejected = await runCli(["review", "--reject", "cccc1111"]);
    expect(rejected.exitCode).toBe(0);
    expect(rejected.stdout).toBe("rejected cccc1111-0000-0000-0000-000000000001\n");
    const afterReject = await runCli(["show", "cccc1111"]);
    expect(afterReject.stdout).toContain("status: superseded");
  });
  it("rejects an ambiguous prefix with every match listed, on all 6 commands", async () => {
    seedFactWithId("dddd1111-0000-0000-0000-000000000001");
    seedFactWithId("dddd2222-0000-0000-0000-000000000002");

    const expectAmbiguous = (result: CliResult): void => {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('ambiguous id prefix "dddd"');
      expect(result.stderr).toContain("dddd1111-0000-0000-0000-000000000001");
      expect(result.stderr).toContain("dddd2222-0000-0000-0000-000000000002");
      expect(result.stderr).toContain("use more characters");
    };

    expectAmbiguous(await runCli(["show", "dddd"]));
    expectAmbiguous(await runCli(["forget", "dddd"]));
    expectAmbiguous(await runCli(["pin", "dddd"]));
    expectAmbiguous(await runCli(["edit", "dddd", "--text", "x"]));
    expectAmbiguous(await runCli(["review", "--promote", "dddd"]));
    expectAmbiguous(await runCli(["review", "--reject", "dddd"]));
  });

  it("preserves the exact existing 'no such fact' error text for an unresolvable id", async () => {
    const result = await runCli(["show", "does-not-exist"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mem: no such fact: does-not-exist");
  });
});

// ─────────────────────────────────────────────────────────────────────────── default limits on list/recall ───────────────────────────────────────────────────────────────────────────

describe("default limits on mem list / mem recall (never hiding pending/contested/superseded/contradicted)", () => {
  /** Seeds `count` distinct active facts with strictly increasing `captured_at` (newest last), so `mem list`/`mem recall`'s default newest-first ordering is deterministic. */
  function seedManyActiveFacts(count: number): void {
    const db = openStorage(resolveDbPath());
    for (let i = 0; i < count; i += 1) {
      insertFact(db, {
        text: `seeded active fact number ${i}`,
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: new Date(2026, 0, 1, 0, i).toISOString(),
      });
    }
    db.close();
  }

  it("mem list caps at the default limit and prints a trailer when truncated", async () => {
    seedManyActiveFacts(25);
    const result = await runCli(["list"]);
    expect(result.exitCode).toBe(0);
    const factLines = result.stdout.split("\n").filter((line) => line.includes("seeded active fact number"));
    expect(factLines).toHaveLength(20);
    expect(result.stdout).toContain("showing 20 of 25 -- use --limit to see more");
  });

  it("mem list --json reflects the same slice plus total/truncated fields", async () => {
    seedManyActiveFacts(25);
    const result = await runCli(["list", "--json"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as { facts: unknown[]; total: number; truncated: boolean };
    expect(envelope.facts).toHaveLength(20);
    expect(envelope.total).toBe(25);
    expect(envelope.truncated).toBe(true);
  });

  it("mem list --limit overrides the default", async () => {
    seedManyActiveFacts(25);
    const result = await runCli(["list", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    const factLines = result.stdout.split("\n").filter((line) => line.includes("seeded active fact number"));
    expect(factLines).toHaveLength(5);
    expect(result.stdout).toContain("showing 5 of 25 -- use --limit to see more");
  });

  it("mem recall caps non-withheld results at the default limit and prints a trailer when truncated", async () => {
    seedManyActiveFacts(25);
    const result = await runCli(["recall"]);
    expect(result.exitCode).toBe(0);
    const factLines = result.stdout.split("\n").filter((line) => line.includes("seeded active fact number"));
    expect(factLines).toHaveLength(20);
    expect(result.stdout).toContain("showing 20 of 25 -- use --limit to see more");
  });

  it("never hides a pending fact behind the default recall limit, even with 20+ higher-ranked active facts ahead of it", async () => {
    // The pending fact is captured first (oldest, so it would rank dead last in default
    // newest-first ordering) -- if the default cap applied uniformly instead of exempting withheld
    // results, it would never appear in the default (uncapped-for-pending) output.
    const db = openStorage(resolveDbPath());
    insertFact(db, {
      text: "a pending candidate fact",
      kind: "fact",
      scope: "global",
      source_type: "user",
      status: "pending",
      captured_at: new Date(2020, 0, 1).toISOString(),
    });
    db.close();
    seedManyActiveFacts(22);

    const result = await runCli(["recall"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("a pending candidate fact");
    expect(result.stdout).toContain("(pending, unconfirmed)");
    // 22 non-withheld facts matched; only 20 are shown by default -- the trailer reflects that,
    // and it excludes the pending fact from both totals (it is never subject to the cap at all).
    expect(result.stdout).toContain("showing 20 of 22 -- use --limit to see more");
  });

  it("rejects a negative --limit on mem list and mem recall instead of silently slicing off the tail", async () => {
    seedManyActiveFacts(5);

    const listResult = await runCli(["list", "--limit", "-5"]);
    expect(listResult.exitCode).toBe(1);
    expect(listResult.stderr).toContain("--limit must be a positive integer");

    const recallResult = await runCli(["recall", "--limit", "0"]);
    expect(recallResult.exitCode).toBe(1);
    expect(recallResult.stderr).toContain("--limit must be a positive integer");
  });

  it("rejects non-numeric values for --age-days and --since-epoch instead of silently discarding NaN", async () => {
    seedManyActiveFacts(5);

    // Invalid --age-days
    const ageDaysInvalid = await runCli(["recall", "--age-days", "abc"]);
    expect(ageDaysInvalid.exitCode).toBe(1);
    expect(ageDaysInvalid.stderr).toContain("--age-days must be a positive number");

    // Invalid --since-epoch
    const sinceEpochInvalid = await runCli(["recall", "--since-epoch", "abc"]);
    expect(sinceEpochInvalid.exitCode).toBe(1);
    expect(sinceEpochInvalid.stderr).toContain("--since-epoch must be a non-negative integer");

    // Invalid --since-epoch in review
    const reviewSinceEpochInvalid = await runCli(["review", "--since-epoch", "xyz"]);
    expect(reviewSinceEpochInvalid.exitCode).toBe(1);
    expect(reviewSinceEpochInvalid.stderr).toContain("--since-epoch must be a non-negative integer");

    // Negative --age-days
    const ageDaysNegative = await runCli(["recall", "--age-days", "-1"]);
    expect(ageDaysNegative.exitCode).toBe(1);
    expect(ageDaysNegative.stderr).toContain("--age-days must be a positive number");

    // Negative --since-epoch
    const sinceEpochNegative = await runCli(["recall", "--since-epoch", "-1"]);
    expect(sinceEpochNegative.exitCode).toBe(1);
    expect(sinceEpochNegative.stderr).toContain("--since-epoch must be a non-negative integer");

    // Zero --age-days (not valid for "within N days")
    const ageDaysZero = await runCli(["recall", "--age-days", "0"]);
    expect(ageDaysZero.exitCode).toBe(1);
    expect(ageDaysZero.stderr).toContain("--age-days must be a positive number");

    // Zero --since-epoch is valid (can filter from epoch 0)
    const sinceEpochZero = await runCli(["recall", "--since-epoch", "0"]);
    expect(sinceEpochZero.exitCode).toBe(0);

    // Positive values should work
    const ageDaysValid = await runCli(["recall", "--age-days", "30"]);
    expect(ageDaysValid.exitCode).toBe(0);

    const sinceEpochValid = await runCli(["recall", "--since-epoch", "100"]);
    expect(sinceEpochValid.exitCode).toBe(0);

    const reviewSinceEpochValid = await runCli(["review", "--since-epoch", "50"]);
    expect(reviewSinceEpochValid.exitCode).toBe(0);
  });
});
// ─────────────────────────────────────────────────────────────────────────── import --from-md ───────────────────────────────────────────────────────────────────────────

describe("import --from-md (advisory CLAUDE.md -> mem migration, S9 trust path)", () => {
  function writeFixture(contents: string): string {
    const path = join(home, "CLAUDE.md");
    writeFileSync(path, contents, "utf8");
    return path;
  }

  it("imports qualifying bullets as pending facts, confirmable only via `mem review --promote`", async () => {
    const path = writeFixture(["## Preferences", "- Always use pnpm, never npm.", "- Prefer tabs over spaces."].join("\n"));

    const result = await runCli(["import", "--from-md", path, "--root", home]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("imported 2 of 2 candidate fact(s)");
    expect(result.stdout).toContain("never auto-promoted -- confirm each via `mem review --promote <id>`");

    const listed = await runCli(["list", "--status", "pending"]);
    expect(listed.stdout).toContain("Always use pnpm, never npm.");
    expect(listed.stdout).toContain("Prefer tabs over spaces.");
    expect(listed.stdout).not.toContain("[preference/active]");

    const summary = await runCli(["review", "--summary"]);
    expect(summary.stdout.trim()).toBe("pending: 2, contested: 0, contradicted: 0, pins: 0, unanchored: 0");
  });

  it("skips non-bullet content", async () => {
    const path = writeFixture(["Just a paragraph.", "", "Another sentence, no bullets here."].join("\n"));

    const result = await runCli(["import", "--from-md", path, "--root", home]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no qualifying bullets found");

    const listed = await runCli(["list"]);
    expect(listed.stdout.trim()).toBe("no facts stored");
  });

  it("--from-md --scope path --path <file> binds every imported bullet to that file", async () => {
    const path = writeFixture(["- auth.ts owns migrations."].join("\n"));

    const result = await runCli(["import", "--from-md", path, "--root", home, "--scope", "path", "--path", "src/auth.ts"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("imported 1 of 1 candidate fact(s)");

    const listed = await runCli(["list", "--status", "pending", "--json"]);
    const envelope = JSON.parse(listed.stdout) as { facts: readonly { scopeRoot: string | null }[] };
    expect(envelope.facts[0]?.scopeRoot).toBe(join(home, "src", "auth.ts"));
  });

  it("--from-md --scope path without --path exits 1 with a pinned message", async () => {
    const path = writeFixture(["- auth.ts owns migrations."].join("\n"));

    const result = await runCli(["import", "--from-md", path, "--root", home, "--scope", "path"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--scope path requires --path <file-or-dir>");
  });

  it("--dry-run reports candidates without writing any facts", async () => {
    const path = writeFixture(["- Always use pnpm, never npm."].join("\n"));

    const result = await runCli(["import", "--from-md", path, "--root", home, "--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("would import 1 candidate fact(s)");
    expect(result.stdout).toContain("nothing written");

    // Regression: --dry-run previously routed through openDb (mkdir + schema init) even though it
    // never wrote a fact, so it silently created mem.db despite claiming not to write anything.
    expect(existsSync(join(home, "mem.db"))).toBe(false);

    const listed = await runCli(["list"]);
    expect(listed.stdout.trim()).toBe("no facts stored");
  });

  it("re-importing the same file does not create duplicate facts", async () => {
    const path = writeFixture(["- Always use pnpm, never npm."].join("\n"));

    const first = await runCli(["import", "--from-md", path, "--root", home]);
    expect(first.stdout).toContain("imported 1 of 1 candidate fact(s)");

    const second = await runCli(["import", "--from-md", path, "--root", home]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("imported 0 of 1 candidate fact(s)");
    expect(second.stdout).toContain("skipped (duplicate)");

    const summary = await runCli(["review", "--summary"]);
    expect(summary.stdout.trim()).toBe("pending: 1, contested: 0, contradicted: 0, pins: 0, unanchored: 0");
  });

  it("promoting an imported fact goes through the exact same `mem review --promote` path as any other pending fact", async () => {
    const path = writeFixture(["- Always use pnpm, never npm."].join("\n"));
    const imported = await runCli(["import", "--from-md", path, "--root", home]);
    const match = /imported\s+\S+\s+(\S+)\s+"/u.exec(imported.stdout);
    expect(match?.[1]).toBeDefined();
    const id = match?.[1] ?? "";

    const promoted = await runCli(["review", "--promote", id]);
    expect(promoted.exitCode).toBe(0);
    expect(promoted.stdout.trim()).toBe(`promoted ${id}`);

    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("status: active");
  });

  it("exits with code 1 (user error) when the --from-md file does not exist", async () => {
    const result = await runCli(["import", "--from-md", "/nonexistent/path/CLAUDE.md"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mem: ");
    expect(result.stderr).toContain("file not found");
  });

  it("exits with code 1 (user error) when the --from-md path is a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-import-dir-"));
    try {
      const result = await runCli(["import", "--from-md", dir]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("mem: ");
      expect(result.stderr).toContain("is a directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires exactly one of --from-md or --from-json", async () => {
    // Neither flag given.
    const neither = await runCli(["import"]);
    expect(neither.exitCode).toBe(1);
    expect(neither.stderr).toContain("requires exactly one of --from-md or --from-json");

    // Both flags given.
    const path = writeFixture(["- Always use pnpm, never npm."].join("\n"));
    const both = await runCli(["import", "--from-md", path, "--from-json", path, "--root", home]);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("requires exactly one of --from-md or --from-json");
  });
});

// ─────────────────────────────────────────────────────────────────────────── mem suggest ───────────────────────────────────────────────────────────────────────────

describe("mem suggest (suggested/candidate capture, S9 trust path)", () => {
  it("stores a pending fact, confirmable only via `mem review --promote`", async () => {
    const result = await runCli(["suggest", "consider using vitest workspaces", "--kind", "preference"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^suggested preference fact \S+ \(pending\)\n$/u);

    const match = /suggested \S+ fact (\S+) \(pending\)/u.exec(result.stdout);
    const id = match?.[1];
    expect(id).toBeDefined();

    const pendingList = await runCli(["list", "--status", "pending"]);
    expect(pendingList.exitCode).toBe(0);
    expect(pendingList.stdout).toContain(id as string);
    expect(pendingList.stdout).toContain("[preference/pending]");

    const activeList = await runCli(["list", "--status", "active"]);
    expect(activeList.stdout).not.toContain(id as string);

    const summary = await runCli(["review", "--summary"]);
    expect(summary.stdout.trim()).toBe("pending: 1, contested: 0, contradicted: 0, pins: 0, unanchored: 0");
  });

  it("rejects a malformed anchor the same way mem remember does", async () => {
    const result = await runCli(["suggest", "bogus", "--kind", "fact", "--anchor", "run-shell rm"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown predicate");

    const listed = await runCli(["list"]);
    expect(listed.stdout.trim()).toBe("no facts stored");
  });

  it("rejects an over-length text the same way mem remember does", async () => {
    const tooLong = "x".repeat(501);
    const result = await runCli(["suggest", tooLong, "--kind", "fact"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("exceeds 500 characters");

    const listed = await runCli(["list"]);
    expect(listed.stdout.trim()).toBe("no facts stored");
  });
});

// ─────────────────────────────────────────────────────────────────────────── mem export / mem import --from-json ───────────────────────────────────────────────────────────────────────────

interface ExportedFact {
  readonly id: string;
  readonly text: string;
  readonly kind: string;
  readonly status: string;
  readonly confidence: number;
  readonly captured_at: string;
}

interface ExportEnvelope {
  readonly schemaVersion: number;
  readonly exportedAt: string;
  readonly facts: readonly ExportedFact[];
}

describe("mem export", () => {
  it("exports schemaVersion 1, a valid exportedAt, and every seeded fact across statuses", async () => {
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
    const activeId = extractRememberedId(remembered);

    const suggested = await runCli(["suggest", "maybe prefers dark mode", "--kind", "preference"]);
    const pendingId = /suggested \S+ fact (\S+) \(pending\)/u.exec(suggested.stdout)?.[1] as string;

    const exported = await runCli(["export"]);
    expect(exported.exitCode).toBe(0);

    const envelope = JSON.parse(exported.stdout) as ExportEnvelope;
    expect(envelope.schemaVersion).toBe(1);
    expect(new Date(envelope.exportedAt).toISOString()).toBe(envelope.exportedAt);

    const byId = new Map(envelope.facts.map((fact) => [fact.id, fact]));
    expect(byId.has(activeId)).toBe(true);
    expect(byId.get(activeId)?.status).toBe("active");
    expect(byId.get(activeId)?.text).toBe("uses pnpm not npm");

    expect(byId.has(pendingId)).toBe(true);
    expect(byId.get(pendingId)?.status).toBe("pending");
  });

  it("--status filters which facts are exported", async () => {
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
    const activeId = extractRememberedId(remembered);

    const suggested = await runCli(["suggest", "maybe prefers dark mode", "--kind", "preference"]);
    const pendingId = /suggested \S+ fact (\S+) \(pending\)/u.exec(suggested.stdout)?.[1] as string;

    const exported = await runCli(["export", "--status", "active"]);
    expect(exported.exitCode).toBe(0);

    const envelope = JSON.parse(exported.stdout) as ExportEnvelope;
    const byId = new Map(envelope.facts.map((fact) => [fact.id, fact]));
    expect(byId.has(activeId)).toBe(true);
    expect(byId.has(pendingId)).toBe(false);
  });
});

describe("mem list --json", () => {
  it("emits a valid JSON envelope with the fact's fields and embedding dropped", async () => {
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
    const id = extractRememberedId(remembered);

    const result = await runCli(["list", "--json"]);
    expect(result.exitCode).toBe(0);

    const envelope = JSON.parse(result.stdout) as { schemaVersion: number; facts: Record<string, unknown>[] };
    expect(envelope.schemaVersion).toBe(1);
    const fact = envelope.facts.find((f) => f["id"] === id);
    expect(fact).toBeDefined();
    expect(fact?.["text"]).toBe("uses pnpm not npm");
    expect(fact?.["subject"]).toBe("package-manager");
    expect(fact).not.toHaveProperty("embedding");
  });

  it("still produces the existing human-readable text when --json is omitted", async () => {
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
    const id = extractRememberedId(remembered);

    const result = await runCli(["list"]);
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stdout).toContain(id);
    expect(result.stdout).toContain("uses pnpm not npm");
  });
});

describe("mem show --json", () => {
  it("includes fact, freshness, and sources", async () => {
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
    const id = extractRememberedId(remembered);

    const result = await runCli(["show", id, "--json"]);
    expect(result.exitCode).toBe(0);

    const envelope = JSON.parse(result.stdout) as {
      schemaVersion: number;
      fact: Record<string, unknown>;
      freshness: string;
      sources: unknown[];
    };
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.fact["id"]).toBe(id);
    expect(envelope.fact["text"]).toBe("uses pnpm not npm");
    expect(envelope.fact).not.toHaveProperty("embedding");
    expect(envelope.freshness).toBe("unverified");
    expect(Array.isArray(envelope.sources)).toBe(true);
  });

  it("resolves the superseding fact instead of leaving its id buried in audit prose", async () => {
    // The whole point of the feature: the loser's own `mem show` answers "what replaced this?"
    // without the reader parsing a sentence out of the audit log or running a second lookup.
    const first = await runCli([
      "remember",
      "node 18 is the floor",
      "--kind",
      "decision",
      "--subject",
      "node-floor",
      "--value",
      "18",
    ]);
    const loserId = extractRememberedId(first);
    const second = await runCli([
      "remember",
      "node 20 is the floor",
      "--kind",
      "decision",
      "--subject",
      "node-floor",
      "--value",
      "20",
    ]);
    const winnerId = extractRememberedId(second);

    // Contradictions are recomputed at recall and persisted only by the retention pass, so the
    // loser is still `active` until the retention pass runs. Driving `epoch --gc` here rather than
    // asserting on an unreconciled store keeps the test honest about when the edge actually exists.
    expect((await runCli(["epoch", "--gc"])).exitCode).toBe(0);

    const shown = await runCli(["show", loserId]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("status: superseded");
    expect(shown.stdout).toContain(`superseded_by: ${winnerId} (active): node 20 is the floor`);

    // The winner is not superseded, so it must not claim an edge it does not have.
    const winnerShown = await runCli(["show", winnerId]);
    expect(winnerShown.stdout).not.toContain("superseded_by:");

    const asJson = await runCli(["show", loserId, "--json"]);
    const envelope = JSON.parse(asJson.stdout) as {
      supersededBy: { id: string; status: string; text: string } | null;
    };
    expect(envelope.supersededBy).toEqual({ id: winnerId, status: "active", text: "node 20 is the floor" });
  });

  it("says so plainly when a superseded fact has no successor", async () => {
    // `forget` retires a fact without a winner, and so do `review --reject` and consolidate's stale
    // pass. Silence here would be indistinguishable from the feature not existing, so the absence
    // is stated rather than omitted.
    const remembered = await runCli(["remember", "retired outright", "--kind", "fact"]);
    const id = extractRememberedId(remembered);
    expect((await runCli(["forget", id])).exitCode).toBe(0);

    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("status: superseded");
    expect(shown.stdout).toContain("superseded_by: (nothing -- retired by forget, reject, or staleness)");

    const envelope = JSON.parse((await runCli(["show", id, "--json"])).stdout) as { supersededBy: unknown };
    expect(envelope.supersededBy).toBeNull();
  });

  it("still produces the existing formatFactDetail text output when --json is omitted", async () => {
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
    const id = extractRememberedId(remembered);

    const result = await runCli(["show", id]);
    expect(result.exitCode).toBe(0);
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stdout).toContain(`id: ${id}`);
    expect(result.stdout).toContain("freshness=");
  });
});

describe("mem import --from-json (full-fidelity round-trip)", () => {
  it("round-trips a fact -- including id, status, confidence, and captured_at -- into a fresh store", async () => {
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
    const id = extractRememberedId(remembered);

    const exported = await runCli(["export"]);
    expect(exported.exitCode).toBe(0);
    const envelope = JSON.parse(exported.stdout) as ExportEnvelope;
    const originalFact = envelope.facts.find((fact) => fact.id === id);
    expect(originalFact).toBeDefined();

    const exportDir = mkdtempSync(join(tmpdir(), "mem-export-"));
    const jsonPath = join(exportDir, "export.json");
    writeFileSync(jsonPath, exported.stdout, "utf8");

    const targetHome = mkdtempSync(join(tmpdir(), "mem-import-target-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = targetHome;
    try {
      const imported = await runCli(["import", "--from-json", jsonPath]);
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout).toContain("imported 1 of 1 candidate fact(s)");

      const shown = await runCli(["show", id]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain(`id: ${id}`);
      expect(shown.stdout).toContain("status: active");
      expect(shown.stdout).toContain("text: uses pnpm not npm");
      expect(shown.stdout).toContain("subject: package-manager");
      expect(shown.stdout).toContain("value: pnpm");
      expect(shown.stdout).toContain(`confidence: ${originalFact?.confidence}`);
      expect(shown.stdout).toContain(`captured_at: ${originalFact?.captured_at}`);
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("re-importing the same export file against the same target is idempotent -- second run reports duplicates, fact count unchanged", async () => {
    await runCli(["remember", "uses pnpm not npm", "--kind", "preference"]);
    const exported = await runCli(["export"]);
    const exportDir = mkdtempSync(join(tmpdir(), "mem-export-"));
    const jsonPath = join(exportDir, "export.json");
    writeFileSync(jsonPath, exported.stdout, "utf8");

    const targetHome = mkdtempSync(join(tmpdir(), "mem-import-target-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = targetHome;
    try {
      const first = await runCli(["import", "--from-json", jsonPath]);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("imported 1 of 1 candidate fact(s)");
      const countAfterFirst = await runCli(["list"]);
      const countLinesFirst = countAfterFirst.stdout.trim().split("\n").length;

      const second = await runCli(["import", "--from-json", jsonPath]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("imported 0 of 1 candidate fact(s)");
      expect(second.stdout).toContain("skipped (duplicate)");

      const countAfterSecond = await runCli(["list"]);
      const countLinesSecond = countAfterSecond.stdout.trim().split("\n").length;
      expect(countLinesSecond).toBe(countLinesFirst);
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("--dry-run reports candidates without writing any facts, and never creates mem.db", async () => {
    await runCli(["remember", "uses pnpm not npm", "--kind", "preference"]);
    const exported = await runCli(["export"]);
    const exportDir = mkdtempSync(join(tmpdir(), "mem-export-"));
    const jsonPath = join(exportDir, "export.json");
    writeFileSync(jsonPath, exported.stdout, "utf8");

    const targetHome = mkdtempSync(join(tmpdir(), "mem-import-target-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = targetHome;
    try {
      const result = await runCli(["import", "--from-json", jsonPath, "--dry-run"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("would import 1 candidate fact(s)");
      expect(result.stdout).toContain("nothing written");
      expect(existsSync(join(targetHome, "mem.db"))).toBe(false);
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("skips a fact with a high-entropy secret value the same way mem remember rejects it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-export-tampered-"));
    const jsonPath = join(dir, "export.json");
    const envelope = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      facts: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          text: "deploy key",
          kind: "fact",
          subject: "deploy-key",
          value: "AKIAABCDEFGHIJKLMNOP",
          scope: "global",
          scopeRoot: null,
          source_type: "user",
          source_ref: null,
          captured_at: new Date().toISOString(),
          anchor: null,
          status: "active",
          confidence: 1,
          embedding: null,
        },
      ],
    };
    writeFileSync(jsonPath, JSON.stringify(envelope), "utf8");

    try {
      const result = await runCli(["import", "--from-json", jsonPath]);
      // Per-fact skip, not a hard command failure: the command still reports success overall
      // (imported 0 of 1), same as a duplicate or a structurally invalid fact.
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("imported 0 of 1 candidate fact(s)");
      expect(result.stdout).toContain("secret");

      const listed = await runCli(["list"]);
      expect(listed.stdout.trim()).toBe("no facts stored");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits with code 1 (user error) when the --from-json file does not exist", async () => {
    const result = await runCli(["import", "--from-json", "/nonexistent/path/export.json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mem: ");
    expect(result.stderr).toContain("file not found");
  });

  it("exits with code 1 (user error) when the --from-json path is a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-import-dir-"));
    try {
      const result = await runCli(["import", "--from-json", dir]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("mem: ");
      expect(result.stderr).toContain("is a directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────── mem init / uninstall ───────────────────────────────────────────────────────────────────────────

describe("mem init/uninstall", () => {
  let toolRoot: string;
  let toolHome: string;

  beforeEach(() => {
    // Separate fixture dirs from `home` (mem's own TOKEN_GOAT_MEM_HOME data dir) -- these are the
    // fake "other tool" config root and home the wiring commands read/write, and must never
    // resolve to the real ~/.claude, real VS Code config, or real project files.
    toolRoot = mkdtempSync(join(tmpdir(), "mem-cli-wiring-root-"));
    toolHome = mkdtempSync(join(tmpdir(), "mem-cli-wiring-home-"));
    process.env["TOKEN_GOAT_MEM_WIRING_HOME"] = toolHome;
  });

  afterEach(() => {
    delete process.env["TOKEN_GOAT_MEM_WIRING_HOME"];
    rmSync(toolRoot, { recursive: true, force: true });
    rmSync(toolHome, { recursive: true, force: true });
  });

  it("rejects an unknown tool name", async () => {
    const result = await runCli(["init", "not-a-real-tool", "--root", toolRoot]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid tool");
  });

  it("--dry-run reports what would be written without touching disk", async () => {
    const result = await runCli(["init", "codex", "--root", toolRoot, "--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("create");
    expect(existsSync(join(toolRoot, "AGENTS.md"))).toBe(false);
  });

  it("dry-run then real run: the real run matches what dry-run predicted, and produces no duplication on a second `init`", async () => {
    const dryRun = await runCli(["init", "claude-code", "--root", toolRoot, "--dry-run"]);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toContain(join(toolRoot, ".claude", "settings.json"));
    expect(dryRun.stdout).toContain(join(toolRoot, "CLAUDE.md"));

    const realRun = await runCli(["init", "claude-code", "--root", toolRoot]);
    expect(realRun.exitCode).toBe(0);
    expect(existsSync(join(toolRoot, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(toolRoot, "CLAUDE.md"))).toBe(true);

    const settings = JSON.parse(readFileSync(join(toolRoot, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].__token_goat_mem).toBe(true);
    const claudeMdAfterFirstInit = readFileSync(join(toolRoot, "CLAUDE.md"), "utf8");

    // Second init: no duplication (upgrade-in-place), matches the manual smoke test in the task spec.
    const second = await runCli(["init", "claude-code", "--root", toolRoot]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("noop");
    const settingsAfterSecond = JSON.parse(readFileSync(join(toolRoot, ".claude", "settings.json"), "utf8"));
    expect(settingsAfterSecond.hooks.SessionStart).toHaveLength(1);
    expect(readFileSync(join(toolRoot, "CLAUDE.md"), "utf8")).toBe(claudeMdAfterFirstInit);
  });

  it("uninstall returns the file to its pre-install state and touches nothing else", async () => {
    writeFileSync(join(toolRoot, "unrelated.txt"), "leave me alone\n", "utf8");

    await runCli(["init", "claude-code", "--root", toolRoot]);
    const uninstallDryRun = await runCli(["uninstall", "claude-code", "--root", toolRoot, "--dry-run"]);
    expect(uninstallDryRun.exitCode).toBe(0);
    expect(uninstallDryRun.stdout).toContain("remove");

    const uninstalled = await runCli(["uninstall", "claude-code", "--root", toolRoot]);
    expect(uninstalled.exitCode).toBe(0);

    // Neither file existed before this init created them, so "the pre-install state" is absence --
    // an empty `.claude/settings.json` or `CLAUDE.md` husk left behind would not be that state, and
    // is exactly what a coding tool picks up as a real (if empty) instruction file.
    expect(existsSync(join(toolRoot, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(`${join(toolRoot, ".claude", "settings.json")}.token-goat-mem.bak`)).toBe(false);
    expect(existsSync(join(toolRoot, "CLAUDE.md"))).toBe(false);
    expect(existsSync(`${join(toolRoot, "CLAUDE.md")}.token-goat-mem.bak`)).toBe(false);
    expect(readFileSync(join(toolRoot, "unrelated.txt"), "utf8")).toBe("leave me alone\n");

    // Uninstalling again is a no-op, not an error.
    const again = await runCli(["uninstall", "claude-code", "--root", toolRoot]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("noop");
  });

  it("a full install/uninstall round trip on a fresh root leaves the directory listing exactly as it started, one tool at a time", async () => {
    // `.claude` and `.vscode` are directories mem creates that this fix deliberately leaves in place
    // (only files are unlinked, never directories), so they are excluded from the comparison.
    //
    // Each tool is installed and uninstalled to completion before the next one starts, rather than
    // installing all four and then uninstalling all four: codex/copilot-cli/copilot-vscode share
    // AGENTS.md, and a *second* tool installing into a file a *different* tool's install already
    // created legitimately takes a `.bak` of that (now mem-authored) content -- a real, unrelated
    // feature of install, not the residue this fix removes. One tool at a time isolates the case this
    // test exists to cover: a file no tool has touched yet, created and then fully uninstalled.
    const before = readdirSync(toolRoot).filter((name) => name !== ".claude" && name !== ".vscode");

    for (const tool of ["claude-code", "codex", "copilot-cli", "copilot-vscode"]) {
      const initResult = await runCli(["init", tool, "--root", toolRoot]);
      expect(initResult.exitCode).toBe(0);
      const uninstallResult = await runCli(["uninstall", tool, "--root", toolRoot]);
      expect(uninstallResult.exitCode).toBe(0);
    }

    const after = readdirSync(toolRoot).filter((name) => name !== ".claude" && name !== ".vscode");
    expect(after).toEqual(before);
  });

  it("--user writes/removes the user-level settings.json (under the isolated TOKEN_GOAT_MEM_WIRING_HOME) instead of the project one", async () => {
    await runCli(["init", "claude-code", "--root", toolRoot, "--user"]);
    expect(existsSync(join(toolRoot, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(toolHome, ".claude", "settings.json"))).toBe(true);

    await runCli(["uninstall", "claude-code", "--root", toolRoot, "--user"]);
    // settings.json never existed before this init created it under toolHome, so uninstall removes
    // the file rather than leaving an empty `{}` behind.
    expect(existsSync(join(toolHome, ".claude", "settings.json"))).toBe(false);
  });

  it("uninstall --all removes every tool's wiring in one call", async () => {
    for (const tool of ["claude-code", "codex", "copilot-cli", "copilot-vscode"]) {
      const result = await runCli(["init", tool, "--root", toolRoot]);
      expect(result.exitCode).toBe(0);
    }

    const result = await runCli(["uninstall", "--all", "--root", toolRoot]);
    expect(result.exitCode).toBe(0);
    for (const tool of ["claude-code", "codex", "copilot-cli", "copilot-vscode"]) {
      expect(result.stdout).toContain(`${tool}:`);
    }
    // AGENTS.md never existed before the first of codex/copilot-cli/copilot-vscode's init created it,
    // so once the last of the three is uninstalled the shared block empties and the file is removed.
    expect(existsSync(join(toolRoot, "AGENTS.md"))).toBe(false);
  });

  it("uninstall --all reports a per-tool failure and keeps going, exiting 1, instead of hiding tools that already finished", async () => {
    // Before this fix, `uninstall --all` buffered every tool's output into one array and only wrote
    // it to stdout after the whole loop finished, so a thrown error from one tool's file (a JSON
    // parse failure here) discarded the output for every tool already uninstalled before it -- the
    // opposite of what codex's successful uninstall, which ran first, deserves to have reported.
    const codexResult = await runCli(["init", "codex", "--root", toolRoot]);
    expect(codexResult.exitCode).toBe(0);
    const copilotVscodeResult = await runCli(["init", "copilot-vscode", "--root", toolRoot]);
    expect(copilotVscodeResult.exitCode).toBe(0);

    writeFileSync(join(toolRoot, ".vscode", "tasks.json"), "{", "utf8");

    const result = await runCli(["uninstall", "--all", "--root", toolRoot]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("codex:");
    expect(result.stdout).toContain(join(toolRoot, "AGENTS.md"));
    expect(result.stdout).toContain("copilot-vscode: failed");
  });

  it("uninstall requires a tool name or --all, and rejects combining them", async () => {
    const missing = await runCli(["uninstall", "--root", toolRoot]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("requires a tool name");

    const both = await runCli(["uninstall", "claude-code", "--all", "--root", toolRoot]);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("cannot combine");
  });

  it("init codex then init copilot-cli against the same AGENTS.md produces exactly one shared \"## Memory\" section tracking both tools; uninstalling codex leaves it intact with only copilot-cli remaining", async () => {
    const codexResult = await runCli(["init", "codex", "--root", toolRoot]);
    expect(codexResult.exitCode).toBe(0);
    const copilotCliResult = await runCli(["init", "copilot-cli", "--root", toolRoot]);
    expect(copilotCliResult.exitCode).toBe(0);

    const agentsMdPath = join(toolRoot, "AGENTS.md");
    const afterBothInit = readFileSync(agentsMdPath, "utf8");
    expect(afterBothInit.split("## Memory").length - 1).toBe(1);
    expect(afterBothInit).toContain("<!-- token-goat-mem:start tools=codex,copilot-cli -->");
    expect(afterBothInit).toContain("<!-- token-goat-mem:end -->");

    const uninstallCodex = await runCli(["uninstall", "codex", "--root", toolRoot]);
    expect(uninstallCodex.exitCode).toBe(0);

    const afterUninstallCodex = readFileSync(agentsMdPath, "utf8");
    expect(afterUninstallCodex.split("## Memory").length - 1).toBe(1);
    expect(afterUninstallCodex).toContain("<!-- token-goat-mem:start tools=copilot-cli -->");
    expect(afterUninstallCodex).not.toContain("tools=codex,copilot-cli");
    expect(afterUninstallCodex).not.toContain("tools=codex ");
    expect(afterUninstallCodex).toContain("mem recall --hint-format --root .");
  });

  it("init codex, copilot-cli, and copilot-vscode against the same AGENTS.md produces exactly one shared section tracking all three; uninstalling one at a time correctly decrements to zero", async () => {
    const agentsMdPath = join(toolRoot, "AGENTS.md");

    for (const tool of ["codex", "copilot-cli", "copilot-vscode"]) {
      const result = await runCli(["init", tool, "--root", toolRoot]);
      expect(result.exitCode).toBe(0);
    }

    const afterAllInit = readFileSync(agentsMdPath, "utf8");
    expect(afterAllInit.split("## Memory").length - 1).toBe(1);
    expect(afterAllInit).toContain("<!-- token-goat-mem:start tools=codex,copilot-cli,copilot-vscode -->");

    const uninstallCopilotVscode = await runCli(["uninstall", "copilot-vscode", "--root", toolRoot]);
    expect(uninstallCopilotVscode.exitCode).toBe(0);
    let current = readFileSync(agentsMdPath, "utf8");
    expect(current).toContain("<!-- token-goat-mem:start tools=codex,copilot-cli -->");
    expect(current.split("## Memory").length - 1).toBe(1);

    const uninstallCopilotCli = await runCli(["uninstall", "copilot-cli", "--root", toolRoot]);
    expect(uninstallCopilotCli.exitCode).toBe(0);
    current = readFileSync(agentsMdPath, "utf8");
    expect(current).toContain("<!-- token-goat-mem:start tools=codex -->");

    const uninstallCodex = await runCli(["uninstall", "codex", "--root", toolRoot]);
    expect(uninstallCodex.exitCode).toBe(0);
    // AGENTS.md never existed before codex's own init created it, so once the last tool tracked in
    // the shared block is uninstalled, the file is removed rather than left empty.
    expect(existsSync(agentsMdPath)).toBe(false);
  });

  it("copilot-vscode init writes tasks.json, keybindings.json (under the isolated home), and AGENTS.md", async () => {
    const result = await runCli(["init", "copilot-vscode", "--root", toolRoot]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(toolRoot, ".vscode", "tasks.json"))).toBe(true);
    expect(existsSync(join(toolRoot, "AGENTS.md"))).toBe(true);

    const keybindingsPath =
      process.platform === "win32"
        ? join(toolHome, "AppData", "Roaming", "Code", "User", "keybindings.json")
        : process.platform === "darwin"
          ? join(toolHome, "Library", "Application Support", "Code", "User", "keybindings.json")
          : join(toolHome, ".config", "Code", "User", "keybindings.json");
    expect(existsSync(keybindingsPath)).toBe(true);
    const keybindings = JSON.parse(readFileSync(keybindingsPath, "utf8"));
    expect(keybindings).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────── regression guards ───────────────────────────────────────────────────────────────────────────

describe("capture confirmations never print a doubled noun (regression: `remembered fact fact <id>`)", () => {
  it("collapses the noun phrase when the kind is `fact`", async () => {
    const result = await runCli(["remember", "a plain fact", "--kind", "fact"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^remembered fact \S+\n$/u);
    expect(result.stdout).not.toContain("fact fact");
  });

  it("keeps the kind in the noun phrase for every other kind", async () => {
    const result = await runCli(["remember", "a decision", "--kind", "decision"]);

    expect(result.stdout).toMatch(/^remembered decision fact \S+\n$/u);
  });

  it("applies the same collapse to `suggest`, which shares the template", async () => {
    const suggested = await runCli(["suggest", "a plain candidate", "--kind", "fact"]);
    const typed = await runCli(["suggest", "a typed candidate", "--kind", "correction"]);

    expect(suggested.stdout).toMatch(/^suggested fact \S+ \(pending\)\n$/u);
    expect(suggested.stdout).not.toContain("fact fact");
    expect(typed.stdout).toMatch(/^suggested correction fact \S+ \(pending\)\n$/u);
  });

  it("still yields an extractable id for a `fact`-kind capture", async () => {
    // The shortened line must not break id extraction: the helper's own pattern required a kind
    // token between "remembered" and "fact", which this collapse removes for exactly this kind.
    const result = await runCli(["remember", "id must still parse", "--kind", "fact"]);

    expect(extractRememberedId(result)).toMatch(/^[0-9a-f-]{36}$/u);
  });
});

describe("mem --version (regression: the shipped bundle reports package.json's version)", () => {
  it("reports exactly package.json's version, executed from the built dist bundle", () => {
    // Asserts against the real artifact (built by tests/setup/build-bundle.ts), not the in-process
    // `run()` the rest of this file drives, because the defect this guards was a hand-maintained
    // literal in cli.ts that shipped 0.2.0 while package.json said 0.2.1 -- only the bundle proves
    // the esbuild `define` that now supplies the version actually reached what users execute.
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };
    const bundle = fileURLToPath(new URL("../dist/token-goat-mem.mjs", import.meta.url));
    const reported = execFileSync(process.execPath, [bundle, "--version"], { encoding: "utf8" }).trim();
    expect(reported).toBe(pkg.version);
  });
});

describe("mem import summary wording (regression: must describe what was actually written)", () => {
  it("does not claim `--from-json` imports landed as pending when their exported status was preserved", async () => {
    await runCli(["remember", "uses pnpm not npm", "--kind", "preference"]);
    const exported = await runCli(["export"]);
    const exportDir = mkdtempSync(join(tmpdir(), "mem-export-wording-"));
    const jsonPath = join(exportDir, "export.json");
    writeFileSync(jsonPath, exported.stdout, "utf8");

    const targetHome = mkdtempSync(join(tmpdir(), "mem-import-wording-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = targetHome;
    try {
      const imported = await runCli(["import", "--from-json", jsonPath]);
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout).toContain("imported 1 of 1 candidate fact(s)");
      // The fact is restored active, so the summary must not send the reader to a `mem review` that has nothing to show.
      expect(imported.stdout).toContain("preserving each fact's exported status");
      expect(imported.stdout).not.toContain("as pending");
      expect(imported.stdout).not.toContain("mem review --promote");

      const review = await runCli(["review", "--summary"]);
      expect(review.stdout.trim()).toBe("pending: 0, contested: 0, contradicted: 0, pins: 0, unanchored: 0");
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("still labels `--from-md` bullets as pending, since those genuinely are", async () => {
    const path = join(home, "NOTES.md");
    writeFileSync(path, ["## Preferences", "- Always use pnpm, never npm."].join("\n"), "utf8");

    const result = await runCli(["import", "--from-md", path, "--root", home]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("as pending");
    expect(result.stdout).toContain("never auto-promoted -- confirm each via `mem review --promote <id>`");
  });

  it("reports nothing written when every candidate was a duplicate", async () => {
    const path = join(home, "DUPES.md");
    writeFileSync(path, ["## Preferences", "- Always use pnpm, never npm."].join("\n"), "utf8");

    await runCli(["import", "--from-md", path, "--root", home]);
    const second = await runCli(["import", "--from-md", path, "--root", home]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("imported 0 of 1 candidate fact(s)");
    expect(second.stdout).toContain("no new facts were written");
    expect(second.stdout).not.toContain("as pending");
  });
});

// ─────────────────────────────────────────────────────────────────────────── regression: withheld statuses are a trapdoor, not a one-way door ───────────────────────────────────────────────────────────────────────────

describe("regression: `contested` is escapable (it used to be excluded from the only pass that could clear it)", () => {
  /**
   * Seeds two facts that genuinely tie on precedence (same subject+scope, different value, identical
   * `captured_at`, identical provenance), which is the exact shape P4 resolves to `contested` rather
   * than picking a winner. Returns their ids in insertion order.
   */
  async function seedTiedPair(): Promise<readonly [string, string]> {
    const first = await runCli(["remember", "uses pnpm", "--kind", "preference", "--subject", "package-manager", "--value", "pnpm"]);
    const idA = extractRememberedId(first);
    const second = await runCli(["remember", "uses npm", "--kind", "preference", "--subject", "package-manager", "--value", "npm"]);
    const idB = extractRememberedId(second);

    const db = openDb(resolveDbPath());
    db.prepare("UPDATE facts SET captured_at = ? WHERE id IN (?, ?)").run("2026-01-01T00:00:00.000Z", idA, idB);
    db.close();
    return [idA, idB];
  }

  it("reinstates a stranded contested fact on the next gc once its rival is forgotten", async () => {
    const [idA, idB] = await seedTiedPair();

    // Persist the contested status. Before the fix this was the trapdoor: detection queried only
    // active/pinned, so nothing that ran afterwards could ever see -- let alone clear -- the status
    // this very pass had just written.
    await runCli(["epoch", "--gc"]);
    const contestedList = await runCli(["list", "--status", "contested"]);
    expect(contestedList.stdout).toContain(idA);
    expect(contestedList.stdout).toContain(idB);

    await runCli(["forget", idB]);
    const gc = await runCli(["epoch", "--gc"]);
    expect(gc.exitCode).toBe(0);

    const survivor = await runCli(["show", idA]);
    expect(survivor.stdout).toContain("status: active");
  });

  it("still surfaces a persisted-contested fact in `mem review`, which used to query only active/pinned", async () => {
    const [idA, idB] = await seedTiedPair();
    await runCli(["epoch", "--gc"]);

    const review = await runCli(["review"]);
    expect(review.exitCode).toBe(0);
    expect(review.stdout).toContain("contested (ambiguous contradiction -- withheld from ground truth");
    expect(review.stdout).toContain(idA);
    expect(review.stdout).toContain(idB);
  });

  it("`review --promote` resolves a contested group in one fact's favor and supersedes its rivals", async () => {
    const [idA, idB] = await seedTiedPair();
    await runCli(["epoch", "--gc"]);

    const promoted = await runCli(["review", "--promote", idA]);
    expect(promoted.exitCode).toBe(0);

    expect((await runCli(["show", idA])).stdout).toContain("status: active");
    // Without superseding the rival, the very next detection pass would find the same tie and
    // re-contest the pair -- making the promotion silently self-undoing.
    expect((await runCli(["show", idB])).stdout).toContain("status: superseded");
    await runCli(["epoch", "--gc"]);
    expect((await runCli(["show", idA])).stdout).toContain("status: active");
  });

  it("`review --promote` restores a formerly-pinned contested fact to pinned, not active", async () => {
    const [idA, idB] = await seedTiedPair();
    await runCli(["pin", idA]);
    await runCli(["epoch", "--gc"]);
    expect((await runCli(["show", idA])).stdout).toContain("status: contested");

    await runCli(["review", "--promote", idA]);
    expect((await runCli(["show", idA])).stdout).toContain("status: pinned");
    expect((await runCli(["show", idB])).stdout).toContain("status: superseded");
  });

  it("`review --reject` on one side reinstates the survivor immediately, without waiting for a gc", async () => {
    const [idA, idB] = await seedTiedPair();
    await runCli(["epoch", "--gc"]);

    const rejected = await runCli(["review", "--reject", idB]);
    expect(rejected.exitCode).toBe(0);
    expect((await runCli(["show", idB])).stdout).toContain("status: superseded");
    expect((await runCli(["show", idA])).stdout).toContain("status: active");
  });
});

// ─────────────────────────────────────────────────────────────────────────── regression: `mem pin` is not a side door around review ───────────────────────────────────────────────────────────────────────────

describe("regression: `mem pin` refuses every withheld status instead of laundering it into maximal trust", () => {
  it("refuses to pin a pending suggestion, and points at the review command that can resolve it", async () => {
    const db = openStorage(resolveDbPath());
    const { fact } = captureSuggested(db, { text: "an unreviewed suggestion", kind: "preference", root: home });
    db.close();
    const id = fact.id;

    const result = await runCli(["pin", id]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is pending, not active");
    expect(result.stderr).toContain(`mem review --promote ${id}`);
    expect((await runCli(["show", id])).stdout).toContain("status: pending");
  });

  it("refuses to pin a superseded (forgotten) fact back into ground truth", async () => {
    const id = extractRememberedId(await runCli(["remember", "a forgotten fact", "--kind", "fact"]));
    await runCli(["forget", id]);

    const result = await runCli(["pin", id]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is superseded, not active");
    expect(result.stderr).toContain("re-capture it with `mem remember`");
    expect((await runCli(["show", id])).stdout).toContain("status: superseded");
  });

  it("still pins an active fact, and re-pinning an already-pinned fact stays a success", async () => {
    const id = extractRememberedId(await runCli(["remember", "a live fact", "--kind", "fact"]));
    expect((await runCli(["pin", id])).exitCode).toBe(0);
    expect((await runCli(["pin", id])).exitCode).toBe(0);
    expect((await runCli(["show", id])).stdout).toContain("status: pinned");
  });
});

// ─────────────────────────────────────────────────────────────────────────── regression: retention clocks key on the status change, not the capture ───────────────────────────────────────────────────────────────────────────

describe("regression: gc and the pin nudge measure age from `status_changed_at`, not `captured_at`", () => {
  it("keeps a long-lived fact that was superseded yesterday, instead of pruning it for being old", async () => {
    const db = openStorage(resolveDbPath());
    insertFact(db, {
      text: "captured long ago, superseded only just now",
      kind: "fact",
      scope: "global",
      source_type: "user",
      captured_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const id = db.prepare<[], { id: string }>("SELECT id FROM facts LIMIT 1").get()?.id ?? "";
    db.close();

    await runCli(["forget", id]);
    const gc = await runCli(["epoch", "--gc"]);
    expect(gc.exitCode).toBe(0);

    // The 90-day window exists to preserve the audit trail of a *recent* soft delete. Keyed on
    // `captured_at` this fact was deleted on the very first pass after being forgotten.
    const shown = await runCli(["show", id]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("status: superseded");
  });

  it("still prunes a fact that has actually been superseded past the window", async () => {
    const db = openStorage(resolveDbPath());
    insertFact(db, { text: "long-superseded fact", kind: "fact", scope: "global", source_type: "user" });
    const id = db.prepare<[], { id: string }>("SELECT id FROM facts LIMIT 1").get()?.id ?? "";
    db.prepare("UPDATE facts SET status = 'superseded', status_changed_at = ? WHERE id = ?").run(
      new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      id
    );
    db.close();

    expect((await runCli(["epoch", "--gc"])).exitCode).toBe(0);
    expect((await runCli(["show", id])).exitCode).toBe(1);
  });

  it("clears a due pin's re-confirmation nudge when the user re-pins it", async () => {
    const db = openStorage(resolveDbPath());
    insertFact(db, { text: "an old pinned fact", kind: "fact", scope: "global", source_type: "user", status: "pinned" });
    const id = db.prepare<[], { id: string }>("SELECT id FROM facts LIMIT 1").get()?.id ?? "";
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE facts SET captured_at = ?, status_changed_at = ? WHERE id = ?").run(longAgo, longAgo, id);
    db.close();

    expect((await runCli(["review"])).stdout).toContain(id);

    // Re-pinning is the act of re-confirming. Keyed on `captured_at` the nudge was unclearable:
    // nothing a user can do changes when a fact was captured, so it nagged forever.
    await runCli(["pin", id]);
    const after = await runCli(["review"]);
    expect(after.stdout).not.toContain("pins due for re-confirmation");
  });
});

// --- regression: anchor roots resolve per fact, not per caller ---

describe("regression: review and show resolve anchor roots the way recall does", () => {
  it("does not list a valid project-scoped fact as contradicted when review runs from another project", async () => {
    const projA = mkdtempSync(join(tmpdir(), "mem-proj-a-"));
    const projB = mkdtempSync(join(tmpdir(), "mem-proj-b-"));
    writeFileSync(join(projA, "package.json"), "{}\n");
    try {
      const db = openStorage(resolveDbPath());
      insertFact(db, {
        text: "this project has a package json manifest",
        kind: "fact",
        scope: "project",
        scopeRoot: projA,
        source_type: "user",
        anchor: "file-exists package.json",
      });
      db.close();

      // projB has no package.json. Evaluated against the caller's root, the predicate denies a fact
      // that is perfectly valid in its own project, and files it under the one review heading whose
      // whole purpose is to invite the user to forget what it lists.
      const review = await runCli(["review", "--root", projB]);
      expect(review.exitCode).toBe(0);
      expect(review.stdout).not.toContain("this project has a package json manifest");

      // ...and recall, from that same foreign root, no longer surfaces it either -- it is bound to
      // projA. Two surfaces disagreeing about one fact was the original defect here; they agree by
      // omission now, where they used to agree only if recall affirmed a fact review had hidden.
      const fromForeign = await runCli(["recall", "package json manifest", "--root", projB]);
      expect(fromForeign.stdout).not.toContain("this project has a package json manifest");

      // From its own project the fact is present and affirmed -- excluded above by its binding, not
      // by a contradicted anchor.
      const fromOwn = await runCli(["recall", "package json manifest", "--root", projA]);
      expect(fromOwn.stdout).toContain("this project has a package json manifest");
      expect(fromOwn.stdout).not.toContain("contradicted");
    } finally {
      rmSync(projA, { recursive: true, force: true });
      rmSync(projB, { recursive: true, force: true });
    }
  });

  it("does not use a path-scoped fact's file path as an anchor root in show", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-path-scope-"));
    const notes = join(dir, "notes.txt");
    writeFileSync(notes, "some notes\n");
    try {
      const db = openStorage(resolveDbPath());
      const inserted = insertFact(db, {
        text: "a fact scoped to one single file",
        kind: "fact",
        scope: "path",
        scopeRoot: notes,
        source_type: "user",
        anchor: "file-exists package.json",
      });
      db.close();

      // With no --root, the old `?? fact.scopeRoot` fallback took over, and for scope="path"
      // scopeRoot is a *file*. Resolving a predicate beneath a file path can only fail, so show
      // reported a confident contradiction that no other surface agreed with. The repo root this
      // suite runs from does have a package.json, so the correct verdict here is affirmed.
      const shown = await runCli(["show", inserted.id]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).not.toContain("freshness=contradicted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- regression: --since-epoch is a display window, not a detection window ---

describe("regression: --since-epoch cannot defeat the contested gate", () => {
  /** Two facts, same subject and scope, different values, identical capture time and provenance: a genuine tie, which the detector resolves to `contested` and withholds rather than guessing a winner. The second fact gets the higher epoch, so `--since-epoch 1` keeps it and drops its rival. */
  async function seedTiedPair(): Promise<void> {
    const db = openStorage(resolveDbPath());
    const capturedAt = new Date().toISOString();
    for (const value of ["npm", "pnpm"]) {
      insertFact(db, {
        text: `the package manager for this repo is ${value}`,
        kind: "decision",
        subject: "package manager",
        value,
        scope: "global",
        source_type: "user",
        captured_at: capturedAt,
      });
    }
    db.close();
  }

  it("keeps recall's contested annotation when the rival falls outside the epoch window", async () => {
    await seedTiedPair();

    // A tie is surfaced with a `(contested, ...)` annotation instead of a guessed winner. Assert on
    // that annotation, not on the bare word "contested": recall's footer prints "mem review to
    // resolve contested/pending" on every call, so the looser assertion passes vacuously and the
    // first draft of this test did exactly that -- it passed against the unfixed code.
    const plain = await runCli(["recall", "package manager"]);
    expect(plain.stdout).toContain("(contested,");

    // Filtering the pool in SQL left the survivor alone, and resolveContradictions' reinstatement
    // pass reads "no rival present" as "nothing is left to contest this" and un-contests it -- so
    // the epoch window silently promoted a withheld fact to ground truth. The filter now runs after
    // contradiction resolution, over the whole store, like every other filter.
    const filtered = await runCli(["recall", "package manager", "--since-epoch", "1"]);
    expect(filtered.exitCode).toBe(0);
    expect(filtered.stdout).toContain("(contested,");
  });

  it("keeps review's contested bucket populated when the rival falls outside the epoch window", async () => {
    await seedTiedPair();

    const plain = await runCli(["review", "--summary"]);
    expect(plain.stdout).toContain("contested: 2");

    // Same defect one function over: `formatReview` fed `detectContradictions` an epoch-filtered
    // pool, so the surviving half of a tie was reported clean by the exact command whose job is to
    // surface it -- while `mem recall` went on withholding it.
    const filtered = await runCli(["review", "--summary", "--since-epoch", "1"]);
    expect(filtered.exitCode).toBe(0);
    expect(filtered.stdout).toContain("contested: 1");
  });
});

// --- regression: recall prints an id its own footer can be followed with ---

describe("regression: recall prints a usable fact id", () => {
  it("prefixes each result with a short id that show actually resolves", async () => {
    await runCli(["remember", "the footer says to run mem show for detail", "--kind", "fact"]);

    const recalled = await runCli(["recall", "footer"]);
    expect(recalled.stdout).toContain("mem show <id> for detail");

    const shortId = (recalled.stdout.split("\n")[0] ?? "").split(/\s+/u)[0] ?? "";
    // A git-style prefix: the exact shape `resolveFactIdOrPrefix` accepts, so the footer's own
    // instruction is followable by copying what is on screen rather than by first running `mem list`
    // to find an id the command that told you to use one declined to print.
    expect(shortId).toMatch(/^[0-9a-f]{8}$/u);

    const shown = await runCli(["show", shortId]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("the footer says to run mem show for detail");
  });
});

// --- regression: a restored backup is not instantly garbage ---

describe("regression: import --from-json does not restore facts that are already GC-expired", () => {
  it("keeps a superseded fact restored from an old export instead of pruning it on the next gc", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-import-clock-"));
    const envelopePath = join(dir, "backup.json");
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    try {
      writeFileSync(
        envelopePath,
        JSON.stringify({
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          facts: [
            {
              id,
              text: "an old fact superseded long before this backup was taken",
              kind: "fact",
              subject: null,
              value: null,
              scope: "global",
              scopeRoot: null,
              source_type: "user",
              source_ref: null,
              captured_at: longAgo,
              anchor: null,
              status: "superseded",
              confidence: 1,
              embedding: null,
            },
          ],
        })
      );

      expect((await runCli(["import", "--from-json", envelopePath])).exitCode).toBe(0);
      expect((await runCli(["epoch", "--gc"])).exitCode).toBe(0);

      // The 90-day superseded retention window is measured from `status_changed_at`, and the export
      // envelope carries no status timestamp to restore. Starting that clock at the envelope's
      // backdated `captured_at` meant every restored superseded fact arrived with its window already
      // elapsed and was destroyed by the first gc after the restore: silent data loss on the one
      // path the docs recommend for backups.
      const shown = await runCli(["show", id]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain("an old fact superseded long before this backup was taken");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- regression: recall binds facts to the project they were captured in ---

describe("regression: recall does not surface another project's facts", () => {
  it("excludes a project-scoped fact belonging to a different root, including under --scope project", async () => {
    const projA = mkdtempSync(join(tmpdir(), "mem-recall-a-"));
    const projB = mkdtempSync(join(tmpdir(), "mem-recall-b-"));
    try {
      const db = openStorage(resolveDbPath());
      insertFact(db, {
        text: "deploys go out on Tuesdays",
        kind: "decision",
        scope: "project",
        scopeRoot: projA,
        source_type: "user",
      });
      insertFact(db, {
        text: "deploys go out on Thursdays",
        kind: "decision",
        scope: "project",
        scopeRoot: projB,
        source_type: "user",
      });
      insertFact(db, {
        text: "deploys always need a changelog entry",
        kind: "decision",
        scope: "global",
        scopeRoot: null,
        source_type: "user",
      });
      db.close();

      // `--root` used to reach only anchor evaluation, so the store was searched whole and a user
      // standing in projB was told projA's release schedule.
      const fromB = await runCli(["recall", "deploys", "--root", projB]);
      expect(fromB.exitCode).toBe(0);
      expect(fromB.stdout).toContain("deploys go out on Thursdays");
      expect(fromB.stdout).not.toContain("deploys go out on Tuesdays");

      // Global facts are bound to no project and stay visible from either one.
      expect(fromB.stdout).toContain("deploys always need a changelog entry");

      // `--scope project` filtered on the scope *label*, so it narrowed to "scoped to some project"
      // and still returned the wrong project's fact -- the exact shape of README's own example.
      const scoped = await runCli(["recall", "deploys", "--root", projB, "--scope", "project"]);
      expect(scoped.exitCode).toBe(0);
      expect(scoped.stdout).toContain("deploys go out on Thursdays");
      expect(scoped.stdout).not.toContain("deploys go out on Tuesdays");
    } finally {
      rmSync(projA, { recursive: true, force: true });
      rmSync(projB, { recursive: true, force: true });
    }
  });

  it("a JSON-imported project-scoped fact is recallable from its bound root and not from another", async () => {
    const projA = mkdtempSync(join(tmpdir(), "mem-import-recall-a-"));
    const projB = mkdtempSync(join(tmpdir(), "mem-import-recall-b-"));
    const exportDir = mkdtempSync(join(tmpdir(), "mem-import-recall-export-"));
    try {
      const envelope = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        facts: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            text: "this repo deploys via a manual runbook",
            kind: "decision",
            subject: null,
            value: null,
            scope: "project",
            scopeRoot: projA,
            source_type: "user",
            source_ref: null,
            captured_at: "2026-01-01T00:00:00.000Z",
            anchor: null,
            status: "active",
            confidence: 1,
            embedding: null,
          },
        ],
      };
      const jsonPath = join(exportDir, "export.json");
      writeFileSync(jsonPath, JSON.stringify(envelope), "utf8");

      const imported = await runCli(["import", "--from-json", jsonPath]);
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout).toContain("imported 1 of 1 candidate fact(s)");

      const fromA = await runCli(["recall", "manual runbook", "--root", projA]);
      expect(fromA.exitCode).toBe(0);
      expect(fromA.stdout).toContain("this repo deploys via a manual runbook");

      const fromB = await runCli(["recall", "manual runbook", "--root", projB]);
      expect(fromB.exitCode).toBe(0);
      expect(fromB.stdout).not.toContain("this repo deploys via a manual runbook");
    } finally {
      rmSync(projA, { recursive: true, force: true });
      rmSync(projB, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("surfaces a path-scoped fact bound to a file inside the querying root", async () => {
    const proj = mkdtempSync(join(tmpdir(), "mem-recall-path-"));
    const outside = mkdtempSync(join(tmpdir(), "mem-recall-out-"));
    try {
      const db = openStorage(resolveDbPath());
      insertFact(db, {
        text: "this module owns retry backoff",
        kind: "fact",
        scope: "path",
        scopeRoot: join(proj, "src", "retry.ts"),
        source_type: "user",
      });
      insertFact(db, {
        text: "this module owns rate limiting",
        kind: "fact",
        scope: "path",
        scopeRoot: join(outside, "src", "limit.ts"),
        source_type: "user",
      });
      db.close();

      const recalled = await runCli(["recall", "module owns", "--root", proj]);
      expect(recalled.exitCode).toBe(0);
      expect(recalled.stdout).toContain("this module owns retry backoff");
      expect(recalled.stdout).not.toContain("this module owns rate limiting");
    } finally {
      rmSync(proj, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// --- regression: `--scope path` is reachable and binds to a file, not the project root ---

describe("regression: --scope path binds to --path, not --root (previously unreachable)", () => {
  it("mem remember --scope path --path <file> binds scopeRoot to the file, and `show` prints it", async () => {
    const proj = mkdtempSync(join(tmpdir(), "mem-scope-path-remember-"));
    try {
      const remembered = await runCli([
        "remember",
        "auth.ts owns migrations",
        "--kind",
        "fact",
        "--scope",
        "path",
        "--path",
        "src/auth.ts",
        "--root",
        proj,
      ]);
      expect(remembered.exitCode).toBe(0);
      const id = extractRememberedId(remembered);

      const shown = await runCli(["show", id]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain(`scope: path (${join(proj, "src", "auth.ts")})`);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("a path-scoped fact recalls only for a matching --context-files entry, not for an unrelated file in the same project", async () => {
    const proj = mkdtempSync(join(tmpdir(), "mem-scope-path-recall-"));
    try {
      const remembered = await runCli([
        "remember",
        "auth.ts owns migrations",
        "--kind",
        "fact",
        "--scope",
        "path",
        "--path",
        "src/auth.ts",
        "--root",
        proj,
      ]);
      expect(remembered.exitCode).toBe(0);

      const matching = await runCli([
        "recall",
        "--hint-format",
        "--root",
        proj,
        "--context-files",
        "src/auth.ts",
      ]);
      expect(matching.exitCode).toBe(0);
      expect(matching.stdout).toContain("auth.ts owns migrations");

      const nonMatching = await runCli([
        "recall",
        "--hint-format",
        "--root",
        proj,
        "--context-files",
        "src/other.ts",
      ]);
      expect(nonMatching.exitCode).toBe(0);
      expect(nonMatching.stdout).not.toContain("auth.ts owns migrations");
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it("rejects --scope path without --path", async () => {
    const result = await runCli(["remember", "some fact", "--kind", "fact", "--scope", "path"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--scope path requires --path <file-or-dir>");
  });

  it("rejects --path without --scope path", async () => {
    const result = await runCli(["remember", "some fact", "--kind", "fact", "--path", "src/auth.ts"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--path requires --scope path");
  });

  it("mem edit --scope path --path <file> rebinds scopeRoot to the new file", async () => {
    const proj = mkdtempSync(join(tmpdir(), "mem-scope-path-edit-"));
    try {
      const remembered = await runCli([
        "remember",
        "b.ts owns retries",
        "--kind",
        "fact",
        "--scope",
        "path",
        "--path",
        "src/a.ts",
        "--root",
        proj,
      ]);
      const id = extractRememberedId(remembered);

      const edited = await runCli(["edit", id, "--scope", "path", "--path", "src/b.ts", "--root", proj]);
      expect(edited.exitCode).toBe(0);

      const shown = await runCli(["show", id]);
      expect(shown.exitCode).toBe(0);
      expect(shown.stdout).toContain(`scope: path (${join(proj, "src", "b.ts")})`);
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

// --- regression: `mem list` cannot tell projects apart ---

describe("regression: mem list distinguishes facts bound to different projects", () => {
  it("shows the project binding on a project-scoped fact's summary line, and no binding on a global fact's", async () => {
    const projA = mkdtempSync(join(tmpdir(), "mem-list-scope-a-"));
    try {
      const db = openStorage(resolveDbPath());
      insertFact(db, {
        text: "deploys go out on Tuesdays",
        kind: "decision",
        scope: "project",
        scopeRoot: projA,
        source_type: "user",
      });
      insertFact(db, {
        text: "deploys always need a changelog entry",
        kind: "decision",
        scope: "global",
        scopeRoot: null,
        source_type: "user",
      });
      db.close();

      const listed = await runCli(["list"]);
      expect(listed.exitCode).toBe(0);

      const projectLine = listed.stdout.split("\n").find((line) => line.includes("deploys go out on Tuesdays"));
      expect(projectLine).toBeDefined();
      expect(projectLine).toContain(`@${projA}`);

      const globalLine = listed.stdout.split("\n").find((line) => line.includes("deploys always need a changelog entry"));
      expect(globalLine).toBeDefined();
      expect(globalLine).not.toContain("@");
    } finally {
      rmSync(projA, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────── recall --session-id / --delta / recall_log ───────────────────────────────────────────────────────────────────────────

describe("mem recall --hint-format session log and --delta (in-process)", () => {
  /** `recall_log` rows as `[fact_id, session_id, surfaced_at]`, oldest first. */
  function recallLogRows(): Array<[string, string, string]> {
    const db = openStorage(resolveDbPath());
    try {
      return db
        .prepare<[], { fact_id: string; session_id: string; surfaced_at: string }>("SELECT fact_id, session_id, surfaced_at FROM recall_log ORDER BY rowid")
        .all()
        .map((row) => [row.fact_id, row.session_id, row.surfaced_at]);
    } finally {
      db.close();
    }
  }

  it.each([
    [["recall", "--hook-stdin", "--root", "."], "--hook-stdin requires --hint-format"],
    [["recall", "--session-id", "s1", "--root", "."], "--session-id requires --hint-format"],
    [["recall", "--delta", "--root", "."], "--delta requires --hint-format"],
    [["recall", "--hint-format", "--delta", "--root", "."], "--delta requires a session id"],
    [["recall", "--hint-format", "--session-id", "  ", "--root", "."], "--session-id must not be empty"],
  ])("rejects %j as a usage error: %s", async (args, message) => {
    const result = await runCli(args);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  });

  it("--session-id logs the emitted ids; --delta then omits them and marks the header; a plain call still returns all", async () => {
    const a = extractRememberedId(await runCli(["remember", "alpha fact about apples", "--kind", "fact", "--scope", "global"]));
    const b = extractRememberedId(await runCli(["remember", "beta fact about bananas", "--kind", "fact", "--scope", "global"]));

    const first = await runCli(["recall", "--hint-format", "--session-id", "sess-1", "--root", home]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout.startsWith("TGMEM/2\n")).toBe(true);
    expect(first.stdout).toContain(`id=${a}`);
    expect(first.stdout).toContain(`id=${b}`);
    expect(recallLogRows().map(([factId, sessionId]) => [factId, sessionId]).sort()).toEqual([[a, "sess-1"], [b, "sess-1"]].sort());

    const delta = await runCli(["recall", "--hint-format", "--session-id", "sess-1", "--delta", "--root", home]);
    expect(delta.exitCode).toBe(0);
    expect(delta.stdout).toBe("TGMEM/2  delta=1\n");

    // Non-firing guard: the same session without --delta gets the complete block again.
    const full = await runCli(["recall", "--hint-format", "--session-id", "sess-1", "--root", home]);
    expect(full.exitCode).toBe(0);
    const factLines = full.stdout.split("\n").filter((line) => /^(pref|dec|fact|corr) {2}/u.test(line));
    expect(factLines.length).toBe(2);
    for (const line of factLines) {
      expect(line).toMatch(new RegExp(`id=(${a}|${b})`, "u"));
    }
    expect(full.stdout.startsWith("TGMEM/2\n")).toBe(true);
  });

  it("--stable writes nothing to recall_log even with a session id", async () => {
    await runCli(["remember", "a stable fact", "--kind", "fact", "--scope", "global"]);
    const result = await runCli(["recall", "--hint-format", "--session-id", "sess-1", "--stable", "--root", home]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("a stable fact");
    expect(recallLogRows()).toEqual([]);
  });

  it("mem epoch --gc prunes recall_log rows older than 30 days and reports the count, leaving recent rows alone", async () => {
    const id = extractRememberedId(await runCli(["remember", "a fact", "--kind", "fact", "--scope", "global"]));
    const db = openStorage(resolveDbPath());
    const insert = db.prepare("INSERT INTO recall_log (fact_id, session_id, surfaced_at) VALUES (?, ?, ?)");
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    insert.run(id, "old-a", new Date(now - 31 * day).toISOString());
    insert.run(id, "old-b", new Date(now - 400 * day).toISOString());
    insert.run(id, "recent", new Date(now - 29 * day).toISOString());
    db.close();

    const gc = await runCli(["epoch", "--gc"]);
    expect(gc.exitCode).toBe(0);
    expect(gc.stdout).toMatch(/pruned_audit_log_rows=\d+ {2}pruned_recall_log_rows=2\b/u);
    expect(recallLogRows().map(([, sessionId]) => sessionId)).toEqual(["recent"]);
  });

  it("a hard-deleted fact takes its recall_log rows with it (ON DELETE CASCADE); a soft `forget` keeps them until gc", async () => {
    const id = extractRememberedId(await runCli(["remember", "a fact to forget", "--kind", "fact", "--scope", "global"]));
    await runCli(["recall", "--hint-format", "--session-id", "sess-1", "--root", home]);
    expect(recallLogRows().map(([factId]) => factId)).toEqual([id]);

    // `forget` is a soft delete (status -> superseded): the row still exists, so its log survives.
    const forgotten = await runCli(["forget", id]);
    expect(forgotten.exitCode).toBe(0);
    expect(recallLogRows().map(([factId]) => factId)).toEqual([id]);

    // The GC path's hard delete is what actually removes the fact -- and, via the cascade, its log.
    const db = openStorage(resolveDbPath());
    try {
      expect(deleteFact(db, id)).toBe(true);
    } finally {
      db.close();
    }
    expect(recallLogRows()).toEqual([]);
  });

  it("migration: a store from before recall_log existed keeps working, and the table is created on first open", async () => {
    const id = extractRememberedId(await runCli(["remember", "a pre-migration fact", "--kind", "fact", "--scope", "global"]));
    // Reproduce a v0.3.2 store: everything else in place, no recall_log table at all.
    const raw = openDb(resolveDbPath());
    raw.exec("DROP TABLE recall_log");
    const before = raw.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'recall_log'").get()?.n;
    raw.close();
    expect(before).toBe(0);

    const result = await runCli(["recall", "--hint-format", "--session-id", "sess-1", "--root", home]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`id=${id}`);
    expect(recallLogRows().map(([factId, sessionId]) => [factId, sessionId])).toEqual([[id, "sess-1"]]);

    // The migrated store's pre-existing data is untouched.
    const listed = await runCli(["list"]);
    expect(listed.stdout).toContain("a pre-migration fact");
  });
});

describe("mem used (usefulness feedback)", () => {
  /** Surfaces every stored global fact to `sessionId` via the real hint-format path, so `recall_log` is populated the way production populates it. */
  async function surfaceAll(sessionId: string): Promise<void> {
    const result = await runCli(["recall", "--hint-format", "--session-id", sessionId, "--root", "."]);
    expect(result.exitCode).toBe(0);
  }

  function usedAtRows(): Array<{ fact_id: string; session_id: string; used_at: string | null }> {
    const db = openStorage(resolveDbPath());
    try {
      return db
        .prepare<[], { fact_id: string; session_id: string; used_at: string | null }>("SELECT fact_id, session_id, used_at FROM recall_log ORDER BY rowid")
        .all();
    } finally {
      db.close();
    }
  }

  it("marks a surfaced fact useful by short id prefix, reports the row count, and audit-logs it", async () => {
    const id = extractRememberedId(await runCli(["remember", "deploys happen on tuesdays", "--kind", "fact", "--scope", "global"]));
    await surfaceAll("session-alpha");

    // A prefix, not the full id: `mem used` has to resolve ids exactly like every other id-accepting
    // command, since the id a user has to hand is the truncated one `mem recall` prints.
    const marked = await runCli(["used", id.slice(0, 8), "--session-id", "session-alpha"]);

    expect(marked.exitCode).toBe(0);
    expect(marked.stdout).toBe("marked 1 recall row useful in session session-alpha\n");
    expect(marked.stderr).toBe("");
    expect(usedAtRows()).toEqual([{ fact_id: id, session_id: "session-alpha", used_at: expect.any(String) }]);

    const db = openStorage(resolveDbPath());
    const events = (db.prepare("SELECT event FROM audit_log WHERE fact_id = ? ORDER BY rowid").all(id) as { event: string }[]).map((row) => row.event);
    db.close();
    expect(events).toContain("used");
  });

  it("says so and exits 0 when the fact was never surfaced in that session, instead of crashing or silently marking nothing", async () => {
    const id = extractRememberedId(await runCli(["remember", "deploys happen on tuesdays", "--kind", "fact", "--scope", "global"]));
    await surfaceAll("session-alpha");

    const marked = await runCli(["used", id, "--session-id", "session-beta"]);

    expect(marked.exitCode).toBe(0);
    expect(marked.stdout).toContain(`note: ${id} was never surfaced in session session-beta`);
    expect(marked.stdout).toContain("marked 0 recall rows useful");
    // session-alpha's row is untouched: a wrong session id must not mark the right fact anyway.
    expect(usedAtRows()).toEqual([{ fact_id: id, session_id: "session-alpha", used_at: null }]);
  });

  it("distinguishes 'already marked' from 'never surfaced', since both update zero rows", async () => {
    const id = extractRememberedId(await runCli(["remember", "deploys happen on tuesdays", "--kind", "fact", "--scope", "global"]));
    await surfaceAll("session-alpha");
    await runCli(["used", id, "--session-id", "session-alpha"]);

    const again = await runCli(["used", id, "--session-id", "session-alpha"]);

    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("already marked useful in this session");
    expect(again.stdout).not.toContain("never surfaced");
  });

  it("requires --session-id and names it, since mem holds no notion of a current session to default to", async () => {
    const id = extractRememberedId(await runCli(["remember", "deploys happen on tuesdays", "--kind", "fact", "--scope", "global"]));

    const missing = await runCli(["used", id]);

    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("--session-id <id> is required");
    expect(missing.stdout).toBe("");
  });

  it("resolves every id before writing, so a bad id in a batch leaves none of the batch marked", async () => {
    const good = extractRememberedId(await runCli(["remember", "deploys happen on tuesdays", "--kind", "fact", "--scope", "global"]));
    await surfaceAll("session-alpha");

    const partial = await runCli(["used", good, "00000000-0000-4000-8000-000000000000", "--session-id", "session-alpha"]);

    expect(partial.exitCode).toBe(1);
    expect(partial.stderr).toContain("no such fact");
    expect(usedAtRows().every((row) => row.used_at === null)).toBe(true);
  });

  it("feeds the ranking: a confirmed-useful fact outranks one that merely ties it on BM25", async () => {
    // Both facts contain "deploy" exactly once in the same-length text, so BM25 ties them and the
    // default recency ordering puts the newer (`second`) first. Confirming the older one useful is
    // the only thing that can flip that, which is what makes this a test of the wiring rather than
    // of the ordering that was already there.
    const first = extractRememberedId(await runCli(["remember", "deploy runbook alpha", "--kind", "fact", "--scope", "global"]));
    const second = extractRememberedId(await runCli(["remember", "deploy runbook bravo", "--kind", "fact", "--scope", "global"]));

    const before = await runCli(["recall", "deploy", "--root", "."]);
    expect(before.stdout.indexOf(second.slice(0, 8))).toBeLessThan(before.stdout.indexOf(first.slice(0, 8)));

    await surfaceAll("session-alpha");
    await runCli(["used", first, "--session-id", "session-alpha"]);

    const after = await runCli(["recall", "deploy", "--root", "."]);
    expect(after.stdout.indexOf(first.slice(0, 8))).toBeLessThan(after.stdout.indexOf(second.slice(0, 8)));
  });
});
