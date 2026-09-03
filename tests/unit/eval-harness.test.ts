/**
 * Correctness coverage for the eval harness itself (item 3) -- fast, deterministic, and run as
 * part of the normal `npm test` gate, unlike `npm run eval` (`eval/run.ts`), which generates a
 * 400-fact corpus and 40+ scenarios and is deliberately kept out of the gate for being unnecessary
 * weight on every commit. This file is not that benchmark; it pins that the metrics math, the
 * ranking configurations, and the fixture generator's own invariants are correct on small,
 * hand-inspectable inputs.
 */

import { describe, expect, it } from "vitest";

import { duplicateSubjectPairs, ndcgAtK, precisionAtK, approximateTokens } from "../../eval/metrics.js";
import { rankFacts } from "../../eval/rank.js";
import { generateCorpus, PROJECT_ROOTS, type EvalFact } from "../../eval/fixtures.js";
import { generateScenarios } from "../../eval/queries.js";
import { evaluateConfig } from "../../eval/harness.js";
import { mulberry32, pick, pickN, chance } from "../../eval/prng.js";

function fact(overrides: Partial<EvalFact> & Pick<EvalFact, "id" | "text">): EvalFact {
  return {
    kind: "fact",
    subject: null,
    value: null,
    scope: "global",
    scopeRoot: null,
    source_type: "user",
    source_ref: null,
    captured_at: "2026-01-01T00:00:00.000Z",
    anchor: null,
    status: "active",
    confidence: 1,
    embedding: null,
    _template: "t",
    _value: "v",
    _isDuplicate: false,
    _isContradiction: false,
    ...overrides,
  };
}

describe("eval/prng.ts", () => {
  it("mulberry32 is deterministic for a fixed seed", () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("pick and pickN are deterministic for a fixed seed and never return an out-of-set element", () => {
    const items = ["a", "b", "c", "d"];
    const rng = mulberry32(7);
    const picked = pickN(rng, items, 2);
    expect(picked).toHaveLength(2);
    for (const p of picked) {
      expect(items).toContain(p);
    }
    expect(new Set(picked).size).toBe(2); // pickN is without replacement
    expect(pick(mulberry32(7), items)).toBe(pick(mulberry32(7), items));
  });

  it("chance respects its probability at the extremes", () => {
    const rng = mulberry32(3);
    expect(chance(rng, 0)).toBe(false);
    expect(chance(rng, 1)).toBe(true);
  });
});

describe("eval/metrics.ts", () => {
  it("precisionAtK: a perfectly relevant top-k scores 1.0", () => {
    expect(precisionAtK(["a", "b", "c"], new Set(["a", "b", "c"]), 3)).toBe(1);
  });

  it("precisionAtK: a completely irrelevant top-k scores 0", () => {
    expect(precisionAtK(["a", "b", "c"], new Set(["x", "y"]), 3)).toBe(0);
  });

  it("precisionAtK: is NaN when there is no relevance judgment", () => {
    expect(precisionAtK(["a"], new Set(), 3)).toBeNaN();
  });

  it("ndcgAtK: perfect ranking (all relevant docs first) scores 1.0", () => {
    expect(ndcgAtK(["a", "b", "x"], new Set(["a", "b"]), 3)).toBeCloseTo(1, 10);
  });

  it("ndcgAtK: same relevant set, worse order scores strictly less than perfect order", () => {
    const relevant = new Set(["a", "b"]);
    const perfect = ndcgAtK(["a", "b", "x"], relevant, 3);
    const worse = ndcgAtK(["x", "a", "b"], relevant, 3);
    expect(worse).toBeLessThan(perfect);
    // Same relevant set present either way -- this is an ordering penalty, not a precision loss.
    expect(precisionAtK(["a", "b", "x"], relevant, 3)).toBe(precisionAtK(["x", "a", "b"], relevant, 3));
  });

  it("duplicateSubjectPairs counts same-subject pairs within top-k only, ignoring null subjects", () => {
    const facts = [
      fact({ id: "1", text: "a", subject: "s1" }),
      fact({ id: "2", text: "b", subject: "s1" }),
      fact({ id: "3", text: "c", subject: "s2" }),
      fact({ id: "4", text: "d", subject: null }),
      fact({ id: "5", text: "e", subject: null }),
    ];
    // Two null-subject facts must not count as a "duplicate" pair.
    expect(duplicateSubjectPairs(facts, 5)).toBe(1);
    // Restricting k below the second same-subject fact drops the pair.
    expect(duplicateSubjectPairs(facts, 1)).toBe(0);
  });

  it("approximateTokens grows with combined text length and respects k", () => {
    const facts = [fact({ id: "1", text: "a".repeat(40) }), fact({ id: "2", text: "b".repeat(40) })];
    expect(approximateTokens(facts, 2)).toBeGreaterThan(approximateTokens(facts, 1));
    expect(approximateTokens(facts, 1)).toBeGreaterThan(0);
  });
});

describe("eval/rank.ts", () => {
  const older = fact({ id: "older", text: "older fact about a distinctive giraffe topic", captured_at: "2020-01-01T00:00:00.000Z" });
  const newer = fact({ id: "newer", text: "unrelated newer fact about oranges", captured_at: "2020-01-02T00:00:00.000Z" });

  it("'recency' config ignores the query entirely, same as the old hardcoded query: \"\"", () => {
    const withQuery = rankFacts([older, newer], "giraffe", "/root", "recency");
    const withoutQuery = rankFacts([older, newer], "", "/root", "recency");
    expect(withQuery.map((r) => r.fact.id)).toEqual(withoutQuery.map((r) => r.fact.id));
    // Falls through to recency: newer leads.
    expect(withQuery.map((r) => r.fact.id)).toEqual(["newer", "older"]);
  });

  it("'query-no-stem' and 'query-stem' both honor the query, reordering the older matching fact first", () => {
    for (const config of ["query-no-stem", "query-stem"] as const) {
      const ranked = rankFacts([older, newer], "giraffe", "/root", config);
      expect(ranked.map((r) => r.fact.id)).toEqual(["older", "newer"]);
    }
  });

  it("only 'query-stem' matches an inflected query the raw text never contains", () => {
    const doc = fact({ id: "a", text: "the test runner runs quickly" });
    const unrelated = fact({ id: "b", text: "unrelated fact about bananas" });
    const noStem = rankFacts([doc, unrelated], "running", "/root", "query-no-stem");
    const stem = rankFacts([doc, unrelated], "running", "/root", "query-stem");
    // Unstemmed: no shared term at all, both tie at score 0 (order falls back to recency/insertion).
    expect(noStem.find((r) => r.fact.id === "a")?.score).toBe(0);
    // Stemmed: "running" and "runs" share a stem, so the doc scores above the unrelated fact.
    expect(stem.find((r) => r.fact.id === "a")?.score).toBeGreaterThan(0);
    expect(stem[0]?.fact.id).toBe("a");
  });

  it("respects scope binding: a project-scoped fact from a different root is excluded", () => {
    const boundElsewhere = fact({ id: "x", text: "deploys go out on tuesdays", scope: "project", scopeRoot: "/other-root" });
    const global = fact({ id: "g", text: "deploys go out on tuesdays too", scope: "global" });
    const ranked = rankFacts([boundElsewhere, global], "deploys", "/root", "query-stem");
    expect(ranked.map((r) => r.fact.id)).toEqual(["g"]);
  });
});

describe("eval/fixtures.ts + eval/queries.ts (generator invariants)", () => {
  it("generateCorpus is deterministic for a fixed seed", () => {
    const a = generateCorpus(99, 60);
    const b = generateCorpus(99, 60);
    expect(a).toEqual(b);
  });

  it("generateCorpus produces at least the requested count, spanning multiple roots and all four kinds", () => {
    const facts = generateCorpus(1234, 120);
    expect(facts.length).toBeGreaterThanOrEqual(120);
    const kinds = new Set(facts.map((f) => f.kind));
    expect(kinds).toEqual(new Set(["preference", "decision", "fact", "correction"]));
    const roots = new Set(facts.filter((f) => f.scopeRoot !== null).map((f) => f.scopeRoot));
    expect(roots.size).toBeGreaterThan(1);
    for (const root of roots) {
      expect(PROJECT_ROOTS).toContain(root);
    }
  });

  it("generateCorpus produces at least one exact duplicate and one contradiction at a large enough sample", () => {
    const facts = generateCorpus(55, 400);
    expect(facts.some((f) => f._isDuplicate)).toBe(true);
    expect(facts.some((f) => f._isContradiction)).toBe(true);
  });

  it("generateScenarios is deterministic for a fixed corpus and seed, and produces all three families", () => {
    const facts = generateCorpus();
    const a = generateScenarios(facts);
    const b = generateScenarios(facts);
    expect(a).toEqual(b);
    const families = new Set(a.map((s) => s.family));
    expect(families).toEqual(new Set(["exact", "stem", "no-match"]));
    expect(a.length).toBeGreaterThanOrEqual(30);
    expect(a.length).toBeLessThanOrEqual(50);
  });

  it("every 'exact' and 'stem' scenario has a non-empty relevant set", () => {
    const facts = generateCorpus();
    const scenarios = generateScenarios(facts);
    for (const scenario of scenarios) {
      if (scenario.family === "no-match") {
        continue;
      }
      expect(scenario.relevantIds && scenario.relevantIds.size).toBeGreaterThan(0);
    }
  });
});

describe("eval/harness.ts (evaluateConfig)", () => {
  it("a no-match scenario never shrinks the scope-eligible candidate count under any configuration", () => {
    const facts = generateCorpus(11, 80);
    const scenarios = generateScenarios(facts).filter((s) => s.family === "no-match");
    expect(scenarios.length).toBeGreaterThan(0);
    for (const config of ["recency", "query-no-stem", "query-stem"] as const) {
      const report = evaluateConfig(facts, scenarios, config, 8);
      expect(report.noMatchNeverFiltered).toBe(true);
    }
  });

  it("query-stem scores at least as well as recency-only on mean precision@k and nDCG@k over the same scenario set", () => {
    const facts = generateCorpus(22, 200);
    const scenarios = generateScenarios(facts);
    const recency = evaluateConfig(facts, scenarios, "recency", 8);
    const stem = evaluateConfig(facts, scenarios, "query-stem", 8);
    expect(stem.judgedScenarioCount).toBe(recency.judgedScenarioCount);
    expect(stem.meanPrecisionAtK).toBeGreaterThan(recency.meanPrecisionAtK);
    expect(stem.meanNdcgAtK).toBeGreaterThan(recency.meanNdcgAtK);
  });

  it("stemming scenarios specifically favor query-stem over query-no-stem", () => {
    const facts = generateCorpus(33, 200);
    const stemScenarios = generateScenarios(facts).filter((s) => s.family === "stem");
    expect(stemScenarios.length).toBeGreaterThan(0);
    const noStem = evaluateConfig(facts, stemScenarios, "query-no-stem", 8);
    const stem = evaluateConfig(facts, stemScenarios, "query-stem", 8);
    expect(stem.meanPrecisionAtK).toBeGreaterThan(noStem.meanPrecisionAtK);
    expect(stem.meanNdcgAtK).toBeGreaterThan(noStem.meanNdcgAtK);
  });
});
