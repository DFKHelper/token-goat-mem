import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { openDb } from "../src/db.js";
import { MIGRATIONS, runMigrations } from "../src/migrations.js";

let root: string;
let dbPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-migrations-test-"));
  dbPath = join(root, "mem.db");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name);
}

function tablesOf(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

const HIGHEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

describe("runMigrations on a fresh database", () => {
  it("ends at the highest version with every table and column present", () => {
    const db = openDb(dbPath);
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(HIGHEST_VERSION);

      const tables = tablesOf(db);
      expect(tables).toEqual(
        expect.arrayContaining(["facts", "audit_log", "meta", "sources", "recall_log", "fact_terms", "anchor_cache"])
      );

      const factsColumns = columnsOf(db, "facts");
      expect(factsColumns).toEqual(
        expect.arrayContaining([
          "epoch",
          "scope_repo",
          "status_changed_at",
          "prior_status",
          "capture_root",
          "last_surfaced_at",
          "terms_checked_at",
          "sightings",
          "text_hash",
        ])
      );
      expect(columnsOf(db, "recall_log")).toContain("used_at");
      expect(columnsOf(db, "audit_log")).toContain("prior_json");
    } finally {
      db.close();
    }
  });

  it("running the migrations twice in a row is a no-op the second time", () => {
    const db = openDb(dbPath);
    try {
      // openDb already ran the migrations once on open; this second call must find nothing pending.
      const result = runMigrations(db);
      expect(result.applied).toEqual([]);
      expect(result.from).toBe(HIGHEST_VERSION);
      expect(result.to).toBe(HIGHEST_VERSION);
    } finally {
      db.close();
    }
  });

  it("stamps PRAGMA user_version, readable back", () => {
    const db = openDb(dbPath);
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(HIGHEST_VERSION);
    } finally {
      db.close();
    }
  });
});

describe("runMigrations on the upgrade path", () => {
  it("migrates an old-shape database, backfilling every baseline column without losing data", () => {
    // Build a database at the shape this phase's baseline migration exists to fix: only the
    // original `facts`/`audit_log`/`meta` columns, and `user_version` never set (reads `0`), the
    // same as every real database created before this migration runner existed.
    const db = openDb(dbPath);
    db.exec("ALTER TABLE facts DROP COLUMN epoch");
    db.exec("ALTER TABLE facts DROP COLUMN scope_repo");
    db.exec("ALTER TABLE facts DROP COLUMN status_changed_at");
    db.exec("ALTER TABLE facts DROP COLUMN prior_status");
    db.exec("ALTER TABLE facts DROP COLUMN capture_root");
    db.exec("ALTER TABLE facts DROP COLUMN last_surfaced_at");
    db.exec("ALTER TABLE facts DROP COLUMN terms_checked_at");
    db.exec("ALTER TABLE facts DROP COLUMN sightings");
    db.exec("DROP TABLE sources");
    db.exec("DROP TABLE recall_log");
    db.exec("DROP TABLE fact_terms");
    db.pragma("user_version = 0");

    db.prepare(
      `INSERT INTO facts (id, text, kind, subject, value, scope, scope_root, source_type, source_ref, captured_at, anchor, status, confidence)
       VALUES (@id, @text, @kind, @subject, @value, @scope, @scopeRoot, @source_type, @source_ref, @captured_at, @anchor, @status, @confidence)`
    ).run({
      id: "pre-phase-1-fact",
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
    db.close();

    const reopened = openDb(dbPath);
    try {
      expect(reopened.pragma("user_version", { simple: true })).toBe(HIGHEST_VERSION);
      expect(tablesOf(reopened)).toEqual(
        expect.arrayContaining(["sources", "recall_log", "fact_terms", "anchor_cache"])
      );
      expect(columnsOf(reopened, "facts")).toEqual(
        expect.arrayContaining([
          "epoch",
          "scope_repo",
          "status_changed_at",
          "prior_status",
          "capture_root",
          "last_surfaced_at",
          "terms_checked_at",
          "sightings",
          "text_hash",
        ])
      );

      const row = reopened.prepare("SELECT * FROM facts WHERE id = ?").get("pre-phase-1-fact") as Record<
        string,
        unknown
      >;
      expect(row["text"]).toBe("uses npm not pnpm");
      expect(row["subject"]).toBe("package-manager");
      expect(row["status"]).toBe("active");
      expect(row["captured_at"]).toBe("2025-01-01T00:00:00.000Z");
      expect(row["epoch"]).toBe(0); // backfilled sentinel, never a real write's epoch
      expect(row["sightings"]).toBe(0); // backfilled sentinel, same reasoning as epoch
      expect(row["scope_repo"]).toBeNull(); // no honest value to invent, so NULL
    } finally {
      reopened.close();
    }
  });

  it("migrates a database that already has every column but user_version = 0, without error or duplication", () => {
    // The real in-the-wild case: every applyIdempotentAlter-era database already carries every
    // baseline column (added on some earlier open, before this migration runner existed to stamp a
    // version), but has never had `user_version` set.
    const db = openDb(dbPath);
    db.pragma("user_version = 0");
    db.close();

    const reopened = openDb(dbPath);
    try {
      expect(reopened.pragma("user_version", { simple: true })).toBe(HIGHEST_VERSION);
      // Re-running ADD COLUMN against a column that was already there would throw "duplicate
      // column" under the old applyIdempotentAlter mechanism if the swallow ever regressed; here
      // it simply never runs, because hasColumn already found the column. Either way, this must
      // not throw and must not create a second copy of any table or index.
      const indexCount = (
        reopened
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_facts_text_hash'")
          .get() as { n: number }
      ).n;
      expect(indexCount).toBe(1);
    } finally {
      reopened.close();
    }
  });
});

describe("anchor_cache", () => {
  it("rejects a verdict outside the three allowed values", () => {
    const db = openDb(dbPath);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO anchor_cache (root, anchor, verdict, verified_at)
             VALUES ('/repo', 'some anchor', 'maybe', '2025-01-01T00:00:00.000Z')`
          )
          .run()
      ).toThrow(/CHECK constraint failed/i);

      expect(() =>
        db
          .prepare(
            `INSERT INTO anchor_cache (root, anchor, verdict, verified_at)
             VALUES ('/repo', 'some anchor', 'affirmed', '2025-01-01T00:00:00.000Z')`
          )
          .run()
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});
