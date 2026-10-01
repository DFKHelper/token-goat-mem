/** End-to-end tests for `mem doctor`'s why-coverage line. A decision or correction without a `why` is the kind a later session relitigates, and nothing else in the CLI says how many of them there are. The line counts only what can reach a session (active or pinned): a withheld or superseded fact's missing reason costs nothing. Driven through the real `run()` against a real database. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractRememberedId, runCli } from "./support/cli.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-doctor-why-home-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  rmSync(home, { recursive: true, force: true });
});

async function remember(text: string, kind: string, ...extra: string[]): Promise<string> {
  const result = await runCli(["remember", text, "--kind", kind, ...extra]);
  expect(result.exitCode).toBe(0);
  return extractRememberedId(result);
}

async function whyLine(): Promise<string | undefined> {
  const result = await runCli(["doctor"]);
  expect(result.exitCode).toBe(0);
  return result.stdout.split("\n").find((line) => line.startsWith("why coverage:"));
}

describe("mem doctor why coverage", () => {
  it("reads as not applicable on a store with no decisions or corrections", async () => {
    await remember("the api is versioned under /v2", "fact");
    expect(await whyLine()).toBe("why coverage: n/a -- no active or pinned decisions or corrections");
  });

  it("counts decisions and corrections that carry a reason, and names the fix for the rest", async () => {
    await remember("use pnpm workspaces", "decision", "--why", "the monorepo already depends on them");
    await remember("tests run against a real database", "correction");
    await remember("prefer tabs", "preference");
    expect(await whyLine()).toBe(
      'why coverage: 1/2 active or pinned decisions and corrections carry a reason (add one with `mem edit <id> --why "<reason>"`)'
    );
  });

  it("includes pinned facts and drops the hint once every one has a reason", async () => {
    const id = await remember("ship from master", "decision", "--why", "no release branches yet");
    expect((await runCli(["pin", id])).exitCode).toBe(0);
    await remember("never add commit trailers", "correction", "--why", "the maintainer asked");
    expect(await whyLine()).toBe("why coverage: 2/2 active or pinned decisions and corrections carry a reason");
  });

  it("ignores facts a session never receives", async () => {
    const id = await remember("use yarn", "decision");
    expect((await runCli(["forget", id])).exitCode).toBe(0);
    expect(await whyLine()).toBe("why coverage: n/a -- no active or pinned decisions or corrections");
  });
});
