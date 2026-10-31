/** The UserPromptSubmit memory-block marker: one empty file per session beside the store, present while the block already went out in the session's current context window, so later prompts in that window send nothing. A session start or a compaction clears it. */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { MEM_DB_MODE } from "./fileUtils.js";

/** A session id that is safe to name a file with: plain token characters only, so no separator or dot segment can reach the path. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** The marker beside the store for `sessionId`, or `undefined` when the id cannot name a file (the caller then sends the block on every prompt, as before). */
export function promptBlockMarkerPath(dbPath: string, sessionId: string): string | undefined {
  return SAFE_SESSION_ID.test(sessionId) ? join(dirname(dbPath), `prompt-block-${sessionId}.sent`) : undefined;
}

/** Whether the UserPromptSubmit block already went out in this session's current context window. */
export function promptBlockSent(dbPath: string, sessionId: string): boolean {
  const marker = promptBlockMarkerPath(dbPath, sessionId);
  return marker !== undefined && existsSync(marker);
}

/** Records that the block went out in this window, so later prompts in it send nothing; throws on failure, for the caller to absorb. */
export function markPromptBlockSent(dbPath: string, sessionId: string): void {
  const marker = promptBlockMarkerPath(dbPath, sessionId);
  if (marker !== undefined) {
    writeFileSync(marker, "", { mode: MEM_DB_MODE });
  }
}

/** Opens a new context window (a session start or a compaction): the next prompt sends the block again. */
export function resetPromptBlock(dbPath: string, sessionId: string): void {
  const marker = promptBlockMarkerPath(dbPath, sessionId);
  if (marker !== undefined) {
    rmSync(marker, { force: true });
  }
}
