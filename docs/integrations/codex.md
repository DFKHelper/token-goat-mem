# Codex + Token-Goat Mem Integration

Use token-goat-mem to carry durable facts, preferences, and decisions across Codex sessions.

## Quick start: `mem init codex`

Wires the `AGENTS.md` instructions documented below in one command:

```bash
mem init codex --root .        # writes/upgrades a marked block in AGENTS.md
mem init codex --dry-run       # preview without touching disk
```

Safe to re-run (upgrades mem's own block in place, never duplicates it). If `mem init copilot-cli` has already run against the same `AGENTS.md`, `mem init codex` joins that same shared "## Memory" block instead of adding a second one -- both tools' installs are tracked by one reference-counted marker, so the file never ends up with two near-identical "## Memory" sections. `mem uninstall codex` drops codex from that tracking list; the block (and copilot-cli's install) stays in place until the last tracked tool uninstalls. The rest of this doc is what `mem init codex` writes, if you'd rather do it by hand.

## Shell-out invocation

Codex runs as a separate agent session with shell access. Shell out to `mem` directly to capture and retrieve facts. `--kind` is required on every `remember`:

```bash
# Capture a code review decision during a Codex session
mem remember "Prefer reduce + map over nested loops for readability" \
  --kind decision \
  --subject loop-style \
  --value reduce-map \
  --scope global

# Retrieve all design decisions for the current review
mem recall --kind decision

# Retrieve preferences with trust caveats (freshness verdict embedded in each line)
mem recall --kind preference --limit 5
```

`--kind` takes exactly one value per call. To pre-load multiple kinds, run one `recall` per kind, or omit `--kind` to recall across all kinds.

## Instruction wiring via AGENTS.md

Codex reads the project's `AGENTS.md` as instructions. The reliable integration is prose telling the agent when to read and write memory:

```markdown
## Memory

This machine has token-goat-mem installed (`mem` on PATH).

- At the start of a task, run `mem recall --hint-format --root .` and treat
  each returned line's `display` string as a prior fact, honoring its
  embedded trust caveat ("verify", "unverified", "contradicted, excluded").
- Do not wait to be asked to run `mem remember` — when the user says things
  like "remember that...", "always...", "from now on...", "never...",
  "don't...", or otherwise reaches a durable preference, decision, or
  correction, persist it yourself, right then:
  `mem remember "<short fact>" --kind preference|decision|fact|correction
  --scope project --root .`. Use --subject/--value for anything that can be
  contradicted later.
```

This is the same wording `mem init copilot-cli` writes. If both tools are installed against the same `AGENTS.md`, they share this one block -- see "Quick start" above.

## Direct CLI usage in a review script

```bash
#!/bin/bash
# Load preferences before analysis (--hint-format ignores --kind/--scope filters; it always
# returns all in-scope kinds under its own per-kind caps -- filter the output yourself if needed)
PREFS=$(mem recall --hint-format --root .)
echo "Prefs in scope: $PREFS"

# Run your analysis
# ...

# Capture the finding (anchor keeps it honest: contradicted if the file disappears)
mem remember "Found N+1 query pattern; prefer DataLoader wrapper" \
  --kind correction \
  --subject query-patterns \
  --value dataloader \
  --scope project --root . \
  --anchor 'file-exists src/queries.ts'
```

## Codex-specific patterns

**One-shot memory seeding:**
Before invoking `/codex` for a peer review, pre-load facts:

```bash
mem remember "Team prefers immutable data structures" --kind preference --scope global
mem remember "Use structured logging via pino, not console.log" --kind decision --scope project --root .
```

Then invoke Codex with an instruction to run `mem recall` first (via AGENTS.md as above, or inline in the prompt).

**Continuous review archive:**
After each Codex session, capture high-level verdicts:

```bash
mem remember "Agreed: async errors must propagate, never swallow" \
  --kind decision \
  --subject error-handling \
  --value propagate \
  --scope project --root .
```

Over time, `mem list --kind decision` accumulates a log of team design decisions any future session can recall.

## Trust caveats in output

`mem recall --hint-format` returns self-annotated display strings:

```
TGMEM/2
pref  fresh=affirmed  id=7ac43f22-...  display="stored pref (verify): pnpm is the package manager"
pref  fresh=unverified  id=21a1330e-...  display="stored pref (unverified, 2026-07): switched to bun"
footer  mem show <id> for detail; mem review to resolve contested/pending
```

The caveat lives inside `display` — "verify", "unverified", "contradicted, excluded" — so Codex treats low-trust facts accordingly without parsing anything. The shared `footer` line (present whenever at least one fact line was emitted) points to the same follow-up commands instead of repeating a CTA on every line. Anchor-contradicted facts are excluded from ground truth and routed to `mem review`.

## Fail-open guarantee

If `mem` is not installed or a call fails:

- Recall steps produce no hints (a missing binary is a command-not-found the agent can ignore)
- Capture steps fail loudly but harmlessly (nothing is stored)
- Codex continues with no degradation

No dependency on token-goat-mem for Codex to function. Memory is purely optional and benefits accumulate over sessions.

## See also

- [AGENTS.md](../../AGENTS.md) — token-goat-mem data model and commands
- [README.md](../../README.md) — CLI reference and anchor predicates
- `docs/integrations/claude-code.md` — the same patterns for Claude Code (adds a real hooks system)
