/**
 * The co-occurrence fact graph and score propagation over it (design plan Section 3 extension,
 * "Retrieval" layer).
 *
 * `fact_terms` (fact_id, term_key, kind) is a bipartite fact<->term table -- two facts are graph
 * neighbours exactly when they share a `term_key`. The table carries no weight column, so an
 * unweighted walk over it floods through any term common enough to link hundreds of facts (a
 * language name, a common tool): every score here is damped by how many facts carry the term
 * (inverse document frequency), and a term covering more than `DF_CEILING_RATIO` of the store is
 * dropped outright -- that common, it carries no discriminating information at any weight.
 *
 * Caller-side, like consolidate.ts: this module may import storage.ts and opens no connection of
 * its own. retrieval.ts must not import this module or storage.ts -- the caller computes the
 * signal here and hands `retrieve()` plain data, never a db handle (see ARCHITECTURE.md).
 */

import { countFacts, getEntityOverlapForQuery, listTermsForFact } from "./storage.js";

/** Connection type, borrowed the way `src/consolidate.ts` borrows it, so this module adds no dependency of its own. */
type Db = Parameters<typeof listTermsForFact>[0];

/** Terms on more than this fraction of the store carry no discriminating signal and are dropped before propagation touches them. */
const DEFAULT_DF_CEILING_RATIO = 0.6;
/** "Stripped" PPR: a fixed hop count, not a convergence loop -- bounds every call to a known number of grouped queries. */
const DEFAULT_HOPS = 2;
/** Standard PPR damping: at each hop, this share of a fact's score moves to neighbours and the rest re-anchors to the original seed. */
const DEFAULT_DAMPING = 0.85;
/** Caps how many facts one hop expands from, so a pathologically connected store cannot blow up query or result size. */
const DEFAULT_MAX_FRONTIER = 200;

export interface FactGraphOptions {
  /** Terms covering more than this fraction of the store are excluded outright. Default {@link DEFAULT_DF_CEILING_RATIO}. */
  readonly dfCeilingRatio?: number;
  /** Caps the number of facts one hop expands from. Default {@link DEFAULT_MAX_FRONTIER}. */
  readonly maxFrontier?: number;
}

export interface PropagateOptions extends FactGraphOptions {
  /** Number of propagation hops. Default {@link DEFAULT_HOPS}. */
  readonly hops?: number;
  /** Share of a fact's score that moves to neighbours per hop, in `[0, 1]`. Default {@link DEFAULT_DAMPING}. */
  readonly damping?: number;
}

interface FactGraphEdges {
  readonly edgesByFact: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly neighborIds: ReadonlySet<string>;
}

/** Smoothed IDF: 0 at `df === totalFacts` (a term on every fact says nothing), rising as a term gets rarer. */
function termWeight(df: number, totalFacts: number): number {
  return Math.log((totalFacts + 1) / (df + 1));
}

/**
 * Builds weighted co-occurrence edges from every fact in `factIds` outward, in three grouped
 * queries regardless of how many facts or terms are involved: the terms `factIds` carry, the
 * store-wide document frequency of just those terms, and the facts that carry the surviving ones.
 * Never one query per fact or per term -- that per-fact-in-a-loop shape is exactly what
 * integration-seam.ts's ~150ms budget cannot afford.
 */
function buildEdges(db: Db, factIds: readonly string[], totalFacts: number, dfCeilingRatio: number): FactGraphEdges {
  const edgesByFact = new Map<string, Map<string, number>>();
  const neighborIds = new Set<string>();
  if (factIds.length === 0 || totalFacts === 0) {
    return { edgesByFact, neighborIds };
  }

  const factPlaceholders = factIds.map(() => "?").join(", ");
  const termRows = db
    .prepare<unknown[], { fact_id: string; term_key: string }>(
      `SELECT DISTINCT fact_id, term_key FROM fact_terms WHERE fact_id IN (${factPlaceholders})`
    )
    .all(...factIds);
  if (termRows.length === 0) {
    return { edgesByFact, neighborIds };
  }

  const termsByFact = new Map<string, Set<string>>();
  const termKeys = new Set<string>();
  for (const row of termRows) {
    termKeys.add(row.term_key);
    let terms = termsByFact.get(row.fact_id);
    if (terms === undefined) {
      terms = new Set();
      termsByFact.set(row.fact_id, terms);
    }
    terms.add(row.term_key);
  }

  const termList = [...termKeys];
  const termPlaceholders = termList.map(() => "?").join(", ");
  const dfRows = db
    .prepare<unknown[], { term_key: string; df: number }>(
      `SELECT term_key, COUNT(DISTINCT fact_id) AS df FROM fact_terms WHERE term_key IN (${termPlaceholders}) GROUP BY term_key`
    )
    .all(...termList);

  const ceiling = totalFacts * dfCeilingRatio;
  const weightByTerm = new Map<string, number>();
  const survivingTerms: string[] = [];
  for (const row of dfRows) {
    if (row.df > ceiling) {
      continue; // hub term: covers more of the store than the ceiling allows -- no weight at all
    }
    weightByTerm.set(row.term_key, termWeight(row.df, totalFacts));
    survivingTerms.push(row.term_key);
  }
  if (survivingTerms.length === 0) {
    return { edgesByFact, neighborIds };
  }

  const survivingPlaceholders = survivingTerms.map(() => "?").join(", ");
  const memberRows = db
    .prepare<unknown[], { fact_id: string; term_key: string }>(
      `SELECT DISTINCT fact_id, term_key FROM fact_terms WHERE term_key IN (${survivingPlaceholders})`
    )
    .all(...survivingTerms);

  const membersByTerm = new Map<string, string[]>();
  for (const row of memberRows) {
    let members = membersByTerm.get(row.term_key);
    if (members === undefined) {
      members = [];
      membersByTerm.set(row.term_key, members);
    }
    members.push(row.fact_id);
  }

  for (const factId of factIds) {
    const terms = termsByFact.get(factId);
    if (terms === undefined) {
      continue;
    }
    for (const term of terms) {
      const weight = weightByTerm.get(term);
      if (weight === undefined) {
        continue; // excluded by the df ceiling above
      }
      for (const neighborId of membersByTerm.get(term) ?? []) {
        if (neighborId === factId) {
          continue;
        }
        let edges = edgesByFact.get(factId);
        if (edges === undefined) {
          edges = new Map();
          edgesByFact.set(factId, edges);
        }
        edges.set(neighborId, (edges.get(neighborId) ?? 0) + weight);
        neighborIds.add(neighborId);
      }
    }
  }

  return { edgesByFact, neighborIds };
}

/**
 * Facts sharing a term with `factId`, weighted by how discriminating the shared term is -- an edge
 * weight is the sum of {@link termWeight} across every term the two facts have in common, so a
 * neighbour tied by one rare term can outrank one tied by several common ones.
 */
export function neighbours(db: Db, factId: string, opts: FactGraphOptions = {}): Map<string, number> {
  const dfCeilingRatio = opts.dfCeilingRatio ?? DEFAULT_DF_CEILING_RATIO;
  const totalFacts = countFacts(db);
  const { edgesByFact } = buildEdges(db, [factId], totalFacts, dfCeilingRatio);
  return new Map(edgesByFact.get(factId) ?? []);
}

/**
 * Stripped personalized PageRank: the truncated-to-`hops` series `(1 - damping) * sum_k damping^k *
 * M^k * seeds`, where `M` is the row-normalized (edge weight / a fact's total outgoing weight)
 * walk over {@link buildEdges}'s graph. Each hop's mass is recorded into the result at that hop's
 * `damping^k` weight before walking one more step outward -- not overwritten by the next hop -- so
 * a fact reached only at hop 1 keeps its score instead of being displaced by hop 2's redistribution.
 *
 * "Stripped" specifically means no convergence loop: `hops` bounds the `for` loop directly, so this
 * terminates on any input -- cyclic or not -- in at most `hops` rounds of {@link buildEdges}'s three
 * grouped queries, the shape integration-seam.ts's ~150ms budget requires.
 */
export function propagate(db: Db, seeds: ReadonlyMap<string, number>, opts: PropagateOptions = {}): Map<string, number> {
  if (seeds.size === 0) {
    return new Map();
  }
  const hops = opts.hops ?? DEFAULT_HOPS;
  const damping = opts.damping ?? DEFAULT_DAMPING;
  const maxFrontier = opts.maxFrontier ?? DEFAULT_MAX_FRONTIER;
  const dfCeilingRatio = opts.dfCeilingRatio ?? DEFAULT_DF_CEILING_RATIO;
  const totalFacts = countFacts(db);

  const result = new Map<string, number>();
  let massAtHop = new Map(seeds);

  for (let hop = 0; hop < hops; hop++) {
    const restartWeight = (1 - damping) * damping ** hop;
    for (const [id, mass] of massAtHop) {
      result.set(id, (result.get(id) ?? 0) + restartWeight * mass);
    }

    if (hop === hops - 1) {
      break; // no more hops left to walk outward for
    }

    const frontier = [...massAtHop.entries()].filter(([, mass]) => mass > 0).map(([id]) => id).slice(0, maxFrontier);
    if (frontier.length === 0) {
      break;
    }
    const { edgesByFact } = buildEdges(db, frontier, totalFacts, dfCeilingRatio);

    const next = new Map<string, number>();
    for (const factId of frontier) {
      const current = massAtHop.get(factId) ?? 0;
      const edges = edgesByFact.get(factId);
      if (edges === undefined || edges.size === 0) {
        continue;
      }
      let outWeight = 0;
      for (const weight of edges.values()) {
        outWeight += weight;
      }
      if (outWeight === 0) {
        continue;
      }
      for (const [neighborId, weight] of edges) {
        next.set(neighborId, (next.get(neighborId) ?? 0) + current * (weight / outWeight));
      }
    }
    massAtHop = next;
  }

  return result;
}

/**
 * Sibling to `storage.getEntityOverlapForQuery`, same shape and same vocabulary discipline: seeds
 * are the facts the query names by entity, and {@link propagate} walks outward from there.
 *
 * Where `getEntityOverlapForQuery` answers "does the query name this fact", this answers "is this
 * fact strongly connected to what the query names, even though the query never says so" -- a fact
 * reached only through a shared term, not through the identifier itself, surfaces here and nowhere
 * else. A vote, never an override, for the same reason `entityOverlap` is: fused as one more RRF
 * rank list, it cannot displace a fact that actually matches the rest of the query.
 *
 * Empty whenever the query names no entity: no seed, no graph work, matching
 * `getEntityOverlapForQuery`'s own empty-query short-circuit -- the common case costs nothing.
 *
 * `seeds` lets a caller that already paid for `getEntityOverlapForQuery(db, query)` -- both current
 * callers do, immediately before this call, to decide whether it is even worth calling -- hand the
 * result straight to `propagate` instead of this function recomputing an identical map on the same
 * hint-path budget. Omit it and this still works standalone, recomputing exactly as before; passing
 * a looser, hand-rolled map here would match rows the write path never creates, so the only intended
 * source is `getEntityOverlapForQuery` itself.
 */
export function getGraphScoresForQuery(
  db: Db,
  query: string,
  opts: PropagateOptions = {},
  seeds: ReadonlyMap<string, number> = getEntityOverlapForQuery(db, query)
): Map<string, number> {
  if (seeds.size === 0) {
    return new Map();
  }
  return propagate(db, seeds, opts);
}
