/**
 * Fake `mem` binaries for tests that exercise `mem init claude-code`'s pre-flight, which resolves
 * whatever `mem` is on PATH and checks it can run the hooks about to be written (wiring.ts's
 * `checkClaudeHookHealth`). Each writer drops a node script named `mem` plus a `mem.cmd` wrapper so
 * the same directory resolves on POSIX and Windows.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Reports every flag the installed hooks use as supported. */
export const CAPABLE_MEM_SHIM =
  "#!/usr/bin/env node\n" +
  "const args = process.argv.slice(2);\n" +
  'if (args[0] === "--version") { process.stdout.write("0.0.0-test-shim\\n"); process.exit(0); }\n' +
  'if (args[1] === "--help") { process.stdout.write("--hint-format --hook-stdin --delta --quiet --root\\n"); process.exit(0); }\n' +
  "process.exit(1);\n";

/**
 * Understands `--version` and a `--help` for `recall`, but its help text is missing
 * `--hook-stdin`/`--delta`, and it has no `scan-session` subcommand at all -- the shape of an
 * install that predates both.
 */
export const OLD_MEM_SHIM =
  "#!/usr/bin/env node\n" +
  "const args = process.argv.slice(2);\n" +
  'if (args[0] === "--version") { process.stdout.write("0.2.5\\n"); process.exit(0); }\n' +
  'if (args[0] === "recall" && args[1] === "--help") { process.stdout.write("--hint-format --root\\n"); process.exit(0); }\n' +
  "process.exit(1);\n";

/** Writes `body` as `mem` (and a `mem.cmd` wrapper) into `dir`. */
export function writeFakeMem(dir: string, body: string): void {
  writeFileSync(join(dir, "mem"), body, "utf8");
  chmodSync(join(dir, "mem"), 0o755);
  writeFileSync(join(dir, "mem.cmd"), `@echo off\r\nnode "%~dp0mem" %*\r\n`, "utf8");
}
