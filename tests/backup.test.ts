/** End-to-end tests for `mem backup` and `mem restore`, and the `backups:` line in `mem doctor`. The backup directory is deliberately outside the mem home -- a sibling of it by default -- so a store survives the deletion of `~/.mem` (or of `~/.claude`, which never held it). Driven through the real `run()` against a real database. */
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTO_SNAPSHOTS_KEPT, listSnapshots, snapshotFileName, takeSnapshot, type Snapshot } from "../src/backup.js";
import { BACKUP_DIR_ENV, resolveDbPath } from "../src/db.js";
import { LATEST_SCHEMA_VERSION } from "../src/migrations.js";
import { getEpoch, insertFact, openStorage } from "../src/storage.js";
import { MS_PER_DAY } from "../src/timeUtils.js";
import { runCli } from "./support/cli.js";
import { CAPABLE_PROBE, installProbe, resetProbe } from "./support/fakeProbe.js";
import { openTemplateStore } from "./support/templateStore.js";

vi.mock("../src/probeSpawn.js", async (importOriginal) => (await import("./support/fakeProbe.js")).withFakeProbe(await importOriginal<typeof import("../src/probeSpawn.js")>()));

let root: string;
let home: string;
let backupDir: string;
let priorBackupDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-backup-e2e-"));
  home = join(root, ".mem");
  backupDir = join(root, "backups");
  vi.stubEnv("TOKEN_GOAT_MEM_HOME", home);
  priorBackupDir = process.env[BACKUP_DIR_ENV];
  process.env[BACKUP_DIR_ENV] = backupDir;
  // The doctor tests read the backups line, not the wiring probe, so the probe is scripted rather than a process started per run.
  installProbe(CAPABLE_PROBE);
});

afterEach(() => {
  resetProbe();
  vi.unstubAllEnvs();
  if (priorBackupDir === undefined) {
    delete process.env[BACKUP_DIR_ENV];
  } else {
    process.env[BACKUP_DIR_ENV] = priorBackupDir;
  }
  rmSync(root, { recursive: true, force: true });
});

type Store = ReturnType<typeof openStorage>;

/** Opens the home's store -- a copy of the template store when none exists yet, because these tests are about backing up and restoring a store, not about creating one. */
function openHomeStore(): Store {
  const dbPath = resolveDbPath();
  return existsSync(dbPath) ? openStorage(dbPath) : openTemplateStore(dbPath);
}

function addFact(db: Store, text: string): void {
  insertFact(db, { text, kind: "fact", scope: "global", source_type: "user" });
}

/** Writes `before` into the home's store, takes a manual snapshot of it, then writes `after`, all in one open: the state `mem remember`, `mem backup`, `mem remember` leave, without a CLI run per step. */
function seedWithSnapshot(before: readonly string[], after: readonly string[] = [], now: Date = new Date()): Snapshot {
  const db = openHomeStore();
  try {
    before.forEach((text) => {
      addFact(db, text);
    });
    const snapshot = takeSnapshot(db, backupDir, "manual", now);
    after.forEach((text) => {
      addFact(db, text);
    });
    return snapshot;
  } finally {
    db.close();
  }
}

/** Writes `texts` into the home's store in one open, with no snapshot. */
function seed(texts: readonly string[]): void {
  const db = openHomeStore();
  try {
    texts.forEach((text) => {
      addFact(db, text);
    });
  } finally {
    db.close();
  }
}

async function listedTexts(): Promise<string[]> {
  const result = await runCli(["list", "--json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  return (JSON.parse(result.stdout) as { facts: { text: string }[] }).facts.map((fact) => fact.text).sort();
}

async function epoch(): Promise<number> {
  const result = await runCli(["epoch"]);
  expect(result.exitCode, result.stderr).toBe(0);
  return Number(result.stdout.trim());
}

describe("mem backup", () => {
  it("writes a snapshot outside the mem home and prints where", async () => {
    seed(["the staging database is rebuilt nightly"]);
    const result = await runCli(["backup"]);
    expect(result.exitCode, result.stderr).toBe(0);

    const snapshots = listSnapshots(backupDir).filter((snapshot) => snapshot.reason === "manual");
    expect(snapshots).toHaveLength(1);
    const path = snapshots[0]?.path ?? "";
    expect(result.stdout).toContain(`backed up to ${path}`);
    expect(existsSync(path)).toBe(true);
    expect(dirname(path)).not.toBe(home);

    // Deleting the whole home leaves the snapshot where it was.
    rmSync(home, { recursive: true, force: true });
    expect(existsSync(path)).toBe(true);
  });

  it("--list names every snapshot, newest first", async () => {
    const now = Date.now();
    seedWithSnapshot(["first fact"], [], new Date(now - 60_000));
    seedWithSnapshot(["second fact"], [], new Date(now));

    const result = await runCli(["backup", "--list"]);
    expect(result.exitCode, result.stderr).toBe(0);
    const names = listSnapshots(backupDir).map((snapshot) => basename(snapshot.path));
    expect(names.length).toBeGreaterThanOrEqual(2);
    const positions = names.map((name) => result.stdout.indexOf(name));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(result.stdout).toContain(backupDir);
  });

  it("--list says so when there are no snapshots yet", async () => {
    const result = await runCli(["backup", "--list"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(`no snapshots in ${backupDir}\n`);
  });
});

describe("mem restore", () => {
  it("puts a snapshot back, advances the epoch past both stores, and keeps what it replaced", async () => {
    const snapshot = seedWithSnapshot(["kept across the restore"], ["written after the backup"]);
    const before = await epoch();

    const result = await runCli(["restore", basename(snapshot?.path ?? "")]);
    expect(result.exitCode, result.stderr).toBe(0);

    expect(await listedTexts()).toEqual(["kept across the restore"]);
    expect(await epoch()).toBeGreaterThan(before);

    const preRestore = listSnapshots(backupDir).filter((candidate) => candidate.reason === "pre-restore");
    expect(preRestore).toHaveLength(1);
    expect(result.stdout).toContain(preRestore[0]?.path ?? "<missing>");

    // The replaced store is itself restorable: the restore can be undone.
    const undo = await runCli(["restore", preRestore[0]?.path ?? ""]);
    expect(undo.exitCode, undo.stderr).toBe(0);
    expect(await listedTexts()).toEqual(["kept across the restore", "written after the backup"]);
  });

  it("recovers a live store that is unreadable and says where the unreadable file went", async () => {
    const snapshot = seedWithSnapshot(["recoverable from the snapshot"]);
    const dbPath = resolveDbPath();
    writeFileSync(dbPath, "garbage that is not sqlite ".repeat(80), "utf8");
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });

    const result = await runCli(["restore", basename(snapshot?.path ?? "")]);
    expect(result.exitCode, result.stderr).toBe(0);

    const moved = readdirSync(dirname(dbPath)).find((name) => name.startsWith("mem.db.unreadable-"));
    expect(moved).toBeDefined();
    expect(result.stdout).toContain(join(dirname(dbPath), moved ?? ""));
    expect(await listedTexts()).toEqual(["recoverable from the snapshot"]);
  });

  it("refuses a file that is not a mem store and leaves the live store untouched", async () => {
    seed(["must survive a bad restore"]);
    const bogus = join(root, "not-a-db.db");
    writeFileSync(bogus, "definitely not sqlite", "utf8");

    const result = await runCli(["restore", bogus]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("restore:");
    expect(await listedTexts()).toEqual(["must survive a bad restore"]);
  });

  it("refuses a name that matches no snapshot", async () => {
    const result = await runCli(["restore", "mem-nope.db"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`restore: no snapshot named mem-nope.db`);
  });

  it("refuses a SQLite file whose facts table is not mem's, and leaves the live store untouched", async () => {
    seed(["must survive a foreign facts table"]);
    const foreign = join(root, "foreign.db");
    const db = new Database(foreign);
    db.exec("CREATE TABLE facts (x TEXT)");
    db.close();

    const result = await runCli(["restore", foreign]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is not a usable mem store");
    expect(result.stderr).toContain("facts table is missing");
    expect(await listedTexts()).toEqual(["must survive a foreign facts table"]);
  });

  it("refuses a snapshot written by a newer mem rather than restoring a schema it cannot read", async () => {
    const snapshot = seedWithSnapshot(["kept when the snapshot is from the future"], ["written after the backup"]);
    const db = new Database(snapshot.path);
    db.pragma(`user_version = ${String(LATEST_SCHEMA_VERSION + 1)}`);
    db.close();

    const result = await runCli(["restore", snapshot?.path ?? ""]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("newer mem");
    expect(await listedTexts()).toEqual(["kept when the snapshot is from the future", "written after the backup"]);
  });

  it("moves the epoch past a source store whose epoch is ahead of the live one", async () => {
    seed(["the live store's only fact"]);
    const other = join(root, "other", "mem.db");
    const db = openTemplateStore(other);
    for (let i = 0; i < 5; i += 1) {
      addFact(db, `fact ${String(i)} from another store`);
    }
    const sourceEpoch = getEpoch(db);
    db.close();
    const before = await epoch();
    expect(sourceEpoch).toBeGreaterThan(before);

    const result = await runCli(["restore", other]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await epoch()).toBe(sourceEpoch + 1);
    expect(result.stdout).toContain(`epoch now ${String(sourceEpoch + 1)}`);
  });

  it("never prunes the automatic snapshot it is restoring from", async () => {
    // A store at epoch 0 has no automatic snapshot due, so this open takes none of its own.
    const db = openHomeStore();
    try {
      addFact(db, "restored from the oldest automatic snapshot");
      // Pruning reads only the names in the backup directory, so the other automatic snapshots are copies of one real snapshot under older names.
      const newest = takeSnapshot(db, backupDir, "auto", new Date(Date.now() - 2 * MS_PER_DAY));
      for (let i = 1; i < AUTO_SNAPSHOTS_KEPT; i += 1) {
        copyFileSync(newest.path, join(backupDir, snapshotFileName(new Date(Date.now() - (i + 2) * MS_PER_DAY), newest.epoch, "auto")));
      }
      // Written through the same handle, so no open snapshots it: the store has now changed since a newest snapshot two days old, and the next ordinary open would take one and prune the oldest.
      addFact(db, "written after the snapshots");
    } finally {
      db.close();
    }
    const oldest = listSnapshots(backupDir).filter((candidate) => candidate.reason === "auto").at(-1);

    const result = await runCli(["restore", basename(oldest?.path ?? "")]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(oldest?.path ?? "")).toBe(true);
    expect(await listedTexts()).toEqual(["restored from the oldest automatic snapshot"]);
  });
});

describe("mem doctor backups line", () => {
  it("reports the backup directory and the newest snapshot", async () => {
    seedWithSnapshot(["doctor should see a backup"]);
    const result = await runCli(["doctor"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`backups: ${escapeRegExp(backupDir)} -- \\d+ snapshots?, newest `));
  });

  it("points at `mem backup` when a store with facts has no snapshot", async () => {
    seed(["no backup yet"]);
    // Pointing the directory at a file makes every snapshot attempt fail, including doctor's own open.
    writeFileSync(backupDir, "blocked", "utf8");
    const result = await runCli(["doctor"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`backups: none in ${backupDir}`);
    expect(result.stdout).toContain("mem backup");
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
