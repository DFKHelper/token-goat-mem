/**
 * End-to-end tests for a fact's optional `why`: the rationale behind a decision or correction.
 *
 * A stored decision without its reason is the one a later session is most tempted to relitigate --
 * "uses esbuild" invites "why not tsc?", where "uses esbuild (why: tsc cannot emit one ESM bundle)"
 * answers it. Driven through the real `run()` against a real database.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractRememberedId, runCli } from "./support/cli.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-why-home-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  rmSync(home, { recursive: true, force: true });
});

const REASON = "tsc cannot emit a single ESM bundle";

async function rememberDecision(extra: readonly string[] = []): Promise<string> {
  const result = await runCli(["remember", "the build uses esbuild", "--kind", "decision", ...extra]);
  expect(result.exitCode).toBe(0);
  return extractRememberedId(result);
}

interface ShownJson {
  readonly fact: { readonly why: string | null };
}

async function shownWhy(id: string): Promise<string | null> {
  const shown = await runCli(["show", id, "--json"]);
  expect(shown.exitCode).toBe(0);
  return (JSON.parse(shown.stdout) as ShownJson).fact.why;
}

describe("fact why (rationale)", () => {
  it("round-trips through `mem remember --why` into `mem show` and `mem show --json`", async () => {
    const id = await rememberDecision(["--why", REASON]);

    const shown = await runCli(["show", id]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toContain(`why: ${REASON}`);
    expect(await shownWhy(id)).toBe(REASON);
  });

  it("is optional: a fact captured without one shows `why: (none)` and a null JSON field", async () => {
    const id = await rememberDecision();
    expect((await runCli(["show", id])).stdout).toContain("why: (none)");
    expect(await shownWhy(id)).toBeNull();
  });

  it("is carried by `mem suggest` onto the pending fact", async () => {
    const suggested = await runCli(["suggest", "the build uses esbuild", "--kind", "decision", "--why", REASON]);
    expect(suggested.exitCode).toBe(0);
    const id = /(\S+) \(pending\)/u.exec(suggested.stdout)?.[1] ?? "";
    expect(await shownWhy(id)).toBe(REASON);
  });

  it("rejects an empty or over-long --why at capture", async () => {
    const empty = await runCli(["remember", "the build uses esbuild", "--kind", "decision", "--why", "  "]);
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain("--why");

    const tooLong = await runCli(["remember", "the build uses esbuild", "--kind", "decision", "--why", "x".repeat(501)]);
    expect(tooLong.exitCode).toBe(1);
    expect(tooLong.stderr).toContain("exceeds 500 characters");
  });

  it("is secret-screened like every other stored field", async () => {
    const blocked = await runCli([
      "remember",
      "deploys go through the release bot",
      "--kind",
      "decision",
      "--why",
      "the bot holds AKIAIOSFODNN7EXAMPLE",
    ]);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain("secret");
    expect((await runCli(["list"])).stdout).toBe("no facts stored\n");
  });

  it("is replaced when the same fact is restated with a new reason, and kept when restated without one", async () => {
    const id = await rememberDecision(["--why", "first reason"]);

    const restated = await runCli(["remember", "the build uses esbuild", "--kind", "decision", "--why", REASON]);
    expect(restated.exitCode).toBe(0);
    expect(restated.stdout).toContain(`reaffirmed decision fact ${id}`);
    expect(await shownWhy(id)).toBe(REASON);
    expect((await runCli(["log", "--fact", id])).stdout).toContain("why updated");

    expect((await runCli(["remember", "the build uses esbuild", "--kind", "decision"])).exitCode).toBe(0);
    expect(await shownWhy(id)).toBe(REASON);
  });

  // `--force` because `mem remember` stores a source_type=user fact, and a reason is part of what
  // the user stated: amending it goes through the same guard as any other field.
  it("is set by `mem edit --why`, cleared by an empty --why, and restored by `mem edit --undo`", async () => {
    const id = await rememberDecision(["--why", "first reason"]);

    expect((await runCli(["edit", id, "--why", REASON, "--force"])).exitCode).toBe(0);
    expect(await shownWhy(id)).toBe(REASON);
    expect((await runCli(["log", "--fact", id, "--event", "edit"])).stdout).toContain("why");

    expect((await runCli(["edit", id, "--why", "", "--force"])).exitCode).toBe(0);
    expect(await shownWhy(id)).toBeNull();

    expect((await runCli(["edit", id, "--undo"])).exitCode).toBe(0);
    expect(await shownWhy(id)).toBe(REASON);
  });

  it("blocks a secret in `mem edit --why` and leaves the stored reason untouched", async () => {
    const id = await rememberDecision(["--why", REASON]);
    const edited = await runCli(["edit", id, "--why", "the key is AKIAIOSFODNN7EXAMPLE", "--force"]);
    expect(edited.exitCode).toBe(1);
    expect(edited.stderr).toContain("secret");
    expect(await shownWhy(id)).toBe(REASON);
  });

  it("survives `mem export` / `mem import --from-json` into a fresh store", async () => {
    const id = await rememberDecision(["--why", REASON]);
    const exported = await runCli(["export"]);
    expect(exported.exitCode).toBe(0);
    const exportDir = mkdtempSync(join(tmpdir(), "mem-why-export-"));
    const jsonPath = join(exportDir, "export.json");
    writeFileSync(jsonPath, exported.stdout, "utf8");

    const targetHome = mkdtempSync(join(tmpdir(), "mem-why-target-"));
    process.env["TOKEN_GOAT_MEM_HOME"] = targetHome;
    try {
      expect((await runCli(["import", "--from-json", jsonPath])).exitCode).toBe(0);
      expect(await shownWhy(id)).toBe(REASON);
    } finally {
      process.env["TOKEN_GOAT_MEM_HOME"] = home;
      rmSync(targetHome, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("rides along on the recalled display line, so the agent reading it sees the reason too", async () => {
    await rememberDecision(["--why", REASON]);
    const recalled = await runCli(["recall", "--hint-format", "--root", home]);
    expect(recalled.exitCode).toBe(0);
    expect(recalled.stdout).toContain(`why: ${REASON}`);
  });
});
