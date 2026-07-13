/**
 * Automates what docs/integrations/*.md currently ask a human to hand-copy: `install()` writes
 * exactly the config snippets those guides document (Claude Code's `settings.json` hook +
 * `CLAUDE.md` instructions, Codex/Copilot CLI's `AGENTS.md` instructions, Copilot VS Code's
 * `.vscode/tasks.json` + user `keybindings.json` + `AGENTS.md`); `uninstall()` reverses exactly
 * what `install()` wrote, and only that.
 *
 * Two idempotency/authorship mechanisms, chosen per file format:
 *
 * - **Markdown** (`CLAUDE.md`, `AGENTS.md`): the inserted block is wrapped in a per-tool marker
 *   pair, `<!-- token-goat-mem:<tool>:start -->` / `<!-- token-goat-mem:<tool>:end -->` (see
 *   `upsertMarkedBlock`/`stripMarkedBlock`). The marker is namespaced per tool -- not the bare
 *   `token-goat-mem:start/end` a first reading of the design might suggest -- because Codex and
 *   Copilot CLI both write instructions into the *same* `AGENTS.md` file; a shared marker would
 *   mean installing one silently clobbers the other's block on the next `install()`. Install
 *   replaces everything between an existing pair (upgrade in place) or appends a new marked block
 *   at end of file; uninstall strips the marked block plus the one blank-line separator install
 *   adds, leaving everything else untouched.
 * - **JSON/JSONC** (`settings.json` hooks, VS Code `tasks.json`/`keybindings.json`): every object
 *   mem writes is stamped with an inert sentinel key, `__token_goat_mem: true`. Install
 *   upgrades/skips only stamped entries and aborts with `WiringConflictError` if an *unstamped*
 *   entry already occupies the same identity (hook `command`, task `label`, keybinding `key`)
 *   rather than duplicating or silently overwriting hand-written config. Uninstall removes only
 *   stamped entries, so it survives content drift across mem versions (unlike deep-equality
 *   matching against a remembered snapshot).
 *
 * Every write goes through `writeManagedFile`: atomic (temp file + rename), takes a `.bak` snapshot
 * of the pre-existing file on its first-ever write (never overwritten by a later re-init), and
 * re-reads + recomputes once if the file changed underneath the read used to compute the new
 * content.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { applyEdits, modify, parse as parseJsonc, type JSONPath, type ModificationOptions } from "jsonc-parser";

// ─────────────────────────────────────────────────────────────────────────── Public types ───────────────────────────────────────────────────────────────────────────

export interface WiringOpts {
  /** Project root for project-level config (settings.json, tasks.json, AGENTS.md/CLAUDE.md). Default: `process.cwd()`. */
  readonly root?: string;
  /** Write to the tool's user-level config instead of project-level, where the tool has both (currently only Claude Code's `settings.json`). */
  readonly user?: boolean;
  /** Home directory user-level config resolves under. Default: `os.homedir()`; dependency-injected so tests never touch the real home. */
  readonly homeDir?: string;
}

export type WiringFileAction = "create" | "update" | "remove" | "noop";

export interface WiringChange {
  readonly path: string;
  readonly action: WiringFileAction;
  readonly detail: string;
}

export interface WiringResult {
  readonly changes: readonly WiringChange[];
}

export interface WiringPlanEntry {
  readonly path: string;
  readonly installAction: "create" | "update" | "noop";
  readonly uninstallAction: "remove" | "noop";
  readonly detail: string;
}

export interface WiringPlan {
  readonly entries: readonly WiringPlanEntry[];
}

export interface ToolWiring {
  install(opts?: WiringOpts): WiringResult;
  uninstall(opts?: WiringOpts): WiringResult;
  describe(opts?: WiringOpts): WiringPlan;
}

/** Thrown when an unstamped, hand-written entry already occupies the identity mem's install would write (same hook command / task label / keybinding key). Install refuses to duplicate or overwrite it. */
export class WiringConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WiringConflictError";
  }
}

// ─────────────────────────────────────────────────────────────────────────── Atomic file write + backup ───────────────────────────────────────────────────────────────────────────

/** A pure content transform for one managed file: given current content (`undefined` if the file doesn't exist), returns the next content, or the same value / `undefined` to mean "nothing to do". May throw `WiringConflictError`. */
type FileTransform = (current: string | undefined) => string | undefined;

interface FileOp {
  readonly path: string;
  readonly transform: FileTransform;
}

function backupIfNeeded(filePath: string): void {
  const bakPath = `${filePath}.token-goat-mem.bak`;
  if (!existsSync(bakPath)) {
    copyFileSync(filePath, bakPath);
  }
}

/** Writes the result of `op.transform` to `op.path` atomically (temp file + rename), taking a one-time `.bak` snapshot before the first write and retrying the transform once if the file changed between the initial read and the pre-write check. Exported for direct unit testing of the retry path. */
export function writeManagedFile(op: FileOp): WiringChange {
  let before = existsSync(op.path) ? readFileSync(op.path, "utf8") : undefined;
  let after = op.transform(before);
  if (after === undefined || after === before) {
    return { path: op.path, action: "noop", detail: "already up to date" };
  }

  if (before !== undefined) {
    backupIfNeeded(op.path);
  }

  // Re-check immediately before writing: if the file changed underneath us since the read above,
  // re-read and recompute once against the fresh content before writing.
  const recheck = existsSync(op.path) ? readFileSync(op.path, "utf8") : undefined;
  if (recheck !== before) {
    before = recheck;
    after = op.transform(before);
    if (after === undefined || after === before) {
      return { path: op.path, action: "noop", detail: "already up to date" };
    }
  }

  const existedBefore = before !== undefined;
  mkdirSync(dirname(op.path), { recursive: true });
  const tmpPath = `${op.path}.token-goat-mem.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, after, "utf8");
  renameSync(tmpPath, op.path);
  return {
    path: op.path,
    action: existedBefore ? "update" : "create",
    detail: existedBefore ? "updated existing file" : "created new file",
  };
}

// ─────────────────────────────────────────────────────────────────────────── Managed-file orchestration ───────────────────────────────────────────────────────────────────────────

interface ManagedFile {
  readonly path: string;
  readonly install: FileTransform;
  readonly uninstall: FileTransform;
}

function runInstall(files: readonly ManagedFile[]): WiringResult {
  return { changes: files.map((file) => writeManagedFile({ path: file.path, transform: file.install })) };
}

function runUninstall(files: readonly ManagedFile[]): WiringResult {
  return { changes: files.map((file) => writeManagedFile({ path: file.path, transform: file.uninstall })) };
}

function runDescribe(files: readonly ManagedFile[]): WiringPlan {
  const entries = files.map((file): WiringPlanEntry => {
    const current = existsSync(file.path) ? readFileSync(file.path, "utf8") : undefined;

    const installNext = file.install(current);
    const installAction: WiringPlanEntry["installAction"] =
      installNext === undefined || installNext === current ? "noop" : current === undefined ? "create" : "update";

    const uninstallNext = file.uninstall(current);
    const uninstallAction: WiringPlanEntry["uninstallAction"] = uninstallNext === undefined || uninstallNext === current ? "noop" : "remove";

    const detail =
      installAction !== "noop"
        ? `install would ${installAction} this file`
        : uninstallAction !== "noop"
          ? "already installed; uninstall would strip mem's content"
          : current === undefined
            ? "not installed"
            : "up to date; nothing to remove";

    return { path: file.path, installAction, uninstallAction, detail };
  });
  return { entries };
}

function resolveWiringOpts(opts: WiringOpts | undefined): { root: string; homeDir: string; user: boolean } {
  return {
    root: resolvePath(opts?.root ?? process.cwd()),
    homeDir: opts?.homeDir ?? homedir(),
    user: opts?.user === true,
  };
}

function makeToolWiring(filesFor: (resolved: { root: string; homeDir: string; user: boolean }) => readonly ManagedFile[]): ToolWiring {
  return {
    install(opts) {
      return runInstall(filesFor(resolveWiringOpts(opts)));
    },
    uninstall(opts) {
      return runUninstall(filesFor(resolveWiringOpts(opts)));
    },
    describe(opts) {
      return runDescribe(filesFor(resolveWiringOpts(opts)));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────── Markdown marker blocks ───────────────────────────────────────────────────────────────────────────

function markerStart(tool: string): string {
  return `<!-- token-goat-mem:${tool}:start -->`;
}

function markerEnd(tool: string): string {
  return `<!-- token-goat-mem:${tool}:end -->`;
}

/** Inserts/replaces a tool-namespaced marked block. Replaces everything between an existing marker pair in place (upgrade); otherwise appends a new marked block at end of file, separated from any existing content by exactly one blank line. */
function upsertMarkedBlock(content: string, tool: string, body: string): string {
  const start = markerStart(tool);
  const end = markerEnd(tool);
  const block = `${start}\n${body.trim()}\n${end}`;

  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return content.slice(0, startIdx) + block + content.slice(endIdx + end.length);
  }

  if (content.trim().length === 0) {
    return `${block}\n`;
  }
  const base = content.endsWith("\n") ? content : `${content}\n`;
  return `${base}\n${block}\n`;
}

/** Strips a tool-namespaced marked block plus the one blank-line separator `upsertMarkedBlock` adds, leaving the rest of the file untouched. No-op (returns `content` unchanged) if the marker pair isn't present. */
function stripMarkedBlock(content: string, tool: string): string {
  const start = markerStart(tool);
  const end = markerEnd(tool);
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return content;
  }
  const blockEnd = endIdx + end.length;
  const before = content.slice(0, startIdx);
  const after = content.slice(blockEnd);
  const beforeStripped = before.endsWith("\n\n") ? before.slice(0, -1) : before;
  const afterStripped = after.startsWith("\n") ? after.slice(1) : after;
  return `${beforeStripped}${afterStripped}`;
}

function markdownFile(path: string, tool: string, body: string): ManagedFile {
  return {
    path,
    install: (current) => upsertMarkedBlock(current ?? "", tool, body),
    uninstall: (current) => (current === undefined ? undefined : stripMarkedBlock(current, tool)),
  };
}

// ─────────────────────────────────────────────────────────────────────────── JSON stamping helpers ───────────────────────────────────────────────────────────────────────────

const STAMP_KEY = "__token_goat_mem";

function isStamped(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as Record<string, unknown>)[STAMP_KEY] === true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((value, index) => deepEqual(value, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).sort();
  const bKeys = Object.keys(bRecord).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) {
    return false;
  }
  return aKeys.every((key) => deepEqual(aRecord[key], bRecord[key]));
}

function parseJsonOrConflict(current: string, label: string): unknown {
  try {
    return JSON.parse(current) as unknown;
  } catch {
    throw new WiringConflictError(`${label} is not valid JSON; refusing to modify a hand-edited config`);
  }
}

// ─────────────────────────────────────────────────────────────────────────── Claude Code: settings.json hook ───────────────────────────────────────────────────────────────────────────

const CLAUDE_HOOK_COMMAND = 'mem recall --hint-format --root "$CLAUDE_PROJECT_DIR"';

interface ClaudeHook {
  readonly type: string;
  readonly command: string;
  readonly [STAMP_KEY]?: boolean;
}

interface ClaudeHookGroup {
  readonly hooks?: ClaudeHook[];
  readonly [key: string]: unknown;
}

interface ClaudeSettings {
  hooks?: { SessionStart?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

function installClaudeSettings(current: string | undefined, path: string): string | undefined {
  const parsed: ClaudeSettings = current === undefined ? {} : (parseJsonOrConflict(current, path) as ClaudeSettings);
  if (parsed.hooks === undefined) {
    parsed.hooks = {};
  }
  if (parsed.hooks.SessionStart === undefined) {
    parsed.hooks.SessionStart = [];
  }
  if (!Array.isArray(parsed.hooks.SessionStart)) {
    throw new WiringConflictError(`hooks.SessionStart in ${path} is not an array; refusing to modify a hand-edited config`);
  }
  const sessionStart = parsed.hooks.SessionStart as ClaudeHookGroup[];

  let stampedHook: ClaudeHook | undefined;
  for (const group of sessionStart) {
    const found = (group.hooks ?? []).find((hook) => isStamped(hook));
    if (found !== undefined) {
      stampedHook = found;
      break;
    }
  }

  const hasUnstampedConflict = sessionStart.some((group) =>
    (group.hooks ?? []).some((hook) => !isStamped(hook) && hook.command === CLAUDE_HOOK_COMMAND)
  );
  if (hasUnstampedConflict && stampedHook === undefined) {
    throw new WiringConflictError(`a SessionStart hook with command "${CLAUDE_HOOK_COMMAND}" already exists in ${path} and was not created by mem; refusing to duplicate it`);
  }

  if (stampedHook !== undefined) {
    if (stampedHook.type === "command" && stampedHook.command === CLAUDE_HOOK_COMMAND) {
      return current;
    }
    (stampedHook as { type: string; command: string }).type = "command";
    (stampedHook as { type: string; command: string }).command = CLAUDE_HOOK_COMMAND;
  } else {
    sessionStart.push({ hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND, [STAMP_KEY]: true }] });
  }

  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function uninstallClaudeSettings(current: string | undefined, path: string): string | undefined {
  if (current === undefined) {
    return undefined;
  }
  const parsed = parseJsonOrConflict(current, path) as ClaudeSettings;
  const sessionStart = parsed.hooks?.SessionStart;
  if (!Array.isArray(sessionStart)) {
    return current;
  }

  let changed = false;
  const filtered: ClaudeHookGroup[] = [];
  for (const group of sessionStart as ClaudeHookGroup[]) {
    const hooks = group.hooks;
    if (!Array.isArray(hooks) || !hooks.some((hook) => isStamped(hook))) {
      filtered.push(group);
      continue;
    }
    changed = true;
    const remaining = hooks.filter((hook) => !isStamped(hook));
    if (remaining.length > 0) {
      filtered.push({ ...group, hooks: remaining });
    }
    // else: this group was entirely mem's addition -- drop it whole.
  }

  if (!changed) {
    return current;
  }
  if (parsed.hooks !== undefined) {
    parsed.hooks.SessionStart = filtered;
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

// ─────────────────────────────────────────────────────────────────────────── Copilot VS Code: tasks.json / keybindings.json (JSONC) ───────────────────────────────────────────────────────────────────────────

const JSONC_FORMAT: ModificationOptions = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };

const VSCODE_TASKS: ReadonlyArray<Record<string, unknown>> = [
  {
    label: "Mem: Recall project facts",
    type: "shell",
    command: "mem",
    args: ["recall", "--hint-format", "--root", "${workspaceFolder}"],
    presentation: { reveal: "always" },
    [STAMP_KEY]: true,
  },
  {
    label: "Mem: Remember a preference",
    type: "shell",
    command: "mem",
    args: ["remember", "${input:factText}", "--kind", "preference", "--scope", "project", "--root", "${workspaceFolder}"],
    presentation: { reveal: "always" },
    [STAMP_KEY]: true,
  },
  {
    label: "Mem: Review facts",
    type: "shell",
    command: "mem",
    args: ["review", "--root", "${workspaceFolder}"],
    presentation: { reveal: "always" },
    [STAMP_KEY]: true,
  },
];

const VSCODE_INPUT: Record<string, unknown> = {
  id: "factText",
  type: "promptString",
  description: "Fact to remember",
  [STAMP_KEY]: true,
};

function findIndexByKey(items: readonly unknown[], key: string, value: unknown): number {
  return items.findIndex((item) => typeof item === "object" && item !== null && (item as Record<string, unknown>)[key] === value);
}

/** Upserts each entry in `wanted` (identified by `identityKey`) into the array at `arrayPath` within `text`, appending new entries, upgrading stamped ones in place, and throwing `WiringConflictError` on an unstamped identity collision. Returns the updated text. */
function upsertJsoncArrayEntries(
  text: string,
  arrayPath: JSONPath,
  existing: readonly unknown[],
  wanted: readonly Record<string, unknown>[],
  identityKey: string,
  path: string,
  kindLabel: string
): string {
  let result = text;
  for (const entry of wanted) {
    const identity = entry[identityKey];
    const idx = findIndexByKey(existing, identityKey, identity);
    if (idx === -1) {
      result = applyEdits(result, modify(result, [...arrayPath, -1], entry, JSONC_FORMAT));
      continue;
    }
    const found = existing[idx];
    if (!isStamped(found)) {
      throw new WiringConflictError(`a ${kindLabel} with ${identityKey}=${JSON.stringify(identity)} already exists in ${path} and was not created by mem; refusing to duplicate or overwrite it`);
    }
    if (!deepEqual(found, entry)) {
      result = applyEdits(result, modify(result, [...arrayPath, idx], entry, JSONC_FORMAT));
    }
  }
  return result;
}

/** Removes every stamped entry from the array at `arrayPath`, in descending index order so earlier removals never shift the index of a later one. Returns the updated text, or `text` unchanged if nothing was stamped. */
function removeStampedJsoncArrayEntries(text: string, arrayPath: JSONPath, existing: readonly unknown[]): { text: string; changed: boolean } {
  const stampedIndices = existing
    .map((item, index) => (isStamped(item) ? index : -1))
    .filter((index) => index !== -1)
    .sort((a, b) => b - a);
  if (stampedIndices.length === 0) {
    return { text, changed: false };
  }
  let result = text;
  for (const idx of stampedIndices) {
    result = applyEdits(result, modify(result, [...arrayPath, idx], undefined, JSONC_FORMAT));
  }
  return { text: result, changed: true };
}

function parseJsoncOrConflict(current: string, path: string): unknown {
  const errors: import("jsonc-parser").ParseError[] = [];
  const parsed: unknown = parseJsonc(current, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new WiringConflictError(`${path} is not valid JSON/JSONC; refusing to modify a hand-edited config`);
  }
  return parsed;
}

function installTasksJson(current: string | undefined, path: string): string | undefined {
  let text = current ?? "{\n  \"version\": \"2.0.0\",\n  \"tasks\": [],\n  \"inputs\": []\n}\n";
  const parsed = current === undefined ? {} : ((parseJsoncOrConflict(current, path) as Record<string, unknown>) ?? {});

  if (typeof parsed["version"] !== "string") {
    text = applyEdits(text, modify(text, ["version"], "2.0.0", JSONC_FORMAT));
  }

  const tasks = Array.isArray(parsed["tasks"]) ? (parsed["tasks"] as unknown[]) : [];
  text = upsertJsoncArrayEntries(text, ["tasks"], tasks, VSCODE_TASKS, "label", path, "task");

  const inputs = Array.isArray(parsed["inputs"]) ? (parsed["inputs"] as unknown[]) : [];
  text = upsertJsoncArrayEntries(text, ["inputs"], inputs, [VSCODE_INPUT], "id", path, "input");

  return text === current ? current : text;
}

function uninstallTasksJson(current: string | undefined, path: string): string | undefined {
  if (current === undefined) {
    return undefined;
  }
  const parsed = (parseJsoncOrConflict(current, path) as Record<string, unknown>) ?? {};
  let text = current;
  let anyChanged = false;

  const tasks = Array.isArray(parsed["tasks"]) ? (parsed["tasks"] as unknown[]) : [];
  const tasksResult = removeStampedJsoncArrayEntries(text, ["tasks"], tasks);
  text = tasksResult.text;
  anyChanged = anyChanged || tasksResult.changed;

  const reparsed = (parseJsoncOrConflict(text, path) as Record<string, unknown>) ?? {};
  const inputs = Array.isArray(reparsed["inputs"]) ? (reparsed["inputs"] as unknown[]) : [];
  const inputsResult = removeStampedJsoncArrayEntries(text, ["inputs"], inputs);
  text = inputsResult.text;
  anyChanged = anyChanged || inputsResult.changed;

  return anyChanged ? text : current;
}

const VSCODE_KEYBINDINGS: ReadonlyArray<Record<string, unknown>> = [
  {
    key: "ctrl+shift+m",
    command: "workbench.action.terminal.sendSequence",
    args: { text: "mem recall --hint-format --root .\r" },
    [STAMP_KEY]: true,
  },
  {
    key: "ctrl+shift+n",
    command: "workbench.action.terminal.sendSequence",
    args: { text: 'mem remember "" --kind preference ' },
    [STAMP_KEY]: true,
  },
];

function installKeybindings(current: string | undefined, path: string): string | undefined {
  const text = current ?? "[]\n";
  const parsed = current === undefined ? [] : ((parseJsoncOrConflict(current, path) as unknown[]) ?? []);
  if (!Array.isArray(parsed) && current !== undefined) {
    throw new WiringConflictError(`${path} does not contain a JSON array; refusing to modify a hand-edited config`);
  }
  const existing = Array.isArray(parsed) ? parsed : [];
  const next = upsertJsoncArrayEntries(text, [], existing, VSCODE_KEYBINDINGS, "key", path, "keybinding");
  return next === current ? current : next;
}

function uninstallKeybindings(current: string | undefined, path: string): string | undefined {
  if (current === undefined) {
    return undefined;
  }
  const parsed = parseJsoncOrConflict(current, path);
  const existing = Array.isArray(parsed) ? parsed : [];
  const { text, changed } = removeStampedJsoncArrayEntries(current, [], existing);
  return changed ? text : current;
}

// ─────────────────────────────────────────────────────────────────────────── Tool definitions ───────────────────────────────────────────────────────────────────────────

const CLAUDE_CODE_CLAUDE_MD_BODY = `## Memory

This machine has token-goat-mem installed. When I state a durable preference,
decision, or correction, persist it:
\`mem remember "<short fact>" --kind preference|decision|fact|correction --scope project --root .\`
Use --subject/--value for anything that can be contradicted later
(e.g. --subject package-manager --value pnpm).`;

const CODEX_AGENTS_MD_BODY = `## Memory

This machine has token-goat-mem installed (\`mem\` on PATH).

- Before analysis, run \`mem recall --hint-format --root .\` and honor each
  line's embedded trust caveat ("verify", "unverified", "contradicted, excluded").
- When a review reaches a durable decision, persist it:
  \`mem remember "<short fact>" --kind decision --scope project --root .\``;

const COPILOT_CLI_AGENTS_MD_BODY = `## Memory

This machine has token-goat-mem installed (\`mem\` on PATH).

- At the start of a task, run \`mem recall --hint-format --root .\` and treat
  each returned line's \`display\` string as a prior fact, honoring its
  embedded trust caveat ("verify", "unverified", "contradicted, excluded").
- When the user states a durable preference, decision, or correction, persist
  it: \`mem remember "<short fact>" --kind preference|decision|fact|correction
  --scope project --root .\`. Use --subject/--value for anything that can be
  contradicted later.`;

const COPILOT_VSCODE_AGENTS_MD_BODY = `## Memory

token-goat-mem is installed (\`mem\` on PATH).
- \`mem recall --hint-format --root .\` — retrieve prior facts with trust caveats
- \`mem remember "<fact>" --kind preference|decision|fact|correction --scope project --root .\` — persist new facts
- \`mem review --root .\` — audit facts and contradictions`;

/** VS Code's per-user config directory. Derived purely from the (dependency-injected) `homeDir`, never the real `%APPDATA%`/`$HOME` env vars, so tests stay fully isolated regardless of platform. */
function vscodeUserDir(homeDir: string): string {
  switch (process.platform) {
    case "win32":
      return join(homeDir, "AppData", "Roaming", "Code", "User");
    case "darwin":
      return join(homeDir, "Library", "Application Support", "Code", "User");
    default:
      return join(homeDir, ".config", "Code", "User");
  }
}

export const claudeCode: ToolWiring = makeToolWiring(({ root, homeDir, user }) => {
  const settingsPath = user ? join(homeDir, ".claude", "settings.json") : join(root, ".claude", "settings.json");
  const claudeMdPath = join(root, "CLAUDE.md");
  return [
    { path: settingsPath, install: (current) => installClaudeSettings(current, settingsPath), uninstall: (current) => uninstallClaudeSettings(current, settingsPath) },
    markdownFile(claudeMdPath, "claude-code", CLAUDE_CODE_CLAUDE_MD_BODY),
  ];
});

export const codex: ToolWiring = makeToolWiring(({ root }) => {
  const agentsMdPath = join(root, "AGENTS.md");
  return [markdownFile(agentsMdPath, "codex", CODEX_AGENTS_MD_BODY)];
});

export const copilotCli: ToolWiring = makeToolWiring(({ root }) => {
  const agentsMdPath = join(root, "AGENTS.md");
  return [markdownFile(agentsMdPath, "copilot-cli", COPILOT_CLI_AGENTS_MD_BODY)];
});

export const copilotVscode: ToolWiring = makeToolWiring(({ root, homeDir }) => {
  const tasksPath = join(root, ".vscode", "tasks.json");
  const keybindingsPath = join(vscodeUserDir(homeDir), "keybindings.json");
  const agentsMdPath = join(root, "AGENTS.md");
  return [
    { path: tasksPath, install: (current) => installTasksJson(current, tasksPath), uninstall: (current) => uninstallTasksJson(current, tasksPath) },
    { path: keybindingsPath, install: (current) => installKeybindings(current, keybindingsPath), uninstall: (current) => uninstallKeybindings(current, keybindingsPath) },
    markdownFile(agentsMdPath, "copilot-vscode", COPILOT_VSCODE_AGENTS_MD_BODY),
  ];
});

export const TOOL_NAMES = ["claude-code", "codex", "copilot-cli", "copilot-vscode"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function getToolWiring(name: ToolName): ToolWiring {
  switch (name) {
    case "claude-code":
      return claudeCode;
    case "codex":
      return codex;
    case "copilot-cli":
      return copilotCli;
    case "copilot-vscode":
      return copilotVscode;
  }
}
