import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db.js";
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
  for (const seed of seeds) {
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
  db.close();
}

describe("buildHintFormat", () => {
  let workDir: string;
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "mem-seam-test-"));
    root = join(workDir, "project");
    mkdirSync(root, { recursive: true });
    dbPath = join(workDir, "mem.db");
  });

  afterEach(() => {
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
});
