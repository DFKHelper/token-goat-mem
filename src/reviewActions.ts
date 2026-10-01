/**
 * The status transitions a human drives through `mem review` (promote, reject, undo a rejection),
 * and the two primitives every other status-changing command shares with them: the transactional
 * status-plus-audit write, and the contradiction reconciliation pass `mem epoch --gc` and
 * `mem forget` also run. Kept out of cli.ts so the command layer only parses flags and prints.
 */
import type Database from "better-sqlite3";

import { resolveIdArgOrThrow, UsageError } from "./cliRuntime.js";
import { detectContradictions, type FactStatusUpdate } from "./contradiction.js";
import { insertAuditLog, listAuditLogForFact, SUPERSEDED_BY_FACT_PREFIX } from "./db.js";
import { listFacts, setFactStatus, updateFact } from "./storage.js";
import type { FactStatus } from "./types.js";

/**
 * Flips a fact's status and writes its audit-log row inside a single transaction, so a crash
 * between the two never leaves a persisted status change with no audit trail (the crash-window
 * class commit bb38b1e closed for remember/suggest/edit/forget/pin/promote/reject). All status-
 * changing commands (and the retention pass's per-contradiction resolution) funnel through here.
 */
export function setStatusWithAudit(
  db: Database.Database,
  factId: string,
  nextStatus: FactStatus,
  event: string,
  detail: string
): void {
  const tx = db.transaction((): void => {
    setFactStatus(db, factId, nextStatus);
    insertAuditLog(db, { event, factId, detail });
  });
  // BEGIN IMMEDIATE: `setFactStatus` reads the current status and epoch before writing, and once
  // this outer transaction is open it degrades to a savepoint -- so the outer variant is what
  // decides whether the read-then-write pair survives a concurrent writer under WAL. See
  // storage.insertFact for the SQLITE_BUSY_SNAPSHOT rationale.
  tx.immediate();
}

/**
 * Statuses `mem review --promote/--reject` can act on. Both are review-resolvable *withheld* states
 * -- a fact recall refuses to surface until a human decides -- which is the whole population the
 * review loop exists to drain.
 */
export const REVIEW_RESOLVABLE_STATUSES: readonly FactStatus[] = ["pending", "contested"];

/**
 * Re-runs deterministic contradiction detection over the full detection pool and persists every
 * transition it produces, including reinstatements of facts no longer contested.
 *
 * Shared by `mem epoch --gc` and by review's contested resolution so both agree, by construction,
 * on which facts are still contested -- the divergence that let a `contested` status outlive the
 * contradiction that caused it.
 */
export function reconcileContradictions(db: Database.Database, event: string): readonly FactStatusUpdate[] {
  const pool = listFacts(db, { status: ["active", "pinned", "contested"] });
  const { updates } = detectContradictions(pool);
  for (const update of updates) {
    setStatusWithAudit(db, update.factId, update.nextStatus, event, update.reason);
  }
  return updates;
}

/**
 * `mem review --promote <id>`: accept a withheld fact.
 *
 * For a `pending` fact that means activating it. For a `contested` one it means declaring it the
 * winner of its ambiguous contradiction, which requires superseding exactly its bucket rivals --
 * without that, the next detection pass would find the same tied precedence and re-contest the
 * whole group, making the promotion silently self-undoing. The winner returns to `prior_status`
 * where that was `pinned`, so resolving a contradiction never quietly discards a user's pin.
 */
/** The outcome of a promotion: the resolved id, plus a caveat when the promoted fact cannot be contradicted. */
export interface PromotionOutcome {
  readonly id: string;
  readonly note?: string;
}

/** The contradiction key `mem review --promote --subject --value` gives a pending fact as it activates it; the caller has already validated and screened both fields. */
export interface PromotionKey {
  readonly subject: string;
  readonly value: string;
}

/**
 * Contradiction resolution keys on `subject` + `value` (`detectContradictions` filters to facts
 * that have one), so a fact promoted without a subject becomes ground truth nothing can ever
 * supersede: a later fact stating the opposite accumulates beside it and both surface, with no
 * loser. Derived candidates are the ones that land here, and they rarely carry a key -- `mem
 * scan-session` and `mem import --from-md` extract text, not a subject -- so this is the ordinary
 * promotion rather than an exotic one, and nothing in `promoted <id>` alone would reveal it.
 */
function unkeyedPromotionNote(id: string): string {
  return (
    `note: ${id} has no subject/value, so contradiction resolution can never supersede it -- ` +
    `key it with \`mem edit ${id} --subject <key> --value <value>\` if a later fact should be able to replace it.`
  );
}

/**
 * Appends a reviewer's `--reason` to a transition's audit detail, so `mem log` shows why the call was
 * made beside what it did. The caller has already validated and screened it (capture.ts's
 * `screenReviewReasonOrThrow`).
 */
function withReason(detail: string, reason: string | undefined): string {
  return reason === undefined ? detail : `${detail}; reason: ${reason}`;
}

export function promotePending(db: Database.Database, id: string, reason?: string, key?: PromotionKey): PromotionOutcome {
  const fact = resolveIdArgOrThrow(db, id);
  // `detectContradictions` is run over the same pool `formatReview` derives its `contested` bucket
  // from -- active/pinned/contested -- and read before any status is written below, for the same
  // reason the old contested-only read had to come first: `fact` must still be part of the
  // population its rivals are drawn from. A precedence tie that ties on `captured_at` and
  // provenance is *shown* as contested by `formatReview` without ever persisting `contested` on
  // either side (nothing between detection and display writes it), so gating this solely on
  // `fact.status` left the exact facts `mem review` told the user to resolve unreachable by the
  // command it told them to resolve them with. Deriving live, the way `formatReview` does, is the
  // one-source-of-truth fix rather than a second definition of "contested" that could drift from it.
  const detectionPool = listFacts(db, { status: ["active", "pinned", "contested"] });
  const { groups } = detectContradictions(detectionPool);
  const liveContestedGroup = groups.find(
    (group) => group.resolution === "contested" && group.factIds.includes(fact.id)
  );
  const isContested = fact.status === "contested" || liveContestedGroup !== undefined;
  if (!REVIEW_RESOLVABLE_STATUSES.includes(fact.status) && !isContested) {
    throw new UsageError(
      `fact ${fact.id} is not pending or contested (status=${fact.status}) -- only withheld facts can be promoted`
    );
  }
  if (isContested && key !== undefined) {
    throw new UsageError(`fact ${fact.id} is contested, so it is already keyed -- use \`mem edit ${fact.id} --subject <key> --value <value>\` to change its key`);
  }
  if (isContested) {
    // A fact whose persisted status is still `contested` but which no longer sits in a live
    // contested group (its rival was forgotten or edited away) has no rivals to supersede here --
    // that reinstatement is `reconcileContradictions`'s job, not this command's.
    const rivals =
      liveContestedGroup !== undefined
        ? detectionPool.filter((other) => other.id !== fact.id && liveContestedGroup.factIds.includes(other.id))
        : [];
    const restored: FactStatus = fact.prior_status === "pinned" ? "pinned" : "active";
    setStatusWithAudit(
      db,
      fact.id,
      restored,
      "review_promote",
      withReason(`resolved contested contradiction in this fact's favor via explicit review (restored to ${restored})`, reason)
    );
    for (const rival of rivals) {
      setStatusWithAudit(
        db,
        rival.id,
        "superseded",
        "review_promote",
        withReason(
          `${SUPERSEDED_BY_FACT_PREFIX}${fact.id}: contested contradiction resolved in that fact's favor via explicit review.`,
          reason
        )
      );
    }
    // A contested fact is keyed by construction -- it only reached a contradiction group by having a
    // subject -- so the unkeyed caveat below cannot apply to this branch.
    return { id: fact.id };
  }
  if (key === undefined) {
    setStatusWithAudit(db, fact.id, "active", "review_promote", withReason("promoted pending fact to active via explicit review", reason));
  } else {
    // Keying, activation, and the contradiction pass the new key makes the fact eligible for commit together, so no reader sees it keyed but pending or active but unreconciled.
    const tx = db.transaction((): void => {
      const keyed = updateFact(db, fact.id, key);
      if (keyed === undefined) {
        throw new UsageError(`no such fact: ${fact.id}`);
      }
      setStatusWithAudit(db, fact.id, "active", "review_promote", withReason(`promoted pending fact to active via explicit review; keyed ${keyed.subject ?? ""}=${keyed.value ?? ""}`, reason));
      reconcileContradictions(db, "review_promote");
    });
    // BEGIN IMMEDIATE: `updateFact` reads before writing; see storage.insertFact.
    tx.immediate();
  }
  const unkeyed = key === undefined && (fact.subject === null || fact.subject === undefined);
  return { id: fact.id, ...(unkeyed ? { note: unkeyedPromotionNote(fact.id) } : {}) };
}

/**
 * `mem review --reject <id>`: discard a withheld fact (soft-delete, kept for audit).
 *
 * Rejecting one side of a contested group can leave the group unambiguous, so the reconciliation
 * pass runs afterwards to reinstate any survivor that is no longer contested -- otherwise the
 * survivor would stay withheld with nothing left to contest it until the next `mem epoch --gc`.
 */
export function rejectPending(db: Database.Database, id: string, reason?: string): string {
  const fact = resolveIdArgOrThrow(db, id);
  // Same live-derived definition of "contested" as `promotePending`, and for the same reason: a
  // precedence tie `formatReview` already shows as contested may not have persisted that status yet.
  const detectionPool = listFacts(db, { status: ["active", "pinned", "contested"] });
  const { groups } = detectContradictions(detectionPool);
  const isContested =
    fact.status === "contested" ||
    groups.some((group) => group.resolution === "contested" && group.factIds.includes(fact.id));
  if (!REVIEW_RESOLVABLE_STATUSES.includes(fact.status) && !isContested) {
    throw new UsageError(
      `fact ${fact.id} is not pending or contested (status=${fact.status}) -- only withheld facts can be rejected`
    );
  }
  setStatusWithAudit(
    db,
    fact.id,
    "superseded",
    "review_reject",
    withReason(`rejected ${fact.status} fact (superseded) via explicit review`, reason)
  );
  if (isContested) {
    reconcileContradictions(db, "review_reject");
  }
  return fact.id;
}

/** The audit event `rejectPending` writes. An undo is only offered for a rejection, so this is the marker that identifies one. */
const REVIEW_REJECT_EVENT = "review_reject";

/**
 * `mem review --undo <id>`: put a fact rejected through review back where it was.
 *
 * Review is a two-key decision made one key at a time, and `--reject` was the only irreversible one:
 * it marks the fact `superseded`, and `--promote` refuses anything that is not `pending` or
 * `contested`, so a mis-typed id or a rejection the user changed their mind about could not be
 * walked back through the CLI at all -- only by hand-editing the database or round-tripping a
 * `mem export`. A review queue whose reject key is unrecoverable is one users are right to hesitate
 * over, which defeats the queue.
 *
 * Restores `prior_status` (`pending` when the column predates this fact), so a rejected `contested`
 * fact returns to `contested` rather than being quietly upgraded to `pending` by the undo.
 *
 * Deliberately scoped to rejections, not a general un-forget: `mem forget` is a considered decision
 * about a fact the user chose to keep, and reversing that is a different question from correcting a
 * slip in a review queue. A superseded fact that got there any other way is refused by name, so the
 * error says which mechanism claimed it rather than silently doing nothing.
 */
export function undoReject(db: Database.Database, id: string, reason?: string): string {
  const fact = resolveIdArgOrThrow(db, id);
  if (fact.status !== "superseded") {
    throw new UsageError(`fact ${fact.id} is not rejected (status=${fact.status}) -- there is nothing to undo`);
  }
  const history = listAuditLogForFact(db, fact.id);
  const last = history[history.length - 1];
  if (last?.event !== REVIEW_REJECT_EVENT) {
    throw new UsageError(
      `fact ${fact.id} was not rejected through review (last recorded action: ${last?.event ?? "none"}) -- ` +
        `--undo reverses \`mem review --reject\` only`
    );
  }
  const restored = fact.prior_status ?? "pending";
  setStatusWithAudit(
    db,
    fact.id,
    restored,
    "review_undo",
    withReason(`undid review rejection, restored to ${restored}`, reason)
  );
  if (restored === "contested") {
    reconcileContradictions(db, "review_undo");
  }
  return fact.id;
}
