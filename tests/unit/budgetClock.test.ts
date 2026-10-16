import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { budgetNow } from "../../src/budgetClock.js";
import { startBudgetTimeout as startFrozenBudgetTimeout } from "../../src/budgetTimer.js";
import { retrieve, type EmbeddingBackend } from "../../src/retrieval.js";
import type { Fact } from "../../src/types.js";
import { makeFact } from "../support/fact.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-budget-clock-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const embedded = (): Fact[] => [makeFact({ id: "1", text: "uses pnpm not npm", kind: "preference", embedding: new Float32Array([1, 0]) })];

describe("the budget clock under the test setup", () => {
  it("is frozen: two reads agree, and a deadline built from Date.now() - 1 is already behind it", () => {
    expect(budgetNow()).toBe(budgetNow());
    expect(budgetNow()).toBeGreaterThanOrEqual(Date.now() - 1);
  });

  it("is the monotonic clock in production: the real module reads performance.now, not Date.now", async () => {
    const actual = await vi.importActual<typeof import("../../src/budgetClock.js")>("../../src/budgetClock.js");
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(42);
    const wall = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      expect(actual.budgetNow()).toBe(42);
    } finally {
      monotonic.mockRestore();
      wall.mockRestore();
    }
  });

  it("never expires the embedding budget while frozen, even for a backend that answers on a later timer", async () => {
    const slowBackend: EmbeddingBackend = { embed: () => new Promise<Float32Array>((resolve) => setTimeout(() => resolve(new Float32Array([1, 0])), 40)) };
    const outcome = await retrieve(embedded(), { query: "pnpm", root, embeddingBackend: slowBackend, embeddingTimeoutMs: 1 });
    expect(outcome.embeddingDegraded).toBe(false);
  });

  it("still exhausts an embedding budget of 0 while frozen, for a backend that never answers", async () => {
    const hungBackend: EmbeddingBackend = { embed: () => new Promise<Float32Array>(() => undefined) };
    const outcome = await retrieve(embedded(), { query: "pnpm", root, embeddingBackend: hungBackend, embeddingTimeoutMs: 0 });
    expect(outcome.embeddingDegraded).toBe(true);
  });
});

describe("the budget timer under the test setup", () => {
  const BUDGET_CLOCK_MODULE = "../../src/budgetClock.js";
  let clockMs = 1_000;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock(BUDGET_CLOCK_MODULE);
    vi.resetModules();
  });

  /** Loads the timer against a clock this test moves by hand, with timers faked, so a budget runs out only when the test says so. */
  async function loadTimerOnMovableClock(): Promise<typeof import("../../src/budgetTimer.js")> {
    vi.useFakeTimers();
    vi.resetModules();
    vi.doMock(BUDGET_CLOCK_MODULE, () => ({ budgetNow: () => clockMs }));
    return import("../../src/budgetTimer.js");
  }

  /** Loads the timer against the real budget clock, with only the timer functions faked so `Date` and `performance.now` are the test's to move. */
  async function loadTimerOnRealClock(): Promise<typeof import("../../src/budgetTimer.js")> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.resetModules();
    vi.doMock(BUDGET_CLOCK_MODULE, () => vi.importActual(BUDGET_CLOCK_MODULE));
    return import("../../src/budgetTimer.js");
  }

  it("never aborts a budget above 0 while the clock is frozen, however many timer wakes pass", () => {
    vi.useFakeTimers();
    const deadline = startFrozenBudgetTimeout(50);
    vi.advanceTimersByTime(10_000);
    expect(deadline.signal.aborted).toBe(false);
    deadline.clear();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a budget of 0 while the clock is frozen, with a TimeoutError reason", () => {
    vi.useFakeTimers();
    const deadline = startFrozenBudgetTimeout(0);
    vi.advanceTimersByTime(0);
    expect(deadline.signal.aborted).toBe(true);
    expect((deadline.signal.reason as Error).name).toBe("TimeoutError");
  });

  it("re-arms on a wake before the deadline and aborts once the clock reaches it", async () => {
    const { startBudgetTimeout } = await loadTimerOnMovableClock();
    clockMs = 1_000;
    const deadline = startBudgetTimeout(50);

    vi.advanceTimersByTime(50);
    expect(deadline.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    clockMs = 1_050;
    vi.advanceTimersByTime(50);
    expect(deadline.signal.aborted).toBe(true);
    expect((deadline.signal.reason as Error).name).toBe("TimeoutError");
    expect((deadline.signal.reason as Error).message).toContain("50ms");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the timer on clear, so a settled request leaves nothing re-arming", async () => {
    const { startBudgetTimeout } = await loadTimerOnMovableClock();
    clockMs = 1_000;
    const deadline = startBudgetTimeout(50);
    deadline.clear();
    expect(vi.getTimerCount()).toBe(0);
    clockMs = 2_000;
    vi.advanceTimersByTime(1_000);
    expect(deadline.signal.aborted).toBe(false);
  });

  it("unrefs the timer of a request deadline and keeps the loop-holding timer of a race", async () => {
    const { armBudgetTimer, startBudgetTimeout } = await loadTimerOnMovableClock();
    const spy = vi.spyOn(globalThis, "setTimeout");

    startBudgetTimeout(50).clear();
    armBudgetTimer(50, () => undefined, { unref: false })();

    const [requestTimer, raceTimer] = spy.mock.results.map((result) => result.value as { hasRef: () => boolean });
    expect(requestTimer?.hasRef()).toBe(false);
    expect(raceTimer?.hasRef()).toBe(true);
  });

  it("keeps the real clock monotonic: a wall-clock jump forward does not fire a budget that has not elapsed", async () => {
    const { startBudgetTimeout } = await loadTimerOnRealClock();
    const mono = vi.spyOn(performance, "now").mockReturnValue(5_000);
    const deadline = startBudgetTimeout(50);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);
    mono.mockReturnValue(5_010);
    vi.advanceTimersByTime(50);

    expect(deadline.signal.aborted).toBe(false);
    deadline.clear();
  });

  it("keeps the real clock monotonic: a wall-clock jump back does not stall a budget that has elapsed", async () => {
    const { startBudgetTimeout } = await loadTimerOnRealClock();
    const mono = vi.spyOn(performance, "now").mockReturnValue(5_000);
    const deadline = startBudgetTimeout(50);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() - 3_600_000);
    mono.mockReturnValue(5_050);
    vi.advanceTimersByTime(50);

    expect(deadline.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([Number.NaN, -5])("treats a budget of %s as exhausted: it expires once and never re-arms", async (ms) => {
    const { armBudgetTimer } = await loadTimerOnMovableClock();
    clockMs = 1_000;
    const onExpire = vi.fn();
    armBudgetTimer(ms, onExpire, { unref: false });

    vi.advanceTimersByTime(1_000);

    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never expires an infinite budget and arms no timer for it", async () => {
    const { armBudgetTimer } = await loadTimerOnMovableClock();
    clockMs = 1_000;
    const onExpire = vi.fn();
    const clear = armBudgetTimer(Number.POSITIVE_INFINITY, onExpire, { unref: false });

    vi.advanceTimersByTime(1_000);

    expect(onExpire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    clear();
  });
});
