/** The real-launch contract of `spawnProbe` (src/probeSpawn.ts), the one place src/ starts a probe of the `mem` binary: a child that answers at once is reported as it answered, and a child that never answers is killed with everything it started when the budget expires. Every case is one of those two kinds, so no clock decides a verdict: an answering child leaves a budget it never spends, and a child that blocks forever is always cut off, whatever the machine's speed. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The direct-binary case reads the pid each launch was given, so it never waits for the child to report one.
vi.mock("node:child_process", async (importOriginal) => (await import("./support/fakeProbe.js")).withLaunchLog(await importOriginal<typeof import("node:child_process")>()));

import { spawnProbe } from "../src/probeSpawn.js";
import { launchedPids, resetProbe } from "./support/fakeProbe.js";

const isWindows = process.platform === "win32";
/** The budget of a child that answers at once: it only bounds a hung launch and a child that answers never spends it. */
const HANG_BOUND_MS = 20_000;
/** The budget of a child that never answers: it ends every such launch, and no assertion reads how long that took. */
const NEVER_ANSWERS_BUDGET_MS = 1000;
/** The budget a launch spends after its child announced itself: the child blocks forever, so any value ends it with the child alive and running. */
const AFTER_ANNOUNCE_BUDGET_MS = 100;
/** A `mem.cmd` that answers `--version` the moment cmd.exe runs it, so a really launched shim needs no second process. */
const INSTANT_SHIM = "@echo off\r\necho 0.0.0-test-shim\r\n";
/** A script that blocks its only thread forever: no timer runs out, no event can end it, and only a kill does. */
const BLOCK_FOREVER = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n";
/** A script that writes its own pid synchronously, then blocks forever, so the pid is on stdout before the first byte can be read. */
const ANNOUNCE_THEN_BLOCK = `require("node:fs").writeSync(1, String(process.pid) + "\\n");\n${BLOCK_FOREVER}`;

describe("spawnProbe against a child that answers at once", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-probe-answers-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  it("a node child that prints and exits is reported with its status and output", () => {
    writeFileSync(join(dir, "answer.cjs"), 'process.stdout.write("answered\\n");\nprocess.exit(3);\n', "utf8");
    const result = spawnProbe(process.execPath, [join(dir, "answer.cjs")], HANG_BOUND_MS);
    expect(result.errorCode).toBeUndefined();
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("answered\n");
  });

  it.runIf(isWindows)("spawnProbe still runs a .cmd shim whose path holds a space", () => {
    const spaced = join(dir, "with space");
    mkdirSync(spaced);
    writeFileSync(join(spaced, "mem.cmd"), INSTANT_SHIM, "utf8");
    const result = spawnProbe(join(spaced, "mem.cmd"), ["--version"], HANG_BOUND_MS);
    expect(result.errorCode).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it.runIf(isWindows)("spawnProbe still runs a .cmd shim with ordinary arguments", () => {
    writeFileSync(join(dir, "mem.cmd"), INSTANT_SHIM, "utf8");
    const result = spawnProbe(join(dir, "mem.cmd"), ["--version"], HANG_BOUND_MS);
    expect(result.errorCode).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0.0.0-test-shim");
  });
});

describe("spawnProbe against a child that never answers", () => {
  let dir: string;

  beforeEach(() => {
    resetProbe();
    dir = mkdtempSync(join(tmpdir(), "mem-probe-never-"));
  });

  afterEach(() => {
    resetProbe();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("a direct binary that blocks forever is reported unanswered and its process is gone", () => {
    writeFileSync(join(dir, "block.cjs"), BLOCK_FOREVER, "utf8");
    const result = spawnProbe(process.execPath, [join(dir, "block.cjs")], NEVER_ANSWERS_BUDGET_MS);
    expect(result).toMatchObject({ status: null, errorCode: "ETIMEDOUT" });
    const pids = launchedPids(process.execPath);
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) {
      expect(isAlive(pid), `pid ${pid} is still alive after its probe timed out`).toBe(false);
    }
  });

  it.runIf(isWindows)("a .cmd shim that never answers is reported unanswered", () => {
    writeFileSync(join(dir, "mem.cmd"), "@echo off\r\n:spin\r\ngoto spin\r\n", "utf8");
    expect(spawnProbe(join(dir, "mem.cmd"), ["--version"], NEVER_ANSWERS_BUDGET_MS)).toMatchObject({ status: null, errorCode: "ETIMEDOUT" });
  });

  it.runIf(isWindows)("a .cmd shim's running child is killed with the shim's whole process tree when the budget expires", () => {
    writeFileSync(join(dir, "announce.cjs"), ANNOUNCE_THEN_BLOCK, "utf8");
    writeFileSync(join(dir, "mem.cmd"), `@echo off\r\n"${process.execPath}" "${join(dir, "announce.cjs")}"\r\n`, "utf8");
    const result = spawnProbe(join(dir, "mem.cmd"), ["--version"], AFTER_ANNOUNCE_BUDGET_MS, { budgetStartsOnOutput: true });
    const announced = /^(\d+)\s*$/u.exec(result.stdout)?.[1];
    const pid = announced === undefined ? undefined : Number(announced);
    try {
      expect(result.errorCode, "the shim's child must be running, not finished, when the budget expires").toBe("ETIMEDOUT");
      expect(pid, `the shim's child never announced its pid; stdout was ${JSON.stringify(result.stdout)}`).toBeGreaterThan(0);
      expect(pid).not.toBe(process.pid);
      expect(isAlive(pid ?? 0), `pid ${pid} started by the shim outlived its probe`).toBe(false);
    } finally {
      if (pid !== undefined && isAlive(pid)) {
        spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
      }
    }
  });
});
