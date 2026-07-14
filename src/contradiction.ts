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

import type { Fact, FactScope, FactStatus } from "./types.js";

/** Statuses eligible to be surfaced as ground truth. Everything else (pending/superseded/contested) is withheld. */
const GROUND_TRUTH_STATUSES: readonly FactStatus[] = ["active", "pinned"];

/** A fact narrowed to have a non-null `subject` and `value`, i.e. eligible for keyed contradiction detection. */
type KeyedFact = Fact & { readonly subject: string; readonly value: string };

function isKeyedGroundTruthFact(fact: Fact): fact is KeyedFact {
  return fact.subject !== null && fact.value !== null && GROUND_TRUTH_STATUSES.includes(fact.status);
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
  readonly nextStatus: "superseded" | "contested";
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
  const rootComponent = scope === "global" ? "" : (scopeRoot ?? "");
  return JSON.stringify([subject, scope, rootComponent]);
}

/**
 * Detects deterministic subject+value contradictions among the given facts and computes the status
 * updates required to resolve them. Pure function: does not mutate its input and performs no I/O.
 * Callers (e.g. a store module) are responsible for persisting `updates`.
 */
export function detectContradictions(facts: readonly Fact[]): ContradictionDetectionResult {
  const buckets = new Map<string, SubjectScopeBucket>();

  for (const fact of facts) {
    if (!isKeyedGroundTruthFact(fact)) {
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
