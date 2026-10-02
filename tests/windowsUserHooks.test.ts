/** Tests for the Windows `--user` Claude Code hook shape: a direct `node <bundle>` launch that skips npm's shell shim, falling back to the plain `command -v mem` guard, plus how doctor compares and times those hooks. Platform and bundle path are injected so every branch runs on any OS. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describeHookDivergence, describeLaunchTime, LAUNCH_TIME_WARN_MS } from "../src/doctorWiring.js";
import { checkClaudeHookHealth, claudeCode, claudeHookEventsFor, CLAUDE_HOOK_EVENTS, installedClaudeHookCommands, parseHookCommandSpec } from "../src/wiring.js";

let root: string;
let home: string;
const BUNDLE = "C:/Users/someone/AppData/Roaming/npm/node_modules/token-goat-mem/dist/token-goat-mem.mjs";
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "PreCompact"];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-winhooks-root-"));
  home = mkdtempSync(join(tmpdir(), "mem-winhooks-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function settingsOf(base: string): { hooks: Record<string, Array<{ hooks: Array<{ command: string; __token_goat_mem?: boolean }> }>> } {
  return JSON.parse(readFileSync(join(base, ".claude", "settings.json"), "utf8"));
}

function commandsOf(base: string): string[] {
  const settings = settingsOf(base);
  return EVENTS.map((event) => settings.hooks[event]?.[0]?.hooks[0]?.command as string);
}

describe("claudeHookEventsFor", () => {
  it("writes node-then-mem for a win32 user install, with the same fallback as the plain shape", () => {
    const events = claudeHookEventsFor({ user: true, platform: "win32", bundlePath: BUNDLE });
    const start = events.find((entry) => entry.event === "SessionStart")?.command;
    expect(start).toBe(
      `if [ -f "${BUNDLE}" ]; then node "${BUNDLE}" recall --hint-format --hook-stdin --root "$CLAUDE_PROJECT_DIR" || printf 'TGMEM/2\\nfooter  mem recall failed (exit %s); run mem doctor\\n' "$?"; ` +
        `elif command -v mem >/dev/null 2>&1; then mem recall --hint-format --hook-stdin --root "$CLAUDE_PROJECT_DIR" || printf 'TGMEM/2\\nfooter  mem recall failed (exit %s); run mem doctor\\n' "$?"; fi`
    );
    const stop = events.find((entry) => entry.event === "Stop")?.command as string;
    expect(stop).toContain(`node "${BUNDLE}" reflect --hook-stdin --root "$CLAUDE_PROJECT_DIR" || echo "mem reflect failed (exit $?); run mem doctor"; elif command -v mem`);
  });

  it("keeps today's exact commands for project installs and for non-Windows platforms", () => {
    expect(claudeHookEventsFor({ user: false, platform: "win32", bundlePath: BUNDLE })).toEqual(CLAUDE_HOOK_EVENTS);
    expect(claudeHookEventsFor({ user: true, platform: "linux", bundlePath: BUNDLE })).toEqual(CLAUDE_HOOK_EVENTS);
    expect(claudeHookEventsFor({ user: true, platform: "darwin", bundlePath: BUNDLE })).toEqual(CLAUDE_HOOK_EVENTS);
  });

  it("normalises backslashes in the bundle path to forward slashes", () => {
    const events = claudeHookEventsFor({ user: true, platform: "win32", bundlePath: "C:\\Users\\someone\\dist\\token-goat-mem.mjs" });
    expect(events[0]?.command).toContain('node "C:/Users/someone/dist/token-goat-mem.mjs" recall');
  });

  it.each(['C:/odd"dir/token-goat-mem.mjs', "C:/odd$dir/token-goat-mem.mjs", "C:/odd`dir/token-goat-mem.mjs"])(
    "refuses the direct form for an unsafe bundle path (%s) and falls back to the plain shape",
    (bundlePath) => {
      expect(claudeHookEventsFor({ user: true, platform: "win32", bundlePath })).toEqual(CLAUDE_HOOK_EVENTS);
    }
  );
});

describe("claudeCode user install with the direct launcher", () => {
  const opts = (): { root: string; homeDir: string; user: true; platform: NodeJS.Platform; bundlePath: string } => ({
    root,
    homeDir: home,
    user: true,
    platform: "win32",
    bundlePath: BUNDLE,
  });

  it("writes the direct-node command into the user settings and never into project settings", () => {
    claudeCode.install(opts());
    for (const command of commandsOf(home)) {
      expect(command).toContain(`node "${BUNDLE}"`);
    }
    claudeCode.install({ root, homeDir: home });
    for (const command of commandsOf(root)) {
      expect(command).not.toContain("node ");
      expect(command).not.toContain(BUNDLE);
    }
  });

  it("recognises the new shape: subcommand and flags parse, and an unchanged re-run is a noop", () => {
    claudeCode.install(opts());
    const [start, , stop] = commandsOf(home) as [string, string, string];
    expect(parseHookCommandSpec(start)).toEqual({ subcommand: "recall", flags: ["--hint-format", "--hook-stdin"] });
    expect(parseHookCommandSpec(stop)).toEqual({ subcommand: "reflect", flags: ["--hook-stdin"] });
    const again = claudeCode.install(opts());
    expect(again.changes.map((change) => change.action)).toEqual(["noop"]);
  });

  it("upgrades an old-shape stamped hook in place with no duplicate, and uninstall removes the new shape", () => {
    claudeCode.install({ root, homeDir: home, user: true, platform: "linux" });
    expect(commandsOf(home)[0]).toMatch(/^if command -v mem/u);
    claudeCode.install(opts());
    const upgraded = settingsOf(home);
    for (const event of EVENTS) {
      expect(upgraded.hooks[event]).toHaveLength(1);
      expect(upgraded.hooks[event]?.[0]?.hooks).toHaveLength(1);
      expect(upgraded.hooks[event]?.[0]?.hooks[0]?.command).toContain(`node "${BUNDLE}"`);
    }
    claudeCode.uninstall(opts());
    // The file held only mem's hooks, so removing them leaves no settings file at all.
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });

  it("adopts an unstamped new-shape hook as mem's own rather than adding a second one", () => {
    const direct = claudeHookEventsFor({ user: true, platform: "win32", bundlePath: BUNDLE });
    const hooks: Record<string, unknown> = {};
    for (const { event, command } of direct) {
      hooks[event] = [{ hooks: [{ type: "command", command }] }];
    }
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks }, null, 2), "utf8");
    claudeCode.install({ root, homeDir: home, user: true, platform: "linux" });
    const settings = settingsOf(home);
    for (const event of EVENTS) {
      expect(settings.hooks[event]).toHaveLength(1);
      expect(settings.hooks[event]?.[0]?.hooks[0]?.__token_goat_mem).toBe(true);
    }
  });
});

describe("capability pre-flight with the bundle as launcher", () => {
  it("checks the bundle itself when the hook's bundle exists, even with no mem on PATH", () => {
    const bundle = join(home, "dist", "token-goat-mem.mjs").replace(/\\/gu, "/");
    mkdirSync(dirname(bundle), { recursive: true });
    writeFileSync(bundle, 'console.log(process.argv.slice(2).join(" ") + " --hook-stdin --hint-format --quiet --delta");\n', "utf8");
    const commands = claudeHookEventsFor({ user: true, platform: "win32", bundlePath: bundle });
    const health = checkClaudeHookHealth(commands, { pathEnv: join(home, "empty") });
    expect(health.bin).toBeNull();
    expect(health.hooks.every((hook) => hook.capable)).toBe(true);
  });
});

describe("describeHookDivergence across launchers", () => {
  it("warns that project and user hooks differing only by launcher each run twice, and names dropping the project hooks", () => {
    claudeCode.install({ root, homeDir: home });
    claudeCode.install({ root, homeDir: home, user: true, platform: "win32", bundlePath: BUNDLE });
    expect(installedClaudeHookCommands({ root, homeDir: home, user: true })[0]?.command).toContain("node ");
    const findings = describeHookDivergence({ root, homeDir: home });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("warn");
    expect(findings[0]?.message).toContain("runs twice");
    for (const event of EVENTS) {
      expect(findings[0]?.message).toContain(event);
    }
    expect(findings[0]?.remedy).toContain(`mem uninstall claude-code --root ${root}`);
    expect(findings[0]?.remedy).not.toContain("--user");
  });

  it("stays ok when both levels hold the identical command, which Claude Code runs once", () => {
    claudeCode.install({ root, homeDir: home, platform: "win32", bundlePath: BUNDLE });
    claudeCode.install({ root, homeDir: home, user: true, platform: "linux", bundlePath: BUNDLE });
    expect(commandsOf(root)).toEqual(commandsOf(home));
    const findings = describeHookDivergence({ root, homeDir: home });
    expect(findings).toEqual([expect.objectContaining({ status: "ok" })]);
  });

  it("still flags hooks whose flags differ", () => {
    claudeCode.install({ root, homeDir: home });
    claudeCode.install({ root, homeDir: home, user: true, platform: "win32", bundlePath: BUNDLE });
    const path = join(root, ".claude", "settings.json");
    writeFileSync(path, readFileSync(path, "utf8").replace("--hook-stdin --delta", "--hook-stdin"), "utf8");
    const findings = describeHookDivergence({ root, homeDir: home });
    expect(findings[0]?.status).toBe("warn");
    expect(findings[0]?.message).toContain("UserPromptSubmit");
  });
});

describe("describeLaunchTime", () => {
  const slow = (): number => LAUNCH_TIME_WARN_MS + 1;

  function existingBundle(): string {
    const bundle = join(home, "dist", "token-goat-mem.mjs").replace(/\\/gu, "/");
    mkdirSync(dirname(bundle), { recursive: true });
    writeFileSync(bundle, "", "utf8");
    return bundle;
  }

  function measuredWith(platform: NodeJS.Platform): { findings: ReturnType<typeof describeLaunchTime>; measured: boolean } {
    let measured = false;
    const findings = describeLaunchTime({ root, homeDir: home }, () => {
      measured = true;
      return slow();
    }, platform);
    return { findings, measured };
  }

  it("warns above the threshold, suggesting the direct-node hook on Windows", () => {
    claudeCode.install({ root, homeDir: home });
    const findings = describeLaunchTime({ root, homeDir: home }, slow, "win32");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.check).toBe("launch-time");
    expect(findings[0]?.status).toBe("warn");
    expect(findings[0]?.remedy).toContain("mem init claude-code --user");
  });

  it("does not suggest the Windows-only remedy elsewhere", () => {
    claudeCode.install({ root, homeDir: home });
    const findings = describeLaunchTime({ root, homeDir: home }, slow, "linux");
    expect(findings[0]?.status).toBe("warn");
    expect(findings[0]?.remedy ?? "").not.toContain("mem init claude-code --user");
  });

  it("is silent at or below the threshold", () => {
    claudeCode.install({ root, homeDir: home });
    expect(describeLaunchTime({ root, homeDir: home }, () => LAUNCH_TIME_WARN_MS, "win32")).toEqual([]);
    expect(describeLaunchTime({ root, homeDir: home }, () => 10, "win32")).toEqual([]);
  });

  it("skips, never throws, when the launch cannot be measured", () => {
    claudeCode.install({ root, homeDir: home });
    expect(describeLaunchTime({ root, homeDir: home }, () => null, "win32")).toEqual([]);
    expect(describeLaunchTime({ root, homeDir: home }, () => {
      throw new Error("spawn failed");
    }, "win32")).toEqual([]);
  });

  it("measures nothing when no hooks are installed", () => {
    expect(measuredWith("win32")).toEqual({ findings: [], measured: false });
  });

  it("measures nothing when every hook launches an existing bundle directly", () => {
    claudeCode.install({ root, homeDir: home, user: true, platform: "win32", bundlePath: existingBundle() });
    expect(measuredWith("win32")).toEqual({ findings: [], measured: false });
  });

  it("still measures when a direct hook's bundle is gone, since that hook falls back to mem on PATH", () => {
    claudeCode.install({ root, homeDir: home, user: true, platform: "win32", bundlePath: BUNDLE });
    expect(measuredWith("win32").findings[0]?.status).toBe("warn");
  });

  it("still measures when a plain project hook sits beside direct user hooks", () => {
    claudeCode.install({ root, homeDir: home });
    claudeCode.install({ root, homeDir: home, user: true, platform: "win32", bundlePath: existingBundle() });
    expect(measuredWith("win32").findings[0]?.status).toBe("warn");
  });
});
