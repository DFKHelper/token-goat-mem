/**
 * End-to-end tests for `mem reflect`: the pending-suggestion worklist an agent resolves at the end
 * of a session, update-before-create.
 *
 * `mem scan-session` files durable-sounding sentences as pending and stops there; nothing ever
 * asks the agent that said them whether they restate, change, or add to what the store already
 * knows. `mem reflect` lists each pending suggestion beside the live facts it most resembles and
 * spells out the three resolutions. Driven through the real `run()` against a real database; the
 * Stop-hook mode needs piped stdin and lives in tests/bundle/reflect-hook.test.ts.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractRememberedId, extractSuggestedId, runCli } from "./support/cli.js";

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-reflect-home-"));
  root = mkdtempSync(join(tmpdir(), "mem-reflect-root-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function writeTranscript(name: string, turns: readonly string[]): string {
  const path = join(root, name);
  writeFileSync(
    path,
    turns.map((text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })).join("\n"),
    "utf8"
  );
  return path;
}

async function suggest(text: string, projectRoot: string = root): Promise<string> {
  const result = await runCli(["suggest", text, "--kind", "preference", "--scope", "project", "--root", projectRoot]);
  expect(result.exitCode, result.stderr).toBe(0);
  return extractSuggestedId(result);
}

describe("mem reflect", () => {
  it("says there is nothing to reflect on when no suggestion is pending", async () => {
    const result = await runCli(["reflect", "--root", root]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("nothing to reflect on -- no pending suggestions\n");
  });

  it("files a transcript's durable statements and lists each with the update-before-create resolutions", async () => {
    const transcript = writeTranscript("session.jsonl", ["Never commit generated files to the repository."]);
    const result = await runCli(["reflect", "--transcript", transcript, "--root", root]);
    expect(result.exitCode, result.stderr).toBe(0);

    const pending = await runCli(["list", "--status", "pending", "--json"]);
    const facts = (JSON.parse(pending.stdout) as { facts: { id: string; text: string }[] }).facts;
    expect(facts).toHaveLength(1);
    const id = facts[0]?.id ?? "";

    expect(result.stdout).toContain(`${id.slice(0, 8)} [`);
    expect(result.stdout).toContain("Never commit generated files to the repository.");
    // Update comes first: an agent reading top-down meets "change the existing fact" before "add one".
    const edit = result.stdout.indexOf("mem edit <related-id>");
    const promote = result.stdout.indexOf("mem review --promote <id>");
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(promote).toBeGreaterThan(edit);
    expect(result.stdout).toContain('mem review --reject <id> --reason "merged into <related-id>"');
  });

  it("lists the live facts a suggestion most resembles, so the agent can update one instead", async () => {
    const remembered = await runCli([
      "remember",
      "generated files are built by CI and never committed",
      "--kind",
      "decision",
      "--scope",
      "project",
      "--root",
      root,
    ]);
    expect(remembered.exitCode, remembered.stderr).toBe(0);
    const liveId = extractRememberedId(remembered);

    const transcript = writeTranscript("session.jsonl", ["Never commit generated files to the repository."]);
    const result = await runCli(["reflect", "--transcript", transcript, "--root", root]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`related ${liveId.slice(0, 8)} [decision] generated files are built by CI and never committed`);
  });

  it("without --transcript lists every pending suggestion bound to this root and none from another project", async () => {
    const other = mkdtempSync(join(tmpdir(), "mem-reflect-other-"));
    try {
      const here = await suggest("Always run the linter before pushing.");
      const elsewhere = await suggest("Always squash commits before merging.", other);

      const result = await runCli(["reflect", "--root", root]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain(here.slice(0, 8));
      expect(result.stdout).not.toContain(elsewhere.slice(0, 8));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("with --transcript lists only that transcript's suggestions, not the whole pending queue", async () => {
    const unrelated = await suggest("Always squash commits before merging.");
    const transcript = writeTranscript("session.jsonl", ["Never commit generated files to the repository."]);

    const result = await runCli(["reflect", "--transcript", transcript, "--root", root]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Never commit generated files to the repository.");
    expect(result.stdout).not.toContain(unrelated.slice(0, 8));
  });

  it("exits 1 when --transcript names a file it cannot read, rather than reporting nothing to do", async () => {
    const result = await runCli(["reflect", "--transcript", join(root, "missing.jsonl"), "--root", root]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("reflect: cannot read transcript");
  });
});
