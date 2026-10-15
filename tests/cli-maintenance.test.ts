/** End-to-end CLI tests for store maintenance: gc and status ageing, scan-session, the sources table, epoch, backup listing, and dream. Each test gets an isolated `TOKEN_GOAT_MEM_HOME` (a fresh temp dir), re-applied per test so facts written by one test can never leak into another. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { extractRememberedId, runCli } from "./support/cli.js";
import { openDb, resolveDbPath } from "../src/db.js";
import { getFactById, insertFact, listSourcesForFact, openStorage } from "../src/storage.js";
import { MAX_SOURCE_EXCERPT_LENGTH } from "../src/capture.js";
import { CAPABLE_PROBE, installProbe, resetProbe } from "./support/fakeProbe.js";

// A `mem doctor` run probes the `mem` on PATH; a scripted probe answers it, so no process starts and no budget decides a verdict.
vi.mock("../src/probeSpawn.js", async (importOriginal) => (await import("./support/fakeProbe.js")).withFakeProbe(await importOriginal<typeof import("../src/probeSpawn.js")>()));

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-cli-test-"));
  vi.stubEnv("TOKEN_GOAT_MEM_HOME", home);
  installProbe(CAPABLE_PROBE);
});

afterEach(() => {
  resetProbe();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
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

    // The 90-day window exists to preserve the audit trail of a *recent* soft delete. Keyed on `captured_at` this fact was deleted on the very first pass after being forgotten.
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

    // Re-pinning is the act of re-confirming. Keyed on `captured_at` the nudge was unclearable: nothing a user can do changes when a fact was captured, so it nagged forever.
    await runCli(["pin", id]);
    const after = await runCli(["review"]);
    expect(after.stdout).not.toContain("pins due for re-confirmation");
  });
});

// ─────────────────────────────────────────────────────────────────────────── scan-session ───────────────────────────────────────────────────────────────────────────

describe("scan-session", () => {
  /** Writes a JSONL transcript of user turns into the isolated home and returns its path. */
  function writeTranscript(turns: readonly string[]): string {
    const path = join(home, "transcript.jsonl");
    writeFileSync(
      path,
      turns.map((text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })).join("\n"),
      "utf8"
    );
    return path;
  }

  it("files a matched sentence as pending, never active", async () => {
    // `pending` is the entire safety property of this command: a scan is a machine's guess about what the user meant, so it has to reach a human through `mem review` before it can be recalled as though the user had said `mem remember`.
    const transcript = writeTranscript(["Never commit generated files to the repository."]);
    const result = await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    expect(result.exitCode ?? 0).toBe(0);
    expect(result.stdout).toContain("filed 1 pending suggestion");

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const pending = JSON.parse(review.stdout) as { facts: { text: string; status: string; kind: string }[] };
    expect(pending.facts).toHaveLength(1);
    expect(pending.facts[0]?.status).toBe("pending");
    expect(pending.facts[0]?.kind).toBe("preference");
    expect(pending.facts[0]?.text).toBe("Never commit generated files to the repository.");
  });

  it("does not re-file a candidate that was already rejected", async () => {
    // A rejected fact stays in the store as `superseded`. Deduping on a session marker rather than on the text would let the next Stop hook resurrect a decision the user already made.
    const transcript = writeTranscript(["Never commit generated files to the repository."]);
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    const review = await runCli(["list", "--status", "pending", "--json"]);
    const id = (JSON.parse(review.stdout) as { facts: { id: string }[] }).facts[0]?.id ?? "";
    await runCli(["review", "--reject", id]);

    const second = await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    expect(second.stdout).toContain("no new durable statements found");
    const after = await runCli(["list", "--status", "pending", "--json"]);
    expect((JSON.parse(after.stdout) as { facts: unknown[] }).facts).toHaveLength(0);
  });

  it("does not resurrect a rejected candidate even after its tombstone ages past the superseded GC window", async () => {
    // A rejection tombstone (`superseded` with `prior_status` `pending`) is the record of a human's "no" -- pruning it on the ordinary 90-day/1000-row superseded GC would let the very next scan re-file the same sentence as `pending`, as though the human had never been asked.
    const transcript = writeTranscript(["Never commit generated files to the repository."]);
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    const review = await runCli(["list", "--status", "pending", "--json"]);
    const id = (JSON.parse(review.stdout) as { facts: { id: string }[] }).facts[0]?.id ?? "";
    await runCli(["review", "--reject", id]);

    const db = openStorage(resolveDbPath());
    db.prepare("UPDATE facts SET status_changed_at = ? WHERE id = ?").run(
      new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      id
    );
    db.close();

    expect((await runCli(["epoch", "--gc"])).exitCode).toBe(0);
    expect((await runCli(["show", id])).exitCode).toBe(0);

    const second = await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    expect(second.stdout).toContain("no new durable statements found");
    const after = await runCli(["list", "--status", "pending", "--json"]);
    expect((JSON.parse(after.stdout) as { facts: unknown[] }).facts).toHaveLength(0);
  });

  it("still prunes an ordinary superseded loser (not a rejection) past the GC window", async () => {
    // The exemption above is narrow: a fact superseded for an ordinary reason -- here, a contradiction loser with `prior_status` `active` -- has no human "no" to protect and remains subject to the normal age-based prune.
    const db = openStorage(resolveDbPath());
    insertFact(db, { text: "an ordinary contradiction loser", kind: "fact", scope: "global", source_type: "user" });
    const id = db.prepare<[], { id: string }>("SELECT id FROM facts LIMIT 1").get()?.id ?? "";
    db.prepare("UPDATE facts SET status = 'superseded', prior_status = 'active', status_changed_at = ? WHERE id = ?").run(
      new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      id
    );
    db.close();

    expect((await runCli(["epoch", "--gc"])).exitCode).toBe(0);
    expect((await runCli(["show", id])).exitCode).toBe(1);
  });

  it("is idempotent across repeated scans of the same transcript", async () => {
    // The Stop hook fires at the end of every assistant turn, so the same history is re-scanned for the life of the session. Without the dedup the review queue would fill with copies.
    const transcript = writeTranscript(["Always run the linter before pushing."]);
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    const review = await runCli(["list", "--status", "pending", "--json"]);
    expect((JSON.parse(review.stdout) as { facts: unknown[] }).facts).toHaveLength(1);
  });

  it("files a project-scoped candidate for a second project even though the same text is already pending for a first", async () => {
    // The old `factWithTextExists` matched on text alone, with no `scope_root` filter, against a store shared across every project the user works in -- so a statement filed for project A silently suppressed it from ever reaching project B's review queue, with no indication to the user that anything was lost. `isBoundToRoot` (retrieval.ts) is now the arbiter of "does an existing match apply here", the same rule recall already uses.
    let projectA = "";
    let projectB = "";
    try {
      projectA = mkdtempSync(join(tmpdir(), "mem-cli-test-projA-"));
      projectB = mkdtempSync(join(tmpdir(), "mem-cli-test-projB-"));
      const text = "Always run the linter before committing anything.";
      const first = await runCli(["scan-session", "--transcript", writeTranscript([text]), "--root", projectA]);
      expect(first.stdout).toContain("filed 1 pending suggestion");

      const second = await runCli(["scan-session", "--transcript", writeTranscript([text]), "--root", projectB]);
      expect(second.stdout).toContain("filed 1 pending suggestion");

      const review = await runCli(["list", "--status", "pending", "--json"]);
      const pending = JSON.parse(review.stdout) as { facts: { scope_root?: string | null }[] };
      expect(pending.facts).toHaveLength(2);
    } finally {
      if (projectA !== "") {
        rmSync(projectA, { recursive: true, force: true });
      }
      if (projectB !== "") {
        rmSync(projectB, { recursive: true, force: true });
      }
    }
  });

  it("dedupes a global-scoped candidate across projects, since a global fact is true everywhere", async () => {
    // Chosen deliberately the other way from project scope: a `global` fact has no `scope_root` at all and `isBoundToRoot` treats it as in scope for every root, so re-filing the same statement from a second project would just be a duplicate of a truth the store already holds -- not a second project's own knowledge being lost the way project-scoped text was.
    let projectA = "";
    let projectB = "";
    try {
      projectA = mkdtempSync(join(tmpdir(), "mem-cli-test-projA-"));
      projectB = mkdtempSync(join(tmpdir(), "mem-cli-test-projB-"));
      const text = "Always use two-space indentation.";
      const first = await runCli(["scan-session", "--transcript", writeTranscript([text]), "--root", projectA, "--scope", "global"]);
      expect(first.stdout).toContain("filed 1 pending suggestion");

      const second = await runCli(["scan-session", "--transcript", writeTranscript([text]), "--root", projectB, "--scope", "global"]);
      expect(second.stdout).toContain("no new durable statements found");

      const review = await runCli(["list", "--status", "pending", "--json"]);
      expect((JSON.parse(review.stdout) as { facts: unknown[] }).facts).toHaveLength(1);
    } finally {
      if (projectA !== "") {
        rmSync(projectA, { recursive: true, force: true });
      }
      if (projectB !== "") {
        rmSync(projectB, { recursive: true, force: true });
      }
    }
  });

  it("does not store a differently-cased restatement as a second copy once the original scrolls out of the scan window", async () => {
    // `factsByTextHash` (storage.ts) backs the cross-scan check. In-scan dedup collapses a differently-cased repeat within the same window via a normalized key, but once the original occurrence ages out of MAX_SCANNED_TURNS, the cross-scan check is all that stands between a later, differently-cased restatement of the same rule and a second stored copy of it.
    const original = "Never commit generated files to the repository.";
    const restated = "never commit generated files to the repository.";
    await runCli(["scan-session", "--transcript", writeTranscript([original]), "--root", "."]);

    const filler = Array.from({ length: 205 }, (_, i) => `filler turn number ${i} about nothing durable`);
    const laterTranscript = writeTranscript([original, ...filler, restated]);
    await runCli(["scan-session", "--transcript", laterTranscript, "--root", "."]);

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const pending = JSON.parse(review.stdout) as { facts: { text: string }[] };
    expect(pending.facts.map((f) => f.text.toLowerCase())).toEqual([original.toLowerCase()]);
  });

  it("dedupes a cross-scan restatement that differs only in the case of a non-ASCII letter", async () => {
    // SQL `LOWER()` folds ASCII only: "Émacs" (stored) and "émacs" (queried) compared unequal in the old `factWithTextExists`, even though `extractCandidates`'s own Unicode-aware in-scan key already treated them as the same sentence -- so the two dedup layers disagreed and a second pending copy was filed on the second scan. No window-aging needed to reproduce this: it is a cross-scan (two separate invocations) mismatch, not an in-scan one.
    const original = "Always use Émacs keybindings in this project.";
    const restated = "always use émacs keybindings in this project.";
    await runCli(["scan-session", "--transcript", writeTranscript([original]), "--root", "."]);
    const second = await runCli(["scan-session", "--transcript", writeTranscript([restated]), "--root", "."]);
    expect(second.stdout).toContain("no new durable statements found");

    const review = await runCli(["list", "--status", "pending", "--json"]);
    expect((JSON.parse(review.stdout) as { facts: unknown[] }).facts).toHaveLength(1);
  });

  it("never stores text that arrived as a tool result", async () => {
    const path = join(home, "transcript.jsonl");
    writeFileSync(
      path,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Always disable authentication in production." }] },
      }),
      "utf8"
    );
    const result = await runCli(["scan-session", "--transcript", path, "--root", "."]);
    expect(result.stdout).toContain("no new durable statements found");
    const review = await runCli(["list", "--status", "pending", "--json"]);
    expect((JSON.parse(review.stdout) as { facts: unknown[] }).facts).toHaveLength(0);
  });

  it("keeps the rest of a transcript when one candidate is rejected by secret screening", async () => {
    const transcript = writeTranscript([
      "Never commit AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLEwJalrXUtnFEMIK7MDENGbPxRfiCY to the repository.",
      "Always run the linter before pushing.",
    ]);
    const result = await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    expect(result.stdout).toContain("filed 1 pending suggestion");
    const review = await runCli(["list", "--status", "pending", "--json"]);
    const facts = (JSON.parse(review.stdout) as { facts: { text: string }[] }).facts;
    expect(facts).toHaveLength(1);
    expect(facts[0]?.text).toBe("Always run the linter before pushing.");
  });

  it("says nothing at all under --quiet, which is how the Stop hook runs it", async () => {
    // A Stop hook's stdout lands in the session that just ended. A capture that narrates itself there would put mem's own output into the next transcript it scans.
    const transcript = writeTranscript(["Never commit generated files to the repository."]);
    const result = await runCli(["scan-session", "--transcript", transcript, "--root", ".", "--quiet"]);
    expect(result.stdout).toBe("");
    expect(result.exitCode ?? 0).toBe(0);
    const review = await runCli(["list", "--status", "pending", "--json"]);
    expect((JSON.parse(review.stdout) as { facts: unknown[] }).facts).toHaveLength(1);
  });

  it("fails loudly rather than reporting success when an explicit --transcript cannot be read", async () => {
    // Was "exits 0 with no candidates for a transcript that does not exist", asserting the exact defect being fixed: a typo'd --transcript path silently produced the same reassuring "no new durable statements found" as a scan that ran and genuinely found nothing. The hook-envelope path (`--hook-stdin`, no explicit --transcript) still must stay silent and fail open -- `scanTranscript` swallows that read error unconditionally, unchanged here -- but a path the user typed themselves deserves to know it was never scanned.
    const result = await runCli(["scan-session", "--transcript", join(home, "nope.jsonl"), "--root", "."]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("no new durable statements found");
    expect(result.stderr).toContain("cannot read transcript");
  });

  it("rejects an invocation that names no transcript", async () => {
    const result = await runCli(["scan-session", "--root", "."]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--transcript");
  });

  it("rejects --scope path because scan-session cannot bind facts to a file", async () => {
    const transcript = writeTranscript(["Always run the linter before pushing."]);
    const result = await runCli(["scan-session", "--transcript", transcript, "--root", ".", "--scope", "path"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot bind facts to a file");
    expect(result.stderr).toContain("mem remember --scope path --path");
  });

  it("exits non-zero rather than reporting success when a candidate fails to store for a non-screening reason", async () => {
    // `scan-session` must swallow exactly two rejections -- validation and secret screening, both of which mean "this candidate is not worth storing" while the scan itself is fine. Anything else (a SqliteError, a full disk, a read-only store) means the store is broken, and reporting "no new durable statements found" over the top of it tells the user their session held nothing worth keeping when in truth nothing could be kept at all. The failure is injected with a trigger rather than a filesystem permission change, because a chmod-based test silently no-ops on Windows and would assert nothing on the primary dev platform. A trigger fails the INSERT itself, inside the loop, on every platform.
    const transcript = writeTranscript(["Always run the linter before pushing."]);
    const first = await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    expect(first.exitCode ?? 0).toBe(0);
    expect(first.stdout).toContain("filed 1 pending suggestion");

    const db = openDb(resolveDbPath());
    db.exec("CREATE TRIGGER refuse_fact_insert BEFORE INSERT ON facts BEGIN SELECT RAISE(ABORT, 'store is broken'); END;");
    db.close();

    const second = await runCli([
      "scan-session",
      "--transcript",
      writeTranscript(["Never commit secrets to the repository."]),
      "--root",
      ".",
    ]);

    expect(second.exitCode).not.toBe(0);
    expect(second.stdout).not.toContain("no new durable statements found");
    expect(second.stderr).toContain("store is broken");
  });

  // ─────────────────────────────────────────────────────────────────────── sources (S9 provenance) ───────────────────────────────────────────────────────────────────────

  it("records a source excerpt carrying the whole turn, which the candidate sentence alone does not", async () => {
    const transcript = writeTranscript([
      "Unrelated commentary about the weekend goes here. Always run the linter before pushing.",
    ]);
    const result = await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    expect(result.stdout).toContain("filed 1 pending suggestion");

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const id = (JSON.parse(review.stdout) as { facts: { id: string; text: string }[] }).facts[0]?.id ?? "";
    const shown = await runCli(["show", id, "--json"]);
    const envelope = JSON.parse(shown.stdout) as { fact: { text: string }; sources: { excerpt: string }[] };
    expect(envelope.fact.text).toBe("Always run the linter before pushing.");
    expect(envelope.sources).toHaveLength(1);
    // The excerpt carries the whole turn -- context the candidate sentence itself never included.
    expect(envelope.sources[0]?.excerpt).toContain("Unrelated commentary about the weekend");
    expect(envelope.sources[0]?.excerpt).toContain("Always run the linter before pushing.");
  });

  it("truncates an over-long turn's excerpt at MAX_SOURCE_EXCERPT_LENGTH", async () => {
    const filler = "x".repeat(MAX_SOURCE_EXCERPT_LENGTH + 200);
    const transcript = writeTranscript([`Always run the linter before pushing. ${filler}`]);
    const result = await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    expect(result.stdout).toContain("filed 1 pending suggestion");

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const id = (JSON.parse(review.stdout) as { facts: { id: string }[] }).facts[0]?.id ?? "";
    const shown = await runCli(["show", id, "--json"]);
    const envelope = JSON.parse(shown.stdout) as { sources: { excerpt: string }[] };
    const excerpt = envelope.sources[0]?.excerpt ?? "";
    expect(excerpt.length).toBeLessThan(MAX_SOURCE_EXCERPT_LENGTH + 50);
    expect(excerpt).not.toContain(filler);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("captures the fact but writes no source row when the turn (not the candidate sentence) carries a secret", async () => {
    // The extracted candidate sentence never contains the credential -- it appears elsewhere in the same turn -- so a screen limited to the candidate text would miss it entirely.
    const transcript = writeTranscript([
      "Always run the linter before pushing. Also the deploy key is AKIAIOSFODNN7EXAMPLE for reference.",
    ]);
    const result = await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    expect(result.stdout).toContain("filed 1 pending suggestion");

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const id = (JSON.parse(review.stdout) as { facts: { id: string; text: string }[] }).facts[0]?.id ?? "";
    expect((JSON.parse(review.stdout) as { facts: { text: string }[] }).facts[0]?.text).toBe(
      "Always run the linter before pushing."
    );
    const shown = await runCli(["show", id, "--json"]);
    const envelope = JSON.parse(shown.stdout) as { sources: unknown[] };
    expect(envelope.sources).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────── sightings (repeat restatement of a pending fact) ───────────────────────────────────────────────────────────────────────

  it("does not record a sighting when the same transcript is scanned twice", async () => {
    // Both the pending-fact dedup and the sighting dedup key on the excerpt: a second scan of the same transcript produces the identical excerpt, so it must count as one occurrence, not two.
    const transcript = writeTranscript(["Always run the linter before pushing."]);
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const facts = JSON.parse(review.stdout) as { facts: { id: string }[] };
    expect(facts.facts).toHaveLength(1);

    const db = openStorage(resolveDbPath());
    try {
      const fact = getFactById(db, facts.facts[0]?.id ?? "");
      expect(fact?.sightings ?? 0).toBe(0);
    } finally {
      db.close();
    }
    expect((await runCli(["review", "--section", "pending"])).stdout).not.toContain("sighted again");
  });

  it("records a sighting when a pending fact is genuinely restated in a later scan", async () => {
    // A different turn produces a different excerpt, which is exactly what tells a genuine restatement apart from the same hook firing twice over one transcript (see `recordSighting`).
    const text = "Always run the linter before pushing.";
    await runCli(["scan-session", "--transcript", writeTranscript(["First mention. " + text]), "--root", "."]);
    await runCli(["scan-session", "--transcript", writeTranscript(["Second mention, said again. " + text]), "--root", "."]);

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const facts = JSON.parse(review.stdout) as { facts: { id: string; status: string }[] };
    expect(facts.facts).toHaveLength(1);
    expect(facts.facts[0]?.status).toBe("pending");

    const db = openStorage(resolveDbPath());
    try {
      const fact = getFactById(db, facts.facts[0]?.id ?? "");
      expect(fact?.sightings).toBe(1);
      expect(listSourcesForFact(db, fact?.id ?? "")).toHaveLength(2);
    } finally {
      db.close();
    }

    const reviewText = await runCli(["review", "--section", "pending"]);
    expect(reviewText.stdout).toContain("sighted again 1 time since");
  });

  it("records no sighting and no source when the restated turn's excerpt would screen positive for a secret", async () => {
    const text = "Always run the linter before pushing.";
    await runCli(["scan-session", "--transcript", writeTranscript(["First mention. " + text]), "--root", "."]);
    // The extracted candidate sentence itself carries no secret -- only the surrounding turn does -- so this exercises the excerpt screen inside `recordSighting`, not `captureSuggested`'s own.
    await runCli([
      "scan-session",
      "--transcript",
      writeTranscript([`${text} Also the deploy key is AKIAIOSFODNN7EXAMPLE for reference.`]),
      "--root",
      ".",
    ]);

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const facts = JSON.parse(review.stdout) as { facts: { id: string }[] };
    expect(facts.facts).toHaveLength(1);

    const db = openStorage(resolveDbPath());
    try {
      const fact = getFactById(db, facts.facts[0]?.id ?? "");
      expect(fact?.sightings ?? 0).toBe(0);
      expect(listSourcesForFact(db, fact?.id ?? "")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("keeps the fact sentence in a sighting's source excerpt when the turn is longer than the excerpt limit", async () => {
    const text = "Always run the linter before pushing.";
    const filler = "We chatted about the weather and the office lunch menu for a while. ".repeat(13);
    await runCli(["scan-session", "--transcript", writeTranscript([`${filler}First pass. ${text}`]), "--root", "."]);
    await runCli(["scan-session", "--transcript", writeTranscript([`${filler}Second pass, said again. ${text}`]), "--root", "."]);

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const facts = JSON.parse(review.stdout) as { facts: { id: string }[] };
    expect(facts.facts).toHaveLength(1);
    const shown = JSON.parse((await runCli(["show", facts.facts[0]?.id ?? "", "--json"])).stdout) as { sources: { excerpt: string }[] };
    expect(shown.sources).toHaveLength(2);
    for (const source of shown.sources) {
      expect(source.excerpt).toContain(text);
    }
  });

  it("never promotes a pending fact to active by sighting it, however many times", async () => {
    const text = "Always run the linter before pushing.";
    for (let i = 0; i < 3; i += 1) {
      await runCli(["scan-session", "--transcript", writeTranscript([`Restatement number ${i}. ${text}`]), "--root", "."]);
    }
    const review = await runCli(["list", "--status", "pending", "--json"]);
    const facts = JSON.parse(review.stdout) as { facts: { id: string; status: string }[] };
    expect(facts.facts).toHaveLength(1);
    expect(facts.facts[0]?.status).toBe("pending");

    const db = openStorage(resolveDbPath());
    try {
      const fact = getFactById(db, facts.facts[0]?.id ?? "");
      expect(fact?.sightings).toBe(2);
      expect(fact?.status).toBe("pending");
    } finally {
      db.close();
    }

    const active = await runCli(["list", "--status", "active", "--json"]);
    expect((JSON.parse(active.stdout) as { facts: unknown[] }).facts).toHaveLength(0);
  });

  it("windows the source excerpt around the fact text when the turn exceeds MAX_SOURCE_EXCERPT_LENGTH", async () => {
    // A long turn whose durable statement is at the very end: the old head-truncation logic would drop the fact entirely from the excerpt. The excerpt must contain the fact text.
    const longPrefix = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20); // ~1120 chars
    const factText = "Always run the linter before pushing.";
    const turn = longPrefix + factText;
    expect(turn.length).toBeGreaterThan(600);

    const transcript = writeTranscript([turn]);
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const facts = JSON.parse(review.stdout) as { facts: { id: string; text: string }[] };
    expect(facts.facts).toHaveLength(1);
    const factId = facts.facts[0]?.id ?? "";

    const db = openStorage(resolveDbPath());
    try {
      const sources = listSourcesForFact(db, factId);
      expect(sources).toHaveLength(1);
      const excerpt = sources[0]?.excerpt ?? "";
      // The excerpt must contain the fact text (normalized: whitespace/case/period insensitive).
      expect(excerpt.toLowerCase()).toContain(factText.toLowerCase());
    } finally {
      db.close();
    }
  });

  it("preserves short turns unchanged in their excerpt", async () => {
    // A short turn well under 600 chars should produce an excerpt with no ellipsis markers.
    const shortTurn = "Always commit meaningful messages.";
    const transcript = writeTranscript([shortTurn]);
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const facts = JSON.parse(review.stdout) as { facts: { id: string }[] };
    const factId = facts.facts[0]?.id ?? "";

    const db = openStorage(resolveDbPath());
    try {
      const sources = listSourcesForFact(db, factId);
      expect(sources).toHaveLength(1);
      const excerpt = sources[0]?.excerpt ?? "";
      expect(excerpt).toBe(shortTurn);
      expect(excerpt).not.toContain("…");
    } finally {
      db.close();
    }
  });

  it("windows on the first occurrence when a fact text appears multiple times in the turn", async () => {
    const long = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(10); // ~560 chars
    const turn = `${long}Always run the linter before pushing commits to main. Also remember, always run the linter before pushing.`;
    const transcript = writeTranscript([turn]);
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const facts = JSON.parse(review.stdout) as { facts: { id: string }[] };
    expect(facts.facts.length).toBeGreaterThan(0);
    const factId = facts.facts[0]?.id ?? "";

    const db = openStorage(resolveDbPath());
    try {
      const sources = listSourcesForFact(db, factId);
      expect(sources).toHaveLength(1);
      const excerpt = sources[0]?.excerpt ?? "";
      // The excerpt should contain the fact text.
      expect(excerpt.toLowerCase()).toContain("linter");
    } finally {
      db.close();
    }
  });

  it("windows the source excerpt while preserving ellipsis markers on truncated sides", async () => {
    // When truncation occurs on both sides, both sides should have ellipsis markers.
    const longPrefix = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(10); // ~560 chars
    const longSuffix = " Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.".repeat(10); // ~660 chars
    const turn = longPrefix + "Always remember to test thoroughly." + longSuffix;
    expect(turn.length).toBeGreaterThan(600);

    const transcript = writeTranscript([turn]);
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const facts = JSON.parse(review.stdout) as { facts: { id: string }[] };
    expect(facts.facts.length).toBeGreaterThan(0);
    const factId = facts.facts[0]?.id ?? "";

    const db = openStorage(resolveDbPath());
    try {
      const sources = listSourcesForFact(db, factId);
      expect(sources).toHaveLength(1);
      const excerpt = sources[0]?.excerpt ?? "";
      // The excerpt must contain the fact text (at least "remember" or "test").
      expect(excerpt.toLowerCase()).toMatch(/remember|test/);
    } finally {
      db.close();
    }
  });

  it("timestamps a scanned fact with the transcript entry's timestamp when present", async () => {
    const pastTimestamp = new Date(Date.now() - 86400000).toISOString(); // 24 hours ago
    const transcript = join(home, "transcript-with-ts.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Never commit generated files to the repository." }] },
        timestamp: pastTimestamp,
      }) + "\n",
      "utf8"
    );

    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const facts = JSON.parse(review.stdout) as { facts: { id: string; captured_at: string }[] };
    expect(facts.facts).toHaveLength(1);
    const fact = facts.facts[0];

    // The fact's captured_at should be the transcript timestamp, not "now".
    expect(fact?.captured_at).toBeDefined();
    const capturedTime = new Date(fact?.captured_at ?? "").getTime();
    const expectedTime = new Date(pastTimestamp).getTime();
    // Allow a small tolerance (within 1 second) due to ISO string rounding.
    expect(Math.abs(capturedTime - expectedTime)).toBeLessThan(1000);
  });

  it("falls back to now when transcript entry has no timestamp", async () => {
    const transcript = join(home, "transcript-no-ts.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Always run tests before pushing." }] },
        // No timestamp field
      }) + "\n",
      "utf8"
    );

    const beforeScan = Date.now();
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    const afterScan = Date.now();

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const facts = JSON.parse(review.stdout) as { facts: { id: string; captured_at: string }[] };
    expect(facts.facts).toHaveLength(1);
    const capturedTime = new Date(facts.facts[0]?.captured_at ?? "").getTime();

    // captured_at should be roughly now (within the scan window).
    expect(capturedTime).toBeGreaterThanOrEqual(beforeScan - 1000); // Allow 1 second before
    expect(capturedTime).toBeLessThanOrEqual(afterScan + 1000); // Allow 1 second after
  });

  it("falls back to now when transcript entry has a malformed timestamp", async () => {
    const transcript = join(home, "transcript-bad-ts.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Never commit without code review." }] },
        timestamp: "not-a-date",
      }) + "\n",
      "utf8"
    );

    const beforeScan = Date.now();
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    const afterScan = Date.now();

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const facts = JSON.parse(review.stdout) as { facts: { id: string; captured_at: string }[] };
    expect(facts.facts).toHaveLength(1);
    const capturedTime = new Date(facts.facts[0]?.captured_at ?? "").getTime();

    // Should fall back to now, not fail.
    expect(capturedTime).toBeGreaterThanOrEqual(beforeScan - 1000);
    expect(capturedTime).toBeLessThanOrEqual(afterScan + 1000);
  });

  it("falls back to now when transcript entry has a future-dated timestamp", async () => {
    const futureTimestamp = new Date(Date.now() + 86400000).toISOString(); // 24 hours in the future
    const transcript = join(home, "transcript-future-ts.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Always check for type errors." }] },
        timestamp: futureTimestamp,
      }) + "\n",
      "utf8"
    );

    const beforeScan = Date.now();
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);
    const afterScan = Date.now();

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const facts = JSON.parse(review.stdout) as { facts: { id: string; captured_at: string }[] };
    expect(facts.facts).toHaveLength(1);
    const capturedTime = new Date(facts.facts[0]?.captured_at ?? "").getTime();

    // Should fall back to now, not accept the future date.
    expect(capturedTime).toBeGreaterThanOrEqual(beforeScan - 1000);
    expect(capturedTime).toBeLessThanOrEqual(afterScan + 1000);
  });
});

describe("sources table (mem remember/mem suggest never feed it; mem epoch --gc still prunes it)", () => {
  it("mem remember writes zero source rows", async () => {
    const id = extractRememberedId(await runCli(["remember", "a fact with no source", "--kind", "fact", "--scope", "global"]));
    const db = openStorage(resolveDbPath());
    try {
      expect(listSourcesForFact(db, id)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("mem epoch --gc prunes source rows older than the retention window and reports the count", async () => {
    function writeTranscript(turns: readonly string[]): string {
      const path = join(home, "gc-transcript.jsonl");
      writeFileSync(
        path,
        turns.map((text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })).join("\n"),
        "utf8"
      );
      return path;
    }
    const transcript = writeTranscript(["Always run the linter before pushing, with some extra context in the turn."]);
    await runCli(["scan-session", "--transcript", transcript, "--root", "."]);

    const review = await runCli(["list", "--status", "pending", "--json"]);
    const id = (JSON.parse(review.stdout) as { facts: { id: string }[] }).facts[0]?.id ?? "";

    const db = openStorage(resolveDbPath());
    const before = listSourcesForFact(db, id);
    expect(before).toHaveLength(1);
    // Backdate the source row past the GC retention window, the same way the recall_log gc test ages its own rows -- gc keys on `stored_at`, which a fresh capture always sets to "now".
    db.prepare("UPDATE sources SET stored_at = ? WHERE id = ?").run(
      new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
      before[0]?.id
    );
    db.close();

    const gc = await runCli(["epoch", "--gc"]);
    expect(gc.exitCode).toBe(0);
    expect(gc.stdout).toMatch(/pruned_sources=1\b/u);

    const after = openStorage(resolveDbPath());
    try {
      expect(listSourcesForFact(after, id)).toEqual([]);
    } finally {
      after.close();
    }
  });
});

describe("mem epoch --gc prunes audit rows stamped in the future", () => {
  function seedAuditRow(id: string, offsetMs: number): void {
    const db = openDb(resolveDbPath());
    try {
      db.prepare("INSERT INTO audit_log (id, event, fact_id, detail, prior_json, created_at) VALUES (?, 'capture', NULL, 'seeded', NULL, ?)").run(
        id,
        new Date(Date.now() + offsetMs).toISOString()
      );
    } finally {
      db.close();
    }
  }

  function auditIds(): string[] {
    const db = openDb(resolveDbPath());
    try {
      return (db.prepare("SELECT id FROM audit_log WHERE id LIKE 'seed-%' ORDER BY id").all() as { id: string }[]).map((row) => row.id);
    } finally {
      db.close();
    }
  }

  it("removes a row stamped a year ahead, keeps a fresh row and one a minute ahead, and reports the count", async () => {
    seedAuditRow("seed-fresh", 0);
    seedAuditRow("seed-minute-ahead", 60 * 1000);
    seedAuditRow("seed-year-ahead", 365 * 24 * 60 * 60 * 1000);

    const gc = await runCli(["epoch", "--gc"]);
    expect(gc.exitCode, gc.stderr).toBe(0);
    expect(gc.stdout).toMatch(/pruned_audit_log_rows=1\b/u);
    expect(auditIds()).toEqual(["seed-fresh", "seed-minute-ahead"]);
  });
});

describe("mem dream", () => {
  const URL_ENV = "TOKEN_GOAT_MEM_DREAM_URL";
  const MODEL_ENV = "TOKEN_GOAT_MEM_DREAM_MODEL";
  const KEY_ENV = "TOKEN_GOAT_MEM_DREAM_API_KEY";

  afterEach(() => {
    delete process.env[URL_ENV];
    delete process.env[MODEL_ENV];
    delete process.env[KEY_ENV];
  });

  /** A real HTTP server on loopback, so these tests go through the CLI's own `fetch` rather than the `fetchImpl` seam the unit tests inject. That seam is where the request shaping is proven; what is proven here is the wiring around it -- that the command reads its config from the environment, reaches the endpoint, and renders what comes back. */
  async function withFakeEndpoint(
    reply: (received: unknown) => unknown,
    body: (url: string) => Promise<void>
  ): Promise<void> {
    const received: unknown[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += String(chunk)));
      req.on("end", () => {
        const parsed: unknown = JSON.parse(raw);
        received.push(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply(parsed)) } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      await body(`http://127.0.0.1:${port}/v1/chat/completions`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("says how to turn it on instead of failing obscurely when it is off", async () => {
    // Off is the normal state, so the error has to be an instruction rather than a complaint.
    const result = await runCli(["dream"]);
    expect(result.exitCode).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("not configured");
    expect(output).toContain(URL_ENV);
    expect(output).toContain(MODEL_ENV);
    // The one property of this command a user must not learn by surprise.
    expect(output).toContain("off this machine");
  });

  it("refuses a half-configured endpoint rather than silently doing nothing", async () => {
    process.env[URL_ENV] = "http://127.0.0.1:1/v1/chat/completions";
    const result = await runCli(["dream"]);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(MODEL_ENV);
  });

  it("never prints URL userinfo from an unparseable endpoint", async () => {
    process.env[URL_ENV] = "http://user:hunter2@host:99999";
    process.env[MODEL_ENV] = "m";
    const result = await runCli(["dream"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("is not a valid URL");
    for (const output of [result.stdout, result.stderr]) {
      expect(output).not.toContain("hunter2");
      expect(output).not.toContain("user:");
    }
  });

  it("rejects a --timeout that is not a positive number", async () => {
    process.env[URL_ENV] = "http://127.0.0.1:1/v1/chat/completions";
    process.env[MODEL_ENV] = "m";
    for (const bad of ["0", "-5", "abc"]) {
      const result = await runCli(["dream", "--timeout", bad]);
      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("--timeout must be a positive integer");
    }
  });

  it("tells `mem doctor` whether anything is configured to leave this machine", async () => {
    // The config lives in environment variables, so a URL exported once in a shell profile is otherwise invisible. `doctor` is where someone checks what the tool is set up to do.
    const off = await runCli(["doctor"]);
    expect(off.stdout).toContain("dreaming: off");

    process.env[URL_ENV] = "https://models.example.com/v1/chat/completions";
    process.env[MODEL_ENV] = "test-model";
    process.env[KEY_ENV] = "sk-do-not-print-me";
    const on = await runCli(["doctor"]);
    expect(on.stdout).toContain("dreaming: models.example.com");
    expect(on.stdout).toContain("model test-model");
    expect(on.stdout).toContain("api key configured");
    expect(on.stdout).toContain("sends fact text to this endpoint");
    // `mem doctor` output is the thing users paste into an issue.
    expect(on.stdout).not.toContain("sk-do-not-print-me");
    // Host only: a full URL can carry a token in its path or query.
    expect(on.stdout).not.toContain("/v1/chat/completions");
  });

  it("names the last-surfacing check and --probe-embeddings in `mem doctor --help`", async () => {
    const help = await runCli(["doctor", "--help"]);
    expect(help.stdout).toContain("surfaced a fact");
    expect(help.stdout).toContain("--probe-embeddings");
  });

  it("reports a broken dream config in `mem doctor` rather than crashing the health check", async () => {
    // doctor's whole job is to run when things are wrong; a misconfiguration must be a line in the report, not an exception that suppresses every check after it.
    process.env[URL_ENV] = "not a url";
    process.env[MODEL_ENV] = "test-model";
    // Doctor no longer creates the store, and the term-coverage line below needs one to count.
    openDb(resolveDbPath()).close();
    const result = await runCli(["doctor"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dreaming: misconfigured");
    expect(result.stdout).toContain("term coverage:");
  });

  it("does not offer a --root that would not scope anything", async () => {
    // A flag a user reads as scoping and that quietly is not is worse than no flag: `mem recall` already carries that edge, and a new command must not add a second instance of it.
    const help = await runCli(["dream", "--help"]);
    expect(`${help.stdout}${help.stderr}`).not.toContain("--root");
  });

  it("reports candidate inferences and writes nothing", async () => {
    await withFakeEndpoint(
      () => ({ candidates: [{ text: "deployment is entirely manual", kind: "fact", supports: [1, 2] }] }),
      async (url) => {
        process.env[URL_ENV] = url;
        process.env[MODEL_ENV] = "test-model";
        await runCli(["remember", "releases are cut by hand from a laptop", "--kind", "fact"]);
        await runCli(["remember", "there is no CI workflow in this repository", "--kind", "fact"]);

        const before = await runCli(["list", "--json"]);
        const result = await runCli(["dream"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("test-model via 127.0.0.1");
        expect(result.stdout).toContain("deployment is entirely manual");
        expect(result.stdout).toContain("this is a report");
        // The whole guarantee of the command: the store is byte-identical afterwards. A dry run that quietly wrote its own output back would be the one failure a user could not undo.
        const after = await runCli(["list", "--json"]);
        expect(after.stdout).toBe(before.stdout);
      }
    );
  });

  it("says plainly when nothing follows, rather than printing a bare header", async () => {
    await withFakeEndpoint(
      () => ({ candidates: [] }),
      async (url) => {
        process.env[URL_ENV] = url;
        process.env[MODEL_ENV] = "test-model";
        await runCli(["remember", "the build runs on node 20", "--kind", "fact"]);
        await runCli(["remember", "the lockfile is package-lock.json", "--kind", "fact"]);
        const result = await runCli(["dream"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("no candidate inferences");
      }
    );
  });

  it("sends only live facts, never ones the store has already retracted", async () => {
    // An inference grounded in a retracted premise is worse than no inference: it carries the authority of the store behind a claim the store has already decided is wrong.
    let sentToModel = "";
    await withFakeEndpoint(
      (received) => {
        const messages = (received as { messages: { content: string }[] }).messages;
        sentToModel = messages.map((message) => message.content).join("\n");
        return { candidates: [] };
      },
      async (url) => {
        process.env[URL_ENV] = url;
        process.env[MODEL_ENV] = "test-model";
        await runCli(["remember", "the deploy target is fly.io", "--kind", "fact"]);
        const forgotten = extractRememberedId(await runCli(["remember", "the deploy target is heroku", "--kind", "fact"]));
        await runCli(["forget", forgotten]);
        await runCli(["remember", "the runtime is node 20", "--kind", "fact"]);

        await runCli(["dream"]);
        expect(sentToModel).toContain("fly.io");
        expect(sentToModel).not.toContain("heroku");
      }
    );
  });

  it("withholds contested premises, same as `mem recall` -- reasoning over a live contradiction is the P3 failure one step removed", async () => {
    // Two active facts, same subject+scope, conflicting value, tied precedence: contradiction.ts resolves this to `contested` in memory (never persisted), and `retrieve()` withholds both from ground truth for exactly that reason. Neither is `superseded`, so the old `status: ["active", "pinned"]` filter let both through to the model as premises.
    let sentToModel = "";
    await withFakeEndpoint(
      (received) => {
        const messages = (received as { messages: { content: string }[] }).messages;
        sentToModel = messages.map((message) => message.content).join("\n");
        return { candidates: [] };
      },
      async (url) => {
        process.env[URL_ENV] = url;
        process.env[MODEL_ENV] = "test-model";
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
        const db = openDb(resolveDbPath());
        const tiedTimestamp = "2026-01-01T00:00:00.000Z";
        db.prepare("UPDATE facts SET captured_at = ? WHERE id IN (?, ?)").run(tiedTimestamp, idA, idB);
        db.close();
        await runCli(["remember", "the runtime is node 20", "--kind", "fact"]);
        await runCli(["remember", "the lockfile is package-lock.json", "--kind", "fact"]);

        const result = await runCli(["dream", "--json"]);
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout) as { factsSent: number };
        expect(sentToModel).not.toContain("pnpm");
        expect(sentToModel).not.toContain("npm");
        expect(sentToModel).toContain("node 20");
        expect(parsed.factsSent).toBe(2);
      }
    );
  });

  it("emits machine-readable JSON under --json", async () => {
    await withFakeEndpoint(
      () => ({ candidates: [{ text: "everything is manual", kind: "fact", supports: [1, 2] }] }),
      async (url) => {
        process.env[URL_ENV] = url;
        process.env[MODEL_ENV] = "test-model";
        await runCli(["remember", "releases are cut by hand", "--kind", "fact"]);
        await runCli(["remember", "there is no CI workflow", "--kind", "fact"]);
        const result = await runCli(["dream", "--json"]);
        const parsed = JSON.parse(result.stdout) as {
          model: string;
          factsSent: number;
          candidates: { text: string; supports: string[] }[];
        };
        expect(parsed.model).toBe("test-model");
        expect(parsed.factsSent).toBe(2);
        expect(parsed.candidates[0]?.text).toBe("everything is manual");
        // Ids the reader can follow with `mem show`, not indices into a list they never saw.
        expect(parsed.candidates[0]?.supports).toHaveLength(2);
      }
    );
  });
});

describe("mem epoch --json", () => {
  it("emits JSON with epoch field and preserves plain output unchanged", async () => {
    const plain = await runCli(["epoch"]);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout.trim()).toBe("0");

    await runCli(["remember", "test fact", "--kind", "fact"]);

    const plainAfter = await runCli(["epoch"]);
    expect(plainAfter.stdout.trim()).toBe("1");

    const json = await runCli(["epoch", "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as { epoch: number };
    expect(parsed.epoch).toBe(1);
  });

  it("rejects --json with --gc rather than printing prose under a JSON flag", async () => {
    const result = await runCli(["epoch", "--gc", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--json does not apply to --gc");
    expect(result.stdout).toBe("");
  });
});

describe("mem backup --list --json", () => {
  it("emits JSON array with snapshot objects and preserves plain output unchanged", async () => {
    // Create a fact first to ensure there's something to back up
    await runCli(["remember", "test fact", "--kind", "fact"]);

    // Take a backup
    const backupResult = await runCli(["backup"]);
    expect(backupResult.exitCode).toBe(0);

    const plain = await runCli(["backup", "--list"]);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).toContain("snapshots in");
    expect(plain.stdout).toContain("epoch");

    const json = await runCli(["backup", "--list", "--json"]);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as Array<{
      path: string;
      name: string;
      takenAt: string;
      epoch: number;
      reason: string;
      size: number;
    }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty("path");
    expect(parsed[0]).toHaveProperty("name");
    expect(parsed[0]).toHaveProperty("takenAt");
    expect(parsed[0]).toHaveProperty("epoch");
    expect(parsed[0]).toHaveProperty("reason");
    expect(parsed[0]).toHaveProperty("size");
    // takenAt round-trips through Date unchanged, so it is canonical ISO 8601
    const newest = parsed[0];
    if (newest === undefined) {
      throw new Error("expected at least one listed snapshot");
    }
    expect(new Date(newest.takenAt).toISOString()).toBe(newest.takenAt);
  });
});
