import { describe, expect, it } from "vitest";

import { ageInDays, daysAgoIso, formatAge, MS_PER_DAY } from "../../src/timeUtils.js";

const NOW = new Date("2026-09-30T12:00:00.000Z");

describe("daysAgoIso", () => {
  it("returns the ISO instant exactly N days before now", () => {
    expect(daysAgoIso(1, NOW)).toBe("2026-09-29T12:00:00.000Z");
    expect(daysAgoIso(90, NOW)).toBe("2026-07-02T12:00:00.000Z");
  });

  it("accepts fractional days", () => {
    expect(daysAgoIso(0.5, NOW)).toBe("2026-09-30T00:00:00.000Z");
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
