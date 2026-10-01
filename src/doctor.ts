/**
 * `mem doctor`: the read-only environment and store health check. Each report line has its own
 * `describe*` builder so the policy behind it (what counts as healthy, what to run when it is not)
 * sits beside the doc comment that justifies it, and the command itself only gathers counts.
 */

import type { Command } from "commander";
import { existsSync } from "node:fs";

import { AUTO_SNAPSHOT_INTERVAL_MS, listSnapshots } from "./backup.js";
import { EXIT_USER_ERROR, extractErrorMessage, guard, withDb } from "./cliRuntime.js";
import { resolveBackupDir, resolveDbPath } from "./db.js";
import { DREAM_MODEL_ENV, DREAM_URL_ENV, dreamEndpointLabel, readDreamConfig } from "./dream.js";
import { EMBED_MODEL_ENV, EMBED_URL_ENV, endpointLabelFor, readEmbeddingConfig, type EmbeddingMeta } from "./embeddings.js";
import { HINT_LINE_CEILING, HINT_PINNED_RESERVE } from "./integration-seam.js";
import { countEmbeddedFacts, countFacts, countFactsWithTerms, countRationaleCoverage, getEmbeddingMeta, getEpoch } from "./storage.js";
import { formatAge } from "./timeUtils.js";
import { FACT_STATUSES } from "./types.js";
import { checkClaudeHookHealth, describeHookGap, installedClaudeHookCommands } from "./wiring.js";

/**
 * The fixed set of `check` names a finding can carry. Closed on purpose: `--json` consumers key off
 * these strings, so a new check is a deliberate, tested addition here rather than a string typed at
 * one call site. One name covers every line a topic prints (`hooks` is a header plus one line per
 * event), and the order is the order the report prints in.
 */
export const DOCTOR_CHECKS = ["store", "schema", "integrity", "facts", "embeddings", "dream", "facets", "why", "hints", "scope", "backups", "hooks"] as const;

export type DoctorCheck = (typeof DOCTOR_CHECKS)[number];

export type FindingStatus = "ok" | "warn" | "fail";

/**
 * One line of the doctor report, structured. `fail` is a condition that makes mem silently not do
 * its job (an installed hook that cannot run, a store that cannot be opened) and is what `--strict`
 * turns into exit 1; `warn` is worth acting on but loses nothing yet; `ok` is everything else.
 * `message` is the text line exactly as the plain report prints it; `remedy` is the command to run,
 * when there is one, so a script need not scrape it out of the prose.
 */
export interface Finding {
  readonly check: DoctorCheck;
  readonly status: FindingStatus;
  readonly message: string;
  readonly remedy?: string;
}

function finding(check: DoctorCheck, status: FindingStatus, message: string, remedy?: string): Finding {
  return remedy === undefined ? { check, status, message } : { check, status, message, remedy };
}

/** The plain report: one `message` per line, exactly what `mem doctor` printed before findings were structured. */
function renderFindings(findings: readonly Finding[]): string {
  return findings.map((entry) => entry.message).join("\n");
}

/**
 * `mem doctor`'s term-coverage line. Worth a line of its own because a store captured before terms
 * existed carries none, and the only symptom is `mem recall --entity` quietly matching nothing --
 * indistinguishable, from the outside, from a store that genuinely has no fact mentioning that
 * entity. Naming the shortfall here points at `mem facets --backfill` instead of leaving the user to
 * conclude the filter is broken.
 */
function describeFacets(factsWithTerms: number, totalFacts: number): Finding[] {
  const line = `term coverage: ${factsWithTerms}/${totalFacts} facts`;
  return factsWithTerms < totalFacts
    ? [finding("facets", "warn", `${line} (run \`mem facets --backfill\` -- \`mem recall --entity\` cannot match the rest)`, "mem facets --backfill")]
    : [finding("facets", "ok", line)];
}

/**
 * `mem doctor`'s why-coverage line. A decision or correction recalled without its reason is the one
 * a later session argues with, and no other command says how many of them there are. Only what
 * recall can surface is counted: a pending or superseded fact's missing reason costs nothing.
 */
function describeWhyCoverage(withWhy: number, total: number): Finding[] {
  if (total === 0) {
    return [finding("why", "ok", "why coverage: n/a -- no active or pinned decisions or corrections")];
  }
  const line = `why coverage: ${withWhy}/${total} active or pinned decisions and corrections carry a reason`;
  return withWhy < total
    ? [finding("why", "warn", `${line} (add one with \`mem edit <id> --why "<reason>"\`)`, 'mem edit <id> --why "<reason>"')]
    : [finding("why", "ok", line)];
}

/**
 * `mem doctor`'s hint-budget line: how much of what a store holds can actually reach a session.
 *
 * Worth a line because the ceiling is otherwise invisible from every command a user has. `mem list`
 * shows every fact, `mem doctor`'s own status counts show how many are active, and neither hints
 * that a single `--hint-format` block carries at most `HINT_LINE_CEILING` of them -- so a store that
 * has grown past the cap looks healthy right until someone notices a fact they can plainly see in
 * `mem list` is never in context. The fix is not a bigger cap (the cap is what keeps the block from
 * becoming filler); it is pinning the handful that must always arrive, so the remediation named here
 * is `mem pin`.
 *
 * Pins are reported against the reserve rather than the ceiling because over-pinning is the failure
 * on the other side: past `HINT_PINNED_RESERVE`, extra pins compete on relevance like anything else,
 * so a store with twenty pins has not bought twenty guaranteed slots and should not believe it has.
 */
function describeHintBudget(recallable: number, pinned: number): Finding[] {
  const line = `hint budget: ${recallable} recallable fact${recallable === 1 ? "" : "s"}, at most ${HINT_LINE_CEILING} per recall; ${pinned} pinned of ${HINT_PINNED_RESERVE} reserved slots`;
  if (pinned > HINT_PINNED_RESERVE) {
    return [finding("hints", "warn", `${line} (only ${HINT_PINNED_RESERVE} pins are guaranteed a slot -- the rest compete on relevance)`)];
  }
  if (recallable > HINT_LINE_CEILING) {
    return [finding("hints", "warn", `${line} (pin the facts that must always arrive: \`mem pin <id>\`)`, "mem pin <id>")];
  }
  return [finding("hints", "ok", line)];
}

/**
 * `mem doctor`'s scope-placement line: project- and path-scoped facts whose `scope_root` is gone.
 *
 * A fact bound to a directory that has since been renamed, moved, or deleted is not stale,
 * contested, or decayed -- every status column calls it healthy. Nothing else in `doctor` would
 * show it: the status counts include it as active, and term coverage and embedding coverage both
 * count it as covered. `relocated*` counts the subset that still carries a `scope_repo`: recall
 * binds a project fact by `scope_root` OR repository identity (`retrieval.ts`'s `identityMatches`),
 * so these are still reachable from any checkout of that repository -- the directory moved or was
 * re-cloned, not lost. `unreachable*` is the rest: a root-less fact with no `scope_repo`, which is
 * genuinely unreachable from anywhere, because no session will ever run with that root again.
 * Re-scoping is a human decision (the fact may belong to the moved directory's new path or may have
 * been about the old one), so this names `mem list --scope` to find them and leaves the call to the
 * user rather than guessing a root.
 */
function describeScopePlacement(unreachableRoots: number, unreachableFacts: number, relocatedRoots: number, relocatedFacts: number): Finding[] {
  if (unreachableFacts === 0 && relocatedFacts === 0) {
    return [finding("scope", "ok", "scope placement: every project/path-scoped fact's root still exists")];
  }
  const lines: Finding[] = [];
  if (relocatedFacts > 0) {
    // Still reachable by repository identity, so informational: nothing is lost, hence `ok`.
    lines.push(
      finding(
        "scope",
        "ok",
        `scope placement: ${relocatedFacts} fact${relocatedFacts === 1 ? "" : "s"} bound to ${relocatedRoots} moved ` +
          `root${relocatedRoots === 1 ? "" : "s"} -- still reachable by repository identity from any checkout`
      )
    );
  }
  if (unreachableFacts > 0) {
    lines.push(
      finding(
        "scope",
        "warn",
        `scope placement: ${unreachableFacts} fact${unreachableFacts === 1 ? "" : "s"} bound to ${unreachableRoots} missing ` +
          `root${unreachableRoots === 1 ? "" : "s"} -- unreachable from any session ` +
          "(`mem list --scope project` / `--scope path` to review, then re-capture or `mem forget`)",
        "mem list --scope project"
      )
    );
  }
  return lines;
}

/**
 * `doctor` section for Claude Code hooks: the `mem` binary that actually resolves on PATH (which
 * may be a different build than the one running this `doctor`), and whether each installed hook
 * command -- read from disk, not from what this build would write -- can run against it. Checks
 * both project-level (cwd) and user-level (`--user` install) settings.json, since either or both
 * may exist and `doctor` takes no `--root`/`--user` of its own.
 *
 * This is the check that would have surfaced the 219-hook-failure incident on day one: a stale PATH
 * binary rejecting a newer install's flags produces a `capable: false` line here on the very first
 * `mem doctor` run, instead of five days of silent `|| true` swallowing.
 */
function describeHookHealth(): Finding[] {
  const project = installedClaudeHookCommands({ root: process.cwd() });
  const user = installedClaudeHookCommands({ root: process.cwd(), user: true });
  if (project.length === 0 && user.length === 0) {
    // No hooks installed is a choice, not a fault: nothing is inert, so it is `ok`.
    return [finding("hooks", "ok", "hooks: no Claude Code hooks installed here (`mem init claude-code` to add them)")];
  }
  // Installed hooks that cannot run (no binary, or one too old for their flags) are `fail`: they
  // are the silent-no-op incident this check exists for, and the one thing `--strict` must catch.
  const lines: Finding[] = [];
  for (const [label, hooks] of [
    ["project", project],
    ["user", user],
  ] as const) {
    if (hooks.length === 0) {
      continue;
    }
    const health = checkClaudeHookHealth(hooks);
    lines.push(
      health.bin === null
        ? finding("hooks", "fail", `hooks (${label}): no mem binary found on PATH -- these hooks are inert`, "npm install -g token-goat-mem")
        : finding("hooks", "ok", `hooks (${label}): PATH resolves mem to ${health.bin.path} (${health.bin.version ?? "unknown version"})`)
    );
    for (const hook of health.hooks) {
      lines.push(
        hook.capable
          ? finding("hooks", "ok", `  ${hook.event}: ok`)
          : finding(
              "hooks",
              "fail",
              `  ${hook.event}: ${health.bin === null ? "would be inert" : `does not support ${describeHookGap(hook.command, hook.missing)}`}`,
              "npm install -g token-goat-mem"
            )
      );
    }
  }
  return lines;
}

/**
 * One `doctor` line for `mem dream`, mirroring the embeddings line above.
 *
 * Reported here because both `mem dream` and `mem embed` send fact text off this machine, and their
 * configuration lives in environment variables -- so a URL exported once in a shell profile is
 * otherwise invisible to the person whose facts would be sent. `doctor` is where someone checks
 * what the tool is currently set up to do, and "is anything configured to leave this machine" is
 * the question that most deserves an answer there.
 *
 * Host only, never the URL and never the key: the same rule the request path follows, for the same
 * reason -- `mem doctor` output is the thing users paste into an issue.
 */
function describeDream(): Finding[] {
  let config;
  try {
    config = readDreamConfig();
  } catch (error) {
    return [finding("dream", "warn", `dreaming: misconfigured -- ${extractErrorMessage(error)}`)];
  }
  if (config === null) {
    return [finding("dream", "ok", `dreaming: off (set ${DREAM_URL_ENV} and ${DREAM_MODEL_ENV} to enable)`)];
  }
  return [
    finding(
      "dream",
      "ok",
      `dreaming: ${dreamEndpointLabel(config.url)}, model ${config.model}, ` +
        `api key ${config.apiKey === undefined ? "absent" : "configured"} ` +
        `-- \`mem dream\` sends fact text to this endpoint`
    ),
  ];
}

/**
 * The embedding lines of `mem doctor`'s report.
 *
 * Unconfigured is a healthy state and reads like one -- "off", with the two variables that would
 * turn it on -- because the overwhelming majority of installs never configure an endpoint and a
 * health check that flags the default as a problem trains people to ignore it.
 *
 * The API key is reported as configured or absent and never printed, echoed, or hinted at by
 * length. So is the endpoint: only its host reaches stdout, so a URL carrying userinfo cannot leak
 * through a health check someone pastes into an issue.
 */
function describeEmbeddings(recorded: EmbeddingMeta | null, embeddedFacts: number, totalFacts: number): Finding[] {
  const embed = (status: FindingStatus, message: string, remedy?: string): Finding => finding("embeddings", status, message, remedy);
  const coverage = `embedding coverage: ${embeddedFacts}/${totalFacts} facts`;
  // `recorded === null` alone does not mean nothing is embedded: an interrupted `mem embed` or an
  // import of unknown provenance can leave vectors on disk with no recorded model, and that state
  // must not read as "nothing embedded yet" right above a coverage line reporting otherwise.
  const stored =
    recorded !== null
      ? embed("ok", `embedding store: model ${recorded.model}, dim ${recorded.dimension}`)
      : embeddedFacts > 0
        ? embed("warn", `embedding store: ${embeddedFacts} vector(s) with no recorded model -- provenance unknown; run \`mem embed --all\` to relabel`, "mem embed --all")
        : embed("ok", "embedding store: nothing embedded yet");
  let config;
  try {
    config = readEmbeddingConfig();
  } catch (error) {
    return [embed("warn", `embeddings: misconfigured -- ${extractErrorMessage(error)}`), stored, embed("ok", coverage)];
  }
  if (config === null) {
    // Coverage is only a shortfall once an endpoint could close it: with embeddings off, 0/N is the
    // healthy default, and flagging it would train people to ignore the line.
    return [embed("ok", `embeddings: off (set ${EMBED_URL_ENV} and ${EMBED_MODEL_ENV} to enable)`), stored, embed("ok", coverage)];
  }
  const lines = [
    embed(
      "ok",
      `embeddings: ${endpointLabelFor(config.url)}, model ${config.model}, api key ${config.apiKey === undefined ? "absent" : "configured"} ` +
        "-- `mem remember`/`mem suggest`/`mem embed` send fact text to this endpoint, and `mem recall` sends the query text (every prompt, if wired via a hook)"
    ),
    stored,
  ];
  if (recorded !== null && recorded.model !== config.model) {
    lines.push(embed("warn", `embedding ranking: disabled -- stored vectors are ${recorded.model}'s; run \`mem embed --all\` to re-embed`, "mem embed --all"));
  } else if (recorded === null && embeddedFacts > 0) {
    lines.push(embed("warn", "embedding ranking: disabled -- stored vectors have no recorded model; run `mem embed --all` to relabel", "mem embed --all"));
  }
  lines.push(embeddedFacts < totalFacts ? embed("warn", coverage, "mem embed --all") : embed("ok", coverage));
  return lines;
}

/**
 * `mem doctor`'s backups line. Automatic snapshots are taken silently and fail silently (a backup
 * that cannot be written must not stop recall), so this line is the only place a broken backup
 * directory shows up -- before the day the store is lost, not after. A store never written to has
 * nothing to back up, so an empty directory is only a warning once there is something to lose.
 */
function checkBackups(dir: string, epoch: number, now: Date): Finding {
  let snapshots;
  try {
    snapshots = listSnapshots(dir);
  } catch (error) {
    return finding("backups", "warn", `backups: cannot read ${dir} (${extractErrorMessage(error)})`);
  }
  const [newest] = snapshots;
  if (newest === undefined) {
    // Facts with no snapshot is the one backup state worth a warning: there is something to lose.
    return epoch === 0
      ? finding("backups", "ok", `backups: none in ${dir} (nothing written yet)`)
      : finding(
          "backups",
          "warn",
          `backups: none in ${dir} -- snapshots are not being written; check that ${dir} is a writable directory, then run \`mem backup\``,
          "mem backup"
        );
  }
  const age = now.getTime() - newest.takenAt.getTime();
  const line = `backups: ${dir} -- ${String(snapshots.length)} snapshot${snapshots.length === 1 ? "" : "s"}, newest ${formatAge(age)} ago (epoch ${String(newest.epoch)})`;
  // A day past the interval with writes since means an automatic snapshot was due and did not land.
  return age > 2 * AUTO_SNAPSHOT_INTERVAL_MS && newest.epoch !== epoch
    ? finding("backups", "warn", `${line} -- automatic snapshots may be failing; check that ${dir} is writable, then run \`mem backup\``, "mem backup")
    : finding("backups", "ok", line);
}

/** The backups line as plain text, for callers (and `tests/unit/backup.test.ts`) that want only the message. */
export function describeBackups(dir: string, epoch: number, now: Date = new Date()): string {
  return checkBackups(dir, epoch, now).message;
}

/** Registers `mem doctor` on the CLI program. */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Read-only environment/DB health check: db path, WAL mode, schema tables, epoch, fact counts by status, embedding configuration and coverage, how many decisions and corrections carry a why, how much of the store fits in one recall block, and project/path-scoped facts whose root is gone")
    .option("--json", "Output the findings as machine-readable JSON: { findings: [{ check, status, message, remedy? }], epoch } (unstable, pre-1.0)")
    .option("--strict", "Exit 1 when any finding has status fail (an installed hook that cannot run, an unreadable store); without it doctor always exits 0 so a warning never breaks a script")
    .action(
      guard(async (options: { json?: boolean; strict?: boolean }) => {
        const dbPath = resolveDbPath();
        const report = await withDb((db) => {
          const journalMode = db.pragma("journal_mode", { simple: true }) as string;
          const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;
          const tables = db
            .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all()
            .map((row) => row.name)
            .filter((name) => !name.startsWith("sqlite_"));
          const statusCounts = FACT_STATUSES.map((status) => `${status}=${countFacts(db, { status })}`).join("  ");
          const totalFacts = countFacts(db, {});
          // Same scope as `listFactsNeedingEmbedding`: a superseded fact is never backfilled, so it
          // must not count against the coverage denominator either -- see `countEmbeddedFacts`.
          const embeddableFacts = totalFacts - countFacts(db, { status: "superseded" });
          const sourceRows = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM sources").get()?.c ?? 0;
          const auditRows = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM audit_log").get()?.c ?? 0;
          const epoch = getEpoch(db);
          const rationale = countRationaleCoverage(db);
          // The same status pair the hint-format recall pool loads (see `--hint-format`'s
          // `listFacts` call): anything else is withheld, so counting it here would overstate
          // what a session can actually receive.
          const pinnedFacts = countFacts(db, { status: "pinned" });
          const recallableFacts = countFacts(db, { status: "active" }) + pinnedFacts;
          // Grouped by root so one renamed directory holding forty facts reports as one missing
          // root, not forty -- and so each root is stat'd once however many facts hang off it.
          const scopedRoots = db
            .prepare<[], { scope_root: string; scope_repo: string | null; c: number }>(
              "SELECT scope_root, scope_repo, COUNT(*) AS c FROM facts WHERE scope IN ('project','path') AND scope_root IS NOT NULL GROUP BY scope_root, scope_repo"
            )
            .all();
          const orphaned = scopedRoots.filter((row) => !existsSync(row.scope_root));
          // `scope_repo IS NULL` split: recall binds a project fact by `scope_root` OR repository
          // identity (see `describeScopePlacement`'s doc comment), so an orphaned root with a
          // `scope_repo` is still reachable and must not be reported as unreachable.
          const relocated = orphaned.filter((row) => row.scope_repo !== null);
          const unreachable = orphaned.filter((row) => row.scope_repo === null);
          const findings: Finding[] = [
            finding("store", "ok", `db: ${dbPath}`),
            finding("store", "ok", `journal_mode: ${journalMode}`),
            finding("store", "ok", `foreign_keys: ${foreignKeys === 1 ? "on" : "off"}`),
            finding("store", "ok", `tables: ${tables.join(", ")}`),
            finding("store", "ok", `epoch: ${epoch}`),
            finding("facts", "ok", `facts: ${statusCounts}  (total ${totalFacts})`),
            finding("store", "ok", `sources: ${sourceRows}`),
            finding("store", "ok", `audit_log rows: ${auditRows}`),
            ...describeEmbeddings(getEmbeddingMeta(db) ?? null, countEmbeddedFacts(db, { excludeSuperseded: true }), embeddableFacts),
            ...describeDream(),
            ...describeFacets(countFactsWithTerms(db), totalFacts),
            ...describeWhyCoverage(rationale.withWhy, rationale.total),
            ...describeHintBudget(recallableFacts, pinnedFacts),
            ...describeScopePlacement(
              unreachable.length,
              unreachable.reduce((sum, row) => sum + row.c, 0),
              relocated.length,
              relocated.reduce((sum, row) => sum + row.c, 0)
            ),
            checkBackups(resolveBackupDir(), epoch, new Date()),
            ...describeHookHealth(),
          ];
          return { findings, epoch };
        });
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          process.stdout.write(`${renderFindings(report.findings)}\n`);
        }
        // Exit 1 is the user-error code of the CLI contract (see cli.ts): "your setup needs attention".
        if (options.strict === true && report.findings.some((entry) => entry.status === "fail")) {
          process.exitCode = EXIT_USER_ERROR;
        }
      })
    );
}
