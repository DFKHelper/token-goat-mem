/**
 * `mem reflect --hook-stdin` as the Claude Code Stop hook runs it: the built bundle, a real Stop
 * envelope piped on stdin.
 *
 * The contract a Stop hook has to honour is narrow. Blocking (`{"decision":"block"}` on stdout)
 * makes the agent keep working, so reflect may block only when it has something new to say --
 * suggestions this very run filed -- and must never block while `stop_hook_active` says the agent
 * is already continuing because of a Stop hook, or it loops. Every other outcome is silence.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBundleSync, type BundleResult } from "../support/bundle.js";

let memHome: string;
let root: string;

beforeEach(() => {
  memHome = mkdtempSync(join(tmpdir(), "mem-reflect-hook-home-"));
  root = mkdtempSync(join(tmpdir(), "mem-reflect-hook-root-"));
});

afterEach(() => {
  rmSync(memHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function writeTranscript(turns: readonly string[]): void {
  writeFileSync(
    join(root, "transcript.jsonl"),
    turns.map((text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })).join("\n"),
    "utf8"
  );
}

function stopEnvelope(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "s1",
    transcript_path: join(root, "transcript.jsonl"),
    cwd: root,
    permission_mode: "default",
    hook_event_name: "Stop",
    stop_hook_active: false,
    ...fields,
  });
}

function reflect(stdin: string): BundleResult {
  return runBundleSync(["reflect", "--hook-stdin", "--root", root], { home: memHome, stdin });
}

function pendingCount(): number {
  const listed = runBundleSync(["list", "--status", "pending", "--json"], { home: memHome });
  return (JSON.parse(listed.stdout) as { facts: unknown[] }).facts.length;
}

describe("mem reflect --hook-stdin (built bundle, Stop envelope on stdin)", () => {
  it("files the session's new suggestion and blocks the stop with the worklist as the reason", () => {
    writeTranscript(["Never commit generated files to the repository."]);
    const result = reflect(stopEnvelope());
    expect(result.exitCode, result.stderr).toBe(0);
    const decision = JSON.parse(result.stdout) as { decision: string; reason: string };
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("Never commit generated files to the repository.");
    expect(decision.reason).toContain("mem review --promote <id>");
    expect(pendingCount()).toBe(1);
  });

  it("stays silent on the next stop once the same statements were already filed", () => {
    // The dedupe is the store itself: a restated sentence is a sighting of the existing pending
    // fact, not a new one, so there is nothing new to block on and no extra state to keep.
    writeTranscript(["Never commit generated files to the repository."]);
    expect(reflect(stopEnvelope()).stdout).not.toBe("");
    const again = reflect(stopEnvelope());
    expect(again.exitCode, again.stderr).toBe(0);
    expect(again.stdout).toBe("");
  });

  it("never blocks, and files nothing, while stop_hook_active says a Stop hook already continued the agent", () => {
    writeTranscript(["Never commit generated files to the repository."]);
    const result = reflect(stopEnvelope({ stop_hook_active: true }));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    // Filing now would mean the next real stop never prompts for these; leave them for it.
    expect(pendingCount()).toBe(0);
  });

  it("stays silent when the transcript holds nothing durable", () => {
    writeTranscript(["Can you look at the failing test?"]);
    const result = reflect(stopEnvelope());
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("fails open, silently, on an envelope without a transcript_path or naming a missing file", () => {
    for (const stdin of [JSON.stringify({ session_id: "s1", hook_event_name: "Stop" }), stopEnvelope({ transcript_path: join(root, "gone.jsonl") }), ""]) {
      const result = reflect(stdin);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }
  });
});
