/** `mem doctor`'s wiring checks, kept out of doctor.ts: whether each supported tool's mem block is present and current (`wiring`), whether project- and user-level Claude Code hooks disagree (`hook-divergence`), and whether the PATH `mem` a hook would launch starts slowly (`launch-time`). All are read-only. "Current" is not re-derived here: it is whatever `getToolWiring(tool).describe()` says `mem init <tool>` would change, so a template edit in wiring.ts moves this check with it and there is no second copy to forget. */

import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { Finding } from "./doctor.js";
import {
  getToolWiring,
  installedClaudeHookCommands,
  parseHookBundlePath,
  parseHookCommandSpec,
  projectSettingsIsUserSettings,
  timeMemLaunch,
  TOOL_NAMES,
  WiringUserUnsupportedError,
  type ToolName,
  type WiringOpts,
  type WiringPlan,
} from "./wiring.js";

/** `TOKEN_GOAT_MEM_WIRING_HOME` overrides the home directory user-level wiring resolves under -- same override-for-tests purpose as `TOKEN_GOAT_MEM_HOME` in db.ts, kept separate since it names a coding tool's home, not mem's own data home. */
export function wiringHomeFromEnv(): string | undefined {
  const override = process.env["TOKEN_GOAT_MEM_WIRING_HOME"];
  return typeof override === "string" && override.trim().length > 0 ? override : undefined;
}

type Scope = "project" | "user";

function insideRoot(path: string, root: string): boolean {
  return resolve(path).startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** The plan for one tool at one scope, or `null` when the tool has no such scope. A project plan keeps only files under the root: a tool such as copilot-vscode also lists a user-level file there, which belongs to the user scope. */
function planFor(tool: ToolName, scope: Scope, opts: WiringOpts): WiringPlan | null {
  try {
    const plan = getToolWiring(tool).describe({ ...opts, user: scope === "user" });
    if (scope === "user") {
      return plan;
    }
    const root = resolve(opts.root ?? process.cwd());
    const sameAsUserSettings = projectSettingsIsUserSettings(opts);
    return { entries: plan.entries.filter((entry) => insideRoot(entry.path, root) && !(sameAsUserSettings && tool === "claude-code" && entry.path.endsWith("settings.json"))) };
  } catch (error) {
    if (error instanceof WiringUserUnsupportedError) {
      return null;
    }
    throw error;
  }
}

function remedyFor(tool: ToolName, scope: Scope, opts: WiringOpts): string {
  const parts = ["mem", "init", tool];
  if (scope === "user") {
    parts.push("--user");
  } else if (opts.root !== undefined) {
    parts.push("--root", opts.root);
  }
  return parts.join(" ");
}

/** One finding per tool and scope that has any mem content: `ok` when `mem init` would change nothing, `warn` when it would (an outdated block, a hand edit inside the markers, a hook missing an event, a file mem wrote half of). Tools mem is not in are one informational line: a user need not wire every tool, so that is `ok`, never a warning. */
export function describeWiringDrift(opts: WiringOpts): Finding[] {
  const findings: Finding[] = [];
  const absent: ToolName[] = [];
  for (const tool of TOOL_NAMES) {
    let installedAnywhere = false;
    for (const scope of ["project", "user"] as const) {
      let plan: WiringPlan | null;
      try {
        plan = planFor(tool, scope, opts);
      } catch (error) {
        // A hand-written entry in the way, or a config that does not parse: `mem init` would refuse, so it is not current.
        const reason = error instanceof Error ? error.message : String(error);
        findings.push({ check: "wiring", status: "warn", message: `wiring (${tool}, ${scope}): cannot be checked -- ${reason}`, remedy: remedyFor(tool, scope, opts) });
        installedAnywhere = true;
        continue;
      }
      if (plan === null || !plan.entries.some((entry) => entry.uninstallAction === "remove")) {
        continue;
      }
      installedAnywhere = true;
      const stale = plan.entries.filter((entry) => entry.installAction !== "noop");
      findings.push(
        stale.length === 0
          ? { check: "wiring", status: "ok", message: `wiring (${tool}, ${scope}): current` }
          : {
              check: "wiring",
              status: "warn",
              message: `wiring (${tool}, ${scope}): stale -- ${stale.map((entry) => `${entry.path} (${entry.installAction})`).join(", ")}`,
              remedy: remedyFor(tool, scope, opts),
            }
      );
    }
    if (!installedAnywhere) {
      absent.push(tool);
    }
  }
  if (absent.length > 0) {
    findings.push({ check: "wiring", status: "ok", message: `wiring: not installed for ${absent.join(", ")} (\`mem init <tool>\` to add)` });
  }
  return findings;
}

/** A hook command reduced to what it runs (subcommand and flags) so a launcher-only difference -- `node <bundle>` against `mem` -- is not a divergence; an unparseable command compares as its raw text. */
function normalisedInvocation(command: string): string {
  const spec = parseHookCommandSpec(command);
  return spec === null ? command : [spec.subcommand, ...spec.flags].join(" ");
}

/** Claude Code merges project and user hooks and skips a duplicate only when its command text is identical, so mem installed at both levels is `ok` only when every event's command matches byte for byte. Different invocations mean inconsistent recall; the same invocation through a different launcher (the Windows user hook's `node <bundle>` against a project's `mem`) means every event runs twice. Either way the fix is a project `mem init claude-code`, which drops the project hooks once user hooks exist; `mem uninstall claude-code` would also strip the CLAUDE.md block. Silent when only one level has hooks. */
export function describeHookDivergence(opts: WiringOpts): Finding[] {
  if (projectSettingsIsUserSettings(opts)) {
    return [];
  }
  const project = installedClaudeHookCommands({ ...opts, user: false });
  const user = installedClaudeHookCommands({ ...opts, user: true });
  if (project.length === 0 || user.length === 0) {
    return [];
  }
  const projectByEvent = new Map(project.map((hook) => [hook.event, hook.command]));
  const userByEvent = new Map(user.map((hook) => [hook.event, hook.command]));
  const events = [...new Set([...projectByEvent.keys(), ...userByEvent.keys()])];
  const invocationOf = (command: string | undefined): string | undefined => (command === undefined ? undefined : normalisedInvocation(command));
  const differing = events.filter((event) => invocationOf(projectByEvent.get(event)) !== invocationOf(userByEvent.get(event)));
  const rootArg = opts.root === undefined ? "" : ` --root ${opts.root}`;
  if (differing.length === 0) {
    const doubled = events.filter((event) => projectByEvent.get(event) !== userByEvent.get(event));
    if (doubled.length === 0) {
      return [{ check: "hook-divergence", status: "ok", message: "hook-divergence: project and user Claude Code hooks are identical, so Claude Code runs each once" }];
    }
    return [
      {
        check: "hook-divergence",
        status: "warn",
        message: `hook-divergence: project and user Claude Code hooks launch mem differently for ${doubled.join(", ")} -- Claude Code skips a duplicate only when the command text is identical, so each runs twice (recall is injected twice)`,
        remedy: `mem init claude-code${rootArg} (drops the project hooks, since the user hooks already run in every project, and keeps the CLAUDE.md block)`,
      },
    ];
  }
  return [
    {
      check: "hook-divergence",
      status: "warn",
      message: `hook-divergence: project and user Claude Code hooks differ for ${differing.join(", ")} -- both run, so recall is duplicated or inconsistent`,
      remedy: `mem init claude-code --user, then mem init claude-code${rootArg} (one current set of user hooks; the project install drops its own and keeps the CLAUDE.md block)`,
    },
  ];
}

/** A `mem --version` launch slower than this (milliseconds) is felt on every hook event, so `mem doctor` warns. */
export const LAUNCH_TIME_WARN_MS = 300;

/** True for a direct-launch hook whose bundle still exists: it runs `node <bundle>` and never touches the `mem` on PATH. */
function launchesBundleDirectly(command: string): boolean {
  const bundle = parseHookBundlePath(command);
  return bundle !== null && existsSync(bundle);
}

/** One warning when launching `mem` through the shell shim a plain hook uses is slower than `LAUNCH_TIME_WARN_MS`; silent when it is fast, cannot be measured, or the measurement throws, so a doctor run never fails on it. Nothing is measured when no installed hook would launch the PATH `mem` (none installed, or every one a direct launch of an existing bundle). On Windows the remedy is the direct-node user hook, which skips npm's shim. */
export function describeLaunchTime(opts: WiringOpts, measure: () => number | null = timeMemLaunch, platform: NodeJS.Platform = process.platform): Finding[] {
  const projectHooks = projectSettingsIsUserSettings(opts) ? [] : installedClaudeHookCommands({ ...opts, user: false });
  const commands = [...projectHooks, ...installedClaudeHookCommands({ ...opts, user: true })].map((hook) => hook.command);
  if (commands.every(launchesBundleDirectly)) {
    return [];
  }
  let ms: number | null;
  try {
    ms = measure();
  } catch {
    return [];
  }
  if (ms === null || ms <= LAUNCH_TIME_WARN_MS) {
    return [];
  }
  const remedy =
    platform === "win32"
      ? "mem init claude-code --user (writes hooks that launch node on the bundle directly, skipping npm's mem shim)"
      : "check that mem starts quickly: antivirus scanning or a slow shell profile adds to every hook event";
  return [{ check: "launch-time", status: "warn", message: `launch-time: mem --version took ${Math.round(ms)} ms (over ${LAUNCH_TIME_WARN_MS} ms), and every hook event pays that`, remedy }];
}
