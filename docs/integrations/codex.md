# Codex + Token-Goat Mem Integration

Use token-goat-mem to carry durable facts, preferences, and decisions across Codex peer review sessions.

## Shell-out invocation

Codex spawns as a separate agent session. Shell out to `mem` directly to capture and retrieve facts:

```bash
# Capture a code review decision during a Codex session
mem remember "Prefer reduce + map over nested loops for readability" \
  --kind decision \
  --subject "loop-style" \
  --scope global

# Retrieve all design decisions for the current review
mem recall --kind decision

# Retrieve with trust caveats (shows freshness verdict and confidence)
mem recall --kind preference --limit 5
```

## Wiring via AGENTS.md hooks

Token-goat-mem integrates via AGENTS.md `pre-agent-spawn` and `post-session-end` hooks. Add to your `.claude/AGENTS.md` or project `AGENTS.md`:

```yaml
hooks:
  pre-agent-spawn:
    - run: "mem recall --hint-format --root {{root}} --kind preference,decision"
      label: "Load prior review heuristics"
      env-var: "CODEX_MEMORY_HINTS"
      on-timeout: ignore  # fail-open; no memory hints if mem unavailable

  post-session-end:
    - run: "mem remember {{review_decision}} --kind decision --scope project"
      label: "Archive peer review findings"
      condition: "review_decision is not empty"
```

Each pre-spawn call emits `TGMEM/1` formatted facts (one per line) with embedded trust caveats. Codex can inject these into its system prompt or context directly without parsing.

## Direct CLI usage in Codex

Use within a Codex script or review template:

```bash
#!/bin/bash
# Load preferences before analysis
PREFS=$(mem recall --kind preference --hint-format)
echo "Prefs in scope: $PREFS"

# Run your analysis
# ...

# Capture the finding
mem remember "Found N+1 query pattern; prefer DataLoader wrapper" \
  --kind correction \
  --subject "query-patterns" \
  --anchor "file-newer-than src/queries.ts"
```

## Codex-specific patterns

**One-shot memory seeding:**
Before invoking `/codex` for a peer review, pre-load facts:

```bash
mem remember "Team prefers immutable data structures" --kind preference --scope global
mem remember "Use structured logging via pino, not console.log" --kind decision --scope project
```

Then invoke Codex. Its peer review will surface these via `mem recall` if wired into hooks.

**Continuous review archive:**
After each Codex session, capture high-level verdicts:

```bash
mem remember "Agreed: async errors must propagate, never swallow" \
  --kind decision \
  --subject "error-handling" \
  --anchor "file-newer-than src/error-handler.ts"
```

Over time, `mem review` accumulates a log of team design decisions that Codex learns from.

## Trust caveats in output

`mem recall --hint-format` returns self-annotated display strings:

```
pref  fresh=affirmed  id=abc123  display="Prefer map+reduce; file affirmed 2d ago"
decision  fresh=contradicted  id=def456  display="DO NOT USE: old webpack config (verify with master branch)"
```

Codex sees the caveat in `display` — "verify", "contradicted", "unverified" — and treats low-trust facts accordingly. High-confidence facts (fresh=affirmed) are safe for direct application.

## Fail-open guarantee

If `mem` is not installed or the call times out:
- Pre-spawn hooks skip silently (no memory hints injected)
- Post-spawn hooks skip silently (no facts captured)
- Codex continues with no degradation

No dependency on token-goat-mem for Codex to function. Memory is purely optional and benefits accumulate over sessions.

## See also

- [AGENTS.md](../../AGENTS.md) — token-goat-mem data model and commands
- [README.md](../../README.md) — CLI reference and anchor predicates
- `/codex` skill — Claude's peer review agent
