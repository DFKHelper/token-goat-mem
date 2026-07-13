# GitHub Copilot CLI + Token-Goat Mem Integration

Shell-out patterns and instruction wiring for GitHub Copilot CLI.

## Quick start: `mem init copilot-cli`

Wires the `AGENTS.md` instructions documented below in one command:

```bash
mem init copilot-cli --root .        # writes/upgrades a marked block in AGENTS.md
mem init copilot-cli --dry-run       # preview without touching disk
```

Safe to re-run (upgrades mem's own block in place, never duplicates it) and coexists cleanly with `mem init codex` in the same `AGENTS.md` (each tool owns its own marked block). `mem uninstall copilot-cli` removes exactly that block. The rest of this doc is what `mem init copilot-cli` writes (minus the shell-wrapper pattern below, which `init` doesn't automate since it's a shell profile edit, not a config file).

## Installation

Mem must be on PATH for Copilot CLI to invoke it:

```bash
npm install -g token-goat-mem
mem --version   # verify installation
mem epoch       # confirms the CLI and SQLite store are wired (prints a number)
```

## Direct invocation from shell

Use `mem` as a regular CLI in Copilot CLI's shell tool or in your own terminal. `--kind` is required on every `remember`:

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

## Instruction wiring via AGENTS.md

Copilot CLI reads the project's `AGENTS.md` as custom instructions. The reliable integration is prose that tells the agent when to read and write memory — not a hook schema. Add to your project's `AGENTS.md`:

```markdown
## Memory

This machine has token-goat-mem installed (`mem` on PATH).

- At the start of a task, run `mem recall --hint-format --root .` and treat
  each returned line's `display` string as a prior fact, honoring its
  embedded trust caveat ("verify", "unverified", "contradicted, excluded").
- When the user states a durable preference, decision, or correction, persist
  it: `mem remember "<short fact>" --kind preference|decision|fact|correction
  --scope project --root .`. Use --subject/--value for anything that can be
  contradicted later.
```

## Session pre-loading via a wrapper

To surface memory before Copilot even starts, wrap the launch in a shell function (`~/.bashrc`, `~/.zshrc`, or equivalent):

```bash
copilot-mem() {
  mem recall --hint-format --root . 2>/dev/null
  copilot "$@"
}
```

The recall output lands in your terminal scrollback where you (or the agent, on request) can reference it.

## Embedding memory into token-goat

When both Mem and token-goat are installed, token-goat calls `mem recall --hint-format --root <project-root>` internally to embed memory hints into its manifest. No wiring needed.

To verify the seam is live:
```bash
mem recall --hint-format --root .
```

Returns a `TGMEM/2` header, one line per fact plus a shared `footer` line when at least one fact was returned, or just the bare `TGMEM/2` header line with nothing else on an empty store (`--hint-format` never prints `no matching facts` -- that string is only emitted by plain `mem recall`).

## Fail-open behavior

If `mem` is missing, times out, or returns unparseable output, Copilot CLI continues without memory hints. No exceptions, no halts. Wire memory as a convenience layer, not a dependency.

## Typical workflow

1. **Start of session:** manually or via the AGENTS.md instruction, `mem recall --kind preference --scope project --root .` surfaces prior project preferences.
2. **During work:** write facts as decisions land: `mem remember "chose Postgres for JOIN semantics" --kind decision --scope project`.
3. **End of session:** optional `mem review --root .` to audit what's stored and resolve pending or anchor-contradicted facts.
4. **Next session:** the same facts re-surface, with freshness verdicts telling Copilot which ones to re-verify.

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

## See also

- `README.md` — full CLI and anchor-predicate reference
- `AGENTS.md` — agent-facing command and data-model summary
- `docs/integrations/claude-code.md` — Claude Code patterns (adds a real hooks system)
