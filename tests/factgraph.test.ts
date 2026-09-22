/**
 * Tests for `src/factgraph.ts` -- the `fact_terms` co-occurrence graph, its IDF-damped edge
 * weights, and the seeded propagation `getGraphScoresForQuery` runs over it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { getGraphScoresForQuery, neighbours, propagate } from "../src/factgraph.js";
import { getEntityOverlapForQuery, insertFact, openStorage, replaceFactTerms } from "../src/storage.js";
import type { Fact, FactKind } from "../src/types.js";

function seed(db: Database.Database, id: string, text: string, kind: FactKind = "fact"): Fact {
  return insertFact(db, { id, text, kind, scope: "global", source_type: "user" });
}

let root: string;
let db: Database.Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-factgraph-"));
  db = openStorage(join(root, "mem.db"));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("neighbours -- hub-term damping", () => {
  it("weighs a rare-term neighbour above a hub-term neighbour, both surviving the df ceiling", () => {
    // 10 facts total. "hub" sits on 6 (60%, right at the default 0.6 ceiling -- survives, but with
    // a low weight). "rare" sits on only 2 (f1 and f7), well clear of the ceiling, so its weight is
    // much larger. f1 carries both, so its edge to f7 (via "rare") must outrank every edge to
    // f2..f6 (via "hub" alone).
    const f1 = seed(db, "f1", "f1 text");
    const f2 = seed(db, "f2", "f2 text");
    const f3 = seed(db, "f3", "f3 text");
    const f4 = seed(db, "f4", "f4 text");
    const f5 = seed(db, "f5", "f5 text");
    const f6 = seed(db, "f6", "f6 text");
    const f7 = seed(db, "f7", "f7 text");
    seed(db, "f8", "f8 text");
    seed(db, "f9", "f9 text");
    seed(db, "f10", "f10 text");

    replaceFactTerms(db, f1.id, { entities: [], topics: ["hub", "rare"] });
    for (const fact of [f2, f3, f4, f5, f6]) {
      replaceFactTerms(db, fact.id, { entities: [], topics: ["hub"] });
    }
    replaceFactTerms(db, f7.id, { entities: [], topics: ["rare"] });

    const edges = neighbours(db, f1.id);
    const rareWeight = edges.get(f7.id) ?? 0;
    expect(edges.has(f7.id)).toBe(true);
    expect(rareWeight).toBeGreaterThan(0);
    for (const hubNeighbourId of [f2.id, f3.id, f4.id, f5.id, f6.id]) {
      expect(edges.has(hubNeighbourId)).toBe(true);
      expect(rareWeight).toBeGreaterThan(edges.get(hubNeighbourId) ?? 0);
    }
  });

  it("excludes a term above the df ceiling outright, dropping its edges entirely", () => {
    // 5 facts total; "megahub" covers 4 of them (80%, well past the default 0.6 ceiling). Two
    // megahub-sharing facts must not be neighbours through it -- the excluded term contributes no
    // edge at all, not just a small one.
    const f1 = seed(db, "f1", "f1 text");
    const f2 = seed(db, "f2", "f2 text");
    const f3 = seed(db, "f3", "f3 text");
    const f4 = seed(db, "f4", "f4 text");
    seed(db, "f5", "f5 text");

    for (const fact of [f1, f2, f3, f4]) {
      replaceFactTerms(db, fact.id, { entities: [], topics: ["megahub"] });
    }

    expect(neighbours(db, f1.id).size).toBe(0);
  });

  it("returns nothing for a fact with no extracted terms", () => {
    const lonely = seed(db, "lonely", "lonely text");
    expect(neighbours(db, lonely.id).size).toBe(0);
  });
});

describe("propagate", () => {
  it("terminates within its hop bound on a cyclic graph", () => {
    // A ring: f1-f2-f3-f4-f1, each edge a distinct rare term shared by exactly one adjacent pair,
    // so nothing here is excluded by the df ceiling and every node reaches every other node given
    // enough hops -- the loop must still stop after exactly `hops` rounds.
    const facts = ["f1", "f2", "f3", "f4"].map((id) => seed(db, id, `${id} text`));
    const ring: ReadonlyArray<readonly [string, string, string]> = [
      ["f1", "f2", "edge-a"],
      ["f2", "f3", "edge-b"],
      ["f3", "f4", "edge-c"],
      ["f4", "f1", "edge-d"],
    ];
    const termsByFact = new Map<string, string[]>();
    for (const [a, b, term] of ring) {
      termsByFact.set(a, [...(termsByFact.get(a) ?? []), term]);
      termsByFact.set(b, [...(termsByFact.get(b) ?? []), term]);
    }
    for (const fact of facts) {
      replaceFactTerms(db, fact.id, { entities: [], topics: termsByFact.get(fact.id) ?? [] });
    }

    const result = propagate(db, new Map([["f1", 1]]), { hops: 3 });
    expect(result.size).toBeGreaterThan(0);
    expect(result.get("f1")).toBeGreaterThan(0);
  });

  it("returns an empty map for empty seeds without touching the db", () => {
    expect(propagate(db, new Map()).size).toBe(0);
  });
});

describe("getGraphScoresForQuery", () => {
  it("surfaces a fact entity overlap alone does not", () => {
    // The query names "ProjectX" by entity. f-named carries that entity and is what entity overlap
    // finds. f-linked shares a rare topic term with f-named but never mentions "ProjectX" itself --
    // entity overlap has no way to find it, and propagation is the only signal that does.
    const named = seed(db, "f-named", "ProjectX uses a custom deploy script");
    const linked = seed(db, "f-linked", "the deploy script reads config from a vault");
    // Padding facts, not part of the shared term: with only `named` and `linked` in the store, the
    // shared term's df (2 of 2) exceeds the default 0.6 df ceiling and gets excluded outright. Four
    // total facts keeps df=2 under the ceiling (2.4) so the edge under test actually survives.
    seed(db, "f-other-1", "unrelated note about lunch");
    seed(db, "f-other-2", "unrelated note about the weather");

    replaceFactTerms(db, named.id, { entities: ["ProjectX"], topics: ["deploy-script-config"] });
    replaceFactTerms(db, linked.id, { entities: [], topics: ["deploy-script-config"] });

    const entityOverlap = getEntityOverlapForQuery(db, "ProjectX");
    expect(entityOverlap.has(linked.id)).toBe(false);

    const graphScores = getGraphScoresForQuery(db, "ProjectX");
    expect(graphScores.has(linked.id)).toBe(true);
    expect(graphScores.get(linked.id)).toBeGreaterThan(0);
  });

  it("returns an empty map for a query that names no entity, doing no graph work", () => {
    seed(db, "f1", "some fact with no matching identifier");
    expect(getGraphScoresForQuery(db, "no identifiers in this sentence at all").size).toBe(0);
    expect(getGraphScoresForQuery(db, "").size).toBe(0);
  });
});
