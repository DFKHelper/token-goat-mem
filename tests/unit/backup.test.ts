/**
 * The automatic snapshot every connection open takes of an existing store (src/backup.ts, called
 * from src/db.ts's `openDb`): where snapshots land, when one is taken or skipped, what is kept, and
 * that a failure to take one never costs the caller its database.
 *
 * Snapshot age is read from the file name, not the file's mtime, so a test ages a snapshot by
 * renaming it rather than by waiting a day.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AUTO_SNAPSHOT_CLAIM, AUTO_SNAPSHOTS_KEPT, listSnapshots, snapshotFileName, takeSnapshot } from "../../src/backup.js";
import { BACKUP_DIR_ENV, resolveBackupDir } from "../../src/db.js";
import { describeBackups } from "../../src/doctor.js";
import { MS_PER_DAY } from "../../src/timeUtils.js";
import { getEpoch, insertFact, listFacts, openStorage } from "../../src/storage.js";

let root: string;
let dbPath: string;
let backupDir: string;
let priorBackupDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-backup-unit-"));
  dbPath = join(root, "home", "mem.db");
  backupDir = join(root, "backups");
  priorBackupDir = process.env[BACKUP_DIR_ENV];
  process.env[BACKUP_DIR_ENV] = backupDir;
});

afterEach(() => {
  if (priorBackupDir === undefined) {
    delete process.env[BACKUP_DIR_ENV];
  } else {
    process.env[BACKUP_DIR_ENV] = priorBackupDir;
  }
  rmSync(root, { recursive: true, force: true });
});

/** Opens the store, writes `count` facts, and closes it -- one "session" that changes the store. */
function writeFacts(count: number, prefix = "fact"): void {
  const db = openStorage(dbPath);
  try {
    for (let i = 0; i < count; i += 1) {
      insertFact(db, { text: `${prefix} number ${String(i)} about the build`, kind: "fact", scope: "global", source_type: "user" });
    }
  } finally {
    db.close();
  }
}

/** Opens and closes the store without writing anything. */
function reopen(): void {
  openStorage(dbPath).close();
}

/** Renames every snapshot in the backup dir to claim it was taken `days` earlier. */
function ageSnapshots(days: number): void {
  for (const snapshot of listSnapshots(backupDir)) {
    const older = new Date(snapshot.takenAt.getTime() - days * MS_PER_DAY);
    renameSync(snapshot.path, join(backupDir, snapshotFileName(older, snapshot.epoch, snapshot.reason)));
  }
}

describe("resolveBackupDir", () => {
  it("defaults to a sibling of the mem home, so deleting the home (or ~/.claude) leaves it intact", () => {
    delete process.env[BACKUP_DIR_ENV];
    const home = join(root, ".mem");
    expect(resolveBackupDir(home)).toBe(join(root, ".mem-backups"));
  });

  it("honours the override when one is set", () => {
    expect(resolveBackupDir(join(root, ".mem"))).toBe(backupDir);
  });
});

describe("automatic snapshot on open", () => {
  it("takes none when the open creates the database -- there is nothing yet to lose", () => {
    reopen();
    expect(listSnapshots(backupDir)).toEqual([]);
  });

  it("takes none of a store that has never been written to", () => {
    reopen();
    reopen();
    expect(listSnapshots(backupDir)).toEqual([]);
  });

  it("snapshots an existing store with writes on the next open, as a complete readable copy", () => {
    writeFacts(3);
    reopen();

    const snapshots = listSnapshots(backupDir);
    expect(snapshots).toHaveLength(1);
    const [snapshot] = snapshots;
    expect(snapshot?.reason).toBe("auto");
    expect(snapshot?.epoch).toBe(3);
    expect(snapshot?.bytes).toBeGreaterThan(0);

    const copy = new Database(snapshot?.path ?? "", { readonly: true });
    try {
      expect(listFacts(copy, {})).toHaveLength(3);
    } finally {
      copy.close();
    }
  });

  it("takes no second snapshot within a day of the last one, however many writes happen", () => {
    writeFacts(1);
    reopen();
    writeFacts(2, "later");
    reopen();
    expect(listSnapshots(backupDir)).toHaveLength(1);
  });

  it("takes no new snapshot of an unchanged store however old the last one is", () => {
    writeFacts(1);
    reopen();
    ageSnapshots(3);
    reopen();
    expect(listSnapshots(backupDir)).toHaveLength(1);
  });

  it("takes a new snapshot once the last one is a day old and the store has changed since", () => {
    writeFacts(1);
    reopen();
    ageSnapshots(1.5);
    // This open still finds the store at the snapshot's epoch -- its own write lands afterwards.
    writeFacts(1, "later");
    expect(listSnapshots(backupDir)).toHaveLength(1);

    reopen();
    // Newest first.
    expect(listSnapshots(backupDir).map((snapshot) => snapshot.epoch)).toEqual([2, 1]);
  });

  it(`keeps the newest ${String(AUTO_SNAPSHOTS_KEPT)} automatic snapshots and every explicit one`, () => {
    writeFacts(1);
    const db = openStorage(dbPath);
    try {
      takeSnapshot(db, backupDir, "manual");
    } finally {
      db.close();
    }
    for (let i = 0; i < AUTO_SNAPSHOTS_KEPT + 3; i += 1) {
      ageSnapshots(2);
      writeFacts(1, `round ${String(i)}`);
    }

    const snapshots = listSnapshots(backupDir);
    expect(snapshots.filter((snapshot) => snapshot.reason === "auto")).toHaveLength(AUTO_SNAPSHOTS_KEPT);
    expect(snapshots.filter((snapshot) => snapshot.reason === "manual")).toHaveLength(1);
    // The survivors are the newest: the highest epochs, not the first ones taken.
    const autoEpochs = snapshots.filter((snapshot) => snapshot.reason === "auto").map((snapshot) => snapshot.epoch);
    expect(Math.max(...autoEpochs)).toBe(getEpochOf(dbPath) - 1);
  });

  it("snapshots the store before a pending migration touches it, even with a fresh snapshot on hand", () => {
    writeFacts(2);
    reopen();
    const raw = new Database(dbPath);
    raw.pragma("user_version = 0");
    raw.close();

    reopen();

    const preMigration = listSnapshots(backupDir).filter((snapshot) => snapshot.reason === "pre-migration");
    expect(preMigration).toHaveLength(1);
    const copy = new Database(preMigration[0]?.path ?? "", { readonly: true });
    try {
      expect(copy.pragma("user_version", { simple: true })).toBe(0);
    } finally {
      copy.close();
    }
  });

  it("still opens the database when the snapshot cannot be written", () => {
    writeFacts(1);
    mkdirSync(dirname(backupDir), { recursive: true });
    writeFileSync(backupDir, "a file where the backup directory should be", "utf8");

    const db = openStorage(dbPath);
    try {
      expect(listFacts(db, {})).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("leaves no partial file behind in the backup directory", () => {
    writeFacts(1);
    reopen();
    expect(readdirSync(backupDir).every((name) => name.startsWith("mem-") && name.endsWith(".db"))).toBe(true);
    expect(basename(listSnapshots(backupDir)[0]?.path ?? "")).toMatch(/^mem-\d{8}T\d{9}Z-e1-auto\.db$/);
  });
});

function getEpochOf(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return getEpoch(db);
  } finally {
    db.close();
  }
}

describe("doctor's backups line", () => {
  it("says nothing is due for a store never written to", () => {
    expect(describeBackups(backupDir, 0)).toBe(`backups: none in ${backupDir} (nothing written yet)`);
  });

  it("warns when a written store has no snapshot at all", () => {
    expect(describeBackups(backupDir, 5)).toContain("snapshots are not being written");
  });

  it("reports the newest snapshot and stays quiet while it is current", () => {
    writeFacts(1);
    reopen();
    const line = describeBackups(backupDir, 1);
    expect(line).toMatch(/-- 1 snapshot, newest <1m ago \(epoch 1\)$/);
  });

  it("warns when the newest snapshot is overdue and the store has changed since", () => {
    writeFacts(1);
    reopen();
    ageSnapshots(3);
    expect(describeBackups(backupDir, 7)).toContain("automatic snapshots may be failing");
    // An unchanged store needs no new snapshot however old the last one is.
    expect(describeBackups(backupDir, 1)).not.toContain("may be failing");
  });
});

describe("snapshot hygiene", () => {
  const HOUR_MS = 60 * 60 * 1000;

  function backdate(path: string, ms: number): void {
    const then = new Date(Date.now() - ms);
    utimesSync(path, then, then);
  }

  it("leaves a due snapshot to the open that holds the claim, and takes over a claim abandoned for an hour", () => {
    writeFacts(1);
    mkdirSync(backupDir, { recursive: true });
    const claim = join(backupDir, AUTO_SNAPSHOT_CLAIM);
    writeFileSync(claim, "");

    reopen();
    expect(listSnapshots(backupDir)).toEqual([]);

    backdate(claim, 2 * HOUR_MS);
    reopen();
    expect(listSnapshots(backupDir).map((snapshot) => snapshot.reason)).toEqual(["auto"]);
    expect(existsSync(claim)).toBe(false);
  });

  it("clears copies an interrupted snapshot abandoned, but not one another process may still be writing", () => {
    writeFacts(1);
    mkdirSync(backupDir, { recursive: true });
    const abandoned = join(backupDir, ".mem-snapshot-1-1.tmp");
    const inFlight = join(backupDir, ".mem-snapshot-2-2.tmp");
    writeFileSync(abandoned, "half a copy");
    writeFileSync(inFlight, "half a copy");
    backdate(abandoned, 2 * HOUR_MS);

    reopen();

    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(inFlight)).toBe(true);
    expect(listSnapshots(backupDir)).toHaveLength(1);
  });

  it("names a snapshot after the epoch of the copy itself, not a read taken before the copy", () => {
    writeFacts(2);
    const db = openStorage(dbPath, { autoSnapshot: false });
    try {
      // A temp table shadows main's `meta` for an unqualified read but is never copied by VACUUM INTO:
      // the same disagreement a write landing between the read and the copy would cause.
      db.exec("CREATE TEMP TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.prepare("INSERT INTO temp.meta (key, value) VALUES ('epoch', '999')").run();
      const snapshot = takeSnapshot(db, backupDir, "manual");
      expect(snapshot.epoch).toBe(2);
      expect(getEpochOf(snapshot.path)).toBe(2);
    } finally {
      db.close();
    }
  });

  it("lists past a snapshot-named entry that vanishes or dangles", (ctx) => {
    mkdirSync(backupDir, { recursive: true });
    try {
      symlinkSync(join(root, "nowhere.db"), join(backupDir, snapshotFileName(new Date(), 5, "manual")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        ctx.skip();
      }
      throw error;
    }
    expect(listSnapshots(backupDir)).toEqual([]);
  });

  it("takes one pre-migration snapshot per store state, however many opens find the migration pending", () => {
    writeFacts(2);
    reopen();
    for (let i = 0; i < 2; i += 1) {
      const raw = new Database(dbPath);
      raw.pragma("user_version = 0");
      raw.close();
      reopen();
    }
    expect(listSnapshots(backupDir).filter((snapshot) => snapshot.reason === "pre-migration")).toHaveLength(1);
  });
});
