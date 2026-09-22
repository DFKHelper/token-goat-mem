/**
 * The normalized-text key `storage.ts` and `migrations.ts` both need for fact deduplication.
 *
 * Lives in its own module, rather than in `storage.ts` where `normalizeFactText` used to be
 * defined, because `migrations.ts`'s `facts.text_hash` backfill step needs the exact same
 * normalization `storage.ts` uses on every write -- and `storage.ts` already imports
 * `migrations.ts` (for `runMigrations`), so `migrations.ts` importing back from `storage.ts` would
 * be circular. `storage.ts` re-exports `normalizeFactText` from here, so every existing caller's
 * `from "./storage.js"` import keeps working unchanged.
 */
import { createHash } from "node:crypto";

/**
 * Matching form for "is this the same statement said again".
 *
 * Deliberately conservative and deterministic: case folded, internal whitespace collapsed, and a
 * single trailing period dropped. Nothing semantic -- no stemming, no synonyms, no model. Two facts
 * that differ by a word are two facts, and the cost of being wrong here is a user's second, more
 * precise statement being swallowed as a repeat of their first.
 *
 * The single source of truth for the dedup key: `facts.text_hash` (see `hashFactText` below) is
 * derived from this function's output, on every write path and in the migration that backfills it.
 * Changing this normalization invalidates every previously-stored hash and requires a new migration
 * step to rebackfill `facts.text_hash` -- editing it in place silently leaves old rows keyed under
 * the stale normalization.
 */
export function normalizeFactText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/gu, " ").replace(/\.$/u, "");
}

/**
 * Deterministic key for `facts.text_hash`, derived from {@link normalizeFactText} so a lookup by
 * hash (`factsByTextHash`) can narrow to a small candidate set via the `idx_facts_text_hash` index
 * before comparing normalized text for equality -- the hash narrows, equality decides, so a
 * collision can never silently merge two distinct facts.
 */
export function hashFactText(text: string): string {
  return createHash("sha256").update(normalizeFactText(text)).digest("hex");
}
