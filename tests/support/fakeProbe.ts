/** A scripted stand-in for `spawnProbe` (src/probeSpawn.ts), the one place src/ starts a probe of the `mem` binary: a test decides the verdict logic (capable, old, cannot run, no answer, retry at 3x the budget, one launch per run) by scripting what each probe returns, so no process starts and no clock decides the outcome. Wire it in with `vi.mock("../src/probeSpawn.js", async (importOriginal) => (await import("./support/fakeProbe.js")).withFakeProbe(await importOriginal<typeof import("../src/probeSpawn.js")>()))`, then `installProbe(responder)` in a test and `resetProbe()` after it. With no responder installed a probe falls through to the real `spawnProbe`, so a test that really spawns (a kill, an exit code) is untouched. This module imports only types from src/, because a mock factory that loads a module importing the mocked one stalls collection. */

import type * as childProcess from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ProbeSpawnResult } from "../../src/probeSpawn.js";

/** One probe as `spawnProbe` received it. */
export interface ProbeCall {
  readonly bin: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/** Decides what one probe returns. */
export type ProbeResponder = (call: ProbeCall) => ProbeSpawnResult;

interface FakeProbeState {
  responder: ProbeResponder | null;
  calls: ProbeCall[];
  launched: LaunchedProcess[];
}

/** One process a synchronous launch started: the program it ran and the pid the operating system gave it. */
interface LaunchedProcess {
  readonly file: string;
  readonly pid: number | undefined;
}

// The state hangs off globalThis, so a test that reloads the module graph (vi.resetModules) still talks to the same responder and call log.
const STATE_KEY = Symbol.for("token-goat-mem.tests.fakeProbe");

function state(): FakeProbeState {
  const holder = globalThis as unknown as Record<symbol, FakeProbeState | undefined>;
  const existing = holder[STATE_KEY];
  if (existing !== undefined) {
    return existing;
  }
  const created: FakeProbeState = { responder: null, calls: [], launched: [] };
  holder[STATE_KEY] = created;
  return created;
}

/** Replaces `spawnProbe` in the module with one that records the call and, when a responder is installed, answers from it instead of starting a process. */
export function withFakeProbe<T extends { spawnProbe: (binPath: string, args: readonly string[], timeoutMs: number) => ProbeSpawnResult }>(actual: T): T {
  return {
    ...actual,
    spawnProbe: (bin: string, args: readonly string[], timeoutMs: number): ProbeSpawnResult => {
      const { responder, calls } = state();
      calls.push({ bin, args: [...args], timeoutMs });
      return responder === null ? actual.spawnProbe(bin, args, timeoutMs) : responder({ bin, args: [...args], timeoutMs });
    },
  };
}

/** Wraps `node:child_process` so each `spawnSync` records the pid of the process it started, which is how a test that really launches a hanging probe learns the pid without waiting for the child to report it. */
export function withLaunchLog(actual: typeof childProcess): typeof childProcess {
  const spawnSync = (...args: Parameters<typeof childProcess.spawnSync>): ReturnType<typeof childProcess.spawnSync> => {
    const result = actual.spawnSync(...args);
    state().launched.push({ file: String(args[0]), pid: result.pid });
    return result;
  };
  // The cast is the overloaded signature of spawnSync, which a wrapper over its last overload cannot satisfy by itself.
  return { ...actual, spawnSync: spawnSync as typeof childProcess.spawnSync };
}

/** The pid of every process `spawnSync` started for `file` since the last `resetProbe`, in order. */
export function launchedPids(file: string): number[] {
  return state().launched.flatMap((launch) => (launch.file === file && launch.pid !== undefined ? [launch.pid] : []));
}

/** Answers every later probe from `responder` until `resetProbe`, and forgets the calls recorded so far. */
export function installProbe(responder: ProbeResponder): void {
  const current = state();
  current.responder = responder;
  current.calls = [];
}

/** Back to starting real probes, with no recorded calls. */
export function resetProbe(): void {
  const current = state();
  current.responder = null;
  current.calls = [];
  current.launched = [];
}

/** Every probe `spawnProbe` received since the last `installProbe` or `resetProbe`, in order. */
export function probeCalls(): readonly ProbeCall[] {
  return [...state().calls];
}

const ANSWERED = (status: number, stdout = ""): ProbeSpawnResult => ({ status, stdout, stderr: "" });

/** The help text of a `mem` that has every subcommand and flag a hook probe looks for. */
export const CAPABLE_HELP = "--hint-format --hook-stdin --delta --quiet --root session-start user-prompt-submit stop pre-compact\n";

/** A probe that never ran to an exit: the budget expired, which says nothing about the binary. */
export const UNANSWERED_PROBE: ProbeResponder = () => ({ status: null, stdout: "", stderr: "", errorCode: "ETIMEDOUT" });

/** A binary the shell cannot launch: exit 127 for every probe. */
export const NOT_RUNNABLE_PROBE: ProbeResponder = () => ANSWERED(127);

/** A `mem` that answers `--version` with `version` and `<subcommand> --help` with `helpOf(subcommand)`, and exits 1 for a subcommand `helpOf` returns null for, as Commander does for an unknown one. */
export function memProbe(version: string, helpOf: (subcommand: string) => string | null): ProbeResponder {
  return ({ args }) => {
    if (args.length === 1 && args[0] === "--version") {
      return ANSWERED(0, `${version}\n`);
    }
    const subcommand = args.at(-2);
    const help = args.at(-1) === "--help" && subcommand !== undefined ? helpOf(subcommand) : null;
    return help === null ? ANSWERED(1) : ANSWERED(0, help);
  };
}

/** A current `mem`: every subcommand answers `--help` with the full flag and slug list. */
export const CAPABLE_PROBE: ProbeResponder = memProbe("0.0.0-test-shim", () => CAPABLE_HELP);

/** An install that predates the `hook` command: `recall --help` lacks the newer flags and every other subcommand exits 1. */
export const OLD_PROBE: ProbeResponder = memProbe("0.2.5", (subcommand) => (subcommand === "recall" ? "--hint-format --root\n" : null));

/** Answers call number n from `responders[n]`, and every call past the last from the last one. */
export function inOrder(...responders: readonly ProbeResponder[]): ProbeResponder {
  let next = 0;
  return (call) => {
    const responder = responders[Math.min(next, responders.length - 1)];
    next += 1;
    if (responder === undefined) {
      throw new Error("inOrder needs at least one responder");
    }
    return responder(call);
  };
}

/** Writes an empty `mem` and `mem.cmd` into `dir`: files a PATH lookup finds and a scripted probe never launches. */
export function writeProbeTarget(dir: string): void {
  writeFileSync(join(dir, "mem"), "", "utf8");
  chmodSync(join(dir, "mem"), 0o755);
  writeFileSync(join(dir, "mem.cmd"), "", "utf8");
}
