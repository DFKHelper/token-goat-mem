# Claude Code + Token-Goat Mem Integration

Direct shell-out patterns and hook wiring for Claude Code.

## Installation

Mem must be on PATH for Claude Code to invoke it:

```bash
npm install -g token-goat-mem
mem doctor  # verify installation
```

Confirm in Claude Code: `echo $(mem epoch)` returns a number.

## Direct invocation from Bash

Use `mem` as a regular CLI in Bash tool calls:

**Remember a preference:**
```bash
mem remember "uses pnpm not npm" --kind preference --scope project --anchor "file-newer-than pnpm-lock.yaml package-lock.json"
```

**Recall project facts:**
```bash
mem recall --kind preference --scope project --hint-format
```

**Show one fact:**
```bash
mem show abc123
```

**List all facts:**
```bash
mem list
```

See `mem --help` and `README.md` for full CLI reference.

## Fail-open behavior

If `mem` is missing, times out, or returns unparseable output, Claude Code continues without memory hints. No exceptions, no halts. Wire memory as a convenience layer, not a dependency.

## Hook integration via AGENTS.md

Claude Code honors the AGENTS.md convention for agent-coordination directives. Mem can be wired into pre/post-session hooks by adding a `hooks` stanza to your project's `.agents.md` or by configuring your Claude Code `settings.json`:

**In `.agents.md` (project-level):**
```yaml
hooks:
  pre-session:
    - label: Load project memory
      run: mem recall --kind preference --scope project --hint-format
  post-session:
    - label: Archive session decisions
      run: mem remember "$SESSION_SUMMARY" --kind decision --scope project
```

**In `settings.json` (user-level, via `/update-config` or manual edit):**

Add to your Claude Code `~/.claude/settings.json`:

```json
{
  "hooks": {
    "before-work-starts": {
      "run": "mem recall --kind preference --scope global --limit 10",
      "label": "Load my coding preferences"
    },
    "after-compaction": {
      "run": "mem remember \"Compacted at $(date)\" --kind correction --scope project",
      "label": "Log session boundaries"
    }
  }
}
```

The harness evaluates `run` as a shell command and pipes output to stderr/logs. Use `--hint-format` for structured recall output; plain `mem recall` for human-readable terminal display.

## Embedding memory into token-goat

When both Mem and token-goat are installed, Mem's optional seam embeds memory hints into token-goat's manifest automatically. No wiring needed — token-goat calls `mem recall --hint-format --root <project-root>` internally.

To verify the seam is live:
```bash
mem recall --hint-format --root .
```

Should return `TGMEM/1` header + facts. If not, run `mem doctor` to diagnose.

## Typical workflow

1. **Start of session:** Claude Code (via hook) calls `mem recall --kind preference` and surfaces 5–10 project preferences at the top of context.
2. **During work:** Write facts as you make decisions: `mem remember "chose Postgres for this query because of JOIN semantics"`.
3. **End of session or before compaction:** Optional: `mem review` to audit what's been stored and resolve any contradictions.
4. **Next session:** Same facts re-surface, with freshness verdicts so Claude knows which ones to re-verify.

## Shell quoting and special characters

Use double quotes for Bash and single quotes for fact text to avoid shell expansion:

```bash
mem remember 'uses pnpm not npm' --kind preference
mem remember "Picked $FRAMEWORK for perf" --kind decision
```

For multi-line facts or complex anchors, use heredocs or echo piping:

```bash
echo "Chose Postgres over Mongo because JOINs are critical to the auth model" | \
  mem remember --kind decision --anchor "file-contains schema.sql CREATE INDEX"
```

## Debugging

**Check if Mem is working:**
```bash
mem epoch
mem list
mem doctor
```

**Review stored facts:**
```bash
mem review
```

Shows all facts, their anchor verdicts (affirmed/unverified/contradicted), and any conflicts.

**Show full provenance of one fact:**
```bash
mem show <id>
```

**Manually purge a stale fact:**
```bash
mem forget <id>
```

## See also

- `README.md` — full CLI and feature reference
- `AGENTS.md` — agent-coordination conventions
- `.claude/CLAUDE.md` — how Claude Code respects local memory and preferences
