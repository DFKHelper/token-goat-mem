# GitHub Copilot CLI + Token-Goat Mem Integration

Direct shell-out patterns and hook wiring for GitHub Copilot CLI.

## Installation

Mem must be on PATH for Copilot CLI to invoke it:

```bash
npm install -g token-goat-mem
mem doctor  # verify installation
```

Confirm in your terminal: `echo $(mem epoch)` returns a number.

## Direct invocation from shell

Use `mem` as a regular CLI in Copilot CLI's shell tools or in your own terminal:

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

## Hook integration via AGENTS.md

Copilot CLI honors the AGENTS.md convention for agent-coordination directives. Mem can be wired into pre/post-session hooks by adding a `hooks` stanza to your project's `.agents.md` or by configuring your Copilot CLI settings:

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

**Copilot CLI extensions/hooks (via GitHub Copilot settings):**

Copilot CLI supports extension points and environment-driven configuration. To wire Mem into Copilot's initialization, set an environment variable or add to your shell profile:

```bash
# In ~/.bashrc, ~/.zshrc, or equivalent
export COPILOT_MEM_RECALL="mem recall --kind preference --scope global --limit 10"
```

Then reference it in Copilot commands or in a custom CLI wrapper that pre-loads facts before invoking `copilot`.

**Declarative approach (if supported):**

If your project has a `.copilot/config` or similar configuration directory, add a hooks section:

```yaml
# .copilot/config or similar
memory:
  recall-on-start: true
  scope: project
  hint-format: true
  kinds:
    - preference
    - decision
```

Then create a wrapper script that Copilot CLI invokes on startup:

```bash
#!/bin/bash
# .copilot/hooks/pre-session.sh
mem recall --kind preference --kind decision --scope project --hint-format
```

## Embedding memory into token-goat

When both Mem and token-goat are installed, Mem's optional seam embeds memory hints into token-goat's manifest automatically. No wiring needed — token-goat calls `mem recall --hint-format --root <project-root>` internally.

To verify the seam is live:
```bash
mem recall --hint-format --root .
```

Should return `TGMEM/1` header + facts. If not, run `mem doctor` to diagnose.

## Fail-open behavior

If `mem` is missing, times out, or returns unparseable output, Copilot CLI continues without memory hints. No exceptions, no halts. Wire memory as a convenience layer, not a dependency.

## Typical workflow

1. **Start of session:** Manually or via hook, call `mem recall --kind preference --scope project` to surface 5–10 project preferences.
2. **During work:** Write facts as you make decisions: `mem remember "chose Postgres for this query because of JOIN semantics"`.
3. **End of session or before cleanup:** Optional: `mem review` to audit what's been stored and resolve any contradictions.
4. **Next session:** Same facts re-surface, with freshness verdicts so Copilot knows which ones to re-verify.

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
- `docs/integrations/claude-code.md` — Claude Code patterns (similar hooks model)
