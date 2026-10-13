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

/** Answers nothing for a few seconds, then exits 0: a healthy binary that a probe with a short budget cannot tell from a hang. */
export const HANGING_MEM_SHIM = "#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 5000);\n";

/** Exits 127 at once, as a shell does for a command it cannot find. */
export const NOT_RUNNABLE_MEM_SHIM = "#!/usr/bin/env node\nprocess.exit(127);\n";

/** Hangs on its first invocation (recorded by a marker file named by `FAKE_MEM_MARKER`) and answers like `CAPABLE_MEM_SHIM` on every later one: a healthy binary that was slow once, the case an init pre-flight retry exists for. */
export const HANG_ONCE_MEM_SHIM =
  "#!/usr/bin/env node\n" +
  'const fs = require("node:fs");\n' +
  "const marker = process.env.FAKE_MEM_MARKER;\n" +
  'if (marker && !fs.existsSync(marker)) { fs.writeFileSync(marker, "hung"); setTimeout(() => process.exit(0), 60000); } else {\n' +
  "const args = process.argv.slice(2);\n" +
  'if (args[0] === "--version") { process.stdout.write("0.0.0-test-shim\\n"); process.exit(0); }\n' +
  'if (args[1] === "--help") { process.stdout.write("--hint-format --hook-stdin --delta --quiet --root session-start user-prompt-submit stop pre-compact\\n"); process.exit(0); }\n' +
  "process.exit(1);\n" +
  "}\n";

/** Writes `body` as `mem.js` plus launchers (`mem`, `mem.cmd`) that append one line to the file named by `FAKE_MEM_COUNTER` before node starts, so a launch is counted even when the probe's budget kills the launcher before node is up; the POSIX launcher uses only shell builtins (no `dirname`), because a test may narrow PATH to this directory plus node's own, where an external utility is not found. */
export function writeCountingFakeMem(dir: string, body: string): void {
  writeFileSync(join(dir, "mem.js"), body, "utf8");
  writeFileSync(join(dir, "mem"), '#!/bin/sh\necho launch >> "$FAKE_MEM_COUNTER"\nexec node "${0%/*}/mem.js" "$@"\n', "utf8");
  chmodSync(join(dir, "mem"), 0o755);
  writeFileSync(join(dir, "mem.cmd"), `@echo off\r\necho launch>>"%FAKE_MEM_COUNTER%"\r\nnode "%~dp0mem.js" %*\r\n`, "utf8");
}

/** Writes `body` as `mem` (and a `mem.cmd` wrapper) into `dir`. */
export function writeFakeMem(dir: string, body: string): void {
  writeFileSync(join(dir, "mem"), body, "utf8");
  chmodSync(join(dir, "mem"), 0o755);
  writeFileSync(join(dir, "mem.cmd"), `@echo off\r\nnode "%~dp0mem" %*\r\n`, "utf8");
}
