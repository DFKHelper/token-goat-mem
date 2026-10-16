/** Tests for `scripts/postinstall.mjs`, the npm lifecycle script that wires Claude Code's user-level hooks on every global install and upgrade (`npm i -g token-goat-mem`), so recall runs in every project without a separate `mem init claude-code --user` step. Exactly one test runs the whole shipped chain as npm drives it (the script, the built bundle's `init`, a fake `mem` on PATH); the script's own branches run it as a child `node` against a stand-in bundle, and what `init --user` writes on a second or stale-PATH run goes through `run()` in-process with a scripted probe. */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { stopProcessGroup } from "../scripts/postinstall.mjs";
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

/** Whether `pid` is a live process: a zombie still answers signal 0 until its parent or init reaps it, so on Linux its state is read as well. */
function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${String(pid)}/stat`, "utf8"));
  } catch {
    return true;
  }
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

  // Windows stops the helpers with init (its install is not detached), so only POSIX has a group to stop; the real timeout path there is covered by the hang test above.
  it.skipIf(process.platform === "win32")("stops the helpers a hook install started, not only the install itself", async () => {
    // The helper shares the stand-in init's stdout, so the pipe closes only once both are gone: the test waits on that event and on the helper's own ready line, never on a clock.
    const helper = "require('node:net').createServer().listen(0, () => console.log('ready ' + process.pid))";
    const init = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: ['ignore', 'inherit', 'inherit'] }); require('node:net').createServer().listen(0);`;
    const child = spawn(process.execPath, ["-e", init], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
    let helperPid = Number.NaN;
    try {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      helperPid = await new Promise<number>((resolve, reject) => {
        let seen = "";
        child.stdout.on("data", (chunk: Buffer) => {
          seen += chunk.toString("utf8");
          const match = /ready (\d+)/.exec(seen);
          if (match?.[1] !== undefined) {
            resolve(Number(match[1]));
          }
        });
        child.once("error", reject);
        child.once("close", () => reject(new Error(`the stand-in init ended before its helper was ready: ${seen}`)));
      });
      expect(processIsRunning(helperPid), "the helper runs before the timeout path").toBe(true);

      // What the timeout does: spawnSync kills init, then the group is stopped.
      child.kill("SIGKILL");
      stopProcessGroup(child.pid);
      await closed;
      expect(processIsRunning(helperPid), `helper ${String(helperPid)} still running`).toBe(false);
    } finally {
      stopProcessGroup(child.pid);
      if (Number.isInteger(helperPid) && processIsRunning(helperPid)) {
        process.kill(helperPid, "SIGKILL");
      }
      child.stdout.destroy();
    }
  });

  // The real script drives the timeout and `main()` must stop the group; Windows stops the helpers with init, so only POSIX has a group to stop.
  it.skipIf(process.platform === "win32")("stops the helpers a hook install that timed out started, through the real script", async () => {
    // Event, not clock or probe: the helper alone holds the FIFO's write end, so the reader's EOF is the kernel reporting that it exited (a signal-0 probe also succeeds on a zombie). Its own directory, because the afterEach hook removes `root` before onTestFinished runs.
    const fifoDir = mkdtempSync(join(tmpdir(), "mem-postinstall-fifo-"));
    const fifo = join(fifoDir, "helper.fifo");
    let helperPid = Number.NaN;
    let helperEnded = false;
    onTestFinished(() => {
      if (!helperEnded && Number.isInteger(helperPid)) {
        try {
          process.kill(helperPid, "SIGKILL");
        } catch {
          // The helper is already gone.
        }
      }
      // Read-write never blocks and satisfies a reader still waiting for a writer, so nothing stays parked in the pool.
      if (existsSync(fifo)) {
        closeSync(openSync(fifo, "r+"));
      }
      rmSync(fifoDir, { recursive: true, force: true });
    });
    execFileSync("mkfifo", [fifo]);
    // Queued before the script blocks this thread: the open waits in the thread pool until the stand-in init opens the write end.
    const opening = open(fifo, "r");
    const init = [
      'import { spawn } from "node:child_process";',
      'import { closeSync, openSync, writeSync } from "node:fs";',
      `const fd = openSync(${JSON.stringify(fifo)}, "w");`,
      // The helper stays in init's process group and holds only the FIFO, so it does not keep the script's captured stdout open.
      'const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: ["ignore", "ignore", "ignore", fd] });',
      "writeSync(fd, `${String(helper.pid)}\\n`);",
      "closeSync(fd);",
      HANGING_BUNDLE,
    ].join("\n");

    const result = runPostinstall({ TOKEN_GOAT_MEM_POSTINSTALL_TIMEOUT_MS: String(HANG_TIMEOUT_MS) }, scriptWithBundle(init));
    expect(result.exitCode, "the script exits 0 after its timeout").toBe(0);
    expect(result.output, "the script reports the timeout").toContain("timed out");

    // Ends at EOF once the helper exited; a helper left running holds the stream open until the test times out, which is the failure.
    const handle = await opening;
    let seen = "";
    for await (const chunk of handle.createReadStream({ encoding: "utf8" })) {
      seen += chunk;
      helperPid = Number.parseInt(seen, 10);
    }
    helperEnded = true;
    expect(Number.isInteger(helperPid), `the stand-in init reported its helper's pid, got ${JSON.stringify(seen)}`).toBe(true);
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
