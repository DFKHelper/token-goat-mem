/**
 * The ranking stage under test, isolated from the rest of `retrieve()`'s correctness gate.
 *
 * Phase 1 (this eval harness's reason for existing) touched exactly two things: whether
 * `--hint-format` threads a real query into BM25 at all (item 1), and whether BM25 stems its
 * tokens (item 2). It did not touch anchor re-evaluation, contradiction resolution, or trust
 * classification -- those are unaffected by either change, so re-running the full `retrieve()`
 * pipeline (which needs a real filesystem for anchors) would add noise and machinery to this
 * harness without adding signal about what changed. This module reimplements only the ranking
 * step -- scope filtering, BM25 scoring, the kind boost, and top-k selection -- so all three
 * configurations below are measured on an equal footing.
 *
 * The BM25 formula and constants (`K1`, `B`) and the kind boost mirror `src/retrieval.ts`'s
 * `computeBm25Scores`/`applyKindBoost` exactly (same math, same constants); "stemmed" scoring
 * reuses the *real*, exported `computeBm25Scores` from `src/retrieval.ts` directly (so item 2's
 * actual shipped stemmer is what gets measured, not a reimplementation of it). "Unstemmed" scoring
 * is a small local reimplementation of the pre-item-2 tokenizer, kept only because production code
 * no longer has an unstemmed code path to compare against.
 */

import { AGGRESSIVE_RECALL_BOOST, computeBm25Scores } from "../src/retrieval.js";
import type { EvalFact } from "./fixtures.js";

const K1 = 1.5;
const B = 0.75;

function unstemmedTokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/u).filter((t) => t.length > 0);
}

/** Pre-item-2 BM25: identical formula to `src/retrieval.ts`'s `computeBm25Scores`, but without stemming. Kept here only for comparison -- production code has no unstemmed path left to call. */
function unstemmedBm25(docs: readonly EvalFact[], query: string): Map<string, number> {
  const scores = new Map<string, number>();
  const queryTerms = [...new Set(unstemmedTokenize(query))];
  if (docs.length === 0 || queryTerms.length === 0) {
    for (const doc of docs) {
      scores.set(doc.id, 0);
    }
    return scores;
  }

  const docTokens = new Map<string, string[]>();
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const doc of docs) {
    const tokens = unstemmedTokenize(`${doc.text} ${doc.subject ?? ""} ${doc.value ?? ""}`);
    docTokens.set(doc.id, tokens);
    totalLength += tokens.length;
    for (const term of new Set(tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const n = docs.length;
  const avgDocLength = totalLength / n || 1;

  for (const doc of docs) {
    const tokens = docTokens.get(doc.id) ?? [];
    const termFrequency = new Map<string, number>();
    for (const token of tokens) {
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
    }
    const docLength = tokens.length;
    let score = 0;
    for (const term of queryTerms) {
      const tf = termFrequency.get(term);
      if (tf === undefined) {
        continue;
      }
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const denom = tf + K1 * (1 - B + B * (docLength / avgDocLength));
      score += idf * ((tf * (K1 + 1)) / denom);
    }
    scores.set(doc.id, score);
  }
  return scores;
}

function kindBoost(fact: EvalFact, score: number): number {
  return fact.kind === "preference" || fact.kind === "correction" ? score * AGGRESSIVE_RECALL_BOOST : score;
}

/** Mirrors `isInScope`/`matchesFilters`'s scope-binding rule closely enough for eval purposes: global always matches; project/path match only the given root. */
function isInScope(fact: EvalFact, root: string): boolean {
  if (fact.scope === "global") {
    return true;
  }
  return fact.scopeRoot === root;
}

export type RankConfig = "recency" | "query-no-stem" | "query-stem";

export interface RankedResult {
  readonly fact: EvalFact;
  readonly score: number;
}

/**
 * Ranks `facts` for one scenario (`query` against project `root`) under the given configuration:
 *   - `"recency"`: today's original `--hint-format` behaviour -- the query is ignored entirely
 *     (mirrors the hardcoded `query: ""` this phase removed), so ranking falls through to
 *     `captured_at` descending.
 *   - `"query-no-stem"`: the query is honored (item 1) but BM25 has no stemmer (pre-item-2).
 *   - `"query-stem"`: the query is honored and BM25 stems (item 1 + item 2, today's shipped state).
 */
export function rankFacts(facts: readonly EvalFact[], query: string, root: string, config: RankConfig): RankedResult[] {
  const scoped = facts.filter((fact) => isInScope(fact, root));
  const effectiveQuery = config === "recency" ? "" : query;
  const scores = config === "query-stem" ? computeBm25Scores(scoped, effectiveQuery) : unstemmedBm25(scoped, effectiveQuery);

  const ranked = scoped.map((fact) => ({ fact, score: kindBoost(fact, scores.get(fact.id) ?? 0) }));
  ranked.sort((a, b) => {
    const delta = b.score - a.score;
    return delta !== 0 ? delta : b.fact.captured_at.localeCompare(a.fact.captured_at);
  });
  return ranked;
}
