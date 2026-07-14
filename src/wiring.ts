/**
 * Automates what docs/integrations/*.md currently ask a human to hand-copy: `install()` writes
 * exactly the config snippets those guides document (Claude Code's `settings.json` hook +
 * `CLAUDE.md` instructions, Codex/Copilot CLI's `AGENTS.md` instructions, Copilot VS Code's
 * `.vscode/tasks.json` + user `keybindings.json` + `AGENTS.md`); `uninstall()` reverses exactly
 * what `install()` wrote, and only that.
 *
 * Two idempotency/authorship mechanisms, chosen per file format:
 *
 * - **Markdown, single-owner file** (`CLAUDE.md`, written only by `claude-code`): the inserted block
 *   is wrapped in a per-tool marker pair, `<!-- token-goat-mem:<tool>:start -->` /
 *   `<!-- token-goat-mem:<tool>:end -->` (see `upsertMarkedBlock`/`stripMarkedBlock`). Install
 *   replaces everything between an existing pair (upgrade in place) or appends a new marked block at
 *   end of file; uninstall strips the marked block plus the one blank-line separator install adds,
 *   leaving everything else untouched.
 * - **Markdown, shared file** (`AGENTS.md` for `codex`, `copilot-cli`, and `copilot-vscode`): all
 *   three tools want the same "## Memory" prose in the same file, so instead of near-duplicate
 *   per-tool blocks they share one reference-counted block,
 *   `<!-- token-goat-mem:start tools=<sorted,deduped,csv> -->` / `<!-- token-goat-mem:end -->` (see
 *   `upsertSharedMarkedBlock`/`stripSharedMarkedBlock`). Install creates the block on the first tool
 *   to install and just adds each subsequent tool's name to the `tools=` list (rewriting only the
 *   marker line); the block body is written once and never touched again by a later tool's install.
 *   Uninstall drops a tool from the `tools=` list (rewriting only the marker line) while any other
 *   tool remains listed, and only removes the whole block once the last listed tool uninstalls.
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
  /**
   * Optional override for describe()'s per-entry `detail` string, consulted with the same `current`
   * content (plus the already-computed install/uninstall actions) used to build the generic
   * "install would create/update this file" / "already installed; uninstall would strip mem's
   * content" wording. Returns `undefined` to fall back to that generic wording. Used by the shared
   * AGENTS.md block (see `sharedMarkdownFile`) to distinguish "join existing shared block" from
   * "create new block", and "leave shared block in place, drop <tool> from tools=" from "remove
   * shared block entirely".
   */
  readonly describeDetail?: (current: string | undefined, installAction: WiringFileAction, uninstallAction: WiringFileAction) => string | undefined;
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

    const defaultDetail =
      installAction !== "noop"
        ? `install would ${installAction} this file`
        : uninstallAction !== "noop"
          ? "already installed; uninstall would strip mem's content"
          : current === undefined
            ? "not installed"
            : "up to date; nothing to remove";
    const detail = file.describeDetail?.(current, installAction, uninstallAction) ?? defaultDetail;

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

/** Appends `block` to `content`, separated from any existing content by exactly one blank line. If `content` is blank (absent or whitespace-only), writes just the block (no leading separator). Shared by both the per-tool and reference-counted shared marker implementations. */
function appendBlock(content: string, block: string): string {
  if (content.trim().length === 0) {
    return `${block}\n`;
  }
  const base = content.endsWith("\n") ? content : `${content}\n`;
  return `${base}\n${block}\n`;
}

/** Removes the `[startIdx, blockEnd)` slice of `content` plus the one blank-line separator `appendBlock` adds, leaving the rest of the file untouched. Shared by both the per-tool and reference-counted shared marker implementations. */
function stripBlockSeparators(content: string, startIdx: number, blockEnd: number): string {
  const before = content.slice(0, startIdx);
  const after = content.slice(blockEnd);
  const beforeStripped = before.endsWith("\n\n") ? before.slice(0, -1) : before;
  const afterStripped = after.startsWith("\n") ? after.slice(1) : after;
  return `${beforeStripped}${afterStripped}`;
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

  return appendBlock(content, block);
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
  return stripBlockSeparators(content, startIdx, blockEnd);
}

function markdownFile(path: string, tool: string, body: string): ManagedFile {
  return {
    path,
    install: (current) => upsertMarkedBlock(current ?? "", tool, body),
    uninstall: (current) => (current === undefined ? undefined : stripMarkedBlock(current, tool)),
  };
}

// ─────────────────────────────────────────────────────────────────────────── Markdown shared, reference-counted marker block ───────────────────────────────────────────────────────────────────────────

const SHARED_BLOCK_START_RE = /<!-- token-goat-mem:start tools=([a-z0-9,-]+) -->/g;
const SHARED_BLOCK_END = "<!-- token-goat-mem:end -->";

/** Sorted, deduplicated, comma-joined `tools=` attribute value, for deterministic marker output (and thus deterministic tests/diffs) regardless of install order. */
function sortedToolsAttr(tools: readonly string[]): string {
  return Array.from(new Set(tools)).sort().join(",");
}

function sharedMarkerStart(tools: readonly string[]): string {
  return `<!-- token-goat-mem:start tools=${sortedToolsAttr(tools)} -->`;
}

interface SharedBlockLocation {
  readonly startIdx: number;
  readonly startLineEndIdx: number;
  readonly endIdx: number;
  readonly tools: readonly string[];
}

/**
 * Locates the shared marker block (if any) and parses its `tools=` list. `startLineEndIdx` is the
 * index of the newline terminating the start-marker line, used to rewrite just that line without
 * touching the body.
 *
 * Scans *every* `start` marker occurrence (not just the first) and returns the first one that
 * resolves to a complete block (a matching `end` marker somewhere after it). This matters because a
 * hand-edit, crashed write, or merge conflict can leave an orphaned/malformed start marker with no
 * end marker earlier in the file; stopping at the first occurrence (as a non-global regex would)
 * would make every later install/uninstall permanently blind to a perfectly valid block further
 * down -- installs would keep appending duplicate blocks, and uninstall could never find the real
 * one to strip.
 */
function findSharedBlock(content: string): SharedBlockLocation | undefined {
  SHARED_BLOCK_START_RE.lastIndex = 0;
  const starts: Array<{ index: number; tools: readonly string[] }> = [];
  let match: RegExpExecArray | null;
  while ((match = SHARED_BLOCK_START_RE.exec(content)) !== null) {
    starts.push({ index: match.index, tools: (match[1] ?? "").split(",").filter((t) => t.length > 0) });
  }

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    if (start === undefined) {
      continue;
    }
    const startIdx = start.index;
    const startLineEndIdx = content.indexOf("\n", startIdx);
    const endIdx = startLineEndIdx === -1 ? -1 : content.indexOf(SHARED_BLOCK_END, startLineEndIdx);
    if (startLineEndIdx === -1 || endIdx === -1) {
      continue;
    }
    // A block can't legitimately contain another block's start marker: if one does, the `end` found
    // above doesn't actually belong to this `start` (it belongs to the later block), so this `start`
    // is orphaned/malformed. Skip it and let the next candidate resolve against its own end marker.
    const nextStart = starts[i + 1];
    if (nextStart !== undefined && nextStart.index < endIdx) {
      continue;
    }
    return { startIdx, startLineEndIdx, endIdx, tools: start.tools };
  }
  return undefined;
}

/**
 * Inserts/joins/upgrades the single reference-counted shared block used by tools that write the
 * same "## Memory" prose into the same file (currently `codex`, `copilot-cli`, and `copilot-vscode`,
 * all targeting `AGENTS.md`). If no block exists yet, creates one with `tools=<thisTool>` and `body`. If a block
 * exists and `thisTool` is already listed, no-op. If a block exists and `thisTool` isn't listed,
 * adds it to the (sorted) `tools=` list by rewriting only the marker line -- the body, already
 * shared and correct, is left untouched.
 */
function upsertSharedMarkedBlock(content: string, tool: string, body: string): string {
  const found = findSharedBlock(content);
  if (found !== undefined) {
    if (found.tools.includes(tool)) {
      return content;
    }
    const newStartLine = sharedMarkerStart([...found.tools, tool]);
    return content.slice(0, found.startIdx) + newStartLine + content.slice(found.startLineEndIdx);
  }

  const block = `${sharedMarkerStart([tool])}\n${body.trim()}\n${SHARED_BLOCK_END}`;
  return appendBlock(content, block);
}

/**
 * Removes `thisTool` from the shared block's `tools=` list. If other tools remain listed, rewrites
 * only the marker line and leaves the block body in place. If `thisTool` was the only tool listed,
 * removes the whole block plus the one blank-line separator install adds (same rule as
 * `stripMarkedBlock`). No-op if the block doesn't exist or doesn't list `thisTool`.
 */
function stripSharedMarkedBlock(content: string, tool: string): string {
  const found = findSharedBlock(content);
  if (found === undefined || !found.tools.includes(tool)) {
    return content;
  }

  const remaining = found.tools.filter((t) => t !== tool);
  if (remaining.length > 0) {
    const newStartLine = sharedMarkerStart(remaining);
    return content.slice(0, found.startIdx) + newStartLine + content.slice(found.startLineEndIdx);
  }

  const blockEnd = found.endIdx + SHARED_BLOCK_END.length;
  return stripBlockSeparators(content, found.startIdx, blockEnd);
}

/** describe() detail override for the shared block: distinguishes "join existing shared block" from a plain create/update, and "leave shared block in place, drop <tool>" from "remove shared block entirely". Falls back to the generic wording (`undefined`) whenever no shared block is present yet. */
function describeSharedBlockDetail(tool: string, current: string | undefined, installAction: WiringFileAction, uninstallAction: WiringFileAction): string | undefined {
  const found = current === undefined ? undefined : findSharedBlock(current);
  if (found === undefined) {
    return undefined;
  }
  if (installAction !== "noop") {
    return `install would join existing shared block (adds ${tool} to tools=)`;
  }
  if (uninstallAction !== "noop") {
    const remaining = found.tools.filter((t) => t !== tool);
    return remaining.length > 0
      ? `already installed; uninstall would leave shared block in place, drop ${tool} from tools= (${remaining.join(",")} remains)`
      : "already installed; uninstall would remove shared block entirely";
  }
  return undefined;
}

function sharedMarkdownFile(path: string, tool: string, body: string): ManagedFile {
  return {
    path,
    install: (current) => upsertSharedMarkedBlock(current ?? "", tool, body),
    uninstall: (current) => (current === undefined ? undefined : stripSharedMarkedBlock(current, tool)),
    describeDetail: (current, installAction, uninstallAction) => describeSharedBlockDetail(tool, current, installAction, uninstallAction),
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

/** True for `undefined` (file absent) or a file that exists but contains only whitespace -- neither has any hand-written content that could conflict, so both are treated identically to "start fresh" by every JSON/JSONC entry point below. */
function isBlank(content: string | undefined): boolean {
  return content === undefined || content.trim().length === 0;
}

/** True only for a non-null, non-array object -- i.e. a valid JSON "object" value. Used to guard every `.property` access/assignment on parsed JSON before it happens: JSON.parse legally produces `null`, an array, or a primitive at any level (a hand-edited `{"hooks": null}` or a root of `null`/`5`/`[1,2]` all parse without error), and unguarded property access/assignment on those throws in ES-module strict mode instead of surfacing the intended `WiringConflictError`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const rawParsed: unknown = isBlank(current) ? {} : parseJsonOrConflict(current as string, path);
  if (!isPlainObject(rawParsed)) {
    throw new WiringConflictError(`${path} does not contain a JSON object at its root; refusing to modify a hand-edited config`);
  }
  const parsed = rawParsed as ClaudeSettings;
  if (parsed.hooks !== undefined && !isPlainObject(parsed.hooks)) {
    throw new WiringConflictError(`hooks in ${path} is not an object; refusing to modify a hand-edited config`);
  }
  if (parsed.hooks === undefined) {
    parsed.hooks = {};
  }
  if (parsed.hooks.SessionStart === undefined) {
    parsed.hooks.SessionStart = [];
  }
  if (!Array.isArray(parsed.hooks.SessionStart)) {
    throw new WiringConflictError(`hooks.SessionStart in ${path} is not an array; refusing to modify a hand-edited config`);
  }
  const sessionStart = parsed.hooks.SessionStart as unknown[];

  // Guard every element before touching `.hooks`: a hand-edited SessionStart can legally hold a
  // `null`, a primitive, or a group whose `hooks` isn't an array. Unguarded access below would throw
  // a raw TypeError instead of the documented WiringConflictError contract (same failure class the
  // root/hooks/SessionStart-array checks above already cover, one level deeper).
  for (const group of sessionStart) {
    if (!isPlainObject(group)) {
      throw new WiringConflictError(`hooks.SessionStart in ${path} contains a non-object entry; refusing to modify a hand-edited config`);
    }
    if (group["hooks"] !== undefined && !Array.isArray(group["hooks"])) {
      throw new WiringConflictError(`a hooks.SessionStart entry in ${path} has a non-array "hooks"; refusing to modify a hand-edited config`);
    }
    // Also guard individual hook elements: a hand-edited hooks array may contain null, primitives, or
    // other non-objects. Validate them upfront so later code doesn't crash when accessing .command.
    if (Array.isArray(group["hooks"])) {
      for (const hook of group["hooks"]) {
        if (!isPlainObject(hook)) {
          throw new WiringConflictError(`a hooks.SessionStart entry in ${path} contains a non-object hook element; refusing to modify a hand-edited config`);
        }
      }
    }
  }
  const groups = sessionStart as ClaudeHookGroup[];

  let stampedHook: ClaudeHook | undefined;
  for (const group of groups) {
    const found = (group.hooks ?? []).find((hook) => isStamped(hook));
    if (found !== undefined) {
      stampedHook = found;
      break;
    }
  }

  const hasUnstampedConflict = groups.some((group) =>
    (group.hooks ?? []).some((hook) => isPlainObject(hook) && !isStamped(hook) && hook.command === CLAUDE_HOOK_COMMAND)
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
    groups.push({ hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND, [STAMP_KEY]: true }] });
  }

  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function uninstallClaudeSettings(current: string | undefined, path: string): string | undefined {
  if (isBlank(current)) {
    return undefined;
  }
  const rawParsed: unknown = parseJsonOrConflict(current as string, path);
  if (!isPlainObject(rawParsed)) {
    // Nothing mem could have stamped inside a non-object root; leave it untouched rather than crash.
    return current;
  }
  const parsed = rawParsed as ClaudeSettings;
  const sessionStart = parsed.hooks?.SessionStart;
  if (!Array.isArray(sessionStart)) {
    return current;
  }

  let changed = false;
  const filtered: ClaudeHookGroup[] = [];
  for (const group of sessionStart as unknown[]) {
    // Access `.hooks` only through an isPlainObject guard: a hand-edited SessionStart may hold a
    // `null`/primitive element, and `null.hooks` would throw a raw TypeError. Uninstall stays lenient
    // (leave anything mem didn't stamp untouched) rather than crashing on such an entry.
    const hooks = isPlainObject(group) ? group["hooks"] : undefined;
    if (!Array.isArray(hooks) || !hooks.some((hook) => isStamped(hook))) {
      filtered.push(group as ClaudeHookGroup);
      continue;
    }
    changed = true;
    const remaining = hooks.filter((hook) => !isStamped(hook));
    if (remaining.length > 0) {
      filtered.push({ ...(group as ClaudeHookGroup), hooks: remaining });
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
  let text = isBlank(current) ? "{\n  \"version\": \"2.0.0\",\n  \"tasks\": [],\n  \"inputs\": []\n}\n" : (current as string);
  const rawParsed: unknown = isBlank(current) ? {} : parseJsoncOrConflict(current as string, path);
  if (!isBlank(current) && !isPlainObject(rawParsed)) {
    throw new WiringConflictError(`${path} does not contain a JSON object at its root; refusing to modify a hand-edited config`);
  }
  const parsed = (rawParsed ?? {}) as Record<string, unknown>;

  if (typeof parsed["version"] !== "string") {
    text = applyEdits(text, modify(text, ["version"], "2.0.0", JSONC_FORMAT));
  }

  // A present-but-non-array `tasks`/`inputs` is a hand-edited config mem can't reason about: appending
  // to it via jsonc-parser's `modify(..., [key, -1], ...)` would throw a raw "Can not add property to
  // parent of type ..." Error, not the documented WiringConflictError contract. Reject it explicitly,
  // matching how installClaudeSettings treats a non-array `hooks.SessionStart`. Absent keys stay fine.
  if (parsed["tasks"] !== undefined && !Array.isArray(parsed["tasks"])) {
    throw new WiringConflictError(`"tasks" in ${path} is not an array; refusing to modify a hand-edited config`);
  }
  if (parsed["inputs"] !== undefined && !Array.isArray(parsed["inputs"])) {
    throw new WiringConflictError(`"inputs" in ${path} is not an array; refusing to modify a hand-edited config`);
  }

  const tasks = Array.isArray(parsed["tasks"]) ? (parsed["tasks"] as unknown[]) : [];
  text = upsertJsoncArrayEntries(text, ["tasks"], tasks, VSCODE_TASKS, "label", path, "task");

  const inputs = Array.isArray(parsed["inputs"]) ? (parsed["inputs"] as unknown[]) : [];
  text = upsertJsoncArrayEntries(text, ["inputs"], inputs, [VSCODE_INPUT], "id", path, "input");

  return text === current ? current : text;
}

function uninstallTasksJson(current: string | undefined, path: string): string | undefined {
  if (isBlank(current)) {
    return undefined;
  }
  const rawParsed: unknown = parseJsoncOrConflict(current as string, path);
  if (!isPlainObject(rawParsed)) {
    // Nothing mem could have stamped inside a non-object root; leave it untouched rather than crash.
    return current;
  }
  const parsed = rawParsed;
  let text = current as string;
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
  const text = isBlank(current) ? "[]\n" : (current as string);
  // Guard the raw parsed value against a `?? []` coercion: a keybindings.json holding literally
  // `null` parses to JS `null`, and `null ?? []` would silently masquerade as an empty array, slip
  // past the array check, then reach jsonc-parser's `modify(text, [-1], ...)` on a `null` root --
  // which throws a raw "Can not add property to parent of type null" Error instead of the documented
  // WiringConflictError contract. Every non-array root (null, number, string, boolean, object) must
  // abort with WiringConflictError, matching how installTasksJson rejects a non-object root.
  const parsed: unknown = isBlank(current) ? [] : parseJsoncOrConflict(current as string, path);
  if (!Array.isArray(parsed)) {
    throw new WiringConflictError(`${path} does not contain a JSON array; refusing to modify a hand-edited config`);
  }
  const next = upsertJsoncArrayEntries(text, [], parsed, VSCODE_KEYBINDINGS, "key", path, "keybinding");
  return next === current ? current : next;
}

function uninstallKeybindings(current: string | undefined, path: string): string | undefined {
  if (isBlank(current)) {
    return undefined;
  }
  const parsed = parseJsoncOrConflict(current as string, path);
  const existing = Array.isArray(parsed) ? parsed : [];
  const { text, changed } = removeStampedJsoncArrayEntries(current as string, [], existing);
  return changed ? text : current;
}

// ─────────────────────────────────────────────────────────────────────────── Tool definitions ───────────────────────────────────────────────────────────────────────────

const CLAUDE_CODE_CLAUDE_MD_BODY = `## Memory

This machine has token-goat-mem installed. Do not wait to be asked to run
\`mem remember\` — when I say things like "remember that...", "always...",
"from now on...", "never...", "don't...", or otherwise state a durable
preference, decision, or correction, persist it yourself, right then:
\`mem remember "<short fact>" --kind preference|decision|fact|correction --scope project --root .\`
Use --subject/--value for anything that can be contradicted later.`;

/**
 * Canonical "## Memory" prose shared by every tool that writes into `AGENTS.md` via the
 * reference-counted shared block (`codex`, `copilot-cli`, and `copilot-vscode`).
 */
const AGENTS_MD_SHARED_BODY = `## Memory

token-goat-mem is installed (\`mem\` on PATH).

- At the start of a task, run \`mem recall --hint-format --root .\` and treat
  each returned line's \`display\` string as a prior fact, honoring its
  embedded trust caveat.
- Do not wait to be asked to run \`mem remember\` — when the user says things
  like "remember that...", "always...", "from now on...", "never...",
  "don't...", or otherwise reaches a durable preference, decision, or
  correction, persist it yourself, right then:
  \`mem remember "<short fact>" --kind preference|decision|fact|correction
  --scope project --root .\`. Use --subject/--value for anything that can be
  contradicted later.`;

/** VS Code's per-user config directory. Derived purely from the (dependency-injected) `homeDir`, never the real `%APPDATA%`/`$HOME` env vars, so tests stay fully isolated regardless of platform. Exported so tests can compute the same platform-dependent path rather than hardcoding one OS's layout. */
export function vscodeUserDir(homeDir: string): string {
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
  const settingsEntry: ManagedFile = {
    path: settingsPath,
    install: (current) => installClaudeSettings(current, settingsPath),
    uninstall: (current) => uninstallClaudeSettings(current, settingsPath),
  };
  if (user) {
    return [settingsEntry];
  }
  const claudeMdPath = join(root, "CLAUDE.md");
  return [settingsEntry, markdownFile(claudeMdPath, "claude-code", CLAUDE_CODE_CLAUDE_MD_BODY)];
});

export const codex: ToolWiring = makeToolWiring(({ root }) => {
  const agentsMdPath = join(root, "AGENTS.md");
  return [sharedMarkdownFile(agentsMdPath, "codex", AGENTS_MD_SHARED_BODY)];
});

export const copilotCli: ToolWiring = makeToolWiring(({ root }) => {
  const agentsMdPath = join(root, "AGENTS.md");
  return [sharedMarkdownFile(agentsMdPath, "copilot-cli", AGENTS_MD_SHARED_BODY)];
});

export const copilotVscode: ToolWiring = makeToolWiring(({ root, homeDir }) => {
  const tasksPath = join(root, ".vscode", "tasks.json");
  const keybindingsPath = join(vscodeUserDir(homeDir), "keybindings.json");
  const agentsMdPath = join(root, "AGENTS.md");
  return [
    { path: tasksPath, install: (current) => installTasksJson(current, tasksPath), uninstall: (current) => uninstallTasksJson(current, tasksPath) },
    { path: keybindingsPath, install: (current) => installKeybindings(current, keybindingsPath), uninstall: (current) => uninstallKeybindings(current, keybindingsPath) },
    sharedMarkdownFile(agentsMdPath, "copilot-vscode", AGENTS_MD_SHARED_BODY),
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
