# Claude Code + Token-Goat Mem Integration

Shell-out patterns and hook wiring for Claude Code.

## Quick start: `mem init claude-code`

Once `mem` is on PATH (see Installation below), wire it into Claude Code in one command:

```bash
mem init claude-code --root .          # writes .claude/settings.json + CLAUDE.md
mem init claude-code --user            # writes ~/.claude/settings.json instead (no CLAUDE.md)
mem init claude-code --dry-run         # preview what would be written, without touching disk
```

This writes exactly the `SessionStart` hook and `CLAUDE.md` instructions documented below (as marked blocks/stamped entries), so it's safe to re-run: re-running upgrades mem's own entries in place instead of duplicating them, and a pre-existing hand-written entry with the same identity aborts the write with a conflict error instead of being silently overwritten. `mem uninstall claude-code` reverses exactly what `init` wrote and nothing else. See `mem init --help` / `mem uninstall --help` for the full flag reference.

The rest of this doc is the manual version -- what `mem init claude-code` does under the hood, and useful if you want to wire it by hand or understand exactly what changed.

## Installation

Mem must be on PATH for Claude Code to invoke it:

```bash
npm install -g token-goat-mem
mem --version   # verify installation
mem epoch       # confirms the CLI and SQLite store are wired (prints a number)
```

## Direct invocation from Bash

Use `mem` as a regular CLI in Bash tool calls. `--kind` is required on every `remember`:

**Remember a preference:**
```bash
mem remember "uses pnpm not npm" --kind preference --scope project --root . \
  --anchor "file-newer-than pnpm-lock.yaml package-lock.json"
```

**Recall project facts:**
```bash
mem recall --hint-format --root .
```

(`--hint-format` ignores `--kind`/`--scope` filters -- it always returns every in-scope kind under its own per-kind caps. Use `--kind`/`--scope` only on plain `mem recall`, without `--hint-format`.)

**Show one fact / list all facts:**
```bash
mem show <id>
mem list
```

See `mem --help` and the README for the full CLI reference.

## Fail-open behavior

If `mem` is missing, times out, or returns unparseable output, Claude Code continues without memory hints. No exceptions, no halts. Wire memory as a convenience layer, not a dependency.

## Hook integration via settings.json

Claude Code's `SessionStart` hook runs a command when a session starts, and its stdout is added to Claude's context — exactly the injection point memory hints need. Add to `.claude/settings.json` (project) or `~/.claude/settings.json` (user):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "mem recall --hint-format --root \"$CLAUDE_PROJECT_DIR\""
          }
        ]
      }
    ]
  }
}
```

Every new session then opens with the `TGMEM/2` hint block (or just the bare `TGMEM/2` header line on an empty store), which Claude simply ignores when there are no fact lines.

## Instruction wiring via CLAUDE.md

The complement to the hook: tell Claude *when to write*. Add to your project's `CLAUDE.md`:

```markdown
## Memory

This machine has token-goat-mem installed. When I state a durable preference,
decision, or correction, persist it:
`mem remember "<short fact>" --kind preference|decision|fact|correction --scope project --root .`
Use --subject/--value for anything that can be contradicted later
(e.g. --subject package-manager --value pnpm).
```

## Embedding memory into token-goat

When both Mem and token-goat are installed, token-goat calls `mem recall --hint-format --root <project-root>` internally to embed memory hints into its manifest. No wiring needed.

To verify the seam is live:
```bash
mem recall --hint-format --root .
```

Returns a `TGMEM/2` header, one line per fact plus a shared `footer` line when at least one fact was returned, or just the bare `TGMEM/2` header line with nothing else on an empty store (`--hint-format` never prints `no matching facts` -- that string is only emitted by plain `mem recall`).

## Typical workflow

1. **Start of session:** the `SessionStart` hook surfaces prior facts at the top of context, each with a freshness verdict.
2. **During work:** Claude writes facts as decisions land: `mem remember "chose Postgres for JOIN semantics" --kind decision --scope project`.
3. **End of session:** optional `mem review --root .` to audit what's stored and resolve pending or anchor-contradicted facts.
4. **Next session:** the same facts re-surface, with verdicts telling Claude which ones to re-verify.

## Shell quoting

Fact text is a single positional argument. Single-quote it to avoid shell expansion; double-quote when you *want* expansion:

```bash
mem remember 'uses pnpm not npm' --kind preference
mem remember "Picked $FRAMEWORK for perf" --kind decision
```

Anchor predicates take multiple space-separated arguments, so quote the whole predicate:

```bash
mem remember "auth schema is indexed" --kind fact --root . \
  --anchor 'file-exists schema.sql'
```

## Debugging

```bash
mem epoch       # store reachable? prints the write epoch
mem list        # everything stored, one line each
mem review      # pending / contested / anchor-contradicted facts
mem show <id>   # full provenance of one fact
mem forget <id> # soft-delete a stale fact
```

If a `remember` is rejected with `possible secret detected`, the fact matched Mem's secret/entropy screen. If it is genuinely not a secret, add the exact value to `.mem/allowlist` in the project root, as the error message instructs.

## See also

- `README.md` — full CLI and anchor-predicate reference
- `AGENTS.md` — agent-facing command and data-model summary
- `docs/integrations/codex.md` — the same patterns for Codex
