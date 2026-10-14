/** Tests for which Claude Code hooks a project `mem init` keeps beside user-level hooks: per event, not all or nothing. Everything goes through the real wiring code against temp roots and homes. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describeHookDivergence } from "../src/doctorWiring.js";
import { claudeCode, installedClaudeHookCommands } from "../src/wiring.js";

let root: string;
let home: string;
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "PreCompact"];

type Settings = { hooks?: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout?: number; __token_goat_mem?: boolean }> }>> } & Record<string, unknown>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-hookcov-root-"));
  home = mkdtempSync(join(tmpdir(), "mem-hookcov-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const projectSettingsPath = (): string => join(root, ".claude", "settings.json");
const userSettingsPath = (): string => join(home, ".claude", "settings.json");
const readSettings = (path: string): Settings => JSON.parse(readFileSync(path, "utf8")) as Settings;
const hookEventsIn = (path: string): string[] => EVENTS.filter((event) => (readSettings(path).hooks?.[event]?.length ?? 0) > 0);

/** Rewrites the user settings so only `kept` events still hold mem's hook, as a hand trim would. */
function trimUserHooksTo(kept: readonly string[]): void {
  const settings = readSettings(userSettingsPath());
  for (const event of EVENTS) {
    if (!kept.includes(event)) {
      delete settings.hooks?.[event];
    }
  }
  writeFileSync(userSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

describe("a project install beside user hooks that cover only some events", () => {
  it("keeps the project hook for every event the user settings do not cover, and drops only the covered one", () => {
    claudeCode.install({ root, homeDir: home });
    claudeCode.install({ root, homeDir: home, user: true });
    trimUserHooksTo(["Stop"]);
    const userBefore = readFileSync(userSettingsPath(), "utf8");

    const result = claudeCode.install({ root, homeDir: home });

    expect(result.changes.find((change) => change.path === projectSettingsPath())?.action).toBe("update");
    expect(existsSync(projectSettingsPath())).toBe(true);
    expect(hookEventsIn(projectSettingsPath())).toEqual(["SessionStart", "UserPromptSubmit", "PreCompact"]);
    expect(hookEventsIn(userSettingsPath())).toEqual(["Stop"]);
    expect(readFileSync(userSettingsPath(), "utf8")).toBe(userBefore);
    const everyEvent = [...installedClaudeHookCommands({ root, homeDir: home }), ...installedClaudeHookCommands({ root, homeDir: home, user: true })].map((hook) => hook.event);
    expect(EVENTS.every((event) => everyEvent.includes(event))).toBe(true);
  });

  it("is idempotent once it has settled", () => {
    claudeCode.install({ root, homeDir: home });
    claudeCode.install({ root, homeDir: home, user: true });
    trimUserHooksTo(["Stop"]);
    claudeCode.install({ root, homeDir: home });
    const settled = readFileSync(projectSettingsPath(), "utf8");
    const again = claudeCode.install({ root, homeDir: home });
    expect(again.changes.find((change) => change.path === projectSettingsPath())?.action).toBe("noop");
    expect(readFileSync(projectSettingsPath(), "utf8")).toBe(settled);
  });

  it("writes only the uncovered events into a project that had no settings file", () => {
    claudeCode.install({ root, homeDir: home, user: true });
    trimUserHooksTo(["Stop", "PreCompact"]);
    claudeCode.install({ root, homeDir: home });
    expect(hookEventsIn(projectSettingsPath())).toEqual(["SessionStart", "UserPromptSubmit"]);
  });

  it("keeps a project's own settings and hooks while dropping the covered event", () => {
    mkdirSync(dirname(projectSettingsPath()), { recursive: true });
    writeFileSync(projectSettingsPath(), '{\n  "model": "opus"\n}\n', "utf8");
    claudeCode.install({ root, homeDir: home });
    claudeCode.install({ root, homeDir: home, user: true });
    trimUserHooksTo(["Stop"]);
    claudeCode.install({ root, homeDir: home });
    expect(readSettings(projectSettingsPath())["model"]).toBe("opus");
    expect(hookEventsIn(projectSettingsPath())).toEqual(["SessionStart", "UserPromptSubmit", "PreCompact"]);
  });

  it("does not report the settled split as a divergence", () => {
    claudeCode.install({ root, homeDir: home });
    claudeCode.install({ root, homeDir: home, user: true });
    trimUserHooksTo(["Stop"]);
    claudeCode.install({ root, homeDir: home });
    expect(describeHookDivergence({ root, homeDir: home })).toEqual([]);
  });

  it("still drops every project hook, and deletes a file that held only them, when the user settings cover every event", () => {
    claudeCode.install({ root, homeDir: home });
    claudeCode.install({ root, homeDir: home, user: true });
    const result = claudeCode.install({ root, homeDir: home });
    expect(result.changes.find((change) => change.path === projectSettingsPath())?.action).toBe("delete");
    expect(existsSync(projectSettingsPath())).toBe(false);
  });
});
