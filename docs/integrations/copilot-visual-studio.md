# GitHub Copilot in Visual Studio + Token-Goat Mem Integration

Instruction wiring for GitHub Copilot Chat and code review inside Visual Studio.

## Quick start: `mem init copilot-visual-studio`

Wires the `.github/copilot-instructions.md` instructions documented below in one command:

```bash
mem init copilot-visual-studio --root .        # writes/upgrades a marked block in .github/copilot-instructions.md
mem init copilot-visual-studio --dry-run       # preview without touching disk
```

Safe to re-run (upgrades mem's own block in place, never duplicates it). Project-level only --
Visual Studio has no documented user-level instructions path this repo can write with confidence,
so `--user` is rejected with a clear error rather than silently writing nothing. `.github/` is
created if it does not already exist. The rest of this doc is what `mem init copilot-visual-studio`
writes, if you'd rather do it by hand.

## Why `.github/copilot-instructions.md`, not `AGENTS.md`

Per GitHub's published custom-instructions support matrix, Visual Studio does not read `AGENTS.md`
at all -- it reads `.github/copilot-instructions.md` for both Copilot Chat and Copilot code review,
and `.github/instructions/*.instructions.md` for chat only. This wiring targets the one file both
surfaces read.

If your project also installs an `AGENTS.md`-writing tool (`codex`, `copilot-cli`,
`copilot-vscode`), mem's block ends up in both files. VS Code and Copilot CLI read both, so they see
the block twice -- harmless in meaning, just redundant tokens. Do not try to prevent this by
coupling the two files: each tool's install/uninstall is independently reference-counted, and
cross-checking the other file would break that independence.

## Instruction wiring via `.github/copilot-instructions.md`

The reliable integration is prose that tells Copilot when to read and write memory -- not a hook
schema. `mem init copilot-visual-studio` writes:

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
- Add `--anchor "<predicate> <args>"` when a fact can be re-verified later
  instead of staying caveated forever, e.g.
  `--anchor "file-exists pnpm-lock.yaml"`. Predicates: file-exists,
  file-absent, file-newer-than, glob-exists, git-tracked, newest-of. The
  anchor path must stay inside --root (no "..", no absolute path).
```

This is the same wording `mem init copilot-jetbrains` writes into the same file. If both tools are
installed against the same `.github/copilot-instructions.md`, they share this one block -- tracked
by the same reference-counted marker used for the `AGENTS.md` tools.

## Shell invocation

Visual Studio's integrated terminal runs `mem` like any other CLI. `--kind` is required on every
`remember`:

```bash
mem remember "solution uses central package management" --kind preference --scope project --root . \
  --anchor "file-exists Directory.Packages.props"

mem recall --hint-format --root .
```

(`--hint-format` ignores `--kind`/`--scope` filters -- it always returns every in-scope kind under
its own per-kind caps.)

## How Copilot sees memory hints

Run `mem recall --hint-format` in the integrated terminal, then reference the output in Copilot
Chat:

```
$ mem recall --hint-format --root .
TGMEM/2
pref  fresh=affirmed  id=7ac43f22-...  display="stored pref (verify): central package management"
footer  mem show <id> for detail
```

Each `display` string embeds its own trust caveat ("verify", "unverified", "contradicted,
excluded"), so Copilot knows how much weight to give it without parsing anything further.

## Fail-open behavior

If `mem` is not on PATH, the terminal shows a command-not-found error and Copilot proceeds without
memory hints -- no fallback penalty. Verify the install with `mem --version` and `mem epoch`.

## See also

- `mem --help` -- full CLI reference
- `README.md` -- anchor predicates and the token-goat seam
- `docs/integrations/copilot-jetbrains.md` -- the same file, for JetBrains' local Copilot chat
- `docs/integrations/copilot-vscode.md` -- the `AGENTS.md`-based wiring VS Code and Copilot CLI read
