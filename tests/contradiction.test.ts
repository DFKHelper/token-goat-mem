import { describe, expect, it } from "vitest";

import {
  applyContradictionUpdates,
  detectContradictions,
  getGroundTruthFacts,
  resolveContradictions,
} from "../src/contradiction.js";
import type { Fact } from "../src/types.js";

function makeFact(overrides: Partial<Fact> & Pick<Fact, "id">): Fact {
  return {
    id: overrides.id,
    text: overrides.text ?? `fact ${overrides.id}`,
    kind: overrides.kind ?? "preference",
    subject: overrides.subject ?? null,
    value: overrides.value ?? null,
    scope: overrides.scope ?? "project",
    scopeRoot: overrides.scopeRoot ?? null,
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
  it("returns no groups or updates for facts with no subject/value overlap (happy path, no contradiction)", () => {
    const facts = [
      makeFact({ id: "a", subject: "package-manager", value: "pnpm" }),
      makeFact({ id: "b", subject: "test-framework", value: "vitest" }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
  });

  it("skips free-text facts without a subject/value key entirely", () => {
    const facts = [
      makeFact({ id: "a", text: "prefers concise commit messages" }),
      makeFact({ id: "b", text: "dislikes verbose commit messages" }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
  });

  it("does not treat matching subject+value across facts as a contradiction", () => {
    const facts = [
      makeFact({ id: "a", subject: "package-manager", value: "pnpm" }),
      makeFact({ id: "b", subject: "package-manager", value: "pnpm", captured_at: "2026-03-01T00:00:00.000Z" }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
  });

  it("keeps identical subjects in different scopes independent (no cross-scope contradiction)", () => {
    const facts = [
      makeFact({ id: "a", subject: "package-manager", value: "npm", scope: "global" }),
      makeFact({ id: "b", subject: "package-manager", value: "pnpm", scope: "project" }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
  });

  it("keeps identical subject+scope in different project roots independent (no cross-project contradiction)", () => {
    // Regression: mem's store is shared across every project, so two project-scoped facts with the
    // same subject but bound to *different* roots must not collide into one contradiction bucket --
    // otherwise `mem review` / `mem epoch --gc` would persist a supersede transition, silently
    // clobbering one project's fact because an unrelated project chose a different value.
    const facts = [
      makeFact({ id: "proj-a", subject: "package-manager", value: "npm", scope: "project", scopeRoot: "/home/me/project-a" }),
      makeFact({ id: "proj-b", subject: "package-manager", value: "pnpm", scope: "project", scopeRoot: "/home/me/project-b" }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
  });

  it("still resolves a conflict between two project-scoped facts bound to the SAME root", () => {
    const facts = [
      makeFact({ id: "old", subject: "package-manager", value: "npm", scope: "project", scopeRoot: "/home/me/project-a", captured_at: "2026-01-01T00:00:00.000Z" }),
      makeFact({ id: "new", subject: "package-manager", value: "pnpm", scope: "project", scopeRoot: "/home/me/project-a", captured_at: "2026-03-01T00:00:00.000Z" }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.resolution).toBe("resolved");
    expect(result.groups[0]?.winnerId).toBe("new");
    expect(result.updates).toEqual([expect.objectContaining({ factId: "old", nextStatus: "superseded" })]);
  });

  it("resolves same subject+scope, conflicting value by provenance: user beats derived regardless of timestamp", () => {
    const facts = [
      makeFact({
        id: "derived-newer",
        subject: "package-manager",
        value: "npm",
        source_type: "derived",
        captured_at: "2026-06-01T00:00:00.000Z",
      }),
      makeFact({
        id: "user-older",
        subject: "package-manager",
        value: "pnpm",
        source_type: "user",
        captured_at: "2026-01-01T00:00:00.000Z",
      }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      subject: "package-manager",
      scope: "project",
      resolution: "resolved",
      winnerId: "user-older",
    });
    expect(result.groups[0]?.factIds.sort()).toEqual(["derived-newer", "user-older"]);
    expect(result.updates).toEqual([
      expect.objectContaining({
        factId: "derived-newer",
        previousStatus: "active",
        nextStatus: "superseded",
      }),
    ]);
  });

  it("falls back to newer captured_at when provenance ranks are equal", () => {
    const facts = [
      makeFact({ id: "old", subject: "indent", value: "tabs", captured_at: "2026-01-01T00:00:00.000Z" }),
      makeFact({ id: "new", subject: "indent", value: "spaces", captured_at: "2026-05-01T00:00:00.000Z" }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups[0]).toMatchObject({ resolution: "resolved", winnerId: "new" });
    expect(result.updates).toEqual([
      expect.objectContaining({ factId: "old", nextStatus: "superseded" }),
    ]);
  });

  it("marks the entire subject+scope group contested when precedence is genuinely tied (same provenance rank, same captured_at) -- the module's key edge case", () => {
    const facts = [
      makeFact({ id: "a", subject: "test-framework", value: "vitest", captured_at: "2026-04-01T00:00:00.000Z" }),
      makeFact({ id: "b", subject: "test-framework", value: "jest", captured_at: "2026-04-01T00:00:00.000Z" }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      subject: "test-framework",
      resolution: "contested",
      winnerId: null,
    });
    expect(result.groups[0]?.factIds.sort()).toEqual(["a", "b"]);
    expect(result.updates).toHaveLength(2);
    for (const update of result.updates) {
      expect(update.nextStatus).toBe("contested");
      expect(update.previousStatus).toBe("active");
    }
  });

  it("resolves rather than contests when tied-top-precedence facts agree with each other and only a lower-precedence fact disagrees", () => {
    // Two independently-captured `user` facts tied in precedence (same provenance rank, same
    // captured_at) both say the SAME value; a third, clearly lower-precedence `derived` fact says
    // something different. There is no real ambiguity here -- the tied leaders agree with each
    // other -- so the shared value should win outright and only the outranked fact is superseded.
    const facts = [
      makeFact({
        id: "user-a",
        subject: "package-manager",
        value: "npm",
        source_type: "user",
        captured_at: "2026-04-01T00:00:00.000Z",
      }),
      makeFact({
        id: "user-b",
        subject: "package-manager",
        value: "npm",
        source_type: "user",
        captured_at: "2026-04-01T00:00:00.000Z",
      }),
      makeFact({
        id: "derived-old",
        subject: "package-manager",
        value: "pnpm",
        source_type: "derived",
        captured_at: "2026-01-01T00:00:00.000Z",
      }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      subject: "package-manager",
      resolution: "resolved",
    });
    expect(["user-a", "user-b"]).toContain(result.groups[0]?.winnerId);
    expect(result.updates).toEqual([
      expect.objectContaining({ factId: "derived-old", nextStatus: "superseded" }),
    ]);
  });

  it("still marks the tied facts contested when 3+ facts are tied for top precedence and disagree on value", () => {
    const facts = [
      makeFact({ id: "a", subject: "test-framework", value: "vitest", captured_at: "2026-04-01T00:00:00.000Z" }),
      makeFact({ id: "b", subject: "test-framework", value: "jest", captured_at: "2026-04-01T00:00:00.000Z" }),
      makeFact({ id: "c", subject: "test-framework", value: "mocha", captured_at: "2026-04-01T00:00:00.000Z" }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      subject: "test-framework",
      resolution: "contested",
      winnerId: null,
    });
    expect(result.groups[0]?.factIds.sort()).toEqual(["a", "b", "c"]);
    expect(result.updates).toHaveLength(3);
    for (const update of result.updates) {
      expect(update.nextStatus).toBe("contested");
    }
  });

  it("excludes already-contested facts from detection entirely, same as pending/superseded", () => {
    const facts = [
      makeFact({ id: "a", subject: "linter", value: "eslint", status: "contested" }),
      makeFact({ id: "b", subject: "linter", value: "biome", status: "contested" }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
  });

  it("treats pinned facts as fully participating in contradiction resolution -- pins are not exempt", () => {
    const facts = [
      makeFact({ id: "pinned", subject: "formatter", value: "prettier", status: "pinned" }),
      makeFact({
        id: "newer",
        subject: "formatter",
        value: "biome",
        captured_at: "2026-06-01T00:00:00.000Z",
      }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups[0]).toMatchObject({ resolution: "resolved", winnerId: "newer" });
    expect(result.updates).toEqual([
      expect.objectContaining({ factId: "pinned", previousStatus: "pinned", nextStatus: "superseded" }),
    ]);
  });

  it("excludes pending and already-superseded facts from participating in detection", () => {
    const facts = [
      makeFact({ id: "active", subject: "indent", value: "tabs" }),
      makeFact({ id: "pending", subject: "indent", value: "spaces", status: "pending" }),
      makeFact({ id: "superseded", subject: "indent", value: "spaces", status: "superseded" }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
  });

  it("resolves independent subject+scope buckets separately in the same call", () => {
    const facts = [
      makeFact({ id: "pm-derived", subject: "package-manager", value: "npm", source_type: "derived" }),
      makeFact({ id: "pm-user", subject: "package-manager", value: "pnpm", source_type: "user" }),
      makeFact({ id: "tf-a", subject: "test-framework", value: "vitest", captured_at: "2026-02-01T00:00:00.000Z" }),
      makeFact({ id: "tf-b", subject: "test-framework", value: "jest", captured_at: "2026-02-01T00:00:00.000Z" }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(2);
    const byResolution = new Map(result.groups.map((group) => [group.subject, group.resolution]));
    expect(byResolution.get("package-manager")).toBe("resolved");
    expect(byResolution.get("test-framework")).toBe("contested");
  });
});

describe("applyContradictionUpdates", () => {
  it("returns a shallow copy with no changes when there are no updates", () => {
    const facts = [makeFact({ id: "a" })];

    const result = applyContradictionUpdates(facts, []);

    expect(result).toEqual(facts);
    expect(result).not.toBe(facts);
  });

  it("applies status transitions to referenced facts and leaves unreferenced facts untouched by reference", () => {
    const facts = [
      makeFact({ id: "a", subject: "indent", value: "tabs" }),
      makeFact({ id: "b", text: "unrelated fact" }),
    ];

    const updated = applyContradictionUpdates(facts, [
      { factId: "a", previousStatus: "active", nextStatus: "superseded", reason: "test" },
    ]);

    expect(updated[0]?.status).toBe("superseded");
    expect(updated[0]).not.toBe(facts[0]);
    expect(updated[1]).toBe(facts[1]);
  });

  it("does not mutate the input array", () => {
    const facts = [makeFact({ id: "a", subject: "indent", value: "tabs" })];
    const original = facts[0];

    applyContradictionUpdates(facts, [
      { factId: "a", previousStatus: "active", nextStatus: "superseded", reason: "test" },
    ]);

    expect(facts[0]).toBe(original);
    expect(facts[0]?.status).toBe("active");
  });
});

describe("resolveContradictions", () => {
  it("combines detection and application into a fully-resolved fact list plus groups", () => {
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
  it("keeps only active and pinned facts, withholding pending, superseded, and contested", () => {
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

  it("never surfaces a fact that resolveContradictions just marked contested", () => {
    const facts = [
      makeFact({ id: "a", subject: "test-framework", value: "vitest" }),
      makeFact({ id: "b", subject: "test-framework", value: "jest" }),
    ];

    const { facts: resolved } = resolveContradictions(facts);

    expect(getGroundTruthFacts(resolved)).toHaveLength(0);
  });
});
