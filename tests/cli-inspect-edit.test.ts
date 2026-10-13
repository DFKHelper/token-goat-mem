/** End-to-end CLI tests for inspecting and changing stored facts: show, list, forget, edit, and short id prefixes. Each test gets an isolated `TOKEN_GOAT_MEM_HOME` (a fresh temp dir), re-applied per test so facts written by one test can never leak into another. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Loaded before ./support/cli.js so the child_process mock below is registered first; reaching it only through the CLI import deadlocks the mock factory (every sibling cli test imports it directly).
import "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRememberedId, runCli, type CliResult } from "./support/cli.js";
import { findSupersedingFactId, insertAuditLog, resolveDbPath } from "../src/db.js";
import { insertFact, openStorage } from "../src/storage.js";
import { captureSuggested } from "../src/capture.js";

// Process launches on this machine take 1-10 s, past the capability probe budget (MEM_PROBE_TIMEOUT_MS in wiring.ts); the floor keeps capability tests from timing out on launch latency.
vi.mock("node:child_process", async (importOriginal) => (await import("./support/spawnTimeoutFloor.js")).withSpawnTimeoutFloor(await importOriginal<typeof import("node:child_process")>()));

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-cli-test-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  rmSync(home, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────── forget --by ───────────────────────────────────────────────────────────────────────────

describe("mem forget --reason records why a fact was retired", () => {
  const rememberFact = async (text: string): Promise<string> =>
    extractRememberedId(await runCli(["remember", text, "--kind", "fact"]));

  const forgetDetails = (factId: string): string[] => {
    const db = openStorage(resolveDbPath());
    try {
      return (
        db.prepare("SELECT detail FROM audit_log WHERE fact_id = ? AND event = 'forget' ORDER BY rowid").all(factId) as {
          detail: string;
        }[]
      ).map((row) => row.detail);
    } finally {
      db.close();
    }
  };

  it.each(["wrong", "outdated", "duplicate", "unwanted"])("accepts --reason %s and records it on the audit row and in show", async (reason) => {
    const id = await rememberFact(`the ${reason} retirement fact`);
    const forgotten = await runCli(["forget", id, "--reason", reason]);
    expect(forgotten.exitCode).toBe(0);
    expect(forgotten.stdout).toBe(`forgot ${id}\n`);
    expect(forgetDetails(id)).toEqual([`forgot fact (was active); reason=${reason}`]);
    expect((await runCli(["show", id])).stdout).toContain(`forget_reason: ${reason}`);
  });

  it("does not echo a rejected --reason value back to stderr", async () => {
    const id = await rememberFact("the staging database is read only");
    const refused = await runCli(["forget", id, "--reason", "MARKER-rejected-free-text"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("--reason must be one of");
    expect(refused.stderr).not.toContain("MARKER-rejected-free-text");
  });

  it("refuses an unknown reason with a usage error and leaves the fact and audit log untouched", async () => {
    const id = await rememberFact("the staging database is read only");
    const refused = await runCli(["forget", id, "--reason", "bogus"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("--reason must be one of wrong, outdated, duplicate, unwanted");
    expect(forgetDetails(id)).toEqual([]);
    expect((await runCli(["show", id])).stdout).toContain("status: active");
  });

  it("keeps the winner resolvable when --by and --reason are given together", async () => {
    const loserId = await rememberFact("the deploy target is the blue cluster");
    const winnerId = await rememberFact("zebra quartz mango pipeline runs nightly");
    const forgotten = await runCli(["forget", loserId, "--by", winnerId, "--reason", "duplicate"]);
    expect(forgotten.exitCode).toBe(0);
    expect(forgetDetails(loserId)).toEqual([`Superseded by fact ${winnerId}: forgot fact (was active); reason=duplicate`]);

    const db = openStorage(resolveDbPath());
    try {
      expect(findSupersedingFactId(db, loserId)).toBe(winnerId);
    } finally {
      db.close();
    }
    const envelope = JSON.parse((await runCli(["show", loserId, "--json"])).stdout) as {
      supersededBy: { id: string } | null;
      forgetReason?: string;
    };
    expect(envelope.supersededBy?.id).toBe(winnerId);
    expect(envelope.forgetReason).toBe("duplicate");
    const shown = await runCli(["show", loserId]);
    expect(shown.stdout).toContain(`superseded_by: ${winnerId} (active)`);
    expect(shown.stdout).toContain("forget_reason: duplicate");
  });

  it("shows the reason on the timeline's forget entry", async () => {
    const id = await rememberFact("the nightly backup runs at two");
    expect((await runCli(["forget", id, "--reason", "outdated"])).exitCode).toBe(0);
    const log = await runCli(["log"]);
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain("forget: forgot fact (was active); reason=outdated");
  });

  it("leaves show, show --json and the timeline unchanged when no reason is given", async () => {
    const id = await rememberFact("the on-call rota rotates weekly");
    expect((await runCli(["forget", id])).stdout).toBe(`forgot ${id}\n`);
    expect(forgetDetails(id)).toEqual(["forgot fact (was active)"]);
    const shown = await runCli(["show", id]);
    expect(shown.stdout).not.toContain("forget_reason");
    expect(shown.stdout).toContain("superseded_by: unknown");
    const envelope = JSON.parse((await runCli(["show", id, "--json"])).stdout) as Record<string, unknown>;
    expect(envelope).not.toHaveProperty("forgetReason");
    expect((await runCli(["log"])).stdout).toContain("forget: forgot fact (was active)\n");
  });

  it("keeps the forget reason on show when a state-changing audit row follows the forget", async () => {
    const id = await rememberFact("the metrics exporter is pinned to port nine");
    expect((await runCli(["forget", id, "--reason", "wrong"])).exitCode).toBe(0);
    const db = openStorage(resolveDbPath());
    try {
      insertAuditLog(db, { event: "edit", factId: id, detail: "edited after the forget" });
    } finally {
      db.close();
    }
    expect((await runCli(["show", id])).stdout).toContain("forget_reason: wrong");
  });
});

describe("mem forget --by <winner> records the supersession edge", () => {
  const rememberFact = async (text: string): Promise<string> =>
    extractRememberedId(await runCli(["remember", text, "--kind", "fact"]));

  const seedFactWithId = (id: string): void => {
    const db = openStorage(resolveDbPath());
    insertFact(db, { id, text: `fact ${id}`, kind: "fact", scope: "global", source_type: "user" });
    db.close();
  };

  it("makes show --json and export report superseded_by for the forgotten fact", async () => {
    const loserId = await rememberFact("the deploy target is the blue cluster");
    const winnerId = await rememberFact("zebra quartz mango pipeline runs nightly");

    const forgotten = await runCli(["forget", loserId, "--by", winnerId]);
    expect(forgotten.exitCode).toBe(0);
    expect(forgotten.stdout).toBe(`forgot ${loserId}\n`);

    const shown = await runCli(["show", loserId]);
    expect(shown.stdout).toContain("status: superseded");
    expect(shown.stdout).toContain(`superseded_by: ${winnerId} (active)`);
    const envelope = JSON.parse((await runCli(["show", loserId, "--json"])).stdout) as {
      supersededBy: { id: string } | null;
    };
    expect(envelope.supersededBy?.id).toBe(winnerId);

    const exported = JSON.parse((await runCli(["export"])).stdout) as { facts: { id: string; superseded_by?: string | null }[] };
    expect(exported.facts.find((fact) => fact.id === loserId)?.superseded_by).toBe(winnerId);
  });

  it("accepts a unique prefix for the winner and records the resolved full id", async () => {
    const loserId = await rememberFact("the deploy target is the blue cluster");
    const winnerId = await rememberFact("zebra quartz mango pipeline runs nightly");

    expect((await runCli(["forget", loserId, "--by", winnerId.slice(0, 8)])).exitCode).toBe(0);
    const envelope = JSON.parse((await runCli(["show", loserId, "--json"])).stdout) as { supersededBy: { id: string } | null };
    expect(envelope.supersededBy?.id).toBe(winnerId);
  });

  it("accepts a pinned winner", async () => {
    const loserId = await rememberFact("the deploy target is the blue cluster");
    const winnerId = await rememberFact("zebra quartz mango pipeline runs nightly");
    expect((await runCli(["pin", winnerId])).exitCode).toBe(0);

    expect((await runCli(["forget", loserId, "--by", winnerId])).exitCode).toBe(0);
    const envelope = JSON.parse((await runCli(["show", loserId, "--json"])).stdout) as { supersededBy: { id: string } | null };
    expect(envelope.supersededBy?.id).toBe(winnerId);
  });

  it("rejects a fact naming itself as its own winner, changing nothing", async () => {
    const id = await rememberFact("the deploy target is the blue cluster");

    const result = await runCli(["forget", id, "--by", id]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot supersede itself");
    expect(JSON.parse((await runCli(["show", id, "--json"])).stdout)).toMatchObject({ fact: { status: "active" } });
  });

  it("rejects a winner that is not live, changing nothing", async () => {
    const loserId = await rememberFact("the deploy target is the blue cluster");
    const deadId = await rememberFact("zebra quartz mango pipeline runs nightly");
    expect((await runCli(["forget", deadId])).exitCode).toBe(0);

    const result = await runCli(["forget", loserId, "--by", deadId]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not live");
    const shown = await runCli(["show", loserId]);
    expect(shown.stdout).toContain("status: active");
  });

  it("rejects an unknown or ambiguous winner prefix with the same errors as the id argument, changing nothing", async () => {
    const loserId = await rememberFact("the deploy target is the blue cluster");
    seedFactWithId("eeee1111-0000-0000-0000-000000000001");
    seedFactWithId("eeee2222-0000-0000-0000-000000000002");

    const unknown = await runCli(["forget", loserId, "--by", "no-such-id"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("no such fact: no-such-id");

    const ambiguous = await runCli(["forget", loserId, "--by", "eeee"]);
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stderr).toContain('ambiguous id prefix "eeee"');

    expect((await runCli(["show", loserId])).stdout).toContain("status: active");
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

    const edited = await runCli(["edit", "aaaa1111", "--text", "edited via prefix", "--force"]);
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
    expect(promoted.stdout.trimEnd().split("\n")[0]).toBe("promoted bbbb1111-0000-0000-0000-000000000001");
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

  it("mem list rejects a malformed --limit argument", async () => {
    seedManyActiveFacts(5);
    const result = await runCli(["list", "--limit", "5x"]);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("--limit must be a positive integer");
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
    // The pending fact is captured first (oldest, so it would rank dead last in default newest-first ordering) -- if the default cap applied uniformly instead of exempting withheld results, it would never appear in the default (uncapped-for-pending) output.
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
    // 22 non-withheld facts matched; only 20 are shown by default -- the trailer reflects that, and it excludes the pending fact from both totals (it is never subject to the cap at all).
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
    // The whole point of the feature: the loser's own `mem show` answers "what replaced this?" without the reader parsing a sentence out of the audit log or running a second lookup.
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

    // Contradictions are recomputed at recall and persisted only by the retention pass, so the loser is still `active` until the retention pass runs. Driving `epoch --gc` here rather than asserting on an unreconciled store keeps the test honest about when the edge actually exists.
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

  it("still resolves the superseding fact after a later audit row (`mem used`) is appended", async () => {
    // `findSupersedingFactId` used to read the *last* audit row for a fact and assume it named the successor. `mem used` appends its own audit row after supersession, so once a superseded fact is later marked used, the last row is a "used" row, not a "superseded by" row -- and the lookup must not fall back to treating that as "no successor".
    const first = await runCli([
      "remember",
      "node 18 is the floor",
      "--kind",
      "decision",
      "--subject",
      "node-floor-used",
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
      "node-floor-used",
      "--value",
      "20",
    ]);
    const winnerId = extractRememberedId(second);

    expect((await runCli(["epoch", "--gc"])).exitCode).toBe(0);

    expect((await runCli(["used", loserId, "--session-id", "sess-1"])).exitCode).toBe(0);

    const shown = await runCli(["show", loserId]);
    expect(shown.stdout).toContain("status: superseded");
    expect(shown.stdout).toContain(`superseded_by: ${winnerId} (active): node 20 is the floor`);

    const envelope = JSON.parse((await runCli(["show", loserId, "--json"])).stdout) as {
      supersededBy: { id: string; status: string; text: string } | null;
    };
    expect(envelope.supersededBy).toEqual({ id: winnerId, status: "active", text: "node 20 is the floor" });
  });

  it("says so plainly, without asserting a specific cause, when a superseded fact has no recorded edge", async () => {
    // `forget` retires a fact without a winner, and so do `review --reject` and consolidate's stale pass -- but so does a fact superseded before an export/import round trip, whose winner may still be sitting right there in the store (audit_log, which is where the edge lives, is not part of the export envelope). Silence here would be indistinguishable from the feature not existing, so the absence is stated, but the wording must not name a cause it cannot actually rule out any of the others in favor of.
    const remembered = await runCli(["remember", "retired outright", "--kind", "fact"]);
    const id = extractRememberedId(remembered);
    expect((await runCli(["forget", id])).exitCode).toBe(0);

    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("status: superseded");
    expect(shown.stdout).toContain("superseded_by: unknown (no supersession edge recorded in this store's audit log");
    expect(shown.stdout).not.toContain("retired by forget, reject, or staleness");

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

describe("mem show --related", () => {
  it("ranks a shared-entity neighbour above a shared-topic-only neighbour", async () => {
    // Chosen so plain (unweighted) shared-topic counts alone would rank topicNeighbour first (4 shared topics vs. entityNeighbour's 2) -- only entity-weighting the one shared entity flips the order, so this actually exercises RELATED_ENTITY_WEIGHT rather than passing by accident.
    const target = await runCli(["remember", "the release plan pins the build to v9.9.9 while docs get updated", "--kind", "fact"]);
    const targetId = extractRememberedId(target);
    const entityNeighbour = await runCli(["remember", "the changelog also references v9.9.9 explicitly", "--kind", "fact"]);
    const entityId = extractRememberedId(entityNeighbour);
    const topicNeighbour = await runCli(["remember", "the docs and the release build plan need one more pass", "--kind", "fact"]);
    const topicId = extractRememberedId(topicNeighbour);

    const shown = await runCli(["show", targetId, "--related"]);
    expect(shown.exitCode).toBe(0);
    const relatedSection = shown.stdout.slice(shown.stdout.indexOf("related:"));
    expect(relatedSection.indexOf(entityId)).toBeGreaterThanOrEqual(0);
    expect(relatedSection.indexOf(topicId)).toBeGreaterThanOrEqual(0);
    expect(relatedSection.indexOf(entityId)).toBeLessThan(relatedSection.indexOf(topicId));
  });

  it("never lists the target fact itself", async () => {
    const remembered = await runCli(["remember", "src/cli.ts src/cli.ts src/cli.ts", "--kind", "fact"]);
    const id = extractRememberedId(remembered);

    const shown = await runCli(["show", id, "--related"]);
    expect(shown.exitCode).toBe(0);
    // The only fact carrying this entity is itself, so the honest answer is "none" -- not a related section that quietly includes the very fact being shown.
    expect(shown.stdout).toContain("related: none");
    expect(shown.stdout).not.toContain(`  - ${id}`);
  });

  it("excludes a superseded fact from the related list", async () => {
    const first = await runCli([
      "remember",
      "src/cli.ts owns the node floor at 18",
      "--kind",
      "decision",
      "--subject",
      "node-floor",
      "--value",
      "18",
    ]);
    const loserId = extractRememberedId(first);
    await runCli([
      "remember",
      "src/cli.ts owns the node floor at 20",
      "--kind",
      "decision",
      "--subject",
      "node-floor",
      "--value",
      "20",
    ]);
    expect((await runCli(["epoch", "--gc"])).exitCode).toBe(0);
    const loser = await runCli(["show", loserId]);
    expect(loser.stdout).toContain("status: superseded");

    const other = await runCli(["remember", "src/cli.ts needs one more review pass", "--kind", "fact"]);
    const otherId = extractRememberedId(other);

    const shown = await runCli(["show", otherId, "--related"]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).not.toContain(loserId);
  });

  it("includes a pending fact but labels it consistent with mem recall's own pending caveat", async () => {
    const active = await runCli(["remember", "src/cli.ts owns argument parsing", "--kind", "fact"]);
    const activeId = extractRememberedId(active);
    const suggested = await runCli(["suggest", "src/cli.ts might also own validation", "--kind", "preference"]);
    const pendingMatch = /suggested \S+ fact (\S+) \(pending\)/u.exec(suggested.stdout);
    const pendingId = pendingMatch?.[1] as string;
    expect(pendingId).toBeTruthy();

    const shown = await runCli(["show", activeId, "--related"]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain(pendingId);
    // Same wording `buildDisplay` already uses for a pending fact in `mem recall` output.
    expect(shown.stdout).toContain("(pending, unconfirmed)");
  });

  it("does not leak a related fact across project scope roots", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "mem-related-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "mem-related-b-"));
    const inA = await runCli(["remember", "src/cli.ts drives root a's routing", "--kind", "fact", "--scope", "project", "--root", rootA]);
    const idA = extractRememberedId(inA);
    const inB = await runCli(["remember", "src/cli.ts drives root b's routing", "--kind", "fact", "--scope", "project", "--root", rootB]);
    const idB = extractRememberedId(inB);

    const shown = await runCli(["show", idA, "--related", "--root", rootA]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).not.toContain(idB);
  });

  it("says plainly when nothing shares a term, rather than printing an empty section", async () => {
    const remembered = await runCli(["remember", "xqzvthisuniquephraseneverrepeats", "--kind", "fact"]);
    const id = extractRememberedId(remembered);

    const shown = await runCli(["show", id, "--related"]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain("related: none");
  });

  it("carries related in the --json shape, entity-scored above topic-only, with a caveat on a pending neighbour", async () => {
    const target = await runCli(["remember", "src/cli.ts handles the routing during testing", "--kind", "fact"]);
    const targetId = extractRememberedId(target);
    const entityNeighbour = await runCli(["remember", "src/cli.ts got a follow-up patch", "--kind", "fact"]);
    const entityId = extractRememberedId(entityNeighbour);
    const suggested = await runCli(["suggest", "testing should be part of every review", "--kind", "preference"]);
    const pendingMatch = /suggested \S+ fact (\S+) \(pending\)/u.exec(suggested.stdout);
    const pendingId = pendingMatch?.[1] as string;

    const shown = await runCli(["show", targetId, "--related", "--json"]);
    expect(shown.exitCode).toBe(0);
    const envelope = JSON.parse(shown.stdout) as {
      related: ReadonlyArray<{ id: string; status: string; sharedTerms: number; caveat: string | null }>;
    };
    expect(Array.isArray(envelope.related)).toBe(true);
    const byId = new Map(envelope.related.map((r) => [r.id, r]));
    expect(byId.has(entityId)).toBe(true);
    expect(byId.has(pendingId)).toBe(true);
    expect(byId.get(pendingId)?.status).toBe("pending");
    expect(byId.get(pendingId)?.caveat).toBe("pending, unconfirmed");
    const entityScore = byId.get(entityId)?.sharedTerms ?? 0;
    const pendingScore = byId.get(pendingId)?.sharedTerms ?? 0;
    expect(entityScore).toBeGreaterThan(pendingScore);
  });
});

// ─────────────────────────────────────────────────────────────────────────── edit audit detail ───────────────────────────────────────────────────────────────────────────

describe("mem edit records what the fact said before", () => {
  it("puts the prior value in the audit detail, since the edit overwrites it in place", async () => {
    // `mem edit` overwrites in place, so without this the prior text is unrecoverable from the store entirely: the audit log could say the text was edited but never what it used to say.
    const remembered = await runCli(["remember", "we use yarn", "--kind", "preference", "--scope", "global"]);
    const id = remembered.stdout.trim().split(/\s+/u).pop() ?? "";
    await runCli(["edit", id, "--text", "we use pnpm", "--force"]);

    const shown = JSON.parse((await runCli(["show", id, "--json"])).stdout) as {
      history?: Array<{ event: string; detail: string }>;
    };
    const edit = shown.history?.find((entry) => entry.event === "edit");
    expect(edit?.detail).toContain("we use yarn");
    expect(edit?.detail).toContain("we use pnpm");
    // The human surface has to answer it too -- `mem show --json` is documented as unstable.
    const human = (await runCli(["show", id])).stdout;
    expect(human).toContain("history:");
    expect(human).toContain("we use yarn");
  });
});

// ─────────────────────────────────────────────────────────────────────────── edit --undo ───────────────────────────────────────────────────────────────────────────

describe("mem edit --undo", () => {
  it("restores an edited fact's text byte-for-byte, past the 120-character audit preview", async () => {
    // `auditValuePreview` truncates at AUDIT_VALUE_PREVIEW_LENGTH (120), which is exactly why a reversal payload separate from the `detail` string exists: undo does not go through that truncation at all. A body shorter than 120 characters would not distinguish the two.
    const original =
      "we decided the ingestion worker must batch writes in groups of 250 rows because the upstream vendor API " +
      "throttles at 300 requests per minute and the retry budget is exhausted by the third burst, measured in staging";
    expect(original.length).toBeGreaterThan(120);

    const remembered = await runCli(["remember", original, "--kind", "decision"]);
    const id = extractRememberedId(remembered);

    await runCli(["edit", id, "--text", "ingestion worker batches 250 rows", "--force"]);
    const afterEdit = await runCli(["show", id]);
    expect(afterEdit.stdout).toContain("text: ingestion worker batches 250 rows");

    const undone = await runCli(["edit", id, "--undo"]);
    expect(undone.exitCode).toBe(0);
    expect(undone.stdout).toBe(`restored ${id}\n`);

    const restored = await runCli(["show", id]);
    expect(restored.stdout).toContain(`text: ${original}`);
  });

  it("redacts a secret-bearing prior value out of the edit audit row's detail and prior_json, instead of duplicating it", async () => {
    // Simulates a secret that slipped past capture-time screening (a heuristic, not a guarantee) -- inserted directly via storage, bypassing capture.ts entirely, the same way a hand-edited row or a gap in the screener's coverage would land one.
    const rawKey = "AKIAIOSFODNN7EXAMPLE";
    const db = openStorage(resolveDbPath());
    const fact = insertFact(db, {
      text: `uses key ${rawKey} for the legacy importer`,
      kind: "fact",
      scope: "global",
      source_type: "user",
    });
    db.close();

    const edited = await runCli(["edit", fact.id, "--text", "uses a rotated key for the legacy importer", "--force"]);
    expect(edited.exitCode).toBe(0);

    const auditDb = openStorage(resolveDbPath());
    const row = auditDb
      .prepare("SELECT detail, prior_json FROM audit_log WHERE fact_id = ? AND event = 'edit'")
      .get(fact.id) as { detail: string; prior_json: string | null };
    auditDb.close();

    expect(row.detail).not.toContain(rawKey);
    expect(row.detail).toContain("redacted");
    expect(row.prior_json ?? "").not.toContain(rawKey);
    expect(row.prior_json ?? "").toContain("redacted");

    // The edit itself still succeeds and stores the new (non-secret) text normally.
    const shown = await runCli(["show", fact.id]);
    expect(shown.stdout).toContain("text: uses a rotated key for the legacy importer");
  });

  it("refuses when the last recorded action was not an edit, naming that action", async () => {
    const remembered = await runCli(["remember", "we cache build output", "--kind", "decision"]);
    const id = extractRememberedId(remembered);
    await runCli(["edit", id, "--text", "we cache the build output aggressively", "--force"]);
    await runCli(["pin", id]);

    const result = await runCli(["edit", id, "--undo"]);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("last recorded action: pin");
    // Nothing moved: the edit that ran before the pin is still the current text.
    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("text: we cache the build output aggressively");
  });

  // Every path that creates a fact writes an audit row for it -- `capture_explicit` here, `json_import` for an imported one -- so a never-edited fact does not have an *empty* history, it has a history whose last row is not an edit. The refusal names that row rather than saying something generic, which is the difference between "you have not edited this" and "this command does not know what you did". Redacting a secret-shaped prior value on its way into the audit log is the right call -- it stops `mem edit` making a second at-rest copy of a credential that slipped past capture screening. The realistic way a value gets past capture and trips later is the allowlist: it was an accepted exception when the fact was stored, and is not one by the time the fact is edited. But the audit row is also what `--undo` restores from, so a redacted prior value means the original is gone. Restoring it anyway would write the literal marker in as the fact's text and report success; refusing says what actually happened and leaves the current value alone.
  it("refuses to undo an edit whose prior value was redacted, instead of restoring the marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "mem-undo-redacted-"));
    const secret = "AKIAIOSFODNN7EXAMPLE";
    mkdirSync(join(root, ".mem"), { recursive: true });
    writeFileSync(join(root, ".mem", "allowlist"), `${secret}
`, "utf8");

    const remembered = await runCli(["remember", `rotate ${secret} quarterly`, "--kind", "fact", "--root", root]);
    const id = extractRememberedId(remembered);

    // The exception lapses: the value is no longer allowlisted when the edit records the prior text.
    rmSync(join(root, ".mem", "allowlist"));
    const edited = await runCli(["edit", id, "--text", "rotate creds quarterly", "--force", "--root", root]);
    expect(edited.stderr).toBe("");

    const undone = await runCli(["edit", id, "--undo", "--root", root]);
    expect(undone.exitCode).toBe(1);
    const output = `${undone.stdout}${undone.stderr}`;
    expect(output).toContain("tripped secret screening at edit time");
    expect(output).toContain("nothing safe to restore");

    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("rotate creds quarterly");
    // The marker DOES appear further down, in the audit history -- that is where it belongs. What must not have happened is the marker being restored in as the fact's own text.
    expect(shown.stdout.split("history")[0]).not.toContain("[redacted: possible secret");
    rmSync(root, { recursive: true, force: true });
  });

  it("names the action it found when the last one was not an edit", async () => {
    const remembered = await runCli(["remember", "we deploy nightly", "--kind", "decision"]);
    const id = extractRememberedId(remembered);

    const result = await runCli(["edit", id, "--undo"]);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("last recorded action: capture_explicit");
  });

  it("rejects --undo combined with a field-setting option", async () => {
    const remembered = await runCli(["remember", "we run tests in CI", "--kind", "decision"]);
    const id = extractRememberedId(remembered);

    const result = await runCli(["edit", id, "--undo", "--text", "we run tests before merge"]);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("--undo cannot be used together");
  });

  it("refuses cleanly, rather than throwing, on an edit row that predates the prior_json column", async () => {
    const remembered = await runCli(["remember", "we vendor our own fork", "--kind", "decision"]);
    const id = extractRememberedId(remembered);

    // Simulates a database migrated from a pre-`prior_json` release: an `edit` audit row with no reversal payload, because the column did not exist when it was written. `insertAuditLog` omitting `priorJson` writes NULL, same as a real pre-migration row would read back as.
    const db = openStorage(resolveDbPath());
    insertAuditLog(db, { event: "edit", factId: id, detail: "edited text: (old) -> (new)" });
    db.close();

    const result = await runCli(["edit", id, "--undo"]);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("no recoverable prior value");
  });

  it("skips the `used` event when finding the last edit to undo", async () => {
    const remembered = await runCli(["remember", "we use async generators", "--kind", "decision"]);
    const id = extractRememberedId(remembered);

    await runCli(["edit", id, "--text", "we use async generators for streams", "--force"]);
    await runCli(["recall", "async"]);

    const undone = await runCli(["edit", id, "--undo"]);
    expect(undone.exitCode).toBe(0);
    expect(undone.stdout).toBe(`restored ${id}\n`);

    const restored = await runCli(["show", id]);
    expect(restored.stdout).toContain("text: we use async generators");
  });

  it("skips the refused-secret-edit event when finding the last edit to undo", async () => {
    const root = mkdtempSync(join(tmpdir(), "mem-undo-secret-"));
    const secret = "AKIA1234567890EXAMPLE";
    mkdirSync(join(root, ".mem"), { recursive: true });

    const remembered = await runCli(["remember", "we rotate secrets monthly", "--kind", "fact", "--root", root]);
    const id = extractRememberedId(remembered);

    await runCli(["edit", id, "--text", "we rotate secrets weekly", "--force", "--root", root]);

    expect((await runCli(["edit", id, "--text", `use secret ${secret} for backup`, "--force", "--root", root])).exitCode).toBe(1);
    expect((await runCli(["edit", id, "--text", `another ${secret} backup`, "--force", "--root", root])).exitCode).toBe(1);

    const undone = await runCli(["edit", id, "--undo", "--root", root]);
    expect(undone.exitCode).toBe(0);
    expect(undone.stdout).toBe(`restored ${id}\n`);

    const restored = await runCli(["show", id, "--root", root]);
    expect(restored.stdout).toContain("text: we rotate secrets monthly");
    rmSync(root, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────── edit source_type=user guard ───────────────────────────────────────────────────────────────────────────

describe("mem edit refuses to change a source_type=user fact without --force", () => {
  it("fails, names --force, and changes nothing", async () => {
    const remembered = await runCli(["remember", "we use pnpm", "--kind", "preference", "--scope", "global"]);
    const id = extractRememberedId(remembered);

    const result = await runCli(["edit", id, "--text", "we use yarn now"]);
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("--force");

    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("text: we use pnpm");
  });

  it("succeeds with --force, and the override is recorded in the audit log", async () => {
    const remembered = await runCli(["remember", "we use pnpm", "--kind", "preference", "--scope", "global"]);
    const id = extractRememberedId(remembered);

    const result = await runCli(["edit", id, "--text", "we use yarn now", "--force"]);
    expect(result.exitCode).toBe(0);

    const shown = JSON.parse((await runCli(["show", id, "--json"])).stdout) as {
      history?: Array<{ event: string; detail: string }>;
    };
    const edit = shown.history?.find((entry) => entry.event === "edit");
    expect(edit?.detail).toContain("--force override");
  });

  it("does not require --force for a derived fact (the guard is scoped, not a blanket block)", async () => {
    const db = openStorage(resolveDbPath());
    const { fact } = captureSuggested(db, { text: "we cache lookups", kind: "decision", root: home });
    db.close();
    expect(fact.source_type).toBe("derived");
    await runCli(["review", "--promote", fact.id]);

    const result = await runCli(["edit", fact.id, "--text", "we cache lookups aggressively"]);
    expect(result.exitCode).toBe(0);
    const shown = await runCli(["show", fact.id]);
    expect(shown.stdout).toContain("source_type: derived");
    expect(shown.stdout).toContain("text: we cache lookups aggressively");
  });
});

describe("mem edit keeps the value it is about to destroy", () => {
  it("records the whole prior text, not a 120-character prefix of it", async () => {
    // AGENTS.md: "an edited fact's previous text is recorded there and nowhere else, since mem edit overwrites in place." Measured against the built bundle, editing a 223-character fact left 103 characters recorded nowhere in the store -- the log kept a prefix of the one value it exists to preserve. The new value stays previewed: it is the fact's current text, one column away in the same row, so it is never the value that goes missing.
    const prior =
      "we decided the ingestion worker must batch writes in groups of 250 rows because the upstream vendor API " +
      "throttles at 300 requests per minute and the retry budget is exhausted by the third burst, measured in staging";
    expect(prior.length).toBeGreaterThan(120);

    const stored = await runCli(["remember", prior, "--kind", "decision"]);
    const id = /([0-9a-f-]{36})/u.exec(stored.stdout)?.[1];
    expect(id).toBeDefined();

    await runCli(["edit", String(id), "--text", "ingestion worker batches 250 rows", "--force"]);
    const shown = await runCli(["show", String(id)]);
    expect(shown.stdout).toContain(prior);
  });
});

describe("mem show and mem log hide the stamped-ref audit marker from text", () => {
  it("keeps [stamped_ref= in --json only, and leaves the source_ref line alone", { timeout: 120_000 }, async () => {
    const directory = join(home, "transcripts");
    mkdirSync(directory, { recursive: true });
    const transcript = join(directory, "transcript.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Remember that the staging box notes live in the wiki." }] } }), "utf8");
    const scanned = await runCli(["scan-session", "--transcript", transcript, "--root", home]);
    expect(scanned.exitCode, scanned.stderr).toBe(0);
    const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u.exec((await runCli(["list", "--status", "pending"])).stdout)?.[0] ?? "";
    expect(id, "scan-session filed no pending suggestion").not.toBe("");

    const json = await runCli(["show", id, "--json"]);
    expect(json.stdout).toContain("[stamped_ref=");
    const ref = (JSON.parse(json.stdout) as { fact: { source_ref: string } }).fact.source_ref;
    expect((await runCli(["log", "--json"])).stdout).toContain("[stamped_ref=");

    const shown = await runCli(["show", id]);
    expect(shown.stdout).toContain("capture_suggested");
    expect(shown.stdout).not.toContain("[stamped_ref=");
    expect(shown.stdout).toContain(`source_ref: ${ref}`);
    const log = await runCli(["log"]);
    expect(log.stdout).toContain("capture_suggested");
    expect(log.stdout).not.toContain("[stamped_ref=");
  });
});
