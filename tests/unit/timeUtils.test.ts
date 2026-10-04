import { describe, expect, it } from "vitest";

import { ageInDays, daysAgoIso, formatAge, MS_PER_DAY, parseStrictIsoTimestamp } from "../../src/timeUtils.js";

const NOW = new Date("2026-09-30T12:00:00.000Z");

describe("parseStrictIsoTimestamp", () => {
  it("accepts a full ISO-8601 timestamp with Z or a numeric offset and a bare calendar date", () => {
    expect(parseStrictIsoTimestamp("2026-01-02T03:04:05.000Z")).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(parseStrictIsoTimestamp("2026-01-02T03:04Z")).toBe(Date.UTC(2026, 0, 2, 3, 4));
    expect(parseStrictIsoTimestamp("2026-01-02T05:04:05+02:00")).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(parseStrictIsoTimestamp("2026-01-02")).toBe(Date.UTC(2026, 0, 2));
  });

  it("rejects what Date parses leniently or into a different instant", () => {
    for (const raw of [
      "hello 5",
      "Release 3",
      "last tuesday",
      "",
      "-000001-01-01T00:00:00Z",
      "26-01-02T03:04:05Z",
      "2026-01-02T03:04:05",
      "2026-02-30T00:00:00Z",
      "2026-02-30",
      "2026-13-01T00:00:00Z",
      "2026-01-02T24:00:00Z",
      "2026-01-02T03:60:00Z",
      "2026-01-02T03:04:05+25:00",
      "2026/01/02",
    ]) {
      expect(parseStrictIsoTimestamp(raw), raw).toBeNull();
    }
  });
});

describe("daysAgoIso", () => {
  it("returns the ISO instant exactly N days before now", () => {
    expect(daysAgoIso(1, NOW)).toBe("2026-09-29T12:00:00.000Z");
    expect(daysAgoIso(90, NOW)).toBe("2026-07-02T12:00:00.000Z");
  });

  it("accepts fractional days", () => {
    expect(daysAgoIso(0.5, NOW)).toBe("2026-09-30T00:00:00.000Z");
  });

  it("clamps a huge day count to the valid Date range instead of throwing", () => {
    const result = daysAgoIso(200_000_000, NOW);
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");
    expect(result).toMatch(/T.*Z$/);
  });
});

describe("ageInDays", () => {
  it("measures fractional days from an ISO timestamp or epoch milliseconds", () => {
    expect(ageInDays("2026-09-29T00:00:00.000Z", NOW)).toBe(1.5);
    expect(ageInDays(NOW.getTime() - 3 * MS_PER_DAY, NOW)).toBe(3);
  });

  it("round-trips with daysAgoIso", () => {
    expect(ageInDays(daysAgoIso(42, NOW), NOW)).toBe(42);
  });
});

describe("formatAge", () => {
  it("reads in the largest whole unit that is at least one", () => {
    expect(formatAge(30_000)).toBe("<1m");
    expect(formatAge(5 * 60_000)).toBe("5m");
    expect(formatAge(3 * 3_600_000)).toBe("3h");
    expect(formatAge(2 * MS_PER_DAY + 3_600_000)).toBe("2d");
  });

  it("clamps a negative age -- a clock that moved backwards -- to the smallest bucket", () => {
    expect(formatAge(-5_000)).toBe("<1m");
  });
});
