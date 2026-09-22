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

import { computeContradictionBucketGroups, computeProjectIdentityGroups, sameContradictionBucket } from "./contradiction.js";
import { neighbours } from "./factgraph.js";
import { listFacts, listStaleUnsurfacedFacts, listTermsForFact, normalizeFactText } from "./storage.js";
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
 *
 * The scope-binding component is a precomputed `projectGroups` id (from `contradiction.ts`'s
 * `computeProjectIdentityGroups`, keyed by `fact.scope` so path/global/project facts never merge)
 * rather than a raw `scopeRoot` comparison, so a duplicate cluster spans the same "same project"
 * notion `sameContradictionBucket` below uses to keep a live contradiction out of a cluster -- two
 * clones or worktrees of one repository compare as the same project here too, via one shared
 * computation rather than a second, independently-derived definition.
 */
function comparabilityKey(fact: Fact, projectGroups: ReadonlyMap<string, string>): string {
  return [fact.kind, projectGroups.get(fact.id) ?? ""].join(" ");
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
  // Computed once over the whole pool, not per pair: both are connected-component passes, and
  // `comparabilityKey`/`sameContradictionBucket` below turn into cheap map lookups against them.
  const projectGroups = computeProjectIdentityGroups(facts, (fact) => fact.scope);
  const contradictionGroups = computeContradictionBucketGroups(facts);

  for (const seed of facts) {
    if (assigned.has(seed.id)) {
      continue;
    }
    assigned.add(seed.id);
    const seedTerms = terms.get(seed.id) ?? new Set<string>();
    const seedKey = comparabilityKey(seed, projectGroups);
    const members: DuplicateMember[] = [];
    for (const candidate of facts) {
      if (assigned.has(candidate.id) || comparabilityKey(candidate, projectGroups) !== seedKey) {
        continue;
      }
      // Same subject+scope, different value is a live contradiction, not a duplicate --
      // `detectContradictions` owns that resolution (provenance > newest, contested on a genuine
      // tie). Clustering it here as a "duplicate" would let `preferenceOrder` (pinned > confidence
      // > newest) override that outcome and silently resurrect a value the user already corrected.
      if (sameContradictionBucket(seed, candidate, contradictionGroups) && seed.value !== candidate.value) {
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
 * One discovered relation between two facts, below the duplicate threshold that would merge them --
 * `findRelatedFactPairs`'s report. Canonical order: `a.id <= b.id`, matching `storage.upsertFactLink`'s
 * own ordering, so a pair is reported (and later persisted) once regardless of which fact this pass
 * reaches first.
 */
export interface RelatedFactPair {
  readonly a: Fact;
  readonly b: Fact;
  readonly similarity: number;
}

/**
 * Facts that share enough topic vocabulary to be worth recording as related, but not enough for the
 * duplicate pass to merge them -- exactly the population `findDuplicateClusters` computes on every
 * comparable pair it walks and then discards once a pair falls short of the merge threshold. This
 * pass does not discard it. It is a second, exhaustive read of the same comparable-pair space
 * (`comparabilityKey`, `sameContradictionBucket`) rather than a change to `findDuplicateClusters`
 * itself: that function's greedy single-link walk stops comparing a fact once it joins a cluster, so
 * its own discarded scores are order-dependent and cannot be trusted as "every sub-threshold pair" --
 * only a pass that visits every comparable pair once, as this one does, can.
 *
 * Same two guards as `findDuplicateClusters`, for the same reason its own comment gives: a pair that
 * is a live contradiction (same subject+scope, different value) is never a relation to record here
 * either -- linking a corrected value to its correction would resurrect exactly the bug
 * `detectContradictions` exists to prevent, one step removed from "duplicate" and landing in
 * `fact_links` instead of `facts.status`.
 *
 * `similarity > 0`, not `>= 0`: a pair sharing no topic terms carries no evidence of any relation
 * (see `jaccard`'s own doc comment on why an empty-set pair must never read as similar), so there is
 * nothing to record.
 */
export function findRelatedFactPairs(db: Db, upperThreshold: number = DEFAULT_DUPLICATE_THRESHOLD): RelatedFactPair[] {
  const facts = [...listFacts(db, { status: ["active", "pinned"] })].sort(preferenceOrder);
  const terms = new Map<string, Set<string>>(facts.map((fact) => [fact.id, topicKeys(db, fact.id)]));
  const projectGroups = computeProjectIdentityGroups(facts, (fact) => fact.scope);
  const contradictionGroups = computeContradictionBucketGroups(facts);
  const pairs: RelatedFactPair[] = [];
  for (let i = 0; i < facts.length; i += 1) {
    const left = facts[i];
    if (left === undefined) {
      continue;
    }
    const leftKey = comparabilityKey(left, projectGroups);
    const leftTerms = terms.get(left.id) ?? new Set<string>();
    for (let j = i + 1; j < facts.length; j += 1) {
      const right = facts[j];
      if (right === undefined || comparabilityKey(right, projectGroups) !== leftKey) {
        continue;
      }
      if (sameContradictionBucket(left, right, contradictionGroups) && left.value !== right.value) {
        continue;
      }
      const similarity = jaccard(leftTerms, terms.get(right.id) ?? new Set<string>());
      if (similarity > 0 && similarity < upperThreshold) {
        const [a, b] = left.id <= right.id ? [left, right] : [right, left];
        pairs.push({ a, b, similarity });
      }
    }
  }
  return pairs;
}

function kindTextKey(fact: Fact): string {
  return `${fact.kind} ${normalizeFactText(fact.text)}`;
}

/**
 * Whether two same-kind, same-normalized-text facts should be excluded from cross-scope or
 * cross-project duplicate reporting because their keyed data disagrees. Backs both
 * `findCrossScopeDuplicates` and `findCrossProjectDuplicates` -- the two passes that compare facts
 * *across* a scope or project boundary -- as the one definition of "this is an override, not a
 * duplicate" between them, so a future change to the rule has one place to land instead of two that
 * can quietly drift apart.
 *
 * Not `sameContradictionBucket` (src/contradiction.ts): that bucket is deliberately scope-bound
 * (its family is `subject scope`), so a global fact and a project fact -- or two facts in different
 * projects -- never share a bucket to begin with, whatever their subject or value. Reusing it here
 * would silently no-op on every pair these two passes exist to compare and leave the bug in place;
 * `findDuplicateClusters` above only ever compares facts that already share a scope and project
 * identity by construction of `comparabilityKey`, so its own bucket check never had to look past
 * scope in the first place. This function is that same "same subject, different value is an
 * override" judgment, generalized to also catch "different subject entirely" and applied where a
 * shared contradiction bucket can never be assumed.
 *
 * Null handling, spelled out because unkeyed facts (`subject === null`) are the ordinary case this
 * module serves -- `mem scan-session` and `mem import --from-md` capture text with no subject at
 * all:
 * - Both sides unkeyed: not a mismatch. There is nothing keyed to disagree about, so identical text
 *   still means the same statement -- the behaviour this pass had before subject/value awareness
 *   existed, and the majority path it must keep serving.
 * - Exactly one side keyed: not a mismatch. A single labeled subject has nothing on the other side
 *   to compare a value against, so this also falls back to the conservative text-identity read.
 *   Byte-identical text remains real evidence of restatement even when only one side names what it
 *   is restating.
 * - Both sides keyed, different subjects: a mismatch. Coinciding prose does not make two facts
 *   about different things the same fact.
 * - Both sides keyed, same subject, different values: a mismatch -- the override case this guard
 *   exists for. "The default branch name" can be true of two different values in two different
 *   scopes; that is a correction or override, never a duplicate.
 * - Both sides keyed, same subject, same value: no mismatch -- a genuine restatement, reported as
 *   before.
 */
function isCrossBoundaryKeyMismatch(a: Fact, b: Fact): boolean {
  if (a.subject === null || b.subject === null) {
    return false;
  }
  return a.subject !== b.subject || a.value !== b.value;
}

/** One project-scope fact whose text exactly duplicates a same-kind global fact -- `findCrossScopeDuplicates`'s report. */
export interface CrossScopeDuplicate {
  /** The global fact -- always the survivor. Widening a project fact's own scope is a decision `mem edit --scope global` makes explicitly, never one this pass invents by promoting a project fact on its own. */
  readonly keep: Fact;
  readonly duplicate: Fact;
}

/**
 * Project-scope facts that exactly restate a same-kind global fact -- the one duplicate shape
 * `comparabilityKey` above cannot see by design. That function's own doc comment explains why its
 * scope-family disjointness is deliberate: relaxing it would let the Jaccard pass above merge
 * unrelated same-kind facts across every project boundary. This pass is a narrow, exact-match
 * exception run *beside* that rule, not a change to it -- `normalizeFactText` equality only (the
 * store's existing canonical equality function, not a second notion of sameness), over the same
 * `active`/`pinned` pool `findDuplicateClusters` reads.
 *
 * Normalized text equality alone is not enough to call two sides duplicates, though: a same-kind
 * global fact and project fact can share prose word for word ("the default branch name") while
 * legitimately naming different values in different scopes. `isCrossBoundaryKeyMismatch` above
 * excludes exactly that case -- a genuine override, never a restatement -- and its own doc comment
 * covers the null cases (most facts here carry no subject at all).
 */
export function findCrossScopeDuplicates(db: Db): CrossScopeDuplicate[] {
  const facts = [...listFacts(db, { status: ["active", "pinned"] })].sort(preferenceOrder);
  const globalByKey = new Map<string, Fact>();
  for (const fact of facts) {
    if (fact.scope === "global") {
      const key = kindTextKey(fact);
      // First writer under `preferenceOrder` wins (pinned, then most confident, then newest) for
      // the rare case of two global facts already sharing text -- that pair is a same-scope
      // duplicate `findDuplicateClusters` already reports, not this pass's concern.
      if (!globalByKey.has(key)) {
        globalByKey.set(key, fact);
      }
    }
  }
  const duplicates: CrossScopeDuplicate[] = [];
  for (const fact of facts) {
    if (fact.scope !== "project") {
      continue;
    }
    const keep = globalByKey.get(kindTextKey(fact));
    if (keep !== undefined && !isCrossBoundaryKeyMismatch(keep, fact)) {
      duplicates.push({ keep, duplicate: fact });
    }
  }
  return duplicates;
}

/**
 * One same-kind, same-normalized-text statement live under two or more distinct project
 * identities -- `--cross-project`'s report. `facts` holds one representative per identity, newest
 * capture first, so a printed `mem edit --scope global` command always targets the most recently
 * stated copy.
 */
export interface CrossProjectDuplicateGroup {
  readonly facts: readonly Fact[];
  /** `facts[0]` restated as its own field, typed non-optional: every group has at least two members by construction, but nothing in `Fact[]`'s own type says so, and the CLI's printed `mem edit --scope global` command targets exactly this one. */
  readonly newest: Fact;
}

/**
 * Same-kind, same-normalized-text project-scope facts present under two or more distinct project
 * identities (`computeProjectIdentityGroups` -- the identical identity notion `findDuplicateClusters`
 * above uses, not a second one), and whose keyed data agrees per `isCrossBoundaryKeyMismatch` --
 * same text alone is not sufficient, since two projects can legitimately override a same-worded
 * subject with different values. Report only: nothing in this module writes for this shape, and
 * `mem consolidate --cross-project` has no `--apply` path -- widening a fact's scope out of its own
 * project is a bigger claim than collapsing a same-project restatement (it says the preference
 * applies everywhere, not just here), and that is the user's call to make explicitly, not this
 * pass's to act on unattended.
 */
export function findCrossProjectDuplicates(db: Db): CrossProjectDuplicateGroup[] {
  const facts = [...listFacts(db, { status: ["active", "pinned"], scope: "project" })].sort(preferenceOrder);
  const projectGroups = computeProjectIdentityGroups(facts, (fact) => fact.scope);
  const byKey = new Map<string, Map<string, Fact>>();
  for (const fact of facts) {
    const identity = projectGroups.get(fact.id);
    // No `scopeRoot`/`scopeRepo` at all means this project fact's identity is unknown -- there is
    // no honest way to tell whether it belongs to a project already in the map or a new one, so it
    // cannot count toward "two or more distinct projects" either way.
    if (identity === undefined) {
      continue;
    }
    const key = kindTextKey(fact);
    let byIdentity = byKey.get(key);
    if (byIdentity === undefined) {
      byIdentity = new Map<string, Fact>();
      byKey.set(key, byIdentity);
    }
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, fact);
    }
  }
  const groups: CrossProjectDuplicateGroup[] = [];
  for (const byIdentity of byKey.values()) {
    const candidates = [...byIdentity.values()];
    // Same text is not sufficient once two identities' facts disagree on subject or value -- that
    // pair is an override across two projects, not a duplicate (see `isCrossBoundaryKeyMismatch`).
    // Kept only when it agrees with every other candidate sharing this text key, not merely one:
    // three identities where two agree and a third is a genuine override must not let the override
    // slip through by matching just one of the other two.
    const agreeing = candidates.filter((fact) =>
      candidates.every((other) => other === fact || !isCrossBoundaryKeyMismatch(fact, other))
    );
    if (agreeing.length < 2) {
      continue;
    }
    const facts = [...agreeing].sort((a, b) => b.captured_at.localeCompare(a.captured_at));
    const [newest] = facts;
    if (newest === undefined) {
      continue;
    }
    groups.push({ facts, newest });
  }
  return groups;
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
 * The facts `--stale` proposes: live, captured before `cutoffIso`, unsurfaced by recall since
 * `cutoffIso`, never marked useful, never pinned. Oldest first. See `listStaleUnsurfacedFacts` for
 * why "unsurfaced since the cutoff" and "never marked useful" are governed differently.
 */
export function findStaleFacts(db: Db, cutoffIso: string): Fact[] {
  return listStaleUnsurfacedFacts(db, cutoffIso);
}

/**
 * Minimum distinct topic-graph neighbours a fact must have before the graph-staleness signal below
 * has anything to say about it. With fewer, "most neighbours are superseded" is not a majority, it
 * is one data point wearing a percentage.
 */
export const GRAPH_STALE_MIN_NEIGHBOURS = 2;

/**
 * Share of a fact's topic-graph neighbours that must be superseded before {@link findGraphStaleFacts}
 * calls the fact stale by this signal -- a majority, not any single superseded neighbour, since one
 * corrected fact nearby says nothing about the rest of a cluster.
 */
export const GRAPH_STALE_SUPERSEDED_RATIO = 0.5;

/** One fact `findGraphStaleFacts` proposes on the graph signal, with the neighbour counts that produced the proposal so the CLI can print an honest, checkable reason rather than a bare assertion. */
export interface GraphStaleFact {
  readonly fact: Fact;
  readonly supersededNeighbours: number;
  readonly totalNeighbours: number;
}

/**
 * A second, opt-in staleness signal: facts whose topic-graph neighbours (`factgraph.neighbours`,
 * built from `fact_terms` co-occurrence) have themselves mostly been superseded -- the topic moved
 * on around this fact even though its own age-and-recall history (`findStaleFacts`) does not yet say
 * so. `neighbours` reads `fact_terms` directly, not `facts.status`, so a superseded fact's row is
 * still visible as a neighbour here (its `fact_terms` rows survive a supersede, only a hard delete
 * cascades them away) -- exactly the history this signal needs to read.
 *
 * The brief this was built from named "superseded or retracted" neighbours; this store's
 * `FactStatus` (`active`/`pending`/`superseded`/`contested`/`pinned`) has no `retracted` state, so
 * only `superseded` is checked. Flagged here rather than silently narrowed: if a future status is
 * added for an explicit user retraction, this signal should count it too.
 *
 * Absent by default: this is a second signal, never a replacement for `findStaleFacts`, and it is
 * the CLI's job (not this function's) to decide whether it runs at all -- see `mem consolidate
 * --stale --include-graph-stale`. `exclude` lets the caller drop facts `findStaleFacts` already
 * proposed, so a fact never gets two different stale reasons attributed to it.
 *
 * Candidates are bounded to the same `cutoffIso` age floor `findStaleFacts` uses, deliberately more
 * conservative than "any active fact with the right neighbour shape": a fact captured moments ago
 * should not be supersede-able purely because facts near it in topic space happen to have been
 * cleaned up first.
 */
export function findGraphStaleFacts(db: Db, cutoffIso: string, exclude: ReadonlySet<string> = new Set()): GraphStaleFact[] {
  const candidates = listFacts(db, { status: "active" }).filter(
    (fact) => fact.captured_at < cutoffIso && !exclude.has(fact.id)
  );
  if (candidates.length === 0) {
    return [];
  }
  // One pass over the whole store's statuses, not one query per candidate's neighbour: the same
  // batching discipline `findDuplicateClusters` above uses for topic terms.
  const statusById = new Map(listFacts(db, {}).map((fact) => [fact.id, fact.status]));
  const results: GraphStaleFact[] = [];
  for (const fact of candidates) {
    const neighbourMap = neighbours(db, fact.id);
    if (neighbourMap.size < GRAPH_STALE_MIN_NEIGHBOURS) {
      continue;
    }
    let supersededCount = 0;
    for (const neighbourId of neighbourMap.keys()) {
      if (statusById.get(neighbourId) === "superseded") {
        supersededCount += 1;
      }
    }
    if (supersededCount / neighbourMap.size >= GRAPH_STALE_SUPERSEDED_RATIO) {
      results.push({ fact, supersededNeighbours: supersededCount, totalNeighbours: neighbourMap.size });
    }
  }
  return results;
}
