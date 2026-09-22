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

export interface ScenarioRanking {
  /** Results in surfacing order, already truncated by whatever limit the configuration applies. */
  readonly results: readonly RankedResult[];
  /**
   * How many facts survived ranking *before* any result limit truncated them.
   *
   * Distinct from `results.length` only for a configuration that caps, which is the real
   * `retrieve()` and nothing else (`DEFAULT_RECALL_LIMIT`). The `noMatchNeverFiltered` invariant
   * below asks whether the *query* filtered, and a limit is not the query -- comparing
   * `results.length` against the scope-eligible count charges the cap as if it were lexical
   * filtering and reports a correct pipeline as a violation.
   */
  readonly poolSize: number;
}

/** Ranks one scenario under `config`, returning results in surfacing order plus the pre-limit pool size. */
export type RankScenario = (facts: readonly EvalFact[], scenario: Scenario, config: RankConfig) => Promise<ScenarioRanking>;

/** Wraps the synchronous `rankFacts` for the three baseline configurations. Throws if handed `"pipeline"` -- that configuration has no reduced-model ranking to fall back to and must supply its own `rankScenario` (see `eval/run.ts`). */
async function defaultRankScenario(facts: readonly EvalFact[], scenario: Scenario, config: RankConfig): Promise<ScenarioRanking> {
  if (config === "pipeline") {
    throw new Error("evaluateConfig: the \"pipeline\" config requires an explicit rankScenario (see eval/pipelineFixture.ts)");
  }
  const baseline: BaselineRankConfig = config;
  // `rankFacts` applies no limit at all, so the pool it returns is the pool it ranked.
  const results = rankFacts(facts, scenario.query, scenario.root, baseline);
  return { results, poolSize: results.length };
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
  /**
   * For every "no-match" scenario, whether the query ranked rather than filtered: `true` iff the
   * candidate pool this configuration left standing is the same size it leaves standing for the
   * same scenario with an empty query. Self-referential on purpose -- see the check itself.
   */
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
    const { results: ranked, poolSize } = await rankScenario(facts, scenario, config);
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
      // A query is a ranking input, never a filter (src/cli.ts's documented BM25 contract).
      //
      // Measured against the same configuration ranking the same scenario with an empty query,
      // rather than against the scope-eligible count. Counting scope-eligible facts silently
      // assumed a ranker that drops nothing for any other reason, which is true of `rankFacts` and
      // false of the real `retrieve()`: it excludes superseded facts unconditionally (P4 -- and the
      // fixture builds contradiction pairs precisely so `resolveContradictions` supersedes some),
      // and applies `restrictToRoot` binding rules richer than `scopeRoot === root`. Both are
      // correct, neither is the query, and charging them to the query reported a working pipeline
      // as a filtering violation. Comparing a config against itself isolates the one variable the
      // invariant is actually about, and needs no reimplementation of what `retrieve()` does.
      const { poolSize: unqueriedPoolSize } = await rankScenario(facts, { ...scenario, query: "" }, config);
      if (poolSize !== unqueriedPoolSize) {
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
