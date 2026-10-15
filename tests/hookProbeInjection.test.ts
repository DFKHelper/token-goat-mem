/** A hook command read from a project's settings.json is attacker-controlled text: `mem doctor` must never let it reach a shell, and must probe a project hook's bundle with the node that is running, never a `node` found through the working directory. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";

const spawned = vi.hoisted((): unknown[][] => []);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => {
      spawned.push(args);
      return Reflect.apply(actual.spawnSync, actual, args);
    },
  };
});

// A test scripts what a probe returns with `installProbe`; a test that installs nothing reaches the real `spawnProbe` (the cmd.exe quoting cases).
vi.mock("../src/probeSpawn.js", async (importOriginal) => (await import("./support/fakeProbe.js")).withFakeProbe(await importOriginal<typeof import("../src/probeSpawn.js")>()));

import { spawnProbe } from "../src/probeSpawn.js";
import { checkClaudeHookHealth, checkHookCapability, CLAUDE_HOOK_EVENTS, isLegacyHookShape, MEM_PROBE_TIMEOUT_MS, parseHookCommandSpec } from "../src/wiring.js";
import { runCli } from "./support/cli.js";
import { CAPABLE_PROBE, installProbe, probeCalls, resetProbe, writeProbeTarget } from "./support/fakeProbe.js";

const isWindows = process.platform === "win32";
/** The budget handed to a probe whose verdict does not depend on it: a scripted probe never reads it, and a refused one never starts a process to spend it. */
const BUDGET_MS = MEM_PROBE_TIMEOUT_MS;
/** A `mem.cmd` a refused probe must never run: if the quoting guard failed, it would be launched and the injected marker would exist. */
const INSTANT_SHIM = "@echo off\r\necho 0.0.0-test-shim\r\n";
const ROOT_ARG = '--root "$CLAUDE_PROJECT_DIR"';
const FALLBACK = 'echo "mem failed (exit $?); run mem doctor"';

/** Forward slashes, so a path can sit inside a cmd.exe redirect in a payload. */
function slashed(path: string): string {
  return path.split(sep).join("/");
}

/** A hook command in the Windows user shape that runs `bundle`. */
function bundleHookCommand(bundle: string): string {
  return `if [ -f "${slashed(bundle)}" ]; then node "${slashed(bundle)}" hook session-start || ${FALLBACK}; elif command -v mem >/dev/null 2>&1; then mem hook session-start || ${FALLBACK}; fi`;
}

/** Writes a bundle that creates `marker` when it is executed. */
function writeMarkerBundle(path: string, marker: string): void {
  writeFileSync(path, `process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(slashed(marker))}, "ran");\n`, "utf8");
}

/** The same hostile subcommand wrapped in every shape mem init has ever stamped. */
function wrappedIn(subcommand: string): string[] {
  return [
    `mem ${subcommand} --hint-format ${ROOT_ARG}`,
    `command -v mem >/dev/null 2>&1 && mem ${subcommand} --hint-format ${ROOT_ARG} || true`,
    `if command -v mem >/dev/null 2>&1; then mem ${subcommand} --hint-format ${ROOT_ARG} || ${FALLBACK}; fi`,
    `if [ -f "/b/x.mjs" ]; then node "/b/x.mjs" ${subcommand} --hint-format ${ROOT_ARG} || ${FALLBACK}; elif command -v mem >/dev/null 2>&1; then mem ${subcommand} --hint-format ${ROOT_ARG} || ${FALLBACK}; fi`,
  ];
}

describe("hook wrapper shapes accept only a plain subcommand word", () => {
  it.each(['x"&echo>m&echo', "x;touch", "x$(id)", "x|y", "x`id`"])("a subcommand word running into %s is read as its plain lead word, never with the metacharacters", (subcommand) => {
    for (const command of wrappedIn(subcommand)) {
      const spec = parseHookCommandSpec(command);
      expect(spec?.subcommand, command).toBe("x");
      expect(spec?.flags.every((flag) => /^--[a-z-]+$/u.test(flag)), command).toBe(true);
    }
  });

  it.each(["X", "1x", "x_y", "_x", "-x"])("no shape recognises the subcommand %s", (subcommand) => {
    for (const command of wrappedIn(subcommand)) {
      expect(parseHookCommandSpec(command), command).toBeNull();
      expect(isLegacyHookShape(command), command).toBe(false);
    }
  });

  it("every shape still reads the subcommands mem has stamped", () => {
    for (const subcommand of ["recall", "scan-session", "reflect"]) {
      for (const command of wrappedIn(subcommand)) {
        expect(parseHookCommandSpec(command)?.subcommand, command).toBe(subcommand);
      }
    }
    for (const { command } of CLAUDE_HOOK_EVENTS) {
      expect(parseHookCommandSpec(command)?.subcommand).toBe("hook");
    }
  });
});

describe("a probe is never started for a subcommand that is not a plain token", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-inject-"));
    spawned.length = 0;
  });

  afterEach(() => {
    resetProbe();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  it("checkHookCapability refuses a subcommand carrying shell metacharacters and spawns nothing", () => {
    installProbe(CAPABLE_PROBE);
    writeProbeTarget(dir);
    const marker = join(dir, "marker.txt");
    const binPath = join(dir, isWindows ? "mem.cmd" : "mem");
    const result = checkHookCapability(binPath, { subcommand: `x"&echo>${slashed(marker)}&echo`, flags: ["--help"] }, BUDGET_MS);
    expect(result).toEqual({ capable: false, missing: [`x"&echo>${slashed(marker)}&echo`], refused: true });
    expect(probeCalls()).toEqual([]);
    expect(spawned).toHaveLength(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("checkHookCapability still probes an ordinary subcommand", () => {
    installProbe(CAPABLE_PROBE);
    writeProbeTarget(dir);
    const binPath = join(dir, isWindows ? "mem.cmd" : "mem");
    expect(checkHookCapability(binPath, { subcommand: "recall", flags: ["--hint-format"] }, BUDGET_MS)).toEqual({ capable: true, missing: [] });
    expect(probeCalls()).toEqual([{ bin: binPath, args: ["recall", "--help"], timeoutMs: BUDGET_MS }]);
  });

  for (const token of ['a"b', "a&b", "a|b", "a<b", "a>b", "a^b", "a%b", "a!b", "a\nb", "a\rb"]) {
    it.runIf(isWindows)(`spawnProbe refuses the argument ${JSON.stringify(token)} for a .cmd shim before any process starts`, () => {
      const result = spawnProbe(join(dir, "mem.cmd"), [token, "--help"], BUDGET_MS);
      expect(result.errorCode).toBe("EPROBEREFUSED");
      expect(result.status).toBeNull();
      expect(spawned).toHaveLength(0);
    });
  }

  for (const char of ['"', "&", "^", "%", "|", "<", ">", "!"]) {
    it.runIf(isWindows)(`spawnProbe refuses a .cmd path carrying ${JSON.stringify(char)} before any process starts`, () => {
      const result = spawnProbe(join(dir, `me${char}m`, "mem.cmd"), ["--help"], BUDGET_MS);
      expect(result.errorCode).toBe("EPROBEREFUSED");
      expect(result.status).toBeNull();
      expect(spawned).toHaveLength(0);
    });
  }

  it.runIf(isWindows)("spawnProbe does not let a quote in an argument run a command through cmd.exe", () => {
    writeFileSync(join(dir, "mem.cmd"), INSTANT_SHIM, "utf8");
    const marker = join(dir, "marker.txt");
    const result = spawnProbe(join(dir, "mem.cmd"), [`x"&echo>${slashed(marker)}&echo`, "--help"], BUDGET_MS);
    expect(result.errorCode).toBe("EPROBEREFUSED");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("a project hook's bundle is probed with the running node", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mem-bundle-probe-"));
    spawned.length = 0;
    installProbe(CAPABLE_PROBE);
  });

  afterEach(() => {
    resetProbe();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  it("launches process.execPath on the bundle, never a bare `node`", () => {
    const bundle = join(dir, "bundle.mjs");
    writeFileSync(bundle, 'process.stdout.write("session-start\\n");\n', "utf8");
    const command = `if [ -f "${slashed(bundle)}" ]; then node "${slashed(bundle)}" hook session-start || ${FALLBACK}; elif command -v mem >/dev/null 2>&1; then mem hook session-start || ${FALLBACK}; fi`;
    const health = checkClaudeHookHealth([{ event: "SessionStart", command }], { pathEnv: dir, platform: isWindows ? "win32" : "linux", timeoutMs: BUDGET_MS, trustBundles: true });
    expect(health.hooks[0]?.capable).toBe(true);
    const launchers = probeCalls().map((call) => call.bin);
    expect(launchers.length).toBeGreaterThan(0);
    expect(launchers.every((launcher) => launcher === process.execPath)).toBe(true);
    expect(probeCalls().every((call) => call.args[0] === slashed(bundle))).toBe(true);
  });

  it("never runs a bundle unless the caller vouches for the commands", () => {
    const marker = join(dir, "marker.txt");
    const bundle = join(dir, "evil.mjs");
    writeMarkerBundle(bundle, marker);
    const health = checkClaudeHookHealth([{ event: "SessionStart", command: bundleHookCommand(bundle) }], { pathEnv: dir, platform: isWindows ? "win32" : "linux", timeoutMs: BUDGET_MS });
    expect(health.hooks[0]?.capable).toBe(false);
    expect(probeCalls()).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("mem doctor with a hostile hook in a cloned project's settings.json", () => {
  let memHome: string;
  let toolRoot: string;
  let toolHome: string;
  let binDir: string;
  const originalPath = process.env["PATH"];

  beforeEach(() => {
    memHome = mkdtempSync(join(tmpdir(), "mem-inject-mem-"));
    toolRoot = mkdtempSync(join(tmpdir(), "mem-inject-root-"));
    toolHome = mkdtempSync(join(tmpdir(), "mem-inject-home-"));
    binDir = mkdtempSync(join(tmpdir(), "mem-inject-bin-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = memHome;
    process.env["TOKEN_GOAT_MEM_BACKUP_DIR"] = join(memHome, "backups");
    vi.stubEnv("TOKEN_GOAT_MEM_WIRING_HOME", toolHome);
    installProbe(CAPABLE_PROBE);
    process.env["PATH"] = `${binDir}${delimiter}${dirname(process.execPath)}`;
  });

  afterEach(() => {
    resetProbe();
    process.env["PATH"] = originalPath;
    delete process.env["TOKEN_GOAT_MEM_HOME"];
    delete process.env["TOKEN_GOAT_MEM_BACKUP_DIR"];
    vi.unstubAllEnvs();
    for (const path of [memHome, toolRoot, toolHome, binDir]) {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  });

  it("runs nothing the hook names", async () => {
    writeProbeTarget(binDir);
    const marker = join(toolRoot, "marker.txt");
    const hostile = `mem x"&echo>${slashed(marker)}&echo ${ROOT_ARG}`;
    mkdirSync(join(toolRoot, ".claude"), { recursive: true });
    writeFileSync(join(toolRoot, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", __token_goat_mem: true, command: hostile }] }] } }), "utf8");
    const result = await runCli(["doctor", "--json", "--root", toolRoot]);
    expect(existsSync(marker)).toBe(false);
    const report = JSON.parse(result.stdout) as { findings: Array<{ check: string; status: string; message: string }> };
    const hooks = report.findings.filter((entry) => entry.check === "hooks");
    expect(hooks.some((entry) => entry.message.includes("SessionStart"))).toBe(true);
    expect(hooks.every((entry) => !entry.message.includes("&echo"))).toBe(true);
    expect(probeCalls().some((call) => call.bin.includes("&echo") || call.args.some((arg) => arg.includes("&echo")))).toBe(false);
  });

  it("never executes a bundle file named by the project settings.json", async () => {
    writeProbeTarget(binDir);
    const marker = join(toolRoot, "marker2.txt");
    const bundle = join(toolRoot, "evil.mjs");
    writeMarkerBundle(bundle, marker);
    mkdirSync(join(toolRoot, ".claude"), { recursive: true });
    writeFileSync(join(toolRoot, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", __token_goat_mem: true, command: bundleHookCommand(bundle) }] }] } }), "utf8");
    await runCli(["doctor", "--json", "--root", toolRoot]);
    expect(existsSync(marker)).toBe(false);
    expect(probeCalls().some((call) => call.bin.includes("evil.mjs") || call.args.some((arg) => arg.includes("evil.mjs")))).toBe(false);
  });

  it("still health-checks the bundle a user-level settings.json names", async () => {
    writeProbeTarget(binDir);
    const bundle = join(toolRoot, "user-bundle.mjs");
    writeFileSync(bundle, "", "utf8");
    mkdirSync(join(toolHome, ".claude"), { recursive: true });
    writeFileSync(join(toolHome, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", __token_goat_mem: true, command: bundleHookCommand(bundle) }] }] } }), "utf8");
    await runCli(["doctor", "--json", "--root", toolRoot]);
    const bundleProbes = probeCalls().filter((call) => call.args.includes(slashed(bundle)));
    expect(bundleProbes.length).toBeGreaterThan(0);
    expect(bundleProbes.every((call) => call.bin === process.execPath)).toBe(true);
  });
});
