/**
 * `npm run eval` -- prints before/after retrieval-quality numbers for the three configurations
 * item 1 and item 2 exist to move between: today's recency-only baseline, query-on
 * (BM25 without stemming), and query+stemming (today's shipped state).
 *
 * Deliberately not part of `npm test`: this generates a 400-fact corpus and 40+ scenarios and
 * ranks all of them three times over, which is unnecessary weight for the correctness gate every
 * commit runs. `tests/unit/eval-harness.test.ts` covers the harness's own correctness (precision/
 * nDCG math, duplicate counting, the no-match-never-filters invariant) on a small fixed input,
 * fast enough to run in the normal suite.
 */

import { generateCorpus } from "./fixtures.js";
import { generateScenarios } from "./queries.js";
import { evaluateConfig, type ConfigReport } from "./harness.js";
import type { RankConfig } from "./rank.js";

const K = 8;

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
    `${report.wallTimeMs.toFixed(2)}ms`.padStart(10),
  ].join("  ");
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function main(): void {
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
    ["config".padEnd(15), "p@k".padStart(8), "ndcg@k".padStart(8), "judged".padStart(8), "dup-pairs".padStart(11), "tokens".padStart(9), "no-filter".padStart(9), "time".padStart(10)].join(
      "  "
    )
  );

  const configs: readonly RankConfig[] = ["recency", "query-no-stem", "query-stem"];
  for (const config of configs) {
    print(formatRow(evaluateConfig(facts, scenarios, config, K)));
  }
}

main();
