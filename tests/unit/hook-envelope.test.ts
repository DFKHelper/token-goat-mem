import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { HOOK_PROMPT_KEYS, parseHookEnvelope, readStreamWithTimeout } from "../../src/hook-envelope.js";

describe("parseHookEnvelope", () => {
  it("reads session_id and prompt from a UserPromptSubmit envelope shaped like the hooks reference", () => {
    const envelope = parseHookEnvelope(
      JSON.stringify({
        session_id: "abc123",
        transcript_path: "/home/user/.claude/projects/x/transcript.jsonl",
        cwd: "/home/user/my-project",
        permission_mode: "default",
        hook_event_name: "UserPromptSubmit",
        prompt: "Write a function to calculate the factorial of a number",
      })
    );
    expect(envelope).toEqual({ sessionId: "abc123", prompt: "Write a function to calculate the factorial of a number" });
  });

  it("reads a SessionStart envelope (session_id, no prompt) as session-only", () => {
    const envelope = parseHookEnvelope(JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart", source: "startup" }));
    expect(envelope).toEqual({ sessionId: "s1" });
  });

  it("probes the fallback prompt keys in order when `prompt` is absent", () => {
    expect(HOOK_PROMPT_KEYS).toEqual(["prompt", "user_prompt", "message"]);
    expect(parseHookEnvelope(JSON.stringify({ session_id: "s", user_prompt: "from user_prompt" })).prompt).toBe("from user_prompt");
    expect(parseHookEnvelope(JSON.stringify({ session_id: "s", message: "from message" })).prompt).toBe("from message");
    // `prompt` wins over the fallbacks when both are present.
    expect(parseHookEnvelope(JSON.stringify({ prompt: "primary", user_prompt: "secondary" })).prompt).toBe("primary");
  });

  it.each([
    ["empty input", ""],
    ["not JSON", "TGMEM/2"],
    ["a JSON array", "[1,2,3]"],
    ["a JSON string", '"just a string"'],
    ["null", "null"],
  ])("fails open to an empty envelope on %s", (_label, raw) => {
    expect(parseHookEnvelope(raw)).toEqual({});
  });

  it("ignores fields of the wrong type or empty strings instead of erroring", () => {
    expect(parseHookEnvelope(JSON.stringify({ session_id: 42, prompt: ["not", "a", "string"] }))).toEqual({});
    expect(parseHookEnvelope(JSON.stringify({ session_id: "   ", prompt: "" }))).toEqual({});
    // A non-string `prompt` does not stop the probe from finding a usable fallback key.
    expect(parseHookEnvelope(JSON.stringify({ prompt: null, user_prompt: "fallback" }))).toEqual({ prompt: "fallback" });
  });
});

describe("readStreamWithTimeout", () => {
  it("returns everything written before the stream ends", async () => {
    const stream = new PassThrough();
    const pending = readStreamWithTimeout(stream as unknown as NodeJS.ReadStream, 5000);
    stream.write('{"session_id":"s1",');
    stream.write('"prompt":"hello"}');
    stream.end();
    expect(parseHookEnvelope(await pending)).toEqual({ sessionId: "s1", prompt: "hello" });
  });

  it("resolves with what arrived so far when the stream never closes within the timeout, instead of hanging", async () => {
    const stream = new PassThrough();
    const pending = readStreamWithTimeout(stream as unknown as NodeJS.ReadStream, 50);
    stream.write("partial");
    await expect(pending).resolves.toBe("partial");
  });

  it("returns the empty string without reading when stdin is a TTY (nothing was piped)", async () => {
    const stream = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean };
    stream.isTTY = true;
    await expect(readStreamWithTimeout(stream, 5000)).resolves.toBe("");
  });
});
