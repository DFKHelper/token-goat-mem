/** Day arithmetic shared by every age-based rule in mem: recall's `--age-days` window, preference decay, pin reconfirmation, `gc` retention, `consolidate --stale`, and `log --age-days`. One definition so the cutoffs those rules print and the cutoffs they filter on can never drift apart. Every helper takes `now` explicitly rather than reading the clock, so a caller that makes several decisions in one pass judges them all against the same instant. */

export const MS_PER_DAY = 86_400_000;

/** The ISO-8601 instant `days` before `now` -- the cutoff a "older than N days" rule compares against. */
export function daysAgoIso(days: number, now: Date): string {
  const epochMs = Math.max(now.getTime() - days * MS_PER_DAY, -8.64e15);
  return new Date(epochMs).toISOString();
}

const STRICT_ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2})))?$/u;

/** Epoch milliseconds for a strict ISO-8601 timestamp, or `null`. Accepts `YYYY-MM-DD` (UTC midnight) or `YYYY-MM-DDTHH:MM[:SS[.fff]]` followed by a required `Z` or numeric offset; needs a 4-digit year and rejects an out-of-range month, day (Feb 30), hour, minute, second, or offset. `new Date(raw)` is too lenient for a stored `captured_at`: it reads `"hello 5"` as 2001-05-01 and `"-000001-01-01T00:00:00Z"` as a year -1, silently back-dating a fact so it loses every recency comparison. */
export function parseStrictIsoTimestamp(raw: string): number | null {
  const match = STRICT_ISO_TIMESTAMP.exec(raw);
  if (match === null) {
    return null;
  }
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, , offsetHourStr, offsetMinuteStr] = match;
  const calendar = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1, Number(dayStr)));
  calendar.setUTCFullYear(Number(yearStr));
  if (calendar.getUTCFullYear() !== Number(yearStr) || calendar.getUTCMonth() !== Number(monthStr) - 1 || calendar.getUTCDate() !== Number(dayStr)) {
    return null;
  }
  if (Number(hourStr ?? "0") > 23 || Number(minuteStr ?? "0") > 59 || Number(secondStr ?? "0") > 59) {
    return null;
  }
  if (Number(offsetHourStr ?? "0") > 23 || Number(offsetMinuteStr ?? "0") > 59) {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
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
