import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  applyIdempotentAlter,
  ensureStorageSchema,
  openStorage,
  normalizeSubject,
  insertFact,
  getFactById,
  listFacts,
  countFacts,
  updateFact,
  setFactStatus,
  deleteFact,
  insertSource,
  listSourcesForFact,
  deleteSource,
  deleteSourcesForFact,
  deleteSourcesOlderThan,
  getEpoch,
} from "../src/storage.js";
import { openDb } from "../src/db.js";
import type { NewFact } from "../src/types.js";

let root: string;
let db: Database.Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-storage-test-"));
  db = openStorage(join(root, "mem.db"));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function baseFact(overrides: Partial<NewFact> = {}): NewFact {
  return {
    text: "uses pnpm not npm",
    kind: "preference",
    scope: "global",
    source_type: "user",
    ...overrides,
  };
}

describe("openStorage / ensureStorageSchema", () => {
  it("creates sources and meta tables with epoch seeded to 0", () => {
    expect(getEpoch(db)).toBe(0);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("sources");
    expect(names).toContain("meta");
    expect(names).toContain("facts");
  });

  it("is idempotent across repeated calls on the same connection", () => {
    ensureStorageSchema(db);
    ensureStorageSchema(db);
    expect(getEpoch(db)).toBe(0);
  });

  it("enables foreign key enforcement so sources cascade-deletes on fact delete", () => {
    const fkPragma = db.pragma("foreign_keys") as { foreign_keys: number }[];
    expect(fkPragma[0]?.foreign_keys).toBe(1);

    const fact = insertFact(db, baseFact());
    insertSource(db, { factId: fact.id, excerpt: "some raw excerpt" });
    expect(listSourcesForFact(db, fact.id)).toHaveLength(1);

    deleteFact(db, fact.id);
    expect(listSourcesForFact(db, fact.id)).toHaveLength(0);
  });
});

describe("facts.epoch migration (ensureStorageSchema, pre-migration database)", () => {
  it("backfills epoch=0 on pre-existing rows without touching their other columns, and is a no-op re-applied", () => {
    // Simulate a database written by a pre-migration build: open via db.ts's bare openDb() (which
    // creates `facts` from FACTS_SCHEMA -- no `epoch` column) and insert directly with raw SQL that
    // matches that old schema exactly, bypassing storage.ts's insertFact entirely (insertFact now
    // requires the epoch column and would fail against this schema, which is the point). Uses its
    // own file, separate from the `db`/`root` opened in `beforeEach`.
    const preMigrationPath = join(root, "pre-migration.db");
    const preMigrationDb = openDb(preMigrationPath);
    const columnsBefore = preMigrationDb
      .prepare("PRAGMA table_info(facts)")
      .all() as { name: string }[];
    expect(columnsBefore.map((c) => c.name)).not.toContain("epoch");

    preMigrationDb
      .prepare(
        `INSERT INTO facts (id, text, kind, subject, value, scope, scope_root, source_type, source_ref, captured_at, anchor, status, confidence)
         VALUES (@id, @text, @kind, @subject, @value, @scope, @scopeRoot, @source_type, @source_ref, @captured_at, @anchor, @status, @confidence)`
      )
      .run({
        id: "pre-migration-fact",
        text: "uses npm not pnpm",
        kind: "preference",
        subject: "package-manager",
        value: "npm",
        scope: "global",
        scopeRoot: null,
        source_type: "user",
        source_ref: null,
        captured_at: "2025-01-01T00:00:00.000Z",
        anchor: null,
        status: "active",
        confidence: 1,
      });
    preMigrationDb.close();

    // Re-open through storage.ts's real entry point -- this is what runs the migration in production
    // (cli.ts's withDb -> openStorage -> ensureStorageSchema).
    const migrated = openStorage(preMigrationPath);
    try {
      const columnsAfter = migrated.prepare("PRAGMA table_info(facts)").all() as { name: string }[];
      expect(columnsAfter.map((c) => c.name)).toContain("epoch");

      const preExisting = getFactById(migrated, "pre-migration-fact");
      expect(preExisting).toBeDefined();
      expect(preExisting?.text).toBe("uses npm not pnpm");
      expect(preExisting?.subject).toBe("package-manager");
      expect(preExisting?.status).toBe("active");
      expect(preExisting?.captured_at).toBe("2025-01-01T00:00:00.000Z");
      expect(preExisting?.epoch).toBe(0); // pre-migration sentinel, never a real write's epoch

      // Idempotent: re-running the migration against an already-migrated database is a no-op, not a
      // "duplicate column" crash, and does not disturb the backfilled row.
      expect(() => ensureStorageSchema(migrated)).not.toThrow();
      expect(getFactById(migrated, "pre-migration-fact")?.epoch).toBe(0);

      // A real write against the migrated database stamps a genuine (non-zero) epoch, always
      // strictly greater than the pre-migration sentinel -- so `--since-epoch 0` can distinguish
      // "written before the epoch column existed" from "written since".
      const fresh = insertFact(migrated, baseFact({ text: "fresh fact after migration" }));
      expect(fresh.epoch).toBeGreaterThan(0);
      expect(listFacts(migrated, { epochAfter: 0 }).map((f) => f.id)).toEqual([fresh.id]);
    } finally {
      migrated.close();
    }
  });
});

describe("applyIdempotentAlter", () => {
  it("swallows a duplicate-column failure on repeated application", () => {
    const sql = "ALTER TABLE sources ADD COLUMN note TEXT";
    applyIdempotentAlter(db, sql);
    expect(() => applyIdempotentAlter(db, sql)).not.toThrow();
  });

  it("propagates a non-duplicate-column error", () => {
    expect(() => applyIdempotentAlter(db, "ALTER TABLE not_a_real_table ADD COLUMN x TEXT")).toThrow();
  });
});

describe("normalizeSubject", () => {
  it("trims and lowercases", () => {
    expect(normalizeSubject("  Package-Manager  ")).toBe("package-manager");
    expect(normalizeSubject("package-manager")).toBe("package-manager");
  });
});

describe("insertFact / getFactById", () => {
  it("inserts a fact with defaults applied and bumps the epoch", () => {
    const fact = insertFact(db, baseFact());
    expect(fact.id).toBeTruthy();
    expect(fact.status).toBe("active");
    expect(fact.confidence).toBe(1.0);
    expect(fact.embedding).toBeNull();
    expect(fact.subject).toBeNull();
    expect(fact.value).toBeNull();
    expect(getEpoch(db)).toBe(1);

    const reread = getFactById(db, fact.id);
    expect(reread).toEqual(fact);
  });

  it("normalizes subject on insert", () => {
    const fact = insertFact(db, baseFact({ subject: "  Package Manager  ", value: "pnpm" }));
    expect(fact.subject).toBe("package manager");
    expect(fact.value).toBe("pnpm");
  });

  it("round-trips an embedding through pack/unpack without precision loss beyond float32", () => {
    const vec = new Float32Array([0.5, -1.25, 3.75, 0]);
    const fact = insertFact(db, baseFact({ embedding: vec }));
    expect(fact.embedding).not.toBeNull();
    expect(Array.from(fact.embedding as Float32Array)).toEqual(Array.from(vec));

    const reread = getFactById(db, fact.id);
    expect(Array.from(reread?.embedding as Float32Array)).toEqual(Array.from(vec));
  });

  it("returns undefined for a nonexistent id", () => {
    expect(getFactById(db, "does-not-exist")).toBeUndefined();
  });
});

describe("listFacts / countFacts", () => {
  it("filters by kind, subject, scope, status, and captured_at bounds (AND-ed)", () => {
    insertFact(db, baseFact({ text: "a", kind: "preference", subject: "x", value: "1", captured_at: "2026-01-01T00:00:00.000Z" }));
    insertFact(db, baseFact({ text: "b", kind: "fact", subject: "x", value: "2", captured_at: "2026-02-01T00:00:00.000Z" }));
    insertFact(db, baseFact({ text: "c", kind: "preference", scope: "project", captured_at: "2026-03-01T00:00:00.000Z" }));

    expect(listFacts(db, { kind: "preference" })).toHaveLength(2);
    expect(listFacts(db, { subject: "X" })).toHaveLength(2); // subject filter is normalized too
    expect(listFacts(db, { scope: "project" })).toHaveLength(1);
    expect(listFacts(db, { capturedAfter: "2026-01-15T00:00:00.000Z", capturedBefore: "2026-02-15T00:00:00.000Z" })).toHaveLength(1);
  });

  it("orders results newest captured_at first", () => {
    const older = insertFact(db, baseFact({ text: "older", captured_at: "2026-01-01T00:00:00.000Z" }));
    const newer = insertFact(db, baseFact({ text: "newer", captured_at: "2026-06-01T00:00:00.000Z" }));
    const rows = listFacts(db);
    expect(rows.map((f) => f.id)).toEqual([newer.id, older.id]);
  });

  it("respects limit", () => {
    insertFact(db, baseFact({ text: "a" }));
    insertFact(db, baseFact({ text: "b" }));
    insertFact(db, baseFact({ text: "c" }));
    expect(listFacts(db, { limit: 2 })).toHaveLength(2);
  });

  it("short-circuits to empty/zero for an empty status array instead of running status IN ()", () => {
    insertFact(db, baseFact());
    expect(listFacts(db, { status: [] })).toEqual([]);
    expect(countFacts(db, { status: [] })).toBe(0);
  });

  it("accepts a single status or an array of statuses", () => {
    const active = insertFact(db, baseFact({ text: "active one" }));
    const pending = insertFact(db, baseFact({ text: "pending one", status: "pending" }));
    expect(listFacts(db, { status: "active" }).map((f) => f.id)).toEqual([active.id]);
    const both = listFacts(db, { status: ["active", "pending"] }).map((f) => f.id).sort();
    expect(both).toEqual([active.id, pending.id].sort());
  });

  it("countFacts matches listFacts length for the same filter, ignoring limit", () => {
    insertFact(db, baseFact({ text: "a" }));
    insertFact(db, baseFact({ text: "b" }));
    expect(countFacts(db, { limit: 1 })).toBe(2);
    expect(listFacts(db, { limit: 1 })).toHaveLength(1);
  });

  it("epochAfter filters to facts written strictly after a given epoch (mem review --since-epoch)", () => {
    const first = insertFact(db, baseFact({ text: "first" })); // epoch 1
    const epochAfterFirst = first.epoch ?? 0;
    const second = insertFact(db, baseFact({ text: "second" })); // epoch 2
    expect(listFacts(db, { epochAfter: epochAfterFirst }).map((f) => f.id)).toEqual([second.id]);
    expect(countFacts(db, { epochAfter: epochAfterFirst })).toBe(1);
    expect(listFacts(db, { epochAfter: second.epoch ?? 0 })).toEqual([]);
  });
});

describe("updateFact", () => {
  it("applies only the provided fields and bumps the epoch", () => {
    const fact = insertFact(db, baseFact());
    const epochBefore = getEpoch(db);
    const updated = updateFact(db, fact.id, { text: "uses yarn now" });
    expect(updated?.text).toBe("uses yarn now");
    expect(updated?.kind).toBe(fact.kind);
    expect(getEpoch(db)).toBe(epochBefore + 1);
  });

  it("normalizes subject when updated, and clears a nullable field when explicitly set to null", () => {
    const fact = insertFact(db, baseFact({ subject: "package manager", value: "pnpm" }));
    const updated = updateFact(db, fact.id, { subject: "  New Subject  " });
    expect(updated?.subject).toBe("new subject");

    const cleared = updateFact(db, fact.id, { value: null });
    expect(cleared?.value).toBeNull();
  });

  it("is a no-op read (no epoch bump) when patch has no recognized fields", () => {
    const fact = insertFact(db, baseFact());
    const epochBefore = getEpoch(db);
    const result = updateFact(db, fact.id, {});
    expect(result).toEqual(fact);
    expect(getEpoch(db)).toBe(epochBefore);
  });

  it("returns undefined for a nonexistent id", () => {
    expect(updateFact(db, "does-not-exist", { text: "x" })).toBeUndefined();
  });
});

describe("setFactStatus", () => {
  it("sets status and bumps the epoch", () => {
    const fact = insertFact(db, baseFact());
    const epochBefore = getEpoch(db);
    const updated = setFactStatus(db, fact.id, "superseded");
    expect(updated?.status).toBe("superseded");
    expect(getEpoch(db)).toBe(epochBefore + 1);
  });

  it("supports transitioning a fact to contested (contradiction-resolution outcome)", () => {
    const fact = insertFact(db, baseFact({ subject: "package-manager", value: "pnpm" }));
    const updated = setFactStatus(db, fact.id, "contested");
    expect(updated?.status).toBe("contested");
  });

  it("returns undefined for a nonexistent id", () => {
    expect(setFactStatus(db, "does-not-exist", "pinned")).toBeUndefined();
  });
});

describe("deleteFact", () => {
  it("hard-deletes the fact, returns true, and bumps the epoch", () => {
    const fact = insertFact(db, baseFact());
    const epochBefore = getEpoch(db);
    expect(deleteFact(db, fact.id)).toBe(true);
    expect(getFactById(db, fact.id)).toBeUndefined();
    expect(getEpoch(db)).toBe(epochBefore + 1);
  });

  it("returns false and still bumps the epoch when the id does not exist", () => {
    const epochBefore = getEpoch(db);
    expect(deleteFact(db, "does-not-exist")).toBe(false);
    expect(getEpoch(db)).toBe(epochBefore + 1);
  });
});

describe("sources CRUD", () => {
  it("inserts, lists (newest first), and does not bump the write epoch", () => {
    const fact = insertFact(db, baseFact());
    const epochBefore = getEpoch(db);

    const older = insertSource(db, { factId: fact.id, excerpt: "first excerpt", storedAt: "2026-01-01T00:00:00.000Z" });
    const newer = insertSource(db, { factId: fact.id, excerpt: "second excerpt", storedAt: "2026-02-01T00:00:00.000Z" });

    expect(getEpoch(db)).toBe(epochBefore); // sources writes do not touch the epoch

    const sources = listSourcesForFact(db, fact.id);
    expect(sources.map((s) => s.id)).toEqual([newer.id, older.id]);
  });

  it("deleteSource removes one row and reports whether a row was deleted", () => {
    const fact = insertFact(db, baseFact());
    const source = insertSource(db, { factId: fact.id, excerpt: "excerpt" });
    expect(deleteSource(db, source.id)).toBe(true);
    expect(deleteSource(db, source.id)).toBe(false);
    expect(listSourcesForFact(db, fact.id)).toHaveLength(0);
  });

  it("deleteSourcesForFact removes every source row for a fact and returns the count", () => {
    const fact = insertFact(db, baseFact());
    insertSource(db, { factId: fact.id, excerpt: "one" });
    insertSource(db, { factId: fact.id, excerpt: "two" });
    expect(deleteSourcesForFact(db, fact.id)).toBe(2);
    expect(listSourcesForFact(db, fact.id)).toHaveLength(0);
  });

  it("deleteSourcesOlderThan deletes only rows stored before the cutoff", () => {
    const fact = insertFact(db, baseFact());
    insertSource(db, { factId: fact.id, excerpt: "old", storedAt: "2026-01-01T00:00:00.000Z" });
    insertSource(db, { factId: fact.id, excerpt: "new", storedAt: "2026-06-01T00:00:00.000Z" });
    const deleted = deleteSourcesOlderThan(db, "2026-03-01T00:00:00.000Z");
    expect(deleted).toBe(1);
    const remaining = listSourcesForFact(db, fact.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.excerpt).toBe("new");
  });
});

describe("getEpoch", () => {
  it("increments by exactly 1 per fact-table write, across insert/update/setStatus/delete", () => {
    expect(getEpoch(db)).toBe(0);
    const fact = insertFact(db, baseFact());
    expect(getEpoch(db)).toBe(1);
    updateFact(db, fact.id, { text: "changed" });
    expect(getEpoch(db)).toBe(2);
    setFactStatus(db, fact.id, "pinned");
    expect(getEpoch(db)).toBe(3);
    deleteFact(db, fact.id);
    expect(getEpoch(db)).toBe(4);
  });
});
