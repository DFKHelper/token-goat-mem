/**
 * Ties a ranking stage and `metrics.ts` (precision/nDCG/duplicates/tokens) together into one
 * aggregate report per configuration, over a full scenario set -- the piece item 3 exists to
 * build, so items 1 and 2 are verifiable by measurement rather than assertion alone.
 *
 * For `"recency"`/`"query-no-stem"`/`"query-stem"`, the ranking stage is `rank.ts`'s reduced
 * reimplementation. For `"pipeline"` it is the real `retrieve()` (`eval/pipelineFixture.ts`),
 * threaded in via the `rankScenario` parameter below rather than hardcoded here -- this module
 * stays agnostic to how a configuration ranks, only that it does.
 */

import { rankFacts, type BaselineRankConfig, type RankConfig, type RankedResult } from "./rank.js";
import { approximateTokens, duplicateSubjectPairs, ndcgAtK, precisionAtK } from "./metrics.js";
import type { EvalFact } from "./fixtures.js";
import type { Scenario } from "./queries.js";

/** Ranks one scenario under `config`, returning results in surfacing order. */
export type RankScenario = (facts: readonly EvalFact[], scenario: Scenario, config: RankConfig) => Promise<RankedResult[]>;

/** Wraps the synchronous `rankFacts` for the three baseline configurations. Throws if handed `"pipeline"` -- that configuration has no reduced-model ranking to fall back to and must supply its own `rankScenario` (see `eval/run.ts`). */
async function defaultRankScenario(facts: readonly EvalFact[], scenario: Scenario, config: RankConfig): Promise<RankedResult[]> {
  if (config === "pipeline") {
    throw new Error("evaluateConfig: the \"pipeline\" config requires an explicit rankScenario (see eval/pipelineFixture.ts)");
  }
  const baseline: BaselineRankConfig = config;
  return rankFacts(facts, scenario.query, scenario.root, baseline);
}

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
  /**
   * Share of surfaced anchored facts whose anchor re-evaluated to `"affirmed"`, across every
   * scenario. `NaN` for any configuration that has no anchor stage at all -- which is the three
   * baseline configurations, since `rankFacts` never evaluates an anchor.
   *
   * This is the one column the reduced rankers structurally cannot fill, and it is the reason the
   * `"pipeline"` configuration's filesystem fixture has to be real: an anchor verdict is a *trust*
   * signal, not a ranking one, so it moves neither precision nor nDCG. Without this column a
   * corpus whose anchors never resolve looks identical to one whose anchors all hold.
   */
  readonly anchorAffirmedRate: number;
  /** Total wall-clock time (ms) spent ranking every scenario at this configuration. */
  readonly wallTimeMs: number;
}

export async function evaluateConfig(
  facts: readonly EvalFact[],
  scenarios: readonly Scenario[],
  config: RankConfig,
  k: number,
  rankScenario: RankScenario = defaultRankScenario
): Promise<ConfigReport> {
  const start = performance.now();

  let precisionSum = 0;
  let ndcgSum = 0;
  let judgedScenarioCount = 0;
  let totalDuplicateSubjectPairs = 0;
  let totalTokensEmitted = 0;
  let noMatchNeverFiltered = true;
  let anchoredSurfaced = 0;
  let anchoredAffirmed = 0;

  for (const scenario of scenarios) {
    const ranked = await rankScenario(facts, scenario, config);
    const rankedFacts = ranked.map((r) => r.fact);
    const rankedIds = rankedFacts.map((f) => f.id);

    for (const result of ranked) {
      // `freshness === undefined` means the configuration has no anchor stage, not that the anchor
      // came back empty -- those must not be counted as a miss, or the baselines would report 0%
      // rather than "not applicable".
      if (result.fact.anchor !== null && result.freshness !== undefined) {
        anchoredSurfaced++;
        if (result.freshness === "affirmed") {
          anchoredAffirmed++;
        }
      }
    }

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
    anchorAffirmedRate: anchoredSurfaced > 0 ? anchoredAffirmed / anchoredSurfaced : NaN,
    wallTimeMs,
  };
}
