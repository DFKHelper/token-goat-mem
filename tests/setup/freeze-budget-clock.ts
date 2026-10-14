import { vi } from "vitest";

/** The value the budget clock reads for the whole run: far past any real epoch ms, so a deadline a test builds from `Date.now() - 1` is already behind it and stays expired. */
const FROZEN_BUDGET_NOW_MS = 1e15;

/** Freezes the clock every retrieval deadline reads (`budgetNow` in src/budgetClock.ts), for every test file and every in-process `runCli`. A frozen clock never runs a budget out unless the budget is 0 (the deadline is then `now + 0`, which `>=` already reached), so the 100 ms anchor budget and the 200 ms embedding budget no longer depend on how fast the machine is. A spawned bundle cannot see this mock; it keeps the `TOKEN_GOAT_MEM_RETRIEVAL_BUDGET_MS` pin in isolate-home.ts. `tests/guards/seam-budget.test.ts` requires this mock to exist and be wired into vitest. */
vi.mock("../../src/budgetClock.js", () => ({ budgetNow: () => FROZEN_BUDGET_NOW_MS }));
