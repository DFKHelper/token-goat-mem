/** Guards the two ways an edit to a `CREATE TABLE IF NOT EXISTS` block can break every database already on disk while leaving a suite that starts from an empty file entirely green. `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists. So a schema change reaches an existing user's store only through `migrations.ts`'s `runMigrations` steps, and only for the changes `ALTER TABLE` is capable of expressing: - a new column IS expressible, but only if someone remembers to add the matching ALTER; - a widened `CHECK (... IN (...))` enum is NOT expressible at all, because a CHECK is frozen into the table at creation time and `ALTER TABLE` cannot amend one. Neither failure is visible to a test that creates its database from scratch: `CREATE TABLE` does all the work there, and the migration path is never taken. These tests therefore build their fixtures by *removing* schema from a live database rather than by hand-writing an old one -- a hand-written copy of an old schema drifts from the real one and starts agreeing with whatever migration it was written alongside, which is precisely how this class of defect survives review. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { insertFact, openStorage } from "../../src/storage.js";

type Db = Database.Database;

let workDir: string;
let counter = 0;

let templateDir: string;
let templatePath: string;

// Building a fully migrated store costs a WAL conversion and a full schema pass with their fsyncs, which dominated the per-column loop on a slow disk; the loop copies this one closed store instead, so each column pays only for the reopen under test.
beforeAll(() => {
  templateDir = mkdtempSync(join(tmpdir(), "mem-schema-template-"));
  templatePath = join(templateDir, "template.db");
  openStorage(templatePath).close();
});

afterAll(() => {
  rmSync(templateDir, { recursive: true, force: true });
});

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mem-schema-"));
  counter = 0;
});

afterEach(() => {
  // Deliberately not retried. This delete failing is a signal, not noise: it was how `openStorage`'s leaked handle first surfaced, since a store this file could not delete was a store still held open by a failed open. Swallowing that with retries would have hidden the defect.
  rmSync(workDir, { recursive: true, force: true });
});

/** A fully migrated store at a path no other test in this file is using. */
function freshStore(): { db: Db; path: string } {
  const path = join(workDir, `mem-${(counter += 1)}.db`);
  return { db: openStorage(path), path };
}

function columnsOf(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name);
}

function userTables(db: Db): string[] {
  return (
    db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all()
  ).map((row) => row.name);
}

/** Every column with no `applyIdempotentAlter` behind it, so a database whose table predates the column would never receive it. Derived by measurement, not from reading the schema. All of these are safe today for one of two reasons, and a name joining the list is only safe if one of them still applies: - the column has existed since the first published release, so no database in the wild lacks it; or - its whole table is younger than the column, and `CREATE TABLE IF NOT EXISTS` creates a *missing* table complete. (`fact_terms` arrived in 3ad56d0, after v0.1.0, and is created whole.) A column added to a table that already shipped satisfies neither, and needs an ALTER. */
const COLUMNS_WITHOUT_A_MIGRATION: readonly string[] = [
  "anchor_cache.verdict",
  "anchor_cache.verified_at",
  "anchor_cache.witness",
  "audit_log.created_at",
  "audit_log.detail",
  "audit_log.event",
  "audit_log.fact_id",
  "fact_links.discovered_at",
  "fact_links.similarity",
  "fact_terms.fact_id",
  "fact_terms.kind",
  "fact_terms.term",
  "fact_terms.term_key",
  "facts.anchor",
  "facts.captured_at",
  "facts.confidence",
  "facts.embedding",
  "facts.kind",
  "facts.scope",
  "facts.scope_root",
  "facts.source_ref",
  "facts.source_type",
  "facts.status",
  "facts.subject",
  "facts.text",
  "facts.value",
  "meta.value",
  "recall_log.fact_id",
  "recall_log.session_id",
  "recall_log.surfaced_at",
  "sources.excerpt",
  "sources.fact_id",
  "sources.stored_at",
];

type ColumnRef = { table: string; column: string; name: string; indexed: boolean };

/** What one reopen reported: the columns SQLite refused to drop, and which of the rest are present afterwards (`null` when the reopen itself threw, so nothing can be read, with the thrown error in `failure`). */
type ReopenResult = { refused: string[]; kept: string[] | null; failure: string | null };

/** Drops every given column from one throwaway copy of the migrated store, resets `user_version`, reopens through the real open path once, and reports what came back. Dropping a column is the faithful way to manufacture "a database from before this column existed": it leaves every other artefact of a real store intact -- other tables, indexes, constraints, the seeded epoch row -- where a hand-written fixture would have to reproduce all of them correctly. */
function reopenWithoutColumns(entries: readonly ColumnRef[]): ReopenResult {
  const path = join(workDir, `mem-${(counter += 1)}.db`);
  copyFileSync(templatePath, path);
  // A bare handle rather than `openStorage`: the copy is already migrated, so opening it through the real path here would only repeat the schema pass the reopen below is there to measure.
  const db = new Database(path);
  // Every DROP below is its own commit and a full-sync WAL commit costs an fsync, which is the slow part on a loaded Windows disk; this copy is thrown away, so durability buys nothing here.
  db.pragma("synchronous = OFF");
  const refused: string[] = [];
  try {
    // SQLite refuses to drop an indexed column, which would leave most of the schema untestable. Dropping the table's indexes first is faithful rather than a dodge: `CREATE INDEX IF NOT EXISTS` runs on every open, so a real database is where indexes come from in the first place, and rebuilding one over a missing column fails exactly the way the missing column should.
    const tables = [...new Set(entries.map((entry) => entry.table))];
    const dropped = new Set<string>();
    for (const table of tables) {
      try {
        for (const { name } of db
          .prepare<[string], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL"
          )
          .all(table)) {
          db.exec(`DROP INDEX ${name}`);
        }
        dropped.add(table);
      } catch {
        // A table whose indexes cannot be dropped leaves its columns untestable, the same as a refused DROP COLUMN.
      }
    }
    for (const entry of entries) {
      try {
        if (!dropped.has(entry.table)) {
          throw new Error("indexes not dropped");
        }
        db.exec(`ALTER TABLE ${entry.table} DROP COLUMN ${entry.column}`);
      } catch {
        refused.push(entry.name);
      }
    }
    // `freshStore()` already ran every migration, so `user_version` sits at the latest version and migrations.ts's `runMigrations` would otherwise see nothing pending on reopen and skip every step -- including the one that would restore `column`. Resetting it to `0` here is what makes this fixture a faithful "database that predates this column" rather than "a database with a column missing that nothing will ever look at again": every real pre-phase-1 database reads `user_version = 0` too, since nothing set it before this phase existed.
    db.pragma("user_version = 0");
  } finally {
    db.close();
  }
  let reopened: Db;
  try {
    reopened = openStorage(path);
  } catch (error) {
    return { refused, kept: null, failure: String(error) };
  }
  try {
    const kept = entries
      .filter((entry) => !refused.includes(entry.name) && columnsOf(reopened, entry.table).includes(entry.column))
      .map((entry) => entry.name);
    return { refused, kept, failure: null };
  } finally {
    reopened.close();
  }
}

/** Drops `table.column` alone and reports whether it came back on reopen. `null` means SQLite refused the drop (primary key, or backing an index), so the column cannot be tested this way. Callers assert on which columns those are rather than ignoring them. A reopen that throws counts as `false`, and is the worse half of this failure class rather than a separate one: `openDb` writes to `meta.value` unconditionally, so a database missing a column the open path itself touches does not merely answer queries wrong, it cannot be opened at all. */
function survivesReopenWithoutColumn(entry: ColumnRef): boolean | null {
  const { refused, kept } = reopenWithoutColumns([entry]);
  if (refused.length > 0) {
    return null;
  }
  return kept !== null && kept.length === 1;
}

/** Measures every planned column in as few reopens as is sound: one reopen over every column still unmeasured, and one reopen per column otherwise. A batch is conclusive only when its reopen did not throw and the result is exactly the expectation (a column with a migration came back, one without did not), and that implies the per-column answers because restoring a column is independent of which others are missing: `migrations.ts`'s `addColumn` asks `hasColumn` about that one column alone, `CREATE TABLE IF NOT EXISTS` never fires for a table that still exists, and a missing column can only add failures to a reopen, never remove them, so a column that came back with everything else missing also comes back alone and one that stayed missing also stays missing alone. A batch whose reopen throws names one missing column ("no such column: x", from an index or backfill over it) and says nothing about the rest, so every column of that name is measured alone, exactly as before, and dropped from the batch before it is retried; a reopen that names nothing usable, a column SQLite would not drop in the batch, or a mismatch sends the unmeasured columns to the per-column walk, so a failure still names the offending column. The error text only chooses which columns to measure alone and can never make an answer weaker. */
function measureColumns(plan: readonly ColumnRef[]): { kept: boolean | null; name: string }[] {
  const answers = new Map<string, boolean | null>();
  const expected = (entry: ColumnRef): boolean => !COLUMNS_WITHOUT_A_MIGRATION.includes(entry.name);
  // An indexed column is the usual thrower, since the reopen rebuilds its index over the missing column, so those go straight to the per-column walk instead of costing a failed batch each.
  for (const entry of plan.filter((candidate) => candidate.indexed)) {
    answers.set(entry.name, survivesReopenWithoutColumn(entry));
  }
  let remaining = plan.filter((entry) => !answers.has(entry.name));
  while (remaining.length > 0) {
    const batch = reopenWithoutColumns(remaining);
    let alone: ColumnRef[];
    if (batch.kept === null) {
      const named = /no such column: (\w+)/.exec(batch.failure ?? "")?.[1];
      alone = remaining.filter((entry) => batch.refused.includes(entry.name) || entry.column === named);
    } else if (remaining.every((entry) => batch.refused.includes(entry.name) || batch.kept?.includes(entry.name) === expected(entry))) {
      for (const entry of remaining.filter((candidate) => !batch.refused.includes(candidate.name))) {
        answers.set(entry.name, expected(entry));
      }
      alone = remaining.filter((entry) => batch.refused.includes(entry.name));
    } else {
      alone = remaining;
    }
    if (alone.length === 0 && remaining.some((entry) => !answers.has(entry.name))) {
      alone = remaining.filter((entry) => !answers.has(entry.name));
    }
    for (const entry of alone) {
      answers.set(entry.name, survivesReopenWithoutColumn(entry));
    }
    remaining = remaining.filter((entry) => !answers.has(entry.name));
  }
  return plan.map((entry) => ({ name: entry.name, kept: answers.get(entry.name) ?? null }));
}

describe("opening a database that predates a schema change", () => {
  it("restores exactly the columns a migration is responsible for, with nothing out of reach", () => {
    const { db } = freshStore();
    const indexedNames = new Set(
      db
        .prepare<[], { name: string }>(
          "SELECT m.tbl_name || '.' || i.name AS name FROM sqlite_master AS m, pragma_index_info(m.name) AS i WHERE m.type = 'index' AND m.sql IS NOT NULL"
        )
        .all()
        .map((row) => row.name)
    );
    const plan = userTables(db).flatMap((table) =>
      (db.pragma(`table_info(${table})`) as { name: string; pk: number }[])
        .filter((column) => column.pk === 0)
        .map((column) => ({ table, column: column.name, name: `${table}.${column.name}`, indexed: indexedNames.has(`${table}.${column.name}`) }))
    );
    db.close();

    // One measurement, two assertions: the partition is a single fact about the schema, and re-deriving it per assertion would double the database builds for nothing.
    const outcomes = measureColumns(plan);
    const pick = (kept: boolean | null): string[] =>
      outcomes
        .filter((entry) => entry.kept === kept)
        .map((entry) => entry.name)
        .sort();

    // Every name here is a column an existing user's store never receives. Adding a column to a CREATE TABLE that already shipped puts it in this list and breaks that store: give it a migration step in `migrations.ts` instead of widening the constant, which is pinned so it cannot be used to wave a real gap through.
    expect(pick(false)).toEqual([...COLUMNS_WITHOUT_A_MIGRATION]);
    // The fixture's blind spot, kept empty on purpose: SQLite refuses DROP COLUMN on a PRIMARY KEY or UNIQUE column, and a column that lands here is silently unguarded by the assertion above.
    expect(pick(null)).toEqual([]);
  });

  it("keeps the epoch row and the aux tables a legacy store never had", () => {
    const { db, path } = freshStore();
    db.exec("DROP TABLE fact_terms");
    db.exec("DELETE FROM meta");
    // See the comment in `reopenWithoutColumns`: without this, `user_version` still reads the latest version from `freshStore()`'s own migration run, and `runMigrations` would see nothing pending on reopen -- masking exactly the loss this test manufactures.
    db.pragma("user_version = 0");
    db.close();

    const reopened = openStorage(path);
    try {
      expect(userTables(reopened)).toContain("fact_terms");
      // `openDb` seeds the epoch and `ensureStorageSchema` re-seeds it; a store that lost the row must not come back with a NULL epoch that every `epoch > n` comparison then mis-answers.
      expect(reopened.prepare("SELECT value FROM meta WHERE key = 'epoch'").get()).toEqual({ value: "0" });
    } finally {
      reopened.close();
    }
  });

  it("opens and inserts/reads facts.capture_root on a store that predates the column", () => {
    // A store built before `capture_root TEXT` existed on `facts` -- the generic column-by-column check above already proves this survives reopen; this test additionally proves the reopened store can actually insert and read a fact through it, not just carry the column.
    const { db, path } = freshStore();
    db.exec("ALTER TABLE facts DROP COLUMN capture_root");
    // See the comment in `reopenWithoutColumns`.
    db.pragma("user_version = 0");
    db.close();

    const reopened = openStorage(path);
    try {
      const inserted = insertFact(reopened, {
        text: "a fact written after a pre-capture_root store reopened",
        kind: "fact",
        scope: "path",
        scopeRoot: join(workDir, "some", "file.ts"),
        captureRoot: join(workDir, "some"),
        source_type: "user",
      });
      expect(inserted.captureRoot).toBe(join(workDir, "some"));
      const row = reopened.prepare("SELECT capture_root FROM facts WHERE id = ?").get(inserted.id);
      expect(row).toEqual({ capture_root: join(workDir, "some") });
    } finally {
      reopened.close();
    }
  });
});

/** The enum values frozen into every database ever created by mem. `ALTER TABLE` cannot amend a CHECK constraint, so widening any of these in the schema reaches new databases only; existing ones keep rejecting the new value with `CHECK constraint failed`. Adding a value therefore requires a table rebuild (create, copy, drop, rename) in `ensureStorageSchema`, and this list moves only once that rebuild exists. */
const FROZEN_ENUMS: Readonly<Record<string, readonly string[]>> = {
  kind: ["preference", "decision", "fact", "correction"],
  scope: ["global", "project", "path"],
  source_type: ["user", "derived"],
  status: ["active", "pending", "superseded", "contested", "pinned"],
};

describe("CHECK constraints are frozen once a database exists", () => {
  /** The `IN (...)` values SQLite has actually stored for each constrained column of `facts`. */
  function enumsOf(db: Db): Record<string, string[]> {
    const { sql } = db
      .prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'facts'")
      .get() as { sql: string };
    const found: Record<string, string[]> = {};
    for (const [, column, values] of sql.matchAll(/(\w+)\s+TEXT[^,]*?CHECK\s*\(\s*\1\s+IN\s*\(([^)]*)\)/gi)) {
      if (column === undefined || values === undefined) {
        throw new Error(`CHECK constraint matched without its column or value list: ${sql}`);
      }
      found[column] = [...values.matchAll(/'([^']*)'/g)].map((match) => match[1] as string);
    }
    return found;
  }

  it("still declares exactly the enum values every existing database was built with", () => {
    const { db } = freshStore();
    try {
      // Fails the moment someone widens an enum in FACTS_SCHEMA. That edit is not wrong in itself -- it is wrong *without* a rebuild migration, which is what this failure is here to demand.
      expect(enumsOf(db)).toEqual(FROZEN_ENUMS);
    } finally {
      db.close();
    }
  });

  it("rejects a value the constraint predates, proving the freeze is real", () => {
    const { db, path } = freshStore();
    // A store built when `status` allowed one fewer value: the honest way to show that reopening it does not, and cannot, widen the constraint.
    db.exec(`
      DROP TABLE facts;
      CREATE TABLE facts (
        id TEXT PRIMARY KEY, text TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('preference','decision','fact','correction')),
        subject TEXT, value TEXT,
        scope TEXT NOT NULL CHECK (scope IN ('global','project','path')) DEFAULT 'global',
        scope_root TEXT,
        source_type TEXT NOT NULL CHECK (source_type IN ('user','derived')),
        source_ref TEXT, captured_at TEXT NOT NULL, anchor TEXT,
        status TEXT NOT NULL CHECK (status IN ('active','superseded')) DEFAULT 'active',
        confidence REAL NOT NULL DEFAULT 1.0, embedding BLOB
      );`);
    db.close();

    const reopened = openStorage(path);
    try {
      expect(enumsOf(reopened)["status"]).toEqual(["active", "superseded"]);
      expect(() =>
        reopened
          .prepare(
            `INSERT INTO facts (id, text, kind, scope, source_type, captured_at, status, confidence)
             VALUES ('f1', 'x', 'fact', 'global', 'user', '2025-01-01T00:00:00Z', 'pending', 1.0)`
          )
          .run()
      ).toThrow(/CHECK constraint failed/i);
    } finally {
      reopened.close();
    }
  });
});
