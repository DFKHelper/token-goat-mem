/**
 * Near-duplicate clustering and stale-fact detection -- the two halves of `mem consolidate`.
 *
 * Both answer the same shape of question ("which live facts are no longer pulling their weight?"),
 * both are pure analysis here (nothing in this module writes), and both hand the CLI a plan it can
 * either print or apply through `setStatusWithAudit`. Keeping them in one module is what lets the
 * duplicate pass and the stale pass share one comparability rule, one preference order, and one
 * "never touch a pinned fact" invariant instead of drifting into two.
 *
 * **Deterministic, offline, dependency-free.** No model call, no network, no embedding: the
 * similarity signal is the `fact_terms` topic layer `src/facets.ts` already extracts on every
 * capture and edit. Mem's read path staying free of a model is the product's core claim, and
 * "which of my facts are duplicates" is not an exception to it.
 *
 * **Not a retrieval path.** Nothing here calls `retrieve()`, and nothing here feeds it. That is
 * deliberate: `retrieve()` resolves contradictions across its *whole* input pool before its filters
 * run, and `resolveContradictions`' reinstatement pass reads the absence of a rival as "nothing
 * contests this fact" -- so handing it a pre-filtered pool can surface a genuinely contested fact
 * as clean ground truth (see `RetrievalOptions.entities`). This module reads `facts` directly and
 * reports; it never narrows a pool on retrieval's behalf.
 */

import { listFacts, listStaleUnsurfacedFacts, listTermsForFact } from "./storage.js";
import type { Fact } from "./types.js";

/** Connection type, borrowed the way `src/storage.ts` borrows it, so this module adds no dependency of its own. */
type Db = Parameters<typeof listTermsForFact>[0];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Default Jaccard floor for calling two facts duplicates: they must share at least half of their
 * combined topic vocabulary.
 *
 * Jaccard over topic sets is **scale-free** -- it is the size of the intersection over the size of
 * the union, a property of two facts and nothing else. That is the whole reason it is the signal
 * here rather than a BM25 score: BM25's IDF term is a function of the corpus, so any absolute
 * cutoff on it would silently drift as the store grows and the same pair of facts would score
 * differently next month. A Jaccard threshold means the same thing on day one and on fact ten
 * thousand, so it can be a documented constant.
 *
 * 0.5 rather than something looser because the `--apply` path supersedes facts. Measured against
 * this repo's own tokenizer, "package manager is pnpm" and "the package manager for this repo is
 * pnpm" score 0.75 -- restatements, which is the population this command exists to collapse --
 * while "we use pnpm" against "package manager is pnpm" scores 0.25, and "pnpm not npm" against
 * "always run npm run lint before pushing" scores 0.14. Everything in that lower band merely
 * *discusses the same subject*; collapsing it would lose knowledge. A store that wants the looser
 * reading can ask for it with `--threshold`, having been shown the clusters first.
 */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.5;

/**
 * Default age floor for `--stale`, in days. Matches the retention pass's own
 * `GC_SUPERSEDED_MAX_AGE_DAYS`, so mem has one answer to "how old is old" rather than two, and sits
 * comfortably past the 30-day `recall_log` rotation window, so a candidate's surfacing history is
 * judged on the durable `facts.last_surfaced_at` mark rather than on rows that may have rotated
 * away.
 */
export const DEFAULT_STALE_AGE_DAYS = 90;

/** One member of a duplicate cluster, other than the survivor. */
export interface DuplicateMember {
  readonly fact: Fact;
  /** Jaccard similarity to the cluster's `keep`, in [0, 1]. Always at least the threshold the cluster was built at. */
  readonly similarity: number;
}

/** One group of facts that restate each other, with the survivor already chosen. */
export interface DuplicateCluster {
  /** The fact to keep: pinned first, then most confident, then newest, then lowest id. */
  readonly keep: Fact;
  /** The rest of the cluster. Never contains a pinned fact. */
  readonly duplicates: readonly DuplicateMember[];
  /**
   * Cluster members left alone because they are pinned. A pin is a standing instruction that a
   * fact matters, so `--apply` reports these rather than superseding them -- but omitting them
   * would make the cluster listing lie about its own size.
   */
  readonly retainedPinned: readonly Fact[];
}

/**
 * Jaccard similarity of two term sets. Two empty sets score 0, not 1 -- a fact whose text yields no
 * topics (a bare identifier, a single stopword) carries no evidence of similarity to anything, and
 * 1 would make every such fact a duplicate of every other.
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const term of a) {
    if (b.has(term)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}

/**
 * Which facts may be compared at all. Same kind (a preference and a decision that share vocabulary
 * are two different claims, not one restated) and same scope binding (a global fact and a
 * project-scoped one surface in different places, so neither is redundant given the other).
 */
function comparabilityKey(fact: Fact): string {
  return [fact.kind, fact.scope, fact.scopeRoot ?? ""].join(" ");
}

/**
 * The order a cluster's survivor is chosen in, best first: pinned beats unpinned, then higher
 * confidence, then newer capture, then lower id as the tiebreak that makes the whole pass
 * reproducible on a store with two facts written in the same millisecond.
 */
function preferenceOrder(a: Fact, b: Fact): number {
  const pinned = Number(b.status === "pinned") - Number(a.status === "pinned");
  if (pinned !== 0) {
    return pinned;
  }
  if (a.confidence !== b.confidence) {
    return b.confidence - a.confidence;
  }
  const captured = b.captured_at.localeCompare(a.captured_at);
  return captured !== 0 ? captured : a.id.localeCompare(b.id);
}

function topicKeys(db: Db, factId: string): Set<string> {
  return new Set(
    listTermsForFact(db, factId)
      .filter((term) => term.kind === "topic")
      .map((term) => term.termKey)
  );
}

/**
 * Groups the store's live facts (`active` and `pinned`) into near-duplicate clusters at
 * `threshold`.
 *
 * Seeded, not agglomerative: facts are walked in `preferenceOrder`, each unassigned fact opens a
 * cluster, and every later unassigned comparable fact joins it if it clears the threshold *against
 * that seed*. Single-link agglomeration would chain -- A near B, B near C, A nothing like C, all
 * one cluster -- and the reported "similarity to keep" would then be a number below the threshold
 * the user asked for. Seeding costs nothing here and makes every printed similarity mean exactly
 * what it says.
 *
 * A cluster whose only other members are pinned is dropped: there is nothing to propose.
 */
export function findDuplicateClusters(db: Db, threshold: number): DuplicateCluster[] {
  const facts = [...listFacts(db, { status: ["active", "pinned"] })].sort(preferenceOrder);
  const terms = new Map<string, Set<string>>(facts.map((fact) => [fact.id, topicKeys(db, fact.id)]));
  const assigned = new Set<string>();
  const clusters: DuplicateCluster[] = [];

  for (const seed of facts) {
    if (assigned.has(seed.id)) {
      continue;
    }
    assigned.add(seed.id);
    const seedTerms = terms.get(seed.id) ?? new Set<string>();
    const seedKey = comparabilityKey(seed);
    const members: DuplicateMember[] = [];
    for (const candidate of facts) {
      if (assigned.has(candidate.id) || comparabilityKey(candidate) !== seedKey) {
        continue;
      }
      const similarity = jaccard(seedTerms, terms.get(candidate.id) ?? new Set<string>());
      if (similarity >= threshold) {
        assigned.add(candidate.id);
        members.push({ fact: candidate, similarity });
      }
    }
    const duplicates = members.filter((member) => member.fact.status !== "pinned");
    if (duplicates.length === 0) {
      continue;
    }
    clusters.push({
      keep: seed,
      duplicates,
      retainedPinned: members.filter((member) => member.fact.status === "pinned").map((member) => member.fact),
    });
  }

  return clusters;
}

/**
 * The `captured_at` floor a `--stale` run judges against: facts captured before this are old enough
 * to be candidates. Exposed so the CLI can print the same date it filtered on rather than recompute
 * it from a second clock reading.
 */
export function staleCutoff(ageDays: number, now: Date): string {
  return new Date(now.getTime() - ageDays * MS_PER_DAY).toISOString();
}

/**
 * The facts `--stale` proposes: live, captured before `cutoffIso`, never surfaced by recall, never
 * marked useful, never pinned. Oldest first.
 */
export function findStaleFacts(db: Db, cutoffIso: string): Fact[] {
  return listStaleUnsurfacedFacts(db, cutoffIso);
}
