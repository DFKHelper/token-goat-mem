/** Synchronous launch of one probe of the `mem` binary that never leaves a live process behind when the probe budget expires. */

import { spawnSync } from "node:child_process";
import { basename, extname } from "node:path";

/** What one probe launch produced, reduced to the fields a verdict needs: `errorCode` is set when the process never ran to an exit (`ETIMEDOUT`, `ENOENT`, ...), and `status` is null then. */
export interface ProbeSpawnResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode?: string;
}

/** How long beyond the probe budget the helper process itself may take to start and report, since its own start-up is not part of the budget (a loaded machine takes several seconds to start one node). */
const PROBE_HELPER_GRACE_MS = 60_000;

/** The helper's argv slot holding the budget in milliseconds (`node -e <script> <budget> <command>`), so a test harness that lifts launch budgets can find it. */
export const PROBE_HELPER_BUDGET_ARG_INDEX = 2;

/** The helper run as `node -e`: starts the shell command asynchronously (so its pid is known), enforces the budget, and on expiry kills the whole process tree with `taskkill /T /F`, which `spawnSync`'s own timeout cannot do (it kills only the cmd.exe and orphans the real process). Prints one JSON line. */
const PROBE_HELPER_SCRIPT = `
const { spawn, spawnSync } = require("node:child_process");
const budget = Number(process.argv[1]);
const command = process.argv[2];
let stdout = "";
let stderr = "";
let done = false;
const finish = (status, errorCode) => {
  if (done) {
    return;
  }
  done = true;
  process.stdout.write(JSON.stringify({ status, stdout, stderr, errorCode }), () => process.exit(0));
};
const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdin.on("error", () => {});
child.stdin.end();
const timer = setTimeout(() => {
  if (child.pid !== undefined) {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  }
  finish(null, "ETIMEDOUT");
}, budget);
child.on("error", (error) => { clearTimeout(timer); finish(null, error.code || "UNKNOWN"); });
child.on("close", (code) => { clearTimeout(timer); finish(code, undefined); });
`;

/** Whether `binPath` is a Windows command script, which only a shell can launch (`spawn` raises `EINVAL` on one). */
function needsWindowsShell(binPath: string): boolean {
  const extension = extname(binPath).toLowerCase();
  return process.platform === "win32" && (extension === ".cmd" || extension === ".bat");
}

/** Runs `binPath <args>` for at most `timeoutMs` and returns what it produced, synchronously. A binary that needs no shell is spawned from an argv array with `shell` off, so a timeout kills the real process. A Windows `.cmd`/`.bat` shim runs through a shell as one quoted string (an args array together with `shell: true` is Node's DEP0190 footgun) inside a helper process that kills the whole process tree on timeout. */
export function spawnProbe(binPath: string, args: readonly string[], timeoutMs: number): ProbeSpawnResult {
  if (!needsWindowsShell(binPath)) {
    const result = spawnSync(binPath, [...args], { encoding: "utf8", timeout: timeoutMs });
    const errorCode = result.error === undefined ? undefined : String(Reflect.get(result.error, "code") ?? "UNKNOWN");
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(errorCode === undefined ? {} : { errorCode }) };
  }
  const quoted = [binPath, ...args].map((token) => `"${token}"`).join(" ");
  const helper = spawnSync(process.execPath, ["-e", PROBE_HELPER_SCRIPT, String(timeoutMs), quoted], { encoding: "utf8", timeout: timeoutMs + PROBE_HELPER_GRACE_MS });
  return parseHelperResult(helper.stdout ?? "", helper.error === undefined ? undefined : String(Reflect.get(helper.error, "code") ?? "UNKNOWN"));
}

/** Decodes the helper's one JSON line; a helper that produced none (it was killed, or failed to start) is an unanswered probe, never a verdict on the binary. */
function parseHelperResult(raw: string, helperErrorCode: string | undefined): ProbeSpawnResult {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const status: unknown = Reflect.get(parsed, "status");
      const stdout: unknown = Reflect.get(parsed, "stdout");
      const stderr: unknown = Reflect.get(parsed, "stderr");
      const errorCode: unknown = Reflect.get(parsed, "errorCode");
      return {
        status: typeof status === "number" ? status : null,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
        ...(typeof errorCode === "string" ? { errorCode } : {}),
      };
    }
  } catch {
    // Falls through to the unanswered result below.
  }
  return { status: null, stdout: "", stderr: "", errorCode: helperErrorCode ?? "EPROBEHELPER" };
}

/** Whether two probes launch the same program for the purpose of skipping after an unanswered one: a plain binary is its path, while a node launcher is told apart by its script argument, since `node <bundleA>` hanging says nothing about `node <bundleB>`. */
export function probeSkipKey(binPath: string, args: readonly string[]): string {
  const isNode = basename(binPath, extname(binPath)).toLowerCase() === "node";
  return JSON.stringify(isNode ? [binPath, args[0] ?? null] : [binPath]);
}
