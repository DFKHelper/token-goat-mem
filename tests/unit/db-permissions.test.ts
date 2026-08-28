/**
 * Permission tests for the mem home directory and database file (src/db.ts).
 *
 * Facts are exactly the class of data that must not be world-readable, and `openDb` used to leave
 * both the directory and the file to the process umask -- 0755 and 0644 under the default 022, which
 * on a shared host means every local account can read the store. These tests pin the modes so a
 * future refactor of `openDb` cannot quietly hand that back.
 *
 * POSIX only: on Windows `chmod` toggles only the read-only bit and carries no read-permission
 * meaning, so the modes asserted here are not the mechanism protecting the file there -- the profile
 * ACL `~/.mem` inherits is. Skipping is the honest outcome, not a coverage gap.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../../src/db.js";

const isWindows = process.platform === "win32";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mem-db-perms-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("openDb file permissions", () => {
  it.skipIf(isWindows)("creates the mem home directory as 0700, not umask-default 0755", () => {
    const home = join(workDir, "fresh-home");
    const db = openDb(join(home, "mem.db"));
    try {
      expect(mode(home)).toBe(0o700);
    } finally {
      db.close();
    }
  });

  it.skipIf(isWindows)("creates the database file as 0600, not umask-default 0644", () => {
    const dbPath = join(workDir, "home", "mem.db");
    const db = openDb(dbPath);
    try {
      expect(mode(dbPath)).toBe(0o600);
    } finally {
      db.close();
    }
  });

  it.skipIf(isWindows)("restricts the -wal/-shm sidecars, which hold the same fact rows as the database", () => {
    const dbPath = join(workDir, "home", "mem.db");
    const db = openDb(dbPath);
    try {
      // WAL mode is on from `openDb`, so at least `-shm` exists here. Assert whichever sidecars the
      // engine actually created rather than requiring both -- `-wal` creation timing is SQLite's.
      const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`].filter((path) => existsSync(path));
      expect(sidecars.length).toBeGreaterThan(0);
      for (const sidecar of sidecars) {
        expect(mode(sidecar)).toBe(0o600);
      }
    } finally {
      db.close();
    }
  });

  it.skipIf(isWindows)("tightens a pre-existing world-readable home, so an upgrade repairs the old default", () => {
    // What a database created by <= 0.2.2 under a 022 umask looks like on disk.
    const home = join(workDir, "legacy-home");
    mkdirSync(home, { recursive: true, mode: 0o755 });
    expect(mode(home)).toBe(0o755);

    const db = openDb(join(home, "mem.db"));
    try {
      expect(mode(home)).toBe(0o700);
    } finally {
      db.close();
    }
  });
});
