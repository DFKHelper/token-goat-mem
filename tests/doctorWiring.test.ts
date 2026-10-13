/** End-to-end tests for `mem doctor`'s wiring checks: whether each supported tool's mem block is present and current (`wiring`), and whether project- and user-level Claude Code hooks disagree (`hook-divergence`). Everything goes through the real CLI against temp roots and homes; doctor itself must never write a file. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { hookGapRemedy } from "../src/doctor.js";
import { probeTimeoutFromEnv } from "../src/doctorWiring.js";
import { checkClaudeHookHealth, checkHookCapability, CLAUDE_HOOK_EVENTS, MEM_PROBE_TIMEOUT_MS } from "../src/wiring.js";
import { runCli } from "./support/cli.js";
import { CAPABLE_MEM_SHIM, HANG_ONCE_MEM_SHIM, HANGING_MEM_SHIM, NOT_RUNNABLE_MEM_SHIM, writeCountingFakeMem, writeFakeMem } from "./support/fakeMem.js";
import { SPAWN_TIMEOUT_FLOOR_MS } from "./support/spawnTimeoutFloorMs.js";

interface JsonFinding {
  readonly check: string;
  readonly status: string;
  readonly message: string;
  readonly remedy?: string;
}

let memHome: string;
let toolRoot: string;
let toolHome: string;

beforeEach(() => {
  memHome = mkdtempSync(join(tmpdir(), "mem-dw-mem-"));
  toolRoot = mkdtempSync(join(tmpdir(), "mem-dw-root-"));
  toolHome = mkdtempSync(join(tmpdir(), "mem-dw-home-"));
  process.env["TOKEN_GOAT_MEM_HOME"] = memHome;
  process.env["TOKEN_GOAT_MEM_WIRING_HOME"] = toolHome;
});

afterEach(() => {
  delete process.env["TOKEN_GOAT_MEM_HOME"];
  delete process.env["TOKEN_GOAT_MEM_WIRING_HOME"];
  for (const dir of [memHome, toolRoot, toolHome]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function doctorFindings(check: string, extra: readonly string[] = []): Promise<JsonFinding[]> {
  const result = await runCli(["doctor", "--json", "--root", toolRoot, ...extra]);
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout) as { findings: JsonFinding[] };
  return report.findings.filter((entry) => entry.check === check);
}

async function init(tool: string, ...extra: string[]): Promise<void> {
  // --force skips the PATH-binary pre-flight: these tests are about config text, not hook health.
  const result = await runCli(["init", tool, "--root", toolRoot, "--force", ...extra]);
  expect(result.exitCode).toBe(0);
}

describe("mem doctor wiring drift", { timeout: SPAWN_TIMEOUT_FLOOR_MS }, () => {
  it("reports ok for a tool whose wiring is current", async () => {
    await init("codex");
    await init("claude-code");
    const findings = await doctorFindings("wiring");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((entry) => entry.status === "ok")).toBe(true);
    expect(findings.some((entry) => entry.message.includes("codex") && entry.message.includes("current"))).toBe(true);
    expect(findings.some((entry) => entry.message.includes("claude-code") && entry.message.includes("current"))).toBe(true);
  });

  it("warns, with `mem init <tool>` as the remedy, when the block was hand-edited inside its markers", async () => {
    await init("codex");
    const agentsMd = join(toolRoot, "AGENTS.md");
    const text = readFileSync(agentsMd, "utf8");
    expect(text).toContain("token-goat-mem:");
    const lines = text.split("\n");
    const startAt = lines.findIndex((line) => line.includes("token-goat-mem:") && line.includes(":start"));
    expect(startAt).toBeGreaterThanOrEqual(0);
    lines.splice(startAt + 2, 0, "hand edited line that mem never wrote");
    writeFileSync(agentsMd, lines.join("\n"), "utf8");

    const findings = await doctorFindings("wiring");
    const drift = findings.find((entry) => entry.message.includes("codex"));
    expect(drift?.status).toBe("warn");
    expect(drift?.remedy).toContain("mem init codex");

    const strict = await runCli(["doctor", "--strict", "--root", toolRoot]);
    expect(strict.exitCode).toBe(0);
  });

  it("warns when a Claude Code hook is missing one of the expected events", async () => {
    await init("claude-code");
    const settingsPath = join(toolRoot, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks: Record<string, unknown> };
    delete settings.hooks["Stop"];
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    const findings = await doctorFindings("wiring");
    const drift = findings.find((entry) => entry.message.includes("claude-code") && entry.status === "warn");
    expect(drift).toBeDefined();
    expect(drift?.remedy).toContain("mem init claude-code");
  });

  it("warns for a stale user-level install and names --user in the remedy", async () => {
    await init("claude-code", "--user");
    const settingsPath = join(toolHome, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks: Record<string, unknown> };
    delete settings.hooks["SessionStart"];
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    const findings = await doctorFindings("wiring");
    const drift = findings.find((entry) => entry.status === "warn");
    expect(drift?.remedy).toContain("mem init claude-code");
    expect(drift?.remedy).toContain("--user");
  });

  it("does not warn about, or create files for, tools that were never wired", async () => {
    const findings = await doctorFindings("wiring");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((entry) => entry.status === "ok")).toBe(true);
    expect(findings.some((entry) => entry.message.includes("not installed"))).toBe(true);
    expect(readdirSync(toolRoot)).toEqual([]);
    expect(readdirSync(toolHome)).toEqual([]);
    const strict = await runCli(["doctor", "--strict", "--root", toolRoot]);
    expect(strict.exitCode).toBe(0);
  });

  it("does not call an AGENTS.md shared by two tools stale for the tool that is not listed", async () => {
    await init("codex");
    const findings = await doctorFindings("wiring");
    expect(findings.some((entry) => entry.status === "warn")).toBe(false);
    expect(existsSync(join(toolRoot, "AGENTS.md"))).toBe(true);
  });
});

describe("mem doctor project-vs-user hook divergence", { timeout: SPAWN_TIMEOUT_FLOOR_MS }, () => {
  it("warns when project and user hooks run different mem invocations, naming both fixes", async () => {
    await init("claude-code");
    await init("claude-code", "--user");
    const projectSettings = join(toolRoot, ".claude", "settings.json");
    const text = readFileSync(projectSettings, "utf8");
    expect(text).toContain("hook user-prompt-submit");
    writeFileSync(projectSettings, text.replace("hook user-prompt-submit", "hook session-start"), "utf8");

    const findings = await doctorFindings("hook-divergence");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("warn");
    expect(findings[0]?.remedy).toContain("mem init claude-code --user");
    expect(findings[0]?.remedy).not.toContain("uninstall");
  });

  it("does not warn when project and user hooks are identical", async () => {
    await init("claude-code");
    await init("claude-code", "--user");
    const findings = await doctorFindings("hook-divergence");
    expect(findings.every((entry) => entry.status === "ok")).toBe(true);
  });

  it("says nothing when only one level has hooks", async () => {
    await init("claude-code");
    expect(await doctorFindings("hook-divergence")).toEqual([]);
  });

  it("does not report the user settings file as a stale project file when the root is the home directory", async () => {
    process.env["TOKEN_GOAT_MEM_WIRING_HOME"] = toolRoot;
    await init("claude-code", "--user");
    const wiring = await doctorFindings("wiring");
    expect(wiring.filter((entry) => entry.status !== "ok")).toEqual([]);
    expect(wiring.some((entry) => entry.message.includes("stale"))).toBe(false);
    expect(await doctorFindings("hook-divergence")).toEqual([]);
  });
});

describe("mem hook capability probe that gets no answer", { timeout: SPAWN_TIMEOUT_FLOOR_MS }, () => {
  it("reports a probe that timed out as such, not as a mem without the `mem hook <event>` entry point", () => {
    const binDir = mkdtempSync(join(tmpdir(), "mem-dw-bin-"));
    try {
      writeFakeMem(binDir, HANGING_MEM_SHIM);
      const isWindows = process.platform === "win32";
      const binPath = join(binDir, isWindows ? "mem.cmd" : "mem");
      expect(checkHookCapability(binPath, { subcommand: "hook", flags: ["session-start"] }, 1000)).toEqual({ capable: false, missing: [], probeFailed: true });

      const health = checkClaudeHookHealth(CLAUDE_HOOK_EVENTS.slice(0, 1), { pathEnv: binDir, platform: isWindows ? "win32" : "linux", timeoutMs: 1000 });
      const [hook] = health.hooks;
      expect(hook?.capable).toBe(false);
      expect(hook?.missing).toEqual([]);
      expect(hook?.probeFailure).toContain("could not probe");
      expect(hook?.probeFailure).toContain("within 1 s");
      expect(hook?.probeFailure).not.toContain("entry point");
      expect(hookGapRemedy(hook ?? {})).toContain("less busy");
      expect(hookGapRemedy(hook ?? {})).not.toContain("npm install");
      expect(hookGapRemedy({})).toBe("npm install -g token-goat-mem");
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

/** Runs `fn` with the given env vars set and PATH narrowed to `binDir` plus node's own directory (so no real `mem` on this machine can answer), restoring all of it afterwards. */
async function withProbeEnv(binDir: string, env: Readonly<Record<string, string>>, fn: () => Promise<void>): Promise<void> {
  const originalPath = process.env["PATH"];
  const originalCwd = process.cwd();
  process.env["PATH"] = `${binDir}${delimiter}${dirname(process.execPath)}`;
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    process.env["PATH"] = originalPath;
    process.chdir(originalCwd);
    for (const key of Object.keys(env)) {
      delete process.env[key];
    }
  }
}

function countLaunches(counterPath: string): number {
  return existsSync(counterPath) ? readFileSync(counterPath, "utf8").split("\n").filter((line) => line.trim().length > 0).length : 0;
}

describe("mem doctor and mem init probe a PATH mem under one shared cache and budget", { timeout: 300_000 }, () => {
  let binDir: string;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "mem-dw-probe-bin-"));
  });

  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  it("launches a hanging mem at most once per doctor run and reports it as a probe with no answer", async () => {
    const counter = join(binDir, "launches.txt");
    writeCountingFakeMem(binDir, HANGING_MEM_SHIM);
    await init("claude-code");
    await withProbeEnv(binDir, { TOKEN_GOAT_MEM_PROBE_TIMEOUT_MS: "1000", FAKE_MEM_COUNTER: counter }, async () => {
      const started = Date.now();
      const hooks = await doctorFindings("hooks");
      const elapsedMs = Date.now() - started;
      expect(hooks.some((entry) => entry.status === "fail" && entry.remedy?.includes("less busy") === true)).toBe(true);
      expect(countLaunches(counter)).toBeLessThanOrEqual(1);
      expect(elapsedMs).toBeLessThan(10_000);
    });
  });

  it("tells a binary that cannot run at all to reinstall or fix PATH, not that it lacks the hook entry point", async () => {
    writeFakeMem(binDir, NOT_RUNNABLE_MEM_SHIM);
    await init("claude-code");
    await withProbeEnv(binDir, { TOKEN_GOAT_MEM_PROBE_TIMEOUT_MS: "30000" }, async () => {
      const failures = (await doctorFindings("hooks")).filter((entry) => entry.status === "fail");
      expect(failures.length).toBeGreaterThan(0);
      for (const entry of failures) {
        expect(entry.remedy).toContain("fix PATH");
        expect(entry.remedy).not.toContain("npm install -g");
        expect(entry.message).not.toContain("entry point");
      }
    });
  });

  it("init retries a probe that got no answer once at 3x the budget, and writes the hooks without --force", async () => {
    const marker = join(binDir, "hung-once.marker");
    writeFakeMem(binDir, HANG_ONCE_MEM_SHIM);
    await withProbeEnv(binDir, { TOKEN_GOAT_MEM_PROBE_TIMEOUT_MS: "5000", FAKE_MEM_MARKER: marker }, async () => {
      const result = await runCli(["init", "claude-code", "--root", toolRoot]);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(toolRoot, ".claude", "settings.json"))).toBe(true);
      expect(existsSync(marker)).toBe(true);
    });
  });

  it("init still refuses, as before, when the retry gets no answer either", async () => {
    writeFakeMem(binDir, HANGING_MEM_SHIM);
    await withProbeEnv(binDir, { TOKEN_GOAT_MEM_PROBE_TIMEOUT_MS: "500" }, async () => {
      const result = await runCli(["init", "claude-code", "--root", toolRoot]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("less busy");
      expect(existsSync(join(toolRoot, ".claude", "settings.json"))).toBe(false);
    });
  });

  it("init refuses a binary that cannot run with the reinstall-or-fix-PATH remedy, and does not retry it", async () => {
    const counter = join(binDir, "launches.txt");
    writeCountingFakeMem(binDir, NOT_RUNNABLE_MEM_SHIM);
    await withProbeEnv(binDir, { TOKEN_GOAT_MEM_PROBE_TIMEOUT_MS: "30000", FAKE_MEM_COUNTER: counter }, async () => {
      const result = await runCli(["init", "claude-code", "--root", toolRoot]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("fix PATH");
      expect(result.stdout).not.toContain("does not support");
      // Two distinct probes (--version and hook --help), once each; a retry would double it.
      expect(countLaunches(counter)).toBe(2);
    });
  });

  it.each(["50", "abc", "600001", "1.5"])("rejects TOKEN_GOAT_MEM_PROBE_TIMEOUT_MS=%s naming the variable and the range, for doctor and init", async (value) => {
    writeFakeMem(binDir, CAPABLE_MEM_SHIM);
    await withProbeEnv(binDir, { TOKEN_GOAT_MEM_PROBE_TIMEOUT_MS: value }, async () => {
      for (const args of [["doctor"], ["init", "claude-code", "--root", toolRoot]]) {
        const result = await runCli(args);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("TOKEN_GOAT_MEM_PROBE_TIMEOUT_MS");
        expect(result.stderr).toContain("100");
        expect(result.stderr).toContain("600000");
      }
    });
  });

  it("accepts the range ends and falls back to the default when unset or blank", () => {
    expect(probeTimeoutFromEnv({ TOKEN_GOAT_MEM_PROBE_TIMEOUT_MS: "100" })).toBe(100);
    expect(probeTimeoutFromEnv({ TOKEN_GOAT_MEM_PROBE_TIMEOUT_MS: "600000" })).toBe(600_000);
    expect(probeTimeoutFromEnv({})).toBe(MEM_PROBE_TIMEOUT_MS);
    expect(probeTimeoutFromEnv({ TOKEN_GOAT_MEM_PROBE_TIMEOUT_MS: "  " })).toBe(MEM_PROBE_TIMEOUT_MS);
  });
});
