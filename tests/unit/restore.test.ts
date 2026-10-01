/** `restoreStore` (src/restore.ts): the swap that replaces the live store's rows with a validated, migrated copy of a snapshot, inside one transaction on the live connection. The CLI-level behaviour is covered end to end in tests/backup.test.ts; these tests reach the race that only a seam can reproduce -- another process writing between the pre-restore snapshot and the swap -- and the refusals that must leave the live store untouched. */
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listSnapshots, takeSnapshot } from "../../src/backup.js";
import { LATEST_SCHEMA_VERSION } from "../../src/migrations.js";
import { restoreStore, UnusableSnapshotError } from "../../src/restore.js";
import { getEpoch, insertFact, listFacts, openStorage } from "../../src/storage.js";

let root: string;
let dbPath: string;
let backupDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-restore-unit-"));
  dbPath = join(root, "home", "mem.db");
  backupDir = join(root, "backups");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string): void {
  const db = openStorage(path, { autoSnapshot: false });
  try {
    insertFact(db, { text, kind: "fact", scope: "global", source_type: "user" });
  } finally {
    db.close();
  }
}

function texts(path: string): string[] {
  const db = openStorage(path, { autoSnapshot: false });
  try {
    return listFacts(db)
      .map((fact) => fact.text)
      .sort();
  } finally {
    db.close();
  }
}

function epochOf(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return getEpoch(db);
  } finally {
    db.close();
  }
}

/** A snapshot of the live store holding exactly `text`. */
function snapshotWith(text: string): string {
  write(dbPath, text);
  const db = openStorage(dbPath, { autoSnapshot: false });
  try {
    return takeSnapshot(db, backupDir, "manual").path;
  } finally {
    db.close();
  }
}

describe("restoreStore", () => {
  it("replaces the rows, keeps the replaced store as a pre-restore snapshot, and leaves no staging file", async () => {
    const source = snapshotWith("in the snapshot");
    write(dbPath, "after the snapshot");

    const result = await restoreStore({ source, dbPath, backupDir });

    expect(texts(dbPath)).toEqual(["in the snapshot"]);
    expect(texts(result.preRestore.path)).toEqual(["after the snapshot", "in the snapshot"]);
    expect(result.epoch).toBeGreaterThan(result.preRestore.epoch);
    expect(readdirSync(dirname(dbPath)).filter((name) => name.startsWith(".restore-"))).toEqual([]);
  });

  it("retries when the store changes after the pre-restore snapshot, so that snapshot always holds what was replaced", async () => {
    const source = snapshotWith("in the snapshot");
    let calls = 0;

    const result = await restoreStore({
      source,
      dbPath,
      backupDir,
      afterPreRestoreSnapshot: () => {
        calls += 1;
        if (calls === 1) {
          write(dbPath, "written during the restore");
        }
      },
    });

    expect(calls).toBe(2);
    const preRestore = listSnapshots(backupDir).filter((snapshot) => snapshot.reason === "pre-restore");
    expect(preRestore).toHaveLength(1);
    expect(preRestore[0]?.path).toBe(result.preRestore.path);
    expect(texts(result.preRestore.path)).toContain("written during the restore");
    expect(result.epoch).toBeGreaterThan(result.preRestore.epoch);
    expect(texts(dbPath)).toEqual(["in the snapshot"]);
  });

  it("gives up without replacing anything when the store never stops changing", async () => {
    const source = snapshotWith("in the snapshot");
    write(dbPath, "the live store");
    let calls = 0;

    await expect(
      restoreStore({
        source,
        dbPath,
        backupDir,
        afterPreRestoreSnapshot: () => {
          calls += 1;
          write(dbPath, `concurrent write ${String(calls)}`);
        },
      })
    ).rejects.toThrow(/kept changing/);

    expect(texts(dbPath)).toContain("the live store");
    expect(texts(dbPath)).toContain("concurrent write 3");
    expect(listSnapshots(backupDir).filter((snapshot) => snapshot.reason === "pre-restore")).toEqual([]);
  });

  it("refuses a newer schema as an UnusableSnapshotError and touches neither the live store nor the backups", async () => {
    const source = snapshotWith("in the snapshot");
    const db = new Database(source);
    db.pragma(`user_version = ${String(LATEST_SCHEMA_VERSION + 1)}`);
    db.close();
    write(dbPath, "after the snapshot");
    const epochBefore = epochOf(dbPath);

    const error = await restoreStore({ source, dbPath, backupDir }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnusableSnapshotError);
    expect((error as Error).message).toMatch(/newer mem/);
    expect(texts(dbPath)).toEqual(["after the snapshot", "in the snapshot"]);
    expect(epochOf(dbPath)).toBe(epochBefore);
    expect(listSnapshots(backupDir).filter((snapshot) => snapshot.reason === "pre-restore")).toEqual([]);
  });

  it("migrates an older snapshot before swapping it in", async () => {
    const source = snapshotWith("from an older mem");
    const db = new Database(source);
    db.exec("ALTER TABLE facts DROP COLUMN why");
    db.pragma("user_version = 5");
    db.close();

    await restoreStore({ source, dbPath, backupDir });

    expect(texts(dbPath)).toEqual(["from an older mem"]);
    expect(existsSync(source)).toBe(true);
  });
});
