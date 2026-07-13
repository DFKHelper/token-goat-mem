/**
 * Unit-level tests for src/wiring.ts's install/uninstall/describe behavior across all four tools,
 * plus direct coverage of the low-level building blocks (marker insert/replace/strip, JSON/JSONC
 * stamping, atomic-write retry). Every test uses an isolated `mkdtempSync` fixture for both the
 * project root and the "home" directory -- never the real `~/.claude`, real VS Code config, or real
 * project files.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  claudeCode,
  codex,
  copilotCli,
  copilotVscode,
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

  it("uninstall on a file with nothing stamped is a no-op, not an error", () => {
    const settingsPath = join(root, ".claude", "settings.json");
    const original = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo one" }] }] } };
    seed(settingsPath, `${JSON.stringify(original, null, 2)}\n`);

    const result = claudeCode.uninstall({ root, homeDir: home });
    expect(result.changes.find((c) => c.path === settingsPath)?.action).toBe("noop");
    expect(JSON.parse(read(settingsPath))).toEqual(original);
  });

  it("uninstall on a completely fresh directory is a no-op for every file", () => {
    const result = claudeCode.uninstall({ root, homeDir: home });
    expect(result.changes.every((c) => c.action === "noop")).toBe(true);
  });

  it("takes a .bak snapshot on first write and never overwrites it on a later re-init", () => {
    const settingsPath = join(root, ".claude", "settings.json");
    const original = { hooks: { SessionStart: [] } };
    seed(settingsPath, JSON.stringify(original));

    claudeCode.install({ root, homeDir: home });
    const bakPath = `${settingsPath}.token-goat-mem.bak`;
    expect(JSON.parse(read(bakPath))).toEqual(original);

    // Mutate the live file directly (simulating manual edits) and re-init; the .bak must stay frozen.
    const mutated = JSON.parse(read(settingsPath));
    mutated.extra = "hand-added";
    seed(settingsPath, JSON.stringify(mutated));
    claudeCode.install({ root, homeDir: home });
    expect(JSON.parse(read(bakPath))).toEqual(original);
  });
});

// ─────────────────────────────────────────────────────────────────────────── codex / copilot-cli AGENTS.md shared block ───────────────────────────────────────────────────────────────────────────

describe("codex and copilot-cli wiring (shared, reference-counted AGENTS.md block)", () => {
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

    const keybindingsPath = join(home, "AppData", "Roaming", "Code", "User", "keybindings.json");
    const keybindings = JSON.parse(read(keybindingsPath));
    expect(keybindings).toHaveLength(2);
    expect(keybindings.every((k: { __token_goat_mem?: boolean }) => k.__token_goat_mem === true)).toBe(true);

    expect(read(join(root, "AGENTS.md"))).toContain("<!-- token-goat-mem:copilot-vscode:start -->");
  });

  it("edge case (b): a pre-existing unstamped task sharing mem's label makes install abort with a conflict error, without duplicating or overwriting", () => {
    const tasksPath = join(root, ".vscode", "tasks.json");
    const original = {
      version: "2.0.0",
      tasks: [{ label: "Mem: Recall project facts", type: "shell", command: "echo not-mem" }],
    };
    seed(tasksPath, JSON.stringify(original, null, 2));

    expect(() => copilotVscode.install({ root, homeDir: home })).toThrow(WiringConflictError);
    expect(JSON.parse(read(tasksPath))).toEqual(original);
  });

  it("install is idempotent for tasks.json and keybindings.json", () => {
    copilotVscode.install({ root, homeDir: home });
    const second = copilotVscode.install({ root, homeDir: home });
    expect(second.changes.every((c) => c.action === "noop")).toBe(true);
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
    expect(tasks.inputs).toEqual([]);

    const keybindingsPath = join(home, "AppData", "Roaming", "Code", "User", "keybindings.json");
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
