/** Fake `mem` binaries for tests that exercise `mem init claude-code`'s pre-flight, which resolves whatever `mem` is on PATH and checks it can run the hooks about to be written (wiring.ts's `checkClaudeHookHealth`). Each writer drops a node script named `mem` plus a `mem.cmd` wrapper so the same directory resolves on POSIX and Windows. */

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Reports every flag the installed hooks use as supported. */
export const CAPABLE_MEM_SHIM =
  "#!/usr/bin/env node\n" +
  "const args = process.argv.slice(2);\n" +
  'if (args[0] === "--version") { process.stdout.write("0.0.0-test-shim\\n"); process.exit(0); }\n' +
  'if (args[1] === "--help") { process.stdout.write("--hint-format --hook-stdin --delta --quiet --root session-start user-prompt-submit stop pre-compact\\n"); process.exit(0); }\n' +
  "process.exit(1);\n";

/** Understands `--version` and a `--help` for `recall`, but its help text is missing `--hook-stdin`/`--delta`, it has no `scan-session` subcommand at all, and it has no `hook` command: `hook --help` exits 1 as Commander does for an unknown command -- the shape of an install that predates all three. */
export const OLD_MEM_SHIM =
  "#!/usr/bin/env node\n" +
  "const args = process.argv.slice(2);\n" +
  'if (args[0] === "--version") { process.stdout.write("0.2.5\\n"); process.exit(0); }\n' +
  'if (args[0] === "recall" && args[1] === "--help") { process.stdout.write("--hint-format --root\\n"); process.exit(0); }\n' +
  "process.exit(1);\n";

/** Answers nothing and never exits: a probe's budget, not the shim, is what ends it, so no wall clock inside the shim decides a verdict. */
export const HANGING_MEM_SHIM = "#!/usr/bin/env node\nsetInterval(() => {}, 60000);\n";

/** Exits 127 at once, as a shell does for a command it cannot find. */
export const NOT_RUNNABLE_MEM_SHIM = "#!/usr/bin/env node\nprocess.exit(127);\n";

// The capable answers of CAPABLE_MEM_SHIM, as a shell script and a batch file: neither starts node, so a probe of it costs a shell start instead of a cold node start.
const CAPABLE_SH =
  "#!/bin/sh\n" +
  'if [ "$1" = "--version" ]; then echo 0.0.0-test-shim; exit 0; fi\n' +
  'if [ "$2" = "--help" ]; then echo "--hint-format --hook-stdin --delta --quiet --root session-start user-prompt-submit stop pre-compact"; exit 0; fi\n' +
  "exit 1\n";
const CAPABLE_BAT =
  "@echo off\r\n" +
  'if "%~1"=="--version" (\r\n  echo 0.0.0-test-shim\r\n  exit /b 0\r\n)\r\n' +
  'if "%~2"=="--help" (\r\n  echo --hint-format --hook-stdin --delta --quiet --root session-start user-prompt-submit stop pre-compact\r\n  exit /b 0\r\n)\r\n' +
  "exit /b 1\r\n";

/** Writes a `mem` that answers like CAPABLE_MEM_SHIM without starting node (a `mem` shell script, and a `mem.cmd` batch file that PATH resolution prefers on Windows), for tests that spawn a real chain and are not about the probe. */
export function writeCheapCapableMem(dir: string): void {
  writeFileSync(join(dir, "mem"), CAPABLE_SH, "utf8");
  chmodSync(join(dir, "mem"), 0o755);
  writeFileSync(join(dir, "mem.cmd"), CAPABLE_BAT, "utf8");
}

/** Writes `body` as `mem` (and a `mem.cmd` wrapper) into `dir`. */
export function writeFakeMem(dir: string, body: string): void {
  writeFileSync(join(dir, "mem"), body, "utf8");
  chmodSync(join(dir, "mem"), 0o755);
  writeFileSync(join(dir, "mem.cmd"), `@echo off\r\nnode "%~dp0mem" %*\r\n`, "utf8");
}
