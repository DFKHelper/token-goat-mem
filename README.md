# Token-Goat Mem

**Durable memory for daily AI coding** · **1-second recall** · **Trustworthy confidence levels** · **Anchor-based freshness** · **Optional token-goat seam**

**Local-first, defense-in-depth memory that remembers what your AI coding agent keeps forgetting between sessions.**

You tell your AI "we use pnpm not npm" and it forgets. Every session. Then it runs `npm install` and corrupts the lockfile. You re-explain that you prefer 2-space indentation, and the next day it defaults to tabs. These are not oversights — the agent genuinely does not see a record of these decisions after a compaction.

Mem stores them. Locally, in your own SQLite database. Each fact carries a trust level and an anchor (a read-only predicate that tests whether the fact is still true). On recall, Mem re-validates anchors and surfaces only the facts that are fresh and trustworthy, with a confidence caveat so your agent never treats a hint as ground truth when it should not.

Works with **Claude Code**, **Copilot CLI**, **Cursor**, **Windsurf**, **Cline**, and **Aider**. Optional one-way seam with **token-goat** for embedding memory hints into the token-reduction manifest.

**Install in one command:**

```
npm install -g token-goat-mem
mem --help
```

[![npm](https://img.shields.io/npm/v/token-goat-mem.svg)](https://www.npmjs.com/package/token-goat-mem) [![PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-lightgrey)](LICENSE) ![requires Node.js](https://img.shields.io/badge/requires-Node.js%20%3E%3D18-339933?logo=node.js&logoColor=white)

> Built and maintained by [DFK Helper](https://dfkhelper.com). Free under PolyForm Noncommercial. If it saves your tokens, or your sanity, drop a star at the top of this page.

[Install](#install) · [CLI](#cli) · [How it works](#how-it-works) · [Token-goat integration](#optional-token-goat-seam) · [Disclaimer & License](#disclaimer)

---

## The problem

Your AI coding agent accumulates durable knowledge that keeps evaporating:

- **Preferences** — "uses pnpm not npm", "2-space indent", "no default exports", "tabs not spaces"
- **Decisions** — "chose Postgres over Mongo for relational queries", "auth service owns migrations"
- **Project facts** — "staging DB is at prod-staging-db-1", "CI env is GitHub Actions"
- **Corrections** — recurring "do not do X" that you repeat every session

Today this knowledge is lost at each session boundary. The agent re-asks, re-derives, or — worst — forgets and does the wrong thing. A confident wrong memory is worse than no memory at all. If Mem surfaces a stale preference as ground truth ("you use npm" three months after you switched to pnpm), your agent acts on it and corrupts your lockfile.

The defining engineering problem is not *retrieval* — it is **correctness and staleness**. Mem solves both.

## What changes

| Before | After |
|--------|-------|
| Agent re-reads the same preference every session | "Stored pref (verify): uses pnpm, not npm — mem show <id>" — one-line hint with confidence |
| Agent does the wrong thing because it forgot a decision | `mem remember "Postgres chosen over Mongo for relational JOIN queries"` persists it; `mem recall` surfaces it with provenance and age |
| Mixed signals on project setup (old README says npm, lockfile says pnpm) | Anchor predicates test the *actual state* (which lockfile is newer, git history); contradicted facts surface only in `mem review` for human resolution, never as ground truth |
| Every session starts cold | `mem recall --hint-format` embeds prior facts into your AI context at startup (~5-10 lines per session) |
| Session compaction forgets preferences | Preferences are marked active/pinned and survive compaction; confidence decays over time if not re-affirmed |
| Stale facts invisible until they cause damage | `mem review` flags anchors that contradict stored facts before they become silent bugs |

## How it works

1. **Explicit capture** — `mem remember "uses pnpm not npm"` stores a fact with a source reference and timestamp.
2. **Optional anchors** — Add an anchor: `mem remember "uses pnpm" --anchor 9'file-newer-than pnpm-lock.yaml package-lock.json9'`. The anchor is a read-only predicate; on recall, Mem tests it and returns one of three verdicts: `affirmed` (ground truth), `unverified` (hint to verify), or `contradicted` (suppressed, flagged in review).
3. **Recall with trust levels** — `mem recall --kind preference` returns active facts sorted by recency, with each fact annotated by trust level, freshness verdict, and age. Low-trust facts are marked "verify" so your AI never mistakes a hint for ground truth.
4. **Review and resolution** — `mem review` shows all facts, their anchor verdicts, and any contradictions (same subject, different values, both active). Contradictions are never surfaced as ground truth — they appear here for you to resolve.
5. **Forget and edit** — `mem forget <id>` deletes a fact; `mem edit <id>` updates text or anchor. Both bumps an internal epoch so the token-goat seam always sees the latest state.

## Install

**Requirements:** Node.js 18 or later

```
npm install -g token-goat-mem
mem --help
```

That's it. No daemon, no tray icon, no setup wizard. Mem is a short-lived CLI process.

### Verify the install

```
mem doctor
```

Confirms the database is readable and the CLI is wired correctly.

## CLI

| Command | What it does |
|---------|-------------|
| `mem remember <text>` | Store a new fact. --kind preference or decision or fact or correction, --subject key (for contradiction detection), --value value, --anchor predicate (optional), --scope global or project or path. |
| `mem recall [filter]` | List facts by kind/subject/scope. --kind, --subject, --scope, --hint-format (TGMEM/1 for token-goat), --age-days N, --limit N. Returns facts sorted by freshness + recency. |
| `mem show <id>` | Show one fact in full: text, source, anchor, verdicts, history. |
| `mem review` | Show all facts with freshness verdicts and contradiction flags. |
| `mem forget <id>` | Delete a fact (soft delete). Bumps epoch. |
| `mem edit <id>` | Change a fact's text or anchor. Bumps epoch. |
| `mem pin <id>` | Exempt a fact from time-decay, but still subject to anchor contradiction. |
| `mem list` | Show fact IDs and a one-line summary. |
| `mem epoch` | Print the current epoch (bumped on every write). |
| `mem doctor` | Verify database integrity and anchor evaluation. |

## Optional token-goat seam

Mem works standalone. When token-goat is on PATH, token-goat can call `mem recall --hint-format --root <project-root>` to embed memory hints into its token-reduction manifest.

The seam is one-directional (Mem reads nothing from token-goat), stateless (live calls, no caching), and self-caveating (display strings include their own trust caveats). Contested or low-trust facts are excluded from --hint-format entirely — only ground-truth-eligible or explicitly-caveated hints are emitted. Mem does not cache results; forget/edit reflect instantly. If mem is not on PATH or the call times out, token-goat falls back to no hints (fail-open).

## Works with

- Claude Code
- Copilot CLI
- Cursor
- Windsurf (including Cascade AI patterns)
- Cline
- Aider

## Disclaimer

Token-Goat Mem runs on your machine and writes to your local SQLite database. The software is provided as-is, without warranty of any kind. DFK Helper LLC is not liable for any damages arising from use. Full terms, including the No Liability clause, are in the LICENSE file.

Mem stores facts you tell it to remember and suggests candidate facts for confirmation. Never persisted by default: secrets, credentials, PII, high-entropy tokens, full file contents. Enforcement layers: (a) only short extracted facts are stored; (b) secret-pattern and entropy screening; (c) suggested facts shown in `mem review` before surfacing. Local-only, zero network. Run `mem review` to audit all stored facts.

## License

Token-Goat Mem is source-available under the PolyForm Noncommercial License 1.0.0.

**Personal use:** free. Includes hobby projects, individual productivity, personal study, and private coding. Individual developers may install and use the software on their own machines for individual productivity purposes without a commercial license.

**Commercial use or shared infrastructure:** requires a license. Contact token-goat@dfkhelper.com for details.

**Patent Pending.**

Full terms in LICENSE.

---

Built and maintained by DFK Helper. Inspired by Karpathy's LLM Council and the memory-companion design by the token-goat team. If it saves your tokens or your sanity, a star means the world.
