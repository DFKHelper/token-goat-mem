import { describe, expect, it } from "vitest";

import { ageInDays, daysAgoIso, MS_PER_DAY } from "../../src/timeUtils.js";

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
