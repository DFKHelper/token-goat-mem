/** Tests for how install and `mem doctor` treat duplicate stamped hooks under one Claude Code event: install keeps one current stamped hook and diagnosis reads the same entry. Everything goes through the real wiring code against temp roots and homes. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeCode, CLAUDE_HOOK_EVENTS, installedClaudeHookCommands } from "../src/wiring.js";

let root: string;
let home: string;

type Settings = { hooks?: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout?: number; __token_goat_mem?: boolean }> }>> } & Record<string, unknown>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-stamped-root-"));
  home = mkdtempSync(join(tmpdir(), "mem-stamped-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const projectSettingsPath = (): string => join(root, ".claude", "settings.json");
const readSettings = (path: string): Settings => JSON.parse(readFileSync(path, "utf8")) as Settings;

describe("duplicate stamped hooks under one event", () => {
  const duplicate = { type: "command", command: "mem ho$ok session-start", timeout: 45, __token_goat_mem: true };

  function seedDuplicate(): void {
    claudeCode.install({ root, homeDir: home });
    const settings = readSettings(projectSettingsPath());
    settings.hooks?.["SessionStart"]?.[0]?.hooks.push(duplicate);
    writeFileSync(projectSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  const sessionStartHooks = (): Array<{ command: string; __token_goat_mem?: boolean }> => (readSettings(projectSettingsPath()).hooks?.["SessionStart"] ?? []).flatMap((group) => group.hooks);

  it("diagnoses the same hook install keeps, so a doctor remedy that install cannot act on never appears", () => {
    seedDuplicate();
    const diagnosed = installedClaudeHookCommands({ root, homeDir: home }).find((hook) => hook.event === "SessionStart");
    const kept = sessionStartHooks()[0]?.command;
    expect(diagnosed?.command).toBe(kept);
  });

  it("collapses the duplicate to one current stamped hook, after which the capability check has nothing unsupported to report", () => {
    seedDuplicate();
    const result = claudeCode.install({ root, homeDir: home });
    expect(result.changes.find((change) => change.path === projectSettingsPath())?.action).toBe("update");
    expect(sessionStartHooks().filter((hook) => hook.__token_goat_mem === true)).toHaveLength(1);
    const diagnosed = installedClaudeHookCommands({ root, homeDir: home }).find((hook) => hook.event === "SessionStart");
    expect(diagnosed?.command).toBe(CLAUDE_HOOK_EVENTS.find((entry) => entry.event === "SessionStart")?.command);
    const settled = readFileSync(projectSettingsPath(), "utf8");
    expect(claudeCode.install({ root, homeDir: home }).changes.find((change) => change.path === projectSettingsPath())?.action).toBe("noop");
    expect(readFileSync(projectSettingsPath(), "utf8")).toBe(settled);
  });

  it("collapses a stale first entry onto the current command, keeping one", () => {
    seedDuplicate();
    const settings = readSettings(projectSettingsPath());
    const first = settings.hooks?.["SessionStart"]?.[0]?.hooks[0];
    if (first !== undefined) {
      first.command = "mem ho$ok session-start";
    }
    writeFileSync(projectSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    claudeCode.install({ root, homeDir: home });
    const stamped = sessionStartHooks().filter((hook) => hook.__token_goat_mem === true);
    expect(stamped).toHaveLength(1);
    expect(stamped[0]?.command).toContain("hook session-start");
    expect(stamped[0]?.command).not.toContain("ho$ok");
  });

  it("collapses a duplicate that sits in a separate group, dropping the group it empties", () => {
    seedDuplicate();
    const settings = readSettings(projectSettingsPath());
    const moved = settings.hooks?.["SessionStart"]?.[0]?.hooks.pop();
    if (moved !== undefined) {
      settings.hooks?.["SessionStart"]?.push({ hooks: [moved] });
    }
    writeFileSync(projectSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    claudeCode.install({ root, homeDir: home });
    expect(readSettings(projectSettingsPath()).hooks?.["SessionStart"]).toHaveLength(1);
    expect(sessionStartHooks().filter((hook) => hook.__token_goat_mem === true)).toHaveLength(1);
  });

  it("leaves unstamped and non-mem hooks under the event untouched", () => {
    seedDuplicate();
    const settings = readSettings(projectSettingsPath());
    settings.hooks?.["SessionStart"]?.push({ hooks: [{ type: "command", command: "echo mine" }] });
    settings.hooks?.["SessionStart"]?.[0]?.hooks.push({ type: "command", command: "echo also mine" });
    writeFileSync(projectSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    claudeCode.install({ root, homeDir: home });
    const commands = sessionStartHooks().map((hook) => hook.command);
    expect(commands).toContain("echo mine");
    expect(commands).toContain("echo also mine");
    expect(sessionStartHooks().filter((hook) => hook.__token_goat_mem === true)).toHaveLength(1);
  });

  it("removes every stamped hook on uninstall afterwards, leaving no mem hooks and no file", () => {
    seedDuplicate();
    claudeCode.install({ root, homeDir: home });
    claudeCode.uninstall({ root, homeDir: home });
    expect(existsSync(projectSettingsPath())).toBe(false);
  });

  it("uninstalls a file still holding the duplicate without leaving a stamped hook behind", () => {
    seedDuplicate();
    claudeCode.uninstall({ root, homeDir: home });
    expect(existsSync(projectSettingsPath()) ? installedClaudeHookCommands({ root, homeDir: home }) : []).toEqual([]);
  });
});
