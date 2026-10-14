/** Tests for the advisory lockfile `writeManagedFile` holds beside a managed file while it reads, transforms and renames it, so two `mem init` processes writing one file cannot lose each other's update. The lock is held from the test (a live pid, the test's own, or a dead one) and the writer is called in process, so nothing here races or sleeps. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codex, copilotCli, WiringLockError, writeManagedFile } from "../src/wiring.js";

let dir: string;
let target: string;
let lockPath: string;
// A pid no process can hold: above every platform's pid ceiling, so signalling it fails with ESRCH.
const DEAD_PID = 2147483646;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mem-lock-"));
  target = join(dir, "AGENTS.md");
  lockPath = `${target}.token-goat-mem.lock`;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lockFilesIn = (path: string): string[] => readdirSync(path).filter((name) => name.endsWith(".lock"));

describe("writeManagedFile lock", () => {
  it("refuses to write while a live process holds the lock, names the lock path, and leaves the file and the lock alone", () => {
    writeFileSync(target, "original\n", "utf8");
    writeFileSync(lockPath, String(process.pid), "utf8");

    let thrown: unknown;
    try {
      writeManagedFile({ path: target, transform: () => "changed\n" }, { lock: { waitMs: 0 } });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WiringLockError);
    expect((thrown as Error).message).toContain(lockPath);
    expect(readFileSync(target, "utf8")).toBe("original\n");
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
  });

  it("waits for a held lock and writes once it is released, leaving no lock behind", () => {
    writeFileSync(target, "original\n", "utf8");
    writeFileSync(lockPath, String(process.pid), "utf8");
    const pauses: number[] = [];

    const change = writeManagedFile(
      { path: target, transform: () => "changed\n" },
      {
        lock: {
          pause: (ms) => {
            pauses.push(ms);
            rmSync(lockPath, { force: true });
          },
        },
      }
    );

    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toBeGreaterThan(0);
    expect(change.action).toBe("update");
    expect(readFileSync(target, "utf8")).toBe("changed\n");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("recovers a lock left by a process that no longer exists, without waiting", () => {
    writeFileSync(target, "original\n", "utf8");
    writeFileSync(lockPath, String(DEAD_PID), "utf8");
    const pauses: number[] = [];

    const change = writeManagedFile({ path: target, transform: () => "changed\n" }, { lock: { waitMs: 0, pause: (ms) => pauses.push(ms) } });

    expect(change.action).toBe("update");
    expect(readFileSync(target, "utf8")).toBe("changed\n");
    expect(pauses).toEqual([]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("treats a lock whose content names no pid as held, never as stale", () => {
    writeFileSync(target, "original\n", "utf8");
    writeFileSync(lockPath, "", "utf8");
    expect(() => writeManagedFile({ path: target, transform: () => "changed\n" }, { lock: { waitMs: 0 } })).toThrow(WiringLockError);
    expect(readFileSync(target, "utf8")).toBe("original\n");
    expect(existsSync(lockPath)).toBe(true);
  });

  it("leaves no lock behind after a write, a delete, or a transform that throws under the lock", () => {
    writeManagedFile({ path: target, transform: () => "first\n" });
    expect(lockFilesIn(dir)).toEqual([]);

    writeManagedFile({ path: target, transform: () => "" }, { backup: false, deleteIfEmpty: true });
    expect(existsSync(target)).toBe(false);
    expect(lockFilesIn(dir)).toEqual([]);

    writeFileSync(target, "v1\n", "utf8");
    let calls = 0;
    expect(() =>
      writeManagedFile({
        path: target,
        transform: (current) => {
          calls += 1;
          if (calls === 1) {
            writeFileSync(target, "v2\n", "utf8");
            return `${current}-a\n`;
          }
          throw new Error("transform failed under the lock");
        },
      })
    ).toThrow("transform failed under the lock");
    expect(lockFilesIn(dir)).toEqual([]);
  });

  it("takes no lock and creates no directory for a write that changes nothing", () => {
    const nested = join(dir, "not-yet", "settings.json");
    expect(writeManagedFile({ path: nested, transform: () => undefined }).action).toBe("noop");
    expect(existsSync(join(dir, "not-yet"))).toBe(false);
  });

  it("creates the parent directory for the lock when the file is new", () => {
    const nested = join(dir, ".vscode", "tasks.json");
    expect(writeManagedFile({ path: nested, transform: () => "{}\n" }).action).toBe("create");
    expect(lockFilesIn(join(dir, ".vscode"))).toEqual([]);
  });

  it("does not touch the .bak snapshot logic: a lock never becomes the snapshot, and a held lock leaves no snapshot", () => {
    writeFileSync(target, "user prose\n", "utf8");
    writeFileSync(lockPath, String(process.pid), "utf8");
    expect(() => writeManagedFile({ path: target, transform: () => "user prose\nmem\n" }, { lock: { waitMs: 0 } })).toThrow(WiringLockError);
    expect(existsSync(`${target}.token-goat-mem.bak`)).toBe(false);
    rmSync(lockPath, { force: true });
    writeManagedFile({ path: target, transform: () => "user prose\nmem\n" });
    expect(readFileSync(`${target}.token-goat-mem.bak`, "utf8")).toBe("user prose\n");
  });
});

describe("tools that share one file take the lock in turn", () => {
  it("installs and uninstalls two tools on one AGENTS.md and leaves no lockfile beside it", () => {
    mkdirSync(join(dir, "root"), { recursive: true });
    const opts = { root: join(dir, "root"), homeDir: join(dir, "home") };
    codex.install(opts);
    copilotCli.install(opts);
    const agents = readFileSync(join(opts.root, "AGENTS.md"), "utf8");
    expect(agents).toContain("codex");
    expect(agents).toContain("copilot-cli");
    expect(lockFilesIn(opts.root)).toEqual([]);
    codex.uninstall(opts);
    copilotCli.uninstall(opts);
    expect(existsSync(join(opts.root, "AGENTS.md"))).toBe(false);
    expect(lockFilesIn(opts.root)).toEqual([]);
  });
});
