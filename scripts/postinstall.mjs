#!/usr/bin/env node
/** npm `postinstall`: on a global install or upgrade (`npm i -g token-goat-mem`), wires mem's Claude Code hooks into the user-level `~/.claude/settings.json`, so recall runs in every project without a separate `mem init claude-code --user` step -- and an upgrade refreshes hooks an older mem wrote. Runs the freshly installed bundle's own `mem init claude-code --user`, which is idempotent and keeps its pre-flight check that the `mem` on PATH can run the hooks it writes (never `--force`: a hook that fails on every prompt is worse than none). Never fails the install: every outcome exits 0, and anything short of success prints the command that finishes the job. npm 7+ only shows this output with `--foreground-scripts`; `mem doctor` reports hook health either way. Skipped on a local install (a dependency or this repository's own `npm install`), when `TOKEN_GOAT_MEM_SKIP_HOOKS` is `1` or `true`, and when the process runs as someone other than the owner of the home directory it would write into -- root under `sudo npm i -g`, which would leave a root-owned `~/.claude/settings.json` the user's own Claude Code cannot update. The init is killed if it runs past `TOKEN_GOAT_MEM_POSTINSTALL_TIMEOUT_MS` (two minutes by default), so a hang never holds the install hostage. Only npm runs this: pnpm, yarn and bun do not run a dependency's install scripts by default, and neither does `--ignore-scripts`. Those installs need `mem init claude-code --user` by hand. */

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const PREFIX = "token-goat-mem: ";
const REMEDY = "run `mem init claude-code --user` to install the Claude Code hooks";
const BUNDLE = fileURLToPath(new URL("../dist/token-goat-mem.mjs", import.meta.url));
const DEFAULT_TIMEOUT_MS = 120_000;

function initTimeoutMs() {
  const configured = Number(process.env["TOKEN_GOAT_MEM_POSTINSTALL_TIMEOUT_MS"]);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

/** Why the hooks must not be written as this user, or `undefined` when they may. POSIX only. */
function foreignOwner() {
  if (typeof process.getuid !== "function") {
    return undefined;
  }
  const home = homedir();
  const uid = process.getuid();
  const owner = statSync(home).uid;
  return uid === owner ? undefined : `running as uid ${String(uid)} but ${home} belongs to uid ${String(owner)}`;
}

/** Kills what is left of the group init led after its own kill; a no-op on Windows, where init was not detached, and when the group is already gone. */
export function stopProcessGroup(pid) {
  if (process.platform === "win32" || pid === undefined) {
    return;
  }
  // A pid of 0 or below would make -pid address this process's own group, and 1 every process.
  if (!Number.isInteger(pid) || pid <= 1) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group has no member left.
  }
}

function say(text) {
  const lines = text.trimEnd().split(/\r?\n/).filter((line) => line.length > 0);
  for (const line of lines) {
    process.stdout.write(`${PREFIX}${line}\n`);
  }
}

function main() {
  const skip = (process.env["TOKEN_GOAT_MEM_SKIP_HOOKS"] ?? "").trim().toLowerCase();
  if (skip === "1" || skip === "true") {
    say(`TOKEN_GOAT_MEM_SKIP_HOOKS is set; skipped Claude Code hooks (${REMEDY})`);
    return;
  }
  const isGlobal = process.env["npm_config_global"] === "true" || process.env["npm_config_location"] === "global";
  if (!isGlobal || !existsSync(BUNDLE)) {
    return;
  }
  const foreign = foreignOwner();
  if (foreign !== undefined) {
    say(`${foreign}; skipped Claude Code hooks so their settings stay the home owner's (as that user, without sudo, ${REMEDY})`);
    return;
  }
  const timeout = initTimeoutMs();
  // If this script is itself killed from outside (npm killed), the detached init is orphaned, but it ends on its own within its bounded probes and lock wait (about 2.5 min).
  const result = spawnSync(process.execPath, [BUNDLE, "init", "claude-code", "--user"], {
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    // POSIX only: its own process group, so the timeout can stop the helpers init spawned too, which the kill of init alone leaves running; Windows stops them with init, and detaching there opens a console.
    detached: process.platform !== "win32",
  });
  say(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.error?.code === "ETIMEDOUT") {
    stopProcessGroup(result.pid);
    say(`\`mem init claude-code --user\` timed out after ${String(timeout / 1000)}s and was stopped`);
  }
  if (result.error !== undefined || result.status !== 0) {
    say(`Claude Code hooks were not installed; ${REMEDY}`);
  }
}

/** Whether node was started on this file, as npm does, and not by an import that only wants `stopProcessGroup`. */
function isEntryPoint() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    main();
  } catch (error) {
    say(`postinstall failed (${error instanceof Error ? error.message : String(error)}); ${REMEDY}`);
  }
}
