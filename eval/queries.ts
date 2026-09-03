/**
 * Deterministic scenario-query generation for the eval harness (item 3).
 *
 * Each scenario is a (query, root) pair plus a labelled "relevant" set of fact ids -- the facts a
 * good ranker should surface for that query in that project's scope. Three scenario families:
 *
 *   - "exact" -- the query is a value already present verbatim in the corpus (e.g. "pnpm"); the
 *     relevant set is every scope-eligible fact sharing that subject+value, which also exercises
 *     duplicate detection (an exact duplicate shares subject+value+scope+root by construction).
 *   - "stem" -- hand-picked, verified word pairs (see the module-level comment on which inflected
 *     forms Porter's algorithm actually collapses together -- not every inflection does) where the
 *     query is an inflected form that does not appear verbatim in any fact's text, but stems to the
 *     same root as a word that does. This is the scenario family item 2 exists to move the needle
 *     on; relevant is every scope-eligible fact of that subject template, regardless of value,
 *     since the shared word lives in the sentence template rather than the value.
 *   - "no-match" -- a query sharing no term (stemmed or not) with any fact's text. There is no
 *     "relevant" set to score precision/nDCG against; these exist to assert the harness's own
 *     invariant (a query ranks, it does not filter) rather than to measure ranking quality.
 */

import { mulberry32, pickN } from "./prng.js";
import { EVAL_SEED, type EvalFact } from "./fixtures.js";

export interface Scenario {
  readonly id: string;
  readonly family: "exact" | "stem" | "no-match";
  readonly description: string;
  readonly query: string;
  readonly root: string;
  /** `undefined` for the "no-match" family, which has no relevance judgment. */
  readonly relevantIds?: ReadonlySet<string>;
}

function relevantIdsForValue(facts: readonly EvalFact[], subject: string, value: string, root: string): Set<string> {
  return new Set(
    facts.filter((f) => f.subject === subject && f.value === value && (f.scope === "global" || f.scopeRoot === root)).map((f) => f.id)
  );
}

function relevantIdsForSubject(facts: readonly EvalFact[], subject: string, root: string): Set<string> {
  return new Set(facts.filter((f) => f.subject === subject && (f.scope === "global" || f.scopeRoot === root)).map((f) => f.id));
}

/**
 * Verified against `_stemForTests` during development (see the phase-1 report): each pair's query
 * word and the template's own vocabulary reduce to the same Porter stem, but the query word never
 * appears verbatim in any generated fact's text -- so a pre-stemming BM25 scores every candidate 0
 * (a genuine no-match), while a stemming-aware BM25 correctly ranks the subject's facts above the
 * rest of the corpus. Not every inflection stems together (e.g. "runner"/"running" do not, nor do
 * "architect"/"architecture") -- these are the pairs that were checked and do.
 */
const STEM_SCENARIOS: ReadonlyArray<{ query: string; subject: string }> = [
  { query: "run", subject: "test_runner" },
  { query: "runs", subject: "test_runner" },
  { query: "deploy", subject: "deploy_cadence" },
  { query: "deploying", subject: "deploy_cadence" },
  { query: "formatting", subject: "formatter" },
  { query: "linting", subject: "linter" },
  { query: "reviewing", subject: "code_review" },
  { query: "committing", subject: "commit_convention" },
  { query: "architectural", subject: "architecture" },
  { query: "branching", subject: "branch_strategy" },
];

const NO_MATCH_QUERIES = ["xyzzyplughquux", "zzzznonexistent", "frobnicate the wibbleflorp", "qqjjkkvvxxzz"] as const;

export function generateScenarios(facts: readonly EvalFact[], seed: number = EVAL_SEED + 1): readonly Scenario[] {
  const rng = mulberry32(seed);
  let counter = 0;

  // Every distinct (subject, value, root) combo actually present as a project/path-scoped fact --
  // duplicates collapse into the same combo by construction, so relevance already includes them.
  const combos = new Map<string, { subject: string; value: string; root: string }>();
  for (const fact of facts) {
    if ((fact.scope === "project" || fact.scope === "path") && fact.scopeRoot !== null && fact.scopeRoot !== undefined && fact.subject !== null && fact.value !== null) {
      const key = `${fact.subject}::${fact.value}::${fact.scopeRoot}`;
      combos.set(key, { subject: fact.subject, value: fact.value, root: fact.scopeRoot });
    }
  }

  const scenarios: Scenario[] = [];

  for (const combo of pickN(rng, [...combos.values()], Math.min(28, combos.size))) {
    scenarios.push({
      id: `exact-${counter++}`,
      family: "exact",
      description: `exact match: "${combo.value}" (${combo.subject}) in ${combo.root}`,
      query: combo.value,
      root: combo.root,
      relevantIds: relevantIdsForValue(facts, combo.subject, combo.value, combo.root),
    });
  }

  const roots = [...new Set([...combos.values()].map((c) => c.root))];
  for (const stemCase of STEM_SCENARIOS) {
    const root = roots[counter % Math.max(roots.length, 1)] ?? roots[0];
    if (root === undefined) {
      continue;
    }
    scenarios.push({
      id: `stem-${counter++}`,
      family: "stem",
      description: `stemmed query "${stemCase.query}" -> subject ${stemCase.subject} in ${root}`,
      query: stemCase.query,
      root,
      relevantIds: relevantIdsForSubject(facts, stemCase.subject, root),
    });
  }

  const noMatchRoot = roots[0];
  if (noMatchRoot !== undefined) {
    for (const query of NO_MATCH_QUERIES) {
      scenarios.push({
        id: `nomatch-${counter++}`,
        family: "no-match",
        description: `no-match query "${query}" in ${noMatchRoot}`,
        query,
        root: noMatchRoot,
      });
    }
  }

  return scenarios;
}
