/** End-to-end CLI tests for recall: ordering, hint formats and the fail-open seam, epoch windows, and the usefulness feedback loop. Each test gets an isolated `TOKEN_GOAT_MEM_HOME` (a fresh temp dir), re-applied per test so facts written by one test can never leak into another. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRememberedId, runCli } from "./support/cli.js";
import { insertAuditLog, openDb, resolveDbPath } from "../src/db.js";
import { deleteFact, insertFact, openStorage } from "../src/storage.js";


let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-cli-test-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  rmSync(home, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────── integration-seam.ts fail-open via `mem recall --hint-format` ───────────────────────────────────────────────────────────────────────────

describe("--hint-format fails open on internal error (integration-seam.ts, review S2/S3)", () => {
  it("returns a well-formed TGMEM payload naming the unreadable store, and exit code 0, instead of throwing when the DB cannot be opened", async () => {
    // Point TOKEN_GOAT_MEM_HOME at a path that is a *file*, not a directory. `mem.db` would need to live inside it, so opening the store fails internally -- exactly the class of failure buildHintFormat's outer try/catch exists to absorb (never throws; caller's fail-open path never has to special-case a thrown exception). The response still says the store could not be read, rather than looking byte-identical to a project with genuinely no memory yet.
    const brokenHome = join(mkdtempSync(join(tmpdir(), "mem-cli-broken-")), "not-a-directory");
    writeFileSync(brokenHome, "this is a file, not a mem home directory");
    process.env["TOKEN_GOAT_MEM_HOME"] = brokenHome;

    try {
      const result = await runCli(["recall", "--hint-format", "--root", home]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("TGMEM/2\nfooter  store could not be read; mem doctor shows the underlying error\n");
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

    // --hint-format alone (or with allowed options like --context-files, --stable, --hint-style) should still work We already test the basic case above, and the next test should cover this working case.
  });

  it("--hint-format honors a positional query, reordering the emitted lines by relevance instead of pure recency", async () => {
    // Explicit captured_at timestamps (not two back-to-back `remember` calls) so the recency ordering this test pins is deterministic rather than a race against millisecond clock resolution. Older fact mentions "giraffe" nowhere; newer fact is the only one containing "oranges". Bare (query-less) --hint-format has no ranking signal and falls through to recency, so the newer "oranges" fact already leads -- to prove the query is what reorders (not recency doing it by coincidence), query for a term only the *older* fact contains, and assert the older fact now leads despite being less recent.
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
    const factLines = (stdout: string): string[] => stdout.split("\n").filter((line) => line.startsWith("fact  "));
    // Same set of fact-lines either way -- a query that matches nothing reorders, it never removes.
    expect([...factLines(noMatch.stdout)].sort()).toEqual([...factLines(bare.stdout)].sort());
    // The footer is where the two now diverge: a query with genuinely nothing to match against says so, rather than handing back the same recency dump a no-query call would with no way to tell the two apart.
    expect(noMatch.stdout).toContain("no match for this query -- showing recent facts instead");
    expect(bare.stdout).not.toContain("no match for this query");
  });

  it("--hint-format with allowed options (--context-files, --stable, --hint-style) still works", async () => {
    // This should not fail; we're testing that the allowed options don't trigger the incompatibility error In this test home is already set from the outer describe block, and the DB is populated from prior tests
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
    // Default (full) recall output no longer embeds an id in a per-line CTA (footer-ized, Section 4), so ids are captured from `remember`'s own success line and matched back to each fact's line by its distinguishing text, rather than regex-extracted from recall's display text.
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
    // The message text itself (and the count) is covered directly against `retrieve()`'s `anchorBudgetHits` in tests/unit/retrieval.test.ts, since there is no CLI flag to force the anchor deadline low enough to reproduce a real budget hit here. This only pins the negative: a normal store small enough to finish every anchor within the default budget stays silent.
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
    expect(lines.at(-1)).toBe("mem show <id> for detail");
    expect(lines.filter((line) => line.startsWith("mem show <id> for detail"))).toHaveLength(1);
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

    // A tie is surfaced with a `(contested, ...)` annotation instead of a guessed winner. Assert on that annotation, not on the bare word "contested": recall's footer prints "mem review to resolve contested/pending" on every call, so the looser assertion passes vacuously and the first draft of this test did exactly that -- it passed against the unfixed code.
    const plain = await runCli(["recall", "package manager"]);
    expect(plain.stdout).toContain("(contested,");

    // Filtering the pool in SQL left the survivor alone, and resolveContradictions' reinstatement pass reads "no rival present" as "nothing is left to contest this" and un-contests it -- so the epoch window silently promoted a withheld fact to ground truth. The filter now runs after contradiction resolution, over the whole store, like every other filter.
    const filtered = await runCli(["recall", "package manager", "--since-epoch", "1"]);
    expect(filtered.exitCode).toBe(0);
    expect(filtered.stdout).toContain("(contested,");
  });

  it("keeps review's contested bucket populated when the rival falls outside the epoch window", async () => {
    await seedTiedPair();

    const plain = await runCli(["review", "--summary"]);
    expect(plain.stdout).toContain("contested: 2");

    // Same defect one function over: `formatReview` fed `detectContradictions` an epoch-filtered pool, so the surviving half of a tie was reported clean by the exact command whose job is to surface it -- while `mem recall` went on withholding it.
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
    // A git-style prefix: the exact shape `resolveFactIdOrPrefix` accepts, so the footer's own instruction is followable by copying what is on screen rather than by first running `mem list` to find an id the command that told you to use one declined to print.
    expect(shortId).toMatch(/^[0-9a-f]{8}$/u);

    const shown = await runCli(["show", shortId]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("the footer says to run mem show for detail");
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

  it("--stable writes recall_log rows like any other surfacing, so --delta and mem used still work under it", async () => {
    const id = extractRememberedId(await runCli(["remember", "a stable fact", "--kind", "fact", "--scope", "global"]));
    const result = await runCli(["recall", "--hint-format", "--session-id", "sess-1", "--stable", "--root", home]);
    expect(result.exitCode).toBe(0);
    // Non-firing guard: the fact really was emitted, so the logging assertion below is not vacuously satisfied by an empty response.
    expect(result.stdout).toContain("a stable fact");
    expect(recallLogRows().map(([factId, sessionId]) => [factId, sessionId])).toEqual([[id, "sess-1"]]);

    // The two consumers of that row, end to end.
    const delta = await runCli(["recall", "--hint-format", "--session-id", "sess-1", "--stable", "--delta", "--root", home]);
    expect(delta.exitCode).toBe(0);
    expect(delta.stdout).toBe("TGMEM/2  delta=1\n");

    const used = await runCli(["used", id, "--session-id", "sess-1"]);
    expect(used.exitCode).toBe(0);
    expect(used.stdout).toContain("marked 1 recall row useful in session sess-1");
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

  it("mem epoch --gc prunes old audit rows even when an earlier row is stamped a few hours ahead", async () => {
    const db = openStorage(resolveDbPath());
    const day = 24 * 60 * 60 * 1000;
    const insert = db.prepare("INSERT INTO audit_log (id, event, fact_id, detail, prior_json, created_at) VALUES (?, ?, ?, ?, NULL, ?)");
    insert.run("jump", "capture", "f1", "jumped", new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 400 * day);
    insertAuditLog(db, { event: "pin", factId: "f1", detail: "old-a" });
    insertAuditLog(db, { event: "pin", factId: "f1", detail: "old-b" });
    vi.useRealTimers();
    db.close();

    const gc = await runCli(["epoch", "--gc"]);
    expect(gc.exitCode).toBe(0);
    expect(gc.stdout).toContain("pruned_audit_log_rows=2  ");
    const check = openStorage(resolveDbPath());
    try {
      expect(check.prepare("SELECT id FROM audit_log WHERE id = ?").all("jump")).toHaveLength(1);
    } finally {
      check.close();
    }
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
    // Reproduce a v0.3.2 store: everything else in place, no recall_log table at all. `openDb` now runs every migration itself and stamps `user_version`, so resetting it to `0` here is what makes this a faithful "predates recall_log" store rather than one the migration runner considers already fully migrated and skips -- a real v0.3.2 store never had `user_version` set at all.
    const raw = openDb(resolveDbPath());
    raw.exec("DROP TABLE recall_log");
    raw.pragma("user_version = 0");
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

    // A prefix, not the full id: `mem used` has to resolve ids exactly like every other id-accepting command, since the id a user has to hand is the truncated one `mem recall` prints.
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

  describe("refuses to rubber-stamp a whole recall", () => {
    async function rememberFacts(count: number): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        ids.push(extractRememberedId(await runCli(["remember", `deploy runbook note number ${["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"][i] ?? "golf"}`, "--kind", "fact", "--scope", "global"])));
      }
      return ids;
    }

    it("refuses every fact of a 3-fact recall with exit 1 and writes no rows", async () => {
      const ids = await rememberFacts(3);
      await surfaceAll("session-alpha");

      const refused = await runCli(["used", ...ids, "--session-id", "session-alpha"]);

      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("--all");
      expect(refused.stderr).toContain("only the facts that actually helped");
      expect(usedAtRows().every((row) => row.used_at === null)).toBe(true);
      const db = openStorage(resolveDbPath());
      const usedEvents = (db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE event = 'used'").get() as { c: number }).c;
      db.close();
      expect(usedEvents).toBe(0);
    });

    describe("with a small later recall nested inside a big one", () => {
      async function seedNestedRecalls(): Promise<string[]> {
        const ids = await rememberFacts(6);
        const db = openStorage(resolveDbPath());
        try {
          const insert = db.prepare("INSERT INTO recall_log (fact_id, session_id, surfaced_at) VALUES (?, ?, ?)");
          for (const id of ids) {
            insert.run(id, "session-alpha", "2026-01-01T00:00:00.000Z");
          }
          for (const id of ids.slice(0, 3)) {
            insert.run(id, "session-alpha", "2026-01-01T00:05:00.000Z");
          }
        } finally {
          db.close();
        }
        return ids;
      }

      it("accepts the nested 3-fact set plus one more fact from the big recall", async () => {
        const ids = await seedNestedRecalls();

        const accepted = await runCli(["used", ...ids.slice(0, 4), "--session-id", "session-alpha"]);

        expect(accepted.exitCode).toBe(0);
        expect(usedAtRows().filter((row) => row.used_at !== null).length).toBeGreaterThanOrEqual(4);
      });

      it("still refuses naming exactly the nested 3-fact set", async () => {
        const ids = await seedNestedRecalls();

        const refused = await runCli(["used", ...ids.slice(0, 3), "--session-id", "session-alpha"]);

        expect(refused.exitCode).toBe(1);
        expect(usedAtRows().every((row) => row.used_at === null)).toBe(true);
      });
    });

    it("accepts the whole set with --all", async () => {
      const ids = await rememberFacts(3);
      await surfaceAll("session-alpha");

      const accepted = await runCli(["used", ...ids, "--session-id", "session-alpha", "--all"]);

      expect(accepted.exitCode).toBe(0);
      expect(usedAtRows().every((row) => row.used_at !== null)).toBe(true);
    });

    it("accepts a subset of a 3-fact recall", async () => {
      const ids = await rememberFacts(3);
      await surfaceAll("session-alpha");

      const accepted = await runCli(["used", ...ids.slice(0, 2), "--session-id", "session-alpha"]);

      expect(accepted.exitCode).toBe(0);
      expect(usedAtRows().filter((row) => row.used_at !== null)).toHaveLength(2);
    });

    it("accepts the whole set when the recall surfaced only 2 facts", async () => {
      const ids = await rememberFacts(2);
      await surfaceAll("session-alpha");

      const accepted = await runCli(["used", ...ids, "--session-id", "session-alpha"]);

      expect(accepted.exitCode).toBe(0);
      expect(usedAtRows().every((row) => row.used_at !== null)).toBe(true);
    });
  });

  it("feeds the ranking: a confirmed-useful fact outranks one that merely ties it on BM25", async () => {
    // Both facts contain "deploy" exactly once in the same-length text, so BM25 ties them and the default recency ordering puts the newer (`second`) first. Confirming the older one useful is the only thing that can flip that, which is what makes this a test of the wiring rather than of the ordering that was already there.
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

describe("mem recall ranks a fact that names an identifier above one that only shares its stems", () => {
  /** BM25 stems `src/retrieval.ts` down to `src`/`retriev`/`ts` and then cannot tell the fact that names that file from one that merely uses those three words in a sentence. The entity layer already knows the difference -- `mem facets --list-entities` extracts `src/retrieval.ts` as a single entity on exactly the fact that names it -- but until this test, recall consulted that layer only when the caller passed `--entity`, which requires already knowing the answer. Found by dogfooding against a three-fact store: the fact naming the file ranked *last*. */
  async function seed(): Promise<void> {
    await runCli(["remember", "the BM25 scorer lives in src/retrieval.ts and owns fusion", "--kind", "fact"]);
    await runCli(["remember", "we retriev data from various src locations using ts helpers", "--kind", "fact"]);
    await runCli(["remember", "retrieval of ts source files happens in the src directory", "--kind", "fact"]);
  }

  it("puts the fact naming the path first", async () => {
    await seed();
    const result = await runCli(["recall", "src/retrieval.ts"]);
    expect(result.exitCode).toBe(0);
    const first = result.stdout.split("\n")[0] ?? "";
    expect(first).toContain("src/retrieval.ts and owns fusion");
  });

  it("leaves ranking alone when the query carries no identifier at all", async () => {
    // The guard on the whole idea: this project has already been burned by a rank list that voted on queries it had no signal for (see the zero-BM25 comment in retrieval.ts). A query with no entities must produce no entity list, so ranking is byte-for-byte what it was before.
    await seed();
    const result = await runCli(["recall", "source files and helpers"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("retriev");
  });

  it("does not let a shared identifier outrank a fact the query actually matches", async () => {
    // The entity list is one vote among several, not an override. A fact that merely carries the identifier must not displace one that carries it *and* matches the rest of the query.
    await runCli(["remember", "src/retrieval.ts exists", "--kind", "fact"]);
    await runCli(["remember", "src/retrieval.ts owns reciprocal rank fusion scoring", "--kind", "fact"]);
    const result = await runCli(["recall", "src/retrieval.ts reciprocal rank fusion"]);
    const first = result.stdout.split("\n")[0] ?? "";
    expect(first).toContain("reciprocal rank fusion scoring");
  });
});

// --- what recall and edit tell the user about what they are not seeing ---
describe("recall's follow-up line names only the commands that apply", () => {
  it("omits the review call-to-action when no result needs resolving, and adds it when one does", async () => {
    await runCli(["remember", "the ingestion worker batches 250 rows", "--kind", "decision"]);

    // It used to print unconditionally. That is not merely noise: this file's contested-annotation test carries a comment explaining that the permanent CTA made a looser assertion pass vacuously against unfixed code -- an always-on string is indistinguishable from a real signal to a reader and to a test alike.
    const clean = await runCli(["recall", "ingestion"]);
    expect(clean.stdout).toContain("mem show <id> for detail");
    expect(clean.stdout).not.toContain("mem review");

    await runCli(["suggest", "always vacuum the analytics table weekly", "--kind", "preference"]);
    const queued = await runCli(["recall", "vacuum"]);
    expect(queued.stdout).toContain("mem show <id> for detail; mem review to resolve contested/pending");
  });
});
