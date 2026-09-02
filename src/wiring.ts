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
 *   end of file; uninstall strips the marked block plus the one separator newline install adds,
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

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, findNodeAtLocation, modify, parse as parseJsonc, parseTree, type JSONPath, type ModificationOptions, type Node } from "jsonc-parser";

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

/**
 * The permission bits of an existing file, or `null` on Windows or if it cannot be stat'd.
 *
 * A temp-file-plus-rename write does not update a file in place -- it replaces the inode -- so
 * without this the new file carries whatever the umask gave it. For a managed file the user
 * deliberately restricted (a `~/.claude/settings.json` at 0600, say), that silently *widens* the
 * permissions of a file mem was only asked to add a block to. Windows is excluded for the same
 * reason as in `db.ts`: `chmod` there carries no read permission meaning.
 */
function existingMode(filePath: string): number | null {
  if (process.platform === "win32") {
    return null;
  }
  try {
    return statSync(filePath).mode & 0o777;
  } catch {
    return null;
  }
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
  const preservedMode = existingMode(op.path);
  mkdirSync(dirname(op.path), { recursive: true });
  const tmpPath = `${op.path}.token-goat-mem.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // The temp file is an implementation detail of the atomic write, so it must not survive a failure
  // and litter the user's project (or their `~/.claude`) with a file no later run cleans up. On the
  // success path the rename has already consumed it and the unlink is an expected no-op.
  try {
    writeFileSync(tmpPath, after, "utf8");
    if (preservedMode !== null) {
      chmodSync(tmpPath, preservedMode);
    }
    renameSync(tmpPath, op.path);
  } finally {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup only: never mask the original failure with a cleanup failure.
    }
  }
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

/**
 * The line ending `content` already uses, which is the one mem writes back into it.
 *
 * Every string this module generates is LF, but the files it edits belong to the user and on Windows
 * are routinely CRLF -- that is the editor default, not an exotic case. Appending LF text to a CRLF
 * file leaves it with mixed endings, and the blank-line separator `appendBlock` inserts then fails to
 * match on the way out, so `uninstall` leaves a growing gap behind instead of restoring the file
 * byte-for-byte the way it advertises. Detecting once and emitting in the file's own ending removes
 * both failures at the source.
 *
 * A file with no CRLF anywhere -- including a blank or absent one -- gets LF.
 */
function detectEol(content: string | undefined): "\r\n" | "\n" {
  return content !== undefined && content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Rewrites every line ending in generated text to `eol`.
 *
 * Safe on `JSON.stringify` output: a literal newline there is always formatting, because a newline
 * inside a string value is emitted escaped and so is never matched here. The lone carriage return in
 * the VS Code `sendSequence` task argument is escaped for the same reason and survives untouched.
 */
function withEol(text: string, eol: "\r\n" | "\n"): string {
  return eol === "\n" ? text.replace(/\r\n/gu, "\n") : text.replace(/\r?\n/gu, "\r\n");
}

/**
 * Appends `block` to `content` in whichever line ending `content` already uses, adding exactly one
 * newline between the two. Writes just the block when `content` is empty.
 *
 * The single newline is what makes the append invertible. A file that already ends in a newline gets
 * the blank line you would expect; one that does not gets the block on the very next line instead,
 * and `stripBlockSeparators` restores either by removing exactly one newline. Padding an
 * unterminated file up to a blank line reads better but destroys information: the result `<text>\n\n`
 * is then produced by both an original `<text>` and an original `<text>\n`, and uninstall has to
 * guess. It used to guess `<text>\n`, so a file with no trailing newline silently gained one on the
 * first install/uninstall cycle.
 *
 * Emptiness is tested by length, not by `trim()`: a whitespace-only file is the user's bytes, not an
 * absent file, and treating the two alike dropped its contents on install.
 */
function appendBlock(content: string, block: string): string {
  const eol = detectEol(content);
  const eolBlock = withEol(block, eol);
  if (content.length === 0) {
    return `${eolBlock}${eol}`;
  }
  return `${content}${eol}${eolBlock}${eol}`;
}

/** Removes the `[startIdx, blockEnd)` slice of `content` plus the one separator newline `appendBlock` adds, leaving the rest of the file untouched. Shared by both the per-tool and reference-counted shared marker implementations. */
function stripBlockSeparators(content: string, startIdx: number, blockEnd: number): string {
  const before = content.slice(0, startIdx);
  const after = content.slice(blockEnd);
  // Removes exactly the one newline `appendBlock` inserted, in whichever ending the file uses --
  // the inverse of that function, and the reason it inserts one newline rather than padding to a
  // blank line. Matched as a pattern rather than as a literal, since a CRLF file's separator is
  // "\r\n" and a literal "\n" test would leave the carriage return behind.
  const beforeStripped = before.replace(/\r?\n$/u, "");
  const afterStripped = after.replace(/^\r?\n/u, "");
  return `${beforeStripped}${afterStripped}`;
}

/** Every offset at which `marker` occurs in `content`, ascending. */
function allOccurrences(content: string, marker: string): number[] {
  const out: number[] = [];
  for (let idx = content.indexOf(marker); idx !== -1; idx = content.indexOf(marker, idx + marker.length)) {
    out.push(idx);
  }
  return out;
}

/**
 * The first `start` occurrence that resolves to a complete block -- an `end` marker after it with no
 * other `start` in between -- or `undefined` if none does.
 *
 * A bare `indexOf(start)` / `indexOf(end)` pair is not equivalent, and the difference destroys data.
 * A hand-edit, a crashed write, or a merge conflict can leave an orphaned start marker with no end
 * of its own; pairing that orphan with a *later* block's end marker makes uninstall delete every
 * byte between them -- the user's own content along with mem's block. Scanning past a start that
 * does not resolve also stops installs from appending a duplicate block whenever a stray end marker
 * happens to sit earlier in the file. `findSharedBlock` has always reasoned this way; this is the
 * same rule for the per-tool markers.
 */
function resolveMarkedBlock(content: string, start: string, end: string): { startIdx: number; endIdx: number } | undefined {
  const starts = allOccurrences(content, start);
  for (let i = 0; i < starts.length; i++) {
    const startIdx = starts[i];
    if (startIdx === undefined) {
      continue;
    }
    const endIdx = content.indexOf(end, startIdx + start.length);
    if (endIdx === -1) {
      continue;
    }
    const nextStart = starts[i + 1];
    if (nextStart !== undefined && nextStart < endIdx) {
      continue;
    }
    return { startIdx, endIdx };
  }
  return undefined;
}

/** Inserts/replaces a tool-namespaced marked block. Replaces everything between an existing marker pair in place (upgrade); otherwise appends a new marked block at end of file, separated from any existing content by one newline. */
function upsertMarkedBlock(content: string, tool: string, body: string): string {
  const start = markerStart(tool);
  const end = markerEnd(tool);
  const block = `${start}\n${body.trim()}\n${end}`;

  const found = resolveMarkedBlock(content, start, end);
  if (found !== undefined) {
    return content.slice(0, found.startIdx) + withEol(block, detectEol(content)) + content.slice(found.endIdx + end.length);
  }

  return appendBlock(content, block);
}

/** Strips a tool-namespaced marked block plus the one separator newline `upsertMarkedBlock` adds, leaving the rest of the file untouched. No-op (returns `content` unchanged) if the marker pair isn't present. */
function stripMarkedBlock(content: string, tool: string): string {
  const end = markerEnd(tool);
  const found = resolveMarkedBlock(content, markerStart(tool), end);
  if (found === undefined) {
    return content;
  }
  return stripBlockSeparators(content, found.startIdx, found.endIdx + end.length);
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
    // Index of where the start-marker line's terminator begins, not of its newline: on CRLF the
    // carriage return sits one character earlier, and the tools= rewrite slices the rest of the file
    // back on from here -- slicing from the newline would drop that CR and convert the marker line
    // alone to LF.
    const newlineIdx = content.indexOf("\n", startIdx);
    const startLineEndIdx = newlineIdx > 0 && content[newlineIdx - 1] === "\r" ? newlineIdx - 1 : newlineIdx;
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
    // Rebuilt whole rather than rewriting just the `tools=` line. Returning early once the tool was
    // already listed meant a body written by an older version of mem was never refreshed, so a
    // reinstall upgraded the per-tool blocks and silently left this one stale. The body is generated
    // from one constant shared by every tool that writes here, so regenerating it is the upgrade.
    const tools = found.tools.includes(tool) ? found.tools : [...found.tools, tool];
    const blockEnd = found.endIdx + SHARED_BLOCK_END.length;
    const block = withEol(`${sharedMarkerStart(tools)}\n${body.trim()}\n${SHARED_BLOCK_END}`, detectEol(content));
    if (content.slice(found.startIdx, blockEnd) === block) {
      return content;
    }
    return content.slice(0, found.startIdx) + block + content.slice(blockEnd);
  }

  const block = `${sharedMarkerStart([tool])}\n${body.trim()}\n${SHARED_BLOCK_END}`;
  return appendBlock(content, block);
}

/**
 * Removes `thisTool` from the shared block's `tools=` list. If other tools remain listed, rewrites
 * only the marker line and leaves the block body in place. If `thisTool` was the only tool listed,
 * removes the whole block plus the one separator newline install adds (same rule as
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
    // A listed tool can still have work to do now that install refreshes a stale body, so the two
    // reasons a shared-block install is non-noop have to read differently.
    return found.tools.includes(tool)
      ? `install would refresh the shared block body (${tool} already in tools=)`
      : `install would join existing shared block (adds ${tool} to tools=)`;
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

// ─────────────────────────────────────────────────────────────────────────── Surgical JSON/JSONC editing ───────────────────────────────────────────────────────────────────────────

const JSONC_PARSE = { allowTrailingComma: true } as const;

/** The node at `path`, or `undefined` when the document is empty or the path does not resolve. */
function jsoncNodeAt(content: string, path: JSONPath): Node | undefined {
  const tree = parseTree(content, [], JSONC_PARSE);
  return tree === undefined ? undefined : findNodeAtLocation(tree, path);
}

/** Last-resort formatting for `surgicalJsoncEdit`'s fallback path; never used on the surgical path. */
const JSONC_FORMAT: ModificationOptions = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };

/**
 * The indentation unit the document already uses, so mem's inserts match the file instead of
 * restyling it. Heuristic: a tab-indented line wins outright, otherwise the narrowest positive space
 * indent in the file. Guessing wrong only affects the block mem itself writes.
 */
function detectIndentUnit(content: string): string {
  if (/^\t+\S/mu.test(content)) {
    return "\t";
  }
  let narrowest: number | undefined;
  for (const match of content.matchAll(/^( +)\S/gmu)) {
    const width = match[1]?.length ?? 0;
    if (width > 0 && (narrowest === undefined || width < narrowest)) {
      narrowest = width;
    }
  }
  return " ".repeat(narrowest ?? 2);
}

/** Leading whitespace of the line `offset` sits on, up to `offset`. */
function lineIndentAt(content: string, offset: number): string {
  const lineStart = content.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  return /^[ \t]*/u.exec(content.slice(lineStart, offset))?.[0] ?? "";
}

/** `value` as JSON text indented with `unit`, every line after the first prefixed by `base`. */
function renderJsonAt(value: unknown, unit: string, base: string, eol: string): string {
  return JSON.stringify(value, null, unit)
    .split("\n")
    .map((line, index) => (index === 0 ? line : `${base}${line}`))
    .join(eol);
}

/**
 * `modify` + `applyEdits` that does not reformat text mem did not write.
 *
 * Handing `modify` a `formattingOptions` makes it rewrite the whole containing array or object, so a
 * hand-written `{ "key": "ctrl+q", "command": "noop" }` came back exploded over five lines and a
 * 4-space-indented settings.json came back 2-space -- mem restyling a file it does not own. Passing
 * `{}` instead produces a genuinely surgical (usually zero-length) edit that touches nothing else,
 * at the cost of a minified payload; this re-renders only that payload at the document's own
 * indentation and end-of-line.
 *
 * Falls back to the old whole-container reformat when the edit is not a plain insert of `value` --
 * chiefly when `modify` had to create intermediate objects, where the payload is a nested wrapper
 * rather than `value` itself. Correct output, just less careful about the neighbours.
 */
function surgicalJsoncEdit(content: string, path: JSONPath, value: unknown): string {
  const edits = modify(content, path, value, {});
  const edit = edits[0];
  if (edits.length !== 1 || edit === undefined || edit.content === "") {
    return applyEdits(content, edits);
  }
  const prefix = /^,?\s*(?:"(?:[^"\\]|\\.)*"\s*:\s*)?/u.exec(edit.content)?.[0] ?? "";
  if (edit.content !== `${prefix}${JSON.stringify(value)}`) {
    return applyEdits(content, modify(content, path, value, JSONC_FORMAT));
  }

  const eol = detectEol(content);
  const unit = detectIndentUnit(content);
  const outer = lineIndentAt(content, edit.offset);
  const key = prefix.replace(/^,\s*/u, "").trim();
  const spacer = key === "" ? "" : " ";
  const before = content.slice(0, edit.offset);
  const after = content.slice(edit.offset + edit.length);

  if (edit.length > 0) {
    // Replacing a value in place -- the surrounding text already positions it.
    return `${before}${key}${spacer}${renderJsonAt(value, unit, outer, eol)}${after}`;
  }

  if (prefix.startsWith(",")) {
    // A container the user keeps on one line stays on one line.
    const container = jsoncNodeAt(content, path.slice(0, -1));
    if (container !== undefined && !content.slice(container.offset, edit.offset).includes("\n")) {
      return `${before}, ${key}${spacer}${JSON.stringify(value)}${after}`;
    }
    return `${before},${eol}${outer}${key}${spacer}${renderJsonAt(value, unit, outer, eol)}${after}`;
  }

  // First child of an empty container: open it up one level.
  const base = outer + unit;
  const tail = /^[ \t]*\r?\n/u.test(after) ? "" : `${eol}${outer}`;
  return `${before}${eol}${base}${key}${spacer}${renderJsonAt(value, unit, base, eol)}${tail}${after}`;
}

/**
 * Deletes element `index` of the array at `arrayPath`, leaving every other byte alone.
 *
 * jsonc-parser's own deletion swallows the line break before the closing bracket when the last
 * element goes (`[a,\n  b\n]` becomes `[a ]`), which breaks the install/uninstall round trip this
 * module promises. Returns `content` unchanged when the path or index does not resolve.
 */
function surgicalJsoncRemoveArrayEntry(content: string, arrayPath: JSONPath, index: number): string {
  const array = jsoncNodeAt(content, arrayPath);
  const children = array?.children;
  const node = children?.[index];
  if (array === undefined || children === undefined || node === undefined) {
    return content;
  }
  let start = node.offset;
  let end = node.offset + node.length;
  if (children.length === 1) {
    const inner = array.offset + 1;
    const close = array.offset + array.length - 1;
    // Collapse to `[]` only when whitespace is all that surrounds the element. A comment in there is
    // the user's, and dropping it is exactly the collateral this whole path exists to avoid.
    if (`${content.slice(inner, start)}${content.slice(end, close)}`.trim() === "") {
      start = inner;
      end = close;
    }
  } else if (index > 0) {
    const previous = children[index - 1];
    if (previous !== undefined) {
      start = previous.offset + previous.length;
    }
  } else {
    const next = children[1];
    if (next !== undefined) {
      end = next.offset;
    }
  }
  return content.slice(0, start) + content.slice(end);
}

// ─────────────────────────────────────────────────────────────────────────── Claude Code: settings.json hook ───────────────────────────────────────────────────────────────────────────

// This hook lands in `<root>/.claude/settings.json`, which is typically committed and shared with
// collaborators -- some of whom may not have mem on PATH. `command -v mem` gates the call, and the
// trailing `|| true` forces exit 0 either way (a bare `&&` guard would exit 1 when mem is absent,
// which a host could still surface as a failed hook), matching the fail-open contract the README
// documents for this seam: a missing or broken mem must never block a session.
const CLAUDE_HOOK_COMMAND =
  'command -v mem >/dev/null 2>&1 && mem recall --hint-format --root "$CLAUDE_PROJECT_DIR" || true';

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
  // Which containers the file actually had decides where the single surgical insert lands below; the
  // defaulting on the next lines exists only so the analysis can run over a uniform shape.
  const hadHooks = parsed.hooks !== undefined;
  const hadSessionStart = hadHooks && parsed.hooks?.SessionStart !== undefined;
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

  // Indices, not just the object: the write below is a surgical edit addressed by JSON path.
  let stampedGroupIdx = -1;
  let stampedHookIdx = -1;
  for (let index = 0; index < groups.length && stampedGroupIdx === -1; index += 1) {
    const hookIdx = (groups[index]?.hooks ?? []).findIndex((hook) => isStamped(hook));
    if (hookIdx !== -1) {
      stampedGroupIdx = index;
      stampedHookIdx = hookIdx;
    }
  }
  const stampedHook: ClaudeHook | undefined = stampedGroupIdx === -1 ? undefined : groups[stampedGroupIdx]?.hooks?.[stampedHookIdx];

  const hasUnstampedConflict = groups.some((group) =>
    (group.hooks ?? []).some((hook) => isPlainObject(hook) && !isStamped(hook) && hook.command === CLAUDE_HOOK_COMMAND)
  );
  if (hasUnstampedConflict && stampedHook === undefined) {
    throw new WiringConflictError(`a SessionStart hook with command "${CLAUDE_HOOK_COMMAND}" already exists in ${path} and was not created by mem; refusing to duplicate it`);
  }

  // Edit the text, never a reserialize of the parsed object. `JSON.stringify(parsed, null, 2)` threw
  // away everything the user's file expressed and mem has no opinion about -- indentation width, key
  // layout, the blank lines between sections -- on every install of a one-line hook.
  const text = isBlank(current) ? "{}\n" : (current as string);

  if (stampedHook !== undefined) {
    if (stampedHook.type === "command" && stampedHook.command === CLAUDE_HOOK_COMMAND) {
      return current;
    }
    const hookPath: JSONPath = ["hooks", "SessionStart", stampedGroupIdx, "hooks", stampedHookIdx];
    const retyped = surgicalJsoncEdit(text, [...hookPath, "type"], "command");
    return surgicalJsoncEdit(retyped, [...hookPath, "command"], CLAUDE_HOOK_COMMAND);
  }

  // Insert at the deepest container the file already has, so `modify` never has to synthesise
  // intermediates -- that is the one case surgicalJsoncEdit has to fall back to a reformat.
  const group = { hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND, [STAMP_KEY]: true }] };
  if (!hadHooks) {
    return surgicalJsoncEdit(text, ["hooks"], { SessionStart: [group] });
  }
  if (!hadSessionStart) {
    return surgicalJsoncEdit(text, ["hooks", "SessionStart"], [group]);
  }
  return surgicalJsoncEdit(text, ["hooks", "SessionStart", -1], group);
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

  // Plan the removals as JSON paths, then apply them to the text. Rebuilding the object and
  // reserializing it would hand the user back a file reindented to mem's taste.
  // Built in descending index order -- groups first, then hooks within a group -- so applying them in
  // sequence never shifts the index of one still to come.
  const removals: JSONPath[] = [];
  for (let index = (sessionStart as unknown[]).length - 1; index >= 0; index -= 1) {
    // Access `.hooks` only through an isPlainObject guard: a hand-edited SessionStart may hold a
    // `null`/primitive element, and `null.hooks` would throw a raw TypeError. Uninstall stays lenient
    // (leave anything mem didn't stamp untouched) rather than crashing on such an entry.
    const group: unknown = (sessionStart as unknown[])[index];
    const hooks = isPlainObject(group) ? group["hooks"] : undefined;
    if (!Array.isArray(hooks) || !hooks.some((hook) => isStamped(hook))) {
      continue;
    }
    if (hooks.every((hook) => isStamped(hook))) {
      // The whole group was mem's addition -- drop it rather than leave an empty `hooks: []` behind.
      removals.push(["hooks", "SessionStart", index]);
      continue;
    }
    for (let hookIdx = hooks.length - 1; hookIdx >= 0; hookIdx -= 1) {
      if (isStamped(hooks[hookIdx])) {
        removals.push(["hooks", "SessionStart", index, "hooks", hookIdx]);
      }
    }
  }

  if (removals.length === 0) {
    return current;
  }

  let text = current as string;
  for (const removal of removals) {
    const arrayPath = removal.slice(0, -1);
    const index = removal[removal.length - 1];
    if (typeof index === "number") {
      text = surgicalJsoncRemoveArrayEntry(text, arrayPath, index);
    }
  }

  // Prune the containers mem's own removals just emptied. Install creates `hooks` and
  // `hooks.SessionStart` when a settings.json has neither -- the common case -- so stopping at the
  // group removal left a `"hooks": { "SessionStart": [] }` husk behind and broke the "uninstall
  // reverses exactly what init wrote" promise. An empty SessionStart array, or a hooks object with
  // nothing but one, is inert, so pruning one a user happened to have written costs them nothing.
  const settingsAfter: unknown = parseJsonc(text, [], JSONC_PARSE);
  const hooksAfter: unknown = isPlainObject(settingsAfter) ? settingsAfter["hooks"] : undefined;
  if (isPlainObject(hooksAfter)) {
    const sessionStartAfter = hooksAfter["SessionStart"];
    if (Array.isArray(sessionStartAfter) && sessionStartAfter.length === 0) {
      text =
        Object.keys(hooksAfter).length === 1
          ? surgicalJsoncEdit(text, ["hooks"], undefined)
          : surgicalJsoncEdit(text, ["hooks", "SessionStart"], undefined);
    }
  }
  return text;
}

// ─────────────────────────────────────────────────────────────────────────── Copilot VS Code: tasks.json / keybindings.json (JSONC) ───────────────────────────────────────────────────────────────────────────

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
      result = surgicalJsoncEdit(result, [...arrayPath, -1], entry);
      continue;
    }
    const found = existing[idx];
    if (!isStamped(found)) {
      throw new WiringConflictError(`a ${kindLabel} with ${identityKey}=${JSON.stringify(identity)} already exists in ${path} and was not created by mem; refusing to duplicate or overwrite it`);
    }
    if (!isDeepStrictEqual(found, entry)) {
      result = surgicalJsoncEdit(result, [...arrayPath, idx], entry);
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
    result = surgicalJsoncRemoveArrayEntry(result, arrayPath, idx);
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
    text = surgicalJsoncEdit(text, ["version"], "2.0.0");
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

  // Re-parsed rather than reused: the `tasks` removal above edited `text`, so `parsed` is stale.
  // Guarded like every other call site -- `parseJsoncOrConflict` returns undefined for an empty
  // document, which the previous cast-then-`?? {}` hid from the type system while it still fired.
  const rawReparsed = parseJsoncOrConflict(text, path);
  const reparsed = isPlainObject(rawReparsed) ? rawReparsed : {};
  const inputs = Array.isArray(reparsed["inputs"]) ? (reparsed["inputs"] as unknown[]) : [];
  const inputsResult = removeStampedJsoncArrayEntries(text, ["inputs"], inputs);
  text = inputsResult.text;
  anyChanged = anyChanged || inputsResult.changed;

  if (!anyChanged) {
    return current;
  }

  // Drop the arrays mem's own removals just emptied, same rule as the settings.json hook containers:
  // install has to create `tasks`/`inputs` when the file has no such key, and leaving `"inputs": []`
  // behind is not the pre-install state uninstall promises. An empty array here is inert, so pruning
  // one a user happened to have written costs them nothing.
  for (const key of ["tasks", "inputs"] as const) {
    const after: unknown = parseJsoncOrConflict(text, path);
    const value = isPlainObject(after) ? after[key] : undefined;
    if (Array.isArray(value) && value.length === 0) {
      text = surgicalJsoncEdit(text, [key], undefined);
    }
  }
  return text;
}

/**
 * Both bindings are `ctrl+k` chords rather than plain `ctrl+shift` combinations.
 *
 * The previous `ctrl+shift+m` and `ctrl+shift+n` shadowed two VS Code defaults -- View: Problems and
 * New Window -- so installing mem silently took over shortcuts the user already had muscle memory
 * for, and the only signal was the built-in quietly not working any more. `ctrl+k` is VS Code's
 * conventional chord prefix for exactly this reason: a second keystroke follows, so a chord collides
 * with far less and reads as an extension binding rather than a hijacked default.
 *
 * `mem uninstall` removes these by their stamp, so a user who already installed the old bindings
 * gets them replaced on the next `mem init` rather than accumulating both.
 */
const VSCODE_KEYBINDINGS: ReadonlyArray<Record<string, unknown>> = [
  {
    key: "ctrl+k m",
    command: "workbench.action.terminal.sendSequence",
    args: { text: "mem recall --hint-format --root .\r" },
    [STAMP_KEY]: true,
  },
  {
    key: "ctrl+k r",
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
