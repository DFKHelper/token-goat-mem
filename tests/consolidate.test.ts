/**
 * Tests for `mem consolidate` -- the near-duplicate pass and the stale pass -- plus the durable
 * `facts.last_surfaced_at` mark the stale pass depends on.
 *
 * Two layers, both against a real database: unit tests over `src/consolidate.ts`'s clustering rules
 * (which pairs may be compared at all, who survives, what is never touched), and end-to-end tests
 * driving the real `run()` for the parts that only exist at the CLI boundary -- dry-run-by-default,
 * `--apply`'s audit trail, and the flag validation.
 *
 * The one thing these must actually prove is that `--apply` cannot lose anything silently: every
 * loser is still in the store as `superseded`, with an audit row saying which pass moved it and
 * why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { run } from "../src/cli.js";
import {
  DEFAULT_DUPLICATE_THRESHOLD,
  DEFAULT_STALE_AGE_DAYS,
  findDuplicateClusters,
  findStaleFacts,
  jaccard,
  staleCutoff,
} from "../src/consolidate.js";
import { insertFact, insertRecallLog, listStaleUnsurfacedFacts, markRecallUsed, openStorage } from "../src/storage.js";
import type { Fact, FactKind, FactScope, FactStatus } from "../src/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

interface SeedOptions {
  readonly kind?: FactKind;
  readonly scope?: FactScope;
  readonly scopeRoot?: string | null;
  readonly status?: FactStatus;
  readonly confidence?: number;
  readonly capturedAt?: string;
  readonly id?: string;
}

function seed(db: Database.Database, text: string, options: SeedOptions = {}): Fact {
  return insertFact(db, {
    text,
    kind: options.kind ?? "preference",
    scope: options.scope ?? "global",
    source_type: "user",
    ...(options.scopeRoot !== undefined ? { scopeRoot: options.scopeRoot } : {}),
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(options.confidence !== undefined ? { confidence: options.confidence } : {}),
    ...(options.capturedAt !== undefined ? { captured_at: options.capturedAt } : {}),
    ...(options.id !== undefined ? { id: options.id } : {}),
  });
}

// Three restatements of one preference. Measured at Jaccard 1.00 against each other with this
// repo's tokenizer (the stemmer collapses "the"/"our"/"is" away as stopwords), so they cluster at
// any threshold the CLI accepts -- the tests below never have to encode a fragile score.
const PNPM_RESTATEMENTS = [
  "the package manager for this repo is pnpm",
  "package manager is pnpm for this repo",
  "our package manager for this repo is pnpm",
] as const;
/** Shares no stemmed topic with the three above, so it must never join their cluster. */
const UNRELATED = "always run npm run lint before pushing";

describe("jaccard", () => {
  it("is the intersection over the union", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3, 10);
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  it("scores two term-less facts 0, not 1 -- no topics is no evidence of similarity", () => {
    expect(jaccard(new Set<string>(), new Set<string>())).toBe(0);
    expect(jaccard(new Set(["a"]), new Set<string>())).toBe(0);
  });
});

describe("findDuplicateClusters", () => {
  let root: string;
  let db: Database.Database;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mem-consolidate-unit-"));
    db = openStorage(join(root, "mem.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("clusters restatements of one fact and leaves an unrelated fact alone", () => {
    for (const text of PNPM_RESTATEMENTS) {
      seed(db, text);
    }
    seed(db, UNRELATED);

    const clusters = findDuplicateClusters(db, DEFAULT_DUPLICATE_THRESHOLD);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.duplicates).toHaveLength(2);
    const texts = [clusters[0]?.keep.text, ...(clusters[0]?.duplicates ?? []).map((d) => d.fact.text)].sort();
    expect(texts).toEqual([...PNPM_RESTATEMENTS].sort());
  });

  it("never compares facts of different kinds, however alike their wording", () => {
    seed(db, PNPM_RESTATEMENTS[0], { kind: "preference" });
    seed(db, PNPM_RESTATEMENTS[1], { kind: "decision" });
    expect(findDuplicateClusters(db, DEFAULT_DUPLICATE_THRESHOLD)).toEqual([]);
  });

  it("never compares facts bound to different scope roots", () => {
    seed(db, PNPM_RESTATEMENTS[0], { scope: "project", scopeRoot: "/a" });
    seed(db, PNPM_RESTATEMENTS[1], { scope: "project", scopeRoot: "/b" });
    expect(findDuplicateClusters(db, DEFAULT_DUPLICATE_THRESHOLD)).toEqual([]);

    seed(db, PNPM_RESTATEMENTS[2], { scope: "project", scopeRoot: "/a" });
    const clusters = findDuplicateClusters(db, DEFAULT_DUPLICATE_THRESHOLD);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.keep.scopeRoot).toBe("/a");
    expect(clusters[0]?.duplicates.map((d) => d.fact.scopeRoot)).toEqual(["/a"]);
  });

  it("keeps the pinned fact and never proposes superseding a pinned one", () => {
    const pinned = seed(db, PNPM_RESTATEMENTS[0], { status: "pinned", confidence: 0.1, capturedAt: daysAgo(400) });
    seed(db, PNPM_RESTATEMENTS[1], { confidence: 1, capturedAt: daysAgo(1) });
    const alsoPinned = seed(db, PNPM_RESTATEMENTS[2], { status: "pinned", confidence: 0.05, capturedAt: daysAgo(500) });

    const clusters = findDuplicateClusters(db, DEFAULT_DUPLICATE_THRESHOLD);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.keep.id).toBe(pinned.id);
    expect(clusters[0]?.duplicates.map((d) => d.fact.status)).toEqual(["active"]);
    expect(clusters[0]?.retainedPinned.map((f) => f.id)).toEqual([alsoPinned.id]);
  });

  it("prefers higher confidence, then newer capture, when nothing is pinned", () => {
    seed(db, PNPM_RESTATEMENTS[0], { confidence: 0.4, capturedAt: daysAgo(1) });
    const best = seed(db, PNPM_RESTATEMENTS[1], { confidence: 0.9, capturedAt: daysAgo(300) });
    seed(db, PNPM_RESTATEMENTS[2], { confidence: 0.4, capturedAt: daysAgo(200) });

    expect(findDuplicateClusters(db, DEFAULT_DUPLICATE_THRESHOLD)[0]?.keep.id).toBe(best.id);
  });

  it("reports a similarity for every duplicate that is at least the threshold it was built at", () => {
    for (const text of PNPM_RESTATEMENTS) {
      seed(db, text);
    }
    for (const member of findDuplicateClusters(db, 0.75)[0]?.duplicates ?? []) {
      expect(member.similarity).toBeGreaterThanOrEqual(0.75);
    }
  });

  it("drops a cluster whose only other member is pinned -- there is nothing to propose", () => {
    seed(db, PNPM_RESTATEMENTS[0], { status: "pinned" });
    seed(db, PNPM_RESTATEMENTS[1], { status: "pinned" });
    expect(findDuplicateClusters(db, DEFAULT_DUPLICATE_THRESHOLD)).toEqual([]);
  });

  it("ignores facts that are not live: pending, contested, and already-superseded", () => {
    seed(db, PNPM_RESTATEMENTS[0]);
    seed(db, PNPM_RESTATEMENTS[1], { status: "pending" });
    seed(db, PNPM_RESTATEMENTS[2], { status: "contested" });
    expect(findDuplicateClusters(db, DEFAULT_DUPLICATE_THRESHOLD)).toEqual([]);
  });

  it("never clusters facts whose text yields no topic terms", () => {
    // Both texts are pure stopwords, so `extractFacets` stores no topics for either. An empty-set
    // Jaccard of 1 would make every such fact a duplicate of every other.
    seed(db, "the a of");
    seed(db, "is it to");
    expect(findDuplicateClusters(db, DEFAULT_DUPLICATE_THRESHOLD)).toEqual([]);
  });

  it("is deterministic across repeated runs on the same store", () => {
    for (const text of PNPM_RESTATEMENTS) {
      seed(db, text, { capturedAt: daysAgo(5), confidence: 0.5 });
    }
    const first = findDuplicateClusters(db, DEFAULT_DUPLICATE_THRESHOLD);
    const second = findDuplicateClusters(db, DEFAULT_DUPLICATE_THRESHOLD);
    expect(second.map((c) => [c.keep.id, ...c.duplicates.map((d) => d.fact.id)])).toEqual(
      first.map((c) => [c.keep.id, ...c.duplicates.map((d) => d.fact.id)])
    );
  });
});

describe("findStaleFacts and the durable last_surfaced_at mark", () => {
  let root: string;
  let db: Database.Database;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mem-consolidate-stale-"));
    db = openStorage(join(root, "mem.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("proposes only facts older than the cutoff", () => {
    const old = seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(200) });
    seed(db, "the test runner is vitest", { capturedAt: daysAgo(2) });
    const stale = findStaleFacts(db, staleCutoff(DEFAULT_STALE_AGE_DAYS, new Date()));
    expect(stale.map((f) => f.id)).toEqual([old.id]);
  });

  it("never proposes a pinned fact, however old and unread", () => {
    seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(900), status: "pinned" });
    expect(findStaleFacts(db, staleCutoff(DEFAULT_STALE_AGE_DAYS, new Date()))).toEqual([]);
  });

  it("never proposes a pending, contested, or already-superseded fact", () => {
    for (const status of ["pending", "contested", "superseded"] as const) {
      seed(db, `deploy note ${status}`, { capturedAt: daysAgo(400), status });
    }
    expect(findStaleFacts(db, staleCutoff(DEFAULT_STALE_AGE_DAYS, new Date()))).toEqual([]);
  });

  it("excludes a fact that recall has surfaced", () => {
    const fact = seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(400) });
    insertRecallLog(db, "session-1", [fact.id], daysAgo(300));
    expect(findStaleFacts(db, staleCutoff(DEFAULT_STALE_AGE_DAYS, new Date()))).toEqual([]);
  });

  it("excludes a fact that was marked useful", () => {
    const fact = seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(400) });
    insertRecallLog(db, "session-1", [fact.id], daysAgo(300));
    expect(markRecallUsed(db, [fact.id], "session-1", daysAgo(299))).toBe(1);
    expect(findStaleFacts(db, staleCutoff(DEFAULT_STALE_AGE_DAYS, new Date()))).toEqual([]);
  });

  it("still excludes a surfaced fact after its recall_log rows have been rotated away", () => {
    // The regression this column exists for. `mem epoch --gc` deletes recall_log rows older than 30
    // days, so a fact surfaced months ago has no row left; without the durable mark on `facts` it
    // would read as never-surfaced and the stale pass would propose superseding it.
    const fact = seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(400) });
    insertRecallLog(db, "session-1", [fact.id], daysAgo(300));
    db.prepare("DELETE FROM recall_log").run();
    expect(db.prepare("SELECT COUNT(*) AS c FROM recall_log").get()).toEqual({ c: 0 });

    expect(findStaleFacts(db, staleCutoff(DEFAULT_STALE_AGE_DAYS, new Date()))).toEqual([]);
  });

  it("keeps the surfacing mark monotonic when an older surfacing is replayed", () => {
    const fact = seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(400) });
    insertRecallLog(db, "session-1", [fact.id], daysAgo(10));
    insertRecallLog(db, "session-2", [fact.id], daysAgo(300));
    const mark = db.prepare("SELECT last_surfaced_at AS at FROM facts WHERE id = ?").get(fact.id) as { at: string };
    expect(mark.at).toBe(
      (db.prepare("SELECT MAX(surfaced_at) AS at FROM recall_log WHERE fact_id = ?").get(fact.id) as { at: string }).at
    );
  });

  it("still excludes a pre-migration fact whose only evidence is a surviving recall_log row", () => {
    // A fact captured before `last_surfaced_at` existed has NULL there and no honest backfill. The
    // recall_log NOT EXISTS clause is what covers that window, so simulate it by clearing the mark.
    const fact = seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(400) });
    insertRecallLog(db, "session-1", [fact.id], daysAgo(5));
    db.prepare("UPDATE facts SET last_surfaced_at = NULL WHERE id = ?").run(fact.id);
    expect(listStaleUnsurfacedFacts(db, staleCutoff(DEFAULT_STALE_AGE_DAYS, new Date()))).toEqual([]);
  });

  it("orders candidates oldest first", () => {
    const older = seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(500) });
    const newer = seed(db, "the test runner is vitest", { capturedAt: daysAgo(200) });
    expect(findStaleFacts(db, staleCutoff(DEFAULT_STALE_AGE_DAYS, new Date())).map((f) => f.id)).toEqual([
      older.id,
      newer.id,
    ]);
  });
});

// ── End-to-end: the real CLI ────────────────────────────────────────────────────────────────────

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

describe("mem consolidate (end to end)", () => {
  let home: string;

  function withStore<T>(fn: (db: Database.Database) => T): T {
    const db = openStorage();
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  function statusOf(id: string): string {
    return withStore((db) => (db.prepare("SELECT status FROM facts WHERE id = ?").get(id) as { status: string }).status);
  }

  function auditFor(id: string): { event: string; detail: string }[] {
    return withStore(
      (db) =>
        db.prepare("SELECT event, detail FROM audit_log WHERE fact_id = ? ORDER BY created_at").all(id) as {
          event: string;
          detail: string;
        }[]
    );
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mem-consolidate-e2e-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = home;
  });

  afterEach(() => {
    delete process.env["TOKEN_GOAT_MEM_HOME"];
    rmSync(home, { recursive: true, force: true });
  });

  it("reports duplicate clusters and changes nothing without --apply", async () => {
    const ids = withStore((db) => PNPM_RESTATEMENTS.map((text) => seed(db, text).id));
    withStore((db) => seed(db, UNRELATED));

    const result = await runCli(["consolidate"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("1 duplicate cluster at Jaccard >= 0.50 over topic terms (dry run, nothing changed)");
    expect(result.stdout).toContain("2 facts would be superseded -- re-run with --apply to act");
    expect(result.stdout).not.toContain(UNRELATED);
    for (const id of ids) {
      expect(statusOf(id)).toBe("active");
      expect(auditFor(id).map((row) => row.event)).not.toContain("consolidate_duplicate");
    }
  });

  it("--apply supersedes the losers, keeps one, and audit-logs why", async () => {
    const ids = withStore((db) => PNPM_RESTATEMENTS.map((text) => seed(db, text).id));

    const result = await runCli(["consolidate", "--apply"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("superseded 2 facts as duplicates");
    // The singular branch reads "as a duplicate"; a fixed-plural suffix on a pluralized count is
    // the slip this pins.
    expect(result.stdout).not.toContain("superseded 2 facts as a duplicate;");
    expect(result.stdout).toContain("`mem list --status superseded`");
    expect(result.stdout).not.toContain("dry run");

    const statuses = ids.map((id) => statusOf(id)).sort();
    expect(statuses).toEqual(["active", "superseded", "superseded"]);

    const keptId = ids.find((id) => statusOf(id) === "active");
    expect(keptId).toBeDefined();
    for (const id of ids.filter((candidate) => candidate !== keptId)) {
      const rows = auditFor(id).filter((row) => row.event === "consolidate_duplicate");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.detail).toContain(`superseded as a duplicate of ${keptId}`);
      expect(rows[0]?.detail).toMatch(/Jaccard \d\.\d\d over topic terms/u);
    }
    // The whole reversibility claim: nothing was deleted.
    expect(withStore((db) => db.prepare("SELECT COUNT(*) AS c FROM facts").get())).toEqual({ c: 3 });
  });

  it("a second --apply run has nothing left to do", async () => {
    withStore((db) => PNPM_RESTATEMENTS.map((text) => seed(db, text)));
    await runCli(["consolidate", "--apply"]);
    const second = await runCli(["consolidate", "--apply"]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout.trim()).toBe("no duplicate clusters at Jaccard >= 0.50 over topic terms");
  });

  it("--threshold tightens the pass and is reflected in the report", async () => {
    withStore((db) => {
      seed(db, "use pnpm not npm");
      seed(db, "use pnpm instead of npm for installs");
    });
    const loose = await runCli(["consolidate", "--threshold", "0.3"]);
    expect(loose.stdout).toContain("Jaccard >= 0.30");
    expect(loose.stdout).toContain("1 fact would be superseded");

    const tight = await runCli(["consolidate", "--threshold", "0.9"]);
    expect(tight.stdout.trim()).toBe("no duplicate clusters at Jaccard >= 0.90 over topic terms");
  });

  it("an empty store is a success, not an error", async () => {
    const result = await runCli(["consolidate"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("no duplicate clusters at Jaccard >= 0.50 over topic terms");
  });

  it("--stale reports old unread facts and changes nothing without --apply", async () => {
    const stale = withStore((db) => seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(400) }).id);
    const fresh = withStore((db) => seed(db, "the test runner is vitest").id);

    const result = await runCli(["consolidate", "--stale"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("1 stale fact: active, captured before ");
    expect(result.stdout).toContain("never surfaced by recall, never marked used (dry run, nothing changed)");
    expect(result.stdout).toContain(stale);
    expect(result.stdout).not.toContain(fresh);
    // Singular: the count pluralizes, so the sentence that follows it has to agree.
    expect(result.stdout).toContain("re-run with --apply to supersede it");
    expect(statusOf(stale)).toBe("active");

    // Plural, so neither branch of the agreement can regress unnoticed.
    withStore((db) => seed(db, "the changelog is generated at release", { capturedAt: daysAgo(400) }));
    const plural = await runCli(["consolidate", "--stale"]);
    expect(plural.stdout).toContain("2 stale facts: active, captured before ");
    expect(plural.stdout).toContain("re-run with --apply to supersede them");
  });

  it("--stale --apply supersedes and audit-logs the stale reason", async () => {
    const stale = withStore((db) => seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(400) }).id);

    const result = await runCli(["consolidate", "--stale", "--apply"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("superseded 1 stale fact;");
    expect(statusOf(stale)).toBe("superseded");
    const rows = auditFor(stale).filter((row) => row.event === "consolidate_stale");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("never surfaced by recall, never marked used");
  });

  it("--stale-days moves the window", async () => {
    withStore((db) => seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(100) }));
    expect((await runCli(["consolidate", "--stale", "--stale-days", "400"])).stdout.trim()).toBe(
      "no stale facts older than 400 days"
    );
    expect((await runCli(["consolidate", "--stale", "--stale-days", "50"])).stdout).toContain("1 stale fact");
  });

  it("--stale never touches a pinned fact", async () => {
    const pinned = withStore(
      (db) => seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(900), status: "pinned" }).id
    );
    const result = await runCli(["consolidate", "--stale", "--apply"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("no stale facts older than 90 days");
    expect(statusOf(pinned)).toBe("pinned");
  });

  it.each([
    [["consolidate", "--stale", "--threshold", "0.5"], "--threshold applies to the duplicate pass"],
    [["consolidate", "--stale-days", "5"], "--stale-days applies to --stale"],
    [["consolidate", "--threshold", "2"], "--threshold must be a number greater than 0 and at most 1"],
    [["consolidate", "--threshold", "0"], "--threshold must be a number greater than 0 and at most 1"],
    [["consolidate", "--threshold", "wat"], "--threshold must be a number greater than 0 and at most 1"],
    [["consolidate", "--stale", "--stale-days", "0"], "--stale-days must be a whole number of days, at least 1"],
    [["consolidate", "--stale", "--stale-days", "nope"], "--stale-days must be a whole number of days, at least 1"],
  ])("rejects %j as a usage error", async (args, message) => {
    const result = await runCli(args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^mem: \S/u);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe("");
  });
});
