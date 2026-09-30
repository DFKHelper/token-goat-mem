/**
 * Which live facts share the most entities and topics with a given fact -- the one similarity
 * lookup behind `mem show --related`, `mem review`'s "may contradict" line, and the related facts
 * `mem reflect` lists beside each pending suggestion, so all three agree on what counts as related.
 */

import type Database from "better-sqlite3";

import { isBoundToRoot } from "./projectIdentity.js";
import { getFactById, getSharedTermCounts } from "./storage.js";
import type { Fact } from "./types.js";

/**
 * `mem show --related`'s entity/topic weighting. An entity is a precise, verbatim identifier -- a
 * file path, a CLI flag, a version, a constant -- while a topic is a fuzzy stemmed content word, so
 * two facts sharing one entity are more related than two sharing one topic. 3 was picked so a single
 * shared entity outranks up to two shared topics, while a fact sharing three or more topics can still
 * out-rank a single shared entity -- topics keep some pull rather than being drowned out entirely.
 */
const RELATED_ENTITY_WEIGHT = 3;

/** Cap on how many related facts `mem show --related` returns -- an inspection aid for a human already looking at one fact, not a graph traversal. */
const MAX_RELATED_FACTS = 5;

export interface RelatedFact {
  readonly fact: Fact;
  readonly score: number;
}

/**
 * The facts sharing the most normalized term keys with `fact`, ranked by {@link RELATED_ENTITY_WEIGHT}-weighted
 * shared-term score, `fact` itself excluded.
 *
 * Status and scope containment mirror `retrieve()`'s own correctness gate rather than inventing a
 * second rule for this one command: `superseded` is dropped (that edge is already surfaced
 * separately as `supersededBy`), and `isBoundToRoot` -- the same predicate `retrieve()` filters
 * on -- keeps a project-scoped fact's neighbours from leaking across another project's `scope_root`.
 * Pending/contested facts are not dropped, only labelled (see {@link relatedTrustCaveat}): this is an
 * inspection surface, not the ground-truth channel `mem recall` gates hard.
 */
export function findRelatedFacts(db: Database.Database, fact: Fact, root: string): RelatedFact[] {
  const counts = getSharedTermCounts(db, fact.id);
  const related: RelatedFact[] = [];
  for (const [factId, count] of counts) {
    const candidate = getFactById(db, factId);
    if (candidate === undefined || candidate.status === "superseded") {
      continue;
    }
    if (!isBoundToRoot(candidate, root)) {
      continue;
    }
    related.push({ fact: candidate, score: count.entity * RELATED_ENTITY_WEIGHT + count.topic });
  }
  related.sort((a, b) => b.score - a.score || b.fact.captured_at.localeCompare(a.fact.captured_at));
  return related.slice(0, MAX_RELATED_FACTS);
}
