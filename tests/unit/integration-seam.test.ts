import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db.js";
import { markRecallUsed, openStorage, setEmbeddingMeta, updateFact } from "../../src/storage.js";
import { EMBED_MODEL_ENV, EMBED_URL_ENV } from "../../src/embeddings.js";
import { startStubEmbeddingServer, type StubEmbeddingServer } from "../support/embedding-server.js";
import { AGGRESSIVE_RECALL_BOOST, retrieve, STOPWORDS } from "../../src/retrieval.js";
import { buildHintFormat, TGMEM_FOOTER_LINE, TGMEM_HEADER } from "../../src/integration-seam.js";
import type { Fact } from "../../src/types.js";
import type { HintFormatOptions, HintFormatResult } from "../../src/integration-seam.js";

/** A soft budget no test machine can exceed. */
const NO_TRUNCATION_BUDGET_MS = 3_600_000;

/**
 * `buildHintFormat` with truncation taken out of the picture, and the only entry point this file
 * should use.
 *
 * The seam returns an *empty* hint set when retrieval overruns its 150ms soft budget, because
 * TGMEM/2 has no way to say "this is partial" and a reduced response is byte-indistinguishable
 * from a complete one. That is correct, deliberate behaviour -- but it means every assertion about
 * *which* facts come back is silently also an assertion about how fast the runner is. On the first
 * two CI runs that turned three selection tests red on Windows and green on Linux, for no reason
 * connected to what they test.
 *
 * Pinning per-test only fixes the tests that happened to go red, so the next slow runner finds the
 * next one. Defaulting it here means a new test cannot acquire the flake by omission; the spread
 * puts `options` last so the tests that *are* about exhaustion can still force the budget to 0.
 */
async function buildHint(options: HintFormatOptions): Promise<HintFormatResult> {
  return buildHintFormat({ retrievalBudgetMs: NO_TRUNCATION_BUDGET_MS, ...options });
}

/** TGMEM/2's fact-lines, with the trailing footer-line (if any) stripped -- for assertions about the fact caps/ordering that predate the footer line. */
function factLines(result: HintFormatResult): readonly string[] {
  return result.lines.filter((line) => line !== TGMEM_FOOTER_LINE);
}

interface FactSeed {
  readonly id: string;
  readonly text: string;
  readonly kind: Fact["kind"];
  readonly subject?: string | null;
  readonly value?: string | null;
  readonly scope: Fact["scope"];
  readonly scopeRoot?: string | null;
  readonly source_type: Fact["source_type"];
  readonly captured_at: string;
  readonly anchor?: string | null;
  readonly status: Fact["status"];
  readonly confidence?: number;
}

function seedFacts(dbPath: string, seeds: readonly FactSeed[]): void {
  const db = openDb(dbPath);
  const insert = db.prepare(
    `INSERT INTO facts (id, text, kind, subject, value, scope, scope_root, source_type, source_ref, captured_at, anchor, status, confidence)
     VALUES (@id, @text, @kind, @subject, @value, @scope, @scopeRoot, @source_type, @source_ref, @captured_at, @anchor, @status, @confidence)`
  );
  // One transaction, not one implicit transaction per row. An unwrapped insert commits on its
  // own, so seeding 500 facts costs 500 durability syncs -- 73ms on a local NVMe and over the
  // 5s vitest default on a cold windows-latest runner, which is what turned
  // `emits exactly the cap-limited set` red on the v0.4.0 release. Retrieval itself was never
  // the cost: a query-less buildHintFormat over 500 facts returns inside the 150ms budget.
  // `.immediate()` follows the convention tests/guards/transactions.test.ts pins for src.
  const insertAll = db.transaction((rows: readonly FactSeed[]) => {
    for (const seed of rows) {
      insert.run({
        id: seed.id,
        text: seed.text,
        kind: seed.kind,
        subject: seed.subject ?? null,
        value: seed.value ?? null,
        scope: seed.scope,
        scopeRoot: seed.scopeRoot ?? null,
        source_type: seed.source_type,
        source_ref: null,
        captured_at: seed.captured_at,
        anchor: seed.anchor ?? null,
        status: seed.status,
        confidence: seed.confidence ?? 1,
      });
    }
  });
  insertAll.immediate(seeds);
  db.close();
}

describe("buildHintFormat", () => {
  let workDir: string;
  let root: string;
  let dbPath: string;
  let priorEmbedEnv: Record<string, string | undefined> = {};
  const openServers: StubEmbeddingServer[] = [];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "mem-seam-test-"));
    root = join(workDir, "project");
    mkdirSync(root, { recursive: true });
    dbPath = join(workDir, "mem.db");
    priorEmbedEnv = { [EMBED_URL_ENV]: process.env[EMBED_URL_ENV], [EMBED_MODEL_ENV]: process.env[EMBED_MODEL_ENV] };
  });

  afterEach(async () => {
    // Record/set/restore rather than delete, matching tests/setup/isolate-home.ts: an embedding
    // variable left set here would silently turn ranking on for every later test in this worker.
    for (const key of [EMBED_URL_ENV, EMBED_MODEL_ENV] as const) {
      const prior = priorEmbedEnv[key];
      if (prior === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prior;
      }
    }
    while (openServers.length > 0) {
      await openServers.pop()?.close();
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  // ── Scale invariant ──────────────────────────────────────────────────────────────────────────
  //
  // The seam has exactly two legal shapes on the wire, and the gap between them is the whole point
  // of returning empty rather than a smaller slice when the budget blows (see RETRIEVAL_BUDGET_MS
  // in src/integration-seam.ts). Nothing in the suite exercised that at a store size where the caps
  // actually bind, which is why a silent 40,000-fact degradation to 2 lines was found by hand-run
  // benchmarking rather than by CI.
  //
  // Deliberately an invariant guard, not a latency budget: recall is linear in store size, and a
  // wall-clock assertion on a shared CI runner is precisely the flake this file already carries a
  // wrapper to prevent. The assertions below hold whether the runner is fast or slow.
  describe("at a store size where the emission caps bind", () => {
    const AGGRESSIVE_CAP = 8;
    const PRECISION_CAP = 4;
    const FULL_EMISSION = AGGRESSIVE_CAP + PRECISION_CAP;

    /** Seeds `preferences` aggressive-kind and `decisions` precision-kind facts, all in scope and all active. */
    function seedAtScale(preferences: number, decisions: number): void {
      const seeds: FactSeed[] = [];
      for (let i = 0; i < preferences; i += 1) {
        seeds.push({
          id: `scale-pref-${String(i).padStart(4, "0")}`,
          text: `scale preference number ${i}`,
          kind: "preference",
          scope: "global",
          source_type: "user",
          captured_at: "2026-07-01T00:00:00.000Z",
          status: "active",
        });
      }
      for (let i = 0; i < decisions; i += 1) {
        seeds.push({
          id: `scale-dec-${String(i).padStart(4, "0")}`,
          text: `scale decision number ${i}`,
          kind: "decision",
          scope: "global",
          source_type: "user",
          captured_at: "2026-07-01T00:00:00.000Z",
          status: "active",
        });
      }
      seedFacts(dbPath, seeds);
    }

    it("emits exactly the cap-limited set, not everything eligible, when the budget is ample", async () => {
      seedAtScale(300, 200);
      const result = await buildHint({ root, dbPath });
      const lines = factLines(result);
      expect(result.truncated).toBe(false);
      // 500 eligible facts, 12 emitted. The caps are the *designed* bound on a hint set and are not
      // the defect -- withholding *below* them without saying so was.
      expect(lines).toHaveLength(FULL_EMISSION);
      expect(lines.filter((line) => line.startsWith("pref"))).toHaveLength(AGGRESSIVE_CAP);
      expect(lines.filter((line) => line.startsWith("dec"))).toHaveLength(PRECISION_CAP);
    });

    it("emits nothing at all, rather than a reduced slice, when the budget is exhausted at scale", async () => {
      seedAtScale(300, 200);
      const result = await buildHint({ root, dbPath, retrievalBudgetMs: 0 });
      expect(result.truncated).toBe(true);
      // The regression this pins: the deleted TRUNCATED_AGGRESSIVE_CAP/TRUNCATED_PRECISION_CAP pair
      // returned 2 + 1 = 3 lines here, in a payload a consumer could not tell from a complete one.
      // Any reintroduction of a reduced-cap path makes this a non-zero count.
      expect(factLines(result)).toEqual([]);
      expect(result.lines).toEqual([]);
    });

    it("never emits a third size: at scale the fact-line count is the full cap set or zero", async () => {
      seedAtScale(300, 200);
      // The real invariant, run against the *default* 150ms budget at a scale where blowing it is
      // plausible on a loaded runner. Whichever way it lands is legal; landing between them is not.
      // This is the one assertion here that would catch a future third emission path, whatever
      // mechanism introduced it.
      const result = await buildHintFormat({ root, dbPath });
      const count = factLines(result).length;
      expect([0, FULL_EMISSION]).toContain(count);
      // ...and the two shapes stay distinguishable on the wire: a complete set carries the footer,
      // an empty one carries nothing at all.
      expect(result.lines).toHaveLength(count === 0 ? 0 : count + 1);
    });
  });

  it("returns just the header with no lines when the store is empty", async () => {
    // Budget pinned high: `truncated` is wall-clock-driven, and a cold CI runner can spend more than
    // the 150ms default just opening the database -- which reported truncation on an empty store.
    const result = await buildHint({ root, dbPath });
    expect(result.header).toBe(TGMEM_HEADER);
    expect(result.lines).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("fails open (never throws, returns an empty result) when the db cannot be opened", async () => {
    const brokenDbPath = join(workDir, "not-a-sqlite-file");
    mkdirSync(brokenDbPath); // a directory, not a valid sqlite file -- new Database() on this must throw
    const result = await buildHint({ root, dbPath: brokenDbPath });
    expect(result.header).toBe(TGMEM_HEADER);
    expect(result.lines).toEqual([]);
  });

  it("fails open when root does not resolve to anything usable", async () => {
    // No facts seeded at all; this mainly asserts the function still resolves cleanly end to end.
    const result = await buildHint({ root: join(root, "deeply", "nested", "missing"), dbPath });
    expect(result.header).toBe(TGMEM_HEADER);
    expect(result.lines).toEqual([]);
  });

  it("surfaces a global preference with a verify caveat even when unverified (no anchor)", async () => {
    seedFacts(dbPath, [
      {
        id: "pref-1",
        text: "uses pnpm not npm",
        kind: "preference",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]);

    const result = await buildHint({ root, dbPath, protocolVersion: 1 });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain("pref  fresh=unverified  id=pref-1");
    expect(result.lines[0]).toContain("verify");
  });

  it("surfaces a decision without a forced caveat once its anchor is affirmed", async () => {
    writeFileSync(join(root, "schema.sql"), "-- postgres schema");
    seedFacts(dbPath, [
      {
        id: "dec-1",
        text: "chose Postgres over Mongo",
        kind: "decision",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
        anchor: "file-exists schema.sql",
      },
    ]);

    const result = await buildHint({ root, dbPath });
    expect(factLines(result)).toHaveLength(1);
    expect(result.lines[0]).toContain("dec  fresh=affirmed  id=dec-1");
    expect(result.lines[0]).not.toContain("(verify)");
    expect(result.lines[result.lines.length - 1]).toBe(TGMEM_FOOTER_LINE);
  });

  it("excludes a fact whose anchor is contradicted", async () => {
    seedFacts(dbPath, [
      {
        id: "dec-2",
        text: "uses the old auth service",
        kind: "decision",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
        anchor: "file-exists definitely-missing-file.txt",
      },
    ]);

    const result = await buildHint({ root, dbPath });
    expect(result.lines).toEqual([]);
  });

  it("excludes pending facts", async () => {
    seedFacts(dbPath, [
      {
        id: "pend-1",
        text: "candidate fact",
        kind: "fact",
        scope: "global",
        source_type: "derived",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "pending",
      },
    ]);
    const result = await buildHint({ root, dbPath });
    expect(result.lines).toEqual([]);
  });

  it("excludes contested facts (ambiguous same-subject contradiction, tied precedence)", async () => {
    seedFacts(dbPath, [
      {
        id: "tie-1",
        text: "uses npm",
        kind: "preference",
        subject: "package-manager",
        value: "npm",
        scope: "project",
        scopeRoot: root,
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
      {
        id: "tie-2",
        text: "uses pnpm",
        kind: "preference",
        subject: "package-manager",
        value: "pnpm",
        scope: "project",
        scopeRoot: root,
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]);
    const result = await buildHint({ root, dbPath });
    expect(result.lines).toEqual([]);
  });

  it("includes a project-scoped fact only when --root matches its bound project root", async () => {
    const otherRoot = join(workDir, "other-project");
    mkdirSync(otherRoot, { recursive: true });
    seedFacts(dbPath, [
      {
        id: "proj-1",
        text: "staging db is prod-staging-db-1",
        kind: "fact",
        scope: "project",
        scopeRoot: otherRoot,
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]);

    const resultForRoot = await buildHint({ root, dbPath });
    expect(resultForRoot.lines).toEqual([]);

    const resultForOtherRoot = await buildHint({ root: otherRoot, dbPath });
    expect(factLines(resultForOtherRoot)).toHaveLength(1);
  });

  it("excludes a project-scoped fact with an empty-string scopeRoot from every root, including one equal to cwd", async () => {
    // Regression: isInScope only excluded `null`, so `scopeRoot: ""` fell through to
    // resolvePath(""), which resolves to process.cwd() -- putting an unbound project fact in scope
    // for any caller whose --root happens to equal the cwd, which is the normal case. Must exclude
    // it the same way isBoundToRoot (retrieval.ts) already does.
    seedFacts(dbPath, [
      {
        id: "proj-empty-scoperoot",
        text: "an unbound project fact from a hand-edited export",
        kind: "fact",
        scope: "project",
        scopeRoot: "",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]);

    const result = await buildHint({ root: process.cwd(), dbPath });
    expect(factLines(result)).toHaveLength(0);
  });

  it("includes a path-scoped fact only when a matching --context-files entry is passed", async () => {
    const filePath = join(root, "src", "auth.ts");
    seedFacts(dbPath, [
      {
        id: "path-1",
        text: "auth.ts owns migrations",
        kind: "fact",
        scope: "path",
        scopeRoot: filePath,
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]);

    const withoutContext = await buildHint({ root, dbPath });
    expect(withoutContext.lines).toEqual([]);

    const withContext = await buildHint({ root, dbPath, contextFiles: ["src/auth.ts"] });
    expect(factLines(withContext)).toHaveLength(1);
  });

  it("caps aggressively-recalled kinds (preference/correction) at 8", async () => {
    const seeds: FactSeed[] = [];
    for (let i = 0; i < 12; i += 1) {
      seeds.push({
        id: `pref-cap-${i}`,
        text: `preference number ${i}`,
        kind: "preference",
        scope: "global",
        source_type: "user",
        captured_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        status: "active",
      });
    }
    seedFacts(dbPath, seeds);

    const result = await buildHint({ root, dbPath });
    expect(factLines(result)).toHaveLength(8);
  });

  it("caps precision-recalled kinds (decision/fact) at 4", async () => {
    const seeds: FactSeed[] = [];
    for (let i = 0; i < 6; i += 1) {
      seeds.push({
        id: `fact-cap-${i}`,
        text: `fact number ${i}`,
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        status: "active",
      });
    }
    seedFacts(dbPath, seeds);

    const result = await buildHint({ root, dbPath });
    expect(factLines(result)).toHaveLength(4);
  });

  it("emits a well-formed TGMEM/1 line whose display field is valid JSON", async () => {
    seedFacts(dbPath, [
      {
        id: "pref-json",
        text: 'has "quotes" and — a dash',
        kind: "preference",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]);

    const result = await buildHint({ root, dbPath, protocolVersion: 1 });
    expect(result.lines).toHaveLength(1);
    const line = result.lines[0];
    expect(line).toBeDefined();
    const match = /^pref {2}fresh=\w+ {2}id=pref-json {2}display=(.+)$/.exec(line ?? "");
    expect(match).not.toBeNull();
    const displayJson = match?.[1] ?? "";
    expect(() => JSON.parse(displayJson)).not.toThrow();
  });

  it("emits every line conforming to the normative TGMEM/1 grammar (integration-seam.ts doc comment)", async () => {
    seedFacts(dbPath, [
      {
        id: "g-pref",
        text: 'pref with "quotes" and — a dash',
        kind: "preference",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
      {
        id: "g-corr",
        text: "never run npm install here",
        kind: "correction",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-02T00:00:00.000Z",
        status: "active",
      },
      {
        id: "g-dec",
        text: "chose Postgres over Mongo",
        kind: "decision",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-03T00:00:00.000Z",
        status: "active",
      },
      {
        id: "g-fact",
        text: "staging DB host is db.internal",
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-04T00:00:00.000Z",
        status: "pinned",
      },
    ]);

    const result = await buildHint({ root, dbPath, protocolVersion: 1 });
    expect(result.header).toBe("TGMEM/1");
    expect(result.lines).toHaveLength(4);

    // The exact consumer-side regex the grammar doc comment publishes. Every produced line must
    // match it, and the final capture must JSON.parse to a non-empty display string -- if this
    // test breaks, either fix the producer or bump TGMEM_PROTOCOL_VERSION and the grammar together.
    const grammar = /^(pref|dec|fact|corr) {2}fresh=(affirmed|unverified|contradicted) {2}id=(\S+) {2}display=(".*")$/u;
    for (const line of result.lines) {
      const match = grammar.exec(line);
      expect(match, `line does not match TGMEM/1 grammar: ${line}`).not.toBeNull();
      expect(line).not.toContain("\n");
      const display: unknown = JSON.parse(match?.[4] ?? "null");
      expect(typeof display).toBe("string");
      expect((display as string).length).toBeGreaterThan(0);
    }
  });

  it("TGMEM/2 (default): strips the per-line CTA and appends one shared footer line", async () => {
    seedFacts(dbPath, [
      {
        id: "dec-cta",
        text: "chose Postgres over Mongo",
        kind: "decision",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
        anchor: "file-exists schema.sql",
      },
    ]);
    writeFileSync(join(root, "schema.sql"), "-- postgres schema");

    const result = await buildHint({ root, dbPath });
    expect(result.header).toBe("TGMEM/2");
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toBe('dec  fresh=affirmed  id=dec-cta  display="decision: chose Postgres over Mongo"');
    expect(result.lines[1]).toBe(TGMEM_FOOTER_LINE);
  });

  it("TGMEM/2: omits the footer line when there are no fact-lines", async () => {
    const result = await buildHint({ root, dbPath });
    expect(result.header).toBe("TGMEM/2");
    expect(result.lines).toEqual([]);
  });

  it("TGMEM/1 (explicit protocolVersion: 1): no footer line, per-line CTA preserved", async () => {
    seedFacts(dbPath, [
      {
        id: "dec-v1",
        text: "chose Postgres over Mongo",
        kind: "decision",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
        anchor: "file-exists schema.sql",
      },
    ]);
    writeFileSync(join(root, "schema.sql"), "-- postgres schema");

    const result = await buildHint({ root, dbPath, protocolVersion: 1 });
    expect(result.header).toBe("TGMEM/1");
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toBe('dec  fresh=affirmed  id=dec-v1  display="decision: chose Postgres over Mongo — mem show dec-v1"');
  });

  it("--stable sorts fact-lines by id ascending, independent of relevance/recency order", async () => {
    seedFacts(dbPath, [
      {
        id: "z-newest",
        text: "captured most recently",
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-03T00:00:00.000Z",
        status: "active",
      },
      {
        id: "a-oldest",
        text: "captured earliest",
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
      {
        id: "m-middle",
        text: "captured in between",
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-02T00:00:00.000Z",
        status: "active",
      },
    ]);

    // Budget pinned high: this asserts an *ordering*, and blowing the soft budget drops the caps to
    // 2/1, which turns the assertion into a question of how busy the machine was.
    const defaultOrder = await buildHint({ root, dbPath });
    expect(factLines(defaultOrder).map((line) => line.split("  ")[2])).toEqual(["id=z-newest", "id=m-middle", "id=a-oldest"]);

    const stableOrder = await buildHint({ root, dbPath, stable: true });
    expect(factLines(stableOrder).map((line) => line.split("  ")[2])).toEqual(["id=a-oldest", "id=m-middle", "id=z-newest"]);
  });

  // ── HintFormatOptions.query (item 1) ─────────────────────────────────────────────────────────

  it("a query reorders fact-lines by BM25 relevance instead of falling through to recency", async () => {
    seedFacts(dbPath, [
      {
        id: "newer-oranges",
        text: "unrelated newer fact about oranges",
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-02T00:00:00.000Z",
        status: "active",
      },
      {
        id: "older-giraffe",
        text: "older fact about a distinctive giraffe topic",
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]);

    // No query: BM25 ties both at 0, so the sort falls through to captured_at descending -- newer first.
    const noQuery = await buildHint({ root, dbPath });
    expect(factLines(noQuery).map((line) => line.split("  ")[2])).toEqual(["id=newer-oranges", "id=older-giraffe"]);

    // Querying "giraffe" (only in the older fact) reorders: the matching, older fact now leads.
    const withQuery = await buildHint({ root, dbPath, query: "giraffe" });
    expect(factLines(withQuery).map((line) => line.split("  ")[2])).toEqual(["id=older-giraffe", "id=newer-oranges"]);
  });

  it("an absent query and an empty-string query produce byte-identical results (today's recency-only path is unchanged)", async () => {
    seedFacts(dbPath, [
      {
        id: "newer-oranges",
        text: "unrelated newer fact about oranges",
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-02T00:00:00.000Z",
        status: "active",
      },
      {
        id: "older-giraffe",
        text: "older fact about a distinctive giraffe topic",
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]);

    const absent = await buildHint({ root, dbPath });
    const empty = await buildHint({ root, dbPath, query: "" });
    expect(empty).toEqual(absent);
  });

  it("a query matching no fact text ranks (ties at 0), never filters out a candidate", async () => {
    seedFacts(dbPath, [
      {
        id: "apples",
        text: "fact about apples",
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
      {
        id: "bananas",
        text: "fact about bananas",
        kind: "fact",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-02T00:00:00.000Z",
        status: "active",
      },
    ]);

    const noQuery = await buildHint({ root, dbPath });
    const noMatch = await buildHint({ root, dbPath, query: "zzzz nonexistent xyzzy" });
    expect([...factLines(noMatch)].sort()).toEqual([...factLines(noQuery)].sort());
  });

  /**
   * The truncated path had no deterministic coverage at all: it was only ever reached by a machine
   * slow enough to blow the 150ms soft budget, which is how it turned up -- as two unrelated tests
   * failing on the first Windows CI run this project ever did. Forcing the budget to 0 exercises it
   * on purpose, so the degradation contract is pinned rather than inferred from a flake.
   */
  it("returns an empty hint set, not a smaller one, when the soft budget is exceeded", async () => {
    seedFacts(dbPath, [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `pref-${i}`,
        text: `preference number ${i}`,
        kind: "preference" as const,
        scope: "global" as const,
        source_type: "user" as const,
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active" as const,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `dec-${i}`,
        text: `decision number ${i}`,
        kind: "decision" as const,
        scope: "global" as const,
        source_type: "user" as const,
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active" as const,
      })),
    ]);

    const full = await buildHint({ root, dbPath });
    expect(full.truncated).toBe(false);

    expect(factLines(full).length).toBeGreaterThan(0);

    const exhausted = await buildHint({ root, dbPath, retrievalBudgetMs: 0 });
    expect(exhausted.truncated).toBe(true);

    // The invariant, and the whole point of the fix: a budget-exhausted response must not be a
    // *subset* of a healthy one. It used to emit 3 of 12 facts (caps dropped to 2 aggressive + 1
    // precision) in a payload byte-indistinguishable from a complete response -- same TGMEM/2
    // header, same line grammar, same footer -- so a consumer surfacing `display` verbatim
    // presented a quarter of what was found as though it were all of it. TGMEM/2's grammar is
    // closed, so there is no in-band way to say "partial"; the only honest options are complete
    // or empty. Asserting emptiness rather than `< full` is deliberate: `< full` would pass again
    // the moment someone reintroduces a reduced cap, which is the bug.
    expect(exhausted.lines).toEqual([]);
    expect(factLines(exhausted)).toEqual([]);
  });

  /**
   * The test above forces exhaustion by passing a zero budget, and that only worked by accident:
   * `truncated` was `elapsed > budgetMs`, so a zero budget reported *not* exhausted whenever the
   * whole retrieval landed inside one millisecond. A 10-fact anchor-free store on a fast runner
   * does exactly that, which made the assertion a coin flip decided by the clock -- it passed on
   * Windows, failed on ubuntu-latest, then passed again on the next commit with the test code
   * untouched.
   *
   * Freezing `Date.now` pins `elapsed` to exactly 0 on every platform, so this is the boundary
   * case itself rather than a race that happens to land on it: with a zero budget, consuming zero
   * time must still count as exhausted, because zero time is all there was.
   */
  it("treats a fully-consumed budget as exhausted, not as headroom", async () => {
    seedFacts(dbPath, [
      {
        id: "pref-boundary",
        text: "preference at the budget boundary",
        kind: "preference",
        scope: "global",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active",
      },
    ]);

    const frozen = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(frozen);
    try {
      const exhausted = await buildHint({ root, dbPath, retrievalBudgetMs: 0 });
      // elapsed === 0 and budget === 0: the strict `>` reported this as a healthy response.
      expect(exhausted.truncated).toBe(true);
      expect(factLines(exhausted)).toEqual([]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  /**
   * The wire-level half of the assertion above, at the boundary the consumer actually sees.
   *
   * `buildHintFormat`'s return value is in-process; what token-goat parses is stdout. A response
   * that withholds facts has to be distinguishable *there* -- and the distinguishing signal is the
   * absence of fact-lines, not a flag, because `HintFormatResult.truncated` never reaches the wire
   * and cannot be made to without a version bump that fails un-upgraded consumers open to nothing.
   */
  it("emits no fact-lines and no footer on the wire when the budget is exhausted", async () => {
    seedFacts(dbPath, [
      {
        id: "pref-wire",
        text: "uses pnpm not npm",
        kind: "preference" as const,
        scope: "global" as const,
        source_type: "user" as const,
        captured_at: "2026-01-01T00:00:00.000Z",
        status: "active" as const,
      },
    ]);

    const healthy = await buildHint({ root, dbPath });
    expect(healthy.lines).toContain(TGMEM_FOOTER_LINE);

    const exhausted = await buildHint({ root, dbPath, retrievalBudgetMs: 0 });
    // No footer either: TGMEM/2 emits one only alongside at least one fact-line, so a lone
    // footer would itself be an off-grammar response.
    expect(exhausted.lines).not.toContain(TGMEM_FOOTER_LINE);
    expect(exhausted.header).toBe(TGMEM_HEADER);
    expect(exhausted.lines).toEqual([]);
  });

  // ── Session recall log and --delta ───────────────────────────────────────────────────────────

  /** Ids on the fact-lines of `result`, in emitted order. */
  function emittedIds(result: HintFormatResult): string[] {
    return factLines(result).map((line) => line.split("  ")[2]?.replace(/^id=/u, "") ?? "");
  }

  /** `recall_log` rows for `sessionId`, as `fact_id`s, in insertion order. */
  function loggedIds(sessionId: string): string[] {
    const db = openStorage(dbPath);
    try {
      return db
        .prepare<[string], { fact_id: string }>("SELECT fact_id FROM recall_log WHERE session_id = ? ORDER BY rowid")
        .all(sessionId)
        .map((row) => row.fact_id);
    } finally {
      db.close();
    }
  }

  function threeGlobalFacts(): void {
    seedFacts(dbPath, [
      { id: "fact-a", text: "alpha fact about apples", kind: "fact", scope: "global", source_type: "user", captured_at: "2026-01-03T00:00:00.000Z", status: "active" },
      { id: "fact-b", text: "beta fact about bananas", kind: "fact", scope: "global", source_type: "user", captured_at: "2026-01-02T00:00:00.000Z", status: "active" },
      { id: "fact-c", text: "gamma fact about cherries", kind: "fact", scope: "global", source_type: "user", captured_at: "2026-01-01T00:00:00.000Z", status: "active" },
    ]);
  }

  it("records the emitted fact ids in recall_log under the session id, and nothing without one", async () => {
    threeGlobalFacts();

    const anonymous = await buildHint({ root, dbPath });
    expect(emittedIds(anonymous)).toEqual(["fact-a", "fact-b", "fact-c"]);
    const db = openStorage(dbPath);
    const total = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM recall_log").get()?.n;
    db.close();
    expect(total).toBe(0);

    const first = await buildHint({ root, dbPath, sessionId: "sess-1" });
    expect(first.delta).toBe(false);
    expect(first.header).toBe(TGMEM_HEADER);
    expect(loggedIds("sess-1")).toEqual(["fact-a", "fact-b", "fact-c"]);
  });

  it("--delta omits every fact already logged for the session and marks the header delta=1", async () => {
    threeGlobalFacts();
    await buildHint({ root, dbPath, sessionId: "sess-1" });

    // A fact captured after the first recall is the only thing the session has not seen.
    seedFacts(dbPath, [
      { id: "fact-d", text: "delta fact about dates", kind: "fact", scope: "global", source_type: "user", captured_at: "2026-01-04T00:00:00.000Z", status: "active" },
    ]);

    const second = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true });
    expect(second.delta).toBe(true);
    expect(second.header).toBe(`${TGMEM_HEADER}  delta=1`);
    expect(emittedIds(second)).toEqual(["fact-d"]);
    expect(second.lines[second.lines.length - 1]).toBe(TGMEM_FOOTER_LINE);

    // The delta itself is logged, so a third delta call has nothing left: header only, no footer.
    const third = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true });
    expect(third.header).toBe(`${TGMEM_HEADER}  delta=1`);
    expect(third.lines).toEqual([]);
  });

  it("non-firing: a call without --delta in the same session still returns every fact, byte-identical to a fresh session", async () => {
    threeGlobalFacts();
    await buildHint({ root, dbPath, sessionId: "sess-1" });
    await buildHint({ root, dbPath, sessionId: "sess-1", delta: true });

    const fullAgain = await buildHint({ root, dbPath, sessionId: "sess-1" });
    const freshSession = await buildHint({ root, dbPath, sessionId: "sess-2" });
    expect(fullAgain.lines.length).toBeGreaterThan(0);
    expect(fullAgain.delta).toBe(false);
    expect(fullAgain.header).toBe(TGMEM_HEADER);
    expect(fullAgain.lines).toEqual(freshSession.lines);
    expect(emittedIds(fullAgain)).toEqual(["fact-a", "fact-b", "fact-c"]);
  });

  it("recall logs are per session: a second session's delta starts from the full set", async () => {
    threeGlobalFacts();
    await buildHint({ root, dbPath, sessionId: "sess-1" });

    const otherSession = await buildHint({ root, dbPath, sessionId: "sess-2", delta: true });
    expect(emittedIds(otherSession)).toEqual(["fact-a", "fact-b", "fact-c"]);
  });

  it("delta filters before the per-kind caps, so a repeat call surfaces the next-best unseen facts rather than nothing", async () => {
    // 6 decisions, cap is 4 (PRECISION_CAP): a full call sends the 4 newest; the delta then sends the remaining 2.
    seedFacts(
      dbPath,
      Array.from({ length: 6 }, (_, index) => ({
        id: `dec-${index}`,
        text: `decision number ${index}`,
        kind: "decision" as const,
        scope: "global" as const,
        source_type: "user" as const,
        captured_at: `2026-01-0${index + 1}T00:00:00.000Z`,
        status: "active" as const,
      }))
    );
    const first = await buildHint({ root, dbPath, sessionId: "sess-1" });
    expect(emittedIds(first)).toEqual(["dec-5", "dec-4", "dec-3", "dec-2"]);

    const second = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true });
    expect(emittedIds(second)).toEqual(["dec-1", "dec-0"]);
  });

  it("regression: a fact sent as filler on a non-matching prompt is re-sent by --delta once a later prompt matches it (compaction makes 'already sent' != 'still in context')", async () => {
    seedFacts(dbPath, [
      { id: "deploy-key", text: "the deploy key lives in the vault at ops/deploy-key", kind: "fact", scope: "global", source_type: "user", captured_at: "2026-01-02T00:00:00.000Z", status: "active" },
      { id: "lunch", text: "team lunch happens fridays", kind: "fact", scope: "global", source_type: "user", captured_at: "2026-01-01T00:00:00.000Z", status: "active" },
    ]);

    // Prompt 1 matches nothing: both facts go out as filler (score 0, recency order) and get logged.
    const filler = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true, query: "what is the lint setup" });
    expect(emittedIds(filler)).toEqual(["deploy-key", "lunch"]);
    expect(loggedIds("sess-1")).toEqual(["deploy-key", "lunch"]);

    // Prompt 2 is exactly the deploy-key question. Before the fix this returned the bare header.
    const exact = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true, query: "where is the deploy key vault path" });
    expect(exact.header).toBe(`${TGMEM_HEADER}  delta=1`);
    expect(emittedIds(exact)).toEqual(["deploy-key"]);

    // And a third time: a genuine hit re-sends every time it is asked for.
    const again = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true, query: "deploy key" });
    expect(emittedIds(again)).toEqual(["deploy-key"]);
  });

  it("regression: --delta still suppresses non-matching facts once a usefulness signal turns fusion on (the predicate must not be 'score !== 0')", async () => {
    // The bug this pins: delta suppression asked "did this fact match?" by testing `score !== 0`.
    // That is only true while BM25 is the sole rank list. The moment a second list joins -- a
    // usefulness signal here, an embedding backend later -- retrieval fuses via RRF, which floors
    // every ranked fact above zero. Every filler fact then looked like a match, so nothing was ever
    // suppressed and `--delta` silently became a no-op store-wide, with no existing test failing.
    threeGlobalFacts();
    const baseline = await buildHint({ root, dbPath, sessionId: "sess-1", query: "what is the lint setup" });
    expect(emittedIds(baseline)).toEqual(["fact-a", "fact-b", "fact-c"]);

    // One usefulness row is enough to make the third rank list non-empty and switch fusion on.
    const db = openStorage(dbPath);
    try {
      markRecallUsed(db, ["fact-a"], "sess-1", "2026-01-05T00:00:00.000Z");
    } finally {
      db.close();
    }

    // Same non-matching query, so the correct answer is unchanged: everything was already sent and
    // nothing matches, therefore header only. Before the fix this returned all three facts again.
    const repeat = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true, query: "what is the lint setup" });
    expect(repeat.header).toBe(`${TGMEM_HEADER}  delta=1`);
    expect(repeat.lines).toEqual([]);

    // And the other half of the contract still holds under fusion: a genuine hit re-sends.
    const hit = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true, query: "alpha" });
    expect(emittedIds(hit)).toEqual(["fact-a"]);
  });

  it("regression: --delta still suppresses non-matching facts once an embedding backend turns fusion on", async () => {
    // The embedding half of the `matchedQuery` regression above. Fusion is switched on by any
    // non-empty auxiliary rank list, and an embedding list is the other one -- so the same
    // `score !== 0` predicate that usefulness feedback broke would be broken by a configured
    // endpoint, on installs that never run `mem used` at all.
    threeGlobalFacts();
    const baseline = await buildHint({ root, dbPath, sessionId: "sess-1", query: "what is the lint setup" });
    expect(emittedIds(baseline)).toEqual(["fact-a", "fact-b", "fact-c"]);

    // A stored vector per fact plus a recorded model is what makes the embedding rank list
    // non-empty; the stub endpoint supplies the query vector.
    const server = await startStubEmbeddingServer();
    openServers.push(server);
    const db = openStorage(dbPath);
    try {
      for (const id of ["fact-a", "fact-b", "fact-c"]) {
        updateFact(db, id, { embedding: Float32Array.from([1, 0, 0, 0]) });
      }
      setEmbeddingMeta(db, { model: "stub-model", dimension: 4 });
    } finally {
      db.close();
    }
    process.env[EMBED_URL_ENV] = server.url;
    process.env[EMBED_MODEL_ENV] = "stub-model";

    // Same non-matching query, so the correct answer is unchanged: everything was already sent and
    // nothing matches, therefore header only.
    const repeat = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true, query: "what is the lint setup" });
    expect(repeat.header).toBe(`${TGMEM_HEADER}  delta=1`);
    expect(repeat.lines).toEqual([]);
    // The endpoint really was consulted -- otherwise this would be the BM25-only path and would
    // pass for the wrong reason.
    expect(server.requests.length).toBeGreaterThan(0);

    // And a genuine lexical hit still re-sends under fusion.
    const hit = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true, query: "alpha" });
    expect(emittedIds(hit)).toEqual(["fact-a"]);
  });

  it("non-firing: a zero-scoring fact already surfaced in the session stays suppressed by --delta (delta is not a no-op)", async () => {
    threeGlobalFacts();
    const baseline = await buildHint({ root, dbPath, sessionId: "sess-1", query: "what is the lint setup" });
    expect(emittedIds(baseline)).toEqual(["fact-a", "fact-b", "fact-c"]);
    expect(loggedIds("sess-1")).toHaveLength(3);

    // Same non-matching query: everything scores 0 and everything was sent -> header only.
    const repeat = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true, query: "what is the lint setup" });
    expect(repeat.header).toBe(`${TGMEM_HEADER}  delta=1`);
    expect(repeat.lines).toEqual([]);

    // A query matching only one of them re-sends exactly that one.
    const partial = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true, query: "bananas" });
    expect(emittedIds(partial)).toEqual(["fact-b"]);
  });

  it("the SessionStart recency dump (no query) is still fully suppressible: every score is zero", async () => {
    seedFacts(dbPath, [
      { id: "pref-1", text: "prefers pnpm", kind: "preference", scope: "global", source_type: "user", captured_at: "2026-01-04T00:00:00.000Z", status: "active" },
      { id: "corr-1", text: "never use npm here", kind: "correction", scope: "global", source_type: "user", captured_at: "2026-01-03T00:00:00.000Z", status: "active" },
      { id: "dec-1", text: "chose sqlite", kind: "decision", scope: "global", source_type: "user", captured_at: "2026-01-02T00:00:00.000Z", status: "active" },
      { id: "fact-1", text: "the build is esbuild", kind: "fact", scope: "global", source_type: "user", captured_at: "2026-01-01T00:00:00.000Z", status: "active" },
    ]);
    const opener = await buildHint({ root, dbPath, sessionId: "sess-1" });
    expect(factLines(opener)).toHaveLength(4);

    const promptless = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true });
    expect(promptless.header).toBe(`${TGMEM_HEADER}  delta=1`);
    expect(promptless.lines).toEqual([]);
  });

  it("no kind boost can lift a zero score past the delta predicate: boosted kinds on a non-matching query score exactly 0", async () => {
    expect(AGGRESSIVE_RECALL_BOOST).toBeGreaterThan(1);
    const facts: Fact[] = (["preference", "correction", "decision", "fact"] as const).map((kind, index) => ({
      id: `${kind}-1`,
      text: `${kind} about something unrelated`,
      kind,
      subject: null,
      value: null,
      scope: "global",
      scopeRoot: null,
      source_type: "user",
      source_ref: null,
      captured_at: `2026-01-0${index + 1}T00:00:00.000Z`,
      anchor: null,
      status: "active",
      confidence: 1,
    }));
    for (const query of ["", "what is the lint setup"]) {
      const { results } = await retrieve(facts, { query, root, hintFormat: true, limit: 100 });
      expect(results).toHaveLength(4);
      for (const result of results) {
        expect(result.score, `${result.fact.kind} query=${JSON.stringify(query)}`).toBe(0);
      }
    }
  });

  // ── Stopwords: function words must not make an unrelated prompt re-send the whole store ─────────

  /** Six realistic facts, none topically about any of the seven prompts below; kinds split so every one fits under the caps. */
  function sixRealisticFacts(): void {
    seedFacts(dbPath, [
      { id: "pnpm", text: "prefers pnpm over npm", kind: "preference", scope: "global", source_type: "user", captured_at: "2026-01-06T00:00:00.000Z", status: "active" },
      { id: "secrets", text: "never commit secrets", kind: "correction", scope: "global", source_type: "user", captured_at: "2026-01-05T00:00:00.000Z", status: "active" },
      { id: "lint", text: "lint runs eslint with zero warnings", kind: "preference", scope: "global", source_type: "user", captured_at: "2026-01-04T00:00:00.000Z", status: "active" },
      { id: "deploy-key", text: "the deploy key lives in the vault at ops/deploy-key", kind: "fact", scope: "global", source_type: "user", captured_at: "2026-01-03T00:00:00.000Z", status: "active" },
      { id: "lunch", text: "team lunch happens on fridays", kind: "fact", scope: "global", source_type: "user", captured_at: "2026-01-02T00:00:00.000Z", status: "active" },
      { id: "sqlite", text: "chose sqlite for the storage layer", kind: "decision", scope: "global", source_type: "user", captured_at: "2026-01-01T00:00:00.000Z", status: "active" },
    ]);
  }

  const UNRELATED_PROMPTS = [
    "what is the plan for today",
    "add a test for the parser",
    "rename the variable to foo",
    "why did the release fail",
    "is there anything new here",
    "can you refactor this function",
    "explain this error message",
  ] as const;

  it("regression: realistic prompts unrelated to every stored fact re-send zero facts under --delta (function words are not matches)", async () => {
    sixRealisticFacts();
    const opener = await buildHint({ root, dbPath, sessionId: "sess-1" });
    expect(emittedIds(opener).sort()).toEqual(["deploy-key", "lint", "lunch", "pnpm", "secrets", "sqlite"]);
    expect(loggedIds("sess-1")).toHaveLength(6);

    // Before stopwords: "what is the plan for today" re-sent 5/6 and "add a test for the parser" 5/6
    // on `the`/`is`/`for`/`a` alone.
    for (const prompt of UNRELATED_PROMPTS) {
      const delta = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true, query: prompt });
      expect(delta.header, prompt).toBe(`${TGMEM_HEADER}  delta=1`);
      expect(emittedIds(delta), prompt).toEqual([]);
    }
  });

  it("non-firing: a prompt matching on a content word still re-sends that fact under --delta after the stopword filter", async () => {
    sixRealisticFacts();
    const opener = await buildHint({ root, dbPath, sessionId: "sess-1" });
    expect(emittedIds(opener)).toHaveLength(6);

    const deployKey = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true, query: "where is the deploy key vault path" });
    expect(emittedIds(deployKey)).toEqual(["deploy-key"]);

    const lunch = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true, query: "when is lunch" });
    expect(emittedIds(lunch)).toEqual(["lunch"]);
  });

  it("a prompt made entirely of stopwords falls through to the no-query behaviour: recency order, and fully suppressible under --delta", async () => {
    threeGlobalFacts();
    const allStop = await buildHint({ root, dbPath, sessionId: "sess-1", query: "is it the one for me" });
    const noQuery = await buildHint({ root, dbPath, sessionId: "sess-2" });
    expect(emittedIds(noQuery)).toEqual(["fact-a", "fact-b", "fact-c"]);
    expect(allStop.lines).toEqual(noQuery.lines);

    const suppressed = await buildHint({ root, dbPath, sessionId: "sess-1", delta: true, query: "is it the one for me" });
    expect(suppressed.header).toBe(`${TGMEM_HEADER}  delta=1`);
    expect(suppressed.lines).toEqual([]);
  });

  it("a fact whose text is mostly stopwords is still indexed and retrievable by its content words", async () => {
    seedFacts(dbPath, [
      { id: "mostly-stop", text: "it is what it is with the one about kubernetes", kind: "fact", scope: "global", source_type: "user", captured_at: "2026-01-02T00:00:00.000Z", status: "active" },
      { id: "other", text: "team lunch happens on fridays", kind: "fact", scope: "global", source_type: "user", captured_at: "2026-01-03T00:00:00.000Z", status: "active" },
    ]);
    const result = await buildHint({ root, dbPath, query: "kubernetes" });
    expect(emittedIds(result)).toEqual(["mostly-stop", "other"]);
  });

  function bareFact(id: string, text: string, kind: Fact["kind"] = "fact"): Fact {
    return { id, text, kind, subject: null, value: null, scope: "global", scopeRoot: null, source_type: "user", source_ref: null, captured_at: "2026-01-01T00:00:00.000Z", anchor: null, status: "active", confidence: 1 };
  }

  it("negations are never stripped: a fact and a query that share only a negation word still score on it", async () => {
    for (const negation of ["no", "not", "nor", "never", "none", "neither", "nothing", "without", "cannot", "dont", "cant", "wont"]) {
      expect(STOPWORDS.has(negation), negation).toBe(false);
    }
    const facts = [bareFact("negated", "do not use npm", "correction"), bareFact("plain", "use yarn", "preference")];
    const { results } = await retrieve(facts, { query: "not", root, hintFormat: true, limit: 10 });
    const byId = new Map(results.map((result) => [result.fact.id, result.score]));
    expect(byId.get("plain")).toBe(0);
    expect(byId.get("negated") ?? 0).toBeGreaterThan(0);

    // `n't` contractions keep their negation through the apostrophe split, on both sides.
    const contracted = [bareFact("dont", "don't use npm", "correction"), bareFact("cant", "can't push to main", "correction"), bareFact("wont", "won't merge without review", "correction")];
    for (const [query, expected] of [["never do not", "dont"], ["cannot not", "cant"], ["do not merge", "wont"]] as const) {
      const scored = await retrieve(contracted, { query, root, hintFormat: true, limit: 10 });
      const hit = scored.results.find((result) => result.fact.id === expected);
      expect(hit?.score ?? 0, `${query} -> ${expected}`).toBeGreaterThan(0);
    }
    const stopOnly = await retrieve(contracted, { query: "do", root, hintFormat: true, limit: 10 });
    for (const result of stopOnly.results) {
      expect(result.score, `stopword-only query vs ${result.fact.id}`).toBe(0);
    }
  });

  it("--stable never writes to recall_log (it exists to make output deterministic for tests)", async () => {
    threeGlobalFacts();
    const stable = await buildHint({ root, dbPath, sessionId: "sess-1", stable: true });
    expect(factLines(stable)).toHaveLength(3);
    expect(loggedIds("sess-1")).toEqual([]);
  });

  it("delta without a session id is a plain full response (the CLI rejects the pairing; the seam cannot subtract from an unknown session)", async () => {
    threeGlobalFacts();
    const result = await buildHint({ root, dbPath, delta: true });
    expect(result.delta).toBe(false);
    expect(result.header).toBe(TGMEM_HEADER);
    expect(emittedIds(result)).toEqual(["fact-a", "fact-b", "fact-c"]);
  });

  it("a failure to write recall_log never fails the recall: the facts are still emitted and a warning goes to stderr", async () => {
    threeGlobalFacts();
    // Make every insert into recall_log abort at the SQLite level, the closest stand-in for a
    // locked or read-only store that does not also break the read path.
    const db = openStorage(dbPath);
    db.exec("CREATE TRIGGER block_recall_log BEFORE INSERT ON recall_log BEGIN SELECT RAISE(ABORT, 'recall_log is read-only in this test'); END;");
    db.close();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await buildHint({ root, dbPath, sessionId: "sess-1" });

    const warnings = warnSpy.mock.calls.map((call) => String(call[0]));
    warnSpy.mockRestore();
    expect(emittedIds(result)).toEqual(["fact-a", "fact-b", "fact-c"]);
    expect(loggedIds("sess-1")).toEqual([]);
    expect(warnings.some((line) => line.includes("could not record surfaced facts") && line.includes("recall_log is read-only in this test"))).toBe(true);
  });

  it("an empty (budget-exhausted) response logs nothing, so the session is not marked as having seen facts it never received", async () => {
    threeGlobalFacts();
    const exhausted = await buildHintFormat({ root, dbPath, sessionId: "sess-1", retrievalBudgetMs: 0 });
    expect(exhausted.truncated).toBe(true);
    expect(exhausted.lines).toEqual([]);
    expect(loggedIds("sess-1")).toEqual([]);
  });
});
