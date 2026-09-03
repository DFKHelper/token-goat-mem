/**
 * Ties `rank.ts` (the ranking stage under test) and `metrics.ts` (precision/nDCG/duplicates/tokens)
 * together into one aggregate report per configuration, over a full scenario set -- the piece item
 * 3 exists to build, so items 1 and 2 are verifiable by measurement rather than assertion alone.
 */

import { rankFacts, type RankConfig } from "./rank.js";
import { approximateTokens, duplicateSubjectPairs, ndcgAtK, precisionAtK } from "./metrics.js";
import type { EvalFact } from "./fixtures.js";
import type { Scenario } from "./queries.js";

export interface ConfigReport {
  readonly config: RankConfig;
  /** Mean precision@k over scenarios that have a relevance judgment ("exact" and "stem" families). */
  readonly meanPrecisionAtK: number;
  /** Mean nDCG@k over the same judged scenarios. */
  readonly meanNdcgAtK: number;
  /** Scenarios scored for precision/nDCG (excludes "no-match", which has no relevance judgment). */
  readonly judgedScenarioCount: number;
  /** Total duplicate-subject pairs across every scenario's top-k. */
  readonly totalDuplicateSubjectPairs: number;
  /** Total approximate tokens emitted across every scenario's top-k. */
  readonly totalTokensEmitted: number;
  /** For every "no-match" scenario, whether the full candidate set still appeared in the top-k
   * (bounded by corpus size) -- i.e. the query ranked rather than filtered. `true` iff every
   * no-match scenario preserved the full scope-eligible candidate count. */
  readonly noMatchNeverFiltered: boolean;
  /** Total wall-clock time (ms) spent ranking every scenario at this configuration. */
  readonly wallTimeMs: number;
}

export function evaluateConfig(facts: readonly EvalFact[], scenarios: readonly Scenario[], config: RankConfig, k: number): ConfigReport {
  const start = performance.now();

  let precisionSum = 0;
  let ndcgSum = 0;
  let judgedScenarioCount = 0;
  let totalDuplicateSubjectPairs = 0;
  let totalTokensEmitted = 0;
  let noMatchNeverFiltered = true;

  for (const scenario of scenarios) {
    const ranked = rankFacts(facts, scenario.query, scenario.root, config);
    const rankedFacts = ranked.map((r) => r.fact);
    const rankedIds = rankedFacts.map((f) => f.id);

    totalDuplicateSubjectPairs += duplicateSubjectPairs(rankedFacts, k);
    totalTokensEmitted += approximateTokens(rankedFacts, k);

    if (scenario.family === "no-match") {
      // A query is a ranking input, never a filter (src/cli.ts's documented BM25 contract): the
      // full scope-eligible candidate set must still be present, just (possibly) reordered.
      const scopeEligibleCount = facts.filter((f) => f.scope === "global" || f.scopeRoot === scenario.root).length;
      if (rankedIds.length !== scopeEligibleCount) {
        noMatchNeverFiltered = false;
      }
      continue;
    }

    const relevant = scenario.relevantIds ?? new Set<string>();
    if (relevant.size === 0) {
      continue;
    }
    judgedScenarioCount++;
    precisionSum += precisionAtK(rankedIds, relevant, k);
    ndcgSum += ndcgAtK(rankedIds, relevant, k);
  }

  const wallTimeMs = performance.now() - start;

  return {
    config,
    meanPrecisionAtK: judgedScenarioCount > 0 ? precisionSum / judgedScenarioCount : NaN,
    meanNdcgAtK: judgedScenarioCount > 0 ? ndcgSum / judgedScenarioCount : NaN,
    judgedScenarioCount,
    totalDuplicateSubjectPairs,
    totalTokensEmitted,
    noMatchNeverFiltered,
    wallTimeMs,
  };
}
