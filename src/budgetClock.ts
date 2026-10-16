/** The clock every retrieval deadline reads: the anchor time budget, the embedding timer budget and the hint seam's soft budget. In production it is the monotonic clock (`performance.now`), so a wall-clock step (NTP, a manual change, a VM resume) cannot fire a budget early or stall it; its values are only ever subtracted from each other, never compared with a calendar time. A test freezes it (tests/setup/freeze-budget-clock.ts), so a budget then never runs out unless it is 0 and a slow machine cannot turn a correct answer into an exhausted one. It is for deadline arithmetic only: captured_at, `valid-until` and every other timestamp keep `Date.now`. */
export function budgetNow(): number {
  return performance.now();
}
