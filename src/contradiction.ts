/**
 * Deterministic subject+value contradiction detection (design plan P4, Section 6, review S5/S8).
 *
 * No embeddings, no NLP/NLI. Two facts with the same `subject` and `scope` but different
 * `value` are a contradiction. Resolution is deterministic:
 *   - prefer higher provenance (user > derived), then newer `captured_at`;
 *   - the loser is marked `superseded` (kept for audit, not surfaced);
 *   - if precedence is genuinely tied (same provenance rank AND same `captured_at`), the entire
 *     subject+scope group is ambiguous and every fact in it is marked `contested` — withheld from
 *     ground truth entirely, left for a human to resolve via `mem review` (P4).
 *
 * Free-text facts without a `subject`/`value` key are not evaluated here (deferred per Section 5 /
 * Open Question 2). `pending` and already-`superseded` facts do not participate: only `active` and
 * `pinned` facts are live enough to contradict one another (pins are not exempt from this — S8).
 */

import { normalizePath } from "./pathUtils.js";
import type { Fact, FactScope, FactStatus } from "./types.js";

/** Statuses eligible to be surfaced as ground truth. Everything else (pending/superseded/contested) is withheld. */
const GROUND_TRUTH_STATUSES: readonly FactStatus[] = ["active", "pinned"];

/**
 * Statuses that participate in *detection*. Deliberately wider than
 * {@link GROUND_TRUTH_STATUSES} by exactly one entry: `contested`.
 *
 * `contested` is a cached outcome of this function, not an independent lifecycle state -- the fact
 * is withheld because *this* detector previously found its subject+scope bucket ambiguous. Excluding
 * it from detection therefore made the status unfalsifiable: once `mem epoch --gc` persisted it, the
 * fact dropped out of every pool that could ever clear it (this detector, and `mem review`'s
 * contested bucket, which is derived from the same pool), while `mem recall` kept withholding it
 * from the persisted status forever. Forgetting or editing the other side of the contradiction did
 * not help: the surviving fact stayed `contested` with nothing left to contest, and the documented
 * escape ("resolve it via `mem review`") had no reachable command behind it.
 *
 * Feeding contested facts back through detection closes that trapdoor: a bucket that is still
 * ambiguous re-emits nothing (the `fact.status !== "contested"` guard below keeps it idempotent),
 * and a bucket that is no longer ambiguous produces a reinstatement update instead.
 */
const DETECTION_ELIGIBLE_STATUSES: readonly FactStatus[] = ["active", "pinned", "contested"];

/** A fact narrowed to have a non-null `subject` and `value`, i.e. eligible for keyed contradiction detection. */
type KeyedFact = Fact & { readonly subject: string; readonly value: string };

function isKeyedDetectionFact(fact: Fact): fact is KeyedFact {
  return fact.subject !== null && fact.value !== null && DETECTION_ELIGIBLE_STATUSES.includes(fact.status);
}

/** Whether a fact would be surfaceable as ground truth if nothing else withheld it. Kept as the separate, narrower predicate {@link DETECTION_ELIGIBLE_STATUSES} widens against. */
export function isGroundTruthStatus(status: FactStatus): boolean {
  return GROUND_TRUTH_STATUSES.includes(status);
}

/**
 * The status a fact leaving `contested` returns to. A pin is a deliberate user act that exempts a
 * fact from time-decay, and contesting it overwrote that status -- so reinstating unconditionally to
 * `active` would silently destroy the pin as a side effect of an unrelated contradiction being
 * resolved. `prior_status` (storage.setFactStatus) records what to come back to; `active` is the
 * fallback for rows written before that column existed.
 */
function reinstatedStatus(fact: Fact): "active" | "pinned" {
  return fact.prior_status === "pinned" ? "pinned" : "active";
}

/** One subject+scope bucket that contains two or more distinct values, i.e. a live contradiction. */
export interface ContradictionGroup {
  readonly subject: string;
  readonly scope: FactScope;
  readonly factIds: readonly string[];
  readonly resolution: "resolved" | "contested";
  /** The id of the fact that remains ground-truth-eligible, or null when the group is contested. */
  readonly winnerId: string | null;
}

/** A single fact status transition produced by contradiction resolution. */
export interface FactStatusUpdate {
  readonly factId: string;
  readonly previousStatus: FactStatus;
  readonly nextStatus: "superseded" | "contested" | "active" | "pinned";
  readonly reason: string;
}

export interface ContradictionDetectionResult {
  readonly groups: readonly ContradictionGroup[];
  readonly updates: readonly FactStatusUpdate[];
}

/** Higher rank wins. User-stated facts outrank derived (extracted-from-content) facts (P7/S9). */
function provenanceRank(fact: KeyedFact): number {
  return fact.source_type === "user" ? 1 : 0;
}

/**
 * Compares two facts for contradiction-resolution precedence.
 * Returns a positive number if `a` is preferred over `b`, negative if `b` is preferred, 0 if tied.
 * Precedence order: higher provenance rank first, then newer `captured_at` (ISO 8601, lexically comparable).
 */
function comparePrecedence(a: KeyedFact, b: KeyedFact): number {
  const provenanceDelta = provenanceRank(a) - provenanceRank(b);
  if (provenanceDelta !== 0) {
    return provenanceDelta;
  }
  if (a.captured_at > b.captured_at) {
    return 1;
  }
  if (a.captured_at < b.captured_at) {
    return -1;
  }
  return 0;
}

interface SubjectScopeBucket {
  readonly subject: string;
  readonly scope: FactScope;
  readonly facts: KeyedFact[];
}

/**
 * Bucket identity for contradiction detection: subject + scope + (for non-global scopes) scope_root.
 *
 * `FactScope` alone ("global"/"project"/"path") is not root-aware, but mem's store is shared across
 * every project a user works in. Without the scope_root component, `subject="package-manager"
 * scope="project"` in project A (value=npm, scope_root=/a) and the same subject/scope in project B
 * (value=pnpm, scope_root=/b) collapse into one bucket and look like a live contradiction -- so
 * `mem epoch --gc` / `mem review` would *persist* a supersede/contested transition, silently
 * clobbering one project's fact because of an unrelated project's, and plain `mem recall` would
 * mislabel them. Including scope_root keeps each project's facts in their own bucket. Global facts
 * always share one bucket (scope_root is null by convention). (The `--hint-format` seam already
 * pre-filters to a single root before calling in, so this only corrects the whole-store callers.)
 */
function bucketKey(subject: string, scope: FactScope, scopeRoot: string | null | undefined): string {
  // Case-fold the root component the same way retrieval.ts folds paths for comparison (see
  // pathUtils.ts): `scopeRoot` is `path.resolve(root)` at capture time (src/capture.ts), which on
  // Windows preserves whatever drive-letter/segment case the shell happened to report, so the same
  // directory captured from a differently-cased cwd would otherwise split into two buckets and
  // never be detected as a contradiction.
  const rootComponent = scope === "global" ? "" : normalizePath(scopeRoot ?? "");
  return JSON.stringify([subject, scope, rootComponent]);
}

/**
 * Whether two facts fall in the same contradiction bucket, i.e. whether they are candidates to
 * contradict each other at all. Exported so `mem review --promote` can resolve a contested group in
 * one fact's favor -- superseding exactly its rivals -- using the same bucket identity the detector
 * itself uses, rather than a second, drifting definition of "same subject". Free-text facts (no
 * `subject`) are never in any bucket.
 */
export function sameContradictionBucket(a: Fact, b: Fact): boolean {
  if (a.subject === null || b.subject === null) {
    return false;
  }
  return bucketKey(a.subject, a.scope, a.scopeRoot) === bucketKey(b.subject, b.scope, b.scopeRoot);
}

/**
 * Detects deterministic subject+value contradictions among the given facts and computes the status
 * updates required to resolve them. Pure function: does not mutate its input and performs no I/O.
 * Callers (e.g. a store module) are responsible for persisting `updates`.
 */
export function detectContradictions(facts: readonly Fact[]): ContradictionDetectionResult {
  const buckets = new Map<string, SubjectScopeBucket>();

  for (const fact of facts) {
    if (!isKeyedDetectionFact(fact)) {
      continue;
    }
    const key = bucketKey(fact.subject, fact.scope, fact.scopeRoot);
    const existing = buckets.get(key);
    if (existing) {
      existing.facts.push(fact);
    } else {
      buckets.set(key, { subject: fact.subject, scope: fact.scope, facts: [fact] });
    }
  }

  const groups: ContradictionGroup[] = [];
  const updates: FactStatusUpdate[] = [];

  for (const bucket of buckets.values()) {
    const distinctValues = new Set(bucket.facts.map((fact) => fact.value));
    if (distinctValues.size <= 1) {
      continue;
    }

    const sorted = [...bucket.facts].sort((a, b) => comparePrecedence(b, a));
    const best = sorted[0];
    if (best === undefined) {
      continue;
    }
    // All facts tied for the top precedence rank (may be 2+, not just the top two array slots).
    const topGroup = sorted.filter((fact) => comparePrecedence(fact, best) === 0);
    const topValues = new Set(topGroup.map((fact) => fact.value));
    // Genuinely ambiguous only when the tied-top-precedence facts themselves disagree on value.
    const isGenuineTie = topGroup.length > 1 && topValues.size > 1;

    if (isGenuineTie) {
      for (const fact of bucket.facts) {
        if (fact.status !== "contested") {
          updates.push({
            factId: fact.id,
            previousStatus: fact.status,
            nextStatus: "contested",
            reason:
              `Ambiguous contradiction on subject "${bucket.subject}" (scope=${bucket.scope}): ` +
              `tied precedence between conflicting values, no deterministic winner.`,
          });
        }
      }
      groups.push({
        subject: bucket.subject,
        scope: bucket.scope,
        factIds: bucket.facts.map((fact) => fact.id),
        resolution: "contested",
        winnerId: null,
      });
    } else if (topGroup.length > 1) {
      // Tied-top-precedence facts agree on value: that value wins outright. Only facts holding a
      // different (lower-precedence) value are superseded; the other tied leader(s) sharing the
      // winning value are left untouched since they are not actually in conflict with the winner.
      for (const fact of bucket.facts) {
        if (fact.value === best.value) {
          continue;
        }
        updates.push({
          factId: fact.id,
          previousStatus: fact.status,
          nextStatus: "superseded",
          reason:
            `Superseded by fact ${best.id} on subject "${bucket.subject}" (scope=${bucket.scope}): ` +
            `value "${fact.value}" superseded by newer/higher-provenance value "${best.value}".`,
        });
      }
      groups.push({
        subject: bucket.subject,
        scope: bucket.scope,
        factIds: bucket.facts.map((fact) => fact.id),
        resolution: "resolved",
        winnerId: best.id,
      });
    } else {
      for (const fact of bucket.facts) {
        if (fact.id === best.id) {
          continue;
        }
        updates.push({
          factId: fact.id,
          previousStatus: fact.status,
          nextStatus: "superseded",
          reason:
            `Superseded by fact ${best.id} on subject "${bucket.subject}" (scope=${bucket.scope}): ` +
            `value "${fact.value}" superseded by newer/higher-provenance value "${best.value}".`,
        });
      }
      groups.push({
        subject: bucket.subject,
        scope: bucket.scope,
        factIds: bucket.facts.map((fact) => fact.id),
        resolution: "resolved",
        winnerId: best.id,
      });
    }
  }

  // Reinstatement pass. Anything still carrying a persisted `contested` status that this run did
  // *not* place in a contested group is stale: the ambiguity that justified withholding it is gone
  // (the other side was forgotten, edited to agree, or re-captured with higher precedence), or it
  // was never keyed in the first place and so could never have been legitimately contested. Facts
  // already receiving an update this run are skipped -- a contested fact that lost a now-resolvable
  // bucket is correctly superseded above, and must not also be reinstated.
  const contestedGroupIds = new Set(groups.filter((group) => group.resolution === "contested").flatMap((group) => group.factIds));
  const alreadyUpdatedIds = new Set(updates.map((update) => update.factId));
  for (const fact of facts) {
    if (fact.status !== "contested" || contestedGroupIds.has(fact.id) || alreadyUpdatedIds.has(fact.id)) {
      continue;
    }
    const restored = reinstatedStatus(fact);
    updates.push({
      factId: fact.id,
      previousStatus: fact.status,
      nextStatus: restored,
      reason:
        `Reinstated to ${restored}: no ambiguous contradiction remains for this fact, so the ` +
        `contested status that was withholding it from ground truth no longer applies.`,
    });
  }

  return { groups, updates };
}

/**
 * Applies contradiction-resolution status updates to a fact list, returning a new array. Facts not
 * referenced by any update are returned unchanged (same reference). Pure, does not mutate `facts`.
 */
export function applyContradictionUpdates(facts: readonly Fact[], updates: readonly FactStatusUpdate[]): Fact[] {
  if (updates.length === 0) {
    return [...facts];
  }
  const nextStatusById = new Map<string, FactStatus>(updates.map((update) => [update.factId, update.nextStatus]));
  return facts.map((fact) => {
    const nextStatus = nextStatusById.get(fact.id);
    return nextStatus === undefined ? fact : { ...fact, status: nextStatus };
  });
}

/**
 * Runs contradiction detection and applies the resulting updates in one step, returning the
 * fully-resolved fact list alongside the contradiction groups that were found. Convenience wrapper
 * around `detectContradictions` + `applyContradictionUpdates`.
 */
export function resolveContradictions(facts: readonly Fact[]): {
  readonly facts: readonly Fact[];
  readonly groups: readonly ContradictionGroup[];
} {
  const { groups, updates } = detectContradictions(facts);
  return { facts: applyContradictionUpdates(facts, updates), groups };
}

/**
 * The ground-truth read path (P1/P8). Returns only facts eligible to be surfaced as trusted,
 * current knowledge: `active` and `pinned`. Excludes `pending` (never auto-promoted, S9),
 * `superseded` (lost a contradiction), and — critically — `contested` (ambiguous contradiction,
 * withheld until a human resolves it via `mem review`, P4). Callers building "current truth" views
 * (e.g. the persona/preferences read-model, `--hint-format`) must go through this function rather
 * than filtering `facts` themselves, so a contested subject can never leak into ground truth.
 */
export function getGroundTruthFacts(facts: readonly Fact[]): Fact[] {
  return facts.filter((fact) => GROUND_TRUTH_STATUSES.includes(fact.status));
}
