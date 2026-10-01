/** End-to-end tests for `mem backup` and `mem restore`, and the `backups:` line in `mem doctor`. The backup directory is deliberately outside the mem home -- a sibling of it by default -- so a store survives the deletion of `~/.mem` (or of `~/.claude`, which never held it). Driven through the real `run()` against a real database. */
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AUTO_SNAPSHOTS_KEPT, listSnapshots, takeSnapshot } from "../src/backup.js";
import { BACKUP_DIR_ENV, resolveDbPath } from "../src/db.js";
import { LATEST_SCHEMA_VERSION } from "../src/migrations.js";
import { getEpoch, insertFact, openStorage } from "../src/storage.js";
import { MS_PER_DAY } from "../src/timeUtils.js";
import { runCli } from "./support/cli.js";

let root: string;
let home: string;
let backupDir: string;
let priorBackupDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-backup-e2e-"));
  home = join(root, ".mem");
  backupDir = join(root, "backups");
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
  priorBackupDir = process.env[BACKUP_DIR_ENV];
  process.env[BACKUP_DIR_ENV] = backupDir;
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  if (priorBackupDir === undefined) {
    delete process.env[BACKUP_DIR_ENV];
  } else {
    process.env[BACKUP_DIR_ENV] = priorBackupDir;
  }
  rmSync(root, { recursive: true, force: true });
});

async function remember(text: string): Promise<void> {
  const result = await runCli(["remember", text, "--kind", "fact", "--scope", "global"]);
  expect(result.exitCode, result.stderr).toBe(0);
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
    await remember("the staging database is rebuilt nightly");
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
    await remember("first fact");
    await runCli(["backup"]);
    await remember("second fact");
    await runCli(["backup"]);

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
    await remember("kept across the restore");
    await runCli(["backup"]);
    const snapshot = listSnapshots(backupDir).find((candidate) => candidate.reason === "manual");
    await remember("written after the backup");
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

  it("refuses a file that is not a mem store and leaves the live store untouched", async () => {
    await remember("must survive a bad restore");
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
    await remember("must survive a foreign facts table");
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
    await remember("kept when the snapshot is from the future");
    await runCli(["backup"]);
    const snapshot = listSnapshots(backupDir).find((candidate) => candidate.reason === "manual");
    const db = new Database(snapshot?.path ?? "");
    db.pragma(`user_version = ${String(LATEST_SCHEMA_VERSION + 1)}`);
    db.close();
    await remember("written after the backup");

    const result = await runCli(["restore", snapshot?.path ?? ""]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("newer mem");
    expect(await listedTexts()).toEqual(["kept when the snapshot is from the future", "written after the backup"]);
  });

  it("moves the epoch past a source store whose epoch is ahead of the live one", async () => {
    await remember("the live store's only fact");
    const other = join(root, "other", "mem.db");
    const db = openStorage(other);
    for (let i = 0; i < 5; i += 1) {
      insertFact(db, { text: `fact ${String(i)} from another store`, kind: "fact", scope: "global", source_type: "user" });
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
    // Created by this open, so it takes no automatic snapshot of its own.
    const db = openStorage(resolveDbPath());
    try {
      insertFact(db, { text: "restored from the oldest automatic snapshot", kind: "fact", scope: "global", source_type: "user" });
      for (let i = 0; i < AUTO_SNAPSHOTS_KEPT; i += 1) {
        takeSnapshot(db, backupDir, "auto", new Date(Date.now() - (i + 2) * MS_PER_DAY));
      }
      // Written through the same handle, so no open snapshots it: the store has now changed since a newest snapshot two days old, and the next ordinary open would take one and prune the oldest.
      insertFact(db, { text: "written after the snapshots", kind: "fact", scope: "global", source_type: "user" });
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
    await remember("doctor should see a backup");
    await runCli(["backup"]);
    const result = await runCli(["doctor"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`backups: ${escapeRegExp(backupDir)} -- \\d+ snapshots?, newest `));
  });

  it("points at `mem backup` when a store with facts has no snapshot", async () => {
    await remember("no backup yet");
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
