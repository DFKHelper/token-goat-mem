/**
 * Guards the two ways an edit to a `CREATE TABLE IF NOT EXISTS` block can break every database
 * already on disk while leaving a suite that starts from an empty file entirely green.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists. So a schema change
 * reaches an existing user's store only through `ensureStorageSchema`'s `applyIdempotentAlter`
 * calls, and only for the changes `ALTER TABLE` is capable of expressing:
 *
 *  - a new column IS expressible, but only if someone remembers to add the matching ALTER;
 *  - a widened `CHECK (... IN (...))` enum is NOT expressible at all, because a CHECK is frozen
 *    into the table at creation time and `ALTER TABLE` cannot amend one.
 *
 * Neither failure is visible to a test that creates its database from scratch: `CREATE TABLE` does
 * all the work there, and the migration path is never taken. These tests therefore build their
 * fixtures by *removing* schema from a live database rather than by hand-writing an old one -- a
 * hand-written copy of an old schema drifts from the real one and starts agreeing with whatever
 * migration it was written alongside, which is precisely how this class of defect survives review.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStorage } from "../../src/storage.js";
import type { Db } from "../../src/storage.js";

let workDir: string;
let counter = 0;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mem-schema-"));
  counter = 0;
});

afterEach(() => {
  // Deliberately not retried. This delete failing is a signal, not noise: it was how `openStorage`'s
  // leaked handle first surfaced, since a store this file could not delete was a store still held
  // open by a failed open. Swallowing that with retries would have hidden the defect.
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

/**
 * Every column with no `applyIdempotentAlter` behind it, so a database whose table predates the
 * column would never receive it. Derived by measurement, not from reading the schema.
 *
 * All of these are safe today for one of two reasons, and a name joining the list is only safe if
 * one of them still applies:
 *
 *  - the column has existed since the first published release, so no database in the wild lacks it; or
 *  - its whole table is younger than the column, and `CREATE TABLE IF NOT EXISTS` creates a *missing*
 *    table complete. (`fact_terms` arrived in 3ad56d0, after v0.1.0, and is created whole.)
 *
 * A column added to a table that already shipped satisfies neither, and needs an ALTER.
 */
const COLUMNS_WITHOUT_A_MIGRATION: readonly string[] = [
  "audit_log.created_at",
  "audit_log.detail",
  "audit_log.event",
  "audit_log.fact_id",
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

/**
 * Drops `table.column` from a throwaway store, reopens it through the real open path, and reports
 * whether the column came back.
 *
 * Dropping a column is the faithful way to manufacture "a database from before this column existed":
 * it leaves every other artefact of a real store intact -- other tables, indexes, constraints, the
 * seeded epoch row -- where a hand-written fixture would have to reproduce all of them correctly.
 *
 * `null` means SQLite refused the drop (primary key, or backing an index), so the column cannot be
 * tested this way. Callers assert on which columns those are rather than ignoring them.
 *
 * A reopen that throws counts as `false`, and is the worse half of this failure class rather than a
 * separate one: `openDb` writes to `meta.value` unconditionally, so a database missing a column the
 * open path itself touches does not merely answer queries wrong, it cannot be opened at all.
 */
function survivesReopenWithoutColumn(table: string, column: string): boolean | null {
  const { db, path } = freshStore();
  try {
    // SQLite refuses to drop an indexed column, which would leave most of the schema untestable.
    // Dropping the table's indexes first is faithful rather than a dodge: `CREATE INDEX IF NOT
    // EXISTS` runs on every open, so a real database is where indexes come from in the first place,
    // and rebuilding one over a missing column fails exactly the way the missing column should.
    for (const { name } of db
      .prepare<[string], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL"
      )
      .all(table)) {
      db.exec(`DROP INDEX ${name}`);
    }
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  } catch {
    return null;
  } finally {
    db.close();
  }
  let reopened: Db;
  try {
    reopened = openStorage(path);
  } catch {
    return false;
  }
  try {
    return columnsOf(reopened, table).includes(column);
  } finally {
    reopened.close();
  }
}

describe("opening a database that predates a schema change", () => {
  it("restores exactly the columns a migration is responsible for, with nothing out of reach", () => {
    const { db } = freshStore();
    const plan = userTables(db).flatMap((table) =>
      (db.pragma(`table_info(${table})`) as { name: string; pk: number }[])
        .filter((column) => column.pk === 0)
        .map((column) => ({ table, column: column.name, name: `${table}.${column.name}` }))
    );
    db.close();

    // One measurement, two assertions: the partition is a single fact about the schema, and
    // re-deriving it per assertion would double 30-odd database builds for nothing.
    const outcomes = plan.map((entry) => ({ ...entry, kept: survivesReopenWithoutColumn(entry.table, entry.column) }));
    const pick = (kept: boolean | null): string[] =>
      outcomes
        .filter((entry) => entry.kept === kept)
        .map((entry) => entry.name)
        .sort();

    // Every name here is a column an existing user's store never receives. Adding a column to a
    // CREATE TABLE that already shipped puts it in this list and breaks that store: give it an
    // `applyIdempotentAlter` in `ensureStorageSchema` instead of widening the constant, which is
    // pinned so it cannot be used to wave a real gap through.
    expect(pick(false)).toEqual([...COLUMNS_WITHOUT_A_MIGRATION]);
    // The fixture's blind spot, kept empty on purpose: SQLite refuses DROP COLUMN on a PRIMARY KEY
    // or UNIQUE column, and a column that lands here is silently unguarded by the assertion above.
    expect(pick(null)).toEqual([]);
  });

  it("keeps the epoch row and the aux tables a legacy store never had", () => {
    const { db, path } = freshStore();
    db.exec("DROP TABLE fact_terms");
    db.exec("DELETE FROM meta");
    db.close();

    const reopened = openStorage(path);
    try {
      expect(userTables(reopened)).toContain("fact_terms");
      // `openDb` seeds the epoch and `ensureStorageSchema` re-seeds it; a store that lost the row
      // must not come back with a NULL epoch that every `epoch > n` comparison then mis-answers.
      expect(reopened.prepare("SELECT value FROM meta WHERE key = 'epoch'").get()).toEqual({ value: "0" });
    } finally {
      reopened.close();
    }
  });
});

/**
 * The enum values frozen into every database ever created by mem.
 *
 * `ALTER TABLE` cannot amend a CHECK constraint, so widening any of these in the schema reaches new
 * databases only; existing ones keep rejecting the new value with `CHECK constraint failed`. Adding
 * a value therefore requires a table rebuild (create, copy, drop, rename) in `ensureStorageSchema`,
 * and this list moves only once that rebuild exists.
 */
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
      found[column] = [...(values as string).matchAll(/'([^']*)'/g)].map((match) => match[1] as string);
    }
    return found;
  }

  it("still declares exactly the enum values every existing database was built with", () => {
    const { db } = freshStore();
    try {
      // Fails the moment someone widens an enum in FACTS_SCHEMA. That edit is not wrong in itself --
      // it is wrong *without* a rebuild migration, which is what this failure is here to demand.
      expect(enumsOf(db)).toEqual(FROZEN_ENUMS);
    } finally {
      db.close();
    }
  });

  it("rejects a value the constraint predates, proving the freeze is real", () => {
    const { db, path } = freshStore();
    // A store built when `status` allowed one fewer value: the honest way to show that reopening it
    // does not, and cannot, widen the constraint.
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
