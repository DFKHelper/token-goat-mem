/** End-to-end tests for `mem review --promote <id> --subject <key> --value <value>`: keying a suggested fact in the same step that accepts it, so it joins contradiction resolution from its first active moment instead of needing a follow-up `mem edit`. Driven through the real `run()` against a real database. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractRememberedId, extractSuggestedId, runCli } from "./support/cli.js";
import { resolveDbPath } from "../src/db.js";
import { insertFact, openStorage } from "../src/storage.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-review-key-home-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  rmSync(home, { recursive: true, force: true });
});

async function suggest(text: string): Promise<string> {
  const result = await runCli(["suggest", text, "--kind", "fact"]);
  expect(result.exitCode).toBe(0);
  return extractSuggestedId(result);
}

async function show(id: string): Promise<string> {
  const result = await runCli(["show", id]);
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

describe("mem review --promote --subject --value", () => {
  it("keys and activates the fact, with no unkeyed caveat", async () => {
    const id = await suggest("the database backend is postgres");
    const result = await runCli(["review", "--promote", id, "--subject", "database-backend", "--value", "postgres"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`promoted ${id}\n`);
    const shown = await show(id);
    expect(shown).toContain("status: active");
    expect(shown).toContain("subject: database-backend");
    expect(shown).toContain("value: postgres");
  });

  it("records the keying on the promotion's audit row", async () => {
    const id = await suggest("the database backend is postgres");
    expect((await runCli(["review", "--promote", id, "--subject", "database-backend", "--value", "postgres", "--reason", "checked the compose file"])).exitCode).toBe(0);
    const log = await runCli(["log", "--fact", id, "--event", "review_promote"]);
    expect(log.stdout).toMatch(/promoted pending fact to active via explicit review; keyed database-backend=postgres; reason: checked the compose file$/mu);
  });

  it("runs contradiction resolution against the newly keyed fact", async () => {
    const id = await suggest("the database backend is postgres");
    const remembered = await runCli(["remember", "the database backend is mysql", "--kind", "fact", "--subject", "database-backend", "--value", "mysql"]);
    expect(remembered.exitCode).toBe(0);
    const rival = extractRememberedId(remembered);
    expect((await runCli(["review", "--promote", id, "--subject", "database-backend", "--value", "postgres"])).exitCode).toBe(0);
    expect(await show(id)).toContain("status: superseded");
    expect(await show(rival)).toContain("status: active");
  });

  it("leaves a plain promotion unkeyed and caveated", async () => {
    const id = await suggest("the database backend is postgres");
    const result = await runCli(["review", "--promote", id]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`note: ${id} has no subject/value`);
    expect(await show(id)).toContain("subject: (none)");
  });

  it("refuses a key for a contested fact, which already has one", async () => {
    const db = openStorage(resolveDbPath());
    const contested = insertFact(db, { text: "the cache is redis", kind: "fact", subject: "cache", value: "redis", scope: "global", source_type: "user", status: "contested", confidence: 1 });
    db.close();
    const result = await runCli(["review", "--promote", contested.id, "--subject", "cache", "--value", "memcached"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("use `mem edit");
    expect(await show(contested.id)).toContain("status: contested");
  });

  it.each([
    [["--subject", "database-backend"], "--subject and --value must be provided together"],
    [["--value", "postgres"], "--subject and --value must be provided together"],
  ])("refuses %j alone", async (flags, message) => {
    const id = await suggest("the database backend is postgres");
    const result = await runCli(["review", "--promote", id, ...flags]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("refuses a key without --promote", async () => {
    const id = await suggest("the database backend is postgres");
    const result = await runCli(["review", "--reject", id, "--subject", "database-backend", "--value", "postgres"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--subject and --value can only be used with --promote");
    expect(await show(id)).toContain("status: pending");
  });

  it.each([
    ["x".repeat(101), "postgres", "subject exceeds 100 characters"],
    ["database-backend", "x".repeat(501), "value exceeds 500 characters"],
  ])("refuses an over-long key field", async (subject, value, message) => {
    const id = await suggest("the database backend is postgres");
    const result = await runCli(["review", "--promote", id, "--subject", subject, "--value", value]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(message);
    expect(await show(id)).toContain("status: pending");
  });

  it("refuses a value that looks like a secret and leaves the fact pending", async () => {
    const id = await suggest("the deploy key is configured");
    const result = await runCli(["review", "--promote", id, "--subject", "deploy-key", "--value", "AKIAIOSFODNN7EXAMPLE"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("possible secret detected");
    const shown = await show(id);
    expect(shown).toContain("status: pending");
    expect(shown).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
