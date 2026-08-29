/**
 * `mem init` / `mem uninstall` driven through the built `dist/token-goat-mem.mjs`, against
 * hand-formatted config files, asserting the file comes back byte-identical.
 *
 * CONTRIBUTING.md's test-tier rule is that a command with no coverage driving the built bundle
 * fails the gate by design, and until this file existed exactly one test in the suite executed the
 * bundle (`mem --version`). Everything else drives `run()` in-process against transformed TS.
 *
 * That gap is not theoretical: the two deepest 0.2.6 defects -- a reinstall that never refreshed a
 * stale shared block, and uninstall leaving behind the containers install had created -- were both
 * found by running the built binary against a real config, not by the suite. The assertions here
 * are on file *bytes*, because the 0.2.6 formatting damage was invisible to a green suite whose
 * every assertion went through `JSON.parse`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BUNDLE = fileURLToPath(new URL("../../dist/token-goat-mem.mjs", import.meta.url));

let root: string;
let memHome: string;

/** Runs the built bundle against an isolated mem home, returning stdout. Throws on a non-zero exit. */
function runBundle(args: readonly string[]): string {
  return execFileSync(process.execPath, [BUNDLE, ...args], {
    encoding: "utf8",
    env: { ...process.env, TOKEN_GOAT_MEM_HOME: memHome },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-bundle-root-"));
  memHome = mkdtempSync(join(tmpdir(), "mem-bundle-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(memHome, { recursive: true, force: true });
});

describe("init/uninstall round trip through the built bundle", () => {
  it("returns a hand-formatted settings.json and a CRLF CLAUDE.md to their exact bytes", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const settingsPath = join(root, ".claude", "settings.json");
    const claudeMdPath = join(root, "CLAUDE.md");

    // Four-space indent, a hook the user wrote themselves, and a key after the hooks block -- the
    // shape that came back two-space-indented and reordered before 0.2.6.
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
    // CRLF throughout, and no trailing newline: install used to hard-code "\n" into the marked
    // block, and uninstall's separator search then never matched, growing a blank line per cycle.
    const claudeMd = "# My notes\r\n\r\nSome prose I wrote.";

    writeFileSync(settingsPath, settings);
    writeFileSync(claudeMdPath, claudeMd);

    runBundle(["init", "claude-code", "--root", root]);

    // Sanity: the install actually happened, so a byte-identical result below means "reversed",
    // not "never wrote anything".
    expect(readFileSync(settingsPath, "utf8")).not.toBe(settings);
    expect(readFileSync(claudeMdPath, "utf8")).not.toBe(claudeMd);

    runBundle(["uninstall", "claude-code", "--root", root]);

    expect(readFileSync(settingsPath, "utf8")).toBe(settings);
    expect(readFileSync(claudeMdPath, "utf8")).toBe(claudeMd);
  });

  it("leaves no empty containers behind when it created them itself", () => {
    // The common case: a settings.json with no hooks at all. Install creates `hooks` and
    // `hooks.SessionStart`; before 0.2.6 uninstall removed the hook group and stopped, leaving a
    // `"hooks": { "SessionStart": [] }` husk that no JSON.parse-based assertion would notice.
    mkdirSync(join(root, ".claude"), { recursive: true });
    const settingsPath = join(root, ".claude", "settings.json");
    const settings = '{\n  "theme": "dark"\n}\n';
    writeFileSync(settingsPath, settings);

    runBundle(["init", "claude-code", "--root", root]);
    runBundle(["uninstall", "claude-code", "--root", root]);

    const after = readFileSync(settingsPath, "utf8");
    expect(after).toBe(settings);
    expect(after).not.toContain("hooks");
  });

  it("is a no-op the second time, so a repeated uninstall cannot damage the file", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const settingsPath = join(root, ".claude", "settings.json");
    const settings = '{\n  "theme": "dark"\n}\n';
    writeFileSync(settingsPath, settings);

    runBundle(["init", "claude-code", "--root", root]);
    runBundle(["uninstall", "claude-code", "--root", root]);
    const afterFirst = readFileSync(settingsPath, "utf8");

    // Documented as a no-op rather than an error when there is nothing mem-authored to remove.
    runBundle(["uninstall", "claude-code", "--root", root]);
    expect(readFileSync(settingsPath, "utf8")).toBe(afterFirst);
  });

  it("survives a reinstall without duplicating its own block", () => {
    const claudeMdPath = join(root, "CLAUDE.md");
    writeFileSync(claudeMdPath, "# My notes\n");

    runBundle(["init", "claude-code", "--root", root]);
    const afterFirst = readFileSync(claudeMdPath, "utf8");
    runBundle(["init", "claude-code", "--root", root]);

    expect(readFileSync(claudeMdPath, "utf8")).toBe(afterFirst);
    const starts = afterFirst.match(/<!-- token-goat-mem:claude-code:start -->/gu) ?? [];
    expect(starts).toHaveLength(1);

    runBundle(["uninstall", "claude-code", "--root", root]);
    expect(readFileSync(claudeMdPath, "utf8")).toBe("# My notes\n");
  });
});
