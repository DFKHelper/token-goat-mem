/** `mem recall --hint-format --hook-stdin [--delta]` driven exactly the way a Claude Code hook drives it: the built `dist/token-goat-mem.mjs` as a real subprocess, with the hook's JSON envelope piped to stdin. The in-process `run()` tests cannot cover this path -- `process.stdin` there is vitest's, not a pipe -- so this file is the only place the stdin contract is exercised as shipped. The store is seeded in-process: what the delta filter and the ranking do with a session's facts is pinned in tests/unit/integration-seam.test.ts, so each spawn here exists to show what only the bundle's stdin, stdout and exit code add. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { countFactsWithStatus, logSurfacedInSession, runBundleSync, seedFacts, type BundleResult } from "../support/bundle.js";
import { runCli } from "../support/cli.js";

let memHome: string;
let root: string;

/** Runs the bundle against an isolated mem home with `stdin` piped in, capturing both streams (on exit 0 too -- a fail-open note on stderr is part of what this file asserts) and the exit code. */
function runBundle(args: readonly string[], stdin = ""): BundleResult {
  // No truncation budget: under a loaded runner the 150ms default blows and the seam returns an empty hint set by design, which would turn every selection assertion here into a timing one.
  return runBundleSync(args, { home: memHome, stdin, env: { TOKEN_GOAT_MEM_RETRIEVAL_BUDGET_MS: "3600000" } });
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
  vi.unstubAllEnvs();
  rmSync(memHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("mem recall --hint-format --hook-stdin (built bundle, envelope on stdin)", () => {
  it("uses the envelope's prompt as the query: the matching fact leads although it is the older one", () => {
    // Seeded oldest first, so with no query the recency order would be [oranges, giraffe]; only the prompt read from stdin can put the older, matching fact first.
    const [giraffe = "", oranges = ""] = seedFacts(memHome, ["older fact about a distinctive giraffe topic", "unrelated newer fact about oranges"]);

    const ranked = runBundle(
      ["recall", "--hint-format", "--hook-stdin", "--root", root],
      envelope({ session_id: "sess-rank", hook_event_name: "UserPromptSubmit", prompt: "what did we decide about the giraffe?" })
    );
    expect(ranked.exitCode, ranked.stderr).toBe(0);
    expect(headerOf(ranked.stdout)).toBe("TGMEM/2");
    expect(emittedIds(ranked.stdout)).toEqual([giraffe, oranges]);
  });

  describe("--delta, with the session already shown the store in-process (the delta filter itself is pinned in tests/unit/integration-seam.test.ts)", () => {
    const prompt = (): string => envelope({ session_id: "sess-delta", hook_event_name: "UserPromptSubmit", prompt: "anything regarding fruit" });

    it("a recall in a session that has already been shown the store is header only, with no footer", async () => {
      seedFacts(memHome, ["first fact about apples", "second fact about bananas"]);
      expect(await logSurfacedInSession(memHome, root, "sess-delta")).toBe(2);

      // What the installed UserPromptSubmit hook runs: nothing new yet.
      const delta = runBundle(["recall", "--hint-format", "--hook-stdin", "--delta", "--root", root], prompt());
      expect(delta.exitCode, delta.stderr).toBe(0);
      expect(delta.stdout).toBe("TGMEM/2  delta=1\n");
    });

    it("a fact captured after the session was shown the store is all the next delta carries", async () => {
      seedFacts(memHome, ["first fact about apples", "second fact about bananas"]);
      expect(await logSurfacedInSession(memHome, root, "sess-delta")).toBe(2);
      const [third = ""] = seedFacts(memHome, ["third fact about cherries"]);

      const delta = runBundle(["recall", "--hint-format", "--hook-stdin", "--delta", "--root", root], prompt());
      expect(delta.exitCode, delta.stderr).toBe(0);
      expect(headerOf(delta.stdout)).toBe("TGMEM/2  delta=1");
      expect(emittedIds(delta.stdout)).toEqual([third]);
    });
  });

  // One spawn per row: the stdin a host can send that is not a usable envelope, each degrading to the full unranked block.
  it.each([
    { name: "a malformed envelope under --delta, with a stderr note", args: ["--delta"], stdin: () => "this is not json {", stderrContains: "--delta ignored" },
    { name: "an envelope with no session_id at all under --delta", args: ["--delta"], stdin: () => envelope({ hook_event_name: "UserPromptSubmit", prompt: "hello" }), stderrContains: undefined },
    { name: "a closed, empty pipe (a host that wrote nothing), silently", args: [], stdin: () => "", stderrContains: "" },
  ])("fails open: $name exits 0 with the full unranked block", ({ args, stdin, stderrContains }) => {
    const [id = ""] = seedFacts(memHome, ["a fact that must still surface"]);

    const result = runBundle(["recall", "--hint-format", "--hook-stdin", ...args, "--root", root], stdin());
    expect(result.exitCode, result.stderr).toBe(0);
    expect(headerOf(result.stdout), "no delta header: the envelope could not scope a session").toBe("TGMEM/2");
    expect(emittedIds(result.stdout)).toEqual([id]);
    if (stderrContains === "") {
      expect(result.stderr, "an empty pipe is the plain query-less recall, not a degraded one").toBe("");
    } else if (stderrContains !== undefined) {
      expect(result.stderr).toContain(stderrContains);
    }
  });

  it("an explicit --session-id is honoured by the bundle and overrides the envelope's", async () => {
    const [id = ""] = seedFacts(memHome, ["a fact"]);
    // The session the explicit id names has already been shown the store; the envelope's own session has not.
    expect(await logSurfacedInSession(memHome, root, "explicit")).toBe(1);

    const viaEnvelope = runBundle(
      ["recall", "--hint-format", "--hook-stdin", "--delta", "--session-id", "explicit", "--root", root],
      envelope({ session_id: "some-other-session", hook_event_name: "UserPromptSubmit", prompt: "zzz unrelated" })
    );
    expect(viaEnvelope.exitCode, viaEnvelope.stderr).toBe(0);
    expect(viaEnvelope.stdout, `the envelope's session would have re-sent ${id}`).toBe("TGMEM/2  delta=1\n");
  });

  it("an envelope carrying a session id prints a footer invocation naming exactly that session, and running it marks the row useful", async () => {
    // Regression: the recall footer used to say nothing about `mem used` at all, and the agent-facing guidance told the agent to run it "using the session id you recalled under" -- an id the wire format never carried. This is the fix: the session that logged this recall is now on the wire, in a copy-pasteable command, and running it end to end actually marks the row.
    const [id = ""] = seedFacts(memHome, ["a fact worth marking useful"]);
    const result = runBundle(
      ["recall", "--hint-format", "--hook-stdin", "--root", root],
      envelope({ session_id: "sess-mark", hook_event_name: "SessionStart", source: "startup" })
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(emittedIds(result.stdout)).toEqual([id]);

    const footer = footerOf(result.stdout);
    expect(footer).toBeDefined();
    const invocation = /mark only the facts that informed the work: mem used (.+) --session-id (\S+)$/u.exec(footer ?? "");
    expect(invocation).not.toBeNull();
    const [, idList, sessionId] = invocation ?? [];
    expect(idList?.split(" ")).toEqual([id]);
    expect(sessionId).toBe("sess-mark");

    // Drive the footer's own printed command back through `mem used`, exactly as an agent copying it would -- proving the handle works, not just that a string was formatted. In this process: `used` takes no stdin, so a second spawn would add a cold start and no bundle-specific coverage; the row it marks was written by the spawn above.
    vi.stubEnv("TOKEN_GOAT_MEM_HOME", memHome);
    const used = await runCli(["used", ...(idList?.split(" ") ?? []), "--session-id", sessionId ?? ""]);
    expect(used.exitCode ?? 0, used.stderr).toBe(0);
    expect(used.stdout).toBe(`marked 1 recall row useful in session ${sessionId}\n`);
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
    expect(countFactsWithStatus(memHome, "pending")).toBe(1);
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
    expect(countFactsWithStatus(memHome, "pending")).toBe(1);
  });

  it("exits 1 with a usage error when the envelope carries no transcript_path", () => {
    // The hook shape always supplies one; a bare invocation must say so rather than scan nothing and report success, which would look identical to a session with no durable statements.
    const result = runBundle(["scan-session", "--hook-stdin", "--root", root], JSON.stringify({ session_id: "s1", hook_event_name: "Stop" }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--transcript");
  });
});
