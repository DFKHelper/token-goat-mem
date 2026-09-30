# opencode + Token-Goat Mem Integration

Use token-goat-mem to carry durable facts, preferences, and decisions across opencode sessions.

## Quick start: `mem init opencode`

Wires the `AGENTS.md` instructions documented below in one command:

```bash
mem init opencode --root .     # writes/upgrades a marked block in the project's AGENTS.md
mem init opencode --user       # writes it into opencode's global rules file instead
mem init opencode --dry-run    # preview without touching disk
```

Safe to re-run (upgrades mem's own block in place, never duplicates it). A project install joins
the same shared "## Memory" block `mem init codex`, `copilot-cli`, and `copilot-vscode` write into
`AGENTS.md`: one reference-counted marker tracks every tool that installed it, and
`mem uninstall opencode` drops only opencode from that list. The block is removed once the last
tracked tool uninstalls, and the file is removed with it if mem created it.

## Where opencode reads instructions

opencode combines two sources of rules:

- **Project:** the first `AGENTS.md` it finds walking up from the directory it was started in. It
  falls back to `CLAUDE.md` only when no `AGENTS.md` exists, so a project that already has an
  `AGENTS.md` never sees a block `mem init claude-code` wrote into `CLAUDE.md`. That is why this
  install targets `AGENTS.md`. Run it with `--root` pointing at the directory whose `AGENTS.md`
  opencode actually picks up.
- **Global:** `~/.config/opencode/AGENTS.md`, on every platform. opencode resolves its config
  directory through xdg-basedir, which has no Windows branch, so on Windows this is
  `%USERPROFILE%\.config\opencode\AGENTS.md`, not a path under `%APPDATA%`. `mem init opencode
  --user` writes here. mem derives the path from your home directory and does not consult
  `XDG_CONFIG_HOME`; if you set that variable, add the block below to
  `$XDG_CONFIG_HOME/opencode/AGENTS.md` by hand.

A `--user` install reaches every project you open in opencode; a project install reaches only that
project, and also any other agent that reads the same `AGENTS.md`.

## The instruction block

This is the block `mem init opencode` writes, the same wording the other `AGENTS.md` tools share:

```markdown
## Memory

token-goat-mem is installed (`mem` on PATH).

- At the start of a task, run `mem recall --hint-format --root .` and treat
  each returned line's `display` string as a prior fact, honoring its
  embedded trust caveat.
- Do not wait to be asked to run `mem remember` — when the user says things
  like "remember that...", "always...", "from now on...", "never...",
  "don't...", or otherwise reaches a durable preference, decision, or
  correction, persist it yourself, right then:
  `mem remember "<short fact>" --kind preference|decision|fact|correction
  --scope project --root .`. Use --subject/--value for anything that can be
  contradicted later.
- Add `--why "<reason>"` to a decision or correction so a later session
  reads the reason before relitigating it.
- Add `--anchor "<predicate> <args>"` when a fact can be re-verified later
  instead of staying caveated forever, e.g.
  `--anchor "file-exists pnpm-lock.yaml"`. Predicates: file-exists,
  file-absent, file-newer-than, file-contains, file-not-contains, glob-exists,
  git-branch-is, git-tracked, package-version, valid-until, newest-of. The
  anchor path must stay inside --root (no "..", no absolute path).
```

## Shell-out invocation

opencode's agent runs shell commands directly, so it calls `mem` the same way any shell does.
`--kind` is required on every `remember`:

```bash
mem recall --hint-format --root .
mem remember "Releases are cut from master" --kind decision --subject release-branch --value master --scope project --root .
mem recall --kind correction --limit 5
```
