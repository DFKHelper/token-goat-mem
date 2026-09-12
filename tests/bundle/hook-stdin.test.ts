/**
 * `mem recall --hint-format --hook-stdin [--delta]` driven exactly the way a Claude Code hook drives
 * it: the built `dist/token-goat-mem.mjs` as a real subprocess, with the hook's JSON envelope piped
 * to stdin. The in-process `run()` tests cannot cover this path -- `process.stdin` there is
 * vitest's, not a pipe -- so this file is the only place the stdin contract is exercised as shipped.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BUNDLE = fileURLToPath(new URL("../../dist/token-goat-mem.mjs", import.meta.url));

interface BundleResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

let memHome: string;
let root: string;

/** Runs the bundle against an isolated mem home with `stdin` piped in, capturing both streams (on exit 0 too -- a fail-open note on stderr is part of what this file asserts) and the exit code. */
function runBundle(args: readonly string[], stdin = ""): BundleResult {
  const result = spawnSync(process.execPath, [BUNDLE, ...args], {
    encoding: "utf8",
    // No truncation budget: under a loaded runner the 150ms default blows and the seam returns an
    // empty hint set by design, which would turn every selection assertion here into a timing one.
    env: { ...process.env, TOKEN_GOAT_MEM_HOME: memHome, TOKEN_GOAT_MEM_RETRIEVAL_BUDGET_MS: "3600000" },
    input: stdin,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
}

/** The `id=` values of the TGMEM fact-lines in `stdout`, in order. */
function emittedIds(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => /^(pref|dec|fact|corr) {2}/u.test(line))
    .map((line) => line.split("  ")[2]?.replace(/^id=/u, "") ?? "");
}

function headerOf(stdout: string): string {
  return stdout.split("\n")[0] ?? "";
}

/** The TGMEM/2 footer-line, if one was emitted. */
function footerOf(stdout: string): string | undefined {
  return stdout.split("\n").find((line) => line.startsWith("footer  "));
}

function remember(text: string): string {
  const result = runBundle(["remember", text, "--kind", "fact", "--scope", "global"]);
  expect(result.exitCode, result.stderr).toBe(0);
  const match = /remembered (?:\S+ )?fact (\S+)/u.exec(result.stdout);
  expect(match?.[1]).toBeDefined();
  return match?.[1] ?? "";
}

function envelope(fields: Record<string, unknown>): string {
  return JSON.stringify({
    transcript_path: join(root, "transcript.jsonl"),
    cwd: root,
    permission_mode: "default",
    ...fields,
  });
}

beforeEach(() => {
  memHome = mkdtempSync(join(tmpdir(), "mem-hook-home-"));
  root = mkdtempSync(join(tmpdir(), "mem-hook-root-"));
});

afterEach(() => {
  rmSync(memHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("mem recall --hint-format --hook-stdin (built bundle, envelope on stdin)", () => {
  it("uses the envelope's prompt as the query: the ranking changes against the same store with no query", () => {
    const giraffe = remember("older fact about a distinctive giraffe topic");
    const oranges = remember("unrelated newer fact about oranges");

    // No query: recency order, the later-remembered fact first.
    const unranked = runBundle(["recall", "--hint-format", "--root", root]);
    expect(unranked.exitCode, unranked.stderr).toBe(0);
    expect(headerOf(unranked.stdout)).toBe("TGMEM/2");
    expect(emittedIds(unranked.stdout)).toEqual([oranges, giraffe]);

    // A UserPromptSubmit envelope about giraffes: BM25 puts the matching, older fact first.
    const ranked = runBundle(
      ["recall", "--hint-format", "--hook-stdin", "--root", root],
      envelope({ session_id: "sess-rank", hook_event_name: "UserPromptSubmit", prompt: "what did we decide about the giraffe?" })
    );
    expect(ranked.exitCode, ranked.stderr).toBe(0);
    expect(headerOf(ranked.stdout)).toBe("TGMEM/2");
    expect(emittedIds(ranked.stdout)).toEqual([giraffe, oranges]);
  });

  it("--delta: the second recall in a session omits what the first surfaced, and a non-delta call in the same session still returns everything", () => {
    const first = remember("first fact about apples");
    const second = remember("second fact about bananas");
    const opener = envelope({ session_id: "sess-delta", hook_event_name: "SessionStart", source: "startup" });
    const prompt = envelope({ session_id: "sess-delta", hook_event_name: "UserPromptSubmit", prompt: "anything regarding fruit" });

    // What the installed SessionStart hook runs: full set, logged under the session.
    const sessionStart = runBundle(["recall", "--hint-format", "--hook-stdin", "--root", root], opener);
    expect(sessionStart.exitCode, sessionStart.stderr).toBe(0);
    expect(headerOf(sessionStart.stdout)).toBe("TGMEM/2");
    expect(emittedIds(sessionStart.stdout)).toEqual([second, first]);

    // What the installed UserPromptSubmit hook runs: nothing new yet -> header only, no footer.
    const delta = runBundle(["recall", "--hint-format", "--hook-stdin", "--delta", "--root", root], prompt);
    expect(delta.exitCode, delta.stderr).toBe(0);
    expect(delta.stdout).toBe("TGMEM/2  delta=1\n");

    // A fact captured mid-session is the only thing the next prompt's delta carries.
    const third = remember("third fact about cherries");
    const nextDelta = runBundle(["recall", "--hint-format", "--hook-stdin", "--delta", "--root", root], prompt);
    expect(nextDelta.exitCode, nextDelta.stderr).toBe(0);
    expect(headerOf(nextDelta.stdout)).toBe("TGMEM/2  delta=1");
    expect(emittedIds(nextDelta.stdout)).toEqual([third]);

    // A prompt that matches an already-sent fact re-sends it: "sent" is not "still in context" once
    // the host has compacted, so a genuine hit must arrive every time it is asked for.
    const exact = runBundle(
      ["recall", "--hint-format", "--hook-stdin", "--delta", "--root", root],
      envelope({ session_id: "sess-delta", hook_event_name: "UserPromptSubmit", prompt: "bananas please" })
    );
    expect(exact.exitCode, exact.stderr).toBe(0);
    expect(headerOf(exact.stdout)).toBe("TGMEM/2  delta=1");
    expect(emittedIds(exact.stdout)).toEqual([second]);

    // Non-firing: the same session, without --delta, still gets the complete block under a plain header.
    const full = runBundle(["recall", "--hint-format", "--hook-stdin", "--root", root], prompt);
    expect(full.exitCode, full.stderr).toBe(0);
    expect(headerOf(full.stdout)).toBe("TGMEM/2");
    const fullIds = emittedIds(full.stdout);
    expect(fullIds.length).toBeGreaterThan(0);
    expect([...fullIds].sort()).toEqual([first, second, third].sort());
  });

  it("fails open: a malformed envelope under --hook-stdin --delta exits 0 with the full unranked block and a stderr note", () => {
    const id = remember("a fact that must still surface");

    const malformed = runBundle(["recall", "--hint-format", "--hook-stdin", "--delta", "--root", root], "this is not json {");
    expect(malformed.exitCode).toBe(0);
    expect(headerOf(malformed.stdout)).toBe("TGMEM/2");
    expect(emittedIds(malformed.stdout)).toEqual([id]);
    expect(malformed.stderr).toContain("--delta ignored");

    // An envelope with no session_id at all degrades the same way.
    const noSession = runBundle(
      ["recall", "--hint-format", "--hook-stdin", "--delta", "--root", root],
      envelope({ hook_event_name: "UserPromptSubmit", prompt: "hello" })
    );
    expect(noSession.exitCode).toBe(0);
    expect(headerOf(noSession.stdout)).toBe("TGMEM/2");
    expect(emittedIds(noSession.stdout)).toEqual([id]);

    // A closed, empty pipe (a host that wrote nothing) is the plain query-less recall.
    const empty = runBundle(["recall", "--hint-format", "--hook-stdin", "--root", root], "");
    expect(empty.exitCode).toBe(0);
    expect(empty.stderr).toBe("");
    expect(emittedIds(empty.stdout)).toEqual([id]);
  });

  it("--delta with neither --hook-stdin nor --session-id is a usage error, never a silent full response", () => {
    remember("a fact");
    const result = runBundle(["recall", "--hint-format", "--delta", "--root", root]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--delta requires a session id");
  });

  it("an explicit --session-id is honoured by the bundle and overrides the envelope's", () => {
    const id = remember("a fact");
    const seed = runBundle(["recall", "--hint-format", "--session-id", "explicit", "--root", root]);
    expect(seed.exitCode, seed.stderr).toBe(0);
    expect(emittedIds(seed.stdout)).toEqual([id]);

    const viaEnvelope = runBundle(
      ["recall", "--hint-format", "--hook-stdin", "--delta", "--session-id", "explicit", "--root", root],
      envelope({ session_id: "some-other-session", hook_event_name: "UserPromptSubmit", prompt: "zzz unrelated" })
    );
    expect(viaEnvelope.exitCode, viaEnvelope.stderr).toBe(0);
    expect(viaEnvelope.stdout).toBe("TGMEM/2  delta=1\n");
  });

  it("an envelope carrying a session id prints a footer invocation naming exactly that session, and running it marks the row useful", () => {
    // Regression: the recall footer used to say nothing about `mem used` at all, and the agent-facing
    // guidance told the agent to run it "using the session id you recalled under" -- an id the wire
    // format never carried. This is the fix: the session that logged this recall is now on the wire,
    // in a copy-pasteable command, and running it end to end actually marks the row.
    const id = remember("a fact worth marking useful");
    const result = runBundle(
      ["recall", "--hint-format", "--hook-stdin", "--root", root],
      envelope({ session_id: "sess-mark", hook_event_name: "SessionStart", source: "startup" })
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(emittedIds(result.stdout)).toEqual([id]);

    const footer = footerOf(result.stdout);
    expect(footer).toBeDefined();
    const invocation = /mem used (.+) --session-id (\S+) to mark what helped/u.exec(footer ?? "");
    expect(invocation).not.toBeNull();
    const [, idList, sessionId] = invocation ?? [];
    expect(idList?.split(" ")).toEqual([id]);
    expect(sessionId).toBe("sess-mark");

    // Drive the footer's own printed command back through `mem used`, exactly as an agent copying
    // it would -- proving the handle works, not just that a string was formatted.
    const used = runBundle(["used", ...(idList?.split(" ") ?? []), "--session-id", sessionId ?? ""]);
    expect(used.exitCode, used.stderr).toBe(0);
    expect(used.stdout).toBe(`marked 1 recall row useful in session ${sessionId}\n`);
  });

  it("with no session id known, the footer carries no usefulness invocation", () => {
    // A plain, session-less recall never writes a `recall_log` row (see `markSurfaced` vs
    // `recordSurfaced` in src/integration-seam.ts), so there is nothing a `mem used` call could mark
    // -- printing one anyway would earn the exact "never surfaced in session ..." reply this fix
    // exists to stop producing.
    remember("a fact recalled with no session to log against");
    const result = runBundle(["recall", "--hint-format", "--root", root]);
    expect(result.exitCode, result.stderr).toBe(0);
    const footer = footerOf(result.stdout);
    expect(footer).toBeDefined();
    expect(footer).not.toContain("mem used");
  });
});


describe("mem scan-session --hook-stdin (built bundle, Stop envelope on stdin)", () => {
  /** Writes the transcript at the path `envelope()` already points every envelope at. */
  function writeTranscript(turns: readonly string[]): void {
    writeFileSync(
      join(root, "transcript.jsonl"),
      turns.map((text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })).join("\n"),
      "utf8"
    );
  }

  it("takes transcript_path from the envelope and files the match as pending", () => {
    writeTranscript(["Never commit generated files to the repository."]);
    const result = runBundle(
      ["scan-session", "--hook-stdin", "--root", root],
      envelope({ session_id: "s1", hook_event_name: "Stop", stop_hook_active: false })
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("filed 1 pending suggestion");

    const listed = runBundle(["list", "--status", "pending", "--json"]);
    const facts = (JSON.parse(listed.stdout) as { facts: { text: string; status: string }[] }).facts;
    expect(facts).toHaveLength(1);
    expect(facts[0]?.status).toBe("pending");
  });

  it("stays silent and exits 0 under --quiet, the shape mem init installs", () => {
    writeTranscript(["Always run the linter before pushing."]);
    const result = runBundle(
      ["scan-session", "--hook-stdin", "--quiet", "--root", root],
      envelope({ session_id: "s1", hook_event_name: "Stop", stop_hook_active: false })
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    const listed = runBundle(["list", "--status", "pending", "--json"]);
    expect((JSON.parse(listed.stdout) as { facts: unknown[] }).facts).toHaveLength(1);
  });

  it("exits 1 with a usage error when the envelope carries no transcript_path", () => {
    // The hook shape always supplies one; a bare invocation must say so rather than scan nothing
    // and report success, which would look identical to a session with no durable statements.
    const result = runBundle(["scan-session", "--hook-stdin", "--root", root], JSON.stringify({ session_id: "s1", hook_event_name: "Stop" }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--transcript");
  });
});
