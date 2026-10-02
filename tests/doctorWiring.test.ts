/** End-to-end tests for `mem doctor`'s wiring checks: whether each supported tool's mem block is present and current (`wiring`), and whether project- and user-level Claude Code hooks disagree (`hook-divergence`). Everything goes through the real CLI against temp roots and homes; doctor itself must never write a file. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "./support/cli.js";

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

describe("mem doctor wiring drift", () => {
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

describe("mem doctor project-vs-user hook divergence", () => {
  it("warns when project and user hooks run different mem invocations, naming both fixes", async () => {
    await init("claude-code");
    await init("claude-code", "--user");
    const projectSettings = join(toolRoot, ".claude", "settings.json");
    const text = readFileSync(projectSettings, "utf8");
    expect(text).toContain("--hint-format");
    writeFileSync(projectSettings, text.replace("--hint-format", "--hint-format --limit 3"), "utf8");

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
});
