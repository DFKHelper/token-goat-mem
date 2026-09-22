/**
 * `npm run eval` -- prints before/after retrieval-quality numbers for four configurations. Items 1
 * and 2 are what `"recency"`, `"query-no-stem"`, and `"query-stem"` exist to move between: today's
 * recency-only baseline, query-on (BM25 without stemming), and query+stemming (today's shipped
 * BM25 state) -- all three measured by `rank.ts`'s reduced reimplementation of `retrieve()`'s
 * ranking step. `"pipeline"` (item 4) instead drives the real `retrieve()` end to end -- RRF
 * fusion, entity overlap, graph propagation, anchor re-evaluation, contradiction resolution, and
 * trust classification all run for real, against a real (temp) filesystem and SQLite store built
 * and torn down for this run only (see `eval/pipelineFixture.ts`).
 *
 * Deliberately not part of `npm test`: this generates a 400-fact corpus and 40+ scenarios and
 * ranks all of them four times over -- the `"pipeline"` pass alone does real anchor filesystem I/O
 * and a real SQLite round trip per scenario -- which is unnecessary weight for the correctness
 * gate every commit runs. `tests/unit/eval-harness.test.ts` covers the harness's own correctness
 * (precision/nDCG math, duplicate counting, the no-match-never-filters invariant) on a small fixed
 * input, fast enough to run in the normal suite, and never exercises `"pipeline"`.
 */

import { join } from "node:path";

import { generateCorpus } from "./fixtures.js";
import { generateScenarios } from "./queries.js";
import { evaluateConfig, type ConfigReport } from "./harness.js";
import { buildFsFixture, buildPipelineContext } from "./pipelineFixture.js";
import type { RankConfig } from "./rank.js";

const K = 8;

/**
 * Fixed clock for the `"pipeline"` configuration's decay/freshness math, alongside `EVAL_SEED`
 * (`fixtures.ts`) as the other source of this run's determinism. Set after the corpus's newest
 * `captured_at` (`generateCorpus`'s dates run up to 2032-08-26 for the default seed/count) so no
 * fact is ever "captured in the future" relative to it.
 */
const PIPELINE_NOW = new Date("2033-01-01T00:00:00.000Z");

function formatRow(report: ConfigReport): string {
  const pct = (n: number): string => (Number.isNaN(n) ? "n/a" : `${(n * 100).toFixed(1)}%`);
  return [
    report.config.padEnd(15),
    pct(report.meanPrecisionAtK).padStart(8),
    pct(report.meanNdcgAtK).padStart(8),
    String(report.judgedScenarioCount).padStart(8),
    String(report.totalDuplicateSubjectPairs).padStart(11),
    String(report.totalTokensEmitted).padStart(9),
    (report.noMatchNeverFiltered ? "yes" : "NO").padStart(9),
    pct(report.anchorAffirmedRate).padStart(10),
    `${report.wallTimeMs.toFixed(2)}ms`.padStart(10),
  ].join("  ");
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const facts = generateCorpus();
  const scenarios = generateScenarios(facts);

  const families = new Map<string, number>();
  for (const scenario of scenarios) {
    families.set(scenario.family, (families.get(scenario.family) ?? 0) + 1);
  }

  print(`corpus: ${facts.length} facts across ${new Set(facts.map((f) => f.scopeRoot ?? "global")).size} scope roots`);
  print(`scenarios: ${scenarios.length} (${[...families.entries()].map(([family, n]) => `${family}=${n}`).join(", ")})`);
  print(`k = ${K}\n`);

  print(
    ["config".padEnd(15), "p@k".padStart(8), "ndcg@k".padStart(8), "judged".padStart(8), "dup-pairs".padStart(11), "tokens".padStart(9), "no-filter".padStart(9), "anchor-ok".padStart(10), "time".padStart(10)].join(
      "  "
    )
  );

  const baselineConfigs: readonly RankConfig[] = ["recency", "query-no-stem", "query-stem"];
  for (const config of baselineConfigs) {
    print(formatRow(await evaluateConfig(facts, scenarios, config, K)));
  }

  // The real pipeline needs a resolvable filesystem (anchors) and a real SQLite store (entity/graph
  // signals) -- both built fresh for this run and torn down in `finally`, whatever the outcome.
  const fsFixture = buildFsFixture();
  try {
    const pipelineContext = buildPipelineContext(join(fsFixture.baseDir, "eval.db"), facts, fsFixture.rootMap, PIPELINE_NOW);
    try {
      print(formatRow(await evaluateConfig(facts, scenarios, "pipeline", K, pipelineContext.rankScenario)));
    } finally {
      pipelineContext.cleanup();
    }
  } finally {
    fsFixture.cleanup();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`eval: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
