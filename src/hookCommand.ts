/** `mem hook <event>`: the one entry point installed hook commands call. A settings file outlives the build that wrote it and a committed project file is shared by teammates on different builds, so the string it carries is only the frozen event slug; every flag and the project root live here, in the binary. Each slug runs the handler the old flag-carrying string ran, with the same implied flags, so the stdout contract (`TGMEM/2` for the two recall slugs) is unchanged. Nothing here writes a settings file. */

import type { Command } from "commander";

import { guard, UsageError } from "./cliRuntime.js";
import { parseHookEnvelope, primeHookStdin, readStreamWithTimeout } from "./hook-envelope.js";
import { MEM_HOOK_EVENT_SLUGS, RETIRED_MEM_HOOK_SLUGS, type MemHookSlug } from "./wiring.js";

/** The subcommand and flags each slug implies, exactly what the flag-carrying hook string wrote before `--root`, which `buildHookArgv` appends. */
export const MEM_HOOK_IMPLIED_ARGS: Readonly<Record<MemHookSlug, readonly string[]>> = {
  "session-start": ["recall", "--hint-format", "--hook-stdin"],
  "user-prompt-submit": ["recall", "--hint-format", "--hook-stdin", "--delta"],
  stop: ["reflect", "--hook-stdin"],
  "pre-compact": ["scan-session", "--hook-stdin", "--quiet"],
};

export function isMemHookSlug(value: string): value is MemHookSlug {
  return Object.hasOwn(MEM_HOOK_EVENT_SLUGS, value);
}

/** The project root a hook run binds to: the host's `CLAUDE_PROJECT_DIR`, else the `cwd` the envelope reported, else the process working directory. */
export function deriveHookRoot(env: Readonly<Record<string, string | undefined>>, envelopeCwd: string | undefined, processCwd: string): string {
  const fromEnv = env["CLAUDE_PROJECT_DIR"];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return fromEnv;
  }
  return envelopeCwd ?? processCwd;
}

/** The argv (after `mem`) the handler behind `slug` is run with. */
export function buildHookArgv(slug: MemHookSlug, root: string): string[] {
  return [...MEM_HOOK_IMPLIED_ARGS[slug], "--root", root];
}

export interface HookCommandOptions {
  /** Runs one argv (after `mem`) through a fresh copy of the full program; supplied by cli.ts, which this module cannot import without a cycle. */
  readonly dispatch: (argv: string[]) => Promise<void>;
  /** Slugs that exit 0 with empty stdout; defaults to `RETIRED_MEM_HOOK_SLUGS`. */
  readonly retired?: ReadonlySet<string>;
}

export function registerHookCommand(program: Command, options: HookCommandOptions): void {
  const retired = options.retired ?? RETIRED_MEM_HOOK_SLUGS;
  const slugs = Object.keys(MEM_HOOK_EVENT_SLUGS);
  program
    .command("hook <event>")
    .description(
      `Run the handler behind a Claude Code hook event; installed hook commands call this and nothing else. Events: ${slugs.join(", ")}. ` +
        "The project root comes from CLAUDE_PROJECT_DIR, else the hook envelope's cwd, else the current directory."
    )
    .allowExcessArguments(false)
    .action(
      guard(async (event: string) => {
        if (retired.has(event)) {
          return;
        }
        if (!isMemHookSlug(event)) {
          throw new UsageError(`unknown hook event ${JSON.stringify(event)} (one of ${slugs.join(", ")})`);
        }
        let envelopeCwd: string | undefined;
        if ((process.env["CLAUDE_PROJECT_DIR"] ?? "").trim().length === 0) {
          // The envelope is only needed for its cwd here, and a pipe reads once: hand the text on to the handler that parses the rest of it.
          const raw = await readStreamWithTimeout(process.stdin);
          envelopeCwd = parseHookEnvelope(raw).cwd;
          primeHookStdin(raw);
        }
        await options.dispatch(buildHookArgv(event, deriveHookRoot(process.env, envelopeCwd, process.cwd())));
      })
    );
}
