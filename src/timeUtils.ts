/** Day arithmetic shared by every age-based rule in mem: recall's `--age-days` window, preference decay, pin reconfirmation, `gc` retention, `consolidate --stale`, and `log --age-days`. One definition so the cutoffs those rules print and the cutoffs they filter on can never drift apart. Every helper takes `now` explicitly rather than reading the clock, so a caller that makes several decisions in one pass judges them all against the same instant. */

export const MS_PER_DAY = 86_400_000;

/** The ISO-8601 instant `days` before `now` -- the cutoff a "older than N days" rule compares against. */
export function daysAgoIso(days: number, now: Date): string {
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString();
}

/** Fractional days from `from` (an ISO timestamp or epoch milliseconds) to `now`. An unparseable timestamp yields `NaN`, which every caller already rejects with `Number.isFinite`. */
export function ageInDays(from: string | number, now: Date): number {
  const fromMs = typeof from === "number" ? from : Date.parse(from);
  return (now.getTime() - fromMs) / MS_PER_DAY;
}

/** A compact, human-readable age (`<1m`, `5m`, `3h`, `2d`) for status lines such as `mem doctor`'s. */
export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `${String(minutes)}m`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${String(hours)}h` : `${String(Math.floor(ms / MS_PER_DAY))}d`;
}
