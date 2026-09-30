/**
 * End-to-end tests for `mem review --reason <text>`.
 *
 * A review decision is the one moment a human explains why a withheld fact is kept or dropped; the
 * reason rides on that transition's audit row so `mem log` answers "why was this rejected?" later,
 * without a second fact to keep in sync. Driven through the real `run()` against a real database.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "./support/cli.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-review-reason-home-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  rmSync(home, { recursive: true, force: true });
});

async function suggest(text: string): Promise<string> {
  const result = await runCli(["suggest", text, "--kind", "preference"]);
  expect(result.exitCode).toBe(0);
  const id = /suggested \S+ fact (\S+) \(pending\)/u.exec(result.stdout)?.[1];
  expect(id).toBeDefined();
  return id as string;
}

/** The `mem log --fact <id> --event <event>` detail lines for one fact. */
async function auditDetails(id: string, event: string): Promise<string[]> {
  const result = await runCli(["log", "--fact", id, "--event", event]);
  expect(result.exitCode).toBe(0);
  return result.stdout.split("\n").filter((line) => line.startsWith("["));
}

describe("mem review --reason", () => {
  it("records the reason on the promotion's audit row", async () => {
    const id = await suggest("prefer vitest workspaces");
    const result = await runCli(["review", "--promote", id, "--reason", "confirmed with the team"]);
    expect(result.exitCode).toBe(0);
    const [line] = await auditDetails(id, "review_promote");
    expect(line).toMatch(/promoted pending fact to active via explicit review; reason: confirmed with the team$/u);
  });

  it("records the reason on the rejection's audit row", async () => {
    const id = await suggest("prefer tabs over spaces");
    const result = await runCli(["review", "--reject", id, "--reason", "  the repo formatter says spaces  "]);
    expect(result.exitCode).toBe(0);
    const [line] = await auditDetails(id, "review_reject");
    expect(line).toMatch(/via explicit review; reason: the repo formatter says spaces$/u);
  });

  it("records the reason on the undo's audit row", async () => {
    const id = await suggest("prefer pnpm");
    expect((await runCli(["review", "--reject", id])).exitCode).toBe(0);
    const result = await runCli(["review", "--undo", id, "--reason", "rejected the wrong fact"]);
    expect(result.exitCode).toBe(0);
    const [line] = await auditDetails(id, "review_undo");
    expect(line).toMatch(/restored to pending; reason: rejected the wrong fact$/u);
  });

  it("leaves the audit detail unchanged when no reason is given", async () => {
    const id = await suggest("prefer npm scripts");
    expect((await runCli(["review", "--promote", id])).exitCode).toBe(0);
    const [line] = await auditDetails(id, "review_promote");
    expect(line).toMatch(/promoted pending fact to active via explicit review$/u);
  });

  it("refuses --reason without an action to attach it to", async () => {
    const result = await runCli(["review", "--reason", "orphaned"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--reason requires --promote, --reject, or --undo");
  });

  it("refuses an empty reason without changing the fact", async () => {
    const id = await suggest("prefer yarn");
    const result = await runCli(["review", "--promote", id, "--reason", "   "]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("reason (--reason), if provided, must not be empty");
    expect((await runCli(["list", "--status", "pending"])).stdout).toContain(id);
  });

  it("refuses an over-long reason", async () => {
    const id = await suggest("prefer bun");
    const result = await runCli(["review", "--reject", id, "--reason", "x".repeat(501)]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("reason exceeds 500 characters");
  });

  it("refuses a reason that looks like a secret, since the audit log persists it", async () => {
    const id = await suggest("prefer deno");
    const result = await runCli(["review", "--reject", id, "--reason", "key was AKIAIOSFODNN7EXAMPLE"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("possible secret detected");
    expect((await runCli(["list", "--status", "pending"])).stdout).toContain(id);
    const blocked = await runCli(["log", "--event", "review_blocked_secret"]);
    expect(blocked.stdout).toMatch(/review_blocked_secret: blocked: reason\//u);
    expect(blocked.stdout).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
