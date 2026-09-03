/**
 * Parsing for the JSON envelope a coding tool's hook hands `mem recall --hook-stdin` on stdin.
 *
 * Claude Code delivers every hook's input as one JSON object on stdin (not env vars). `session_id`
 * is a common field present on every event; a `UserPromptSubmit` hook additionally carries the
 * submitted text in `prompt` (hooks reference, "UserPromptSubmit input"). Other tools, and the
 * plugin-authoring guide's own `$USER_PROMPT` naming, suggest `user_prompt`, so a short ordered
 * probe list is used rather than one hard-coded key.
 *
 * Everything here fails open. A hook that exits non-zero, or prints a parse error into an agent's
 * context, is worse than a hook that returns unranked facts -- so an unexpected shape, a truncated
 * pipe, or a non-string field degrades to "no query / no session", never to an error.
 */

/** Keys probed, in order, for the submitted prompt text; the first non-empty string wins. */
export const HOOK_PROMPT_KEYS: readonly string[] = ["prompt", "user_prompt", "message"];

/** Key carrying the hook's session identifier. */
export const HOOK_SESSION_KEY = "session_id";

export interface HookEnvelope {
  /** Session identifier, when the envelope carried a non-empty string under `session_id`. */
  readonly sessionId?: string;
  /** Submitted prompt text, when one of {@link HOOK_PROMPT_KEYS} held a non-empty string. */
  readonly prompt?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Extracts the session id and prompt from raw stdin text. Never throws: anything that is not a
 * JSON object with the expected string fields yields an envelope with the corresponding field
 * absent.
 */
export function parseHookEnvelope(raw: string): HookEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const record = parsed as Record<string, unknown>;
  const sessionId = nonEmptyString(record[HOOK_SESSION_KEY]);
  let prompt: string | undefined;
  for (const key of HOOK_PROMPT_KEYS) {
    prompt = nonEmptyString(record[key]);
    if (prompt !== undefined) {
      break;
    }
  }
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
  };
}

/** Upper bound on how long `--hook-stdin` waits for stdin to close before giving up on it. */
export const HOOK_STDIN_TIMEOUT_MS = 1000;

/**
 * Reads all of `stream` as UTF-8, resolving to the empty string when the stream is a TTY (nothing
 * was piped), when it errors, or when it has not ended within `timeoutMs` -- a hook host always
 * writes the envelope and closes the pipe promptly, so a stall means there is no envelope coming
 * and the recall should proceed without one rather than hang the host.
 */
export function readStreamWithTimeout(
  stream: NodeJS.ReadStream,
  timeoutMs: number = HOOK_STDIN_TIMEOUT_MS
): Promise<string> {
  if (stream.isTTY === true) {
    return Promise.resolve("");
  }
  return new Promise<string>((resolve) => {
    const chunks: string[] = [];
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", finish);
      stream.removeListener("error", finish);
      stream.removeListener("close", finish);
      // Leave the stream paused so a still-open pipe cannot keep the process alive.
      stream.pause();
      resolve(chunks.join(""));
    };
    const onData = (chunk: Buffer | string): void => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    };
    const timer = setTimeout(finish, timeoutMs);
    stream.setEncoding("utf8");
    stream.on("data", onData);
    stream.once("end", finish);
    stream.once("error", finish);
    stream.once("close", finish);
    stream.resume();
  });
}
