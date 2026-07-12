# GitHub Copilot CLI + Token-Goat Mem Integration

Shell-out patterns and instruction wiring for GitHub Copilot CLI.

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
mem recall --kind preference --scope project --hint-format --root .
```

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

Returns a `TGMEM/1` header plus one line per fact, or `no matching facts` on an empty store.

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

`file-contains` anchors take free-text substrings, so quote the whole predicate:

```bash
mem remember "auth schema is indexed" --kind fact --root . \
  --anchor 'file-contains schema.sql CREATE INDEX'
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
