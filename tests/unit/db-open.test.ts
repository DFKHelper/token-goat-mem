/**
 * Failure-path tests for `openDb` (src/db.ts).
 *
 * `new Database(path)` connects lazily, so a damaged store is not detected at construction but at
 * the first statement `openDb` runs against it. Before the try/catch these tests pin, that error
 * escaped with the handle still open and unreferenced: nothing could close it, and on Windows the
 * OS held an exclusive lock, so the user could not delete or replace their own corrupt database
 * without killing the process -- and `mem doctor`, which opens through this same path, hit the same
 * lock instead of reporting the corruption it exists to report.
 */
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

    // The assertion that actually pins the leak. A retained handle fails this with EBUSY on
    // Windows; on POSIX the unlink succeeds either way, so the check below carries the platform's
    // share of the evidence.
    expect(() => unlinkSync(dbPath)).not.toThrow();
  });

  it("leaves no sidecars behind for a store it never opened", () => {
    expect(() => openDb(corruptStore())).toThrow();

    // A handle closed properly takes its WAL sidecars with it. One left on disk means the
    // connection outlived the failure.
    expect(readdirSync(workDir).filter((name) => name.endsWith("-wal") || name.endsWith("-shm"))).toEqual([]);
  });

  it("releases the handle when the failure is in the second phase, not the first", () => {
    // `openStorage` is `openDb` plus `ensureStorageSchema`, and only the first half was guarded at
    // first. This store passes `openDb` cleanly and fails the DDL that follows -- a shape a store
    // damaged or half-migrated by an older version can genuinely reach (here the index build refuses
    // the object it finds) -- so it pins the layer the first fix missed rather than re-testing the
    // one it covered.
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

    // End-to-end proof of the user-facing recovery: delete the corrupt file, and mem works again
    // in the same process. This is the sequence that was impossible while the handle leaked.
    const db = openDb(dbPath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS c FROM facts").get()).toEqual({ c: 0 });
    } finally {
      db.close();
    }
  });
});
