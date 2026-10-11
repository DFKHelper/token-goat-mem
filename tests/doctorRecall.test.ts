/** End-to-end tests for `mem doctor`'s last-surfacing line: the latest recorded time a fact reached a session, taken from the later of `facts.last_surfaced_at` (never rotated) and `recall_log.surfaced_at` (rotated by `mem epoch --gc`). Driven through the real `run()` against a real database; the pure `describeLastSurfaced` is tested with a fixed clock. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, resolveDbPath } from "../src/db.js";
import { describeLastSurfaced } from "../src/doctor.js";
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
