/**
 * Snapshots of the mem store, kept outside the mem home so they outlive it (`resolveBackupDir` in
 * src/db.ts: `~/.mem-backups` by default).
 *
 * Every connection open of an existing store calls `snapshotOnOpen` (src/db.ts's `openDb`), which
 * copies the store at most once per `AUTO_SNAPSHOT_INTERVAL_MS`, only when it has changed since the
 * newest snapshot, and always before a pending migration rewrites it. mem has no daemon, so "the next
 * time anything opens the store" is the only schedule a backup can have; the hooks `mem init`
 * installs open it on every session, which makes that roughly daily for anyone using mem at all.
 *
 * A snapshot is a `VACUUM INTO` copy: a consistent, compacted, standalone SQLite file taken through
 * the open connection, so it never races a writer the way copying the `.db` file and its WAL sidecar
 * would. Its file name carries everything the retention and freshness rules read -- when it was
 * taken, the store's write epoch at the time, and why -- so neither depends on file mtimes, which a
 * copy or a sync tool rewrites. The epoch in the name is read from the finished copy, so it always
 * describes what the file holds, even when a write lands while the copy is being taken.
 *
 * Hooks open the store from several processes at once, so an automatic snapshot is taken only by the
 * open that creates `AUTO_SNAPSHOT_CLAIM` in the backup directory; the rest skip it. A claim, or a
 * temporary copy, left by a process that died mid-snapshot is cleared once it is an hour old.
 *
 * Deliberately independent of src/db.ts (which imports this module) and src/storage.ts (which imports
 * db.ts): the epoch comes from src/epoch.ts.
 */

import Database from "better-sqlite3";
import { closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { getEpoch } from "./epoch.js";
import { MEM_DB_MODE, MEM_HOME_MODE, restrictPermissions } from "./fileUtils.js";
import { MS_PER_DAY } from "./timeUtils.js";

/** Why a snapshot was taken. Only `auto` snapshots are ever pruned; the rest are kept until deleted by hand. */
export type SnapshotReason = "auto" | "manual" | "pre-migration" | "pre-restore";

const SNAPSHOT_REASONS: readonly SnapshotReason[] = ["auto", "manual", "pre-migration", "pre-restore"];

export interface Snapshot {
  path: string;
  name: string;
  takenAt: Date;
  /** The store's write epoch when the snapshot was taken. */
  epoch: number;
  reason: SnapshotReason;
  bytes: number;
}

/** The least time between two automatic snapshots. */
export const AUTO_SNAPSHOT_INTERVAL_MS = MS_PER_DAY;

/** How many automatic snapshots are kept: two weeks of daily copies. */
export const AUTO_SNAPSHOTS_KEPT = 14;

/** The file whose exclusive creation entitles one open to take a due automatic snapshot. Not snapshot-named. */
export const AUTO_SNAPSHOT_CLAIM = ".auto-snapshot.claim";

/** How old a claim or temporary copy must be before it is treated as left by a process that died. */
const ABANDONED_AFTER_MS = 60 * 60 * 1000;

const SNAPSHOT_NAME_PATTERN = new RegExp(`^mem-(\\d{8}T\\d{9}Z)-e(\\d+)-(${SNAPSHOT_REASONS.join("|")})\\.db$`);

/** `mem-20260930T091800123Z-e42-auto.db`: sortable, filesystem-safe on every platform, and self-describing. */
export function snapshotFileName(takenAt: Date, epoch: number, reason: SnapshotReason): string {
  return `mem-${takenAt.toISOString().replace(/[-:.]/g, "")}-e${String(epoch)}-${reason}.db`;
}

function parseSnapshotName(name: string): Pick<Snapshot, "takenAt" | "epoch" | "reason"> | undefined {
  const match = SNAPSHOT_NAME_PATTERN.exec(name);
  if (match === null) {
    return undefined;
  }
  const [, stamp = "", epoch = "", reason = ""] = match;
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`;
  const takenAt = new Date(iso);
  if (Number.isNaN(takenAt.getTime())) {
    return undefined;
  }
  return { takenAt, epoch: Number(epoch), reason: reason as SnapshotReason };
}

/**
 * Every snapshot in `dir`, newest first. A directory that does not exist yet -- or a path that is not a
 * directory -- holds none; any other failure to read it throws. Files that are not snapshot-named
 * (including an interrupted copy's temporary file) are ignored, and so is an entry that is gone by the
 * time it is looked at: one pruned by another process, or a dangling link.
 */
export function listSnapshots(dir: string): Snapshot[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return [];
    }
    throw error;
  }
  const snapshots: Snapshot[] = [];
  for (const name of names) {
    const parsed = parseSnapshotName(name);
    if (parsed === undefined) {
      continue;
    }
    const path = join(dir, name);
    const bytes = sizeOf(path);
    if (bytes !== undefined) {
      snapshots.push({ path, name, ...parsed, bytes });
    }
  }
  // Name breaks a same-millisecond tie so every caller sees one order.
  return snapshots.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime() || b.name.localeCompare(a.name));
}

/**
 * Copies the store behind `db` into `dir` as a new snapshot and returns it.
 *
 * Written to a temporary name and renamed into place, so a crash or a full disk mid-copy never leaves
 * a truncated file that `listSnapshots` would offer as a restore point. Owner-only permissions, like
 * the store itself: a snapshot holds the same fact rows. The epoch it is named for is read from the
 * finished copy, never from `db` beforehand, which a write could move before the copy starts.
 */
export function takeSnapshot(db: Database.Database, dir: string, reason: SnapshotReason, now: Date = new Date()): Snapshot {
  ensureBackupDir(dir);
  const temporary = join(dir, `.mem-snapshot-${String(process.pid)}-${String(now.getTime())}.tmp`);
  try {
    db.prepare("VACUUM INTO ?").run(temporary);
    restrictPermissions(temporary, MEM_DB_MODE);
    const epoch = readStore(temporary, getEpoch);
    const name = snapshotFileName(now, epoch, reason);
    const path = join(dir, name);
    renameSync(temporary, path);
    return { path, name, takenAt: now, epoch, reason, bytes: statSync(path).size };
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Deletes every `auto` snapshot in `dir` beyond the newest `keep`; returns how many it removed. */
export function pruneAutoSnapshots(dir: string, keep: number = AUTO_SNAPSHOTS_KEPT): number {
  const surplus = listSnapshots(dir)
    .filter((snapshot) => snapshot.reason === "auto")
    .slice(keep);
  for (const snapshot of surplus) {
    rmSync(snapshot.path, { force: true });
  }
  return surplus.length;
}

export interface SnapshotOnOpenOptions {
  dir: string;
  /** Whether migrations are about to run against this store; if so it is copied first, unconditionally. */
  pendingMigrations: boolean;
  now?: Date;
}

/**
 * The automatic snapshot `openDb` takes of an existing store, or `undefined` when none was due.
 *
 * Due when the store has ever been written (epoch above 0), the newest snapshot of any kind is at
 * least `AUTO_SNAPSHOT_INTERVAL_MS` old, and the store has changed since it (a different epoch): a
 * store nobody writes to is not copied again however long it sits. Only the open holding
 * `AUTO_SNAPSHOT_CLAIM` takes it, after checking it is still due -- another open may have taken it
 * between the first check and the claim.
 *
 * A pending migration overrides all of that -- the copy taken right before a schema change is the
 * one a failed upgrade needs -- unless a `pre-migration` snapshot of this very store state (same epoch,
 * same schema version) already exists, as it does when an earlier open's migration failed. It takes no
 * claim: several processes opening a store that needs migrating at the same moment may each copy it,
 * which costs disk once per upgrade and never loses the copy.
 *
 * Never throws. A backup directory that cannot be written is a reason for `mem doctor` to warn, not
 * for every mem command -- the recall hooks included -- to stop working.
 */
export function snapshotOnOpen(db: Database.Database, options: SnapshotOnOpenOptions): Snapshot | undefined {
  const { dir } = options;
  const now = options.now ?? new Date();
  try {
    if (options.pendingMigrations) {
      return hasPreMigrationSnapshot(db, dir) ? undefined : takeSnapshot(db, dir, "pre-migration", now);
    }
    const epoch = getEpoch(db);
    if (!autoSnapshotDue(dir, epoch, now)) {
      return undefined;
    }
    const claim = claimAutoSnapshot(dir);
    if (claim === undefined) {
      return undefined;
    }
    try {
      if (!autoSnapshotDue(dir, epoch, now)) {
        return undefined;
      }
      removeAbandonedTemporaries(dir);
      const snapshot = takeSnapshot(db, dir, "auto", now);
      pruneAutoSnapshots(dir);
      return snapshot;
    } finally {
      rmSync(claim, { force: true });
    }
  } catch {
    // Intentionally silent: see the doc comment above.
    return undefined;
  }
}

function autoSnapshotDue(dir: string, epoch: number, now: Date): boolean {
  if (epoch === 0) {
    return false;
  }
  const [newest] = listSnapshots(dir);
  return newest === undefined || (newest.epoch !== epoch && now.getTime() - newest.takenAt.getTime() >= AUTO_SNAPSHOT_INTERVAL_MS);
}

/** Whether a `pre-migration` snapshot already holds the store behind `db` exactly as it stands. */
function hasPreMigrationSnapshot(db: Database.Database, dir: string): boolean {
  const epoch = getEpoch(db);
  const version = db.pragma("user_version", { simple: true });
  return listSnapshots(dir).some(
    (snapshot) =>
      snapshot.reason === "pre-migration" &&
      snapshot.epoch === epoch &&
      readStore(snapshot.path, (copy) => copy.pragma("user_version", { simple: true })) === version
  );
}

/**
 * Creates the claim file and returns its path, or `undefined` when another open holds it. A claim
 * an hour old was left by a process that died mid-snapshot and is taken over. Two opens taking over
 * the same abandoned claim at once can both proceed; the recheck after claiming makes the second
 * skip unless the first has not finished, and the cost of both finishing is one extra auto snapshot.
 */
function claimAutoSnapshot(dir: string): string | undefined {
  ensureBackupDir(dir);
  const claim = join(dir, AUTO_SNAPSHOT_CLAIM);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      closeSync(openSync(claim, "wx", MEM_DB_MODE));
      return claim;
    } catch (error) {
      if (errorCode(error) !== "EEXIST" || !isAbandoned(claim)) {
        return undefined;
      }
      rmSync(claim, { force: true });
    }
  }
  return undefined;
}

/** Deletes the temporary copies in `dir` that a process which died mid-snapshot left behind. */
function removeAbandonedTemporaries(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name.startsWith(".") && name.endsWith(".tmp") && isAbandoned(path)) {
      rmSync(path, { force: true });
    }
  }
}

/** Whether `path` was last written `ABANDONED_AFTER_MS` ago or more; a path already gone counts. */
function isAbandoned(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs >= ABANDONED_AFTER_MS;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return true;
    }
    throw error;
  }
}

function ensureBackupDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: MEM_HOME_MODE });
  restrictPermissions(dir, MEM_HOME_MODE);
}

/** Runs `read` against the store file at `path`, opened read-only and closed again before returning. */
function readStore<T>(path: string, read: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** The size of `path` in bytes, or `undefined` when nothing is there (including a dangling link). */
function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
