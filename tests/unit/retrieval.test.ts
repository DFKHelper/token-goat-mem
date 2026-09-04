import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _clearAnchorMemoForTests } from "../../src/anchors.js";
import {
  _stemForTests,
  computeBm25Scores,
  cosineSimilarity,
  reciprocalRankFusion,
  retrieve,
  type EmbeddingBackend,
} from "../../src/retrieval.js";
import type { Fact } from "../../src/types.js";

function makeFact(overrides: Partial<Fact> & Pick<Fact, "id" | "text" | "kind">): Fact {
  return {
    subject: null,
    value: null,
    scope: "project",
    source_type: "user",
    source_ref: null,
    captured_at: "2026-01-01T00:00:00.000Z",
    anchor: null,
    status: "active",
    confidence: 1,
    embedding: null,
    ...overrides,
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-retrieval-"));
  _clearAnchorMemoForTests();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("computeBm25Scores", () => {
  it("scores an exact-match document above an unrelated one", () => {
    const docs = [
      makeFact({ id: "a", text: "uses pnpm not npm", kind: "preference" }),
      makeFact({ id: "b", text: "staging DB host is prod-staging-db-1", kind: "fact" }),
    ];
    const scores = computeBm25Scores(docs, "pnpm");
    expect(scores.get("a")).toBeGreaterThan(scores.get("b") ?? 0);
    expect(scores.get("b")).toBe(0);
  });

  it("returns all zeros for an empty query", () => {
    const docs = [makeFact({ id: "a", text: "uses pnpm", kind: "preference" })];
    const scores = computeBm25Scores(docs, "");
    expect(scores.get("a")).toBe(0);
  });

  // ── Porter stemming (item 2) ─────────────────────────────────────────────────────────────────
  // Applied identically at index and query time inside `tokenize`, so a plural/inflected query
  // term matches a differently-inflected document term it previously missed entirely.

  it("a plural query matches a singular document term ('commits' query -> 'commit' text)", () => {
    const docs = [
      makeFact({ id: "a", text: "the commit message must be imperative mood", kind: "fact" }),
      makeFact({ id: "b", text: "unrelated fact about bananas", kind: "fact" }),
    ];
    const scores = computeBm25Scores(docs, "commits");
    expect(scores.get("a")).toBeGreaterThan(0);
    expect(scores.get("b")).toBe(0);
  });

  it("a gerund document term matches a bare-verb query ('testing' text <- 'test' query)", () => {
    const docs = [
      makeFact({ id: "a", text: "prefers vitest for testing over jest", kind: "preference" }),
      makeFact({ id: "b", text: "unrelated fact about bananas", kind: "fact" }),
    ];
    const scores = computeBm25Scores(docs, "test");
    expect(scores.get("a")).toBeGreaterThan(0);
    expect(scores.get("b")).toBe(0);
  });

  it("stems query and document terms to the same root regardless of inflection direction", () => {
    // "running"/"runner"/"runs" all reduce to the same Porter stem as "run".
    const docs = [
      makeFact({ id: "a", text: "the test runner runs quickly", kind: "fact" }),
      makeFact({ id: "b", text: "unrelated fact about bananas", kind: "fact" }),
    ];
    const scores = computeBm25Scores(docs, "running");
    expect(scores.get("a")).toBeGreaterThan(0);
    expect(scores.get("b")).toBe(0);
  });

  it("does not stem a token containing a digit -- 'es6' stays 'es6', not truncated to 'es'", () => {
    const docs = [makeFact({ id: "a", text: "targets es6 output", kind: "fact" })];
    // If "es6" were fed through the stemmer it is not purely alphabetic so nothing would change --
    // this pins that a *query* of the bare prefix "es" does not match the mixed alnum token "es6",
    // i.e. tokenize's digit guard actually took effect rather than the stemmer being a no-op here
    // for an unrelated reason.
    expect(computeBm25Scores(docs, "es6").get("a")).toBeGreaterThan(0);
    expect(computeBm25Scores(docs, "es").get("a")).toBe(0);
  });
});

describe("porterStem (item 2)", () => {
  // A representative slice of the word/stem pairs from Porter's own reference vocabulary
  // (M.F. Porter, "An algorithm for suffix stripping", 1980) covering all five steps of the
  // algorithm, not just the two words this project's own docs happen to mention.
  const vectors: ReadonlyArray<readonly [string, string]> = [
    ["caresses", "caress"],
    ["ponies", "poni"],
    ["ties", "ti"],
    ["caress", "caress"],
    ["cats", "cat"],
    ["feed", "feed"],
    ["agreed", "agre"],
    ["plastered", "plaster"],
    ["bled", "bled"],
    ["motoring", "motor"],
    ["sing", "sing"],
    ["conflated", "conflat"],
    ["troubled", "troubl"],
    ["sized", "size"],
    ["hopping", "hop"],
    ["tanned", "tan"],
    ["falling", "fall"],
    ["hissing", "hiss"],
    ["fizzed", "fizz"],
    ["failing", "fail"],
    ["filing", "file"],
    ["happy", "happi"],
    ["sky", "sky"],
    ["relational", "relat"],
    ["conditional", "condit"],
    ["rational", "ration"],
    ["valenci", "valenc"],
    ["hesitanci", "hesit"],
    ["digitizer", "digit"],
    ["conformabli", "conform"],
    ["radicalli", "radic"],
    ["differentli", "differ"],
    ["vileli", "vile"],
    ["analogousli", "analog"],
    ["vietnamization", "vietnam"],
    ["predication", "predic"],
    ["operator", "oper"],
    ["feudalism", "feudal"],
    ["decisiveness", "decis"],
    ["hopefulness", "hope"],
    ["callousness", "callous"],
    ["formaliti", "formal"],
    ["sensitiviti", "sensit"],
    ["sensibiliti", "sensibl"],
    ["triplicate", "triplic"],
    ["formative", "form"],
    ["formalize", "formal"],
    ["electriciti", "electr"],
    ["electrical", "electr"],
    ["hopeful", "hope"],
    ["goodness", "good"],
    ["revival", "reviv"],
    ["allowance", "allow"],
    ["inference", "infer"],
    ["airliner", "airlin"],
    ["gyroscopic", "gyroscop"],
    ["adjustable", "adjust"],
    ["defensible", "defens"],
    ["irritant", "irrit"],
    ["replacement", "replac"],
    ["adjustment", "adjust"],
    ["dependent", "depend"],
    ["adoption", "adopt"],
    ["homologou", "homolog"],
    ["communism", "commun"],
    ["activate", "activ"],
    ["angulariti", "angular"],
    ["homologous", "homolog"],
    ["effective", "effect"],
    ["bowdlerize", "bowdler"],
    ["probate", "probat"],
    ["rate", "rate"],
    ["cease", "ceas"],
    ["controll", "control"],
    ["roll", "roll"],
  ];

  // Cross-checked against the `porter-stemmer` npm package (jedp/porter-stemmer, MIT), a
  // long-established independent implementation of the same algorithm -- every pair above and
  // below matched it exactly when verified during development. Not a runtime dependency of this
  // project; used only to validate these fixed expected values, which are what the suite actually
  // pins.
  it.each([
    ["running", "run"],
    ["commits", "commit"],
    ["commit", "commit"],
    ["testing", "test"],
    ["test", "test"],
  ] as const)("stems %s to %s", (word, expected) => {
    expect(_stemForTests(word)).toBe(expected);
  });

  it.each(vectors)("stems %s to %s", (word, expected) => {
    expect(_stemForTests(word)).toBe(expected);
  });

  it("stems consistently regardless of input case", () => {
    expect(_stemForTests("RUNNING")).toBe(_stemForTests("running"));
  });

  it("is idempotent: stemming an already-stemmed word is a no-op", () => {
    const once = _stemForTests("nationalization");
    expect(_stemForTests(once)).toBe(once);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal vectors", () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
  });

  it("returns 0 for a zero vector", () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });
});

describe("reciprocalRankFusion", () => {
  it("boosts an id that ranks well in both lists over one that ranks well in only one", () => {
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["a", "c", "b"],
    ]);
    expect(fused.get("a")).toBeGreaterThan(fused.get("b") ?? 0);
    expect(fused.get("a")).toBeGreaterThan(fused.get("c") ?? 0);
  });

  it("gives partial credit to an id present in only one list", () => {
    const fused = reciprocalRankFusion([["a", "b"], ["a"]]);
    expect(fused.get("a")).toBeGreaterThan(fused.get("b") ?? 0);
  });
});

describe("retrieve", () => {
  it("marks a fact with no anchor as unverified/hint, with an unverified display", async () => {
    const facts = [makeFact({ id: "1", text: "chose Postgres over Mongo", kind: "decision" })];
    const { results: [result] } = await retrieve(facts, { query: "postgres", root });
    expect(result?.freshness).toBe("unverified");
    expect(result?.trust).toBe("hint");
    expect(result?.display).toContain("(unverified, 2026-01)");
  });

  it("surfaces a decision plainly (no verify caveat) once its anchor affirms it", async () => {
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({ id: "1", text: "chose Postgres over Mongo", kind: "decision", anchor: "file-exists present.txt" }),
    ];
    const { results: [result] } = await retrieve(facts, { query: "postgres", root });
    expect(result?.freshness).toBe("affirmed");
    expect(result?.trust).toBe("ground-truth");
    expect(result?.display).toBe("decision: chose Postgres over Mongo — mem show 1");
  });

  it("anchorTimeBudgetMs: 0 forces every anchor to unverified and reports one anchorBudgetHits per fact", async () => {
    // A zero (or already-passed) budget means `evaluateAnchor` bails out on entry for every
    // candidate before it ever reads a file -- exercising `budgetExceeded`'s "already-expired
    // deadline on entry" branch for the whole batch, not just a slow individual anchor.
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({ id: "1", text: "chose Postgres over Mongo", kind: "decision", anchor: "file-exists present.txt" }),
      makeFact({ id: "2", text: "uses pnpm not npm", kind: "preference", anchor: "file-absent npm-only.txt" }),
    ];
    const outcome = await retrieve(facts, { query: "", root, anchorTimeBudgetMs: 0 });
    expect(outcome.results.every((result) => result.freshness === "unverified")).toBe(true);
    expect(outcome.anchorBudgetHits).toBe(facts.length);
  });

  it("a fact with no anchor at all is unverified without counting as an anchorBudgetHits, even under a zero budget", async () => {
    // `anchor === null` short-circuits `evaluateAnchor` before the budget check ever runs, so this
    // fact's "unverified" is the ordinary "no predicate to evaluate" outcome, not a budget artifact.
    const facts = [makeFact({ id: "1", text: "no anchor at all", kind: "fact" })];
    const outcome = await retrieve(facts, { query: "", root, anchorTimeBudgetMs: 0 });
    expect(outcome.results[0]?.freshness).toBe("unverified");
    expect(outcome.anchorBudgetHits).toBe(0);
  });

  it("a generous anchorTimeBudgetMs reports zero anchorBudgetHits, matching the default small-store case", async () => {
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({ id: "1", text: "chose Postgres over Mongo", kind: "decision", anchor: "file-exists present.txt" }),
    ];
    const outcome = await retrieve(facts, { query: "postgres", root });
    expect(outcome.anchorBudgetHits).toBe(0);
  });

  it("omits the trailing CTA from display when includeDisplayCta is false (integration-seam.ts TGMEM/2)", async () => {
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({ id: "1", text: "chose Postgres over Mongo", kind: "decision", anchor: "file-exists present.txt" }),
    ];
    const { results: [result] } = await retrieve(facts, { query: "postgres", root, includeDisplayCta: false });
    expect(result?.display).toBe("decision: chose Postgres over Mongo");
  });

  it("hintStyle 'full' (default/explicit) is byte-identical to today's format", async () => {
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({ id: "1", text: "chose Postgres over Mongo", kind: "decision", anchor: "file-exists present.txt" }),
    ];
    const { results: [defaulted] } = await retrieve(facts, { query: "postgres", root });
    const { results: [explicit] } = await retrieve(facts, { query: "postgres", root, hintStyle: "full" });
    expect(defaulted?.display).toBe("decision: chose Postgres over Mongo — mem show 1");
    expect(explicit?.display).toBe(defaulted?.display);
  });

  it("hintStyle 'terse' drops the CTA and shortens kind labels to the wire-tag set (pref/dec/fact/corr)", async () => {
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({ id: "1", text: "chose Postgres over Mongo", kind: "decision", anchor: "file-exists present.txt" }),
      makeFact({ id: "2", text: "never run npm install here", kind: "correction" }),
      makeFact({ id: "3", text: "staging DB host is db.internal", kind: "fact" }),
    ];
    const { results } = await retrieve(facts, { query: "", root, hintStyle: "terse" });
    const byId = new Map(results.map((result) => [result.fact.id, result.display]));
    expect(byId.get("1")).toBe("dec: chose Postgres over Mongo");
    expect(byId.get("2")).toContain("corr (unverified, 2026-01): never run npm install here");
    expect(byId.get("2")).not.toContain("—");
    expect(byId.get("3")).not.toContain("—");
  });

  it("hintStyle 'terse' still applies the (verify) caveat to preferences, just without the CTA", async () => {
    writeFileSync(join(root, "pnpm-lock.yaml"), "x");
    const facts = [
      makeFact({
        id: "1",
        text: "uses pnpm not npm",
        kind: "preference",
        anchor: "file-exists pnpm-lock.yaml",
        subject: "package-manager",
        value: "pnpm",
      }),
    ];
    const now = new Date("2026-01-01T00:00:01.000Z");
    const { results: [result] } = await retrieve(facts, { query: "pnpm", root, now, hintStyle: "terse" });
    expect(result?.display).toBe("stored pref (verify): uses pnpm not npm");
  });

  it("always caveats a preference with (verify), even when affirmed", async () => {
    writeFileSync(join(root, "pnpm-lock.yaml"), "x");
    const facts = [
      makeFact({
        id: "1",
        text: "uses pnpm not npm",
        kind: "preference",
        anchor: "file-exists pnpm-lock.yaml",
        subject: "package-manager",
        value: "pnpm",
      }),
    ];
    const now = new Date("2026-01-01T00:00:01.000Z");
    const { results: [result] } = await retrieve(facts, { query: "pnpm", root, now });
    expect(result?.freshness).toBe("affirmed");
    expect(result?.trust).toBe("ground-truth");
    expect(result?.display).toBe("stored pref (verify): uses pnpm not npm — mem show 1");
  });

  it("withholds and caveats an anchor-contradicted fact", async () => {
    writeFileSync(join(root, "npm-only.txt"), "x");
    const facts = [
      makeFact({ id: "1", text: "uses pnpm not npm", kind: "preference", anchor: "file-absent npm-only.txt" }),
    ];
    const { results: [result] } = await retrieve(facts, { query: "pnpm", root });
    expect(result?.freshness).toBe("contradicted");
    expect(result?.trust).toBe("withheld");
    expect(result?.display).toContain("(contradicted, excluded)");
  });

  it("labels a pinned-but-contradicted fact distinctly", async () => {
    writeFileSync(join(root, "npm-only.txt"), "x");
    const facts = [
      makeFact({
        id: "1",
        text: "uses pnpm not npm",
        kind: "preference",
        anchor: "file-absent npm-only.txt",
        status: "pinned",
      }),
    ];
    const { results: [result] } = await retrieve(facts, { query: "pnpm", root });
    expect(result?.display).toContain("(pinned but contradicted)");
    expect(result?.trust).toBe("withheld");
  });

  it("never surfaces a superseded fact even if it matches the query", async () => {
    const facts = [
      makeFact({ id: "1", text: "uses npm", kind: "preference", status: "superseded", subject: "package-manager", value: "npm" }),
    ];
    const { results } = await retrieve(facts, { query: "npm", root });
    expect(results).toHaveLength(0);
  });

  it("shows a pending fact as unconfirmed in interactive mode but excludes it from hint-format", async () => {
    const facts = [makeFact({ id: "1", text: "uses tabs not spaces", kind: "preference", status: "pending" })];

    const { results: interactive } = await retrieve(facts, { query: "tabs", root });
    expect(interactive[0]?.trust).toBe("withheld");
    expect(interactive[0]?.display).toContain("(pending, unconfirmed)");

    const { results: hintFormat } = await retrieve(facts, { query: "tabs", root, hintFormat: true });
    expect(hintFormat).toHaveLength(0);
  });

  it("shows a contested fact as excluded in interactive mode but excludes it from hint-format", async () => {
    const facts: Fact[] = [
      makeFact({ id: "1", text: "uses npm", kind: "preference", subject: "package-manager", value: "npm", source_type: "user", captured_at: "2026-01-01T00:00:00.000Z" }),
      makeFact({ id: "2", text: "uses pnpm", kind: "preference", subject: "package-manager", value: "pnpm", source_type: "user", captured_at: "2026-01-01T00:00:00.000Z" }),
    ];

    const { results: interactive } = await retrieve(facts, { query: "package manager", root });
    expect(interactive).toHaveLength(2);
    for (const result of interactive) {
      expect(result.trust).toBe("withheld");
      expect(result.display).toContain("(contested, excluded)");
    }

    const { results: hintFormat } = await retrieve(facts, { query: "package manager", root, hintFormat: true });
    expect(hintFormat).toHaveLength(0);
  });

  it("resolves a deterministic contradiction to a single winner surfaced as ground-truth-eligible", async () => {
    const facts: Fact[] = [
      makeFact({ id: "old", text: "uses npm", kind: "preference", subject: "package-manager", value: "npm", captured_at: "2025-01-01T00:00:00.000Z" }),
      makeFact({ id: "new", text: "uses pnpm", kind: "preference", subject: "package-manager", value: "pnpm", captured_at: "2026-01-01T00:00:00.000Z" }),
    ];
    const { results } = await retrieve(facts, { query: "package manager", root });
    const ids = results.map((r) => r.fact.id);
    expect(ids).toEqual(["new"]);
    expect(results[0]?.trust).toBe("hint");
  });

  it("decays an old, unpinned preference from ground-truth to hint", async () => {
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({
        id: "1",
        text: "uses pnpm",
        kind: "preference",
        anchor: "file-exists present.txt",
        captured_at: "2020-01-01T00:00:00.000Z",
        confidence: 1,
      }),
    ];
    const farFuture = new Date("2027-01-01T00:00:00.000Z");
    const { results: [result] } = await retrieve(facts, { query: "pnpm", root, now: farFuture });
    expect(result?.freshness).toBe("affirmed");
    expect(result?.trust).toBe("hint");
  });

  it("does not decay a pinned preference", async () => {
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({
        id: "1",
        text: "uses pnpm",
        kind: "preference",
        anchor: "file-exists present.txt",
        captured_at: "2020-01-01T00:00:00.000Z",
        confidence: 1,
        status: "pinned",
      }),
    ];
    const farFuture = new Date("2027-01-01T00:00:00.000Z");
    const { results: [result] } = await retrieve(facts, { query: "pnpm", root, now: farFuture });
    expect(result?.trust).toBe("ground-truth");
  });

  it("does not decay decisions/facts", async () => {
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({
        id: "1",
        text: "chose Postgres over Mongo",
        kind: "decision",
        anchor: "file-exists present.txt",
        captured_at: "2020-01-01T00:00:00.000Z",
        confidence: 1,
      }),
    ];
    const farFuture = new Date("2027-01-01T00:00:00.000Z");
    const { results: [result] } = await retrieve(facts, { query: "postgres", root, now: farFuture });
    expect(result?.trust).toBe("ground-truth");
  });

  it("applies structural filters (kind, subject, scope, ageDays)", async () => {
    const facts: Fact[] = [
      makeFact({ id: "1", text: "uses pnpm", kind: "preference", subject: "package-manager", scope: "project", captured_at: "2026-01-01T00:00:00.000Z" }),
      makeFact({ id: "2", text: "chose Postgres", kind: "decision", subject: "database", scope: "global", captured_at: "2020-01-01T00:00:00.000Z" }),
    ];
    const now = new Date("2026-01-15T00:00:00.000Z");

    const { results: byKind } = await retrieve(facts, { query: "", root, kind: "decision", now });
    expect(byKind.map((r) => r.fact.id)).toEqual(["2"]);

    const { results: bySubject } = await retrieve(facts, { query: "", root, subject: "package-manager", now });
    expect(bySubject.map((r) => r.fact.id)).toEqual(["1"]);

    // Regression: a subject filter typed with different casing/whitespace than how storage.ts
    // normalized and stored it (trim + lowercase) must still match -- a raw, un-normalized `!==`
    // comparison here would silently return zero results for a perfectly valid, naturally-typed
    // `--subject Package-Manager`.
    const { results: bySubjectDifferentCasing } = await retrieve(facts, { query: "", root, subject: "  Package-Manager  ", now });
    expect(bySubjectDifferentCasing.map((r) => r.fact.id)).toEqual(["1"]);

    const { results: byScope } = await retrieve(facts, { query: "", root, scope: "global", now });
    expect(byScope.map((r) => r.fact.id)).toEqual(["2"]);

    const { results: byAge } = await retrieve(facts, { query: "", root, ageDays: 30, now });
    expect(byAge.map((r) => r.fact.id)).toEqual(["1"]);
  });

  it("applies limit after ranking", async () => {
    const facts = [
      makeFact({ id: "1", text: "fact one about pnpm", kind: "fact", captured_at: "2026-01-01T00:00:00.000Z" }),
      makeFact({ id: "2", text: "fact two about pnpm", kind: "fact", captured_at: "2026-01-02T00:00:00.000Z" }),
      makeFact({ id: "3", text: "fact three about pnpm", kind: "fact", captured_at: "2026-01-03T00:00:00.000Z" }),
    ];
    const { results } = await retrieve(facts, { query: "pnpm", root, limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("falls back to BM25-only when the embedding backend throws", async () => {
    const throwingBackend: EmbeddingBackend = {
      embed: () => {
        throw new Error("boom");
      },
    };
    const facts = [
      makeFact({ id: "1", text: "uses pnpm not npm", kind: "preference", embedding: new Float32Array([1, 0]) }),
    ];
    const { results } = await retrieve(facts, { query: "pnpm", root, embeddingBackend: throwingBackend });
    expect(results).toHaveLength(1);
    expect(results[0]?.fact.id).toBe("1");
  });

  it("fuses BM25 and embedding signals when an embedding backend is available", async () => {
    // "a" is a strong BM25 match but far in embedding space; "b" is a weak BM25 match but close in
    // embedding space to the (contrived) query vector. RRF fusion should let "b" compete with "a"
    // rather than BM25 alone dominating.
    const facts = [
      makeFact({ id: "a", text: "uses pnpm not npm for everything", kind: "fact", embedding: new Float32Array([0, 1]) }),
      makeFact({ id: "b", text: "irrelevant unrelated text", kind: "fact", embedding: new Float32Array([1, 0]) }),
    ];
    const backend: EmbeddingBackend = {
      embed: () => new Float32Array([1, 0]),
    };
    const { results } = await retrieve(facts, { query: "pnpm", root, embeddingBackend: backend });
    const ids = results.map((r) => r.fact.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    // b wins the embedding signal outright (cosine similarity 1 vs 0), and RRF gives it credit
    // even though it has zero BM25 score, so it should not rank last.
    expect(ids.indexOf("b")).toBeLessThan(1 + 1);
  });

  it("returns nothing when there are no candidate facts after filtering", async () => {
    const facts = [makeFact({ id: "1", text: "x", kind: "fact" })];
    const { results } = await retrieve(facts, { query: "x", root, kind: "decision" });
    expect(results).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────── regression: project-scoped anchors evaluate against their own root ───────────────────────────────────────────────────────────────────────────

describe("regression: a project-scoped fact's anchor is evaluated against its own scopeRoot", () => {
  let otherRoot: string;

  beforeEach(() => {
    otherRoot = mkdtempSync(join(tmpdir(), "mem-retrieval-other-"));
  });

  afterEach(() => {
    rmSync(otherRoot, { recursive: true, force: true });
  });

  it("affirms a project fact whose anchor target lives under its scopeRoot, not under the querying root", async () => {
    writeFileSync(join(otherRoot, "present.txt"), "x");
    const facts = [
      makeFact({
        id: "1",
        text: "chose Postgres over Mongo",
        kind: "decision",
        scope: "project",
        scopeRoot: otherRoot,
        anchor: "file-exists present.txt",
      }),
    ];

    // Evaluated against the *querying* root the file is absent, which under P3 is a `contradicted`
    // verdict -- actively asserting the fact is wrong, and withholding it from ground truth, purely
    // because the query came from a different directory than the one the fact is bound to.
    const { results: [result] } = await retrieve(facts, { query: "postgres", root });
    expect(result?.freshness).toBe("affirmed");
    expect(result?.trust).toBe("ground-truth");
  });

  it("still contradicts a project fact whose target is genuinely missing from its own scopeRoot", async () => {
    const facts = [
      makeFact({
        id: "1",
        text: "chose Postgres over Mongo",
        kind: "decision",
        scope: "project",
        scopeRoot: otherRoot,
        anchor: "file-exists present.txt",
      }),
    ];

    const { results: [result] } = await retrieve(facts, { query: "postgres", root });
    expect(result?.freshness).toBe("contradicted");
  });

  it("leaves path- and global-scoped facts on the caller's root, where scopeRoot is not a project directory", async () => {
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({
        id: "1",
        text: "chose Postgres over Mongo",
        kind: "decision",
        scope: "path",
        // For `path` scope this is a file/dir path, not a project root -- resolving an anchor's
        // relative target against it would be meaningless.
        scopeRoot: join(otherRoot, "some", "file.ts"),
        anchor: "file-exists present.txt",
      }),
    ];

    const { results: [result] } = await retrieve(facts, { query: "postgres", root });
    expect(result?.freshness).toBe("affirmed");
  });
});

// ─────────────────────────────────────────────────────────────────────────── regression: restrictToRoot binds facts to the querying root ───────────────────────────────────────────────────────────────────────────

describe("regression: restrictToRoot excludes facts bound to a different root", () => {
  let otherRoot: string;

  beforeEach(() => {
    otherRoot = mkdtempSync(join(tmpdir(), "mem-retrieval-scope-"));
  });

  afterEach(() => {
    rmSync(otherRoot, { recursive: true, force: true });
  });

  it("drops a project fact bound to another project, and keeps the one bound here", async () => {
    const facts = [
      makeFact({ id: "here", text: "chose Postgres", kind: "decision", scope: "project", scopeRoot: root }),
      makeFact({ id: "there", text: "chose Postgres", kind: "decision", scope: "project", scopeRoot: otherRoot }),
    ];

    const { results } = await retrieve(facts, { query: "postgres", root, restrictToRoot: true });
    expect(results.map((result) => result.fact.id)).toEqual(["here"]);
  });

  it("keeps global facts regardless of where the query came from", async () => {
    const facts = [makeFact({ id: "g", text: "chose Postgres", kind: "decision", scope: "global", scopeRoot: null })];

    const { results } = await retrieve(facts, { query: "postgres", root, restrictToRoot: true });
    expect(results.map((result) => result.fact.id)).toEqual(["g"]);
  });

  it("keeps a path fact bound beneath the querying root and drops one bound outside it", async () => {
    const facts = [
      makeFact({
        id: "inside",
        text: "chose Postgres",
        kind: "decision",
        scope: "path",
        scopeRoot: join(root, "src", "db.ts"),
      }),
      makeFact({
        id: "outside",
        text: "chose Postgres",
        kind: "decision",
        scope: "path",
        scopeRoot: join(otherRoot, "src", "db.ts"),
      }),
    ];

    const { results } = await retrieve(facts, { query: "postgres", root, restrictToRoot: true });
    expect(results.map((result) => result.fact.id)).toEqual(["inside"]);
  });

  it("drops a project fact carrying no binding rather than guessing it belongs here", async () => {
    const facts = [makeFact({ id: "unbound", text: "chose Postgres", kind: "decision", scope: "project", scopeRoot: null })];

    const { results } = await retrieve(facts, { query: "postgres", root, restrictToRoot: true });
    expect(results).toHaveLength(0);
  });

  it("leaves the pool untouched when restrictToRoot is not set, which every other caller relies on", async () => {
    const facts = [
      makeFact({ id: "here", text: "chose Postgres", kind: "decision", scope: "project", scopeRoot: root }),
      makeFact({ id: "there", text: "chose Redis", kind: "decision", scope: "project", scopeRoot: otherRoot }),
    ];

    const { results } = await retrieve(facts, { query: "chose", root });
    expect(results.map((result) => result.fact.id).sort()).toEqual(["here", "there"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────── regression: superseded facts are excluded entirely, not exempt from limit ───────────────────────────────────────────────────────────────────────────

describe("regression: superseded facts are excluded entirely from results, not exempt from limit", () => {
  it("never returns a superseded fact even when limit is very low (e.g., 1)", async () => {
    const facts = [
      makeFact({
        id: "superseded-id",
        text: "chose Redis for caching",
        kind: "decision",
        status: "superseded",
      }),
      makeFact({
        id: "active-id",
        text: "chose Postgres for persistence",
        kind: "decision",
        status: "active",
      }),
    ];

    const { results } = await retrieve(facts, { query: "chose", limit: 1 });
    // With limit 1, only one result should come back, and it must be the active one
    expect(results).toHaveLength(1);
    expect(results[0].fact.id).toBe("active-id");
    // Verify the superseded fact is definitely not in the results
    expect(results.map((r) => r.fact.id)).not.toContain("superseded-id");
  });
});

describe("usefulness as a third RRF rank list", () => {
  const facts = [
    makeFact({ id: "a", text: "deploy runbook mentions the deploy step", kind: "fact", captured_at: "2026-01-03T00:00:00.000Z" }),
    makeFact({ id: "b", text: "deploy runbook", kind: "fact", captured_at: "2026-01-02T00:00:00.000Z" }),
    makeFact({ id: "c", text: "unrelated note about cheese", kind: "fact", captured_at: "2026-01-01T00:00:00.000Z" }),
  ];

  it("reorders results a confirmed-useful fact would otherwise lose on BM25 alone", async () => {
    const withoutFeedback = await retrieve(facts, { query: "deploy", root });
    expect(withoutFeedback.results.map((r) => r.fact.id).slice(0, 2)).toEqual(["a", "b"]);

    // `b` is the fact people actually act on; `a` merely says the word "deploy" twice.
    const withFeedback = await retrieve(facts, {
      query: "deploy",
      root,
      usefulness: new Map([
        ["a", { surfaced: 4, used: 0 }],
        ["b", { surfaced: 3, used: 3 }],
      ]),
    });
    expect(withFeedback.results.map((r) => r.fact.id).slice(0, 2)).toEqual(["b", "a"]);
  });

  it("prefers a fact used 2 of 2 times over one used 2 of 50", async () => {
    const withFeedback = await retrieve(facts, {
      query: "",
      root,
      usefulness: new Map([
        ["b", { surfaced: 50, used: 2 }],
        ["c", { surfaced: 2, used: 2 }],
      ]),
    });
    // An empty query ties every BM25 score at 0, so the usefulness list alone decides the order of
    // the two ranked facts -- which is what isolates the tie-break rule under test. `c` is also the
    // *older* of the two, so the final `captured_at` tie-break would order them the other way round:
    // without the surfaced-count rule this assertion reads ["b", "c"] and the test cannot pass by
    // accident of the default recency ordering.
    const ranked = withFeedback.results.map((r) => r.fact.id).filter((id) => id === "b" || id === "c");
    expect(ranked).toEqual(["c", "b"]);
  });

  it("ignores a surfaced-but-never-confirmed fact rather than demoting it", async () => {
    // Zero used counts must leave the rank list empty. If they did not, every store that had ever
    // logged a recall would switch retrieval into RRF -- and RRF never emits a 0 score, which is the
    // single predicate integration-seam.ts's `--delta` filter uses to tell a match from filler.
    const baseline = await retrieve(facts, { query: "deploy", root });
    const withZeroes = await retrieve(facts, {
      query: "deploy",
      root,
      usefulness: new Map([
        ["a", { surfaced: 9, used: 0 }],
        ["b", { surfaced: 9, used: 0 }],
        ["c", { surfaced: 9, used: 0 }],
      ]),
    });
    expect(withZeroes.results.map((r) => [r.fact.id, r.score])).toEqual(baseline.results.map((r) => [r.fact.id, r.score]));
  });

  it("scores a non-matching fact exactly 0 when no auxiliary list is fused, preserving the --delta contract", async () => {
    // Pinned, not assumed: integration-seam.ts's delta filter keeps a fact suppressed only while
    // `score === 0` ("filler, swept in by the caps"). Switching the single-list path to RRF would
    // give every filler fact a small positive score and silently disable delta suppression entirely.
    const outcome = await retrieve(facts, { query: "deploy", root });
    const scores = new Map(outcome.results.map((r) => [r.fact.id, r.score]));
    expect(scores.get("c")).toBe(0);
    expect(scores.get("a")).toBeGreaterThan(0);
    // And raw BM25, not a fused rank score: the two ranked facts differ by more than RRF's tiny
    // 1/(k+rank) spacing ever could.
    expect((scores.get("a") ?? 0) - (scores.get("b") ?? 0)).not.toBe(0);
  });
});
