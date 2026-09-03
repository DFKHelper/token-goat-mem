/**
 * A small deterministic PRNG (mulberry32), used so the eval fixture corpus and scenario queries
 * are generated the same way on every run given the same seed -- no hand-written 400-fact JSON
 * blob to keep in sync, and no run-to-run noise in the precision/nDCG numbers this harness reports.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks a uniformly random element of `items` using `rng`. */
export function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) {
    throw new Error("pick: items must be non-empty");
  }
  return item;
}

/** Picks `n` distinct elements of `items` (without replacement) using `rng`. */
export function pickN<T>(rng: () => number, items: readonly T[], n: number): T[] {
  const pool = [...items];
  const result: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const index = Math.floor(rng() * pool.length);
    result.push(...pool.splice(index, 1));
  }
  return result;
}

/** True with probability `p` (0..1), using `rng`. */
export function chance(rng: () => number, p: number): boolean {
  return rng() < p;
}
