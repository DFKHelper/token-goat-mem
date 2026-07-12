import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _clearAnchorMemoForTests } from "../../src/anchors.js";
import {
  computeBm25Scores,
  cosineSimilarity,
  reciprocalRankFusion,
  retrieve,
  type EmbeddingBackend,
} from "../../src/retrieval.js";
import type { Fact } from "../../src/types.js";

function makeFact(overrides: Partial<Fact> & Pick<Fact, "id" | "text" | "kind">): Fact {
  return {
    subject: null,
    value: null,
    scope: "project",
    source_type: "user",
    source_ref: null,
    captured_at: "2026-01-01T00:00:00.000Z",
    anchor: null,
    status: "active",
    confidence: 1,
    embedding: null,
    ...overrides,
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-retrieval-"));
  _clearAnchorMemoForTests();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("computeBm25Scores", () => {
  it("scores an exact-match document above an unrelated one", () => {
    const docs = [
      makeFact({ id: "a", text: "uses pnpm not npm", kind: "preference" }),
      makeFact({ id: "b", text: "staging DB host is prod-staging-db-1", kind: "fact" }),
    ];
    const scores = computeBm25Scores(docs, "pnpm");
    expect(scores.get("a")).toBeGreaterThan(scores.get("b") ?? 0);
    expect(scores.get("b")).toBe(0);
  });

  it("returns all zeros for an empty query", () => {
    const docs = [makeFact({ id: "a", text: "uses pnpm", kind: "preference" })];
    const scores = computeBm25Scores(docs, "");
    expect(scores.get("a")).toBe(0);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors and 0 for orthogonal vectors", () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
  });

  it("returns 0 for a zero vector", () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });
});

describe("reciprocalRankFusion", () => {
  it("boosts an id that ranks well in both lists over one that ranks well in only one", () => {
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["a", "c", "b"],
    ]);
    expect(fused.get("a")).toBeGreaterThan(fused.get("b") ?? 0);
    expect(fused.get("a")).toBeGreaterThan(fused.get("c") ?? 0);
  });

  it("gives partial credit to an id present in only one list", () => {
    const fused = reciprocalRankFusion([["a", "b"], ["a"]]);
    expect(fused.get("a")).toBeGreaterThan(fused.get("b") ?? 0);
  });
});

describe("retrieve", () => {
  it("marks a fact with no anchor as unverified/hint, with an unverified display", async () => {
    const facts = [makeFact({ id: "1", text: "chose Postgres over Mongo", kind: "decision" })];
    const [result] = await retrieve(facts, { query: "postgres", root });
    expect(result?.freshness).toBe("unverified");
    expect(result?.trust).toBe("hint");
    expect(result?.display).toContain("(unverified, 2026-01)");
  });

  it("surfaces a decision plainly (no verify caveat) once its anchor affirms it", async () => {
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({ id: "1", text: "chose Postgres over Mongo", kind: "decision", anchor: "file-exists present.txt" }),
    ];
    const [result] = await retrieve(facts, { query: "postgres", root });
    expect(result?.freshness).toBe("affirmed");
    expect(result?.trust).toBe("ground-truth");
    expect(result?.display).toBe("decision: chose Postgres over Mongo — mem show 1");
  });

  it("omits the trailing CTA from display when includeDisplayCta is false (integration-seam.ts TGMEM/2)", async () => {
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({ id: "1", text: "chose Postgres over Mongo", kind: "decision", anchor: "file-exists present.txt" }),
    ];
    const [result] = await retrieve(facts, { query: "postgres", root, includeDisplayCta: false });
    expect(result?.display).toBe("decision: chose Postgres over Mongo");
  });

  it("hintStyle 'full' (default/explicit) is byte-identical to today's format", async () => {
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({ id: "1", text: "chose Postgres over Mongo", kind: "decision", anchor: "file-exists present.txt" }),
    ];
    const [defaulted] = await retrieve(facts, { query: "postgres", root });
    const [explicit] = await retrieve(facts, { query: "postgres", root, hintStyle: "full" });
    expect(defaulted?.display).toBe("decision: chose Postgres over Mongo — mem show 1");
    expect(explicit?.display).toBe(defaulted?.display);
  });

  it("hintStyle 'terse' drops the CTA and shortens kind labels to the wire-tag set (pref/dec/fact/corr)", async () => {
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({ id: "1", text: "chose Postgres over Mongo", kind: "decision", anchor: "file-exists present.txt" }),
      makeFact({ id: "2", text: "never run npm install here", kind: "correction" }),
      makeFact({ id: "3", text: "staging DB host is db.internal", kind: "fact" }),
    ];
    const results = await retrieve(facts, { query: "", root, hintStyle: "terse" });
    const byId = new Map(results.map((result) => [result.fact.id, result.display]));
    expect(byId.get("1")).toBe("dec: chose Postgres over Mongo");
    expect(byId.get("2")).toContain("corr (unverified, 2026-01): never run npm install here");
    expect(byId.get("2")).not.toContain("—");
    expect(byId.get("3")).not.toContain("—");
  });

  it("hintStyle 'terse' still applies the (verify) caveat to preferences, just without the CTA", async () => {
    writeFileSync(join(root, "pnpm-lock.yaml"), "x");
    const facts = [
      makeFact({
        id: "1",
        text: "uses pnpm not npm",
        kind: "preference",
        anchor: "file-exists pnpm-lock.yaml",
        subject: "package-manager",
        value: "pnpm",
      }),
    ];
    const now = new Date("2026-01-01T00:00:01.000Z");
    const [result] = await retrieve(facts, { query: "pnpm", root, now, hintStyle: "terse" });
    expect(result?.display).toBe("stored pref (verify): uses pnpm not npm");
  });

  it("always caveats a preference with (verify), even when affirmed", async () => {
    writeFileSync(join(root, "pnpm-lock.yaml"), "x");
    const facts = [
      makeFact({
        id: "1",
        text: "uses pnpm not npm",
        kind: "preference",
        anchor: "file-exists pnpm-lock.yaml",
        subject: "package-manager",
        value: "pnpm",
      }),
    ];
    const now = new Date("2026-01-01T00:00:01.000Z");
    const [result] = await retrieve(facts, { query: "pnpm", root, now });
    expect(result?.freshness).toBe("affirmed");
    expect(result?.trust).toBe("ground-truth");
    expect(result?.display).toBe("stored pref (verify): uses pnpm not npm — mem show 1");
  });

  it("withholds and caveats an anchor-contradicted fact", async () => {
    writeFileSync(join(root, "npm-only.txt"), "x");
    const facts = [
      makeFact({ id: "1", text: "uses pnpm not npm", kind: "preference", anchor: "file-absent npm-only.txt" }),
    ];
    const [result] = await retrieve(facts, { query: "pnpm", root });
    expect(result?.freshness).toBe("contradicted");
    expect(result?.trust).toBe("withheld");
    expect(result?.display).toContain("(contradicted, excluded)");
  });

  it("labels a pinned-but-contradicted fact distinctly", async () => {
    writeFileSync(join(root, "npm-only.txt"), "x");
    const facts = [
      makeFact({
        id: "1",
        text: "uses pnpm not npm",
        kind: "preference",
        anchor: "file-absent npm-only.txt",
        status: "pinned",
      }),
    ];
    const [result] = await retrieve(facts, { query: "pnpm", root });
    expect(result?.display).toContain("(pinned but contradicted)");
    expect(result?.trust).toBe("withheld");
  });

  it("never surfaces a superseded fact even if it matches the query", async () => {
    const facts = [
      makeFact({ id: "1", text: "uses npm", kind: "preference", status: "superseded", subject: "package-manager", value: "npm" }),
    ];
    const results = await retrieve(facts, { query: "npm", root });
    expect(results).toHaveLength(0);
  });

  it("shows a pending fact as unconfirmed in interactive mode but excludes it from hint-format", async () => {
    const facts = [makeFact({ id: "1", text: "uses tabs not spaces", kind: "preference", status: "pending" })];

    const interactive = await retrieve(facts, { query: "tabs", root });
    expect(interactive[0]?.trust).toBe("withheld");
    expect(interactive[0]?.display).toContain("(pending, unconfirmed)");

    const hintFormat = await retrieve(facts, { query: "tabs", root, hintFormat: true });
    expect(hintFormat).toHaveLength(0);
  });

  it("shows a contested fact as excluded in interactive mode but excludes it from hint-format", async () => {
    const facts: Fact[] = [
      makeFact({ id: "1", text: "uses npm", kind: "preference", subject: "package-manager", value: "npm", source_type: "user", captured_at: "2026-01-01T00:00:00.000Z" }),
      makeFact({ id: "2", text: "uses pnpm", kind: "preference", subject: "package-manager", value: "pnpm", source_type: "user", captured_at: "2026-01-01T00:00:00.000Z" }),
    ];

    const interactive = await retrieve(facts, { query: "package manager", root });
    expect(interactive).toHaveLength(2);
    for (const result of interactive) {
      expect(result.trust).toBe("withheld");
      expect(result.display).toContain("(contested, excluded)");
    }

    const hintFormat = await retrieve(facts, { query: "package manager", root, hintFormat: true });
    expect(hintFormat).toHaveLength(0);
  });

  it("resolves a deterministic contradiction to a single winner surfaced as ground-truth-eligible", async () => {
    const facts: Fact[] = [
      makeFact({ id: "old", text: "uses npm", kind: "preference", subject: "package-manager", value: "npm", captured_at: "2025-01-01T00:00:00.000Z" }),
      makeFact({ id: "new", text: "uses pnpm", kind: "preference", subject: "package-manager", value: "pnpm", captured_at: "2026-01-01T00:00:00.000Z" }),
    ];
    const results = await retrieve(facts, { query: "package manager", root });
    const ids = results.map((r) => r.fact.id);
    expect(ids).toEqual(["new"]);
    expect(results[0]?.trust).toBe("hint");
  });

  it("decays an old, unpinned preference from ground-truth to hint", async () => {
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({
        id: "1",
        text: "uses pnpm",
        kind: "preference",
        anchor: "file-exists present.txt",
        captured_at: "2020-01-01T00:00:00.000Z",
        confidence: 1,
      }),
    ];
    const farFuture = new Date("2027-01-01T00:00:00.000Z");
    const [result] = await retrieve(facts, { query: "pnpm", root, now: farFuture });
    expect(result?.freshness).toBe("affirmed");
    expect(result?.trust).toBe("hint");
  });

  it("does not decay a pinned preference", async () => {
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({
        id: "1",
        text: "uses pnpm",
        kind: "preference",
        anchor: "file-exists present.txt",
        captured_at: "2020-01-01T00:00:00.000Z",
        confidence: 1,
        status: "pinned",
      }),
    ];
    const farFuture = new Date("2027-01-01T00:00:00.000Z");
    const [result] = await retrieve(facts, { query: "pnpm", root, now: farFuture });
    expect(result?.trust).toBe("ground-truth");
  });

  it("does not decay decisions/facts", async () => {
    writeFileSync(join(root, "present.txt"), "x");
    const facts = [
      makeFact({
        id: "1",
        text: "chose Postgres over Mongo",
        kind: "decision",
        anchor: "file-exists present.txt",
        captured_at: "2020-01-01T00:00:00.000Z",
        confidence: 1,
      }),
    ];
    const farFuture = new Date("2027-01-01T00:00:00.000Z");
    const [result] = await retrieve(facts, { query: "postgres", root, now: farFuture });
    expect(result?.trust).toBe("ground-truth");
  });

  it("applies structural filters (kind, subject, scope, ageDays)", async () => {
    const facts: Fact[] = [
      makeFact({ id: "1", text: "uses pnpm", kind: "preference", subject: "package-manager", scope: "project", captured_at: "2026-01-01T00:00:00.000Z" }),
      makeFact({ id: "2", text: "chose Postgres", kind: "decision", subject: "database", scope: "global", captured_at: "2020-01-01T00:00:00.000Z" }),
    ];
    const now = new Date("2026-01-15T00:00:00.000Z");

    const byKind = await retrieve(facts, { query: "", root, kind: "decision", now });
    expect(byKind.map((r) => r.fact.id)).toEqual(["2"]);

    const bySubject = await retrieve(facts, { query: "", root, subject: "package-manager", now });
    expect(bySubject.map((r) => r.fact.id)).toEqual(["1"]);

    const byScope = await retrieve(facts, { query: "", root, scope: "global", now });
    expect(byScope.map((r) => r.fact.id)).toEqual(["2"]);

    const byAge = await retrieve(facts, { query: "", root, ageDays: 30, now });
    expect(byAge.map((r) => r.fact.id)).toEqual(["1"]);
  });

  it("applies limit after ranking", async () => {
    const facts = [
      makeFact({ id: "1", text: "fact one about pnpm", kind: "fact", captured_at: "2026-01-01T00:00:00.000Z" }),
      makeFact({ id: "2", text: "fact two about pnpm", kind: "fact", captured_at: "2026-01-02T00:00:00.000Z" }),
      makeFact({ id: "3", text: "fact three about pnpm", kind: "fact", captured_at: "2026-01-03T00:00:00.000Z" }),
    ];
    const results = await retrieve(facts, { query: "pnpm", root, limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("falls back to BM25-only when the embedding backend throws", async () => {
    const throwingBackend: EmbeddingBackend = {
      embed: () => {
        throw new Error("boom");
      },
    };
    const facts = [
      makeFact({ id: "1", text: "uses pnpm not npm", kind: "preference", embedding: new Float32Array([1, 0]) }),
    ];
    const results = await retrieve(facts, { query: "pnpm", root, embeddingBackend: throwingBackend });
    expect(results).toHaveLength(1);
    expect(results[0]?.fact.id).toBe("1");
  });

  it("fuses BM25 and embedding signals when an embedding backend is available", async () => {
    // "a" is a strong BM25 match but far in embedding space; "b" is a weak BM25 match but close in
    // embedding space to the (contrived) query vector. RRF fusion should let "b" compete with "a"
    // rather than BM25 alone dominating.
    const facts = [
      makeFact({ id: "a", text: "uses pnpm not npm for everything", kind: "fact", embedding: new Float32Array([0, 1]) }),
      makeFact({ id: "b", text: "irrelevant unrelated text", kind: "fact", embedding: new Float32Array([1, 0]) }),
    ];
    const backend: EmbeddingBackend = {
      embed: () => new Float32Array([1, 0]),
    };
    const results = await retrieve(facts, { query: "pnpm", root, embeddingBackend: backend });
    const ids = results.map((r) => r.fact.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    // b wins the embedding signal outright (cosine similarity 1 vs 0), and RRF gives it credit
    // even though it has zero BM25 score, so it should not rank last.
    expect(ids.indexOf("b")).toBeLessThan(1 + 1);
  });

  it("returns nothing when there are no candidate facts after filtering", async () => {
    const facts = [makeFact({ id: "1", text: "x", kind: "fact" })];
    const results = await retrieve(facts, { query: "x", root, kind: "decision" });
    expect(results).toHaveLength(0);
  });
});
