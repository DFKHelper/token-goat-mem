/** Failure-path tests for `openDb` (src/db.ts). `new Database(path)` connects lazily, so a damaged store is not detected at construction but at the first statement `openDb` runs against it. Before the try/catch these tests pin, that error escaped with the handle still open and unreferenced: nothing could close it, and on Windows the OS held an exclusive lock, so the user could not delete or replace their own corrupt database without killing the process -- and `mem doctor`, which opens through this same path, hit the same lock instead of reporting the corruption it exists to report. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { openDb } from "../../src/db.js";
import { openStorage } from "../../src/storage.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mem-db-open-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A file that exists and is readable but is not a sqlite database. */
function corruptStore(): string {
  const dbPath = join(workDir, "mem.db");
  writeFileSync(dbPath, "not a sqlite database, not even the 16-byte header\n".repeat(20), "utf8");
  return dbPath;
}

describe("openDb on a damaged store", () => {
  it("surfaces the corruption instead of returning a broken handle", () => {
    expect(() => openDb(corruptStore())).toThrow(/SQLITE_NOTADB|file is not a database/i);
  });

  it("releases the file handle, so the store stays replaceable", () => {
    const dbPath = corruptStore();

    expect(() => openDb(dbPath)).toThrow();

    // The assertion that actually pins the leak. A retained handle fails this with EBUSY on Windows; on POSIX the unlink succeeds either way, so the check below carries the platform's share of the evidence.
    expect(() => unlinkSync(dbPath)).not.toThrow();
  });

  it("leaves no sidecars behind for a store it never opened", () => {
    expect(() => openDb(corruptStore())).toThrow();

    // A handle closed properly takes its WAL sidecars with it. One left on disk means the connection outlived the failure.
    expect(readdirSync(workDir).filter((name) => name.endsWith("-wal") || name.endsWith("-shm"))).toEqual([]);
  });

  it("releases the handle when the failure is in the second phase, not the first", () => {
    // `openStorage` is `openDb` plus `ensureStorageSchema`, and only the first half was guarded at first. This store passes `openDb` cleanly and fails the DDL that follows -- a shape a store damaged or half-migrated by an older version can genuinely reach (here the index build refuses the object it finds) -- so it pins the layer the first fix missed rather than re-testing the one it covered.
    const dbPath = join(workDir, "mem.db");
    const seed = new Database(dbPath);
    seed.exec("CREATE VIEW sources AS SELECT 1 AS x");
    seed.close();

    expect(() => openStorage(dbPath)).toThrow(/views may not be indexed/i);
    expect(() => unlinkSync(dbPath)).not.toThrow();
  });

  it("still opens a healthy store at the same path afterwards", () => {
    const dbPath = corruptStore();
    expect(() => openDb(dbPath)).toThrow();
    unlinkSync(dbPath);

    // End-to-end proof of the user-facing recovery: delete the corrupt file, and mem works again in the same process. This is the sequence that was impossible while the handle leaked.
    const db = openDb(dbPath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS c FROM facts").get()).toEqual({ c: 0 });
    } finally {
      db.close();
    }
  });
});

type TraceEvent = { readonly kind: "write" | "pragma"; readonly sql: string; readonly inTransaction: boolean };

/** Runs `fn` while recording every write statement better-sqlite3 is handed, with whether a transaction was open at that moment, and every `db.transaction` invocation with the mode it began in. */
function traceWrites(fn: () => void): { readonly events: readonly TraceEvent[]; readonly transactionModes: readonly string[] } {
  const proto = Database.prototype as unknown as Record<string, (...args: never[]) => unknown>;
  const events: TraceEvent[] = [];
  const transactionModes: string[] = [];
  const isWrite = (sql: string): boolean => /^\s*(CREATE|INSERT|UPDATE|DELETE|ALTER|DROP|REPLACE)\b/iu.test(sql);
  const original = { exec: proto["exec"], prepare: proto["prepare"], pragma: proto["pragma"], transaction: proto["transaction"] } as Record<string, (this: Database.Database, ...args: never[]) => unknown>;
  proto["exec"] = function (this: Database.Database, sql: string) {
    for (const statement of sql.split(";").map((part) => part.trim()).filter((part) => part.length > 0)) {
      if (isWrite(statement)) {
        events.push({ kind: "write", sql: statement, inTransaction: this.inTransaction });
      }
    }
    return original["exec"]?.call(this, sql as never);
  } as never;
  proto["prepare"] = function (this: Database.Database, sql: string) {
    const statement = original["prepare"]?.call(this, sql as never) as { run: (...args: unknown[]) => unknown };
    if (isWrite(sql)) {
      const run = statement.run.bind(statement);
      statement.run = (...args: unknown[]) => {
        events.push({ kind: "write", sql, inTransaction: this.inTransaction });
        return run(...args);
      };
    }
    return statement;
  } as never;
  proto["pragma"] = function (this: Database.Database, sql: string, options?: unknown) {
    if (/^\s*journal_mode\s*=/iu.test(sql)) {
      events.push({ kind: "pragma", sql, inTransaction: this.inTransaction });
    }
    return original["pragma"]?.call(this, sql as never, options as never);
  } as never;
  proto["transaction"] = function (this: Database.Database, body: never) {
    const wrapped = original["transaction"]?.call(this, body) as unknown as Record<string, (...args: unknown[]) => unknown> & ((...args: unknown[]) => unknown);
    const traced = ((...args: unknown[]) => {
      transactionModes.push("deferred");
      return wrapped(...args);
    }) as typeof wrapped;
    for (const mode of ["deferred", "immediate", "exclusive"]) {
      traced[mode] = (...args: unknown[]) => {
        transactionModes.push(mode);
        return wrapped[mode]?.(...args);
      };
    }
    return traced;
  } as never;
  try {
    fn();
  } finally {
    Object.assign(proto, original);
  }
  return { events, transactionModes };
}

describe("openDb schema commits", () => {
  const dbPath = (): string => join(workDir, "mem.db");

  it("commits a fresh store's whole schema in one immediate transaction, not one commit per statement", () => {
    const { events, transactionModes } = traceWrites(() => {
      openDb(dbPath(), { autoSnapshot: false }).close();
    });

    const writes = events.filter((event) => event.kind === "write");
    expect(writes.some((event) => /CREATE TABLE IF NOT EXISTS facts\b/iu.test(event.sql))).toBe(true);
    expect(writes.some((event) => /INSERT OR IGNORE INTO meta\b/iu.test(event.sql))).toBe(true);
    // Every schema statement ran inside a transaction, so none of them was a commit of its own.
    expect(writes.filter((event) => !event.inTransaction)).toEqual([]);
    // Immediate, never deferred: a deferred transaction upgrading read-to-write fails "database is locked" without consulting the busy handler.
    expect(transactionModes.length).toBeGreaterThan(0);
    expect(transactionModes.filter((mode) => mode !== "immediate")).toEqual([]);
  });

  it("keeps an existing store's open free of an up-front write transaction", () => {
    openDb(dbPath(), { autoSnapshot: false }).close();

    const { events, transactionModes } = traceWrites(() => {
      openDb(dbPath(), { autoSnapshot: false }).close();
    });

    // Read-only hook opens land here constantly: wrapping the no-op schema statements in a transaction would take the write lock for each of them and queue them behind any writer.
    expect(transactionModes).toEqual([]);
    expect(events.filter((event) => event.kind === "write" && event.inTransaction)).toEqual([]);
  });

  it("issues no statement that takes the write lock when an existing store already has its epoch row", () => {
    openDb(dbPath(), { autoSnapshot: false }).close();

    const { events } = traceWrites(() => {
      openDb(dbPath(), { autoSnapshot: false }).close();
    });

    // A `CREATE ... IF NOT EXISTS` on an object that already exists is a no-op SQLite answers from the schema without the write lock; an `INSERT OR IGNORE` of a row that exists is not, and queued every existing-store open behind any writer.
    const lockTaking = events.filter((event) => event.kind === "write" && !/^\s*CREATE\s+(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\b/iu.test(event.sql));
    expect(lockTaking).toEqual([]);
  });

  it("seeds the epoch row of an existing store that lacks one", () => {
    const seed = openDb(dbPath(), { autoSnapshot: false });
    seed.prepare("DELETE FROM meta WHERE key = 'epoch'").run();
    seed.close();

    const { events } = traceWrites(() => {
      openDb(dbPath(), { autoSnapshot: false }).close();
    });

    expect(events.filter((event) => event.kind === "write" && /INSERT OR IGNORE INTO meta\b/iu.test(event.sql))).toHaveLength(1);
    const check = new Database(dbPath(), { readonly: true });
    try {
      expect(check.prepare("SELECT value FROM meta WHERE key = 'epoch'").get()).toEqual({ value: "0" });
    } finally {
      check.close();
    }
  });
});
