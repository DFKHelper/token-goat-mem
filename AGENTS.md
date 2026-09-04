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

Tests run in two tiers (`npm install` points `core.hooksPath` at `.githooks/`, so the fast tier runs on every commit; `git commit --no-verify` skips it once):

- **Before committing (fast, ~2s)** — lint + typecheck + `npm run test:guards`. The guards are pure-introspection invariants that catch the structural bug class (unregistered command, broken fact schema) *before the commit lands*.
- **Before pushing (full)** — the entire suite (`npm test`), including end-to-end tests that exercise the full CLI and the shipped `dist/token-goat-mem.mjs` binary.

## Commands and operations

All memory operations are explicit and auditable:

- `mem remember <text> --kind <kind>` — capture a user-stated fact into active storage (`--kind` is required: preference/decision/fact/correction)
- `mem recall [query] [--hint-format]` — retrieve facts with trust levels and staleness verdicts; `--hint-format` emits token-goat-compatible display strings; `--entity <value>` (repeatable, ANDed) filters to facts carrying that extracted entity
- `mem review` — view pending, contested, anchor-contradicted, or unanchored-but-checkable facts for human resolution (`--promote <id>` / `--reject <id>` act on pending facts; the `unanchored` bucket is an advisory nudge to add an anchor, not a pending decision)
- `mem forget <id>` — soft-delete a fact (marks superseded, kept for audit) and audit-log it
- `mem pin <id>` — exempt a fact from time-decay (still subject to anchor-contradiction checks)
- `mem used <id...> --session-id <id>` — record that facts recalled in that session were actually useful; feeds recall ranking as a third RRF rank list
- `mem edit <id>` — modify fact text, subject/value, anchor, or scope
- `mem show <id>` — view a fact and its full provenance
- `mem list` — all facts, filtered by status/kind/subject/scope
- `mem facets` — extract and inspect the structured entity/topic terms behind `mem recall --entity`; no flags backfills facts missing terms, `--all` re-extracts everything after an extraction-rule change, `--fact <id>` shows one fact's terms, `--list-entities` lists the distinct entities with fact counts
- `mem embed` — compute embedding vectors for facts, enabling semantic recall alongside BM25; `--all` re-embeds everything after a model change, `--limit <n>` bounds the run. Off unless `TOKEN_GOAT_MEM_EMBED_URL` and `TOKEN_GOAT_MEM_EMBED_MODEL` are set
- `mem consolidate` — report near-duplicate facts (deterministic Jaccard over the `fact_terms` topic layer, same kind + same scope binding only, `--threshold` default 0.5) or, with `--stale`, live facts older than `--stale-days` (default 90) that recall has never surfaced and nobody marked useful. Dry run by default; `--apply` marks the losers `superseded` through the same audited soft-delete `mem forget` uses, never touching a pinned fact and never hard-deleting
- `mem epoch` — emit a monotonic version number (for cache invalidation); `--gc` runs the retention pass first

## Data model

**fact_terms** table: `fact_id`, `term` (verbatim), `term_key` (normalized lookup form), `kind` (entity/topic) — the structured facet layer (`src/facets.ts`). Entities are the identifier-shaped tokens BM25's stemmer destroys (paths, dotted filenames, snake_case, camelCase, CLI flags, versions, `@scope/package`), stored exactly as written; topics are `tokenize`'s own stemmed terms. Written in the same transaction as the fact insert/edit, cascaded on delete, and read by `mem recall --entity`.

**facts** table: `id`, `text`, `kind` (preference/decision/fact/correction), `subject`, `value`, `scope` (global/project/path), `scope_root`, `source_type` (user/derived), `source_ref`, `captured_at`, `anchor`, `status` (active/pending/superseded/contested/pinned), `confidence`, `embedding`. `last_surfaced_at` is a durable mirror of "recall has shown this fact at least once", written alongside every `recall_log` insert: the log itself rotates after 30 days, so it cannot answer that question for an old fact, and `mem consolidate --stale` would otherwise propose superseding facts it had surfaced months ago.

**Retrieval:** BM25 by default, with no configuration and no network. `--entity` is a structured filter alongside it, not a ranking input: BM25 reduces `src/retrieval.ts` to `src`/`retriev`/`ts` and cannot tell a fact naming that file from one merely using those three words, which is the gap the facet layer closes. Setting `TOKEN_GOAT_MEM_EMBED_URL` + `TOKEN_GOAT_MEM_EMBED_MODEL` (optionally `TOKEN_GOAT_MEM_EMBED_API_KEY`) to an OpenAI-compatible embeddings endpoint adds a dense rank list fused with BM25 via RRF. The `meta` table records which model produced the stored vectors; a configured model that disagrees with it disables embedding ranking rather than comparing two vector spaces, and `mem embed --all` migrates.

**sources** table: `fact_id`, `excerpt` (redacted preview, full content never persisted in sources table), `stored_at`. The read/write/gc paths exist and are tested, but no capture path writes to it yet — the table is empty in practice. Keeping it unfed is a decision, not an oversight: deleting it would be a schema migration plus a break of the `insertSource`/`listSourcesForFact`/`deleteSourcesOlderThan` exports in `src/index.ts`, a one-way door bought for no correctness gain. `tests/guards/unfed-sources.test.ts` holds the docs to that state in both directions.

**Contradiction resolution:** deterministic `subject`+`value` keying. Two active facts, same subject + scope, different value = mark loser `superseded`, prefer newer + higher-provenance. If genuinely ambiguous (same recency/provenance), mark `contested` and withhold from ground-truth surfacing. A subject holds exactly one value: capturing a second value against the same subject is read as a correction, not as adding to a set, so encode set membership as a distinct subject per member (`supported-node-lts`, not two values under `supported-node`).

## Token-Goat integration seam

Mem's integration into token-goat is stateless, live, and fail-open:

```bash
mem recall --hint-format --root <project-root> [--context-files a.ts,b.ts]
```

Returns `TGMEM/2` header + one line per fact (`pref  fresh=affirmed|unverified|contradicted  id=abc  display="..."`), then one shared footer line (`footer  mem show <id> for detail; mem review to resolve contested/pending`) when at least one fact line was emitted. Token-goat surfaces `display` verbatim; trust caveat is embedded in the payload, not something the consumer reconstructs. Contested/low-trust facts excluded from `--hint-format` entirely. `TGMEM/1` (per-line CTA, no footer) is still fully supported by the programmatic seam via `protocolVersion: 1`.

If `mem` is missing, the binary times out, or parsing fails, token-goat treats it as "no hints" — fail-open to no memory (safe).

**Cheap polling:** `mem epoch` prints a monotonic integer bumped on every store write and left alone otherwise. It covers store state only — not anchor verdicts (filesystem and git, re-evaluated live on each recall) or preference decay (time-dependent). A polling consumer can use epoch to avoid redundant recalls when the store is unchanged, but should also re-run `mem recall` on a time interval or working-tree events (branch switches, installs) to refresh anchors and decay.

Store-only pattern:
```bash
last_epoch=$(mem epoch)
current_epoch=$(mem epoch)
[ "$current_epoch" != "$last_epoch" ] && mem recall --hint-format --root <project-root>
```

To refresh all state including anchors and decay, also use a time interval (e.g., every 5 minutes):
```bash
[ $(($(date +%s) - last_recall)) -gt 300 ] && mem recall --hint-format --root <project-root>
```

<!-- token-goat-mem:start tools=copilot-cli,copilot-vscode -->
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
<!-- token-goat-mem:end -->
