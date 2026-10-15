/** Tests for `scripts/postinstall.mjs`, the npm lifecycle script that wires Claude Code's user-level hooks on every global install and upgrade (`npm i -g token-goat-mem`), so recall runs in every project without a separate `mem init claude-code --user` step. Exactly one test runs the whole shipped chain as npm drives it (the script, the built bundle's `init`, a fake `mem` on PATH); the script's own branches run it as a child `node` against a stand-in bundle, and what `init --user` writes on a second or stale-PATH run goes through `run()` in-process with a scripted probe. */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkClaudeHookHealth, claudeHookEventsFor } from "../src/wiring.js";
import { runCli } from "./support/cli.js";
import { writeCheapCapableMem } from "./support/fakeMem.js";
import { CAPABLE_PROBE, installProbe, OLD_PROBE, resetProbe } from "./support/fakeProbe.js";
import type { ProbeResponder } from "./support/fakeProbe.js";

// The in-process `init --user` runs below script every probe of the `mem` binary, so no process starts and no budget decides a verdict.
vi.mock("../src/probeSpawn.js", async (importOriginal) => (await import("./support/fakeProbe.js")).withFakeProbe(await importOriginal<typeof import("../src/probeSpawn.js")>()));

// How long the stand-in `init` is allowed to run before the postinstall must kill it.
const HANG_TIMEOUT_MS = 1000;
// A diagnostic bound under vitest's 30 s testTimeout so a hung child fails with its stderr; it is not what makes the tests pass.
const SPAWN_TIMEOUT_MS = 25_000;

const POSTINSTALL_PATH = fileURLToPath(new URL("../scripts/postinstall.mjs", import.meta.url));

// Stand-ins for the built bundle: the script only spawns it as `node <bundle> init claude-code --user` and relays what it printed.
const ECHO_BUNDLE = 'process.stdout.write(`stand-in bundle ran: ${process.argv.slice(2).join(" ")}\\n`);\n';
const REFUSING_BUNDLE = 'process.stderr.write("stand-in bundle refused: the mem on PATH cannot run these hooks\\n");\nprocess.exit(1);\n';
const HANGING_BUNDLE = "setInterval(() => {}, 60000);\n";

let root: string;
let home: string;
let binDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-postinstall-"));
  home = join(root, "home");
  binDir = join(root, "bin");
  mkdirSync(home);
  mkdirSync(binDir);
  writeCheapCapableMem(binDir);
});

afterEach(() => {
  resetProbe();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

interface PostinstallResult {
  readonly output: string;
  readonly exitCode: number;
}

/** A copy of the script next to a stand-in `dist/token-goat-mem.mjs`, which is where the script looks for the bundle it spawns. */
function scriptWithBundle(bundleSource: string): string {
  const packageDir = join(root, "package");
  mkdirSync(join(packageDir, "scripts"), { recursive: true });
  mkdirSync(join(packageDir, "dist"));
  const script = join(packageDir, "scripts", "postinstall.mjs");
  copyFileSync(POSTINSTALL_PATH, script);
  writeFileSync(join(packageDir, "dist", "token-goat-mem.mjs"), bundleSource, "utf8");
  return script;
}

function runPostinstall(env: Readonly<Record<string, string>> = {}, script: string = POSTINSTALL_PATH): PostinstallResult {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${binDir}${delimiter}${process.env["PATH"] ?? ""}`,
    npm_config_global: "true",
  };
  delete childEnv["TOKEN_GOAT_MEM_WIRING_HOME"];
  delete childEnv["TOKEN_GOAT_MEM_SKIP_HOOKS"];
  Object.assign(childEnv, env);
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: childEnv, timeout: SPAWN_TIMEOUT_MS, killSignal: "SIGKILL" });
  if (result.error !== undefined || result.signal !== null) {
    throw new Error(`postinstall did not finish (error: ${String(result.error?.message)}, signal: ${String(result.signal)}); stdout: ${result.stdout}; stderr: ${result.stderr}`);
  }
  return { output: `${result.stdout}${result.stderr}`, exitCode: result.status ?? 1 };
}

const settingsPath = (): string => join(home, ".claude", "settings.json");

function hookCommands(): string[] {
  const settings = JSON.parse(readFileSync(settingsPath(), "utf8")) as {
    hooks?: Record<string, { hooks: { command: string }[] }[]>;
  };
  return Object.values(settings.hooks ?? {}).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
}

/** Points the in-process wiring at the throwaway home, with the fake `mem` first on PATH for the pre-flight lookup (the scripted probe answers it). */
function useThrowawayHome(): void {
  vi.stubEnv("TOKEN_GOAT_MEM_WIRING_HOME", home);
  vi.stubEnv("PATH", `${binDir}${delimiter}${process.env["PATH"] ?? ""}`);
}

describe("postinstall", () => {
  it("is wired as the package's postinstall script and shipped in the tarball", () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
      scripts: Record<string, string>;
      files: string[];
    };
    expect(manifest.scripts["postinstall"]).toBe("node scripts/postinstall.mjs");
    expect(manifest.files).toContain("scripts/postinstall.mjs");
  });

  it("installs mem's Claude Code hooks at user level on a global install, even before Claude Code has created ~/.claude", () => {
    const result = runPostinstall();
    expect(result.exitCode, result.output).toBe(0);
    expect(hookCommands().some((command) => command.includes("mem recall"))).toBe(true);
    expect(result.output).toContain("token-goat-mem:");
  });

  it("keeps unrelated settings and is idempotent across upgrades", async () => {
    useThrowawayHome();
    installProbe(CAPABLE_PROBE);
    mkdirSync(join(home, ".claude"));
    writeFileSync(settingsPath(), JSON.stringify({ theme: "dark" }, null, 2), "utf8");
    const first = await runCli(["init", "claude-code", "--user"]);
    expect(first.exitCode, first.stderr).toBe(0);
    const afterFirst = readFileSync(settingsPath(), "utf8");
    const second = await runCli(["init", "claude-code", "--user"]);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(readFileSync(settingsPath(), "utf8")).toBe(afterFirst);
    expect((JSON.parse(afterFirst) as { theme?: string }).theme).toBe("dark");
    expect(hookCommands().some((command) => command.includes("mem recall"))).toBe(true);
  });

  it("runs the bundle's `init claude-code --user` when npm marks a global install only through npm_config_location", () => {
    const result = runPostinstall({ npm_config_global: "", npm_config_location: "global" }, scriptWithBundle(ECHO_BUNDLE));
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("stand-in bundle ran: init claude-code --user");
  });

  it("does nothing on a local (non-global) install", () => {
    const result = runPostinstall({ npm_config_global: "" });
    expect(result.exitCode).toBe(0);
    expect(existsSync(settingsPath())).toBe(false);
    expect(result.output).toBe("");
  });

  it.each(["1", "true"])("honors TOKEN_GOAT_MEM_SKIP_HOOKS=%s", (value) => {
    const result = runPostinstall({ TOKEN_GOAT_MEM_SKIP_HOOKS: value });
    expect(result.exitCode).toBe(0);
    expect(existsSync(settingsPath())).toBe(false);
    expect(result.output).toContain("TOKEN_GOAT_MEM_SKIP_HOOKS");
  });

  it("never fails the install when the bundle's init refuses, and names the fix", () => {
    const result = runPostinstall({}, scriptWithBundle(REFUSING_BUNDLE));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("stand-in bundle refused");
    expect(result.output).toContain("Claude Code hooks were not installed");
    expect(result.output).toContain("mem init claude-code --user");
  });

  it("refuses plain hooks a stale PATH mem cannot run, but not Windows user hooks, which launch the installed bundle instead", () => {
    // The stale PATH mem answers as an old install would; the bundle the Windows hooks launch is current, and it is the one process.execPath runs.
    const staleOnPath: ProbeResponder = (call) => (call.bin === process.execPath ? CAPABLE_PROBE(call) : OLD_PROBE(call));
    installProbe(staleOnPath);
    const bundle = join(root, "dist", "token-goat-mem.mjs").replace(/\\/gu, "/");
    mkdirSync(dirname(bundle), { recursive: true });
    writeFileSync(bundle, "", "utf8");
    const plain = checkClaudeHookHealth(claudeHookEventsFor({ user: true, platform: "linux" }), { pathEnv: binDir, trustBundles: true });
    expect(plain.hooks.length, "plain hooks checked").toBeGreaterThan(0);
    expect(plain.hooks.some((hook) => hook.capable), "a stale PATH mem runs no plain hook").toBe(false);
    const direct = checkClaudeHookHealth(claudeHookEventsFor({ user: true, platform: "win32", bundlePath: bundle }), { pathEnv: binDir, trustBundles: true });
    expect(direct.hooks.length, "direct hooks checked").toBeGreaterThan(0);
    expect(direct.hooks.every((hook) => hook.capable), "the bundle runs every direct hook").toBe(true);
  });

  it("gives up on a hook install that hangs rather than hanging the install", () => {
    const result = runPostinstall({ TOKEN_GOAT_MEM_POSTINSTALL_TIMEOUT_MS: String(HANG_TIMEOUT_MS) }, scriptWithBundle(HANGING_BUNDLE));
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("timed out");
    expect(result.output).toContain("mem init claude-code --user");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "leaves the hooks alone when run as someone other than the home directory's owner, as under sudo",
    () => {
      // `/` belongs to root, so this unprivileged run stands in for root writing into a user's home.
      const result = runPostinstall({ HOME: "/" });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("skipped Claude Code hooks");
      expect(result.output).toContain("mem init claude-code --user");
      expect(result.output).not.toContain("were not installed");
    }
  );
});
