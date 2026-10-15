/** End-to-end CLI tests for health and tool wiring: doctor, init, uninstall, and the reported version. Each test gets an isolated `TOKEN_GOAT_MEM_HOME` (a fresh temp dir), re-applied per test so facts written by one test can never leak into another. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CAPABLE_PROBE, installProbe, OLD_PROBE, probeCalls, resetProbe, writeProbeTarget } from "./support/fakeProbe.js";
import { runCli } from "./support/cli.js";
import { openDb, resolveDbPath } from "../src/db.js";
import { DOCTOR_CHECKS } from "../src/doctor.js";
import { getEpoch } from "../src/epoch.js";

// A test scripts what a probe of the `mem` binary returns with `installProbe`, so no process starts and no budget decides a verdict.
vi.mock("../src/probeSpawn.js", async (importOriginal) => (await import("./support/fakeProbe.js")).withFakeProbe(await importOriginal<typeof import("../src/probeSpawn.js")>()));

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mem-cli-test-"));
  vi.stubEnv("TOKEN_GOAT_MEM_HOME", home);
  installProbe(CAPABLE_PROBE);
});

afterEach(() => {
  resetProbe();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────── mem doctor ───────────────────────────────────────────────────────────────────────────

describe("mem doctor (read-only health check)", () => {
  let originalCwd: string;
  let wiringRoot: string;
  let wiringHome: string;

  beforeEach(() => {
    // Doctor inspects the cwd's project hooks and the user's ~/.claude; left real, this repo's own committed hooks and whatever mem the machine has on PATH decide the hooks findings (and --strict's exit code), so CI without a global mem saw them fail.
    originalCwd = process.cwd();
    wiringRoot = mkdtempSync(join(tmpdir(), "mem-cli-doctor-root-"));
    wiringHome = mkdtempSync(join(tmpdir(), "mem-cli-doctor-home-"));
    vi.stubEnv("TOKEN_GOAT_MEM_WIRING_HOME", wiringHome);
    process.chdir(wiringRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    rmSync(wiringRoot, { recursive: true, force: true });
    rmSync(wiringHome, { recursive: true, force: true });
  });

  it("reports db path, WAL mode, schema tables, epoch, and zeroed fact counts on an empty store", async () => {
    // Doctor no longer creates the store, so an empty one has to exist already (epoch stays 0).
    openDb(resolveDbPath()).close();
    const result = await runCli(["doctor"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`db: ${join(home, "mem.db")}`);
    expect(result.stdout).toContain("journal_mode: wal");
    expect(result.stdout).toContain("foreign_keys: on");
    for (const table of ["audit_log", "facts", "meta", "sources"]) {
      expect(result.stdout).toContain(table);
    }
    expect(result.stdout).toContain("epoch: 0");
    expect(result.stdout).toContain("active=0");
    expect(result.stdout).toContain("(total 0)");
  });

  it("on an empty mem home exits 0, reports no store, and does not create the database", async () => {
    const result = await runCli(["doctor"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`store: none at ${join(home, "mem.db")} (mem remember creates it)`);
    // The environment checks still report without a store behind them.
    expect(result.stdout).toContain("hooks: no Claude Code hooks installed here");
    expect(result.stdout).toContain("backups:");
    expect(existsSync(join(home, "mem.db"))).toBe(false);
    expect(existsSync(`${join(home, "mem.db")}-wal`)).toBe(false);
    const strict = await runCli(["doctor", "--strict"]);
    expect(strict.exitCode).toBe(0);
  });

  describe("on a corrupt store", () => {
    beforeEach(() => {
      writeFileSync(join(home, "mem.db"), "not a sqlite database, not even the 16-byte header\n".repeat(20), "utf8");
    });

    it("exits 0, reports the store unreadable, and still prints the environment lines", async () => {
      const result = await runCli(["doctor"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("store: unreadable (SQLITE_NOTADB) -- see mem backup --list / mem restore");
      expect(result.stdout).toContain("hooks: no Claude Code hooks installed here");
      expect(result.stdout).toContain("backups:");
    });

    it("--strict exits 1, and --json names the store as a failed finding", async () => {
      expect((await runCli(["doctor", "--strict"])).exitCode).toBe(1);
      const json = await runCli(["doctor", "--json"]);
      expect(json.exitCode).toBe(0);
      const report = JSON.parse(json.stdout) as { findings: { check: string; status: string }[] };
      expect(report.findings.some((entry) => entry.check === "store" && entry.status === "fail")).toBe(true);
    });

    it("reports the embedding endpoint but no vector counts it could not read", async () => {
      const result = await runCli(["doctor"]);
      expect(result.stdout).toContain("embeddings: off");
      expect(result.stdout).not.toContain("embedding store:");
      expect(result.stdout).not.toContain("embedding coverage:");
    });
  });

  it("on an older store missing a column a pending migration adds, reports the migration and the epoch, not an unreadable store", async () => {
    await runCli(["remember", "a fact from before why existed", "--kind", "fact", "--scope", "global"]);
    const raw = openDb(resolveDbPath());
    const epoch = getEpoch(raw);
    raw.exec("ALTER TABLE facts DROP COLUMN why");
    raw.pragma("user_version = 5");
    raw.close();
    const result = await runCli(["doctor", "--json"]);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as { findings: { check: string; status: string; message: string }[]; epoch: number | null };
    expect(report.epoch).toBe(epoch);
    expect(report.findings.find((entry) => entry.check === "schema")).toMatchObject({ status: "warn", message: "schema: 1 migration pending (the next write applies them)" });
    expect(report.findings.find((entry) => entry.check === "integrity")).toMatchObject({ status: "ok" });
    expect(report.findings.some((entry) => entry.check === "store" && entry.status === "fail")).toBe(false);
    const messages = report.findings.map((entry) => entry.message);
    expect(messages.some((message) => message.startsWith("embeddings: off"))).toBe(true);
    expect(messages.some((message) => message.startsWith("embedding store:") || message.startsWith("embedding coverage:"))).toBe(false);
  });

  it("does not migrate a store from an older schema; it reports the pending migrations", async () => {
    await runCli(["remember", "a pre-migration fact", "--kind", "fact", "--scope", "global"]);
    const raw = openDb(resolveDbPath());
    raw.pragma("user_version = 1");
    raw.close();
    const result = await runCli(["doctor"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/schema: \d+ migrations? pending \(the next write applies them\)/);
    // A raw read-only handle, because `openDb` would migrate the store and hide what doctor did.
    const after = new Database(resolveDbPath(), { readonly: true, fileMustExist: true });
    try {
      expect(after.pragma("user_version", { simple: true })).toBe(1);
    } finally {
      after.close();
    }
  });

  it("reports a healthy store's schema and integrity as ok", async () => {
    await runCli(["remember", "an intact fact", "--kind", "fact", "--scope", "global"]);
    const result = await runCli(["doctor", "--json"]);
    const report = JSON.parse(result.stdout) as { findings: { check: string; status: string; message: string }[] };
    expect(report.findings.find((entry) => entry.check === "integrity")).toMatchObject({ status: "ok" });
    expect(report.findings.some((entry) => entry.check === "schema")).toBe(false);
  });

  it("--json prints findings whose check names all come from the exported list", async () => {
    await runCli(["remember", "json doctor fact", "--kind", "fact"]);
    const result = await runCli(["doctor", "--json"]);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as { findings: { check: string; status: string; message: string }[]; epoch: number };
    expect(report.epoch).toBe(1);
    expect(report.findings.length).toBeGreaterThan(0);
    for (const finding of report.findings) {
      expect(DOCTOR_CHECKS).toContain(finding.check);
      expect(["ok", "warn", "fail"]).toContain(finding.status);
      expect(finding.message.length).toBeGreaterThan(0);
    }
  });

  it("--strict exits 0 when nothing fails, even with warnings present", async () => {
    await runCli(["remember", "strict doctor fact", "--kind", "fact"]);
    const result = await runCli(["doctor", "--strict"]);
    expect(result.exitCode).toBe(0);
  });

  it("reflects writes in its counts without performing any itself", async () => {
    await runCli(["remember", "doctor sees me", "--kind", "preference"]);

    const result = await runCli(["doctor"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("epoch: 1");
    expect(result.stdout).toContain("active=1");
    expect(result.stdout).toContain("(total 1)");

    // Read-only: a doctor run must not bump the epoch or write anything.
    const epochAfter = await runCli(["epoch"]);
    expect(epochAfter.stdout.trim()).toBe("1");
  });

  it("reports the hint budget, so a store that has outgrown one recall block says so", async () => {
    // 15 recallable facts against a 14-line ceiling: the first store size at which a fact the user can see in `mem list` may never reach a session, and nothing else in doctor would say it.
    for (let index = 0; index < 15; index += 1) {
      await runCli(["remember", `budget fact number ${index}`, "--kind", "fact"]);
    }
    const result = await runCli(["doctor"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hint budget: 15 recallable facts, at most 14 per recall; 0 pinned of 2 reserved slots");
    expect(result.stdout).toContain("`mem pin <id>`");
  });

  it("non-firing: a store inside the ceiling gets the same line without the pin remediation", async () => {
    await runCli(["remember", "the only fact here", "--kind", "fact"]);
    const result = await runCli(["doctor"]);
    expect(result.stdout).toContain("hint budget: 1 recallable fact, at most 14 per recall; 0 pinned of 2 reserved slots");
    expect(result.stdout).not.toContain("mem pin <id>");
  });

  it("warns when more facts are pinned than the reserve can guarantee", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const stored = await runCli(["remember", `pinned fact ${index}`, "--kind", "fact"]);
      ids.push((/[0-9a-f-]{36}/u.exec(stored.stdout) ?? [""])[0]);
    }
    for (const id of ids) {
      await runCli(["pin", id]);
    }
    const result = await runCli(["doctor"]);
    expect(result.stdout).toContain("3 pinned of 2 reserved slots");
    expect(result.stdout).toContain("only 2 pins are guaranteed a slot");
  });

  it("reports project-scoped facts whose root no longer exists, which every other line calls healthy", async () => {
    const gone = mkdtempSync(join(tmpdir(), "mem-doctor-gone-"));
    await runCli(["remember", "bound to a doomed directory", "--kind", "fact", "--scope", "project", "--root", gone]);
    rmSync(gone, { recursive: true, force: true });

    const result = await runCli(["doctor"]);
    expect(result.exitCode).toBe(0);
    // Still active, still term-covered: the status counts are exactly why this line has to exist.
    expect(result.stdout).toContain("active=1");
    expect(result.stdout).toContain("scope placement: 1 fact bound to 1 missing root -- unreachable from any session");
  });

  it("non-firing: a project-scoped fact whose root still exists is not reported as orphaned", async () => {
    await runCli(["remember", "bound to a live directory", "--kind", "fact", "--scope", "project", "--root", home]);
    const result = await runCli(["doctor"]);
    expect(result.stdout).toContain("scope placement: every project/path-scoped fact's root still exists");
    expect(result.stdout).not.toContain("missing root");
  });
});

// ─────────────────────────────────────────────────────────────────────────── mem init / uninstall ───────────────────────────────────────────────────────────────────────────

describe("mem init/uninstall", () => {
  let toolRoot: string;
  let toolHome: string;
  let fakeMemDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    // Separate fixture dirs from `home` (mem's own TOKEN_GOAT_MEM_HOME data dir) -- these are the fake "other tool" config root and home the wiring commands read/write, and must never resolve to the real ~/.claude, real VS Code config, or real project files.
    toolRoot = mkdtempSync(join(tmpdir(), "mem-cli-wiring-root-"));
    toolHome = mkdtempSync(join(tmpdir(), "mem-cli-wiring-home-"));
    vi.stubEnv("TOKEN_GOAT_MEM_WIRING_HOME", toolHome);

    // `mem init claude-code`'s pre-flight resolves whatever `mem` binary is actually on PATH and checks it against the hooks it's about to write (see wiring.ts's `checkClaudeHookHealth`). These tests are about the config-writing behavior, not that check, so a `mem` file that a capable scripted probe answers for is put ahead of the real PATH -- real end-to-end coverage of the check itself (a shim that *doesn't* support a flag) lives in its own describe block below. Prepending to the real PATH, not replacing it, keeps `bash`/`git`/etc. (which other tests in this file's PATH-independent init tests still need) resolvable.
    fakeMemDir = mkdtempSync(join(tmpdir(), "mem-cli-fake-mem-"));
    writeProbeTarget(fakeMemDir);
    originalPath = process.env["PATH"];
    process.env["PATH"] = `${fakeMemDir}${delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.env["PATH"] = originalPath;
    rmSync(fakeMemDir, { recursive: true, force: true });
    rmSync(toolRoot, { recursive: true, force: true });
    rmSync(toolHome, { recursive: true, force: true });
  });

  it("rejects an unknown tool name", async () => {
    const result = await runCli(["init", "not-a-real-tool", "--root", toolRoot]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid tool");
  });

  it("--dry-run reports what would be written without touching disk", async () => {
    const result = await runCli(["init", "codex", "--root", toolRoot, "--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("create");
    expect(existsSync(join(toolRoot, "AGENTS.md"))).toBe(false);
  });

  it("dry-run then real run: the real run matches what dry-run predicted, and produces no duplication on a second `init`", async () => {
    const dryRun = await runCli(["init", "claude-code", "--root", toolRoot, "--dry-run"]);
    expect(dryRun.exitCode).toBe(0);
    expect(dryRun.stdout).toContain(join(toolRoot, ".claude", "settings.json"));
    expect(dryRun.stdout).toContain(join(toolRoot, "CLAUDE.md"));

    const realRun = await runCli(["init", "claude-code", "--root", toolRoot]);
    expect(realRun.exitCode).toBe(0);
    expect(existsSync(join(toolRoot, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(toolRoot, "CLAUDE.md"))).toBe(true);

    const settings = JSON.parse(readFileSync(join(toolRoot, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].__token_goat_mem).toBe(true);
    const claudeMdAfterFirstInit = readFileSync(join(toolRoot, "CLAUDE.md"), "utf8");

    // Second init: no duplication (upgrade-in-place), matches the manual smoke test in the task spec.
    const second = await runCli(["init", "claude-code", "--root", toolRoot]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("noop");
    const settingsAfterSecond = JSON.parse(readFileSync(join(toolRoot, ".claude", "settings.json"), "utf8"));
    expect(settingsAfterSecond.hooks.SessionStart).toHaveLength(1);
    expect(readFileSync(join(toolRoot, "CLAUDE.md"), "utf8")).toBe(claudeMdAfterFirstInit);
  });

  it("uninstall returns the file to its pre-install state and touches nothing else", async () => {
    writeFileSync(join(toolRoot, "unrelated.txt"), "leave me alone\n", "utf8");

    await runCli(["init", "claude-code", "--root", toolRoot]);
    const uninstallDryRun = await runCli(["uninstall", "claude-code", "--root", toolRoot, "--dry-run"]);
    expect(uninstallDryRun.exitCode).toBe(0);
    expect(uninstallDryRun.stdout).toContain("remove");

    const uninstalled = await runCli(["uninstall", "claude-code", "--root", toolRoot]);
    expect(uninstalled.exitCode).toBe(0);

    // Neither file existed before this init created them, so "the pre-install state" is absence -- an empty `.claude/settings.json` or `CLAUDE.md` husk left behind would not be that state, and is exactly what a coding tool picks up as a real (if empty) instruction file.
    expect(existsSync(join(toolRoot, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(`${join(toolRoot, ".claude", "settings.json")}.token-goat-mem.bak`)).toBe(false);
    expect(existsSync(join(toolRoot, "CLAUDE.md"))).toBe(false);
    expect(existsSync(`${join(toolRoot, "CLAUDE.md")}.token-goat-mem.bak`)).toBe(false);
    expect(readFileSync(join(toolRoot, "unrelated.txt"), "utf8")).toBe("leave me alone\n");

    // Uninstalling again is a no-op, not an error.
    const again = await runCli(["uninstall", "claude-code", "--root", toolRoot]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("noop");
  });

  it("a full install/uninstall round trip on a fresh root leaves the directory listing exactly as it started, one tool at a time", async () => {
    // `.claude` and `.vscode` are directories mem creates that this fix deliberately leaves in place (only files are unlinked, never directories), so they are excluded from the comparison. Each tool is installed and uninstalled to completion before the next one starts, rather than installing all four and then uninstalling all four: codex/copilot-cli/copilot-vscode share AGENTS.md, and a *second* tool installing into a file a *different* tool's install already created legitimately takes a `.bak` of that (now mem-authored) content -- a real, unrelated feature of install, not the residue this fix removes. One tool at a time isolates the case this test exists to cover: a file no tool has touched yet, created and then fully uninstalled.
    const before = readdirSync(toolRoot).filter((name) => name !== ".claude" && name !== ".vscode");

    for (const tool of ["claude-code", "codex", "copilot-cli", "copilot-vscode"]) {
      const initResult = await runCli(["init", tool, "--root", toolRoot]);
      expect(initResult.exitCode).toBe(0);
      const uninstallResult = await runCli(["uninstall", tool, "--root", toolRoot]);
      expect(uninstallResult.exitCode).toBe(0);
    }

    const after = readdirSync(toolRoot).filter((name) => name !== ".claude" && name !== ".vscode");
    expect(after).toEqual(before);
  });

  it("--user writes/removes the user-level settings.json (under the isolated TOKEN_GOAT_MEM_WIRING_HOME) instead of the project one", async () => {
    await runCli(["init", "claude-code", "--root", toolRoot, "--user"]);
    expect(existsSync(join(toolRoot, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(toolHome, ".claude", "settings.json"))).toBe(true);

    await runCli(["uninstall", "claude-code", "--root", toolRoot, "--user"]);
    // settings.json never existed before this init created it under toolHome, so uninstall removes the file rather than leaving an empty `{}` behind.
    expect(existsSync(join(toolHome, ".claude", "settings.json"))).toBe(false);
  });

  it("uninstall --user only targets the user-level config, leaving project-level wiring untouched -- and its help text says so", async () => {
    // Regression: uninstall's `--user` help text read "Also target the tool's user-level config", implying it widens uninstall to both levels at once. The code has always targeted the user-level file *instead of* the project one (matching `init --user`, whose help already says "instead of"), so the wording was the bug, not the behavior -- fixed to match what actually runs.
    await runCli(["init", "claude-code", "--root", toolRoot]);
    await runCli(["init", "claude-code", "--root", toolRoot, "--user"]);

    const uninstallUser = await runCli(["uninstall", "claude-code", "--root", toolRoot, "--user"]);
    expect(uninstallUser.exitCode).toBe(0);
    expect(existsSync(join(toolHome, ".claude", "settings.json"))).toBe(false);
    // Project-level wiring is untouched by `--user`.
    expect(existsSync(join(toolRoot, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(toolRoot, "CLAUDE.md"))).toBe(true);

    const help = await runCli(["uninstall", "--help"]);
    expect(help.exitCode).toBe(0);
    const flowed = help.stdout.replace(/\s+/g, " ");
    expect(flowed).toMatch(/instead of project-level/i);
    expect(flowed).not.toMatch(/also target/i);
  });

  it("uninstall --all removes every tool's wiring in one call", async () => {
    for (const tool of ["claude-code", "codex", "copilot-cli", "copilot-vscode"]) {
      const result = await runCli(["init", tool, "--root", toolRoot]);
      expect(result.exitCode).toBe(0);
    }

    const result = await runCli(["uninstall", "--all", "--root", toolRoot]);
    expect(result.exitCode).toBe(0);
    for (const tool of ["claude-code", "codex", "copilot-cli", "copilot-vscode"]) {
      expect(result.stdout).toContain(`${tool}:`);
    }
    // AGENTS.md never existed before the first of codex/copilot-cli/copilot-vscode's init created it, so once the last of the three is uninstalled the shared block empties and the file is removed.
    expect(existsSync(join(toolRoot, "AGENTS.md"))).toBe(false);
  });

  it("uninstall --all reports a per-tool failure and keeps going, exiting 1, instead of hiding tools that already finished", async () => {
    // Before this fix, `uninstall --all` buffered every tool's output into one array and only wrote it to stdout after the whole loop finished, so a thrown error from one tool's file (a JSON parse failure here) discarded the output for every tool already uninstalled before it -- the opposite of what codex's successful uninstall, which ran first, deserves to have reported.
    const codexResult = await runCli(["init", "codex", "--root", toolRoot]);
    expect(codexResult.exitCode).toBe(0);
    const copilotVscodeResult = await runCli(["init", "copilot-vscode", "--root", toolRoot]);
    expect(copilotVscodeResult.exitCode).toBe(0);

    writeFileSync(join(toolRoot, ".vscode", "tasks.json"), "{", "utf8");

    const result = await runCli(["uninstall", "--all", "--root", toolRoot]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("codex:");
    expect(result.stdout).toContain(join(toolRoot, "AGENTS.md"));
    expect(result.stdout).toContain("copilot-vscode: failed");
  });

  it("uninstall requires a tool name or --all, and rejects combining them", async () => {
    const missing = await runCli(["uninstall", "--root", toolRoot]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("requires a tool name");

    const both = await runCli(["uninstall", "claude-code", "--all", "--root", toolRoot]);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("cannot combine");
  });

  it("init codex then init copilot-cli against the same AGENTS.md produces exactly one shared \"## Memory\" section tracking both tools; uninstalling codex leaves it intact with only copilot-cli remaining", async () => {
    const codexResult = await runCli(["init", "codex", "--root", toolRoot]);
    expect(codexResult.exitCode).toBe(0);
    const copilotCliResult = await runCli(["init", "copilot-cli", "--root", toolRoot]);
    expect(copilotCliResult.exitCode).toBe(0);

    const agentsMdPath = join(toolRoot, "AGENTS.md");
    const afterBothInit = readFileSync(agentsMdPath, "utf8");
    expect(afterBothInit.split("## Memory").length - 1).toBe(1);
    expect(afterBothInit).toContain("<!-- token-goat-mem:start tools=codex,copilot-cli -->");
    expect(afterBothInit).toContain("<!-- token-goat-mem:end -->");

    const uninstallCodex = await runCli(["uninstall", "codex", "--root", toolRoot]);
    expect(uninstallCodex.exitCode).toBe(0);

    const afterUninstallCodex = readFileSync(agentsMdPath, "utf8");
    expect(afterUninstallCodex.split("## Memory").length - 1).toBe(1);
    expect(afterUninstallCodex).toContain("<!-- token-goat-mem:start tools=copilot-cli -->");
    expect(afterUninstallCodex).not.toContain("tools=codex,copilot-cli");
    expect(afterUninstallCodex).not.toContain("tools=codex ");
    expect(afterUninstallCodex).toContain("mem recall --hint-format --root .");
  });

  it("init opencode --user writes opencode's global AGENTS.md under the wiring home, and uninstall removes it", async () => {
    const globalAgentsMd = join(toolHome, ".config", "opencode", "AGENTS.md");

    const init = await runCli(["init", "opencode", "--user", "--root", toolRoot]);
    expect(init.exitCode).toBe(0);
    expect(readFileSync(globalAgentsMd, "utf8")).toContain("<!-- token-goat-mem:start tools=opencode -->");
    expect(existsSync(join(toolRoot, "AGENTS.md"))).toBe(false);

    const uninstall = await runCli(["uninstall", "opencode", "--user", "--root", toolRoot]);
    expect(uninstall.exitCode).toBe(0);
    expect(existsSync(globalAgentsMd)).toBe(false);
  });

  it("init codex, copilot-cli, and copilot-vscode against the same AGENTS.md produces exactly one shared section tracking all three; uninstalling one at a time correctly decrements to zero", async () => {
    const agentsMdPath = join(toolRoot, "AGENTS.md");

    for (const tool of ["codex", "copilot-cli", "copilot-vscode"]) {
      const result = await runCli(["init", tool, "--root", toolRoot]);
      expect(result.exitCode).toBe(0);
    }

    const afterAllInit = readFileSync(agentsMdPath, "utf8");
    expect(afterAllInit.split("## Memory").length - 1).toBe(1);
    expect(afterAllInit).toContain("<!-- token-goat-mem:start tools=codex,copilot-cli,copilot-vscode -->");

    const uninstallCopilotVscode = await runCli(["uninstall", "copilot-vscode", "--root", toolRoot]);
    expect(uninstallCopilotVscode.exitCode).toBe(0);
    let current = readFileSync(agentsMdPath, "utf8");
    expect(current).toContain("<!-- token-goat-mem:start tools=codex,copilot-cli -->");
    expect(current.split("## Memory").length - 1).toBe(1);

    const uninstallCopilotCli = await runCli(["uninstall", "copilot-cli", "--root", toolRoot]);
    expect(uninstallCopilotCli.exitCode).toBe(0);
    current = readFileSync(agentsMdPath, "utf8");
    expect(current).toContain("<!-- token-goat-mem:start tools=codex -->");

    const uninstallCodex = await runCli(["uninstall", "codex", "--root", toolRoot]);
    expect(uninstallCodex.exitCode).toBe(0);
    // AGENTS.md never existed before codex's own init created it, so once the last tool tracked in the shared block is uninstalled, the file is removed rather than left empty.
    expect(existsSync(agentsMdPath)).toBe(false);
  });

  it("copilot-vscode init writes tasks.json, keybindings.json (under the isolated home), and AGENTS.md", async () => {
    const result = await runCli(["init", "copilot-vscode", "--root", toolRoot]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(toolRoot, ".vscode", "tasks.json"))).toBe(true);
    expect(existsSync(join(toolRoot, "AGENTS.md"))).toBe(true);

    const keybindingsPath =
      process.platform === "win32"
        ? join(toolHome, "AppData", "Roaming", "Code", "User", "keybindings.json")
        : process.platform === "darwin"
          ? join(toolHome, "Library", "Application Support", "Code", "User", "keybindings.json")
          : join(toolHome, ".config", "Code", "User", "keybindings.json");
    expect(existsSync(keybindingsPath)).toBe(true);
    const keybindings = JSON.parse(readFileSync(keybindingsPath, "utf8"));
    expect(keybindings).toHaveLength(2);
  });

  it("copilot-visual-studio init creates .github/copilot-instructions.md with the memory block, even when .github/ does not exist beforehand", async () => {
    expect(existsSync(join(toolRoot, ".github"))).toBe(false);
    const result = await runCli(["init", "copilot-visual-studio", "--root", toolRoot]);
    expect(result.exitCode).toBe(0);

    const content = readFileSync(join(toolRoot, ".github", "copilot-instructions.md"), "utf8");
    expect(content).toContain("<!-- token-goat-mem:start tools=copilot-visual-studio -->");
    expect(content).toContain("## Memory");
  });

  it("installing copilot-visual-studio and copilot-jetbrains then uninstalling one leaves the block intact; uninstalling the second removes it and the file", async () => {
    const instructionsPath = join(toolRoot, ".github", "copilot-instructions.md");

    for (const tool of ["copilot-visual-studio", "copilot-jetbrains"]) {
      const result = await runCli(["init", tool, "--root", toolRoot]);
      expect(result.exitCode).toBe(0);
    }
    const afterBothInit = readFileSync(instructionsPath, "utf8");
    expect(afterBothInit).toContain("<!-- token-goat-mem:start tools=copilot-jetbrains,copilot-visual-studio -->");

    const uninstallOne = await runCli(["uninstall", "copilot-visual-studio", "--root", toolRoot]);
    expect(uninstallOne.exitCode).toBe(0);
    const afterOneUninstall = readFileSync(instructionsPath, "utf8");
    expect(afterOneUninstall).toContain("<!-- token-goat-mem:start tools=copilot-jetbrains -->");
    expect(afterOneUninstall).toContain("## Memory");

    const uninstallTwo = await runCli(["uninstall", "copilot-jetbrains", "--root", toolRoot]);
    expect(uninstallTwo.exitCode).toBe(0);
    expect(existsSync(instructionsPath)).toBe(false);
  });

  it("--user is rejected for copilot-visual-studio and copilot-jetbrains", async () => {
    const visualStudioResult = await runCli(["init", "copilot-visual-studio", "--root", toolRoot, "--user"]);
    expect(visualStudioResult.exitCode).toBe(1);
    expect(visualStudioResult.stderr).toContain("no user-level config");

    const jetbrainsResult = await runCli(["init", "copilot-jetbrains", "--root", toolRoot, "--user"]);
    expect(jetbrainsResult.exitCode).toBe(1);
    expect(jetbrainsResult.stderr).toContain("no user-level config");

    expect(existsSync(join(toolRoot, ".github"))).toBe(false);
  });

  it("uninstall --all --user skips tools with no user-level config instead of failing", async () => {
    const init1 = await runCli(["init", "claude-code", "--user", "--root", toolRoot]);
    expect(init1.exitCode).toBe(0);
    const init2 = await runCli(["init", "copilot-visual-studio", "--root", toolRoot]);
    expect(init2.exitCode).toBe(0);

    const uninstall = await runCli(["uninstall", "--all", "--user", "--root", toolRoot]);
    expect(uninstall.exitCode).toBe(0);
    expect(uninstall.stdout).toContain("claude-code:");
    expect(uninstall.stdout).toContain("copilot-visual-studio: skipped");
    expect(uninstall.stdout).not.toContain("failed");
  });

  it("a pre-existing .github/copilot-instructions.md with hand-written content is preserved with a one-time .bak snapshot, and left with only its own content after uninstall", async () => {
    const instructionsPath = join(toolRoot, ".github", "copilot-instructions.md");
    mkdirSync(join(toolRoot, ".github"), { recursive: true });
    const original = "# Repo instructions\n\nUse two-space indentation.\n";
    writeFileSync(instructionsPath, original, "utf8");

    const initResult = await runCli(["init", "copilot-visual-studio", "--root", toolRoot]);
    expect(initResult.exitCode).toBe(0);
    expect(readFileSync(instructionsPath, "utf8")).not.toBe(original);
    expect(existsSync(`${instructionsPath}.token-goat-mem.bak`)).toBe(true);
    expect(readFileSync(`${instructionsPath}.token-goat-mem.bak`, "utf8")).toBe(original);

    const uninstallResult = await runCli(["uninstall", "copilot-visual-studio", "--root", toolRoot]);
    expect(uninstallResult.exitCode).toBe(0);
    expect(readFileSync(instructionsPath, "utf8")).toBe(original);
  });

  describe("regression: `mem init claude-code` no longer trusts a PATH binary it never checked", () => {
    // The incident this fix responds to: a newer `mem init` writes `--hook-stdin`/`scan-session` hooks, but the `mem` a real Claude Code session resolves from PATH at hook time is an older build that rejects those flags -- every hook then fails, silently, because nothing compared the write against the binary that would actually run it. These tests script an incapable answer (or leave no `mem` on PATH) in place of the capable one the file-level `beforeEach` installs, so the refusal path itself is exercised, not just its bypass.

    function installOldMemShim(dir: string): void {
      // The exact shape of the real incident: an install that predates `--hook-stdin`/`--delta` and `scan-session`.
      writeProbeTarget(dir);
      installProbe(OLD_PROBE);
    }

    it("refuses to write hooks an old PATH mem can't run, naming the binary and what it can't run", async () => {
      rmSync(fakeMemDir, { recursive: true, force: true });
      fakeMemDir = mkdtempSync(join(tmpdir(), "mem-cli-fake-mem-old-"));
      installOldMemShim(fakeMemDir);
      process.env["PATH"] = `${fakeMemDir}${delimiter}${originalPath ?? ""}`;

      const result = await runCli(["init", "claude-code", "--root", toolRoot]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("0.2.5");
      expect(result.stdout).toContain("no `mem hook <event>` entry point");
      expect(existsSync(join(toolRoot, ".claude", "settings.json"))).toBe(false);
      // The verdict came from probing the `mem` found on PATH: its version first, then its help.
      const calls = probeCalls();
      expect(calls[0]?.args).toEqual(["--version"]);
      expect(calls[0]?.bin.startsWith(fakeMemDir)).toBe(true);
    });

    it("--force writes the hooks anyway", async () => {
      rmSync(fakeMemDir, { recursive: true, force: true });
      fakeMemDir = mkdtempSync(join(tmpdir(), "mem-cli-fake-mem-old-"));
      installOldMemShim(fakeMemDir);
      process.env["PATH"] = `${fakeMemDir}${delimiter}${originalPath ?? ""}`;

      const result = await runCli(["init", "claude-code", "--root", toolRoot, "--force"]);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(toolRoot, ".claude", "settings.json"))).toBe(true);
    });

    it("--dry-run reports the same refusal instead of silently previewing a write that would be inert", async () => {
      rmSync(fakeMemDir, { recursive: true, force: true });
      fakeMemDir = mkdtempSync(join(tmpdir(), "mem-cli-fake-mem-old-"));
      installOldMemShim(fakeMemDir);
      process.env["PATH"] = `${fakeMemDir}${delimiter}${originalPath ?? ""}`;

      const result = await runCli(["init", "claude-code", "--root", toolRoot, "--dry-run"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("0.2.5");
      expect(existsSync(join(toolRoot, ".claude", "settings.json"))).toBe(false);
    });

    it("reports mem missing from PATH distinctly from mem present but incapable", async () => {
      rmSync(fakeMemDir, { recursive: true, force: true });
      fakeMemDir = mkdtempSync(join(tmpdir(), "mem-cli-fake-mem-empty-"));
      // No `mem`/`mem.cmd` written, and PATH is restricted to just this empty dir (plus node's own directory, so a child process could still resolve `node` if one were spawned) -- appending the real inherited PATH here would let this test's result depend on whether *this* machine happens to have a real `mem` installed globally, which is exactly the non-hermeticity this fix's own PATH-resolution logic must not have.
      process.env["PATH"] = `${fakeMemDir}${delimiter}${dirname(process.execPath)}`;

      const result = await runCli(["init", "claude-code", "--root", toolRoot]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("no mem binary found on PATH");
      expect(result.stdout).not.toContain("0.2.5");
      expect(probeCalls()).toEqual([]);
    });

    /** Installs the hooks with the capable shim the outer beforeEach already put on PATH, then swaps in the incapable one and runs `fn` from the project root -- `doctor` checks whatever settings.json already has, not what this build would write, so this is the "already installed, binary downgraded since" case. */
    async function withDowngradedBinary(fn: () => Promise<void>): Promise<void> {
      const installed = await runCli(["init", "claude-code", "--root", toolRoot]);
      expect(installed.exitCode).toBe(0);

      rmSync(fakeMemDir, { recursive: true, force: true });
      fakeMemDir = mkdtempSync(join(tmpdir(), "mem-cli-fake-mem-old-"));
      installOldMemShim(fakeMemDir);
      process.env["PATH"] = `${fakeMemDir}${delimiter}${originalPath ?? ""}`;

      const originalCwd = process.cwd();
      process.chdir(toolRoot);
      try {
        await fn();
      } finally {
        process.chdir(originalCwd);
      }
    }

    it("mem doctor reports the same incompatibility for hooks already installed", async () => {
      await withDowngradedBinary(async () => {
        const doctor = await runCli(["doctor"]);
        expect(doctor.exitCode).toBe(0);
        expect(doctor.stdout).toContain("0.2.5");
        expect(doctor.stdout).toContain("no `mem hook <event>` entry point");
      });
    });

    it("mem doctor --strict exits 1 on the incompatible binary, and --json names it as a failed hooks finding", async () => {
      await withDowngradedBinary(async () => {
        const strict = await runCli(["doctor", "--strict"]);
        expect(strict.exitCode).toBe(1);
        // --strict changes the exit code only; the report is the same text.
        expect(strict.stdout).toContain("0.2.5");

        const json = await runCli(["doctor", "--json"]);
        expect(json.exitCode).toBe(0);
        const report = JSON.parse(json.stdout) as { findings: { check: string; status: string }[]; epoch: number };
        expect(report.findings.some((finding) => finding.check === "hooks" && finding.status === "fail")).toBe(true);
        expect(typeof report.epoch).toBe("number");
      });
    });
  });
});

describe("mem --version (regression: the shipped bundle reports package.json's version)", () => {
  it("reports exactly package.json's version, executed from the built dist bundle", () => {
    // Asserts against the real artifact (built by tests/setup/build-bundle.ts), not the in-process `run()` the rest of this file drives, because the defect this guards was a hand-maintained literal in cli.ts that shipped 0.2.0 while package.json said 0.2.1 -- only the bundle proves the esbuild `define` that now supplies the version actually reached what users execute.
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };
    const bundle = fileURLToPath(new URL("../dist/token-goat-mem.mjs", import.meta.url));
    const reported = execFileSync(process.execPath, [bundle, "--version"], { encoding: "utf8" }).trim();
    expect(reported).toBe(pkg.version);
  });
});
