/**
 * Retrieval-quality metrics for the eval harness (item 3). Binary relevance throughout -- a fact
 * id is either in a scenario's labelled `relevantIds` set or it isn't; there is no partial-credit
 * grading in this fixture corpus.
 */

import type { EvalFact } from "./fixtures.js";

/** Fraction of the top `k` results that are labelled relevant. `NaN` if `relevant` is empty (no judgment to score against -- callers should skip precision/nDCG for "no-match" scenarios). */
export function precisionAtK(rankedIds: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) {
    return NaN;
  }
  const topK = rankedIds.slice(0, k);
  const hits = topK.filter((id) => relevant.has(id)).length;
  return hits / k;
}

/** Normalized Discounted Cumulative Gain at `k`, binary relevance. `NaN` if `relevant` is empty. */
export function ndcgAtK(rankedIds: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) {
    return NaN;
  }
  const topK = rankedIds.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const id = topK[i];
    if (id !== undefined && relevant.has(id)) {
      dcg += 1 / Math.log2(i + 2);
    }
  }
  const idealHits = Math.min(relevant.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

/** Number of pairs within the top `k` results that share the same non-null `subject` -- a proxy for redundant/duplicate-ish output a consumer would see repeated. */
export function duplicateSubjectPairs(rankedFacts: readonly EvalFact[], k: number): number {
  const topK = rankedFacts.slice(0, k);
  let pairs = 0;
  for (let i = 0; i < topK.length; i++) {
    for (let j = i + 1; j < topK.length; j++) {
      const a = topK[i];
      const b = topK[j];
      if (a?.subject !== null && a?.subject !== undefined && a.subject === b?.subject) {
        pairs++;
      }
    }
  }
  return pairs;
}

/**
 * Approximate token count for the top `k` results' fact text, using the common ~4-characters-per-
 * token heuristic for English prose. This is an approximation, not a real tokenizer count -- good
 * enough to compare *relative* token cost across configurations (does stemming/query-honoring
 * change how much gets emitted), not to predict an exact provider token bill.
 */
export function approximateTokens(rankedFacts: readonly EvalFact[], k: number): number {
  const topK = rankedFacts.slice(0, k);
  return topK.reduce((sum, fact) => sum + Math.ceil(fact.text.length / 4), 0);
}
