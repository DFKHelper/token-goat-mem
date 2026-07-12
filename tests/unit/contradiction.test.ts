import { describe, it, expect } from "vitest";
import {
  detectContradictions,
  applyContradictionUpdates,
  resolveContradictions,
  getGroundTruthFacts,
} from "../../src/contradiction.js";
import type { Fact } from "../../src/types.js";

function makeFact(overrides: Partial<Fact> & Pick<Fact, "id">): Fact {
  return {
    id: overrides.id,
    text: overrides.text ?? `fact ${overrides.id}`,
    kind: overrides.kind ?? "preference",
    subject: overrides.subject ?? null,
    value: overrides.value ?? null,
    scope: overrides.scope ?? "project",
    source_type: overrides.source_type ?? "user",
    source_ref: overrides.source_ref ?? null,
    captured_at: overrides.captured_at ?? "2026-01-01T00:00:00.000Z",
    anchor: overrides.anchor ?? null,
    status: overrides.status ?? "active",
    confidence: overrides.confidence ?? 1,
    embedding: overrides.embedding ?? null,
  };
}

describe("detectContradictions", () => {
  it("ignores facts without a subject/value key", () => {
    const facts = [
      makeFact({ id: "a", text: "likes tabs" }),
      makeFact({ id: "b", text: "likes spaces" }),
    ];
    const result = detectContradictions(facts);
    expect(result.groups).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
  });

  it("does not flag same subject with the same value as a contradiction", () => {
    const facts = [
      makeFact({ id: "a", subject: "package-manager", value: "pnpm" }),
      makeFact({ id: "b", subject: "package-manager", value: "pnpm", captured_at: "2026-02-01T00:00:00.000Z" }),
    ];
    const result = detectContradictions(facts);
    expect(result.groups).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
  });

  it("ignores different scopes even with the same subject and conflicting values", () => {
    const facts = [
      makeFact({ id: "a", subject: "package-manager", value: "npm", scope: "global" }),
      makeFact({ id: "b", subject: "package-manager", value: "pnpm", scope: "project" }),
    ];
    const result = detectContradictions(facts);
    expect(result.groups).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
  });

  it("resolves a conflict by preferring higher provenance (user over derived)", () => {
    const facts = [
      makeFact({ id: "derived", subject: "package-manager", value: "npm", source_type: "derived" }),
      makeFact({ id: "user", subject: "package-manager", value: "pnpm", source_type: "user" }),
    ];
    const result = detectContradictions(facts);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.resolution).toBe("resolved");
    expect(result.groups[0]?.winnerId).toBe("user");
    expect(result.updates).toEqual([
      expect.objectContaining({ factId: "derived", nextStatus: "superseded" }),
    ]);
  });

  it("resolves a conflict between equal-provenance facts by preferring the newer one", () => {
    const facts = [
      makeFact({ id: "old", subject: "package-manager", value: "npm", captured_at: "2026-01-01T00:00:00.000Z" }),
      makeFact({ id: "new", subject: "package-manager", value: "pnpm", captured_at: "2026-06-01T00:00:00.000Z" }),
    ];
    const result = detectContradictions(facts);
    expect(result.groups[0]?.resolution).toBe("resolved");
    expect(result.groups[0]?.winnerId).toBe("new");
    expect(result.updates).toEqual([
      expect.objectContaining({ factId: "old", nextStatus: "superseded" }),
    ]);
  });

  it("marks a tied conflict (same provenance, same timestamp) as contested for every fact in the group", () => {
    const facts = [
      makeFact({ id: "a", subject: "test-framework", value: "vitest" }),
      makeFact({ id: "b", subject: "test-framework", value: "jest" }),
    ];
    const result = detectContradictions(facts);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.resolution).toBe("contested");
    expect(result.groups[0]?.winnerId).toBeNull();
    expect(result.updates).toHaveLength(2);
    for (const update of result.updates) {
      expect(update.nextStatus).toBe("contested");
    }
  });

  it("treats pinned facts as fully participating in contradiction resolution, not exempt", () => {
    const facts = [
      makeFact({ id: "pinned", subject: "formatter", value: "prettier", status: "pinned" }),
      makeFact({ id: "newer", subject: "formatter", value: "biome", captured_at: "2026-06-01T00:00:00.000Z" }),
    ];
    const result = detectContradictions(facts);
    expect(result.groups[0]?.resolution).toBe("resolved");
    expect(result.groups[0]?.winnerId).toBe("newer");
    expect(result.updates).toEqual([
      expect.objectContaining({ factId: "pinned", nextStatus: "superseded" }),
    ]);
  });

  it("excludes pending and already-superseded facts from contradiction detection", () => {
    const facts = [
      makeFact({ id: "active", subject: "indent", value: "tabs" }),
      makeFact({ id: "pending", subject: "indent", value: "spaces", status: "pending" }),
      makeFact({ id: "superseded", subject: "indent", value: "spaces", status: "superseded" }),
    ];
    const result = detectContradictions(facts);
    expect(result.groups).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
  });
});

describe("applyContradictionUpdates", () => {
  it("applies status transitions and leaves untouched facts unchanged", () => {
    const facts = [
      makeFact({ id: "a", subject: "indent", value: "tabs" }),
      makeFact({ id: "b", text: "unrelated" }),
    ];
    const updated = applyContradictionUpdates(facts, [
      { factId: "a", previousStatus: "active", nextStatus: "superseded", reason: "test" },
    ]);
    expect(updated[0]?.status).toBe("superseded");
    expect(updated[1]).toBe(facts[1]);
  });
});

describe("resolveContradictions", () => {
  it("returns a fully-resolved fact list in one call", () => {
    const facts = [
      makeFact({ id: "derived", subject: "package-manager", value: "npm", source_type: "derived" }),
      makeFact({ id: "user", subject: "package-manager", value: "pnpm", source_type: "user" }),
    ];
    const { facts: resolved, groups } = resolveContradictions(facts);
    expect(groups).toHaveLength(1);
    expect(resolved.find((fact) => fact.id === "derived")?.status).toBe("superseded");
    expect(resolved.find((fact) => fact.id === "user")?.status).toBe("active");
  });
});

describe("getGroundTruthFacts", () => {
  it("withholds contested, pending, and superseded facts, keeping active and pinned", () => {
    const facts = [
      makeFact({ id: "active", status: "active" }),
      makeFact({ id: "pinned", status: "pinned" }),
      makeFact({ id: "pending", status: "pending" }),
      makeFact({ id: "superseded", status: "superseded" }),
      makeFact({ id: "contested", status: "contested" }),
    ];
    const groundTruth = getGroundTruthFacts(facts).map((fact) => fact.id);
    expect(groundTruth.sort()).toEqual(["active", "pinned"]);
  });

  it("never surfaces a fact that contradiction detection just marked contested", () => {
    const facts = [
      makeFact({ id: "a", subject: "test-framework", value: "vitest" }),
      makeFact({ id: "b", subject: "test-framework", value: "jest" }),
    ];
    const { facts: resolved } = resolveContradictions(facts);
    expect(getGroundTruthFacts(resolved)).toHaveLength(0);
  });
});
