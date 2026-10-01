/** End-to-end tests for `mem log`: the store-wide audit timeline. `mem show <id>` already reads one fact's history back; `mem log` is the same trail across the whole store, newest first, so "what did the agent change in my memory this week?" has an answer without knowing a fact id first. Driven through the real `run()` against a real database. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { insertAuditLog } from "../src/db.js";
import { deleteFact, openStorage } from "../src/storage.js";
import { extractRememberedId, runCli } from "./support/cli.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-timeline-home-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  rmSync(home, { recursive: true, force: true });
});

async function remember(text: string): Promise<string> {
  const result = await runCli(["remember", text, "--kind", "decision"]);
  expect(result.exitCode).toBe(0);
  return extractRememberedId(result);
}

/** The timeline's text lines, without the trailing truncation notice. */
function entryLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.startsWith("["));
}

describe("mem log", () => {
  it("says the audit log is empty on a fresh store", async () => {
    const result = await runCli(["log"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("audit log is empty\n");
  });

  it("lists every fact's events newest first, each with a pasteable short fact id", async () => {
    const first = await remember("the build uses esbuild");
    const second = await remember("releases are cut from master");
    expect((await runCli(["forget", first])).exitCode).toBe(0);

    const result = await runCli(["log"]);
    expect(result.exitCode).toBe(0);
    const lines = entryLines(result.stdout);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(new RegExp(`^\\[[^\\]]+\\] ${first.slice(0, 8)}  forget: `, "u"));
    expect(lines[1]).toMatch(new RegExp(`^\\[[^\\]]+\\] ${second.slice(0, 8)}  capture_explicit: `, "u"));
    expect(lines[2]).toMatch(new RegExp(`^\\[[^\\]]+\\] ${first.slice(0, 8)}  capture_explicit: `, "u"));
  });

  it("narrows to one fact by id prefix", async () => {
    const first = await remember("the build uses esbuild");
    await remember("releases are cut from master");
    const result = await runCli(["log", "--fact", first.slice(0, 8)]);
    expect(result.exitCode).toBe(0);
    const lines = entryLines(result.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(first.slice(0, 8));
  });

  it("still finds a fact's trail after gc has deleted the fact itself", async () => {
    const id = await remember("the build uses esbuild");
    const db = openStorage();
    try {
      deleteFact(db, id);
    } finally {
      db.close();
    }
    expect((await runCli(["show", id])).exitCode).toBe(1);

    const result = await runCli(["log", "--fact", id.slice(0, 8)]);
    expect(result.exitCode).toBe(0);
    expect(entryLines(result.stdout)[0]).toContain("capture_explicit");
  });

  it("reports a prefix shared by a live fact and a deleted one as ambiguous, not as the live one's trail", async () => {
    const id = await remember("the build uses esbuild");
    const deletedTwin = `${id.slice(0, 8)}-0000-4000-8000-000000000000`;
    const db = openStorage();
    try {
      insertAuditLog(db, { event: "forget", factId: deletedTwin, detail: "forgot fact (was active)" });
    } finally {
      db.close();
    }
    const result = await runCli(["log", "--fact", id.slice(0, 8)]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`ambiguous id prefix "${id.slice(0, 8)}" matches 2 facts`);

    const exact = await runCli(["log", "--fact", id]);
    expect(exact.exitCode).toBe(0);
    expect(entryLines(exact.stdout)).toHaveLength(1);
  });

  it("rejects a --fact that names nothing in the store or the log", async () => {
    const result = await runCli(["log", "--fact", "deadbeef"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("mem: no such fact: deadbeef\n");
  });

  it("filters by event name or by event family prefix", async () => {
    const id = await remember("the build uses esbuild");
    expect((await runCli(["forget", id])).exitCode).toBe(0);

    const exact = entryLines((await runCli(["log", "--event", "forget"])).stdout);
    expect(exact).toHaveLength(1);
    expect(exact[0]).toContain("forget: ");

    const family = entryLines((await runCli(["log", "--event", "capture"])).stdout);
    expect(family).toHaveLength(1);
    expect(family[0]).toContain("capture_explicit: ");

    const none = await runCli(["log", "--event", "capt"]);
    expect(none.stdout).toBe("no audit events match these filters\n");
  });

  it("renders a store-level event that names no fact", async () => {
    const db = openStorage();
    try {
      insertAuditLog(db, { event: "json_import", factId: null, detail: "imported 3 facts" });
    } finally {
      db.close();
    }
    const lines = entryLines((await runCli(["log"])).stdout);
    expect(lines[0]).toMatch(/^\[[^\]]+\] -{8} {2}json_import: imported 3 facts$/u);
  });

  it("caps output at --limit and says how much it left out", async () => {
    for (const text of ["one decision", "two decision", "three decision"]) {
      await remember(text);
    }
    const result = await runCli(["log", "--limit", "2"]);
    expect(entryLines(result.stdout)).toHaveLength(2);
    expect(result.stdout).toContain("showing 2 of 3 -- use --limit to see more\n");
  });

  it("drops events older than --age-days", async () => {
    await remember("the build uses esbuild");
    const db = openStorage();
    try {
      db.prepare("UPDATE audit_log SET created_at = ?").run("2000-01-01T00:00:00.000Z");
    } finally {
      db.close();
    }
    await remember("releases are cut from master");
    expect(entryLines((await runCli(["log", "--age-days", "7"])).stdout)).toHaveLength(1);
    expect(entryLines((await runCli(["log"])).stdout)).toHaveLength(2);
  });

  it.each([
    [["--limit", "0"], "mem: --limit must be a positive integer\n"],
    [["--age-days", "0"], "mem: --age-days must be a positive number\n"],
  ])("rejects %j as a usage error", async (flags, message) => {
    const result = await runCli(["log", ...flags]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(message);
  });

  it("emits the same entries as JSON, full fact ids and prior wording included", async () => {
    const id = await remember("the build uses esbuild");
    expect((await runCli(["edit", id, "--text", "the build uses esbuild 0.25", "--force"])).exitCode).toBe(0);

    const result = await runCli(["log", "--json"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      entries: { event: string; factId: string | null; detail: string; createdAt: string; priorJson?: string }[];
      total: number;
      truncated: boolean;
    };
    expect(envelope.total).toBe(2);
    expect(envelope.truncated).toBe(false);
    expect(envelope.entries.map((entry) => entry.event)).toEqual(["edit", "capture_explicit"]);
    expect(envelope.entries[0]?.factId).toBe(id);
    expect(envelope.entries[0]?.priorJson).toContain("the build uses esbuild");
  });
});

describe("mem show history", () => {
  it("renders history lines with the same formatter mem log uses", async () => {
    const id = await remember("the build uses esbuild");
    const result = await runCli(["show", id]);
    expect(result.stdout).toMatch(/\n {2}- \[[^\]]+\] capture_explicit: stored active decision fact \(scope=global\)\n/u);
  });
});
