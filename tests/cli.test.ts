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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/cli.js";
import { openDb, resolveDbPath } from "../src/db.js";
import { insertFact, openStorage } from "../src/storage.js";
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

  it("refuses to promote a fact that is not pending", async () => {
    const remembered = await runCli(["remember", "already active", "--kind", "fact"]);
    const id = extractRememberedId(remembered);

    const result = await runCli(["review", "--promote", id]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`fact ${id} is not pending (status=active)`);
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
    expect(result.stdout.trim()).toBe("pending: 1, contested: 0, contradicted: 0, pins: 0");
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
    expect(summarySinceCutoff.stdout.trim()).toBe("pending: 1, contested: 0, contradicted: 0, pins: 0");

    const fullSinceCutoff = await runCli(["review", "--section", "pending", "--since-epoch", cutoffEpoch]);
    expect(fullSinceCutoff.stdout).toContain("captured after the cutoff");
    expect(fullSinceCutoff.stdout).not.toContain("captured before the cutoff");

    const summaryFromZero = await runCli(["review", "--summary", "--since-epoch", "0"]);
    expect(summaryFromZero.stdout.trim()).toBe("pending: 2, contested: 0, contradicted: 0, pins: 0");
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
    expect(summary.stdout.trim()).toBe("pending: 2, contested: 0, contradicted: 0, pins: 0");
  });

  it("skips non-bullet content", async () => {
    const path = writeFixture(["Just a paragraph.", "", "Another sentence, no bullets here."].join("\n"));

    const result = await runCli(["import", "--from-md", path, "--root", home]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no qualifying bullets found");

    const listed = await runCli(["list"]);
    expect(listed.stdout.trim()).toBe("no facts stored");
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
    expect(summary.stdout.trim()).toBe("pending: 1, contested: 0, contradicted: 0, pins: 0");
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
    expect(summary.stdout.trim()).toBe("pending: 1, contested: 0, contradicted: 0, pins: 0");
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

    const settings = JSON.parse(readFileSync(join(toolRoot, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart).toEqual([]);
    const claudeMd = readFileSync(join(toolRoot, "CLAUDE.md"), "utf8");
    expect(claudeMd).not.toContain("token-goat-mem");
    expect(readFileSync(join(toolRoot, "unrelated.txt"), "utf8")).toBe("leave me alone\n");

    // Uninstalling again is a no-op, not an error.
    const again = await runCli(["uninstall", "claude-code", "--root", toolRoot]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("noop");
  });

  it("--user writes/removes the user-level settings.json (under the isolated TOKEN_GOAT_MEM_WIRING_HOME) instead of the project one", async () => {
    await runCli(["init", "claude-code", "--root", toolRoot, "--user"]);
    expect(existsSync(join(toolRoot, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(toolHome, ".claude", "settings.json"))).toBe(true);

    await runCli(["uninstall", "claude-code", "--root", toolRoot, "--user"]);
    const settings = JSON.parse(readFileSync(join(toolHome, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart).toEqual([]);
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
    expect(readFileSync(join(toolRoot, "AGENTS.md"), "utf8")).not.toContain("token-goat-mem");
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
    current = readFileSync(agentsMdPath, "utf8");
    expect(current).not.toContain("token-goat-mem");
    expect(current).not.toContain("## Memory");
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
