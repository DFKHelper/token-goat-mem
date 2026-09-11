import { describe, expect, it } from "vitest";

import {
  applyContradictionUpdates,
  computeContradictionBucketGroups,
  detectContradictions,
  getGroundTruthFacts,
  resolveContradictions,
  sameContradictionBucket,
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
    scopeRepo: overrides.scopeRepo ?? null,
    source_type: overrides.source_type ?? "user",
    source_ref: overrides.source_ref ?? null,
    captured_at: overrides.captured_at ?? "2026-01-01T00:00:00.000Z",
    anchor: overrides.anchor ?? null,
    status: overrides.status ?? "active",
    confidence: overrides.confidence ?? 1,
    embedding: overrides.embedding ?? null,
    status_changed_at: overrides.status_changed_at ?? null,
    prior_status: overrides.prior_status ?? null,
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

  it("resolves a conflict between two clones of the SAME repository (same scope_repo, different scope_root)", () => {
    // Reproduces the reported defect: two clones/worktrees of one upstream repo share a scope_repo
    // identity (src/projectIdentity.ts) but have different absolute scopeRoot paths. Recall already
    // widens a project fact's binding to match on scope_repo (isBoundToRoot/isInScope), so both facts
    // are served as current from either clone -- contradiction detection must key the same way or the
    // correction captured in the second clone never supersedes the decision it corrects.
    const facts = [
      makeFact({
        id: "clone-a",
        subject: "package-manager",
        value: "pnpm",
        scope: "project",
        scopeRoot: "/home/me/worktrees/a",
        scopeRepo: "github.com/acme/repo#.",
        captured_at: "2026-01-01T00:00:00.000Z",
      }),
      makeFact({
        id: "clone-b",
        subject: "package-manager",
        value: "npm",
        scope: "project",
        scopeRoot: "/home/me/worktrees/b",
        scopeRepo: "github.com/acme/repo#.",
        captured_at: "2026-03-01T00:00:00.000Z",
      }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.resolution).toBe("resolved");
    expect(result.groups[0]?.winnerId).toBe("clone-b");
    expect(result.updates).toEqual([expect.objectContaining({ factId: "clone-a", nextStatus: "superseded" })]);
  });

  it("keeps two DIFFERENT repositories independent when they share neither root nor repo", () => {
    // Mirror of "keeps identical subject+scope in different project roots independent" above, but
    // for the scope_repo-keyed branch: two unrelated repositories, at different roots with
    // different identities, must never collapse into one bucket.
    const facts = [
      makeFact({
        id: "repo-a",
        subject: "package-manager",
        value: "npm",
        scope: "project",
        scopeRoot: "/home/me/project-a",
        scopeRepo: "github.com/acme/repo-a#.",
      }),
      makeFact({
        id: "repo-b",
        subject: "package-manager",
        value: "pnpm",
        scope: "project",
        scopeRoot: "/home/me/project-b",
        scopeRepo: "github.com/acme/repo-b#.",
      }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
  });

  it("resolves a conflict between a legacy fact (scope_repo NULL) and a newer one at the SAME root", () => {
    // This is the primary, common-case regression a per-fact "scope_repo if present, else
    // scope_root" key would introduce: scope_repo shipped after this fact shape already existed
    // (or shipped before the project ever gained a remote), so every fact in an existing store has
    // scope_repo NULL. A correction captured at the same root after scope_repo starts being written
    // must still supersede the fact it corrects -- same normalized scope_root always shares a
    // bucket, independent of scope_repo, per computeProjectIdentityGroups's non-negotiable
    // invariant (src/contradiction.ts).
    const facts = [
      makeFact({
        id: "legacy",
        subject: "package-manager",
        value: "npm",
        scope: "project",
        scopeRoot: "/home/me/project",
        scopeRepo: null,
        captured_at: "2026-01-01T00:00:00.000Z",
      }),
      makeFact({
        id: "newer",
        subject: "package-manager",
        value: "pnpm",
        scope: "project",
        scopeRoot: "/home/me/project",
        scopeRepo: "github.com/acme/repo#.",
        captured_at: "2026-03-01T00:00:00.000Z",
      }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.resolution).toBe("resolved");
    expect(result.groups[0]?.winnerId).toBe("newer");
    expect(result.updates).toEqual([expect.objectContaining({ factId: "legacy", nextStatus: "superseded" })]);
  });

  it("bridges two clones that share neither root nor repo directly, through a same-directory fact that has both", () => {
    // Concrete case from computeProjectIdentityGroups's doc comment: X (root P, repo R) and Y (root
    // P, repo null) share a root; X and Z (root Q, repo R) share a repo; Y and Z share neither
    // directly. All three name one project and must resolve as a single three-way contradiction,
    // bridged through X -- not two separate, unresolved pairs.
    const x = makeFact({
      id: "x",
      subject: "package-manager",
      value: "pnpm",
      scope: "project",
      scopeRoot: "/w/p",
      scopeRepo: "github.com/acme/repo#.",
      captured_at: "2026-01-01T00:00:00.000Z",
    });
    const y = makeFact({
      id: "y",
      subject: "package-manager",
      value: "npm",
      scope: "project",
      scopeRoot: "/w/p",
      scopeRepo: null,
      captured_at: "2026-02-01T00:00:00.000Z",
    });
    const z = makeFact({
      id: "z",
      subject: "package-manager",
      value: "yarn",
      scope: "project",
      scopeRoot: "/w/q",
      scopeRepo: "github.com/acme/repo#.",
      captured_at: "2026-03-01T00:00:00.000Z",
    });

    const result = detectContradictions([x, y, z]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.factIds.slice().sort()).toEqual(["x", "y", "z"]);
    expect(result.groups[0]?.resolution).toBe("resolved");
    expect(result.groups[0]?.winnerId).toBe("z");
    expect(result.updates.map((u) => u.factId).sort()).toEqual(["x", "y"]);
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

  // Regression: `contested` used to be excluded from detection, which made the status
  // unfalsifiable -- nothing that could clear it could see it, so a fact stayed withheld from
  // ground truth forever even after the contradiction that caused it was gone.
  it("re-evaluates already-contested facts and emits nothing new while the contradiction still stands", () => {
    const facts = [
      makeFact({ id: "a", subject: "linter", value: "eslint", status: "contested" }),
      makeFact({ id: "b", subject: "linter", value: "biome", status: "contested" }),
    ];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ subject: "linter", resolution: "contested", winnerId: null });
    // Idempotent: the facts already hold the status this detection would assign.
    expect(result.updates).toHaveLength(0);
  });

  it("reinstates a contested fact once nothing is left to contest it", () => {
    const facts = [makeFact({ id: "survivor", subject: "linter", value: "eslint", status: "contested" })];

    const result = detectContradictions(facts);

    expect(result.groups).toHaveLength(0);
    expect(result.updates).toEqual([
      expect.objectContaining({ factId: "survivor", previousStatus: "contested", nextStatus: "active" }),
    ]);
  });

  it("reinstates a formerly-pinned contested fact to pinned, never silently downgrading the pin", () => {
    const facts = [
      makeFact({ id: "survivor", subject: "linter", value: "eslint", status: "contested", prior_status: "pinned" }),
    ];

    const result = detectContradictions(facts);

    expect(result.updates).toEqual([expect.objectContaining({ factId: "survivor", nextStatus: "pinned" })]);
  });

  it("supersedes rather than reinstates a contested fact that loses a now-resolvable bucket", () => {
    const facts = [
      makeFact({ id: "loser", subject: "linter", value: "biome", status: "contested", captured_at: "2026-01-01T00:00:00.000Z" }),
      makeFact({ id: "winner", subject: "linter", value: "eslint", status: "active", captured_at: "2026-06-01T00:00:00.000Z" }),
    ];

    const result = detectContradictions(facts);

    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]).toMatchObject({ factId: "loser", nextStatus: "superseded" });
  });

  it("reinstates a contested fact that was never keyed and so could never have been legitimately contested", () => {
    const facts = [makeFact({ id: "free-text", status: "contested" })];

    expect(detectContradictions(facts).updates).toEqual([
      expect.objectContaining({ factId: "free-text", nextStatus: "active" }),
    ]);
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

describe("sameContradictionBucket", () => {
  it("treats two facts with the same scope_repo but different scope_root as the same bucket", () => {
    const a = makeFact({ id: "a", subject: "package-manager", scope: "project", scopeRoot: "/w/a", scopeRepo: "github.com/acme/repo#." });
    const b = makeFact({ id: "b", subject: "package-manager", scope: "project", scopeRoot: "/w/b", scopeRepo: "github.com/acme/repo#." });
    const groups = computeContradictionBucketGroups([a, b]);

    expect(sameContradictionBucket(a, b, groups)).toBe(true);
  });

  it("DOES bucket a legacy fact (no scope_repo) with a same-directory fact that has a scope_repo", () => {
    // Non-negotiable: two facts at the same normalized scope_root always share a bucket, whatever
    // their scope_repo. scope_repo is unreleased at the time of this fix -- every fact in every
    // existing store has it NULL -- so treating "legacy, no scope_repo" as a rare edge case would in
    // fact split the ordinary single-checkout case for the entire installed base. A prior version of
    // this test asserted the opposite (false); that encoded exactly the regression this one pins.
    const legacy = makeFact({ id: "legacy", subject: "package-manager", scope: "project", scopeRoot: "/w/a", scopeRepo: null });
    const newer = makeFact({ id: "newer", subject: "package-manager", scope: "project", scopeRoot: "/w/a", scopeRepo: "github.com/acme/repo#." });
    const groups = computeContradictionBucketGroups([legacy, newer]);

    expect(sameContradictionBucket(legacy, newer, groups)).toBe(true);
  });

  it("does not bucket a legacy fact (no scope_repo) with a scope_repo fact from a DIFFERENT clone, absent a bridging fact", () => {
    const legacy = makeFact({ id: "legacy", subject: "package-manager", scope: "project", scopeRoot: "/w/a", scopeRepo: null });
    const otherClone = makeFact({ id: "other", subject: "package-manager", scope: "project", scopeRoot: "/w/b", scopeRepo: "github.com/acme/repo#." });
    const groups = computeContradictionBucketGroups([legacy, otherClone]);

    expect(sameContradictionBucket(legacy, otherClone, groups)).toBe(false);
  });

  it("bridges a legacy fact to a different clone once a same-directory, repo-tagged fact is present in the population", () => {
    // Same two facts as the "absent a bridging fact" case above, but this time the population also
    // contains a third fact at legacy's own root that carries the shared scope_repo -- the exact
    // bridge computeProjectIdentityGroups's doc comment describes. legacy and otherClone still share
    // neither field directly, but both now resolve to the same connected component through bridge.
    const legacy = makeFact({ id: "legacy", subject: "package-manager", scope: "project", scopeRoot: "/w/a", scopeRepo: null });
    const bridge = makeFact({ id: "bridge", subject: "package-manager", scope: "project", scopeRoot: "/w/a", scopeRepo: "github.com/acme/repo#." });
    const otherClone = makeFact({ id: "other", subject: "package-manager", scope: "project", scopeRoot: "/w/b", scopeRepo: "github.com/acme/repo#." });
    const groups = computeContradictionBucketGroups([legacy, bridge, otherClone]);

    expect(sameContradictionBucket(legacy, otherClone, groups)).toBe(true);
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
