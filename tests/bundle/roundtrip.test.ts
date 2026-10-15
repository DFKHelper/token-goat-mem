/** `mem init` / `mem uninstall` driven through the built `dist/token-goat-mem.mjs`, against hand-formatted config files, asserting the file comes back byte-identical. CONTRIBUTING.md's test-tier rule is that a command with no coverage driving the built bundle fails the gate by design, and until this file existed exactly one test in the suite executed the bundle (`mem --version`). Everything else drives `run()` in-process against transformed TS. That gap is not theoretical: the two deepest 0.2.6 defects -- a reinstall that never refreshed a stale shared block, and uninstall leaving behind the containers install had created -- were both found by running the built binary against a real config, not by the suite. The assertions here are on file *bytes*, because the 0.2.6 formatting damage was invisible to a green suite whose every assertion went through `JSON.parse`. One round trip runs the bundle as a process; the repeated runs (a reinstall, containers install created) go through the same `run()` in-process with a scripted probe, since each extra process start is a cold node start that a slow machine pays in full. */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUNDLE_PATH as BUNDLE } from "../support/bundle.js";
import { runCli } from "../support/cli.js";
import { writeCheapCapableMem } from "../support/fakeMem.js";
import { CAPABLE_PROBE, installProbe, resetProbe } from "../support/fakeProbe.js";

// The in-process runs below script every probe of the `mem` binary, so no process starts and no budget decides a verdict.
vi.mock("../../src/probeSpawn.js", async (importOriginal) => (await import("../support/fakeProbe.js")).withFakeProbe(await importOriginal<typeof import("../../src/probeSpawn.js")>()));

// A diagnostic bound under vitest's 30 s testTimeout so a hung bundle fails with its stderr; it is not what makes the test pass.
const SPAWN_TIMEOUT_MS = 25_000;

let root: string;
let memHome: string;
let fakeMemDir: string;

/** Runs the built bundle against an isolated mem home, returning stdout. Throws, with the child's stderr, on a spawn error, a kill or a non-zero exit. */
function runBundle(args: readonly string[]): string {
  const result = spawnSync(process.execPath, [BUNDLE, ...args], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      TOKEN_GOAT_MEM_HOME: memHome,
      // A project install reads the user-level Claude Code hooks, so keep the real ~/.claude out of it.
      TOKEN_GOAT_MEM_WIRING_HOME: memHome,
      PATH: `${fakeMemDir}${delimiter}${process.env["PATH"] ?? ""}`,
    },
  });
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    throw new Error(`mem ${args.join(" ")} did not succeed (error: ${String(result.error?.message)}, signal: ${String(result.signal)}, status: ${String(result.status)}); stderr: ${result.stderr}`);
  }
  return result.stdout;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-bundle-root-"));
  memHome = mkdtempSync(join(tmpdir(), "mem-bundle-home-"));
  fakeMemDir = mkdtempSync(join(tmpdir(), "mem-bundle-fake-bin-"));

  // Provide a capable mem on PATH so `mem init claude-code` passes preflight in CI environments where token-goat-mem is not installed globally; it answers without starting node, so the preflight costs no cold start.
  writeCheapCapableMem(fakeMemDir);
});

afterEach(() => {
  resetProbe();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(memHome, { recursive: true, force: true });
  rmSync(fakeMemDir, { recursive: true, force: true });
});

describe("init/uninstall round trip through the built bundle", () => {
  it("returns a hand-formatted settings.json and a CRLF CLAUDE.md to their exact bytes", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const settingsPath = join(root, ".claude", "settings.json");
    const claudeMdPath = join(root, "CLAUDE.md");

    // Four-space indent, a hook the user wrote themselves, and a key after the hooks block -- the shape that came back two-space-indented and reordered before 0.2.6.
    const settings = [
      "{",
      '    "hooks": {',
      '        "SessionStart": [',
      '            { "matcher": "*", "hooks": [ { "type": "command", "command": "echo hi" } ] }',
      "        ]",
      "    },",
      '    "theme": "dark"',
      "}",
      "",
    ].join("\n");
    // CRLF throughout, and no trailing newline: install used to hard-code "\n" into the marked block, and uninstall's separator search then never matched, growing a blank line per cycle.
    const claudeMd = "# My notes\r\n\r\nSome prose I wrote.";

    writeFileSync(settingsPath, settings);
    writeFileSync(claudeMdPath, claudeMd);

    runBundle(["init", "claude-code", "--root", root]);

    // Sanity: the install actually happened, so a byte-identical result below means "reversed", not "never wrote anything".
    expect(readFileSync(settingsPath, "utf8")).not.toBe(settings);
    expect(readFileSync(claudeMdPath, "utf8")).not.toBe(claudeMd);

    runBundle(["uninstall", "claude-code", "--root", root]);

    expect(readFileSync(settingsPath, "utf8")).toBe(settings);
    expect(readFileSync(claudeMdPath, "utf8")).toBe(claudeMd);
  });
});

describe("init/uninstall round trip in-process", () => {
  beforeEach(() => {
    vi.stubEnv("TOKEN_GOAT_MEM_HOME", memHome);
    vi.stubEnv("TOKEN_GOAT_MEM_WIRING_HOME", memHome);
    vi.stubEnv("PATH", `${fakeMemDir}${delimiter}${process.env["PATH"] ?? ""}`);
    installProbe(CAPABLE_PROBE);
  });

  it("leaves no empty containers behind when it created them itself", async () => {
    // The common case: a settings.json with no hooks at all. Install creates `hooks` and `hooks.SessionStart`; before 0.2.6 uninstall removed the hook group and stopped, leaving a `"hooks": { "SessionStart": [] }` husk that no JSON.parse-based assertion would notice.
    mkdirSync(join(root, ".claude"), { recursive: true });
    const settingsPath = join(root, ".claude", "settings.json");
    const settings = '{\n  "theme": "dark"\n}\n';
    writeFileSync(settingsPath, settings);

    const installed = await runCli(["init", "claude-code", "--root", root]);
    expect(installed.exitCode, installed.stdout + installed.stderr).toBe(0);
    expect(readFileSync(settingsPath, "utf8"), "install wrote its hooks").toContain("hooks");
    const removed = await runCli(["uninstall", "claude-code", "--root", root]);
    expect(removed.exitCode, removed.stdout + removed.stderr).toBe(0);

    const afterUninstall = readFileSync(settingsPath, "utf8");
    expect(afterUninstall).toBe(settings);
    expect(afterUninstall).not.toContain("hooks");
  });

  it("survives a reinstall without duplicating its own block", async () => {
    const claudeMdPath = join(root, "CLAUDE.md");
    writeFileSync(claudeMdPath, "# My notes\n");

    const first = await runCli(["init", "claude-code", "--root", root]);
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);
    const afterFirst = readFileSync(claudeMdPath, "utf8");
    const second = await runCli(["init", "claude-code", "--root", root]);
    expect(second.exitCode, second.stdout + second.stderr).toBe(0);

    expect(readFileSync(claudeMdPath, "utf8")).toBe(afterFirst);
    const starts = afterFirst.match(/<!-- token-goat-mem:claude-code:start -->/gu) ?? [];
    expect(starts).toHaveLength(1);

    const removed = await runCli(["uninstall", "claude-code", "--root", root]);
    expect(removed.exitCode, removed.stdout + removed.stderr).toBe(0);
    expect(readFileSync(claudeMdPath, "utf8")).toBe("# My notes\n");
  });
});
