/** `mem hook <event>`: the frozen-slug entry point installed hooks call, its recognition and migration in `wiring.ts`, and the doctor warning for the older flag-carrying shape. Covers the ADR's test matrix (1-8) and its two fitness functions, with the real DB and the built bundle for the end-to-end case. */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUNDLE_PATH, runBundleSync } from "./support/bundle.js";
import { runCli } from "./support/cli.js";
import { OLD_MEM_SHIM, writeFakeMem } from "./support/fakeMem.js";
import { CAPABLE_PROBE, installProbe, memProbe, OLD_PROBE, probeCalls, resetProbe, writeProbeTarget } from "./support/fakeProbe.js";
import { deriveHookRoot, MEM_HOOK_IMPLIED_ARGS, registerHookCommand } from "../src/hookCommand.js";
import { describeHookDivergence } from "../src/doctorWiring.js";
import {
  checkClaudeHookHealth,
  claudeCode,
  claudeHookEventsFor,
  CLAUDE_HOOK_EVENTS,
  installClaudeSettings,
  installedClaudeHookCommands,
  isLegacyHookShape,
  MEM_HOOK_EVENT_SLUGS,
  MEM_HOOK_INVOCATION_SHAPES,
  parseHookCommandSpec,
} from "../src/wiring.js";
import { SPAWN_TIMEOUT_FLOOR_MS } from "./support/spawnTimeoutFloorMs.js";

// Process launches on this machine take 1-10 s, past the capability probe budget (MEM_PROBE_TIMEOUT_MS in wiring.ts); the floor keeps capability tests from timing out on launch latency.
vi.mock("node:child_process", async (importOriginal) => (await import("./support/spawnTimeoutFloor.js")).withSpawnTimeoutFloor(await importOriginal<typeof import("node:child_process")>()));
// Matrix 8 scripts what a probe of the `mem` binary returns with `installProbe`; the other cases install nothing and reach the real `spawnProbe`.
vi.mock("../src/probeSpawn.js", async (importOriginal) => (await import("./support/fakeProbe.js")).withFakeProbe(await importOriginal<typeof import("../src/probeSpawn.js")>()));

const RECALL_FALLBACK = `printf 'TGMEM/2\\nfooter  mem recall failed (exit %s); run mem doctor\\n' "$?"`;
/** The flag-carrying strings an earlier mem stamped, per event. */
const LEGACY: Readonly<Record<string, string>> = {
  SessionStart: `if command -v mem >/dev/null 2>&1; then mem recall --hint-format --hook-stdin --root "$CLAUDE_PROJECT_DIR" || ${RECALL_FALLBACK}; fi`,
  UserPromptSubmit: `if command -v mem >/dev/null 2>&1; then mem recall --hint-format --hook-stdin --delta --root "$CLAUDE_PROJECT_DIR" || ${RECALL_FALLBACK}; fi`,
  Stop: `if command -v mem >/dev/null 2>&1; then mem reflect --hook-stdin --root "$CLAUDE_PROJECT_DIR" || echo "mem reflect failed (exit $?); run mem doctor"; fi`,
  PreCompact: `if command -v mem >/dev/null 2>&1; then mem scan-session --hook-stdin --quiet --root "$CLAUDE_PROJECT_DIR" || echo "mem scan-session failed (exit $?); run mem doctor"; fi`,
};
const EVENTS = Object.keys(LEGACY);

let root: string;
let home: string;
let binDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-hook-root-"));
  home = mkdtempSync(join(tmpdir(), "mem-hook-home-"));
  binDir = mkdtempSync(join(tmpdir(), "mem-hook-bin-"));
  vi.stubEnv("TOKEN_GOAT_MEM_WIRING_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of [root, home, binDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const projectSettingsPath = (): string => join(root, ".claude", "settings.json");

function writeSettings(path: string, commands: Readonly<Record<string, string>>, stamped: boolean): void {
  const hooks: Record<string, unknown> = {};
  for (const [event, command] of Object.entries(commands)) {
    hooks[event] = [{ hooks: [{ type: "command", command, ...(stamped ? { __token_goat_mem: true } : {}) }] }];
  }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ hooks }, null, 2), "utf8");
}

function commandsIn(path: string): Record<string, string[]> {
  const settings = JSON.parse(readFileSync(path, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  return Object.fromEntries(Object.entries(settings.hooks).map(([event, groups]) => [event, groups.flatMap((group) => group.hooks.map((hook) => hook.command))]));
}

const currentCommands = (): Record<string, string> => Object.fromEntries(CLAUDE_HOOK_EVENTS.map((entry) => [entry.event, entry.command]));

describe("fitness: the frozen slug list", () => {
  it("1. every command built for CLAUDE_HOOK_EVENTS matches exactly one invocation shape and carries no flag", () => {
    const direct = claudeHookEventsFor({ user: true, platform: "win32", bundlePath: "C:/b/token-goat-mem.mjs" });
    for (const entry of [...CLAUDE_HOOK_EVENTS, ...direct]) {
      expect(MEM_HOOK_INVOCATION_SHAPES.filter((shape) => shape.test(entry.command))).toHaveLength(1);
      expect(entry.command).not.toContain("--");
    }
  });

  it("2. the frozen slug set is pinned to a literal, and each slug maps to a host event and implied arguments", () => {
    expect(Object.keys(MEM_HOOK_EVENT_SLUGS).sort()).toEqual(["pre-compact", "session-start", "stop", "user-prompt-submit"]);
    expect(Object.values(MEM_HOOK_EVENT_SLUGS).sort()).toEqual([...EVENTS].sort());
    expect(Object.keys(MEM_HOOK_IMPLIED_ARGS).sort()).toEqual(Object.keys(MEM_HOOK_EVENT_SLUGS).sort());
  });
});

describe("matrix 1: the new string on an old binary", () => {
  const bash = spawnSync("bash", ["-c", "true"]).status === 0;

  it.skipIf(!bash)("exits 1 bare and prints the fallback, which the host surfaces instead of silence (plain and Windows forms)", () => {
    writeFakeMem(binDir, OLD_MEM_SHIM);
    const missingBundle = "/nonexistent/token-goat-mem.mjs";
    const commands = [CLAUDE_HOOK_EVENTS[2]?.command, claudeHookEventsFor({ user: true, platform: "win32", bundlePath: missingBundle })[2]?.command] as string[];
    for (const command of commands) {
      const result = spawnSync("bash", ["-c", command], { encoding: "utf8", env: { ...process.env, PATH: `${binDir}${delimiter}${process.env["PATH"] ?? ""}` } });
      expect(result.stdout).toContain("mem reflect failed (exit 1); run mem doctor");
    }
    const bare = spawnSync("bash", ["-c", "mem hook stop"], { encoding: "utf8", env: { ...process.env, PATH: `${binDir}${delimiter}${process.env["PATH"] ?? ""}` } });
    expect(bare.status).toBe(1);
  });
});

describe("matrix 2: old strings are recognised and migrated", () => {
  it("rewrites a stamped legacy file in place for all four events, then is idempotent", () => {
    writeSettings(projectSettingsPath(), LEGACY, true);
    claudeCode.install({ root, homeDir: home });
    expect(commandsIn(projectSettingsPath())).toEqual(Object.fromEntries(EVENTS.map((event) => [event, [currentCommands()[event]]])));
    const once = readFileSync(projectSettingsPath(), "utf8");
    const again = claudeCode.install({ root, homeDir: home });
    expect(again.changes.map((change) => change.action)).not.toContain("update");
    expect(readFileSync(projectSettingsPath(), "utf8")).toBe(once);
  });

  it("adopts unstamped legacy hooks as mem's own instead of adding a second entry", () => {
    writeSettings(projectSettingsPath(), LEGACY, false);
    claudeCode.install({ root, homeDir: home });
    for (const commands of Object.values(commandsIn(projectSettingsPath()))) {
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatch(/mem hook [a-z-]+ \|\|/u);
    }
    expect(installedClaudeHookCommands({ root, homeDir: home }).every((hook) => hook.stamped)).toBe(true);
  });

  it("recognises every legacy string and the retired scan-session Stop hook", () => {
    for (const command of Object.values(LEGACY)) {
      expect(isLegacyHookShape(command)).toBe(true);
    }
    const legacyStop = LEGACY["Stop"]?.replace("mem reflect --hook-stdin", "mem scan-session --hook-stdin --quiet") as string;
    writeSettings(projectSettingsPath(), { ...LEGACY, Stop: legacyStop }, false);
    claudeCode.install({ root, homeDir: home });
    expect(commandsIn(projectSettingsPath())["Stop"]).toEqual([currentCommands()["Stop"]]);
  });
});

describe("matrix 3: uninstall by stamp", () => {
  it("removes stamped legacy and stamped new entries together and leaves unstamped and user entries", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: LEGACY["SessionStart"], __token_goat_mem: true }] }, { hooks: [{ type: "command", command: "echo mine" }] }],
        Stop: [{ hooks: [{ type: "command", command: currentCommands()["Stop"], __token_goat_mem: true }] }],
        PreCompact: [{ hooks: [{ type: "command", command: "node my-own-hook.js" }] }],
        // A user's own entry running mem's current invocation shape with no stamp: uninstall removes by stamp only, never by command shape.
        UserPromptSubmit: [{ hooks: [{ type: "command", command: currentCommands()["UserPromptSubmit"] }] }],
      },
    };
    writeFileSync(projectSettingsPath(), JSON.stringify(settings, null, 2), "utf8");
    claudeCode.uninstall({ root, homeDir: home });
    expect(commandsIn(projectSettingsPath())).toEqual({ SessionStart: ["echo mine"], PreCompact: ["node my-own-hook.js"], UserPromptSubmit: [currentCommands()["UserPromptSubmit"]] });
  });
});

describe("matrix 4: hybrids are not recognised", () => {
  it("rejects a Windows form whose elif slug differs from its first slug", () => {
    const direct = claudeHookEventsFor({ user: true, platform: "win32", bundlePath: "C:/b/token-goat-mem.mjs" })[2]?.command as string;
    expect(parseHookCommandSpec(direct)).toEqual({ subcommand: "hook", flags: ["stop"] });
    const hybrid = direct.replace("then mem hook stop", "then mem hook pre-compact");
    expect(hybrid).not.toBe(direct);
    expect(parseHookCommandSpec(hybrid)).toBeNull();
  });

  it("does not adopt a slug that belongs to another event, so the entry is left beside the new hook", () => {
    writeSettings(projectSettingsPath(), { PreCompact: currentCommands()["Stop"] as string }, false);
    claudeCode.install({ root, homeDir: home });
    expect(commandsIn(projectSettingsPath())["PreCompact"]).toHaveLength(2);
  });
});

describe("matrix 5: the committed file and the no-downgrade guard", () => {
  it("writes no machine path and no --root into the project file", () => {
    claudeCode.install({ root, homeDir: home });
    const text = readFileSync(projectSettingsPath(), "utf8");
    expect(text).not.toContain("--root");
    expect(text).not.toContain(root);
    expect(text).not.toContain("CLAUDE_PROJECT_DIR");
  });

  it("keeps a legacy file byte-stable until mem init runs (nothing but install writes settings)", async () => {
    writeSettings(projectSettingsPath(), LEGACY, true);
    const before = readFileSync(projectSettingsPath(), "utf8");
    await runCli(["doctor"]);
    await runCli(["recall", "--root", root]);
    expect(readFileSync(projectSettingsPath(), "utf8")).toBe(before);
  });

  it("never rewrites a current stamped hook back to a legacy shape", () => {
    claudeCode.install({ root, homeDir: home });
    const current = readFileSync(projectSettingsPath(), "utf8");
    const legacyEvents = EVENTS.map((event) => ({ event, command: LEGACY[event] as string }));
    expect(installClaudeSettings(current, projectSettingsPath(), legacyEvents)).toBe(current);
  });
});

describe("matrix 6: root derivation", () => {
  it("prefers CLAUDE_PROJECT_DIR, then the envelope cwd, then the process cwd", () => {
    expect(deriveHookRoot({ CLAUDE_PROJECT_DIR: "/env" }, "/envelope", "/proc")).toBe("/env");
    expect(deriveHookRoot({}, "/envelope", "/proc")).toBe("/envelope");
    expect(deriveHookRoot({ CLAUDE_PROJECT_DIR: "  " }, undefined, "/proc")).toBe("/proc");
  });
});

describe("matrix 7: strict input", () => {
  function hookProgram(retired?: ReadonlySet<string>): { program: Command; dispatch: ReturnType<typeof vi.fn> } {
    const dispatch = vi.fn(async () => undefined);
    const program = new Command().exitOverride();
    registerHookCommand(program, { dispatch, ...(retired === undefined ? {} : { retired }) });
    return { program, dispatch };
  }

  it("exits 1 for an unknown slug and for extra argv, and dispatches nothing", async () => {
    const unknown = await runCli(["hook", "bogus"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('unknown hook event "bogus"');
    const extra = await runCli(["hook", "stop", "extra"]);
    expect(extra.exitCode).toBe(1);
  });

  it("exits 0 with empty stdout for a retired slug without dispatching", async () => {
    const { program, dispatch } = hookProgram(new Set(["old-event"]));
    process.exitCode = undefined;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await program.parseAsync(["hook", "old-event"], { from: "user" });
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
    expect(process.exitCode ?? 0).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches the slug's implied arguments with the env root", async () => {
    const { program, dispatch } = hookProgram();
    vi.stubEnv("CLAUDE_PROJECT_DIR", root);
    try {
      await program.parseAsync(["hook", "user-prompt-submit"], { from: "user" });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(dispatch).toHaveBeenCalledWith(["recall", "--hint-format", "--hook-stdin", "--delta", "--root", root]);
  });

  it("--help lists every slug", async () => {
    const help = await runCli(["hook", "--help"]);
    expect(help.exitCode ?? 0).toBe(0);
    for (const slug of Object.keys(MEM_HOOK_EVENT_SLUGS)) {
      expect(help.stdout).toContain(slug);
    }
  });
});

describe("matrix 8: doctor and the capability probe", () => {
  beforeEach(() => {
    installProbe(CAPABLE_PROBE);
  });

  afterEach(() => {
    resetProbe();
  });

  it("fails the probe with `hook` missing on an old binary and passes on a new one", () => {
    const hooks = CLAUDE_HOOK_EVENTS.map(({ event, command }) => ({ event, command }));
    writeProbeTarget(binDir);
    installProbe(OLD_PROBE);
    const old = checkClaudeHookHealth(hooks, { pathEnv: binDir });
    expect(old.hooks.map((hook) => hook.missing)).toEqual(hooks.map(() => ["hook"]));
    // A real old build answers `hook --help` with its root help and exit 0, never naming a slug.
    installProbe(memProbe("0.5.2", () => "recall reflect scan-session --hint-format --root\n"));
    expect(checkClaudeHookHealth(hooks, { pathEnv: binDir }).hooks.map((hook) => hook.missing)).toEqual(hooks.map(() => ["hook"]));
    installProbe(CAPABLE_PROBE);
    expect(checkClaudeHookHealth(hooks, { pathEnv: binDir }).hooks.every((hook) => hook.capable)).toBe(true);
    expect(probeCalls().map((call) => call.args)).toEqual([["--version"], ["hook", "--help"]]);
  });

  it("warns about a legacy hook shape naming mem init claude-code, and not about the current one", async () => {
    writeSettings(projectSettingsPath(), LEGACY, true);
    const legacyFindings = async (): Promise<Array<{ status: string; message: string; remedy?: string }>> => {
      const result = await runCli(["doctor", "--json", "--root", root]);
      const report = JSON.parse(result.stdout) as { findings: Array<{ check: string; status: string; message: string; remedy?: string }> };
      return report.findings.filter((entry) => entry.check === "hooks" && entry.message.includes("legacy hook shape"));
    };
    const legacy = await legacyFindings();
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toEqual(expect.objectContaining({ status: "warn", remedy: expect.stringContaining("mem init claude-code") }));
    claudeCode.install({ root, homeDir: home });
    expect(await legacyFindings()).toEqual([]);
  });

  it("reports a project file in the legacy shape against a user file in the current shape as divergent", () => {
    writeSettings(projectSettingsPath(), LEGACY, true);
    claudeCode.install({ root, homeDir: home, user: true });
    const findings = describeHookDivergence({ root, homeDir: home });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("warn");
  });
});

describe("end to end through the built bundle", () => {
  it("surfaces a seeded fact for `mem hook session-start` with the envelope on stdin, and leaves settings.json untouched", async () => {
    const memHome = process.env["TOKEN_GOAT_MEM_HOME"] as string;
    const remembered = await runCli(["remember", "the zebra deploy token lives in vault", "--kind", "fact", "--scope", "project", "--root", root]);
    expect(remembered.exitCode ?? 0).toBe(0);
    claudeCode.install({ root, homeDir: home });
    const settingsBefore = readFileSync(projectSettingsPath(), "utf8");
    const envelope = JSON.stringify({ session_id: "s-hook-e2e", hook_event_name: "SessionStart", source: "startup", cwd: root });

    const viaEnv = runBundleSync(["hook", "session-start"], { home: memHome, stdin: envelope, env: { CLAUDE_PROJECT_DIR: root } });
    expect(viaEnv.exitCode).toBe(0);
    expect(viaEnv.stdout.startsWith("TGMEM/2\n")).toBe(true);
    expect(viaEnv.stdout).toContain("zebra deploy token");

    const viaEnvelope = runBundleSync(["hook", "session-start"], { home: memHome, stdin: envelope, env: { CLAUDE_PROJECT_DIR: "" } });
    expect(viaEnvelope.stdout).toBe(viaEnv.stdout);

    const direct = runBundleSync(["recall", "--hint-format", "--hook-stdin", "--root", root], { home: memHome, stdin: envelope });
    expect(viaEnv.stdout).toBe(direct.stdout);
    expect(readFileSync(projectSettingsPath(), "utf8")).toBe(settingsBefore);
    expect(BUNDLE_PATH).toContain("token-goat-mem.mjs");
  });

  const bashOnPath = spawnSync("bash", ["-c", "true"]).status === 0;

  // Claude Code runs a hook command through bash on Windows too, so the direct-bundle string a win32 user-level install writes must work as written.
  it.skipIf(!bashOnPath)("runs the win32 direct-bundle hook command through bash against the built bundle and emits TGMEM/2", { timeout: SPAWN_TIMEOUT_FLOOR_MS }, async () => {
    const memHome = process.env["TOKEN_GOAT_MEM_HOME"] as string;
    const remembered = await runCli(["remember", "the quokka deploy token lives in vault", "--kind", "fact", "--scope", "project", "--root", root]);
    expect(remembered.exitCode ?? 0).toBe(0);
    const command = claudeHookEventsFor({ user: true, platform: "win32", bundlePath: BUNDLE_PATH })[0]?.command as string;
    expect(command, "the direct-bundle form launches node on the bundle path").toContain(`node "${BUNDLE_PATH.replace(/\\/gu, "/")}" hook session-start`);
    const envelope = JSON.stringify({ session_id: "s-hook-direct", hook_event_name: "SessionStart", source: "startup", cwd: root });
    const result = spawnSync("bash", ["-c", command], { encoding: "utf8", input: envelope, env: { ...process.env, TOKEN_GOAT_MEM_HOME: memHome, CLAUDE_PROJECT_DIR: root } });
    expect(result.status, `bash exit; stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout.startsWith("TGMEM/2\n"), `stdout: ${result.stdout}`).toBe(true);
    expect(result.stdout, "the seeded fact surfaces through the direct-bundle branch").toContain("quokka deploy token");
  });
});
