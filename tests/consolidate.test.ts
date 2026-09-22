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
  findCrossProjectDuplicates,
  findCrossScopeDuplicates,
  findDuplicateClusters,
  findGraphStaleFacts,
  findRelatedFactPairs,
  findStaleFacts,
  jaccard,
  staleCutoff,
} from "../src/consolidate.js";
import {
  insertFact,
  insertRecallLog,
  listFactLinks,
  listStaleUnsurfacedFacts,
  markFactsSurfaced,
  markRecallUsed,
  openStorage,
  replaceFactTerms,
  setFactStatus,
} from "../src/storage.js";
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
  readonly subject?: string | null;
  readonly value?: string | null;
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
    ...(options.subject !== undefined ? { subject: options.subject } : {}),
    ...(options.value !== undefined ? { value: options.value } : {}),
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

  it("never clusters same-subject/same-scope facts with different values -- that is a live contradiction, not a duplicate", () => {
    // Wording is similar enough to clear the Jaccard threshold, but the pinned "postgres" answer
    // and the newer "mysql" answer disagree on the same subject: `detectContradictions` must own
    // resolving that, not `preferenceOrder`, or a pinned fact can outrank a later correction.
    seed(db, "the database server is postgres", { status: "pinned", subject: "db", value: "postgres" });
    seed(db, "the database server is mysql", { subject: "db", value: "mysql" });
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

describe("findCrossScopeDuplicates", () => {
  let root: string;
  let db: Database.Database;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mem-consolidate-cross-scope-"));
    db = openStorage(join(root, "mem.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("matches a project-scope fact against a same-kind global fact with identical text, keeping the global one", () => {
    const text = "always use two-space indentation";
    const globalFact = seed(db, text, { scope: "global" });
    const projectFact = seed(db, text, { scope: "project", scopeRoot: "/repo-a" });

    const duplicates = findCrossScopeDuplicates(db);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.keep.id).toBe(globalFact.id);
    expect(duplicates[0]?.duplicate.id).toBe(projectFact.id);
  });

  it("does not match facts of different kinds, however alike their wording", () => {
    const text = "always use two-space indentation";
    seed(db, text, { scope: "global", kind: "preference" });
    seed(db, text, { scope: "project", scopeRoot: "/repo-a", kind: "decision" });
    expect(findCrossScopeDuplicates(db)).toEqual([]);
  });

  it("does not report a same-subject, different-value pair as a duplicate -- that is a live contradiction, not a restatement", () => {
    // A genuine override's two sides differ in *value*, and so in text -- "use tabs for indentation"
    // and "use spaces for indentation" never share normalized text, the one bar this pass checks.
    seed(db, "use spaces for indentation", { scope: "global", subject: "indent-style", value: "spaces" });
    seed(db, "use tabs for indentation", { scope: "project", scopeRoot: "/repo-a", subject: "indent-style", value: "tabs" });
    expect(findCrossScopeDuplicates(db)).toEqual([]);
  });

  it("does not report a same-subject, different-value pair with byte-identical text -- a real override across scopes", () => {
    // The reproduction this fix exists for: generic wording ("the default branch name") makes it
    // easy for two legitimately different values to share exact text across scopes.
    seed(db, "the default branch name", { scope: "global", subject: "default_branch", value: "main" });
    seed(db, "the default branch name", { scope: "project", scopeRoot: "/repo-a", subject: "default_branch", value: "master" });
    expect(findCrossScopeDuplicates(db)).toEqual([]);
  });

  it("does not report a different-subject pair, even with identical text", () => {
    seed(db, "the default branch name", { scope: "global", subject: "default_branch", value: "main" });
    seed(db, "the default branch name", { scope: "project", scopeRoot: "/repo-a", subject: "release_branch", value: "main" });
    expect(findCrossScopeDuplicates(db)).toEqual([]);
  });

  it("still reports a same-subject, same-value pair with identical text as a duplicate", () => {
    const globalFact = seed(db, "the default branch name", { scope: "global", subject: "default_branch", value: "main" });
    const projectFact = seed(db, "the default branch name", {
      scope: "project",
      scopeRoot: "/repo-a",
      subject: "default_branch",
      value: "main",
    });
    const duplicates = findCrossScopeDuplicates(db);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.keep.id).toBe(globalFact.id);
    expect(duplicates[0]?.duplicate.id).toBe(projectFact.id);
  });

  it("does not match a project fact against a global fact of different text", () => {
    seed(db, "always use two-space indentation", { scope: "global" });
    seed(db, "always run the linter before pushing", { scope: "project", scopeRoot: "/repo-a" });
    expect(findCrossScopeDuplicates(db)).toEqual([]);
  });

  it("ignores facts that are not live: pending, contested, and already-superseded", () => {
    const text = "always use two-space indentation";
    seed(db, text, { scope: "global" });
    seed(db, text, { scope: "project", scopeRoot: "/repo-a", status: "pending" });
    expect(findCrossScopeDuplicates(db)).toEqual([]);
  });
});

describe("findCrossProjectDuplicates", () => {
  let root: string;
  let db: Database.Database;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mem-consolidate-cross-project-"));
    db = openStorage(join(root, "mem.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reports a same-kind, same-text fact present under two distinct projects, newest targeted first", () => {
    const text = "always use two-space indentation";
    const older = seed(db, text, { scope: "project", scopeRoot: "/repo-a", capturedAt: daysAgo(10) });
    const newer = seed(db, text, { scope: "project", scopeRoot: "/repo-b", capturedAt: daysAgo(1) });

    const groups = findCrossProjectDuplicates(db);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.newest.id).toBe(newer.id);
    expect(groups[0]?.facts.map((f) => f.id).sort()).toEqual([newer.id, older.id].sort());
  });

  it("does not report a fact present under only one project", () => {
    seed(db, "always use two-space indentation", { scope: "project", scopeRoot: "/repo-a" });
    expect(findCrossProjectDuplicates(db)).toEqual([]);
  });

  it("does not pair a project fact against a global fact of the same text -- that is findCrossScopeDuplicates's shape, not this one", () => {
    const text = "always use two-space indentation";
    seed(db, text, { scope: "global" });
    seed(db, text, { scope: "project", scopeRoot: "/repo-a" });
    expect(findCrossProjectDuplicates(db)).toEqual([]);
  });

  it("does not report a same-subject, different-value pair across two projects", () => {
    seed(db, "use spaces for indentation", { scope: "project", scopeRoot: "/repo-a", subject: "indent-style", value: "spaces" });
    seed(db, "use tabs for indentation", { scope: "project", scopeRoot: "/repo-b", subject: "indent-style", value: "tabs" });
    expect(findCrossProjectDuplicates(db)).toEqual([]);
  });

  it("does not report a same-subject, different-value pair with byte-identical text across two projects", () => {
    seed(db, "the default branch name", { scope: "project", scopeRoot: "/repo-a", subject: "default_branch", value: "main" });
    seed(db, "the default branch name", { scope: "project", scopeRoot: "/repo-b", subject: "default_branch", value: "master" });
    expect(findCrossProjectDuplicates(db)).toEqual([]);
  });

  it("does not report a different-subject pair, even with identical text", () => {
    seed(db, "the default branch name", { scope: "project", scopeRoot: "/repo-a", subject: "default_branch", value: "main" });
    seed(db, "the default branch name", { scope: "project", scopeRoot: "/repo-b", subject: "release_branch", value: "main" });
    expect(findCrossProjectDuplicates(db)).toEqual([]);
  });

  it("still reports a same-subject, same-value pair with identical text across two projects as a duplicate", () => {
    const older = seed(db, "the default branch name", {
      scope: "project",
      scopeRoot: "/repo-a",
      subject: "default_branch",
      value: "main",
      capturedAt: daysAgo(10),
    });
    const newer = seed(db, "the default branch name", {
      scope: "project",
      scopeRoot: "/repo-b",
      subject: "default_branch",
      value: "main",
      capturedAt: daysAgo(1),
    });
    const groups = findCrossProjectDuplicates(db);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.newest.id).toBe(newer.id);
    expect(groups[0]?.facts.map((f) => f.id).sort()).toEqual([newer.id, older.id].sort());
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

  it("excludes a fact that recall has surfaced inside the stale window", () => {
    const fact = seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(400) });
    insertRecallLog(db, "session-1", [fact.id], daysAgo(10));
    expect(findStaleFacts(db, staleCutoff(DEFAULT_STALE_AGE_DAYS, new Date()))).toEqual([]);
  });

  it("excludes a fact that was marked useful", () => {
    const fact = seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(400) });
    insertRecallLog(db, "session-1", [fact.id], daysAgo(300));
    expect(markRecallUsed(db, [fact.id], "session-1", daysAgo(299))).toBe(1);
    expect(findStaleFacts(db, staleCutoff(DEFAULT_STALE_AGE_DAYS, new Date()))).toEqual([]);
  });

  it("proposes a fact whose last surfacing predates the stale window, even with no recall_log row left", () => {
    // `last_surfaced_at` answers "has this gone unread for the window", not "was it ever read at
    // all" -- a fact surfaced once and then ignored for 300 days is exactly as stale as one that
    // was never surfaced. (`--stale-days` here is the default, 90; recall_log is cleared to also
    // prove this doesn't depend on a surviving row, e.g. after `mem epoch --gc` rotation.)
    const fact = seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(400) });
    insertRecallLog(db, "session-1", [fact.id], daysAgo(300));
    db.prepare("DELETE FROM recall_log").run();
    expect(db.prepare("SELECT COUNT(*) AS c FROM recall_log").get()).toEqual({ c: 0 });

    expect(findStaleFacts(db, staleCutoff(DEFAULT_STALE_AGE_DAYS, new Date())).map((f) => f.id)).toEqual([fact.id]);
  });

  it("still excludes a fact surfaced inside the window even after its recall_log row rotates away", () => {
    // Rotation itself must not manufacture false staleness: the durable `last_surfaced_at` mark
    // still says "recent" even once the row that produced it is gone.
    const fact = seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(400) });
    insertRecallLog(db, "session-1", [fact.id], daysAgo(10));
    db.prepare("DELETE FROM recall_log").run();
    expect(findStaleFacts(db, staleCutoff(DEFAULT_STALE_AGE_DAYS, new Date()))).toEqual([]);
  });

  it("never proposes a fact marked useful, no matter how old, as long as the used_at row survives", () => {
    const fact = seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(900) });
    insertRecallLog(db, "session-1", [fact.id], daysAgo(800));
    expect(markRecallUsed(db, [fact.id], "session-1", daysAgo(799))).toBe(1);
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
    expect(result.stdout).toContain("unsurfaced by recall since then, never marked used (dry run, nothing changed)");
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

  it("plain `mem recall` (no session id) marks a fact surfaced, so --stale never catches it", async () => {
    const id = withStore((db) => seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(400) }).id);

    const recall = await runCli(["recall"]);
    expect(recall.exitCode).toBe(0);
    expect(recall.stdout).toContain("fly.io");

    const result = await runCli(["consolidate", "--stale"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("no stale facts older than 90 days");
    expect(result.stdout).not.toContain(id);
    expect(statusOf(id)).toBe("active");
  });

  it("--stale --apply supersedes and audit-logs the stale reason", async () => {
    const stale = withStore((db) => seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(400) }).id);

    const result = await runCli(["consolidate", "--stale", "--apply"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("superseded 1 stale fact;");
    expect(statusOf(stale)).toBe("superseded");
    const rows = auditFor(stale).filter((row) => row.event === "consolidate_stale");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("unsurfaced by recall since");
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
    [["consolidate", "--cross-project", "--apply"], "--cross-project is report-only"],
    [["consolidate", "--cross-project", "--stale"], "--cross-project does not compose"],
    [["consolidate", "--cross-project", "--threshold", "0.5"], "--cross-project does not compose"],
    [["consolidate", "--related", "--stale"], "--related does not compose"],
    [["consolidate", "--related", "--cross-project"], "--cross-project does not compose"],
    [["consolidate", "--related", "--threshold", "0.5"], "--related does not compose"],
    [["consolidate", "--related", "--stale-days", "5"], "--stale-days applies to --stale"],
    [["consolidate", "--include-graph-stale"], "--include-graph-stale applies to --stale"],
  ])("rejects %j as a usage error", async (args, message) => {
    const result = await runCli(args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^mem: \S/u);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe("");
  });

  // ─────────────────────────────────────────────────────────────────────── cross-scope / cross-project ───────────────────────────────────────────────────────────────────────

  it("the default duplicate pass reports and, with --apply, supersedes a project-scope duplicate of a global fact", async () => {
    const text = "always use two-space indentation";
    const globalId = withStore((db) => seed(db, text, { scope: "global" }).id);
    const projectId = withStore((db) => seed(db, text, { scope: "project", scopeRoot: "/repo-a" }).id);

    const report = await runCli(["consolidate"]);
    expect(report.exitCode).toBe(0);
    expect(report.stdout).toContain("1 cross-scope duplicate: a project-scope fact restating a global one, word for word");
    expect(report.stdout).toContain("(dry run, nothing changed)");
    expect(statusOf(globalId)).toBe("active");
    expect(statusOf(projectId)).toBe("active");

    const applied = await runCli(["consolidate", "--apply"]);
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("superseded 1 project-scope duplicate;");
    expect(statusOf(globalId)).toBe("active");
    expect(statusOf(projectId)).toBe("superseded");
    const rows = auditFor(projectId).filter((row) => row.event === "consolidate_duplicate");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain(`superseded as a duplicate of ${globalId}`);
  });

  it("does not supersede a project-scope override of a global fact under --apply, even with byte-identical text", async () => {
    // The reproduction this fix exists for: same generic wording, but a genuine override (different
    // subject/value) rather than a restatement -- `--apply` must leave both sides active.
    const globalId = withStore(
      (db) => seed(db, "the default branch name", { scope: "global", subject: "default_branch", value: "main" }).id
    );
    const projectId = withStore(
      (db) =>
        seed(db, "the default branch name", {
          scope: "project",
          scopeRoot: "/repo-a",
          subject: "default_branch",
          value: "master",
        }).id
    );

    const report = await runCli(["consolidate"]);
    expect(report.exitCode).toBe(0);
    expect(report.stdout).not.toContain("cross-scope duplicate");

    const applied = await runCli(["consolidate", "--apply"]);
    expect(applied.exitCode).toBe(0);
    expect(statusOf(globalId)).toBe("active");
    expect(statusOf(projectId)).toBe("active");
  });

  it("--cross-project reports same-kind, same-text facts across two projects with no --apply path, and touches nothing", async () => {
    const text = "always use two-space indentation";
    const older = withStore((db) => seed(db, text, { scope: "project", scopeRoot: "/repo-a", capturedAt: daysAgo(10) }).id);
    const newer = withStore((db) => seed(db, text, { scope: "project", scopeRoot: "/repo-b", capturedAt: daysAgo(1) }).id);

    const result = await runCli(["consolidate", "--cross-project"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 statement restated under two or more distinct projects");
    expect(result.stdout).toContain("no --apply path");
    expect(result.stdout).toContain(`mem edit ${newer} --scope global`);
    expect(result.stdout).not.toContain(`mem edit ${older} --scope global`);
    expect(statusOf(older)).toBe("active");
    expect(statusOf(newer)).toBe("active");
  });

  it("--cross-project reports nothing for a store with no cross-project restatements", async () => {
    withStore((db) => seed(db, "always use two-space indentation", { scope: "project", scopeRoot: "/repo-a" }));
    const result = await runCli(["consolidate", "--cross-project"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("no same-kind, same-text facts found under two or more distinct projects");
  });
});

describe("findRelatedFactPairs", () => {
  let root: string;
  let db: Database.Database;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mem-consolidate-related-unit-"));
    db = openStorage(join(root, "mem.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reports a pair below the duplicate threshold, in canonical id order", () => {
    const first = seed(db, "fact one");
    const second = seed(db, "fact two");
    replaceFactTerms(db, first.id, { entities: [], topics: ["alpha", "beta"] });
    replaceFactTerms(db, second.id, { entities: [], topics: ["beta", "gamma"] }); // Jaccard 1/3

    const pairs = findRelatedFactPairs(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.similarity).toBeCloseTo(1 / 3, 10);
    const [lower, higher] = first.id <= second.id ? [first, second] : [second, first];
    expect(pairs[0]?.a.id).toBe(lower.id);
    expect(pairs[0]?.b.id).toBe(higher.id);
  });

  it("never links two facts sharing no topic terms -- zero similarity is no relation to record", () => {
    const first = seed(db, "fact one");
    const second = seed(db, "fact two");
    replaceFactTerms(db, first.id, { entities: [], topics: ["alpha"] });
    replaceFactTerms(db, second.id, { entities: [], topics: ["zeta"] });
    expect(findRelatedFactPairs(db)).toEqual([]);
  });

  it("never links a pair at or above the duplicate threshold -- that pair belongs to the merge pass, not this one", () => {
    for (const text of PNPM_RESTATEMENTS.slice(0, 2)) {
      seed(db, text);
    }
    // PNPM_RESTATEMENTS score 1.00 against each other with this repo's tokenizer (see the fixture's
    // own comment), well above DEFAULT_DUPLICATE_THRESHOLD.
    expect(findRelatedFactPairs(db)).toEqual([]);
    expect(findDuplicateClusters(db, DEFAULT_DUPLICATE_THRESHOLD)).toHaveLength(1);
  });

  it("THE TRAP: never links a live contradiction, even though it shares topic terms below the threshold", () => {
    // Same fixture as findDuplicateClusters's own contradiction test: same subject+scope, different
    // value. Terms chosen so their Jaccard (0.2) lands strictly inside (0, DEFAULT_DUPLICATE_THRESHOLD)
    // -- clear of both the zero-similarity filter and the merge threshold -- so only the
    // contradiction guard can be what excludes this pair.
    const postgres = seed(db, "the database server is postgres", { status: "pinned", subject: "db", value: "postgres" });
    const mysql = seed(db, "the database server is mysql", { subject: "db", value: "mysql" });
    replaceFactTerms(db, postgres.id, { entities: [], topics: ["database", "server", "postgres"] });
    replaceFactTerms(db, mysql.id, { entities: [], topics: ["database", "mysql", "cache"] });
    // Sanity: this pair scores inside the related band the guard has to actively exclude it from.
    const similarity = jaccard(new Set(["database", "server", "postgres"]), new Set(["database", "mysql", "cache"]));
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThan(DEFAULT_DUPLICATE_THRESHOLD);
    expect(findRelatedFactPairs(db)).toEqual([]);
  });

  it("never links facts of different kinds, the same comparability guard the duplicate pass uses", () => {
    const first = seed(db, "fact one", { kind: "preference" });
    const second = seed(db, "fact two", { kind: "decision" });
    replaceFactTerms(db, first.id, { entities: [], topics: ["alpha", "beta"] });
    replaceFactTerms(db, second.id, { entities: [], topics: ["beta", "gamma"] });
    expect(findRelatedFactPairs(db)).toEqual([]);
  });
});

describe("findGraphStaleFacts", () => {
  let root: string;
  let db: Database.Database;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mem-consolidate-graph-stale-unit-"));
    db = openStorage(join(root, "mem.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * `neighbours` (factgraph.ts) drops a term outright once its document frequency exceeds the
   * default df ceiling (60% of the store) -- a real safety feature (hub-term damping), not
   * something these fixtures should trip over by accident. Padding the store with `count`
   * unrelated facts keeps "redis" comfortably under that ceiling so a test's assertions are about
   * the staleness signal, not about incidentally recreating the hub-term exclusion.
   */
  function seedFiller(count: number): void {
    for (let i = 0; i < count; i += 1) {
      const filler = seed(db, `unrelated filler fact ${i}`);
      replaceFactTerms(db, filler.id, { entities: [], topics: [`filler-${i}`] });
    }
  }

  it("flags a candidate whose neighbours are majority-superseded", () => {
    seedFiller(2); // 3 redis-tagged facts over 5 total keeps "redis" under the 60% df ceiling
    const candidate = seed(db, "redis config lives in config/redis.yml", { capturedAt: daysAgo(200) });
    const supersededA = seed(db, "we use redis for caching");
    const supersededB = seed(db, "redis is the cache layer");
    for (const fact of [candidate, supersededA, supersededB]) {
      replaceFactTerms(db, fact.id, { entities: [], topics: ["redis"] });
    }
    setFactStatus(db, supersededA.id, "superseded");
    setFactStatus(db, supersededB.id, "superseded");

    const cutoff = daysAgo(90);
    const results = findGraphStaleFacts(db, cutoff);
    expect(results).toHaveLength(1);
    expect(results[0]?.fact.id).toBe(candidate.id);
    expect(results[0]?.supersededNeighbours).toBe(2);
    expect(results[0]?.totalNeighbours).toBe(2);
  });

  it("does not flag a candidate whose neighbours are only a minority superseded", () => {
    seedFiller(3); // 4 redis-tagged facts over 7 total, same df-ceiling reasoning as above
    const candidate = seed(db, "redis config lives in config/redis.yml", { capturedAt: daysAgo(200) });
    const superseded = seed(db, "we use redis for caching");
    const activeA = seed(db, "redis is the cache layer");
    const activeB = seed(db, "the redis client library is ioredis");
    for (const fact of [candidate, superseded, activeA, activeB]) {
      replaceFactTerms(db, fact.id, { entities: [], topics: ["redis"] });
    }
    setFactStatus(db, superseded.id, "superseded");

    expect(findGraphStaleFacts(db, daysAgo(90))).toEqual([]);
  });

  it("does not flag a candidate with too few neighbours to carry a signal", () => {
    const candidate = seed(db, "redis config lives in config/redis.yml", { capturedAt: daysAgo(200) });
    const superseded = seed(db, "we use redis for caching");
    replaceFactTerms(db, candidate.id, { entities: [], topics: ["redis"] });
    replaceFactTerms(db, superseded.id, { entities: [], topics: ["redis"] });
    setFactStatus(db, superseded.id, "superseded");

    // Only one neighbour: below GRAPH_STALE_MIN_NEIGHBOURS, whatever its status.
    expect(findGraphStaleFacts(db, daysAgo(90))).toEqual([]);
  });

  it("never flags a fact captured after the cutoff, however superseded its neighbours are", () => {
    const candidate = seed(db, "redis config lives in config/redis.yml", { capturedAt: daysAgo(1) });
    const supersededA = seed(db, "we use redis for caching");
    const supersededB = seed(db, "redis is the cache layer");
    for (const fact of [candidate, supersededA, supersededB]) {
      replaceFactTerms(db, fact.id, { entities: [], topics: ["redis"] });
    }
    setFactStatus(db, supersededA.id, "superseded");
    setFactStatus(db, supersededB.id, "superseded");

    expect(findGraphStaleFacts(db, daysAgo(90))).toEqual([]);
  });

  it("excludes ids the caller already attributed to the age-based pass", () => {
    const candidate = seed(db, "redis config lives in config/redis.yml", { capturedAt: daysAgo(200) });
    const supersededA = seed(db, "we use redis for caching");
    const supersededB = seed(db, "redis is the cache layer");
    for (const fact of [candidate, supersededA, supersededB]) {
      replaceFactTerms(db, fact.id, { entities: [], topics: ["redis"] });
    }
    setFactStatus(db, supersededA.id, "superseded");
    setFactStatus(db, supersededB.id, "superseded");

    expect(findGraphStaleFacts(db, daysAgo(90), new Set([candidate.id]))).toEqual([]);
  });

  it("never flags a pinned fact", () => {
    const candidate = seed(db, "redis config lives in config/redis.yml", { capturedAt: daysAgo(200), status: "pinned" });
    const supersededA = seed(db, "we use redis for caching");
    const supersededB = seed(db, "redis is the cache layer");
    for (const fact of [candidate, supersededA, supersededB]) {
      replaceFactTerms(db, fact.id, { entities: [], topics: ["redis"] });
    }
    setFactStatus(db, supersededA.id, "superseded");
    setFactStatus(db, supersededB.id, "superseded");

    expect(findGraphStaleFacts(db, daysAgo(90))).toEqual([]);
  });
});

describe("mem consolidate --related (end to end)", () => {
  let home: string;

  function withStore<T>(fn: (db: Database.Database) => T): T {
    const db = openStorage();
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mem-consolidate-related-e2e-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = home;
  });

  afterEach(() => {
    delete process.env["TOKEN_GOAT_MEM_HOME"];
    rmSync(home, { recursive: true, force: true });
  });

  it("reports related pairs and writes nothing to fact_links without --apply", async () => {
    const ids = withStore((db) => {
      const first = seed(db, "fact one");
      const second = seed(db, "fact two");
      replaceFactTerms(db, first.id, { entities: [], topics: ["alpha", "beta"] });
      replaceFactTerms(db, second.id, { entities: [], topics: ["beta", "gamma"] });
      return [first.id, second.id];
    });

    const result = await runCli(["consolidate", "--related"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 related fact pair");
    expect(result.stdout).toContain("(dry run, nothing changed)");
    expect(result.stdout).toContain("re-run with --apply to store it");
    expect(withStore((db) => listFactLinks(db))).toEqual([]);
    // Nothing about a report-only pass may change a fact's own status.
    for (const id of ids) {
      expect(withStore((db) => db.prepare("SELECT status FROM facts WHERE id = ?").get(id))).toEqual({
        status: "active",
      });
    }
  });

  it("--apply persists exactly one row per pair, stable across a second run", async () => {
    withStore((db) => {
      const first = seed(db, "fact one");
      const second = seed(db, "fact two");
      replaceFactTerms(db, first.id, { entities: [], topics: ["alpha", "beta"] });
      replaceFactTerms(db, second.id, { entities: [], topics: ["beta", "gamma"] });
    });

    const first = await runCli(["consolidate", "--related", "--apply"]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("persisted 1 fact link");
    expect(withStore((db) => listFactLinks(db))).toHaveLength(1);

    // A second --apply run over the same store must refresh, not duplicate, the row (see
    // storage.upsertFactLink's own ordering guarantee).
    const second = await runCli(["consolidate", "--related", "--apply"]);
    expect(second.exitCode).toBe(0);
    expect(withStore((db) => listFactLinks(db))).toHaveLength(1);
  });

  it("an empty store reports nothing to link", async () => {
    const result = await runCli(["consolidate", "--related"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("no related facts found below the duplicate threshold");
  });
});

describe("mem consolidate --stale --include-graph-stale (end to end)", () => {
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

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mem-consolidate-graph-stale-e2e-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = home;
  });

  afterEach(() => {
    delete process.env["TOKEN_GOAT_MEM_HOME"];
    rmSync(home, { recursive: true, force: true });
  });

  it("--stale --apply supersedes the identical set whether or not the graph signal would also flag something -- absent by default", async () => {
    // A fact old enough and unsurfaced -- the age-based pass's own population.
    const ageStale = withStore((db) => seed(db, "we deploy to fly.io on merge", { capturedAt: daysAgo(400) }).id);
    // A separate candidate the graph signal alone WOULD flag if asked (old enough, neighbours
    // majority superseded) but the age-based pass never would: marked recently surfaced, so
    // `findStaleFacts`'s own "unsurfaced since the cutoff" test excludes it. Its presence proves
    // `--include-graph-stale`'s absence changes nothing -- not merely that the fixture was too weak
    // for either pass to ever catch.
    const graphCandidate = withStore((db) => {
      replaceFactTerms(db, seed(db, "unrelated filler fact 0").id, { entities: [], topics: ["filler-0"] });
      replaceFactTerms(db, seed(db, "unrelated filler fact 1").id, { entities: [], topics: ["filler-1"] });
      const candidate = seed(db, "redis config lives in config/redis.yml", { capturedAt: daysAgo(200) });
      markFactsSurfaced(db, [candidate.id], new Date().toISOString());
      const supersededA = seed(db, "we use redis for caching");
      const supersededB = seed(db, "redis is the cache layer");
      for (const fact of [candidate, supersededA, supersededB]) {
        replaceFactTerms(db, fact.id, { entities: [], topics: ["redis"] });
      }
      setFactStatus(db, supersededA.id, "superseded");
      setFactStatus(db, supersededB.id, "superseded");
      return candidate.id;
    });

    const withoutFlag = await runCli(["consolidate", "--stale", "--apply"]);
    expect(withoutFlag.exitCode).toBe(0);
    expect(statusOf(ageStale)).toBe("superseded");
    expect(statusOf(graphCandidate)).toBe("active"); // never touched -- the signal was never asked for
  });

  it("--include-graph-stale additionally supersedes a graph-flagged fact with a distinct, accurate audit reason", async () => {
    const graphCandidate = withStore((db) => {
      // Two unrelated filler facts keep "redis" under `neighbours`' default 60% df ceiling (3 of 5
      // facts, not 3 of 3) -- see findGraphStaleFacts's own unit tests for the same reasoning.
      replaceFactTerms(db, seed(db, "unrelated filler fact 0").id, { entities: [], topics: ["filler-0"] });
      replaceFactTerms(db, seed(db, "unrelated filler fact 1").id, { entities: [], topics: ["filler-1"] });
      const candidate = seed(db, "redis config lives in config/redis.yml", { capturedAt: daysAgo(200) });
      // Marked recently surfaced so the age-based pass's own "unsurfaced since the cutoff" test
      // excludes it -- otherwise this fixture (old, never recalled) would also qualify for
      // `findStaleFacts` and this test could not tell which pass actually superseded it.
      markFactsSurfaced(db, [candidate.id], new Date().toISOString());
      const supersededA = seed(db, "we use redis for caching");
      const supersededB = seed(db, "redis is the cache layer");
      for (const fact of [candidate, supersededA, supersededB]) {
        replaceFactTerms(db, fact.id, { entities: [], topics: ["redis"] });
      }
      setFactStatus(db, supersededA.id, "superseded");
      setFactStatus(db, supersededB.id, "superseded");
      return candidate.id;
    });

    const result = await runCli(["consolidate", "--stale", "--include-graph-stale", "--apply"]);
    expect(result.exitCode).toBe(0);
    expect(statusOf(graphCandidate)).toBe("superseded");

    const rows = withStore(
      (db) =>
        db.prepare("SELECT event, detail FROM audit_log WHERE fact_id = ? ORDER BY created_at").all(graphCandidate) as {
          event: string;
          detail: string;
        }[]
    );
    const graphRow = rows.find((row) => row.event === "consolidate_graph_stale");
    expect(graphRow).toBeDefined();
    // The reason must be true of *this* fact, not the age-based pass's reason repurposed: this fact
    // was captured 200 days ago and never surfaced, so an unfalsifiable "unsurfaced since" string
    // would also happen to read true -- the distinct wording is what makes the claim checkable.
    expect(graphRow?.detail).toBe("superseded via graph staleness: 2 of 2 topic-connected neighbours already superseded");
    expect(rows.some((row) => row.event === "consolidate_stale")).toBe(false);
  });

  it("--include-graph-stale without --apply reports the additional candidate but changes nothing", async () => {
    const graphCandidate = withStore((db) => {
      replaceFactTerms(db, seed(db, "unrelated filler fact 0").id, { entities: [], topics: ["filler-0"] });
      replaceFactTerms(db, seed(db, "unrelated filler fact 1").id, { entities: [], topics: ["filler-1"] });
      const candidate = seed(db, "redis config lives in config/redis.yml", { capturedAt: daysAgo(200) });
      // Marked recently surfaced so the age-based pass's own "unsurfaced since the cutoff" test
      // excludes it -- otherwise this fixture would also be a `findStaleFacts` candidate, and the
      // report line asserted below could come from either pass.
      markFactsSurfaced(db, [candidate.id], new Date().toISOString());
      const supersededA = seed(db, "we use redis for caching");
      const supersededB = seed(db, "redis is the cache layer");
      for (const fact of [candidate, supersededA, supersededB]) {
        replaceFactTerms(db, fact.id, { entities: [], topics: ["redis"] });
      }
      setFactStatus(db, supersededA.id, "superseded");
      setFactStatus(db, supersededB.id, "superseded");
      return candidate.id;
    });

    const result = await runCli(["consolidate", "--stale", "--include-graph-stale"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 additional stale fact");
    expect(result.stdout).toContain("(dry run, nothing changed)");
    expect(statusOf(graphCandidate)).toBe("active");
  });
});
