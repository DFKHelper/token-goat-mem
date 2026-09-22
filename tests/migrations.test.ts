import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { openDb } from "../src/db.js";
import { hashFactText } from "../src/factText.js";
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
        expect.arrayContaining([
          "facts",
          "audit_log",
          "meta",
          "sources",
          "recall_log",
          "fact_terms",
          "anchor_cache",
          "fact_links",
        ])
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

describe("facts.text_hash backfill (v4)", () => {
  it("backfills every NULL text_hash row and leaves a re-run a no-op", () => {
    // Force the exact pre-v4 shape: text_hash present (v2) but NULL, as every row written before
    // this migration existed would be.
    const db = openDb(dbPath);
    db.prepare(
      `INSERT INTO facts (id, text, kind, scope, source_type, captured_at, status, confidence)
       VALUES ('needs-backfill', 'Uses PNPM  not npm.', 'preference', 'global', 'user', '2025-01-01T00:00:00.000Z', 'active', 1)`
    ).run();
    db.pragma("user_version = 3");
    db.close();

    const reopened = openDb(dbPath);
    try {
      const row = reopened.prepare("SELECT text_hash FROM facts WHERE id = ?").get("needs-backfill") as {
        text_hash: string | null;
      };
      expect(row.text_hash).toBe(hashFactText("Uses PNPM  not npm."));

      // Re-running must not touch an already-hashed row (nothing pending at user_version already
      // at HIGHEST_VERSION), and must not throw.
      const result = runMigrations(reopened);
      expect(result.applied).toEqual([]);
      const rowAgain = reopened.prepare("SELECT text_hash FROM facts WHERE id = ?").get("needs-backfill") as {
        text_hash: string | null;
      };
      expect(rowAgain.text_hash).toBe(hashFactText("Uses PNPM  not npm."));
    } finally {
      reopened.close();
    }
  });

  it("does not overwrite a hash a later write already computed", () => {
    // A row inserted directly at user_version 3 (text_hash column exists, but this row's own
    // insert already set it, unlike the backfill fixture above) must survive the v4 step
    // unchanged -- the backfill only ever touches `text_hash IS NULL` rows.
    const db = openDb(dbPath);
    db.prepare(
      `INSERT INTO facts (id, text, kind, scope, source_type, captured_at, status, confidence, text_hash)
       VALUES ('already-hashed', 'uses pnpm', 'preference', 'global', 'user', '2025-01-01T00:00:00.000Z', 'active', 1, 'not-a-real-hash')`
    ).run();
    db.pragma("user_version = 3");
    db.close();

    const reopened = openDb(dbPath);
    try {
      const row = reopened.prepare("SELECT text_hash FROM facts WHERE id = ?").get("already-hashed") as {
        text_hash: string | null;
      };
      expect(row.text_hash).toBe("not-a-real-hash");
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

describe("fact_links (v5)", () => {
  it("upgrades an existing v4 database, with rows already present, to v5 without loss", () => {
    // A real store immediately before this phase: baseline through the v4 text_hash backfill, with
    // facts and their fact_terms rows already written -- `findRelatedFactPairs`/`upsertFactLink`
    // read exactly this shape on their first run after upgrade.
    const db = openDb(dbPath);
    db.prepare(
      `INSERT INTO facts (id, text, kind, scope, source_type, captured_at, status, confidence)
       VALUES ('pre-v5-a', 'uses pnpm', 'preference', 'global', 'user', '2025-01-01T00:00:00.000Z', 'active', 1),
              ('pre-v5-b', 'we use pnpm here', 'preference', 'global', 'user', '2025-01-02T00:00:00.000Z', 'active', 1)`
    ).run();
    db.exec("DROP TABLE fact_links");
    db.pragma("user_version = 4");
    db.close();

    const reopened = openDb(dbPath);
    try {
      expect(reopened.pragma("user_version", { simple: true })).toBe(HIGHEST_VERSION);
      expect(tablesOf(reopened)).toContain("fact_links");
      const factRow = reopened.prepare("SELECT text FROM facts WHERE id = ?").get("pre-v5-a") as { text: string };
      expect(factRow.text).toBe("uses pnpm"); // pre-existing rows survive the upgrade untouched
      expect(
        reopened.prepare("SELECT COUNT(*) AS n FROM fact_links").get() as { n: number }
      ).toEqual({ n: 0 }); // the new table starts empty; nothing backfills a discovered relation
    } finally {
      reopened.close();
    }
  });

  it("re-running the migration is a no-op and does not recreate the table or its index", () => {
    const db = openDb(dbPath); // already at HIGHEST_VERSION, fact_links created once
    try {
      const result = runMigrations(db);
      expect(result.applied).toEqual([]);
      const indexCount = (
        db
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_fact_links_b'")
          .get() as { n: number }
      ).n;
      expect(indexCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("enforces canonical pair order at the schema level, not just by convention", () => {
    const db = openDb(dbPath);
    try {
      db.prepare(
        `INSERT INTO facts (id, text, kind, scope, source_type, captured_at, status, confidence)
         VALUES ('a', 'fact a', 'preference', 'global', 'user', '2025-01-01T00:00:00.000Z', 'active', 1),
                ('b', 'fact b', 'preference', 'global', 'user', '2025-01-01T00:00:00.000Z', 'active', 1)`
      ).run();
      expect(() =>
        db
          .prepare("INSERT INTO fact_links (fact_id_a, fact_id_b, similarity, discovered_at) VALUES ('b', 'a', 0.3, '2025-01-01T00:00:00.000Z')")
          .run()
      ).toThrow(/CHECK constraint failed/i);
      expect(() =>
        db
          .prepare("INSERT INTO fact_links (fact_id_a, fact_id_b, similarity, discovered_at) VALUES ('a', 'b', 0.3, '2025-01-01T00:00:00.000Z')")
          .run()
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});
