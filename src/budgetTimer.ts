/** The timers that enforce a retrieval deadline on the budget clock: the race around an embedding backend and the abort signal on an embedding HTTP request. Both read `budgetNow` (src/budgetClock.ts), so a test that freezes that clock never runs a budget out, while in production they fire at the budget on a monotonic clock. */

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

/** The longest delay `setTimeout` accepts; a longer one is run after 1 ms, so a larger budget waits in slices of this size. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Runs `onExpire` once `ms` have passed on the budget clock, and returns the call that cancels the timer. The timer only wakes the check: a wake before the clock reaches the deadline re-arms for what is left, so a frozen clock never expires a budget above 0 while a budget of 0 is already exhausted. A budget that is NaN or negative is exhausted like 0, and an infinite one never expires and arms no timer. In production the clock is monotonic and this fires at `ms`. */
export function armBudgetTimer(ms: number, onExpire: () => void, options: BudgetTimerOptions): () => void {
  if (ms === Infinity) {
    return () => undefined;
  }
  const budgetMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const deadline = budgetNow() + budgetMs;
  let timer: ReturnType<typeof setTimeout>;
  const arm = (delayMs: number): void => {
    timer = setTimeout(() => {
      const remaining = deadline - budgetNow();
      if (remaining <= 0) {
        onExpire();
      } else {
        arm(remaining);
      }
    }, Math.min(delayMs, MAX_TIMER_DELAY_MS));
    if (options.unref) {
      timer.unref();
    }
  };
  arm(budgetMs);
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
