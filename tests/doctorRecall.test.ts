/** End-to-end tests for `mem doctor`'s last-surfacing line: the latest recorded time a fact reached a session, taken from the later of `facts.last_surfaced_at` (never rotated) and `recall_log.surfaced_at` (rotated by `mem epoch --gc`). Driven through the real `run()` against a real database; the pure `describeLastSurfaced` is tested with a fixed clock. */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, resolveDbPath } from "../src/db.js";
import { describeLastSurfaced } from "../src/doctor.js";
import { MIGRATIONS } from "../src/migrations.js";
import { runCli } from "./support/cli.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-doctor-recall-home-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = home;
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  rmSync(home, { recursive: true, force: true });
});

interface RecallFinding {
  readonly check: string;
  readonly status: string;
  readonly message: string;
  readonly remedy?: string;
}

async function recallFinding(): Promise<RecallFinding | undefined> {
  const result = await runCli(["doctor", "--json"]);
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout) as { findings: RecallFinding[] };
  return report.findings.find((entry) => entry.message.startsWith("recall:"));
}

async function surfaceOneFact(): Promise<void> {
  expect((await runCli(["remember", "a fact about apples", "--kind", "fact", "--scope", "global"])).exitCode).toBe(0);
  const recall = await runCli(["recall", "--hint-format", "--session-id", "x", "--root", home]);
  expect(recall.exitCode).toBe(0);
  // Non-firing guard: the fact really was emitted, so the surfacing under test exists.
  expect(recall.stdout).toContain("a fact about apples");
}

function rewriteSurfacing(sql: string): void {
  const db = openDb(resolveDbPath());
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

const TIMESTAMP = /last fact surfaced \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \(/u;

describe("mem doctor last-surfacing line", () => {
  it("names the timestamp of a fact a real recall surfaced", async () => {
    await surfaceOneFact();
    const entry = await recallFinding();
    expect(entry?.status).toBe("ok");
    expect(entry?.check).toBe("store");
    expect(entry?.message).toMatch(TIMESTAMP);
    expect(entry?.message).toContain("recalls that surfaced nothing leave no record");
    expect(entry?.message).not.toContain("\n");
  });

  it("still reports it after the recall_log rows are rotated away", async () => {
    await surfaceOneFact();
    rewriteSurfacing("DELETE FROM recall_log");
    expect((await recallFinding())?.message).toMatch(TIMESTAMP);
  });

  it("falls back to recall_log when facts.last_surfaced_at is NULL", async () => {
    await surfaceOneFact();
    rewriteSurfacing("UPDATE facts SET last_surfaced_at = NULL");
    expect((await recallFinding())?.message).toMatch(TIMESTAMP);
  });

  it("warns when the store has active facts and nothing was ever surfaced", async () => {
    expect((await runCli(["remember", "never recalled", "--kind", "fact", "--scope", "global"])).exitCode).toBe(0);
    const entry = await recallFinding();
    expect(entry?.status).toBe("warn");
    expect(entry?.message).toContain("no fact has been surfaced yet");
    expect(entry?.remedy).toBe("mem init claude-code");
  });

  it("does not warn on an empty store", async () => {
    expect((await runCli(["remember", "short-lived", "--kind", "fact", "--scope", "global"])).exitCode).toBe(0);
    rewriteSurfacing("DELETE FROM facts");
    const entry = await recallFinding();
    expect(entry?.status).toBe("ok");
    expect(entry?.message).toContain("no fact has been surfaced yet");
  });
});

describe("describeLastSurfaced", () => {
  const now = new Date("2026-10-11T12:00:00.000Z");

  it("reports exact ages for minutes, hours, and days", () => {
    const line = (at: string): string | undefined => describeLastSurfaced(at, 3, now)[0]?.message;
    expect(line("2026-10-11T11:30:00.000Z")).toBe("recall: last fact surfaced 2026-10-11T11:30:00.000Z (30m ago; recalls that surfaced nothing leave no record)");
    expect(line("2026-10-11T07:00:00.000Z")).toContain("(5h ago;");
    expect(line("2026-10-05T12:00:00.000Z")).toContain("(6d ago;");
  });

  it("is ok with a surfacing even when no fact is recallable", () => {
    expect(describeLastSurfaced("2026-10-11T11:59:59.000Z", 0, now)[0]?.status).toBe("ok");
  });

  it("warns only for recallable facts with no surfacing ever", () => {
    expect(describeLastSurfaced(null, 2, now)[0]?.status).toBe("warn");
    expect(describeLastSurfaced(null, 0, now)[0]?.status).toBe("ok");
  });

  it("reports an unparseable timestamp as unreadable, not as never surfaced", () => {
    const warned = describeLastSurfaced("not-a-date", 3, now)[0];
    expect(warned?.status).toBe("warn");
    expect(warned?.message).toContain('last surfacing timestamp is unreadable ("not-a-date")');
    expect(warned?.message).not.toContain("no fact has been surfaced yet");
    const quiet = describeLastSurfaced("not-a-date", 0, now)[0];
    expect(quiet?.status).toBe("ok");
    expect(quiet?.message).toContain("unreadable");
  });

  it("treats a lenient-only date string as unreadable instead of reading it as a real date", () => {
    for (const lenient of ["1", "2026", "12/31/2026"]) {
      const entry = describeLastSurfaced(lenient, 3, now)[0];
      expect(entry?.status).toBe("warn");
      expect(entry?.message).toContain("last surfacing timestamp is unreadable");
    }
    const valid = describeLastSurfaced("2026-10-11T11:30:00.000Z", 3, now)[0];
    expect(valid?.status).toBe("ok");
    expect(valid?.message).toContain("last fact surfaced 2026-10-11T11:30:00.000Z");
  });

  it("strips control characters, ESC included, from an unreadable timestamp before echoing it", () => {
    const message = describeLastSurfaced("bad\u001b[31mred\u0007\nvalue", 3, now)[0]?.message ?? "";
    expect(message).toContain('("bad[31mredvalue")');
    expect(message).not.toMatch(/\p{Cc}/u);
  });

  it("truncates an unreadable timestamp to 40 characters in the message", () => {
    const message = describeLastSurfaced("x".repeat(100), 1, now)[0]?.message ?? "";
    expect(message).toContain(`("${"x".repeat(40)}")`);
    expect(message).not.toContain("x".repeat(41));
  });

  it("warns with the remedy when the last surfacing is 8 days old and facts are recallable", () => {
    const entry = describeLastSurfaced("2026-10-03T12:00:00.000Z", 3, now)[0];
    expect(entry?.status).toBe("warn");
    expect(entry?.remedy).toBe("mem init claude-code");
    expect(entry?.message).toContain("mem init claude-code");
  });

  it("stays ok for an 8-day-old surfacing when no fact is recallable", () => {
    expect(describeLastSurfaced("2026-10-03T12:00:00.000Z", 0, now)[0]?.status).toBe("ok");
  });

  it("stays ok for a 6-day-old surfacing with recallable facts", () => {
    expect(describeLastSurfaced("2026-10-05T12:00:00.000Z", 3, now)[0]?.status).toBe("ok");
  });

  it("reports a future timestamp as recorded in the future, ok, and never as under a minute", () => {
    const entry = describeLastSurfaced("2026-10-11T12:05:00.000Z", 3, now)[0];
    expect(entry?.status).toBe("ok");
    expect(entry?.message).toContain("recorded in the future");
    expect(entry?.message).not.toContain("<1m");
  });

  it("stays ok at exactly 7 days and warns one millisecond later", () => {
    expect(describeLastSurfaced("2026-10-04T12:00:00.000Z", 3, now)[0]?.status).toBe("ok");
    expect(describeLastSurfaced("2026-10-04T11:59:59.999Z", 3, now)[0]?.status).toBe("warn");
  });
});

describe("mem doctor on a store behind the newest schema", () => {
  const highest = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

  it.each([
    { userVersion: 0, pending: highest },
    { userVersion: 3, pending: highest - 3 },
    { userVersion: highest - 1, pending: 1 },
  ])("reports $pending pending migration(s) at user_version $userVersion as a warn that --strict does not count, and does not migrate", async ({ userVersion, pending }) => {
    await runCli(["remember", "a fact stored before the newest schema", "--kind", "fact", "--scope", "global"]);
    rewriteSurfacing(`PRAGMA user_version = ${String(userVersion)}`);
    const result = await runCli(["doctor", "--json", "--strict"]);
    const report = JSON.parse(result.stdout) as { findings: RecallFinding[] };
    const failed = report.findings.filter((entry) => entry.status === "fail");
    const schemaEntries = report.findings.filter((entry) => entry.check === "schema");
    expect(schemaEntries, "exactly one schema finding names the pending migrations").toHaveLength(1);
    const schema = schemaEntries[0];
    expect(schema?.status, "pending migrations are a warn, not a fail").toBe("warn");
    expect(failed.includes(schema as RecallFinding), "the pending-migration finding is not among the findings --strict fails on").toBe(false);
    // Only fail findings set the --strict exit, so a slow machine tripping some other check does not make this row fail.
    expect(result.exitCode, `--strict exits 1 exactly when a finding fails: ${JSON.stringify(failed)}`).toBe(failed.length > 0 ? 1 : 0);
    expect(schema?.message).toBe(`schema: ${String(pending)} migration${pending === 1 ? "" : "s"} pending (the next write applies them)`);
    const raw = new Database(resolveDbPath(), { readonly: true, fileMustExist: true });
    try {
      expect(raw.pragma("user_version", { simple: true }), "doctor is read-only and must leave the store un-migrated").toBe(userVersion);
    } finally {
      raw.close();
    }
  });

  it("emits no schema finding for a store at the newest schema", async () => {
    await runCli(["remember", "a fact stored at the newest schema", "--kind", "fact", "--scope", "global"]);
    const result = await runCli(["doctor", "--json"]);
    const report = JSON.parse(result.stdout) as { findings: RecallFinding[] };
    expect(report.findings.some((entry) => entry.check === "integrity" && entry.status === "ok"), "the report did inspect the store").toBe(true);
    expect(report.findings.some((entry) => entry.check === "schema")).toBe(false);
  });
});
