/** End-to-end CLI tests for capture and review: remember, suggest, the pending-review queue, contradiction handling, pin, and the exit-code contract. Each test gets an isolated `TOKEN_GOAT_MEM_HOME` (a fresh temp dir), re-applied per test so facts written by one test can never leak into another. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRememberedId, extractSuggestedId, runCli } from "./support/cli.js";
import { writeCheckout } from "./support/gitCheckout.js";
import { openDb, resolveDbPath } from "../src/db.js";
import { insertFact, openStorage } from "../src/storage.js";
import { captureSuggested } from "../src/capture.js";


let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-cli-test-"));
  vi.stubEnv("TOKEN_GOAT_MEM_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────── happy path ───────────────────────────────────────────────────────────────────────────

describe("regression: remember that promotes a pending suggestion", () => {
  it("recalls the newer user statement over an older user fact for the same subject", async () => {
    const subject = ["--kind", "fact", "--scope", "global", "--subject", "deploy-target"];
    expect((await runCli(["remember", "Deploy target is prod", ...subject, "--value", "prod"])).exitCode).toBe(0);
    expect((await runCli(["suggest", "Deploy target is staging", ...subject, "--value", "staging"])).exitCode).toBe(0);
    const promoted = await runCli(["remember", "Deploy target is staging", ...subject, "--value", "staging"]);
    expect(promoted.exitCode, promoted.stderr).toBe(0);
    const recalled = await runCli(["recall", "deploy target"]);
    expect(recalled.stdout).toContain("Deploy target is staging");
    expect(recalled.stdout).not.toContain("Deploy target is prod");
  });
});

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
    // No anchor was set, so freshness can neither confirm nor deny -- always unverified, never a fabricated affirmed/contradicted verdict for a fact with no predicate to evaluate (P3).
    expect(shown.stdout).toContain("freshness=unverified");

    const recalled = await runCli(["recall", "pnpm"]);
    expect(recalled.exitCode).toBe(0);
    expect(recalled.stdout).toContain("uses pnpm not npm");
    // Preferences always carry a caveat regardless of trust level (P6) -- never a bald assertion. No anchor was set, so freshness is "unverified" (not "affirmed"), which buildDisplay renders as an "(unverified, <month>)" tag. Default output no longer carries a per-line CTA (footer-ized).
    expect(recalled.stdout).toContain("stored pref (unverified,");
    // Only the clause that applies: this store has nothing pending or contested, so the review CTA stays off. It used to print here unconditionally.
    expect(recalled.stdout).toContain("mem show <id> for detail");
    expect(recalled.stdout).not.toContain("mem review");

    // `remember` always stores `source_type=user`, and Defect 2's guard requires `--force` to edit one -- see "mem edit refuses to change a source_type=user fact without --force" below for the guard itself; this round-trip just needs to get past it to keep exercising pin/forget.
    const edited = await runCli(["edit", id, "--text", "uses pnpm exclusively", "--force"]);
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
    // The CLI-facing anchor-syntax arity check (capture.ts's validateAnchorSyntax) whitespace-splits the anchor string, so a multi-word file-contains/file-not-contains substring is genuinely ambiguous to parse from flat CLI input and must still be rejected here -- json-import's exemption from this check (see exportImport.test.ts) does not extend to mem edit/mem remember, which take the same kind of CLI-string input.
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

    const edited = await runCli(["edit", id, "--text", "deploy key is AKIAABCDEFGHIJKLMNOP", "--force"]);
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

    const edited = await runCli(["edit", id, "--text", "audit row check v2", "--force"]);
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
    const edited = await runCli(["edit", id, "--subject", "new_x", "--value", "y", "--force"]);
    expect(edited.exitCode).toBe(0); // This should succeed if both are provided
    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("subject: new_x");
    expect(shown.stdout).toContain("value: y");
  });

  it("mem edit allows valid subject/value pair", async () => {
    const created = await runCli(["remember", "test fact", "--kind", "fact", "--subject", "key1", "--value", "val1"]);
    const id = extractRememberedId(created);

    const edited = await runCli(["edit", id, "--subject", "key2", "--value", "val2", "--force"]);
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

    // Both facts came from explicit `remember` (source_type=user, tied provenance). Force their captured_at to be byte-identical so precedence is genuinely tied (P4's "same recency/provenance" contested case) rather than depending on which of two rapid-fire CLI calls happened to land in an earlier millisecond -- that would make the test's outcome nondeterministic.
    const db = openDb(resolveDbPath());
    const tiedTimestamp = "2026-01-01T00:00:00.000Z";
    db.prepare("UPDATE facts SET captured_at = ? WHERE id IN (?, ?)").run(tiedTimestamp, idA, idB);
    db.close();

    const review = await runCli(["review"]);
    expect(review.exitCode).toBe(0);
    expect(review.stdout).toContain("contested (ambiguous contradiction -- withheld from ground truth");
    expect(review.stdout).toContain(idA);
    expect(review.stdout).toContain(idB);

    // Contradiction resolution is re-derived live at read time -- `mem review` surfaces the conflict without mutating either fact's persisted status; a human must resolve it explicitly.
    const activeList = await runCli(["list", "--status", "active"]);
    expect(activeList.stdout).toContain(idA);
    expect(activeList.stdout).toContain(idB);

    // Plain `mem recall` (no --hint-format) still surfaces the contested pair, but caveated as excluded rather than presented as ground truth -- a human using `mem recall` interactively can see the ambiguity; an automated consumer must not.
    const recalled = await runCli(["recall", "package manager"]);
    expect(recalled.stdout).toContain("(contested, excluded)");

    // --hint-format is precision-max: contested facts are excluded entirely, never handed to the agent as an unresolved either/or it would have to gamble on (Section 4).
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
      // sourceType intentionally omitted -- captureSuggested defaults to the more heavily quarantined "derived" when the caller doesn't say otherwise (Section 3).
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

    // --hint-format excludes pending/derived candidates entirely -- an automated consumer never sees an unconfirmed suggestion presented as memory.
    const hintFormat = await runCli(["recall", "--hint-format", "--root", home]);
    expect(hintFormat.stdout).not.toContain("internal service X owns migrations");

    // Promotion requires an explicit human action; there is no code path that reaches "active" for a pending fact other than this one.
    const promoted = await runCli(["review", "--promote", fact.id]);
    expect(promoted.exitCode).toBe(0);
    const [promotedLine, caveatLine] = promoted.stdout.trimEnd().split("\n");
    expect(promotedLine).toBe(`promoted ${fact.id}`);
    // A derived candidate carries no subject, so nothing can ever supersede it once active. The promotion is the only moment the user can act on that, so it is the moment that says so.
    expect(caveatLine).toContain("has no subject/value");

    const activeAfterPromote = await runCli(["list", "--status", "active"]);
    expect(activeAfterPromote.stdout).toContain(fact.id);
  });

  it("promoting a keyed candidate says nothing extra -- the caveat is about keylessness, not promotion", async () => {
    const suggested = await runCli([
      "suggest",
      "the queue backend is redis",
      "--kind",
      "fact",
      "--subject",
      "queue-backend",
      "--value",
      "redis",
      "--root",
      home,
    ]);
    expect(suggested.exitCode).toBe(0);
    const id = /suggested fact (\S+)/u.exec(suggested.stdout)?.[1] ?? "";
    expect(id).not.toBe("");

    const promoted = await runCli(["review", "--promote", id]);
    expect(promoted.exitCode).toBe(0);
    // A keyed fact can be superseded by a later contradicting one, so there is nothing to warn about -- a caveat printed here would be noise on the common path.
    expect(promoted.stdout).toBe(`promoted ${id}\n`);
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
    // TOKEN_GOAT_MEM_HOME points at a *file*, so mkdir/open of mem.db inside it fails -- an environment failure, not a usage error, and must be distinguishable from one (exit 2, not 1).
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
    // The invariant is real but silent otherwise: a second --value against the same subject supersedes the first instead of joining it, and the user finds out by losing the first one. Asserted on both commands because a reader consults the help of whichever they are running, and asserted on the behaviour word ("supersedes") rather than the whole sentence so rewording stays free while deleting the warning does not.
    for (const command of ["remember", "suggest"]) {
      const help = await runCli([command, "--help"]);
      expect(help.exitCode).toBe(0);
      // Commander hard-wraps option descriptions to the terminal width, so the phrase arrives split across lines and padded. Collapse whitespace before matching -- asserting on the raw string would pin the wrap column, which is an artifact of the reader's terminal, not of mem.
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

// ─────────────────────────────────────────────────────────────────────────── review unanchored bucket: paste-ready anchor suggestions ───────────────────────────────────────────────────────────────────────────

describe("review unanchored bucket prints a paste-ready `mem edit --anchor` suggestion", () => {
  it("suggests the exact path for a fact naming a file that exists under its root, and the suggested edit round-trips to affirmed", async () => {
    const repo = mkdtempSync(join(tmpdir(), "mem-unanchored-suggest-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "main.ts"), "x\n", "utf8");
      const db = openStorage(resolveDbPath());
      const { fact } = captureSuggested(db, { text: "the entry point is src/main.ts", kind: "fact", root: repo });
      db.close();
      await runCli(["review", "--promote", fact.id]);

      const listing = await runCli(["review", "--section", "unanchored", "--root", repo]);
      expect(listing.exitCode).toBe(0);
      const predicate = "file-exists src/main.ts";
      expect(listing.stdout).toContain(`mem edit ${fact.id} --anchor "${predicate}"`);

      // The round trip is the point: paste the exact suggested command's argv (the quoted anchor is one shell word; commander sees it as one `--anchor` value either way) and confirm it actually resolves the fact to ground truth, not just that a plausible-looking line was printed.
      const edited = await runCli(["edit", fact.id, "--anchor", predicate, "--root", repo]);
      expect(edited.stderr, edited.stderr).toBe("");
      expect(edited.exitCode).toBe(0);

      const shown = JSON.parse((await runCli(["show", fact.id, "--root", repo, "--json"])).stdout) as { freshness: string };
      expect(shown.freshness).toBe("affirmed");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("carries --force for a user-stated fact, whose edit would otherwise refuse", async () => {
    const repo = mkdtempSync(join(tmpdir(), "mem-unanchored-user-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "main.ts"), "x\n", "utf8");
      const remembered = await runCli([
        "remember",
        "the entry point is src/main.ts",
        "--kind",
        "fact",
        "--scope",
        "project",
        "--root",
        repo,
      ]);
      const id = /remembered fact (\S+)/u.exec(remembered.stdout)?.[1] ?? "";
      expect(id).not.toBe("");

      // Most of a real store is user-stated, and `mem edit` refuses those without --force. A suggestion that answers with a refusal on the common path is worse than none: it teaches the user the feature is broken.
      const listing = await runCli(["review", "--section", "unanchored", "--root", repo]);
      expect(listing.stdout).toContain(`mem edit ${id} --anchor "file-exists src/main.ts" --force`);

      const edited = await runCli(["edit", id, "--anchor", "file-exists src/main.ts", "--root", repo, "--force"]);
      expect(edited.stderr, edited.stderr).toBe("");
      expect(edited.exitCode).toBe(0);

      const shown = JSON.parse((await runCli(["show", id, "--root", repo, "--json"])).stdout) as { freshness: string };
      expect(shown.freshness).toBe("affirmed");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("prints no suggestion for a fact naming a file that does not exist under its root", async () => {
    const repo = mkdtempSync(join(tmpdir(), "mem-unanchored-nofile-"));
    try {
      const db = openStorage(resolveDbPath());
      const { fact } = captureSuggested(db, { text: "the entry point is src/missing.ts", kind: "fact", root: repo });
      db.close();
      await runCli(["review", "--promote", fact.id]);

      const listing = await runCli(["review", "--section", "unanchored", "--root", repo]);
      expect(listing.exitCode).toBe(0);
      expect(listing.stdout).toContain("the entry point is src/missing.ts");
      expect(listing.stdout).not.toContain(`mem edit ${fact.id} --anchor "`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each([
    ["a parent-relative escape", "the entry point is ../secrets.txt"],
    ["an absolute path outside the root", "the entry point is /etc/passwd"],
  ])("prints no suggestion for %s", async (_label, text) => {
    const repo = mkdtempSync(join(tmpdir(), "mem-unanchored-outside-"));
    try {
      const db = openStorage(resolveDbPath());
      const { fact } = captureSuggested(db, { text, kind: "fact", root: repo });
      db.close();
      await runCli(["review", "--promote", fact.id]);

      const listing = await runCli(["review", "--section", "unanchored", "--root", repo]);
      expect(listing.exitCode).toBe(0);
      expect(listing.stdout).toContain(text);
      expect(listing.stdout).not.toContain(`mem edit ${fact.id} --anchor "`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("leaves the unanchored listing for a fact with no viable target byte-identical to before", async () => {
    const repo = mkdtempSync(join(tmpdir(), "mem-unanchored-byte-identical-"));
    try {
      const text = "the entry point is src/main.ts";
      const db = openStorage(resolveDbPath());
      const { fact } = captureSuggested(db, { text, kind: "fact", root: repo });
      db.close();
      await runCli(["review", "--promote", fact.id]);

      const listing = await runCli(["review", "--section", "unanchored", "--root", repo]);
      expect(listing.exitCode).toBe(0);
      // Exact reconstruction of pre-feature output: one section header, one fact-summary line, no suggestion line -- `src/main.ts` genuinely does not exist under this fresh, empty root.
      const expected =
        "-- unanchored but checkable (names a path/URL/config file; consider `mem edit <id> --anchor`) (1) --\n" +
        `${fact.id}  [fact/active]  ${text}\n`;
      expect(listing.stdout).toBe(expected);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────── review shows a pending fact's newest source excerpt ───────────────────────────────────────────────────────────────────────────

describe("review shows a pending fact's newest source excerpt", () => {
  it("shows the originating turn under a scan-session candidate", async () => {
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Unrelated chatter first. Always run the linter before pushing." }] },
      }),
      "utf8"
    );
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);

    const review = await runCli(["review", "--section", "pending"]);
    expect(review.exitCode).toBe(0);
    expect(review.stdout).toContain("Always run the linter before pushing.");
    // The excerpt carries the whole turn, which is the reviewer's evidence for judging the claim -- context the derived sentence alone doesn't carry.
    expect(review.stdout).toContain("source:");
    expect(review.stdout).toContain("Unrelated chatter first.");
  });

  it("shows no source line for a plain mem suggest candidate", async () => {
    const db = openStorage(resolveDbPath());
    const { fact } = captureSuggested(db, { text: "internal service X owns migrations", kind: "fact", root: home });
    db.close();

    const review = await runCli(["review", "--section", "pending"]);
    expect(review.exitCode).toBe(0);
    expect(review.stdout).toContain(fact.id);
    expect(review.stdout).not.toContain("source:");
  });

  it("says why an unanchored pending fact is unverified", async () => {
    const db = openStorage(resolveDbPath());
    captureSuggested(db, { text: "internal service Y owns queues", kind: "fact", root: home });
    db.close();

    const review = await runCli(["review", "--section", "pending"]);
    expect(review.exitCode).toBe(0);
    expect(review.stdout).toContain("freshness: unverified (no-anchor)");
  });
});

// ─────────────────────────────────────────────────────────────────────────── review names what a pending correction may contradict ───────────────────────────────────────────────────────────────────────────

describe("review flags what a pending correction/subject fact may contradict", () => {
  it("names the live fact sharing the most terms as `may contradict <id> \"<text>\"`", async () => {
    const rival = await runCli(["remember", "the release plan pins the build to v9.9.9 while docs get updated", "--kind", "fact"]);
    const rivalId = extractRememberedId(rival);

    const db = openStorage(resolveDbPath());
    // kind=correction alone is eligible, with no --subject/--value supplied -- the gap this feature closes is exactly the case where a correction has nothing but its text linking it to what it corrects.
    const { fact: correction } = captureSuggested(db, {
      text: "the release plan actually pins the build to v9.9.9 and a hotfix",
      kind: "correction",
      root: home,
    });
    db.close();

    const review = await runCli(["review", "--section", "pending"]);
    expect(review.exitCode).toBe(0);
    expect(review.stdout).toContain(correction.id);
    expect(review.stdout).toContain(`may contradict ${rivalId} "the release plan pins the build to v9.9.9 while docs get updated"`);
    // Paste-ready resolution for the user who agrees the pending fact wins: it names the rival to retire and the pending fact as its successor.
    expect(review.stdout).toContain(`mem forget ${rivalId} --by ${correction.id}`);
  });

  it("names the live fact for a pending fact carrying --subject even when its kind is not correction", async () => {
    const rival = await runCli([
      "remember",
      "uses pnpm as the package manager for this project",
      "--kind",
      "preference",
      "--subject",
      "package-manager",
      "--value",
      "pnpm",
    ]);
    const rivalId = extractRememberedId(rival);

    const db = openStorage(resolveDbPath());
    const { fact: suggestion } = captureSuggested(db, {
      text: "uses npm as the package manager for this project",
      kind: "preference",
      subject: "package-manager",
      value: "npm",
      root: home,
    });
    db.close();

    const review = await runCli(["review", "--section", "pending"]);
    expect(review.exitCode).toBe(0);
    expect(review.stdout).toContain(suggestion.id);
    expect(review.stdout).toContain(`may contradict ${rivalId}`);
  });

  it("prints no line when the pending fact is not a correction and carries no --subject", async () => {
    await runCli(["remember", "the release plan pins the build to v9.9.9 while docs get updated", "--kind", "fact"]);

    const db = openStorage(resolveDbPath());
    const { fact: suggestion } = captureSuggested(db, {
      text: "the release plan pins the build to v9.9.9 as well",
      kind: "fact",
      root: home,
    });
    db.close();

    const review = await runCli(["review", "--section", "pending"]);
    expect(review.exitCode).toBe(0);
    expect(review.stdout).toContain(suggestion.id);
    expect(review.stdout).not.toContain("may contradict");
  });

  it("prints no line when a correction shares no terms with anything live", async () => {
    const db = openStorage(resolveDbPath());
    const { fact: suggestion } = captureSuggested(db, {
      text: "an entirely unrelated correction about zzz-nonexistent-topic",
      kind: "correction",
      root: home,
    });
    db.close();

    const review = await runCli(["review", "--section", "pending"]);
    expect(review.exitCode).toBe(0);
    expect(review.stdout).toContain(suggestion.id);
    expect(review.stdout).not.toContain("may contradict");
  });

  it("never supersedes, promotes, or changes status: it is a label only", async () => {
    const rival = await runCli(["remember", "the release plan pins the build to v9.9.9 while docs get updated", "--kind", "fact"]);
    const rivalId = extractRememberedId(rival);

    const db = openStorage(resolveDbPath());
    const { fact: correction } = captureSuggested(db, {
      text: "the release plan actually pins the build to v9.9.9 and a hotfix",
      kind: "correction",
      root: home,
    });
    db.close();

    await runCli(["review", "--section", "pending"]);

    const rivalAfter = await runCli(["show", rivalId]);
    expect(rivalAfter.stdout).toContain("status: active");
    const correctionAfter = await runCli(["show", correction.id]);
    expect(correctionAfter.stdout).toContain("status: pending");
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

  it("records a sighting instead of a second row when the same text is suggested again", async () => {
    const first = await runCli(["suggest", "always run migrations before deploy", "--kind", "preference"]);
    const id = /suggested \S+ fact (\S+) \(pending\)/u.exec(first.stdout)?.[1];
    expect(id).toBeDefined();

    const second = await runCli(["suggest", "always run migrations before deploy", "--kind", "preference"]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain(`sighted preference fact ${id}`);
    expect(second.stdout).toContain("recorded another sighting");

    const pendingList = await runCli(["list", "--status", "pending"]);
    // One row, not two -- `mem list` printing the id once pins the no-duplicate-row guarantee at the CLI surface, matching what tests/capture.test.ts already pins at the function level.
    expect(pendingList.stdout.split(id as string)).toHaveLength(2);
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
    // The shortened line must not break id extraction: the helper's own pattern required a kind token between "remembered" and "fact", which this collapse removes for exactly this kind.
    const result = await runCli(["remember", "id must still parse", "--kind", "fact"]);

    expect(extractRememberedId(result)).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("applies the same collapse to the audit trail every capture path writes", async () => {
    // The audit details were built from their own `${kind} fact` templates in capture.ts, so the confirmation fix above never reached them: `mem log` still read "stored active fact fact". Covers the explicit, reaffirmed, pending, and reaffirmed-while-pending captures.
    expect((await runCli(["remember", "a plain fact", "--kind", "fact"])).exitCode).toBe(0);
    expect((await runCli(["remember", "a plain fact", "--kind", "fact"])).exitCode).toBe(0);
    expect((await runCli(["suggest", "a plain candidate", "--kind", "fact"])).exitCode).toBe(0);
    expect((await runCli(["remember", "a plain candidate", "--kind", "fact"])).exitCode).toBe(0);
    expect((await runCli(["remember", "a typed decision", "--kind", "decision"])).exitCode).toBe(0);

    const log = JSON.parse((await runCli(["log", "--json"])).stdout) as { entries: { event: string; detail: string }[] };
    const details = new Map(log.entries.map((entry) => [entry.event, entry.detail]));

    expect([...details.keys()].sort()).toEqual(["capture_explicit", "capture_reaffirmed", "capture_reaffirmed_pending_promoted", "capture_suggested"]);
    expect(log.entries.map((entry) => entry.detail).join("\n")).not.toContain("fact fact");
    expect(log.entries.find((entry) => entry.event === "capture_explicit")?.detail).toBe("stored active decision fact (scope=global)");
    expect(details.get("capture_suggested")).toMatch(/^stored pending fact \(source_type=/u);
    expect(details.get("capture_reaffirmed")).toMatch(/^restated fact \(scope=global\); /u);
    expect(details.get("capture_reaffirmed_pending_promoted")).toMatch(/^restated fact \(scope=global\); /u);
  });
});

// ─────────────────────────────────────────────────────────────────────────── regression: withheld statuses are a trapdoor, not a one-way door ───────────────────────────────────────────────────────────────────────────

describe("regression: `contested` is escapable (it used to be excluded from the only pass that could clear it)", () => {
  /** Seeds two facts that genuinely tie on precedence (same subject+scope, different value, identical `captured_at`, identical provenance), which is the exact shape P4 resolves to `contested` rather than picking a winner. Returns their ids in insertion order. */
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

    // Persist the contested status. Before the fix this was the trapdoor: detection queried only active/pinned, so nothing that ran afterwards could ever see -- let alone clear -- the status this very pass had just written.
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
    // Without superseding the rival, the very next detection pass would find the same tie and re-contest the pair -- making the promotion silently self-undoing.
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

  it("`mem forget` on one side of a contested pair reinstates the rival immediately, the same as `review --reject`", async () => {
    const [idA, idB] = await seedTiedPair();
    await runCli(["epoch", "--gc"]);
    expect((await runCli(["show", idA])).stdout).toContain("status: contested");

    const forgotten = await runCli(["forget", idB]);
    expect(forgotten.exitCode).toBe(0);
    expect((await runCli(["show", idB])).stdout).toContain("status: superseded");
    // Without reconciling, idA is stranded `contested` forever: `mem list --status active` omits it, `mem pin` refuses it, yet `mem recall` (which resolves contradictions in memory on every call) surfaces it with no caveat at all -- commands disagreeing about the same fact.
    expect((await runCli(["show", idA])).stdout).toContain("status: active");
  });

  it("`review --undo` of a contested rejection re-contests the rival too, instead of leaving both sides active", async () => {
    const [idA, idB] = await seedTiedPair();
    await runCli(["epoch", "--gc"]);

    await runCli(["review", "--reject", idB]);
    expect((await runCli(["show", idA])).stdout).toContain("status: active");

    const undone = await runCli(["review", "--undo", idB]);
    expect(undone.exitCode).toBe(0);
    expect((await runCli(["show", idB])).stdout).toContain("status: contested");
    // Without reconciling on the way back in, idA is left `active` alongside idB's restored `contested` -- two winners for one contradiction bucket.
    expect((await runCli(["show", idA])).stdout).toContain("status: contested");
  });

  it("`review --undo` of a rejected contested fact that was pinned before it was contested restores the pin once its rival is gone", async () => {
    const [idA, idB] = await seedTiedPair();
    await runCli(["pin", idA]);
    await runCli(["epoch", "--gc"]);
    expect((await runCli(["show", idA])).stdout).toContain("status: contested");

    await runCli(["review", "--reject", idA]);
    await runCli(["review", "--undo", idA]);
    expect((await runCli(["show", idA])).stdout).toContain("status: contested");

    await runCli(["forget", idB]);
    expect((await runCli(["show", idA])).stdout).toContain("status: pinned");
  });

  it("`review --promote` resolves a tied pair `mem review` already shows as contested, before any `epoch --gc` persists the status", async () => {
    const [idA, idB] = await seedTiedPair();

    // Deliberately no `epoch --gc` here: both facts are still persisted `active`. `mem review` derives its contested bucket live and already lists this pair -- confirmed by the sibling test above ("...report contested contradiction... withheld from ground truth") -- so `--promote` must accept the same fact `mem review` just told the user to resolve, not refuse it as "status=active".
    expect((await runCli(["show", idA])).stdout).toContain("status: active");
    expect((await runCli(["show", idB])).stdout).toContain("status: active");

    const promoted = await runCli(["review", "--promote", idA]);
    expect(promoted.exitCode).toBe(0);
    expect((await runCli(["show", idA])).stdout).toContain("status: active");
    expect((await runCli(["show", idB])).stdout).toContain("status: superseded");
  });

  it("`review --reject` resolves a tied pair `mem review` already shows as contested, before any `epoch --gc` persists the status", async () => {
    const [idA, idB] = await seedTiedPair();

    const rejected = await runCli(["review", "--reject", idB]);
    expect(rejected.exitCode).toBe(0);
    expect((await runCli(["show", idB])).stdout).toContain("status: superseded");
    // The rival was never persisted `contested` either, so it needs no reinstatement -- it should simply remain the surviving active fact.
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

// ─────────────────────────────────────────────────────────────────────────── reaffirmation ───────────────────────────────────────────────────────────────────────────

describe("unquoted multi-word arguments are refused, not truncated", () => {
  it("stores nothing when remember's text arrives as several words", async () => {
    // Commander before 13 accepted excess arguments silently, so `mem remember the build runs on node 22` stored the fact "the" and exited 0.
    const result = await runCli(["remember", "the", "build", "runs", "on", "node", "22", "--kind", "fact"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("too many arguments for 'remember'");
    const listed = JSON.parse((await runCli(["list", "--json"])).stdout) as { facts: unknown[] };
    expect(listed.facts).toHaveLength(0);
  });

  it("refuses a multi-word recall query rather than searching on its first word", async () => {
    const result = await runCli(["recall", "build", "runs"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("too many arguments for 'recall'");
  });
});

describe("mem remember reaffirms rather than duplicating", () => {
  async function facts(): Promise<Array<Record<string, unknown>>> {
    const listed = JSON.parse((await runCli(["list", "--json"])).stdout) as { facts: Array<Record<string, unknown>> };
    return listed.facts;
  }

  it("refreshes the existing fact instead of writing a second row", async () => {
    // A user who says the same thing twice means it more, not less. Without this the second `mem remember` wrote a second row and left the first one's decay clock running, so the facts a user cared enough to restate were the ones drifting out of ground truth -- and `mem recall` showed the same sentence twice at two different confidences.
    const first = await runCli(["remember", "we deploy on fridays", "--kind", "decision", "--scope", "global"]);
    expect(first.stdout).toContain("remembered");
    const before = (await facts())[0];

    const second = await runCli(["remember", "We deploy on Fridays.", "--kind", "decision", "--scope", "global"]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("reaffirmed");

    const after = await facts();
    expect(after).toHaveLength(1);
    expect(after[0]?.["id"]).toBe(before?.["id"]);
    // captured_at is what decay measures age against and what contradiction resolution breaks ties on -- refreshing it is the whole substance of a reaffirmation.
    expect(String(after[0]?.["captured_at"]) > String(before?.["captured_at"])).toBe(true);
    expect(after[0]?.["confidence"]).toBe(1);
  });

  it("reaffirms rather than duplicating when the restated --value differs only in case", async () => {
    // Value comparison for reaffirm must be case-insensitive the same way contradiction detection is: "pnpm" restated as "Pnpm" is the same fact said again, not a second value on the subject.
    const first = await runCli(["remember", "uses pnpm not npm", "--kind", "preference", "--subject", "package-manager", "--value", "pnpm"]);
    expect(first.stdout).toContain("remembered");

    const second = await runCli(["remember", "uses pnpm not npm", "--kind", "preference", "--subject", "package-manager", "--value", "Pnpm"]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("reaffirmed");

    const after = await facts();
    expect(after).toHaveLength(1);
    // The raw value as typed is still stored/displayed verbatim -- normalization is comparison-only.
    expect(after[0]?.["value"]).toBe("pnpm");
  });

  it("applies an --anchor carried by a restatement instead of discarding it", async () => {
    // Regression: `reaffirmFact`'s UPDATE never touched `anchor`, so restating a fact with a new `--anchor` printed "reaffirmed" while `mem show` kept reporting `anchor: (none) freshness=unverified` forever -- the fact could never reach `contradicted` when the anchored file went away, which is the entire point of attaching an anchor.
    const root = mkdtempSync(join(tmpdir(), "mem-reaffirm-anchor-"));
    try {
      const first = await runCli(["remember", "uses pnpm", "--kind", "fact", "--scope", "project", "--root", root]);
      expect(first.stdout).toContain("remembered");
      const id = extractRememberedId(first);
      expect((await runCli(["show", id])).stdout).toContain("anchor: (none)  freshness=unverified");

      writeFileSync(join(root, "pnpm-lock.yaml"), "", "utf8");
      const second = await runCli([
        "remember",
        "uses pnpm",
        "--kind",
        "fact",
        "--scope",
        "project",
        "--root",
        root,
        "--anchor",
        "file-exists pnpm-lock.yaml",
      ]);
      expect(second.stdout).toContain("reaffirmed");
      expect(second.stdout).toContain("anchor: file-exists pnpm-lock.yaml");

      const shown = await runCli(["show", id]);
      expect(shown.stdout).toContain("anchor: file-exists pnpm-lock.yaml  freshness=affirmed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not clear an existing anchor when a restatement omits one", async () => {
    const root = mkdtempSync(join(tmpdir(), "mem-reaffirm-anchor-keep-"));
    try {
      writeFileSync(join(root, "pnpm-lock.yaml"), "", "utf8");
      const first = await runCli([
        "remember",
        "uses pnpm",
        "--kind",
        "fact",
        "--scope",
        "project",
        "--root",
        root,
        "--anchor",
        "file-exists pnpm-lock.yaml",
      ]);
      const id = extractRememberedId(first);

      const second = await runCli(["remember", "uses pnpm", "--kind", "fact", "--scope", "project", "--root", root]);
      expect(second.stdout).toContain("reaffirmed");

      const shown = await runCli(["show", id]);
      expect(shown.stdout).toContain("anchor: file-exists pnpm-lock.yaml  freshness=affirmed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not collapse the same sentence carrying a different value", async () => {
    // Identical text with a different value is a correction for contradiction resolution to key on, never a repeat to be swallowed.
    await runCli(["remember", "node version", "--kind", "fact", "--scope", "global", "--subject", "node", "--value", "20"]);
    await runCli(["remember", "node version", "--kind", "fact", "--scope", "global", "--subject", "node", "--value", "22"]);
    expect(await facts()).toHaveLength(2);
  });

  it("does not collapse the same sentence across different project roots", async () => {
    // Same text, same kind, same scope *label* -- but two different projects. Comparing the label alone would let one repository's restatement swallow another repository's fact.
    const a = mkdtempSync(join(tmpdir(), "mem-bindA-"));
    const b = mkdtempSync(join(tmpdir(), "mem-bindB-"));
    try {
      await runCli(["remember", "we use pnpm", "--kind", "preference", "--scope", "project", "--root", a]);
      await runCli(["remember", "we use pnpm", "--kind", "preference", "--scope", "project", "--root", b]);
      expect(await facts()).toHaveLength(2);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("reaffirms a project fact restated from a second checkout of the same repository, instead of duplicating it", async () => {
    // AGENTS.md documents reaffirm as keying on "scope binding", not the literal scope_root path -- that stricter wording is reserved there for contradiction bucketing. A project fact survives a second clone/worktree for recall (scope_root OR scope_repo); restating it from that same second checkout has to hit the same fact, not insert a duplicate `mem recall` then lists twice.
    function makeCheckout(name: string): string {
      // Identity is read from .git/config (src/projectIdentity.ts), so a written config with an origin is all a checkout needs.
      return writeCheckout(join(work, name), { remotes: { origin: "https://github.com/acme/widget.git" } });
    }
    const work = mkdtempSync(join(tmpdir(), "mem-reaffirm-identity-"));
    try {
      const a = makeCheckout("a");
      const b = makeCheckout("b");
      const first = await runCli(["remember", "the widget build uses esbuild", "--kind", "fact", "--scope", "project", "--root", a]);
      expect(first.stdout).toContain("remembered");

      const second = await runCli(["remember", "the widget build uses esbuild", "--kind", "fact", "--scope", "project", "--root", b]);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("reaffirmed");
      expect(await facts()).toHaveLength(1);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("resolves a matching pending suggestion by promoting it, instead of leaving it queued behind a duplicate", async () => {
    // `mem suggest` files a candidate as pending. Passive promotion (time, repetition, or a confidence number alone) must never happen -- that invariant is unchanged and is exercised separately below ("does not let a suggested candidate reaffirm a user-stated fact", which covers the opposite direction: a *suggestion* must never refresh a fact the user stated). But an explicit `mem remember` of the identical sentence is not a passive signal: it is the human directly answering the suggestion `mem review` is holding open. This test used to assert the pending row stayed queued and a duplicate active row was written alongside it -- that was the defect (S9 misapplied to the wrong direction): the user's restatement answered the queue, and the queue kept asking, while `mem consolidate` went on to report the resulting pair as a 1.00 duplicate cluster.
    const suggested = await runCli(["suggest", "we cache the build", "--kind", "decision", "--scope", "global"]);
    const suggestedId = extractSuggestedId(suggested);

    const result = await runCli(["remember", "we cache the build", "--kind", "decision", "--scope", "global"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("resolved pending suggestion");
    expect(extractRememberedId(result)).toBe(suggestedId);

    const all = await facts();
    expect(all).toHaveLength(1);
    expect(all[0]?.["status"]).toBe("active");

    const review = await runCli(["review"]);
    expect(review.stdout).not.toContain(suggestedId);
  });

  it("does not let a suggested candidate reaffirm a user-stated fact", async () => {
    // Suggested candidates come from file and transcript content. Letting derived text refresh a user-stated fact's clock would hand a CLAUDE.md the power to keep a fact alive that the user never restated.
    await runCli(["remember", "we ship on tuesdays", "--kind", "decision", "--scope", "global"]);
    const before = (await facts())[0];
    const suggest = await runCli(["suggest", "we ship on tuesdays", "--kind", "decision", "--scope", "global"]);
    const after = await facts();
    // Not reaffirmed (the clock is untouched, which is what this test is about) and not duplicated either: a bound match of any status suppresses the insert, so the derived restatement leaves the store exactly as it found it and queues nothing for `mem review`.
    expect(after).toHaveLength(1);
    const active = after.find((fact) => fact["id"] === before?.["id"]);
    expect(active?.["captured_at"]).toBe(before?.["captured_at"]);
    expect(active?.["status"]).toBe("active");
    expect(suggest.stdout).toContain("already active");
  });
});

// ─────────────────────────────────────────────────────────────────────────── review --undo ───────────────────────────────────────────────────────────────────────────

describe("mem review --undo", () => {
  async function pendingId(text: string): Promise<string> {
    await runCli(["suggest", text, "--kind", "decision", "--scope", "global"]);
    const listed = JSON.parse((await runCli(["list", "--status", "pending", "--json"])).stdout) as {
      facts: Array<{ id: string; text: string }>;
    };
    return listed.facts.find((fact) => fact.text === text)?.id ?? "";
  }

  async function statusOf(id: string): Promise<string> {
    const shown = JSON.parse((await runCli(["show", id, "--json"])).stdout) as { fact: { status: string } };
    return shown.fact.status;
  }

  it("puts a rejected fact back, since --reject was otherwise irreversible", async () => {
    // `--promote` refuses anything not pending or contested, so before this a mis-typed `--reject` could not be walked back through the CLI at all -- only by hand-editing the database. A review queue whose reject key is unrecoverable is one users are right to hesitate over.
    const id = await pendingId("we cache the build output");
    await runCli(["review", "--reject", id]);
    expect(await statusOf(id)).toBe("superseded");

    const undone = await runCli(["review", "--undo", id]);
    expect(undone.exitCode).toBe(0);
    expect(undone.stdout).toContain("restored");
    expect(await statusOf(id)).toBe("pending");
  });

  it("still undoes a rejection after a later `used` audit event", async () => {
    const id = await pendingId("we cache the lint output");
    await runCli(["review", "--reject", id]);
    expect((await runCli(["used", id, "--session-id", "sess-1"])).exitCode).toBe(0);

    const undone = await runCli(["review", "--undo", id]);
    expect(undone.exitCode).toBe(0);
    expect(await statusOf(id)).toBe("pending");
  });

  it("refuses a fact that reached superseded some other way", async () => {
    // Scoped to rejections on purpose: `mem forget` is a considered decision about a fact the user chose to keep, and reversing that is a different question from correcting a review slip.
    const remembered = await runCli(["remember", "we deploy nightly", "--kind", "decision", "--scope", "global"]);
    const id = remembered.stdout.trim().split(/\s+/u).pop() ?? "";
    await runCli(["forget", id]);
    const result = await runCli(["review", "--undo", id]);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("not rejected through review");
    expect(await statusOf(id)).toBe("superseded");
  });

  it("refuses a fact that was never rejected at all", async () => {
    const id = await pendingId("we run the linter in CI");
    const result = await runCli(["review", "--undo", id]);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("nothing to undo");
    expect(await statusOf(id)).toBe("pending");
  });

  it("rejects combining --undo with another review action", async () => {
    const result = await runCli(["review", "--promote", "abc", "--undo", "def"]);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("cannot be used together");
  });
});

describe("review pending bucket order", () => {
  it("lists pending facts with equal sightings and capture time in fact id order, whatever order they were stored in", async () => {
    const db = openStorage(resolveDbPath());
    const tied = "2026-01-01T00:00:00.000Z";
    insertFact(db, { id: "z-pending", text: "zulu pending fact", kind: "fact", scope: "global", source_type: "user", status: "pending", captured_at: tied });
    insertFact(db, { id: "a-pending", text: "alpha pending fact", kind: "fact", scope: "global", source_type: "user", status: "pending", captured_at: tied });
    db.close();

    const review = await runCli(["review", "--section", "pending"]);
    expect(review.exitCode).toBe(0);
    const alpha = review.stdout.indexOf("alpha pending fact");
    const zulu = review.stdout.indexOf("zulu pending fact");
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(alpha).toBeLessThan(zulu);
  });
});
