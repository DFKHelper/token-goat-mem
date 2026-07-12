# AGENTS.md

Guidance for AI agents and human contributors working in this repository. This file follows the tool-agnostic [AGENTS.md](https://agents.md) convention, so it is read by Claude Code, Codex, Cursor, Copilot, and any agent that honors it.

## Project

Token-Goat Mem is a local-first conversational memory companion for Claude Code and other AI coding agents. Written in TypeScript and bundled to `dist/token-goat-mem.mjs`, it preserves durable knowledge across sessions: preferences, decisions, project facts, and corrections. Built around failure-mode awareness: every fact carries provenance, freshness verdicts, and trust levels so wrong confident memories do not mislead silently. SQLite + WAL for durability, zero network calls (local only).

## Build, test, lint

```bash
npm install
npm test            # full test suite (vitest run)
npm run test:guards # fast I/O-free structural guards (tests/guards)
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint
npm run build       # bundle to dist/token-goat-mem.mjs
```

Tests run in two tiers (no hook manager is wired yet — run these manually):

- **Before committing (fast, ~2s)** — lint + typecheck + `npm run test:guards`. The guards are pure-introspection invariants that catch the structural bug class (unregistered command, broken fact schema) *before the commit lands*.
- **Before pushing (full)** — the entire suite (`npm test`), including end-to-end tests that exercise the full CLI and the shipped `dist/token-goat-mem.mjs` binary.

## Commands and operations

All memory operations are explicit and auditable:

- `mem remember <text> --kind <kind>` — capture a user-stated fact into active storage (`--kind` is required: preference/decision/fact/correction)
- `mem recall [query] [--hint-format]` — retrieve facts with trust levels and staleness verdicts; `--hint-format` emits token-goat-compatible display strings
- `mem review` — view pending, contested, or anchor-contradicted facts for human resolution (`--promote <id>` / `--reject <id>` act on pending facts)
- `mem forget <id>` — soft-delete a fact (marks superseded, kept for audit) and audit-log it
- `mem pin <id>` — exempt a fact from time-decay (still subject to anchor-contradiction checks)
- `mem edit <id>` — modify fact text, subject/value, anchor, or scope
- `mem show <id>` — view a fact and its full provenance
- `mem list` — all facts, filtered by status/kind/subject/scope
- `mem epoch` — emit a monotonic version number (for cache invalidation); `--gc` runs the retention pass first

## Data model

**facts** table: `id`, `text`, `kind` (preference/decision/fact/correction), `subject`, `value`, `scope` (global/project/path), `scope_root`, `source_type` (user/derived), `source_ref`, `captured_at`, `anchor`, `status` (active/pending/superseded/contested/pinned), `confidence`, `embedding`.

**sources** table: `fact_id`, `excerpt` (redacted preview, full content never persisted in sources table), `stored_at`.

**Contradiction resolution:** deterministic `subject`+`value` keying. Two active facts, same subject + scope, different value = mark loser `superseded`, prefer newer + higher-provenance. If genuinely ambiguous (same recency/provenance), mark `contested` and withhold from ground-truth surfacing.

## Token-Goat integration seam

Mem's integration into token-goat is stateless, live, and fail-open:

```bash
mem recall --hint-format --root <project-root> [--context-files a.ts,b.ts]
```

Returns `TGMEM/1` header + lines: `pref  fresh=affirmed|unverified|contradicted  id=abc  display="..."`. Token-goat surfaces `display` verbatim; trust caveat is embedded in the payload, not something the consumer reconstructs. Contested/low-trust facts excluded from `--hint-format` entirely.

If `mem` is missing, the binary times out, or parsing fails, token-goat treats it as "no hints" — fail-open to no memory (safe).
