# GitHub Copilot + Mem in VS Code

Use Mem to store durable project facts and preferences that survive VS Code sessions. Copilot sees memory hints in chat context and respects them across workflows.

## Shell invocation

The simplest pattern. Open VS Code terminal and invoke Mem directly:

```bash
# Store a preference
mem remember "project uses pnpm, not npm"

# Store a decision with confidence anchor
mem remember "auth service owns all database migrations" \
  --subject "db-migrations" \
  --value "auth-service" \
  --anchor 'file-contains src/auth/migrations.ts migration'

# Recall facts before starting a session
mem recall --hint-format --scope project
```

Copilot can see the output and incorporate it into subsequent chats. No special setup required.

## VS Code tasks

Add Mem commands to `.vscode/tasks.json` for quick access:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Mem: Recall project facts",
      "type": "shell",
      "command": "mem",
      "args": ["recall", "--hint-format", "--scope", "project"],
      "presentation": { "reveal": "always" }
    },
    {
      "label": "Mem: Remember",
      "type": "shell",
      "command": "mem",
      "args": ["remember"],
      "presentation": { "reveal": "always" },
      "promptOnClose": false
    },
    {
      "label": "Mem: Review facts",
      "type": "shell",
      "command": "mem",
      "args": ["review"],
      "presentation": { "reveal": "always" }
    }
  ]
}
```

Run via **Terminal > Run Task** (Ctrl+Shift+D). Copilot chat sees the terminal output.

## Keybindings for quick memory

Add to `.vscode/keybindings.json`:

```json
[
  {
    "key": "ctrl+shift+m",
    "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "mem recall --hint-format" }
  },
  {
    "key": "ctrl+shift+n",
    "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "mem remember " }
  }
]
```

- **Ctrl+Shift+M** — recall facts (output to terminal, Copilot sees it)
- **Ctrl+Shift+N** — start a `mem remember` command (complete in terminal)

## How Copilot sees memory hints

When you run `mem recall --hint-format` in the terminal during a Copilot chat session, the output is visible in the chat context. Copilot can reference it:

```
You (terminal):
$ mem recall --hint-format --scope project

Mem (output):
TGMEM/1
pref  fresh=affirmed  id=abc123  display="uses pnpm not npm (verified)"
fact  fresh=affirmed  id=def456  display="auth service owns migrations (file-backed)"
```

Then in Copilot chat:

> **You:** Based on the memory I just recalled, add a dependency to package.json
>
> **Copilot:** I see from memory that the project uses pnpm. I'll add it via `pnpm add ...`

Copilot reads the terminal output and grounds its response in the memory facts.

## AGENTS.md compliance

Mem's `AGENTS.md` convention is compatible with VS Code's agent discovery. When Copilot or other agents open this workspace, they read `AGENTS.md` to understand that Mem is available as a local CLI:

```bash
mem remember "..."      # capture facts
mem recall --hint-format # retrieve with trust levels
mem review              # audit facts and contradictions
```

No special extension or configuration in VS Code needed. The CLI is a standard tool like `npm` or `git`.

## Workflow example

1. **Start session** — open VS Code
2. **Recall facts** — `mem recall --hint-format --scope project` (Ctrl+Shift+M)
3. **Chat with Copilot** — Copilot sees the output in your terminal
4. **Discover a new preference** — use Copilot to explore, then store it: `mem remember "no default exports in barrel files"` (Ctrl+Shift+N, complete it)
5. **Next session** — repeat step 2; Copilot has continuity

## Fail-open: what happens if Mem is missing

If `mem` is not on PATH or the call times out, the terminal shows an error. Copilot proceeds without memory hints — no fallback penalty, and your chat continues normally. Run `mem doctor` to verify the install is correct.

## See also

- `mem --help` — full CLI reference
- `mem review` — audit all stored facts and contradiction flags
- README: Token-Goat Seam section for deeper integration with other tools
