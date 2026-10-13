/** End-to-end tests for `mem doctor`'s wiring checks: whether each supported tool's mem block is present and current (`wiring`), and whether project- and user-level Claude Code hooks disagree (`hook-divergence`). Everything goes through the real CLI against temp roots and homes; doctor itself must never write a file. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { describeHookHealthRefusal } from "../src/cli.js";
import { describeIncapableHook, hookGapRemedy } from "../src/doctor.js";
import { probeTimeoutFromEnv } from "../src/doctorWiring.js";
import { checkClaudeHookHealth, checkHookCapability, CLAUDE_HOOK_EVENTS, describeProbeRefusal, MEM_PROBE_TIMEOUT_MS, toHookCapabilityResult, type HookCapabilityResult } from "../src/wiring.js";
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

describe("mem doctor warns about a recall hook timeout that is too low", { timeout: SPAWN_TIMEOUT_FLOOR_MS }, () => {
  /** Installs the hooks, then sets (or removes, for `undefined`) the `timeout` on every hook of `event`. */
  async function installWithTimeout(event: string, timeout: number | string | undefined): Promise<void> {
    await init("claude-code");
    const path = join(toolRoot, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(path, "utf8")) as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> };
    for (const group of settings.hooks[event] ?? []) {
      for (const hook of group.hooks) {
        if (timeout === undefined) {
          delete hook["timeout"];
        } else {
          hook["timeout"] = timeout;
        }
      }
    }
    writeFileSync(path, JSON.stringify(settings, null, 2), "utf8");
  }

  async function timeoutWarnings(): Promise<JsonFinding[]> {
    return (await doctorFindings("hooks")).filter((entry) => entry.status === "warn" && entry.message.includes("timeout"));
  }

  it.each(["SessionStart", "UserPromptSubmit"])("warns, naming the event, the value and 45, for a %s timeout of 10", async (event) => {
    await installWithTimeout(event, 10);
    const warnings = await timeoutWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain(event);
    expect(warnings[0]?.message).toContain("10");
    expect(warnings[0]?.remedy).toContain("45");
  });

  it.each([45, undefined])("does not warn for a SessionStart timeout of %s", async (timeout) => {
    await installWithTimeout("SessionStart", timeout);
    expect(await timeoutWarnings()).toEqual([]);
  });

  it("does not warn for a Stop hook with a timeout of 5", async () => {
    await installWithTimeout("Stop", 5);
    expect(await timeoutWarnings()).toEqual([]);
  });

  it.each(["SessionStart", "UserPromptSubmit"])("warns that a %s timeout given as a string is not a number of seconds", async (event) => {
    await installWithTimeout(event, "45");
    const warnings = await timeoutWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain(event);
    expect(warnings[0]?.message).toContain("not a number");
    expect(warnings[0]?.remedy).toContain("45");
  });

  it("does not warn for a Stop hook with a non-numeric timeout", async () => {
    await installWithTimeout("Stop", "5");
    expect(await timeoutWarnings()).toEqual([]);
  });
});

describe("a probe refusal names every character that made it skip, the line break included", () => {
  it("says so in the doctor remedy and in the probe sentence", () => {
    expect(hookGapRemedy({ probeRefusal: "skipped" })).toContain("line break");
    expect(describeProbeRefusal("C:/x")).toContain("line break");
  });
});

describe("the init refusal lists the remedy for every kind of problem it reports, a refusal's first", () => {
  const bin = { path: "C:/m&m/mem", version: "0.5.2" };
  const refused = { event: "SessionStart", command: "mem hook session-start", capable: false, missing: [], probeRefusal: "skipped the capability probe" };
  const timedOut = { event: "UserPromptSubmit", command: "mem hook user-prompt-submit", capable: false, missing: [], probeFailure: "could not probe it within 5 s" };
  const gap = { event: "Stop", command: "mem hook stop", capable: false, missing: ["hook"] };
  const unsafe = { event: "PreCompact", command: "mem hook pre-compact", capable: false, missing: ["pre-compact;x"], commandRefusal: "did not probe this hook: its command looks unsafe" };

  it("names both the path-character remedy and the busy-machine one, the refusal's first, when there is a refusal and a timeout", () => {
    const message = describeHookHealthRefusal({ bin, hooks: [refused, timedOut] }) ?? "";
    expect(message).toContain("without those characters");
    expect(message).toContain("less busy");
    expect(message.indexOf("without those characters")).toBeLessThan(message.indexOf("less busy"));
  });

  it("names only the busy-machine remedy when there is a timeout and no refusal", () => {
    const message = describeHookHealthRefusal({ bin, hooks: [timedOut] }) ?? "";
    expect(message).toContain("less busy");
    expect(message).not.toContain("without those characters");
  });

  it("names only the path-character remedy when there is a refusal and no timeout", () => {
    const message = describeHookHealthRefusal({ bin, hooks: [refused] }) ?? "";
    expect(message).toContain("without those characters");
    expect(message).not.toContain("less busy");
  });

  it("names the upgrade remedy and the busy-machine one when there is a gap and a timeout", () => {
    const message = describeHookHealthRefusal({ bin, hooks: [gap, timedOut] }) ?? "";
    expect(message).toContain("upgrade with");
    expect(message).toContain("less busy");
  });

  it("says each remedy once and offers --force once", () => {
    const message = describeHookHealthRefusal({ bin, hooks: [refused, timedOut, gap] }) ?? "";
    expect(message.match(/less busy/gu)).toHaveLength(1);
    expect(message.match(/upgrade with/gu)).toHaveLength(1);
    expect(message.match(/--force/gu)).toHaveLength(1);
  });

  it("reports a hook whose command was not probed as such, never as an unsupported command", () => {
    const message = describeHookHealthRefusal({ bin, hooks: [unsafe] }) ?? "";
    expect(message).toContain("PreCompact");
    expect(message).toContain("did not probe this hook");
    expect(message).not.toContain("does not support");
  });
});

describe("a hook whose command the safety check refuses is reported as not probed, never as a missing command", () => {
  const event = "UserPromptSubmit";
  const tampered = "mem recall;touch pwned --hint-format --root \"$CLAUDE_PROJECT_DIR\"";

  function refusedHook(binPath: string): HookCapabilityResult {
    const check = checkHookCapability(binPath, { subcommand: "recall;touch", flags: ["--hint-format"] });
    return toHookCapabilityResult(event, tampered, check, { bin: binPath, launched: binPath, timeoutMs: MEM_PROBE_TIMEOUT_MS });
  }

  it("names the event and the command, does not call it unsupported, warns, and launches nothing", () => {
    const binDir = mkdtempSync(join(tmpdir(), "mem-dw-refused-"));
    try {
      writeCountingFakeMem(binDir, CAPABLE_MEM_SHIM);
      const counter = join(binDir, "launches.txt");
      process.env["FAKE_MEM_COUNTER"] = counter;
      const hook = refusedHook(join(binDir, process.platform === "win32" ? "mem.cmd" : "mem"));
      const entry = describeIncapableHook(hook, true);
      expect(entry.message).toContain(event);
      expect(entry.message).toContain("did not probe");
      expect(entry.message).toContain("recall;touch");
      expect(entry.message).not.toContain("does not support");
      expect(entry.message).not.toContain("entry point");
      expect(entry.status).toBe("warn");
      expect(entry.remedy).toContain("mem init claude-code");
      expect(entry.remedy).toContain("--user");
      expect(entry.remedy).toContain("--root");
      expect(existsSync(counter)).toBe(false);
    } finally {
      delete process.env["FAKE_MEM_COUNTER"];
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("truncates a very long command in the message", () => {
    const long = `mem recall;${"x".repeat(400)} --root "$CLAUDE_PROJECT_DIR"`;
    const check = checkHookCapability("mem", { subcommand: `recall;${"x".repeat(400)}`, flags: [] });
    const entry = describeIncapableHook(toHookCapabilityResult(event, long, check, { bin: "mem", launched: "mem", timeoutMs: MEM_PROBE_TIMEOUT_MS }), true);
    expect(entry.message.length).toBeLessThan(400);
  });
});

describe("mem hook capability probe that gets no answer",{ timeout: SPAWN_TIMEOUT_FLOOR_MS }, () => {
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

  it.runIf(process.platform === "win32")("says the probe was skipped, naming the path and the character cmd.exe would interpret, when the mem path carries an ampersand", async () => {
    const special = join(binDir, "user&name");
    mkdirSync(special);
    writeFakeMem(special, CAPABLE_MEM_SHIM);
    await withProbeEnv(special, { TOKEN_GOAT_MEM_PROBE_TIMEOUT_MS: "30000" }, async () => {
      const init = await runCli(["init", "claude-code", "--root", toolRoot]);
      expect(init.exitCode).toBe(1);
      expect(init.stdout).toContain("skipped");
      expect(init.stdout).toContain(special);
      expect(init.stdout).toContain("cmd.exe");
      expect(init.stdout).toContain("--force");
      expect(init.stdout).not.toContain("does not support");
      expect(init.stdout).not.toContain("upgrade with");

      await runCli(["init", "claude-code", "--root", toolRoot, "--force"]);
      const failures = (await doctorFindings("hooks")).filter((entry) => entry.status === "fail");
      expect(failures.length).toBeGreaterThan(0);
      for (const entry of failures) {
        expect(entry.message).toContain("skipped");
        expect(entry.message).toContain("cmd.exe");
        expect(entry.message).not.toContain("does not support");
        expect(entry.remedy).not.toContain("npm install -g");
      }
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
