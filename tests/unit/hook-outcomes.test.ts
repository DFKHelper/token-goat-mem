/** Tests for the hook outcome log (src/hookOutcomes.ts) and the `mem doctor` line built from it. Every timestamp and duration is passed in, so nothing here reads a clock. The doctor cases run through the real `run()` in an isolated temp home. */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeHookOutcomes } from "../../src/doctor.js";
import {
  appendHookOutcome,
  HOOK_OUTCOMES_FILE,
  HOOK_OUTCOMES_MAX_BYTES,
  HOOK_OUTCOMES_ROTATED_FILE,
  summarizeHookOutcomes,
  type HookOutcomeHook,
  type HookOutcomeKind,
  type HookOutcomeRecord,
  type HookOutcomeSummary,
} from "../../src/hookOutcomes.js";
import { runCli } from "../support/cli.js";
import { CAPABLE_PROBE, installProbe, resetProbe } from "../support/fakeProbe.js";

// Doctor probes the `mem` on PATH only for an installed hook, and the `--root` below (the temp home) holds none; the scripted probe makes that a guarantee.
vi.mock("../../src/probeSpawn.js", async (importOriginal) => (await import("../support/fakeProbe.js")).withFakeProbe(await importOriginal<typeof import("../../src/probeSpawn.js")>()));

let home: string;
let dbPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-hook-outcomes-"));
  dbPath = join(home, "mem.db");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function record(overrides: Partial<{ hook: HookOutcomeHook; outcome: HookOutcomeKind; ms: number; cut: number }> = {}): HookOutcomeRecord {
  return { v: 1, at: "2026-01-02T03:04:05.000Z", hook: "prompt", outcome: "ok", ms: 10, cut: 0, ...overrides };
}

const livePath = (): string => join(home, HOOK_OUTCOMES_FILE);

describe("appendHookOutcome", () => {
  it("writes one JSON line per record beside the store", () => {
    appendHookOutcome(dbPath, record({ ms: 12 }));
    appendHookOutcome(dbPath, record({ hook: "session-start", outcome: "out-of-time", ms: 160, cut: 2 }));
    const lines = readFileSync(livePath(), "utf8").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[0] ?? "")).toEqual(record({ ms: 12 }));
    expect(JSON.parse(lines[1] ?? "")).toEqual(record({ hook: "session-start", outcome: "out-of-time", ms: 160, cut: 2 }));
  });

  it.skipIf(process.platform === "win32")("creates the file owner-only", () => {
    appendHookOutcome(dbPath, record());
    expect(statSync(livePath()).mode & 0o777).toBe(0o600);
  });

  it("rotates a file at the cap to .log.1, replacing the old copy, before appending", () => {
    writeFileSync(join(home, HOOK_OUTCOMES_ROTATED_FILE), "stale\n");
    writeFileSync(livePath(), "x".repeat(HOOK_OUTCOMES_MAX_BYTES));
    appendHookOutcome(dbPath, record({ ms: 7 }));
    expect(readFileSync(join(home, HOOK_OUTCOMES_ROTATED_FILE), "utf8")).toBe("x".repeat(HOOK_OUTCOMES_MAX_BYTES));
    expect(readFileSync(livePath(), "utf8")).toBe(`${JSON.stringify(record({ ms: 7 }))}\n`);
  });

  it("does not rotate a file one byte under the cap", () => {
    writeFileSync(livePath(), "x".repeat(HOOK_OUTCOMES_MAX_BYTES - 1));
    appendHookOutcome(dbPath, record());
    expect(existsSync(join(home, HOOK_OUTCOMES_ROTATED_FILE))).toBe(false);
    expect(statSync(livePath()).size).toBeGreaterThan(HOOK_OUTCOMES_MAX_BYTES);
  });

  it("returns normally when the directory beside the store cannot be written", () => {
    const blocker = join(home, "a-file");
    writeFileSync(blocker, "");
    expect(() => appendHookOutcome(join(blocker, "mem.db"), record())).not.toThrow();
    expect(() => appendHookOutcome(join(home, "missing-dir", "mem.db"), record())).not.toThrow();
  });
});

describe("summarizeHookOutcomes", () => {
  it("reads as empty when neither file exists", () => {
    const summary = summarizeHookOutcomes(home);
    expect(summary.total).toEqual({ runs: 0, ok: 0, outOfTime: 0, storeUnreadable: 0, internalErrors: 0, cut: 0, p95Ms: 0 });
    expect(Object.keys(summary)).toEqual(["total"]);
  });

  it("counts every hook and outcome across the rotated and the live file, skipping malformed lines", () => {
    const rotated = [JSON.stringify(record({ ms: 5 })), "not json", JSON.stringify(record({ outcome: "store-unreadable", ms: 9 }))].join("\n");
    const live = [
      JSON.stringify(record({ hook: "session-start", outcome: "out-of-time", ms: 150, cut: 3 })),
      JSON.stringify({ ...record(), v: 2 }),
      JSON.stringify({ ...record(), hook: "elsewhere" }),
      JSON.stringify({ ...record(), outcome: "weird" }),
      JSON.stringify({ ...record(), ms: "7" }),
      JSON.stringify({ ...record(), ms: -1 }),
      JSON.stringify({ ...record(), cut: 1.5 }),
      JSON.stringify({ ...record(), at: 3 }),
      "null",
      "[]",
      "",
      JSON.stringify(record({ hook: "other", outcome: "internal-error", ms: 1 })),
    ].join("\n");
    writeFileSync(join(home, HOOK_OUTCOMES_ROTATED_FILE), rotated);
    writeFileSync(livePath(), live);
    const summary = summarizeHookOutcomes(home);
    expect(summary.total).toMatchObject({ runs: 4, ok: 1, outOfTime: 1, storeUnreadable: 1, internalErrors: 1, cut: 3 });
    expect(summary.total.p95Ms).toBe(150);
  });

  it("takes the p95 as the nearest rank", () => {
    // 1..20 ms: ceil(0.95 * 20) = 19, so the 19th smallest value.
    for (let ms = 20; ms >= 1; ms -= 1) {
      appendHookOutcome(dbPath, record({ ms }));
    }
    expect(summarizeHookOutcomes(home).total.p95Ms).toBe(19);
  });

  it("takes the p95 of a single run as that run", () => {
    appendHookOutcome(dbPath, record({ ms: 42 }));
    expect(summarizeHookOutcomes(home).total.p95Ms).toBe(42);
  });

  it("takes the p95 of 100 runs as the 95th smallest", () => {
    for (let ms = 1; ms <= 100; ms += 1) {
      appendHookOutcome(dbPath, record({ ms }));
    }
    expect(summarizeHookOutcomes(home).total.p95Ms).toBe(95);
  });
});

describe("describeHookOutcomes", () => {
  function summaryFor(outcomes: readonly HookOutcomeKind[]): HookOutcomeSummary {
    outcomes.forEach((outcome, index) => {
      appendHookOutcome(dbPath, record({ outcome, ms: index + 1, cut: outcome === "out-of-time" ? 1 : 0 }));
    });
    return summarizeHookOutcomes(home);
  }

  it("prints nothing for an empty log", () => {
    expect(describeHookOutcomes(summarizeHookOutcomes(home))).toEqual([]);
  });

  it("is ok at exactly 1 run in 100 out of time", () => {
    const outcomes: HookOutcomeKind[] = ["out-of-time", ...Array.from({ length: 99 }, (): HookOutcomeKind => "ok")];
    expect(describeHookOutcomes(summaryFor(outcomes))).toEqual([
      { check: "hints", status: "ok", message: "hint runs: 100 runs, 1 out of time, 0 store unreadable, 0 internal errors, 1 anchor check cut short, p95 about 95 ms" },
    ]);
  });

  it("warns above 1 run in 100 out of time", () => {
    const outcomes: HookOutcomeKind[] = ["out-of-time", "out-of-time", ...Array.from({ length: 98 }, (): HookOutcomeKind => "ok")];
    const [line] = describeHookOutcomes(summaryFor(outcomes));
    expect(line?.status).toBe("warn");
    expect(line?.message).toContain("2 out of time");
    expect(line?.message).toContain("more than 1 run in 100 ran out of time");
  });
});

describe("mem doctor hook outcomes", () => {
  beforeEach(() => {
    vi.stubEnv("TOKEN_GOAT_MEM_HOME", home);
    installProbe(CAPABLE_PROBE);
  });

  afterEach(() => {
    resetProbe();
    vi.unstubAllEnvs();
  });

  async function hintRunsLine(): Promise<string | undefined> {
    const result = await runCli(["doctor", "--root", home]);
    expect(result.exitCode).toBe(0);
    return result.stdout.split("\n").find((line) => line.startsWith("hint runs:"));
  }

  it("prints the line when the log exists", async () => {
    appendHookOutcome(dbPath, record({ ms: 30 }));
    appendHookOutcome(dbPath, record({ outcome: "store-unreadable", ms: 50 }));
    expect(await hintRunsLine()).toBe("hint runs: 2 runs, 0 out of time, 1 store unreadable, 0 internal errors, 0 anchor checks cut short, p95 about 50 ms");
  });

  it("prints no line without the log", async () => {
    expect(await hintRunsLine()).toBeUndefined();
  });
});
