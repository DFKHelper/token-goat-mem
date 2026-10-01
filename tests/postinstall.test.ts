/** End-to-end tests for `scripts/postinstall.mjs`, the npm lifecycle script that wires Claude Code's user-level hooks on every global install and upgrade (`npm i -g token-goat-mem`), so recall runs in every project without a separate `mem init claude-code --user` step. Driven as npm drives it: a child `node` process with npm's own environment variables, against a throwaway home directory and a fake `mem` on PATH for the pre-flight hook-health check. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CAPABLE_MEM_SHIM, OLD_MEM_SHIM, writeFakeMem } from "./support/fakeMem.js";

const POSTINSTALL_PATH = fileURLToPath(new URL("../scripts/postinstall.mjs", import.meta.url));

let root: string;
let home: string;
let binDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mem-postinstall-"));
  home = join(root, "home");
  binDir = join(root, "bin");
  mkdirSync(home);
  mkdirSync(binDir);
  writeFakeMem(binDir, CAPABLE_MEM_SHIM);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface PostinstallResult {
  readonly output: string;
  readonly exitCode: number;
}

function runPostinstall(env: Readonly<Record<string, string>> = {}): PostinstallResult {
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
  // A bound of its own, so a postinstall that hangs fails the test instead of hanging the run.
  const result = spawnSync(process.execPath, [POSTINSTALL_PATH], { encoding: "utf8", env: childEnv, timeout: 30_000 });
  if (result.error !== undefined) {
    throw result.error;
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

describe("postinstall", () => {
  it("is wired as the package's postinstall script and shipped in the tarball", () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
      scripts: Record<string, string>;
      files: string[];
    };
    expect(manifest.scripts["postinstall"]).toBe("node scripts/postinstall.mjs");
    expect(manifest.files).toContain("scripts/postinstall.mjs");
  });

  it("installs mem's Claude Code hooks at user level on a global install", () => {
    mkdirSync(join(home, ".claude"));
    const result = runPostinstall();
    expect(result.exitCode, result.output).toBe(0);
    const commands = hookCommands();
    expect(commands.some((command) => command.includes("mem recall"))).toBe(true);
    expect(result.output).toContain("token-goat-mem:");
  });

  it("installs them even before Claude Code has created ~/.claude", () => {
    const result = runPostinstall();
    expect(result.exitCode, result.output).toBe(0);
    expect(hookCommands().some((command) => command.includes("mem recall"))).toBe(true);
  });

  it("keeps unrelated settings and is idempotent across upgrades", () => {
    mkdirSync(join(home, ".claude"));
    writeFileSync(settingsPath(), JSON.stringify({ theme: "dark" }, null, 2), "utf8");
    expect(runPostinstall().exitCode).toBe(0);
    const first = readFileSync(settingsPath(), "utf8");
    expect(runPostinstall().exitCode).toBe(0);
    expect(readFileSync(settingsPath(), "utf8")).toBe(first);
    expect((JSON.parse(first) as { theme?: string }).theme).toBe("dark");
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

  it("never fails the install when the mem on PATH cannot run the hooks, and names the fix", () => {
    writeFakeMem(binDir, OLD_MEM_SHIM);
    const result = runPostinstall();
    expect(result.exitCode).toBe(0);
    expect(existsSync(settingsPath())).toBe(false);
    expect(result.output).toContain("mem init claude-code --user");
  });

  it("gives up on a hook install that hangs rather than hanging the install", () => {
    // Loaded into every node the postinstall starts; only the one running `init` blocks, forever.
    const preload = join(root, "hang-on-init.cjs");
    writeFileSync(preload, 'if (process.argv.includes("init")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);\n');
    const started = Date.now();
    const result = runPostinstall({ NODE_OPTIONS: `--require ${JSON.stringify(preload)}`, TOKEN_GOAT_MEM_POSTINSTALL_TIMEOUT_MS: "1000" });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("timed out");
    expect(result.output).toContain("mem init claude-code --user");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 40_000);

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
