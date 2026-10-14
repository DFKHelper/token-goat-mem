/** The timers that enforce a retrieval deadline on the budget clock: the race around an embedding backend and the abort signal on an embedding HTTP request. Both read `budgetNow` (src/budgetClock.ts), so a test that freezes that clock never runs a budget out, while in production they fire at the wall-clock budget. */

import { budgetNow } from "./budgetClock.js";

/** Whether the timer `armBudgetTimer` starts keeps the event loop alive while it waits. */
export interface BudgetTimerOptions {
  readonly unref: boolean;
}

/** A request deadline: a signal that aborts at the budget, and the call that stops its timer once the request has settled. */
export interface BudgetTimeout {
  readonly signal: AbortSignal;
  readonly clear: () => void;
}

/** Runs `onExpire` once `ms` have passed on the budget clock, and returns the call that cancels the timer. The timer only wakes the check: a wake before the clock reaches the deadline re-arms for what is left, so a frozen clock never expires a budget above 0 while a budget of 0 is already exhausted. In production the clock is the wall clock and this fires at `ms`. */
export function armBudgetTimer(ms: number, onExpire: () => void, options: BudgetTimerOptions): () => void {
  const deadline = budgetNow() + ms;
  let timer: ReturnType<typeof setTimeout>;
  const arm = (delayMs: number): void => {
    timer = setTimeout(() => {
      const remaining = deadline - budgetNow();
      if (remaining <= 0) {
        onExpire();
      } else {
        arm(remaining);
      }
    }, delayMs);
    if (options.unref) {
      timer.unref();
    }
  };
  arm(ms);
  return () => {
    clearTimeout(timer);
  };
}

/** The budget-clock counterpart of `AbortSignal.timeout`: the signal aborts the request it is passed to, so the socket closes, with a `TimeoutError` reason, and its timer is unref'd so it never holds the event loop open. `clear` stops the timer once the request has settled, which a frozen clock would otherwise leave re-arming. */
export function startBudgetTimeout(ms: number): BudgetTimeout {
  const controller = new AbortController();
  const clear = armBudgetTimer(ms, () => controller.abort(new DOMException(`The operation timed out after ${ms}ms`, "TimeoutError")), { unref: true });
  return { signal: controller.signal, clear };
}
