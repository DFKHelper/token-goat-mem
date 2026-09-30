/**
 * `mem backup` and `mem restore`: the hand-driven side of the snapshots src/backup.ts takes on its
 * own. Snapshots live in `resolveBackupDir()` -- outside the mem home -- so deleting `~/.mem`, or
 * `~/.claude` (which never held the store), leaves every restore point in place.
 */

import type { Command } from "commander";
import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { listSnapshots, restoreSnapshot, takeSnapshot, validateSnapshotFile, type Snapshot } from "./backup.js";
import { extractErrorMessage, guard, UsageError, withDb } from "./cliRuntime.js";
import { resolveBackupDir, resolveDbPath } from "./db.js";
import { formatBytes } from "./fileUtils.js";
import { advanceEpochPast, getEpoch } from "./storage.js";

function describeSnapshot(snapshot: Snapshot): string {
  return `${snapshot.name}  ${snapshot.takenAt.toISOString()}  epoch ${String(snapshot.epoch)}  ${formatBytes(snapshot.bytes)}  ${snapshot.reason}`;
}

/** The canonical form of `path` for an identity comparison: resolved through symlinks when it exists. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The snapshot file `restore <snapshot>` names: an existing path as given, else a bare file name looked
 * up in the backup directory -- so the names `mem backup --list` prints can be pasted back verbatim.
 */
function resolveSnapshotArg(arg: string, dir: string): string {
  if (existsSync(arg)) {
    return arg;
  }
  if (basename(arg) === arg) {
    const candidate = join(dir, arg);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new UsageError(`restore: no snapshot named ${arg} in ${dir} (run \`mem backup --list\`)`);
}

export function registerBackupCommands(program: Command): void {
  program
    .command("backup")
    .description(
      "Copy the store into the backup directory (~/.mem-backups beside the mem home, or TOKEN_GOAT_MEM_BACKUP_DIR), " +
        "outside the mem home so deleting it -- or ~/.claude -- loses nothing. mem already snapshots the store on its own " +
        "at most once a day when it has changed, and always before a schema migration; this takes one now. " +
        "--list shows every snapshot, newest first."
    )
    .option("--list", "list the snapshots instead of taking one")
    .action(
      guard(async (options: { list?: boolean }) => {
        const dir = resolveBackupDir();
        if (options.list === true) {
          const snapshots = listSnapshots(dir);
          if (snapshots.length === 0) {
            process.stdout.write(`no snapshots in ${dir}\n`);
            return;
          }
          process.stdout.write(`${[`snapshots in ${dir}:`, ...snapshots.map(describeSnapshot)].join("\n")}\n`);
          return;
        }
        const snapshot = await withDb((db) => takeSnapshot(db, dir, "manual"));
        process.stdout.write(`backed up to ${snapshot.path} (epoch ${String(snapshot.epoch)}, ${formatBytes(snapshot.bytes)})\n`);
      })
    );

  program
    .command("restore <snapshot>")
    .description(
      "Replace the store with a snapshot -- a name from `mem backup --list` or a path to a snapshot file. The store it " +
        "replaces is snapshotted first (a pre-restore snapshot, printed on success), so a restore can itself be undone. " +
        "The epoch moves forward past both stores so every cache keyed on it refreshes."
    )
    .action(
      guard(async (arg: string) => {
        const dir = resolveBackupDir();
        const dbPath = resolveDbPath();
        const source = resolveSnapshotArg(arg, dir);
        if (canonicalPath(source) === canonicalPath(dbPath)) {
          throw new UsageError(`restore: ${source} is the live store itself`);
        }
        try {
          validateSnapshotFile(source);
        } catch (error) {
          throw new UsageError(`restore: ${source} is not a usable mem store (${extractErrorMessage(error)})`);
        }
        const { previousEpoch, preRestore } = await withDb((db) => ({
          previousEpoch: getEpoch(db),
          preRestore: takeSnapshot(db, dir, "pre-restore"),
        }));
        await restoreSnapshot(source, dbPath);
        const epoch = await withDb((db) => advanceEpochPast(db, previousEpoch));
        process.stdout.write(
          `restored ${source}; epoch now ${String(epoch)}\n` +
            `the replaced store is saved at ${preRestore.path} (\`mem restore ${preRestore.path}\` undoes this)\n`
        );
      })
    );
}
