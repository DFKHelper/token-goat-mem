import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { budgetNow } from "../../src/budgetClock.js";
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

  it("is the wall clock in production: the real module reads Date.now", async () => {
    const actual = await vi.importActual<typeof import("../../src/budgetClock.js")>("../../src/budgetClock.js");
    const before = Date.now();
    const read = actual.budgetNow();
    expect(read).toBeGreaterThanOrEqual(before);
    expect(read).toBeLessThanOrEqual(Date.now());
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
