/**
 * `mem doctor`'s wiring checks, kept out of doctor.ts: whether each supported tool's mem block is
 * present and current (`wiring`), and whether project- and user-level Claude Code hooks disagree
 * (`hook-divergence`). Both are read-only. "Current" is not re-derived here: it is whatever
 * `getToolWiring(tool).describe()` says `mem init <tool>` would change, so a template edit in
 * wiring.ts moves this check with it and there is no second copy to forget.
 */

import { resolve, sep } from "node:path";

import type { Finding } from "./doctor.js";
import {
  getToolWiring,
  installedClaudeHookCommands,
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
    return { entries: plan.entries.filter((entry) => insideRoot(entry.path, root)) };
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

/**
 * One finding per tool and scope that has any mem content: `ok` when `mem init` would change
 * nothing, `warn` when it would (an outdated block, a hand edit inside the markers, a hook missing
 * an event, a file mem wrote half of). Tools mem is not in are one informational line: a user need
 * not wire every tool, so that is `ok`, never a warning.
 */
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

/**
 * Claude Code runs project and user hooks both, so mem installed at both levels with different
 * invocations means duplicate or inconsistent recall. Silent when only one level has hooks.
 */
export function describeHookDivergence(opts: WiringOpts): Finding[] {
  const project = installedClaudeHookCommands({ ...opts, user: false });
  const user = installedClaudeHookCommands({ ...opts, user: true });
  if (project.length === 0 || user.length === 0) {
    return [];
  }
  const projectByEvent = new Map(project.map((hook) => [hook.event, hook.command]));
  const userByEvent = new Map(user.map((hook) => [hook.event, hook.command]));
  const events = [...new Set([...projectByEvent.keys(), ...userByEvent.keys()])];
  const differing = events.filter((event) => projectByEvent.get(event) !== userByEvent.get(event));
  if (differing.length === 0) {
    return [{ check: "hook-divergence", status: "ok", message: "hook-divergence: project and user Claude Code hooks match" }];
  }
  const rootArg = opts.root === undefined ? "" : ` --root ${opts.root}`;
  return [
    {
      check: "hook-divergence",
      status: "warn",
      message: `hook-divergence: project and user Claude Code hooks differ for ${differing.join(", ")} -- both run, so recall is duplicated or inconsistent`,
      remedy: `mem uninstall claude-code${rootArg} (drop the project hooks) or mem uninstall claude-code --user (drop the user hooks), then mem init claude-code --user to keep one current set`,
    },
  ];
}
