# GitHub Copilot + Mem in VS Code

Use Mem to store durable project facts and preferences that survive VS Code sessions. Recall output lands in the integrated terminal, where Copilot Chat can pick it up as context.

## Quick start: `mem init copilot-vscode`

Wires the `tasks.json`, user `keybindings.json`, and `AGENTS.md` snippets documented below in one command:

```bash
mem init copilot-vscode --root .        # writes .vscode/tasks.json, ~/…/Code/User/keybindings.json, AGENTS.md
mem init copilot-vscode --dry-run       # preview without touching disk
```

Safe to re-run: mem's own tasks/keybinding entries and `AGENTS.md` block are upgraded in place, never duplicated, and a pre-existing hand-written task/keybinding with the same label/key aborts the write with a conflict error instead of being overwritten. `mem uninstall copilot-vscode` removes exactly those entries, preserving any other tasks/keybindings you've added. The rest of this doc is what `mem init copilot-vscode` writes, if you'd rather do it by hand.

## Shell invocation

The simplest pattern. Open the VS Code terminal and invoke Mem directly. `--kind` is required on every `remember`:

```bash
# Store a preference
mem remember "project uses pnpm, not npm" --kind preference --scope project --root .

# Store a decision with a staleness anchor
mem remember "auth service owns all database migrations" \
  --kind decision \
  --subject db-migrations \
  --value auth-service \
  --scope project --root . \
  --anchor 'file-exists src/auth/migrations.ts'

# Recall facts before starting a session (--hint-format ignores --kind/--scope filters;
# it always returns every in-scope kind under its own per-kind caps)
mem recall --hint-format --root .
```

No special setup required.

## VS Code tasks

Add Mem commands to `.vscode/tasks.json` for quick access (**Terminal > Run Task**):

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Mem: Recall project facts",
      "type": "shell",
      "command": "mem",
      "args": ["recall", "--hint-format", "--root", "${workspaceFolder}"],
      "presentation": { "reveal": "always" }
    },
    {
      "label": "Mem: Remember a preference",
      "type": "shell",
      "command": "mem",
      "args": ["remember", "${input:factText}", "--kind", "preference", "--scope", "project", "--root", "${workspaceFolder}"],
      "presentation": { "reveal": "always" }
    },
    {
      "label": "Mem: Review facts",
      "type": "shell",
      "command": "mem",
      "args": ["review", "--root", "${workspaceFolder}"],
      "presentation": { "reveal": "always" }
    }
  ],
  "inputs": [
    {
      "id": "factText",
      "type": "promptString",
      "description": "Fact to remember"
    }
  ]
}
```

## Keybindings for quick memory

Add to `keybindings.json` (Command Palette > "Preferences: Open Keyboard Shortcuts (JSON)"):

```json
[
  {
    "key": "ctrl+shift+m",
    "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "mem recall --hint-format --root .\u000d" }
  },
  {
    "key": "ctrl+shift+n",
    "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "mem remember \"\" --kind preference " }
  }
]
```

- **Ctrl+Shift+M** — runs recall immediately (the trailing `\u000d` is Enter)
- **Ctrl+Shift+N** — types a `mem remember` skeleton into the terminal for you to complete

## How Copilot sees memory hints

Run `mem recall --hint-format` in the integrated terminal, then reference the output in Copilot Chat (select it, or use Copilot's terminal-context affordances):

```
$ mem recall --hint-format --root .
TGMEM/2
pref  fresh=affirmed  id=7ac43f22-...  display="stored pref (verify): pnpm is the package manager"
footer  mem show <id> for detail; mem review to resolve contested/pending
```

Then in chat:

> **You:** Based on the memory I just recalled, add a dependency to package.json
>
> **Copilot:** The recalled preference says the project uses pnpm, so: `pnpm add ...`

Each `display` string embeds its own trust caveat ("verify", "unverified", "contradicted, excluded"), so Copilot knows how much weight to give it.

## AGENTS.md compliance

Copilot's agent mode reads a workspace `AGENTS.md`. Document Mem there so agents discover it without extra configuration:

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

No extension needed. The CLI is a standard tool like `npm` or `git`. If Codex or Copilot CLI have already run `mem init` against the same `AGENTS.md`, `mem init copilot-vscode` joins their same shared "## Memory" block instead of adding a duplicate one — all three tools' installs are tracked by one reference-counted marker, so the file never ends up with more than one "## Memory" section. `mem uninstall copilot-vscode` drops copilot-vscode from that tracking list; the block stays in place until the last tracked tool uninstalls.

## Workflow example

1. **Start session** — open VS Code
2. **Recall facts** — Ctrl+Shift+M (or Run Task > "Mem: Recall project facts")
3. **Chat with Copilot** — reference the recalled facts from the terminal
4. **Discover a new preference** — store it: `mem remember "no default exports in barrel files" --kind preference` (Ctrl+Shift+N, complete it)
5. **Next session** — repeat step 2; Copilot has continuity

## Fail-open: what happens if Mem is missing

If `mem` is not on PATH, the terminal shows a command-not-found error and Copilot proceeds without memory hints — no fallback penalty. Verify the install with `mem --version` and `mem epoch`.

## See also

- `mem --help` — full CLI reference
- `README.md` — anchor predicates and the token-goat seam
- `docs/integrations/copilot-cli.md` — the same patterns for Copilot CLI
