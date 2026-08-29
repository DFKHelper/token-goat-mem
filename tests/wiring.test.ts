/**
 * Unit-level tests for src/wiring.ts's install/uninstall/describe behavior across all four tools,
 * plus direct coverage of the low-level building blocks (marker insert/replace/strip, JSON/JSONC
 * stamping, atomic-write retry). Every test uses an isolated `mkdtempSync` fixture for both the
 * project root and the "home" directory -- never the real `~/.claude`, real VS Code config, or real
 * project files.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  claudeCode,
  codex,
  copilotCli,
  copilotVscode,
  vscodeUserDir,
  WiringConflictError,
  writeManagedFile,
} from "../src/wiring.js";

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-wiring-root-"));
  home = mkdtempSync(join(tmpdir(), "mem-wiring-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Seeds a pre-existing fixture file, creating its parent directory first (writeFileSync does not). */
function seed(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

// ─────────────────────────────────────────────────────────────────────────── claudeCode ───────────────────────────────────────────────────────────────────────────

describe("claudeCode wiring", () => {
  it("install creates .claude/settings.json with a stamped SessionStart hook and CLAUDE.md with a marked block", () => {
    const result = claudeCode.install({ root, homeDir: home });
    expect(result.changes.map((c) => c.action)).toEqual(["create", "create"]);

    const settingsPath = join(root, ".claude", "settings.json");
    const settings = JSON.parse(read(settingsPath));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    const hook = settings.hooks.SessionStart[0].hooks[0];
    expect(hook.__token_goat_mem).toBe(true);
    expect(hook.command).toContain("mem recall --hint-format --root");

    const claudeMd = read(join(root, "CLAUDE.md"));
    expect(claudeMd).toContain("<!-- token-goat-mem:claude-code:start -->");
    expect(claudeMd).toContain("mem remember");
    expect(claudeMd).toContain("<!-- token-goat-mem:claude-code:end -->");
  });

  it("install is idempotent: re-running does not duplicate the hook or the CLAUDE.md block", () => {
    claudeCode.install({ root, homeDir: home });
    const second = claudeCode.install({ root, homeDir: home });
    expect(second.changes.every((c) => c.action === "noop")).toBe(true);

    const settings = JSON.parse(read(join(root, ".claude", "settings.json")));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    const claudeMd = read(join(root, "CLAUDE.md"));
    expect(claudeMd.split("token-goat-mem:claude-code:start").length - 1).toBe(1);
  });

  it("--user writes settings.json under homeDir/.claude instead of root/.claude", () => {
    claudeCode.install({ root, homeDir: home, user: true });
    expect(() => read(join(root, ".claude", "settings.json"))).toThrow();
    const settings = JSON.parse(read(join(home, ".claude", "settings.json")));
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it("--user does not touch CLAUDE.md at root (docs promise settings.json only under --user)", () => {
    claudeCode.install({ root, homeDir: home, user: true });
    expect(() => read(join(root, "CLAUDE.md"))).toThrow();
    const result = claudeCode.uninstall({ root, homeDir: home, user: true });
    expect(result.changes.every((c) => c.path !== join(root, "CLAUDE.md"))).toBe(true);
  });

  it("edge case (a): 2 pre-existing non-mem SessionStart hooks -> install produces 3, uninstall restores exactly the original 2 in order", () => {
    const settingsPath = join(root, ".claude", "settings.json");
    const original = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo one" }] },
          { hooks: [{ type: "command", command: "echo two" }] },
        ],
      },
    };
    seed(settingsPath, `${JSON.stringify(original, null, 2)}\n`);

    claudeCode.install({ root, homeDir: home });
    const afterInstall = JSON.parse(read(settingsPath));
    expect(afterInstall.hooks.SessionStart).toHaveLength(3);
    expect(afterInstall.hooks.SessionStart[0].hooks[0].command).toBe("echo one");
    expect(afterInstall.hooks.SessionStart[1].hooks[0].command).toBe("echo two");
    expect(afterInstall.hooks.SessionStart[2].hooks[0].__token_goat_mem).toBe(true);

    claudeCode.uninstall({ root, homeDir: home });
    const afterUninstall = JSON.parse(read(settingsPath));
    expect(afterUninstall.hooks.SessionStart).toEqual(original.hooks.SessionStart);
  });

  it("aborts with WiringConflictError when an unstamped hook with the same command already exists", () => {
    const settingsPath = join(root, ".claude", "settings.json");
    const original = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: 'mem recall --hint-format --root "$CLAUDE_PROJECT_DIR"' }] }],
      },
    };
    seed(settingsPath, `${JSON.stringify(original, null, 2)}\n`);

    expect(() => claudeCode.install({ root, homeDir: home })).toThrow(WiringConflictError);
  });

  it("aborts when hooks.SessionStart exists but is not an array", () => {
    const settingsPath = join(root, ".claude", "settings.json");
    seed(settingsPath, JSON.stringify({ hooks: { SessionStart: "not-an-array" } }));
    expect(() => claudeCode.install({ root, homeDir: home })).toThrow(WiringConflictError);
  });

  it("aborts with WiringConflictError (not a raw TypeError) when hooks is null", () => {
    const settingsPath = join(root, ".claude", "settings.json");
    seed(settingsPath, JSON.stringify({ hooks: null }));
    expect(() => claudeCode.install({ root, homeDir: home })).toThrow(WiringConflictError);
  });

  it("aborts with WiringConflictError (not a raw TypeError) when the settings.json root is not an object", () => {
    const settingsPath = join(root, ".claude", "settings.json");
    seed(settingsPath, "5");
    expect(() => claudeCode.install({ root, homeDir: home })).toThrow(WiringConflictError);
  });

  it("aborts with WiringConflictError (not a raw TypeError) when SessionStart contains a null element", () => {
    const settingsPath = join(root, ".claude", "settings.json");
    seed(settingsPath, JSON.stringify({ hooks: { SessionStart: [null] } }));
    expect(() => claudeCode.install({ root, homeDir: home })).toThrow(WiringConflictError);
  });

  it("aborts with WiringConflictError (not a raw TypeError) when a SessionStart entry's hooks is not an array", () => {
    const settingsPath = join(root, ".claude", "settings.json");
    seed(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: "not-an-array" }] } }));
    expect(() => claudeCode.install({ root, homeDir: home })).toThrow(WiringConflictError);
  });

  it("aborts with WiringConflictError (not a raw TypeError) when a SessionStart entry's hooks array contains a null element", () => {
    const settingsPath = join(root, ".claude", "settings.json");
    seed(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [null] }] } }));
    expect(() => claudeCode.install({ root, homeDir: home })).toThrow(WiringConflictError);
  });

  it("aborts with WiringConflictError (not a raw TypeError) when a SessionStart entry's hooks array contains a non-object element", () => {
    const settingsPath = join(root, ".claude", "settings.json");
    seed(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: ["not-an-object"] }] } }));
    expect(() => claudeCode.install({ root, homeDir: home })).toThrow(WiringConflictError);
  });

  it("uninstall on a SessionStart holding a null element does not crash and leaves the file untouched", () => {
    const settingsPath = join(root, ".claude", "settings.json");
    const seeded = JSON.stringify({ hooks: { SessionStart: [null] } });
    seed(settingsPath, seeded);
    expect(() => claudeCode.uninstall({ root, homeDir: home })).not.toThrow();
    expect(read(settingsPath)).toBe(seeded);
  });

  it("uninstall on a settings.json whose root is null does not crash and leaves the file untouched", () => {
    const settingsPath = join(root, ".claude", "settings.json");
    seed(settingsPath, "null");
    expect(() => claudeCode.uninstall({ root, homeDir: home })).not.toThrow();
    expect(read(settingsPath)).toBe("null");
  });

  it("treats a pre-existing but blank (whitespace-only) settings.json the same as a missing file", () => {
    const settingsPath = join(root, ".claude", "settings.json");
    seed(settingsPath, "   \n\t");
    expect(() => claudeCode.install({ root, homeDir: home })).not.toThrow();
    const settings = JSON.parse(read(settingsPath));
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it("uninstall on a file with nothing stamped is a no-op, not an error", () => {
    const settingsPath = join(root, ".claude", "settings.json");
    // Four-space indent, so byte-identity is a real assertion: a reserialize would come back at two.
    const original = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo one" }] }] } };
    const originalText = `${JSON.stringify(original, null, 4)}\n`;
    seed(settingsPath, originalText);

    const result = claudeCode.uninstall({ root, homeDir: home });
    expect(result.changes.find((c) => c.path === settingsPath)?.action).toBe("noop");
    expect(read(settingsPath)).toBe(originalText);
  });

  it("uninstall on a completely fresh directory is a no-op for every file", () => {
    const result = claudeCode.uninstall({ root, homeDir: home });
    expect(result.changes.every((c) => c.action === "noop")).toBe(true);
  });

  it("takes a .bak snapshot on first write and never overwrites it on a later re-init", () => {
    const settingsPath = join(root, ".claude", "settings.json");
    // Compact and unterminated on purpose: the .bak has to be a byte copy of what was on disk, not a
    // reserialization of what mem parsed out of it.
    const originalText = `{"hooks":{"SessionStart":[]}}`;
    seed(settingsPath, originalText);

    claudeCode.install({ root, homeDir: home });
    const bakPath = `${settingsPath}.token-goat-mem.bak`;
    expect(read(bakPath)).toBe(originalText);

    // Mutate the live file directly (simulating manual edits) and re-init; the .bak must stay frozen.
    const mutated = JSON.parse(read(settingsPath));
    mutated.extra = "hand-added";
    seed(settingsPath, JSON.stringify(mutated));
    claudeCode.install({ root, homeDir: home });
    expect(read(bakPath)).toBe(originalText);
  });
});

// ─────────────────────────────────────────────────────────────────────────── codex / copilot-cli AGENTS.md shared block ───────────────────────────────────────────────────────────────────────────

describe("codex, copilot-cli, and copilot-vscode wiring (shared, reference-counted AGENTS.md block)", () => {
  it("codex install alone creates one shared block with tools=codex", () => {
    codex.install({ root, homeDir: home });

    const agentsMd = read(join(root, "AGENTS.md"));
    expect(agentsMd).toContain("<!-- token-goat-mem:start tools=codex -->");
    expect(agentsMd).toContain("<!-- token-goat-mem:end -->");
    expect(agentsMd.split("## Memory").length - 1).toBe(1);
  });

  it("copilot-cli installing second joins the existing block: tools= gets both, sorted, and there is exactly one \"## Memory\" section", () => {
    codex.install({ root, homeDir: home });
    copilotCli.install({ root, homeDir: home });

    const agentsMd = read(join(root, "AGENTS.md"));
    expect(agentsMd).toContain("<!-- token-goat-mem:start tools=codex,copilot-cli -->");
    expect(agentsMd.split("## Memory").length - 1).toBe(1);
    expect(agentsMd.split("<!-- token-goat-mem:start").length - 1).toBe(1);
    expect(agentsMd).toContain("mem remember \"<short fact>\" --kind preference|decision|fact|correction");
    expect(agentsMd).toContain("At the start of a task, run");
  });

  it("installing in the opposite order (copilot-cli first, codex second) produces the same sorted tools= list", () => {
    copilotCli.install({ root, homeDir: home });
    codex.install({ root, homeDir: home });

    const agentsMd = read(join(root, "AGENTS.md"));
    expect(agentsMd).toContain("<!-- token-goat-mem:start tools=codex,copilot-cli -->");
  });

  it("the block body is untouched when a second tool joins: byte-identical body content before and after", () => {
    codex.install({ root, homeDir: home });
    const before = read(join(root, "AGENTS.md"));
    const bodyBefore = before.split("\n").slice(1, -1).join("\n"); // strip the marker start line and trailing marker

    copilotCli.install({ root, homeDir: home });
    const after = read(join(root, "AGENTS.md"));
    const bodyAfter = after.split("\n").slice(1, -1).join("\n");

    expect(bodyAfter).toBe(bodyBefore);
  });

  it("re-running install for a tool already in the list is a no-op", () => {
    codex.install({ root, homeDir: home });
    copilotCli.install({ root, homeDir: home });
    const first = read(join(root, "AGENTS.md"));

    const second = codex.install({ root, homeDir: home });
    expect(second.changes[0]?.action).toBe("noop");
    expect(read(join(root, "AGENTS.md"))).toBe(first);
  });

  it("uninstalling codex leaves copilot-cli listed and the block (with its content) in place", () => {
    codex.install({ root, homeDir: home });
    copilotCli.install({ root, homeDir: home });
    codex.uninstall({ root, homeDir: home });

    const agentsMd = read(join(root, "AGENTS.md"));
    expect(agentsMd).toContain("<!-- token-goat-mem:start tools=copilot-cli -->");
    expect(agentsMd).toContain("## Memory");
    expect(agentsMd).toContain("mem recall --hint-format --root .");
  });

  it("uninstalling the last remaining tool removes the whole block", () => {
    codex.install({ root, homeDir: home });
    copilotCli.install({ root, homeDir: home });
    codex.uninstall({ root, homeDir: home });
    copilotCli.uninstall({ root, homeDir: home });

    const agentsMd = read(join(root, "AGENTS.md"));
    expect(agentsMd).not.toContain("token-goat-mem");
    expect(agentsMd).not.toContain("## Memory");
  });

  it("codex install/uninstall round-trips a pre-existing AGENTS.md byte-for-byte", () => {
    const agentsMdPath = join(root, "AGENTS.md");
    const original = "# Project agents\n\nSome existing instructions.\n";
    seed(agentsMdPath, original);

    codex.install({ root, homeDir: home });
    expect(read(agentsMdPath)).not.toBe(original);
    codex.uninstall({ root, homeDir: home });
    expect(read(agentsMdPath)).toBe(original);
  });

  it("re-running install upgrades/joins the block in place instead of duplicating it", () => {
    codex.install({ root, homeDir: home });
    const first = read(join(root, "AGENTS.md"));
    const second = codex.install({ root, homeDir: home });
    expect(second.changes[0]?.action).toBe("noop");
    expect(read(join(root, "AGENTS.md"))).toBe(first);
  });

  it("all three tools installed produce exactly one block with tools=codex,copilot-cli,copilot-vscode, sorted", () => {
    codex.install({ root, homeDir: home });
    copilotVscode.install({ root, homeDir: home });
    copilotCli.install({ root, homeDir: home });

    const agentsMd = read(join(root, "AGENTS.md"));
    expect(agentsMd).toContain("<!-- token-goat-mem:start tools=codex,copilot-cli,copilot-vscode -->");
    expect(agentsMd.split("## Memory").length - 1).toBe(1);
    expect(agentsMd.split("<!-- token-goat-mem:start").length - 1).toBe(1);
  });

  it("uninstalling all three tools in a different order than they were installed decrements correctly and removes the block only after the last one", () => {
    copilotVscode.install({ root, homeDir: home });
    codex.install({ root, homeDir: home });
    copilotCli.install({ root, homeDir: home });

    copilotVscode.uninstall({ root, homeDir: home });
    let agentsMd = read(join(root, "AGENTS.md"));
    expect(agentsMd).toContain("<!-- token-goat-mem:start tools=codex,copilot-cli -->");

    copilotCli.uninstall({ root, homeDir: home });
    agentsMd = read(join(root, "AGENTS.md"));
    expect(agentsMd).toContain("<!-- token-goat-mem:start tools=codex -->");
    expect(agentsMd).toContain("## Memory");

    codex.uninstall({ root, homeDir: home });
    agentsMd = read(join(root, "AGENTS.md"));
    expect(agentsMd).not.toContain("token-goat-mem");
    expect(agentsMd).not.toContain("## Memory");
  });

  it("copilot-vscode installing third joins the existing two-tool block without touching tasks.json/keybindings.json semantics", () => {
    codex.install({ root, homeDir: home });
    copilotCli.install({ root, homeDir: home });
    const result = copilotVscode.install({ root, homeDir: home });

    const agentsMdChange = result.changes.find((c) => c.path.endsWith("AGENTS.md"));
    expect(agentsMdChange?.action).toBe("update");
    expect(read(join(root, "AGENTS.md"))).toContain("<!-- token-goat-mem:start tools=codex,copilot-cli,copilot-vscode -->");

    const tasksPath = join(root, ".vscode", "tasks.json");
    const tasks = JSON.parse(read(tasksPath));
    expect(tasks.tasks).toHaveLength(3);
  });

  describe("describe() (dry-run) wording for the shared block", () => {
    it("installing codex when copilot-cli's block already exists describes it as joining, not creating", () => {
      copilotCli.install({ root, homeDir: home });
      const plan = codex.describe({ root, homeDir: home });
      expect(plan.entries[0]?.installAction).toBe("update");
      expect(plan.entries[0]?.detail).toContain("join existing shared block (adds codex to tools=)");
    });

    it("uninstalling one of several tools describes leaving the block in place and dropping just that tool", () => {
      codex.install({ root, homeDir: home });
      copilotCli.install({ root, homeDir: home });
      const plan = codex.describe({ root, homeDir: home });
      expect(plan.entries[0]?.uninstallAction).toBe("remove");
      expect(plan.entries[0]?.detail).toContain("leave shared block in place, drop codex from tools=");
    });

    it("uninstalling the sole remaining tool describes removing the shared block entirely", () => {
      codex.install({ root, homeDir: home });
      const plan = codex.describe({ root, homeDir: home });
      expect(plan.entries[0]?.uninstallAction).toBe("remove");
      expect(plan.entries[0]?.detail).toContain("remove shared block entirely");
    });
  });

  describe("malformed/orphaned markers", () => {
    it("an orphaned start marker (no matching end) earlier in the file does not blind uninstall to a valid block further down", () => {
      const agentsPath = join(root, "AGENTS.md");
      seed(agentsPath, "# hi\n\n<!-- token-goat-mem:start tools=codex -->\norphaned, no end marker for this one\n");
      codex.install({ root, homeDir: home }); // no resolvable block found -> appends a fresh, valid one below

      const afterInstall = read(agentsPath);
      expect(afterInstall).toContain("orphaned, no end marker for this one");
      expect(afterInstall.split("<!-- token-goat-mem:start").length - 1).toBe(2);

      codex.uninstall({ root, homeDir: home });
      const afterUninstall = read(agentsPath);
      // The valid block (the one uninstall can actually act on) is gone...
      expect(afterUninstall).not.toContain("<!-- token-goat-mem:end -->");
      expect(afterUninstall).not.toContain("## Memory");
      // ...but the unrelated, pre-existing orphaned content is left untouched, not swallowed.
      expect(afterUninstall).toContain("orphaned, no end marker for this one");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────── copilotVscode ───────────────────────────────────────────────────────────────────────────

describe("copilotVscode wiring", () => {
  it("install creates tasks.json with 3 stamped tasks + 1 input, keybindings.json with 2 stamped bindings under homeDir, and AGENTS.md", () => {
    const result = copilotVscode.install({ root, homeDir: home });
    expect(result.changes.map((c) => c.action)).toEqual(["create", "create", "create"]);

    const tasksPath = join(root, ".vscode", "tasks.json");
    const tasks = JSON.parse(read(tasksPath));
    expect(tasks.tasks).toHaveLength(3);
    expect(tasks.tasks.every((t: { __token_goat_mem?: boolean }) => t.__token_goat_mem === true)).toBe(true);
    expect(tasks.inputs).toHaveLength(1);
    expect(tasks.version).toBe("2.0.0");

    const keybindingsPath = join(vscodeUserDir(home), "keybindings.json");
    const keybindings = JSON.parse(read(keybindingsPath));
    expect(keybindings).toHaveLength(2);
    expect(keybindings.every((k: { __token_goat_mem?: boolean }) => k.__token_goat_mem === true)).toBe(true);

    expect(read(join(root, "AGENTS.md"))).toContain("<!-- token-goat-mem:start tools=copilot-vscode -->");
  });

  it("edge case (b): a pre-existing unstamped task sharing mem's label makes install abort with a conflict error, without duplicating or overwriting", () => {
    const tasksPath = join(root, ".vscode", "tasks.json");
    const original = {
      version: "2.0.0",
      tasks: [{ label: "Mem: Recall project facts", type: "shell", command: "echo not-mem" }],
    };
    // Four-space indent: an aborted install must leave the file untouched down to its formatting.
    const originalText = JSON.stringify(original, null, 4);
    seed(tasksPath, originalText);

    expect(() => copilotVscode.install({ root, homeDir: home })).toThrow(WiringConflictError);
    expect(read(tasksPath)).toBe(originalText);
  });

  it("install is idempotent for tasks.json and keybindings.json", () => {
    copilotVscode.install({ root, homeDir: home });
    const second = copilotVscode.install({ root, homeDir: home });
    expect(second.changes.every((c) => c.action === "noop")).toBe(true);
  });

  it("treats a pre-existing but blank (0-byte) tasks.json and keybindings.json the same as missing files", () => {
    const tasksPath = join(root, ".vscode", "tasks.json");
    const keybindingsPath = join(vscodeUserDir(home), "keybindings.json");
    seed(tasksPath, "");
    seed(keybindingsPath, "   ");

    expect(() => copilotVscode.install({ root, homeDir: home })).not.toThrow();
    expect(JSON.parse(read(tasksPath)).tasks).toHaveLength(3);
    expect(JSON.parse(read(keybindingsPath))).toHaveLength(2);
  });

  it("aborts with WiringConflictError (not a raw Error from jsonc-parser) when tasks.json's root is not an object", () => {
    const tasksPath = join(root, ".vscode", "tasks.json");
    seed(tasksPath, "5");
    expect(() => copilotVscode.install({ root, homeDir: home })).toThrow(WiringConflictError);
  });

  it("uninstall on a tasks.json whose root is not an object does not crash and leaves the file untouched", () => {
    const tasksPath = join(root, ".vscode", "tasks.json");
    seed(tasksPath, "5");
    expect(() => copilotVscode.uninstall({ root, homeDir: home })).not.toThrow();
    expect(read(tasksPath)).toBe("5");
  });

  it("aborts with WiringConflictError (not a raw jsonc-parser Error) when tasks.json's tasks is not an array", () => {
    const tasksPath = join(root, ".vscode", "tasks.json");
    seed(tasksPath, JSON.stringify({ version: "2.0.0", tasks: "oops" }));
    expect(() => copilotVscode.install({ root, homeDir: home })).toThrow(WiringConflictError);
  });

  it("aborts with WiringConflictError (not a raw jsonc-parser Error) when tasks.json's inputs is not an array", () => {
    const tasksPath = join(root, ".vscode", "tasks.json");
    seed(tasksPath, JSON.stringify({ version: "2.0.0", tasks: [], inputs: {} }));
    expect(() => copilotVscode.install({ root, homeDir: home })).toThrow(WiringConflictError);
  });

  it("aborts with WiringConflictError (not a raw jsonc-parser Error) when keybindings.json parses to literal null", () => {
    // Regression: a `null` root slipped past the array check via a `null ?? []` coercion, then reached
    // jsonc-parser's modify() on a null root -- which throws a raw "Can not add property to parent of
    // type null" Error instead of the documented WiringConflictError contract.
    const keybindingsPath = join(vscodeUserDir(home), "keybindings.json");
    seed(keybindingsPath, "null");
    expect(() => copilotVscode.install({ root, homeDir: home })).toThrow(WiringConflictError);
  });

  it("aborts with WiringConflictError when keybindings.json's root is a JSON object, not an array", () => {
    const keybindingsPath = join(vscodeUserDir(home), "keybindings.json");
    seed(keybindingsPath, JSON.stringify({ not: "an array" }));
    expect(() => copilotVscode.install({ root, homeDir: home })).toThrow(WiringConflictError);
  });

  it("uninstall on a keybindings.json whose root is not an array does not crash and leaves the file untouched", () => {
    const keybindingsPath = join(vscodeUserDir(home), "keybindings.json");
    seed(keybindingsPath, "null");
    expect(() => copilotVscode.uninstall({ root, homeDir: home })).not.toThrow();
    expect(read(keybindingsPath)).toBe("null");
  });

  it("uninstall removes only the stamped tasks/inputs/keybindings, preserving a pre-existing unrelated task", () => {
    const tasksPath = join(root, ".vscode", "tasks.json");
    const original = { version: "2.0.0", tasks: [{ label: "Build", type: "shell", command: "npm run build" }], inputs: [] };
    seed(tasksPath, JSON.stringify(original, null, 2));

    copilotVscode.install({ root, homeDir: home });
    let tasks = JSON.parse(read(tasksPath));
    expect(tasks.tasks).toHaveLength(4);

    copilotVscode.uninstall({ root, homeDir: home });
    tasks = JSON.parse(read(tasksPath));
    expect(tasks.tasks).toEqual([{ label: "Build", type: "shell", command: "npm run build" }]);
    // The `inputs` key was mem's own -- uninstall prunes the array it emptied rather than leave `[]`.
    expect(tasks.inputs).toBeUndefined();

    const keybindingsPath = join(vscodeUserDir(home), "keybindings.json");
    expect(JSON.parse(read(keybindingsPath))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────── describe() dry-run plan ───────────────────────────────────────────────────────────────────────────

describe("describe() (dry-run plan)", () => {
  it("reports create for every file before install, and noop/remove after install", () => {
    const before = codex.describe({ root, homeDir: home });
    expect(before.entries.every((e) => e.installAction === "create" && e.uninstallAction === "noop")).toBe(true);

    codex.install({ root, homeDir: home });
    const after = codex.describe({ root, homeDir: home });
    expect(after.entries.every((e) => e.installAction === "noop" && e.uninstallAction === "remove")).toBe(true);
  });

  it("never writes to disk", () => {
    claudeCode.describe({ root, homeDir: home });
    expect(() => read(join(root, ".claude", "settings.json"))).toThrow();
    expect(() => read(join(root, "CLAUDE.md"))).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────── writeManagedFile: atomic write + retry ───────────────────────────────────────────────────────────────────────────

describe("writeManagedFile permissions", () => {
  /**
   * A temp-file-plus-rename write replaces the inode rather than updating it, so without explicit
   * mode preservation the replacement carries whatever the umask gave it. For a managed file the
   * user deliberately restricted -- a `~/.claude/settings.json` at 0600 holding API configuration --
   * that turns "add a mem block" into "make this world-readable". POSIX-only: on Windows `chmod`
   * carries no read-permission meaning and the ACL is what protects the file.
   */
  it.skipIf(process.platform === "win32")("preserves a restrictive mode across the atomic replace", () => {
    const target = join(root, "settings.json");
    writeFileSync(target, "original\n", "utf8");
    chmodSync(target, 0o600);

    const change = writeManagedFile({ path: target, transform: (before) => `${before ?? ""}appended\n` });

    expect(change.action).toBe("update");
    expect(readFileSync(target, "utf8")).toContain("appended");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});

describe("writeManagedFile", () => {
  it("writes new content and reports create/update correctly", () => {
    const filePath = join(root, "sub", "file.txt");
    const created = writeManagedFile({ path: filePath, transform: () => "hello\n" });
    expect(created.action).toBe("create");
    expect(read(filePath)).toBe("hello\n");

    const updated = writeManagedFile({ path: filePath, transform: (current) => `${current}world\n` });
    expect(updated.action).toBe("update");
    expect(read(filePath)).toBe("hello\nworld\n");
  });

  it("is a no-op when the transform returns the same content or undefined", () => {
    const filePath = join(root, "file.txt");
    writeFileSync(filePath, "unchanged\n", "utf8");
    const noop1 = writeManagedFile({ path: filePath, transform: (current) => current });
    expect(noop1.action).toBe("noop");
    const noop2 = writeManagedFile({ path: filePath, transform: () => undefined });
    expect(noop2.action).toBe("noop");
    expect(read(filePath)).toBe("unchanged\n");
  });

  it("takes a .bak snapshot on the first write to a pre-existing file, and never overwrites it again", () => {
    const filePath = join(root, "file.txt");
    writeFileSync(filePath, "original\n", "utf8");
    writeManagedFile({ path: filePath, transform: () => "v2\n" });
    expect(read(`${filePath}.token-goat-mem.bak`)).toBe("original\n");
    writeManagedFile({ path: filePath, transform: () => "v3\n" });
    expect(read(`${filePath}.token-goat-mem.bak`)).toBe("original\n");
  });

  it("does not create a .bak file when the target file did not previously exist", () => {
    const filePath = join(root, "brand-new.txt");
    writeManagedFile({ path: filePath, transform: () => "new\n" });
    expect(() => read(`${filePath}.token-goat-mem.bak`)).toThrow();
  });

  it("retries the transform once against fresh content if the file changed between the initial read and the pre-write check", () => {
    const filePath = join(root, "concurrent.txt");
    writeFileSync(filePath, "v1\n", "utf8");

    let calls = 0;
    const result = writeManagedFile({
      path: filePath,
      transform: (current) => {
        calls += 1;
        if (calls === 1) {
          // Simulate another process writing to the file concurrently, after this first read.
          writeFileSync(filePath, "v2-from-elsewhere\n", "utf8");
        }
        return `${current}-appended\n`;
      },
    });

    expect(calls).toBe(2);
    expect(result.action).toBe("update");
    expect(read(filePath)).toBe("v2-from-elsewhere\n-appended\n");
  });
});

// ─────────────────────────────────────────────────────────────────────────── regression: the atomic-write temp file never outlives the write ───────────────────────────────────────────────────────────────────────────

describe("writeManagedFile leaves no temp file behind when the rename fails", () => {
  function tempSiblings(filePath: string): string[] {
    return readdirSync(dirname(filePath)).filter((name) => name.includes(".tmp-"));
  }

  // An open read-write handle on the destination makes Windows fail the rename with EPERM *after*
  // the temp file has been written -- the one window where the scratch file can outlive the call.
  // POSIX renames over an open file happily, so there is no equivalent failure to provoke there.
  it.skipIf(process.platform !== "win32")("cleans up its scratch file when the rename fails", () => {
    const target = join(root, "CLAUDE.md");
    writeFileSync(target, "existing content\n");
    const handle = openSync(target, "r+");

    try {
      // Without the cleanup, every failed write left a stray `<file>.token-goat-mem.tmp-<n>` next to
      // the managed file -- in the user's project, or in their ~/.claude -- that no later run removes.
      expect(() => writeManagedFile({ path: target, transform: () => "managed content\n" })).toThrow();
      expect(tempSiblings(target)).toEqual([]);
    } finally {
      closeSync(handle);
    }
  });

  it("leaves no temp file behind on the success path either", () => {
    const target = join(root, "AGENTS.md");
    const change = writeManagedFile({ path: target, transform: () => "managed content\n" });

    expect(change.action).not.toBe("noop");
    expect(readFileSync(target, "utf8")).toBe("managed content\n");
    expect(tempSiblings(target)).toEqual([]);
  });
});

describe("regression: installed keybindings do not shadow VS Code defaults", () => {
  it("binds chords rather than ctrl+shift+m / ctrl+shift+n", () => {
    copilotVscode.install({ root, homeDir: home });
    const keybindings = JSON.parse(read(join(vscodeUserDir(home), "keybindings.json"))) as ReadonlyArray<{ key: string }>;
    const keys = keybindings.map((binding) => binding.key);

    // Both originals were live VS Code defaults: ctrl+shift+m toggles the Problems panel and
    // ctrl+shift+n opens a new window. A later entry in keybindings.json wins, so installing mem
    // silently took both away from every user who ran `mem init copilot-vscode` -- a wiring command
    // is expected to add capability, not remove two bindings the user never mentioned.
    expect(keys).not.toContain("ctrl+shift+m");
    expect(keys).not.toContain("ctrl+shift+n");

    // `ctrl+k` is VS Code's conventional chord prefix: a second keystroke follows, so the binding
    // reads as an extension's rather than a hijacked default, and collides with far less.
    expect(keys.every((key) => key.startsWith("ctrl+k "))).toBe(true);
  });
});

describe("regression: the copilot-vscode doc matches what mem init actually writes", () => {
  /** Extracts the first ```json fenced block appearing after `heading` in the integration doc. */
  function docJsonBlock(heading: string): unknown {
    const doc = readFileSync(new URL("../docs/integrations/copilot-vscode.md", import.meta.url), "utf8");
    const afterHeading = doc.slice(doc.indexOf(heading));
    expect(afterHeading).not.toBe("");
    const fence = /```json\r?\n([\s\S]*?)\r?\n```/u.exec(afterHeading);
    expect(fence?.[1]).toBeDefined();
    return JSON.parse(fence?.[1] ?? "");
  }

  it("documents the same keybindings the installer writes", () => {
    copilotVscode.install({ root, homeDir: home });
    const installed = JSON.parse(read(join(vscodeUserDir(home), "keybindings.json"))) as ReadonlyArray<Record<string, unknown>>;

    // The stamp is installer bookkeeping for reference-counted uninstall, not something a user
    // hand-copying the doc would type, so it is not part of what the doc is expected to show.
    const withoutStamp = installed.map(({ __token_goat_mem: _stamp, ...rest }) => rest);

    // 0.2.4 changed these bindings from `ctrl+shift+m`/`ctrl+shift+n` (which shadowed View: Problems
    // and New Window) to chords, and updated only src/wiring.ts. The suite stayed green because
    // every existing test compared code against code, so the doc went on handing users by hand the
    // exact two shadowing bindings the release had just removed. The doc's own promise -- "what
    // `mem init copilot-vscode` writes, if you'd rather do it by hand" -- is the invariant, and this
    // asserts it directly rather than restating either side's literal values.
    expect(withoutStamp).toEqual(docJsonBlock("## Keybindings for quick memory"));
  });

  it("documents the same tasks and input the installer writes", () => {
    copilotVscode.install({ root, homeDir: home });
    const installed = JSON.parse(read(join(root, ".vscode", "tasks.json"))) as {
      readonly version: string;
      readonly tasks: ReadonlyArray<Record<string, unknown>>;
      readonly inputs: ReadonlyArray<Record<string, unknown>>;
    };

    const documented = docJsonBlock("## VS Code tasks") as typeof installed;

    // Same invariant as the keybindings above, on the other half of what the doc tells a user to
    // write by hand. This block was in sync when the test was added -- it is here to keep it that
    // way, since the keybindings only drifted because nothing was watching.
    expect(installed.version).toEqual(documented.version);
    expect(installed.tasks.map(({ __token_goat_mem: _stamp, ...rest }) => rest)).toEqual(documented.tasks);
    expect(installed.inputs.map(({ __token_goat_mem: _stamp, ...rest }) => rest)).toEqual(documented.inputs);
  });
});

// ─────────────────────────────────────────────────────────────────────────── malformed per-tool markers ───────────────────────────────────────────────────────────────────────────

/**
 * The shared reference-counted locator already scans every start marker and skips the ones that do
 * not resolve to a complete block, because a hand-edit, a crashed write, or a merge conflict can
 * leave an orphaned start marker behind. The per-tool path took the first `start` and the first
 * `end` with a bare `indexOf` pair, so an orphan ahead of the real block made uninstall delete
 * everything between the two -- the user's content included.
 */
describe("regression: per-tool marker pairing survives malformed markers", () => {
  const START = "<!-- token-goat-mem:claude-code:start -->";
  const END = "<!-- token-goat-mem:claude-code:end -->";

  it("does not delete user content between an orphaned start marker and the real block", () => {
    const path = join(root, "CLAUDE.md");
    seed(path, `# My notes\n\n${START}\n\nUSER CONTENT THAT MUST SURVIVE\n\n${START}\nmem body\n${END}\n`);

    claudeCode.uninstall({ root, homeDir: home });

    const after = read(path);
    expect(after).toContain("USER CONTENT THAT MUST SURVIVE");
    expect(after).toContain("# My notes");
    // The real block is gone; the orphaned start marker is left alone rather than guessed at.
    expect(after).not.toContain("mem body");
    expect(after).not.toContain(END);
  });

  it("finds the real block when a stray end marker precedes it", () => {
    const path = join(root, "CLAUDE.md");
    seed(path, `# Notes\n\n${END}\n\nuser text\n\n${START}\nmem body\n${END}\n`);

    claudeCode.uninstall({ root, homeDir: home });

    const after = read(path);
    expect(after).toContain("user text");
    expect(after).not.toContain("mem body");
    expect(after).not.toContain(START);
  });
});

// ─────────────────────────────────────────────────────────────────────────── shared block body upgrades ───────────────────────────────────────────────────────────────────────────

describe("regression: the shared block body is upgraded, not left stale", () => {
  it("rewrites a stale shared body when a listed tool is reinstalled", () => {
    // The shared body is identical prose for every tool that writes it, so a tool already named in
    // tools= still has to refresh it. Returning early on `tools.includes(tool)` meant a body written
    // by an older version was never upgraded -- the per-tool path replaces its body on reinstall, and
    // the two diverged silently.
    const path = join(root, "AGENTS.md");
    codex.install({ root, homeDir: home });

    const installed = read(path);
    const stale = installed.replace(/(<!-- token-goat-mem:start tools=codex -->\n)[\s\S]*?(\n<!-- token-goat-mem:end -->)/u, "$1OLD STALE BODY FROM AN EARLIER VERSION$2");
    expect(stale).toContain("OLD STALE BODY");
    writeFileSync(path, stale, "utf8");

    codex.install({ root, homeDir: home });

    const after = read(path);
    expect(after).not.toContain("OLD STALE BODY");
    expect(after).toBe(installed);
  });

  it("says the dry run would refresh the body, not that it would join tools=", () => {
    const path = join(root, "AGENTS.md");
    codex.install({ root, homeDir: home });
    const stale = read(path).replace(/(<!-- token-goat-mem:start tools=codex -->\n)[\s\S]*?(\n<!-- token-goat-mem:end -->)/u, "$1OLD STALE BODY$2");
    writeFileSync(path, stale, "utf8");

    const plan = codex.describe({ root, homeDir: home });
    const agents = plan.entries.find((e) => e.path.endsWith("AGENTS.md"));
    expect(agents?.detail).toContain("refresh the shared block body");
    expect(agents?.detail).not.toContain("adds codex to tools=");
  });
});

// ─────────────────────────────────────────────────────────────────────────── hand-authored config formatting ───────────────────────────────────────────────────────────────────────────

/**
 * mem edits four files it does not own. Two of them were being rewritten wholesale on every install:
 * settings.json went through `JSON.stringify(parsed, null, 2)`, and the JSONC array writes passed
 * jsonc-parser a `formattingOptions`, which makes `modify` reformat the entire containing array. A
 * user who indents with four spaces, or keeps a keybinding on one line, got it back mem's way.
 */
describe("regression: mem does not restyle config files it did not author", () => {
  const FOUR_SPACE_SETTINGS = [
    "{",
    '    "model": "opus",',
    '    "permissions": {',
    '        "allow": ["Bash(ls:*)"]',
    "    },",
    '    "hooks": {',
    '        "SessionStart": [',
    '            { "hooks": [{ "type": "command", "command": "echo hi" }] }',
    "        ]",
    "    }",
    "}",
    "",
  ].join("\n");

  it("keeps a 4-space settings.json on 4 spaces and leaves the user's own hook entry untouched", () => {
    const settingsPath = join(home, ".claude", "settings.json");
    seed(settingsPath, FOUR_SPACE_SETTINGS);

    claudeCode.install({ root, homeDir: home, user: true });

    const after = read(settingsPath);
    expect(after).toContain('    "model": "opus",');
    expect(after).toContain('        "allow": ["Bash(ls:*)"]');
    // The user's single-line hook group is byte-identical, not exploded across five lines.
    expect(after).toContain('            { "hooks": [{ "type": "command", "command": "echo hi" }] }');
    expect(after).not.toMatch(/^ {2}"/mu);
    // ...and the file is still valid JSON with both hooks present.
    const parsed = JSON.parse(after);
    expect(parsed.hooks.SessionStart).toHaveLength(2);
    expect(parsed.model).toBe("opus");
  });

  it("round-trips a hand-formatted settings.json byte-for-byte through install and uninstall", () => {
    const settingsPath = join(home, ".claude", "settings.json");
    seed(settingsPath, FOUR_SPACE_SETTINGS);

    claudeCode.install({ root, homeDir: home, user: true });
    claudeCode.uninstall({ root, homeDir: home, user: true });

    expect(read(settingsPath)).toBe(FOUR_SPACE_SETTINGS);
  });

  it("removes the hooks container it created, so a settings.json with no hooks round-trips exactly", () => {
    // The common shape: the user has never written a hook. Install has to create both `hooks` and
    // `hooks.SessionStart`; stopping at the group removal used to leave that husk behind.
    const settingsPath = join(home, ".claude", "settings.json");
    const original = '{\n    "model": "opus",\n    "permissions": {\n        "allow": ["Bash(ls:*)"]\n    }\n}\n';
    seed(settingsPath, original);

    claudeCode.install({ root, homeDir: home, user: true });
    expect(read(settingsPath)).toContain('        "SessionStart": [');

    claudeCode.uninstall({ root, homeDir: home, user: true });
    expect(read(settingsPath)).toBe(original);
  });

  it("keeps a hooks object that still holds another event, dropping only SessionStart", () => {
    const settingsPath = join(home, ".claude", "settings.json");
    const original = '{\n    "hooks": {\n        "PreToolUse": [\n            { "matcher": "Bash" }\n        ]\n    }\n}\n';
    seed(settingsPath, original);

    claudeCode.install({ root, homeDir: home, user: true });
    claudeCode.uninstall({ root, homeDir: home, user: true });

    expect(read(settingsPath)).toBe(original);
  });

  it("keeps a tab-indented settings.json on tabs", () => {
    const settingsPath = join(home, ".claude", "settings.json");
    const tabbed = '{\n\t"model": "opus",\n\t"hooks": {\n\t\t"SessionStart": []\n\t}\n}\n';
    seed(settingsPath, tabbed);

    claudeCode.install({ root, homeDir: home, user: true });

    const after = read(settingsPath);
    expect(after).toContain('\t"model": "opus",');
    expect(after).toMatch(/\n\t{3}\{/u);
    expect(after).not.toMatch(/\n {2}"/u);
    expect(JSON.parse(after).hooks.SessionStart).toHaveLength(1);
  });

  it("leaves a user's single-line keybinding entry exactly as written", () => {
    const keybindingsPath = join(vscodeUserDir(home), "keybindings.json");
    const original = [
      "// my own bindings",
      "[",
      '    { "key": "ctrl+q", "command": "noop" }',
      "]",
      "",
    ].join("\n");
    seed(keybindingsPath, original);

    copilotVscode.install({ root, homeDir: home });

    const after = read(keybindingsPath);
    expect(after).toContain('    { "key": "ctrl+q", "command": "noop" }');
    expect(after).toContain("// my own bindings");
    expect(after).not.toContain('"key": "ctrl+q",\n');

    copilotVscode.uninstall({ root, homeDir: home });
    expect(read(keybindingsPath)).toBe(original);
  });

  it("leaves a user's own task and its comments alone in a 4-space tasks.json", () => {
    const tasksPath = join(root, ".vscode", "tasks.json");
    const original = [
      "{",
      '    "version": "2.0.0",',
      "    // do not reformat me",
      '    "tasks": [',
      '        { "label": "Build", "type": "shell", "command": "make" }',
      "    ]",
      "}",
      "",
    ].join("\n");
    seed(tasksPath, original);

    copilotVscode.install({ root, homeDir: home });

    const after = read(tasksPath);
    expect(after).toContain("// do not reformat me");
    expect(after).toContain('        { "label": "Build", "type": "shell", "command": "make" }');
    expect(after).toContain('    "version": "2.0.0",');

    // Byte-identical, including the `"inputs"` key install had to create and the comment above the
    // user's task -- uninstall prunes the array it emptied rather than leaving `"inputs": []`.
    copilotVscode.uninstall({ root, homeDir: home });
    expect(read(tasksPath)).toBe(original);
  });
});

// ─────────────────────────────────────────────────────────────────────────── CRLF-authored config files ───────────────────────────────────────────────────────────────────────────

/**
 * Every string this module generates is written with LF, but the files it edits belong to the user
 * and on Windows are routinely CRLF -- that is the editor default, not an exotic case. Appending LF
 * text to a CRLF file leaves it with mixed endings, and worse, the blank-line separator `install`
 * inserts then no longer matches on the way out, so `uninstall` leaves a growing gap behind instead
 * of restoring the file byte-for-byte as it advertises.
 *
 * These tests pin the file's own ending as the one mem writes in. They assert on exact bytes rather
 * than on parsed structure, because the whole failure mode is invisible to a parser.
 */
describe("regression: config files authored with CRLF stay CRLF", () => {
  const CRLF_MD = "# Project notes\r\n\r\nExisting guidance the user wrote.\r\n";

  /** Counts LF line endings not preceded by CR -- i.e. lines mem wrote in the wrong ending. */
  function lfOnlyLineCount(content: string): number {
    return (content.match(/(?<!\r)\n/gu) ?? []).length;
  }

  it("does not mix LF lines into a CRLF CLAUDE.md on install", () => {
    const path = join(root, "CLAUDE.md");
    seed(path, CRLF_MD);
    claudeCode.install({ root, homeDir: home });

    const after = read(path);
    expect(after).toContain("token-goat-mem:claude-code:start");
    expect(lfOnlyLineCount(after)).toBe(0);
  });

  it("restores a CRLF CLAUDE.md byte-for-byte on uninstall", () => {
    const path = join(root, "CLAUDE.md");
    seed(path, CRLF_MD);
    claudeCode.install({ root, homeDir: home });
    claudeCode.uninstall({ root, homeDir: home });

    expect(read(path)).toBe(CRLF_MD);
  });

  it("restores the file when an editor converts an LF-installed block to CRLF before uninstall", () => {
    // The realistic Windows sequence: mem installs into an LF file, the user opens it in an editor
    // whose default ending is CRLF, and the save converts the whole file -- mem's own block and its
    // separator included. Uninstall has to recognise a separator it did not write.
    //
    // Seeded LF on purpose. Seeding CRLF makes the conversion below an identity transform, since
    // install already writes CRLF into a CRLF file, and the test then silently restates the one
    // above it.
    const lfOriginal = CRLF_MD.replace(/\r\n/gu, "\n");
    const path = join(root, "CLAUDE.md");
    seed(path, lfOriginal);
    claudeCode.install({ root, homeDir: home });
    expect(read(path)).not.toContain("\r");

    const converted = read(path).replace(/\r?\n/gu, "\r\n");
    writeFileSync(path, converted, "utf8");
    expect(converted).toContain("\r\n");

    claudeCode.uninstall({ root, homeDir: home });
    expect(read(path)).toBe(CRLF_MD);
  });

  it("restores a CRLF AGENTS.md byte-for-byte through the shared reference-counted block", () => {
    const path = join(root, "AGENTS.md");
    seed(path, CRLF_MD);
    codex.install({ root, homeDir: home });
    expect(lfOnlyLineCount(read(path))).toBe(0);

    codex.uninstall({ root, homeDir: home });
    expect(read(path)).toBe(CRLF_MD);
  });

  it("keeps the shared marker line CRLF when a second tool joins the tools= list", () => {
    // Joining rewrites only the marker line, slicing the rest of the file back on. Slicing from the
    // "\n" rather than the "\r" drops the CR and silently converts that one line to LF.
    const path = join(root, "AGENTS.md");
    seed(path, CRLF_MD);
    codex.install({ root, homeDir: home });
    copilotCli.install({ root, homeDir: home });

    const after = read(path);
    expect(after).toContain("tools=codex,copilot-cli");
    expect(lfOnlyLineCount(after)).toBe(0);
  });

  it("keeps a CRLF .claude/settings.json CRLF when stamping the hook", () => {
    const path = join(root, ".claude", "settings.json");
    seed(path, '{\r\n  "permissions": {\r\n    "allow": []\r\n  }\r\n}\r\n');
    claudeCode.install({ root, homeDir: home });

    const after = read(path);
    expect(JSON.parse(after).hooks.SessionStart).toHaveLength(1);
    expect(lfOnlyLineCount(after)).toBe(0);
  });

  it("restores a file that has no trailing newline", () => {
    // Nothing forces a config file to end in a newline, and the separator install writes has to be
    // removable without knowing whether the original ended in one. Padding the file up to a blank
    // line makes "<text>\n\n" mean either an original "<text>" or an original "<text>\n", and
    // uninstall then has to guess -- it guessed "<text>\n", so an unterminated file silently gained
    // a newline on the first install/uninstall cycle.
    const original = "# Notes\r\nno trailing newline here";
    const path = join(root, "CLAUDE.md");
    seed(path, original);
    claudeCode.install({ root, homeDir: home });
    expect(read(path)).toContain("token-goat-mem:claude-code:start");

    claudeCode.uninstall({ root, homeDir: home });
    expect(read(path)).toBe(original);
  });

  it("restores a whitespace-only file rather than swallowing its contents", () => {
    // Blank-looking is not the same as absent: these bytes are the user's, and install treated any
    // whitespace-only file as an empty one and dropped them.
    const original = "\r\n";
    const path = join(root, "CLAUDE.md");
    seed(path, original);
    claudeCode.install({ root, homeDir: home });
    claudeCode.uninstall({ root, homeDir: home });

    expect(read(path)).toBe(original);
  });

  it("keeps a CRLF keybindings.json CRLF, the other half of the JSONC path", () => {
    const path = join(vscodeUserDir(home), "keybindings.json");
    seed(path, '// my own bindings\r\n[\r\n  { "key": "ctrl+q", "command": "noop" }\r\n]\r\n');
    copilotVscode.install({ root, homeDir: home });

    const after = read(path);
    expect(after).toContain("__token_goat_mem");
    expect(lfOnlyLineCount(after)).toBe(0);
  });

  it("keeps a CRLF tasks.json CRLF when inserting tasks through the JSONC editor", () => {
    // The JSONC path is a surgical edit rather than a reserialize, so a hardcoded LF here lands
    // inside an otherwise-CRLF file and produces mixed endings in the region mem touched.
    const path = join(root, ".vscode", "tasks.json");
    seed(path, '{\r\n  "version": "2.0.0",\r\n  "tasks": [],\r\n  "inputs": []\r\n}\r\n');
    copilotVscode.install({ root, homeDir: home });

    const after = read(path);
    expect(after).toContain("Mem: Recall project facts");
    expect(lfOnlyLineCount(after)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────── markdown doc drift ───────────────────────────────────────────────────────────────────────────

/**
 * The JSON half of this invariant has been covered since 0.2.5, but the helper doing it only ever
 * matched ` ```json ` fences -- so every markdown block mem writes was unwatched, and three drifts
 * accumulated behind it. Each doc's own promise is that it shows what `mem init <tool>` writes, for
 * a user who would rather do it by hand; a doc that shows something else is worse than no doc,
 * because it is confidently wrong.
 *
 * Compared against what `install()` actually writes to disk, not against the source constant: the
 * constant is one input to the written block, and a defect in the wrapping would slip past a
 * constant-to-doc comparison entirely.
 */
describe("regression: integration docs match the markdown mem init actually writes", () => {
  /**
   * The single ```markdown fence in an integration doc -- the block that doc tells a user to paste.
   *
   * Anchored on the fence rather than on a preceding heading, because every one of these blocks
   * *starts* with `## Memory`: a heading-anchored search finds the copy inside the fence and then
   * looks for an opening fence that is already behind it. Asserting the fence is unique also turns
   * a second markdown block into a visible failure rather than a silently unchecked one.
   */
  function soleMarkdownFence(docName: string): string {
    const doc = readFileSync(new URL(`../docs/integrations/${docName}.md`, import.meta.url), "utf8");
    const fences = [...doc.matchAll(/^```markdown\r?\n([\s\S]*?)\r?\n^```/gmu)];
    expect(fences.length, `expected exactly one markdown fence in ${docName}.md`).toBe(1);
    return (fences[0]?.[1] ?? "").replace(/\r\n/gu, "\n").trim();
  }

  /** The body mem wrote between its markers, with the markers themselves stripped. */
  function writtenBlock(path: string, startMarkerPrefix: string, endMarker: string): string {
    const content = read(path).replace(/\r\n/gu, "\n");
    const startIndex = content.indexOf(startMarkerPrefix);
    expect(startIndex, `no start marker in ${path}`).toBeGreaterThanOrEqual(0);
    const afterStart = content.slice(startIndex);
    const bodyStart = afterStart.indexOf("\n") + 1;
    const bodyEnd = afterStart.indexOf(endMarker);
    expect(bodyEnd, `no end marker in ${path}`).toBeGreaterThan(0);
    return afterStart.slice(bodyStart, bodyEnd).trim();
  }

  it("claude-code.md shows the CLAUDE.md block the installer writes", () => {
    claudeCode.install({ root, homeDir: home });
    const written = writtenBlock(
      join(root, "CLAUDE.md"),
      "<!-- token-goat-mem:claude-code:start -->",
      "<!-- token-goat-mem:claude-code:end -->",
    );

    // Drifted: the doc appended an `(e.g. --subject package-manager --value pnpm)` example the
    // installer never writes, while claiming above the fence to show exactly what mem writes.
    expect(soleMarkdownFence("claude-code")).toBe(written);
  });

  it.each(["codex", "copilot-cli", "copilot-vscode"] as const)(
    "%s.md shows the shared AGENTS.md block the installer writes",
    (docName) => {
      codex.install({ root, homeDir: home });
      const written = writtenBlock(join(root, "AGENTS.md"), "<!-- token-goat-mem:start", "<!-- token-goat-mem:end -->");

      // All three tools share one reference-counted AGENTS.md block, so all three docs must show
      // the same text -- and all three had drifted from it identically, opening with "This machine
      // has token-goat-mem installed" where the installer writes "token-goat-mem is installed".
      expect(soleMarkdownFence(docName)).toBe(written);
    },
  );

  it("copilot-vscode.md's walkthrough names the keybindings the installer actually writes", () => {
    copilotVscode.install({ root, homeDir: home });
    const installed = JSON.parse(read(join(vscodeUserDir(home), "keybindings.json"))) as ReadonlyArray<{ key: string }>;
    const doc = readFileSync(new URL("../docs/integrations/copilot-vscode.md", import.meta.url), "utf8");

    // The prose walkthrough is outside every fenced block, so neither the JSON test above nor the
    // markdown one sees it. It told the reader to press Ctrl+Shift+M and Ctrl+Shift+N for four
    // releases after 0.2.4 replaced those bindings -- in the same file whose own keybindings section
    // explains that they were removed for shadowing View: Problems and New Window.
    const walkthrough = doc.slice(doc.indexOf("## Workflow example"));
    expect(walkthrough).not.toBe("");

    for (const { key } of installed) {
      // "ctrl+k m" as written to keybindings.json is "Ctrl+K M" in prose.
      const display = key
        .split(" ")
        .map((chord) => chord.split("+").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("+"))
        .join(" ");
      expect(walkthrough).toContain(display);
    }

    // The superseded pair may still appear in the section that explains why they were dropped, but
    // never in the walkthrough, which is instruction rather than history.
    expect(walkthrough).not.toContain("Ctrl+Shift+M");
    expect(walkthrough).not.toContain("Ctrl+Shift+N");
  });
});
