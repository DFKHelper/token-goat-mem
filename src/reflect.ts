/** `mem reflect`: the end-of-session worklist that turns pending suggestions into decisions, update-before-create. `mem scan-session` files every durable-sounding sentence as `pending` and stops there. Left alone, that queue only grows, and the agent that said the sentences -- the one party that knows whether "never commit generated files" restates a fact the store already holds, changes it, or is new -- has moved on. `mem reflect` asks it while it still knows: each pending suggestion is listed beside the live facts it most resembles (`findRelatedFacts`, the same lookup behind `mem show --related`), with the resolutions in the order they should be tried -- update an existing fact first, promote as new only when nothing covers it, reject otherwise. As the Claude Code Stop hook (`--hook-stdin`) it files the session's transcript itself and blocks the stop with the worklist as the reason, but only for suggestions *this run* filed. A sentence already in the store files nothing (it is a sighting), so a second stop over the same transcript is silent without any "already prompted" state. It never blocks while `stop_hook_active` is set: the agent is then already continuing because of a Stop hook, and blocking again would loop. */

import type Database from "better-sqlite3";
import type { Command } from "commander";

import { assertTranscriptReadable, guard, resolveRoot, shortFactId, withDb } from "./cliRuntime.js";
import { readHookEnvelope } from "./hook-envelope.js";
import { isBoundToRoot } from "./projectIdentity.js";
import { findRelatedFacts } from "./related.js";
import { fileTranscriptSuggestions, transcriptSourceRefPrefix } from "./sessionCapture.js";
import { getFactById, listFacts } from "./storage.js";
import type { Fact } from "./types.js";

/** Related facts listed per suggestion: enough to spot the one to update, few enough to read at a stop. */
const MAX_REFLECT_RELATED = 3;

/** The resolutions, in the order an agent should try them. `<id>` is the suggestion, `<related-id>` a listed related fact. */
const RESOLUTIONS = [
  '- restates or changes a related fact: update that fact (`mem edit <related-id> --text "..."`, or `mem remember --subject <key> --value <value>` to supersede it), then `mem review --reject <id> --reason "merged into <related-id>"`',
  '- new and durable: `mem review --promote <id> --reason "..."`',
  '- neither: `mem review --reject <id> --reason "..."`',
] as const;

interface ReflectCliOptions {
  readonly transcript?: string;
  readonly hookStdin?: boolean;
  readonly root?: string;
}

function factLine(fact: Fact): string {
  return `${shortFactId(fact.id)} [${fact.kind}] ${fact.text}`;
}

/** The worklist text: a heading, the resolutions once, then each suggestion with its related live facts indented under it. Pending neighbours are left out -- they are on the worklist themselves. */
function formatWorklist(db: Database.Database, heading: string, pending: readonly Fact[], root: string): string {
  const lines = [heading, ...RESOLUTIONS];
  for (const fact of pending) {
    lines.push("", factLine(fact));
    const related = findRelatedFacts(db, fact, root)
      .filter(({ fact: neighbour }) => neighbour.status !== "pending")
      .slice(0, MAX_REFLECT_RELATED);
    for (const { fact: neighbour } of related) {
      lines.push(`  related ${factLine(neighbour)}`);
    }
  }
  return lines.join("\n");
}

function plural(count: number): string {
  return `${count} pending suggestion${count === 1 ? "" : "s"}`;
}

/** Stop-hook mode: file the transcript, and block only on what this run filed. Silent on every other outcome. */
async function reflectFromHook(options: ReflectCliOptions): Promise<void> {
  const envelope = await readHookEnvelope();
  if (envelope.stopHookActive === true) {
    return;
  }
  const transcriptPath = options.transcript ?? envelope.transcriptPath;
  if (transcriptPath === undefined) {
    return;
  }
  const root = resolveRoot(options.root);
  const reason = await withDb((db) => {
    const filed = fileTranscriptSuggestions(db, { transcriptPath, root, scope: "project" })
      .map((id) => getFactById(db, id))
      .filter((fact): fact is Fact => fact !== undefined);
    return filed.length === 0
      ? undefined
      : formatWorklist(db, `mem reflect: this session filed ${plural(filed.length)}. Resolve each before stopping, updating before creating:`, filed, root);
  });
  if (reason !== undefined) {
    process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
  }
}

/** Manual mode: optionally file a named transcript, then list the pending suggestions it (or, without one, the whole root) holds. */
async function reflectManually(options: ReflectCliOptions): Promise<void> {
  const root = resolveRoot(options.root);
  const { transcript } = options;
  if (transcript !== undefined) {
    assertTranscriptReadable("reflect", transcript);
  }
  const output = await withDb((db) => {
    if (transcript !== undefined) {
      fileTranscriptSuggestions(db, { transcriptPath: transcript, root, scope: "project" });
    }
    const prefix = transcript === undefined ? undefined : transcriptSourceRefPrefix(transcript);
    const pending = listFacts(db, { status: "pending" })
      .filter((fact) => isBoundToRoot(fact, root))
      .filter((fact) => prefix === undefined || (fact.source_ref?.startsWith(prefix) ?? false))
      // Oldest first, so the worklist reads in the order the statements were made.
      .reverse();
    return pending.length === 0
      ? "nothing to reflect on -- no pending suggestions"
      : formatWorklist(db, `${plural(pending.length)} to reflect on. Resolve each, updating before creating:`, pending, root);
  });
  process.stdout.write(`${output}\n`);
}

export function registerReflectCommand(program: Command): void {
  program
    .command("reflect")
    .description(
      "List pending suggestions beside the live facts they most resemble, with the resolutions in order: " +
        "update an existing fact first, promote as new only when nothing covers it, reject otherwise"
    )
    .option("--transcript <path>", "File this transcript's durable statements first, then list only the suggestions it holds")
    .option(
      "--hook-stdin",
      "Claude Code Stop hook mode: read the envelope from stdin, file its transcript, and block the stop " +
        'with {"decision":"block"} only for suggestions this run filed; silent otherwise, and whenever stop_hook_active is set'
    )
    .option("--root <path>", "Project root the suggestions bind to (default: current directory)")
    .action(guard(async (options: ReflectCliOptions) => (options.hookStdin === true ? reflectFromHook(options) : reflectManually(options))));
}
