import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const TESTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARDS_DIR = join(TESTS_DIR, "guards");

/** A test file that runs doctor or init in-process and may use the real probe, each with the one-line reason it must. Empty today: every in-process doctor or init run goes through the scripted probe. */
const REAL_PROBE_ALLOWLIST: Readonly<Record<string, string>> = {};

/** An in-process `doctor` or `init` run: `runCli(["doctor"`, `runCli(["init"`, or `run(["node", "mem", "doctor"`. */
const RUNS_DOCTOR_OR_INIT = /\b(?:runCli\(\s*\[|run\(\s*\[\s*"node",\s*"mem",)\s*"(?:doctor|init)"/u;
/** The module mock that scripts what a probe of the `mem` on PATH returns, so no process starts. */
const MOCKS_PROBE_SPAWN = /vi\.mock\(\s*["'][^"']*src\/probeSpawn(?:\.js)?["']/u;

/** Every `.test.ts` file under `tests/` outside this guard directory, as a path relative to `tests/` with forward slashes. */
function testFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (full === GUARDS_DIR) {
      continue;
    }
    if (statSync(full).isDirectory()) {
      found.push(...testFiles(full));
    } else if (entry.endsWith(".test.ts")) {
      found.push(relative(TESTS_DIR, full).split(sep).join("/"));
    }
  }
  return found.sort();
}

function filesRunningDoctorOrInit(): string[] {
  return testFiles(TESTS_DIR).filter((file) => RUNS_DOCTOR_OR_INIT.test(readFileSync(join(TESTS_DIR, file), "utf8")));
}

describe("a test that runs doctor or init in-process never starts the real mem on PATH", () => {
  it("mocks src/probeSpawn.js in every such file, or names it in the allowlist with a reason", () => {
    const running = filesRunningDoctorOrInit();

    expect(running, "the scan found no test running doctor or init, so it is looking in the wrong place").toContain("cli-wiring.test.ts");
    const unmocked = running.filter((file) => !MOCKS_PROBE_SPAWN.test(readFileSync(join(TESTS_DIR, file), "utf8")) && REAL_PROBE_ALLOWLIST[file] === undefined);
    expect(
      unmocked,
      `these tests run doctor or init without vi.mock("../src/probeSpawn.js", ...withFakeProbe) from tests/support/fakeProbe.ts, so the mem on this machine's PATH decides their result and they pay cold node starts: ${unmocked.join(", ")}`
    ).toEqual([]);
  });

  it("keeps the allowlist honest: each entry has a reason and still runs doctor or init without the mock", () => {
    const running = new Set(filesRunningDoctorOrInit());
    const stale = Object.entries(REAL_PROBE_ALLOWLIST)
      .filter(([file, reason]) => reason.trim() === "" || !running.has(file) || MOCKS_PROBE_SPAWN.test(readFileSync(join(TESTS_DIR, file), "utf8")))
      .map(([file]) => file);

    expect(stale, `these allowlist entries have no reason, no longer run doctor or init, or already mock the probe: ${stale.join(", ")}`).toEqual([]);
  });
});
