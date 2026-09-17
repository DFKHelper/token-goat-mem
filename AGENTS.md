# AGENTS.md

Guidance for AI agents and human contributors working in this repository. This file follows the tool-agnostic [AGENTS.md](https://agents.md) convention, so it is read by Claude Code, Codex, Cursor, Copilot, and any agent that honors it.

## Project

Token-Goat Mem is a local-first conversational memory companion for Claude Code and other AI coding agents. Written in TypeScript and bundled to `dist/token-goat-mem.mjs`, it preserves durable knowledge across sessions: preferences, decisions, project facts, and corrections. Built around failure-mode awareness: every fact carries provenance, freshness verdicts, and trust levels so wrong confident memories do not mislead silently. SQLite + WAL for durability, no network calls unless `TOKEN_GOAT_MEM_EMBED_URL`/`_MODEL` or `TOKEN_GOAT_MEM_DREAM_URL`/`_MODEL` are configured (see the `mem dream`/`mem embed` entries below for what each then sends off-machine).

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

- `mem remember <text> --kind <kind>` — capture a user-stated fact into active storage (`--kind` is required: preference/decision/fact/correction). Restating a stored fact reaffirms it instead of duplicating it: same normalized text + kind + scope binding + subject/value refreshes `captured_at` and confidence and prints `reaffirmed` (value compared case-insensitively with internal whitespace collapsed -- same normalization contradiction detection uses -- though the raw value typed is what gets stored). Never matches a `pending` or `superseded` fact, and `mem suggest` never reaffirms — derived text must not refresh a user-stated fact's clock
- `mem recall [query] [--hint-format]` — retrieve facts with trust levels and staleness verdicts; `--hint-format` emits token-goat-compatible display strings; `--entity <value>` (repeatable, ANDed) filters to facts carrying that extracted entity. Ranking is BM25-only unless `TOKEN_GOAT_MEM_EMBED_URL`/`_MODEL` are set, in which case the query text itself is sent to that endpoint too -- including every prompt, when this command runs via a coding tool's `UserPromptSubmit` hook (see `mem init`)
- `mem review` — view pending, contested, anchor-contradicted, or unanchored-but-checkable facts for human resolution (`--promote <id>` / `--reject <id>` act on pending facts, `--undo <id>` reverses a rejection; the `unanchored` bucket is an advisory nudge to add an anchor, not a pending decision). A pending `correction`, or any pending fact carrying a `subject`, also prints `may contradict <id> "<text>"` naming the single best-matching live fact it may contradict once promoted (the same entity/topic-weighted lookup `mem show --related` runs); a label only, it never supersedes, changes status, or promotes anything
- `mem scan-session [--hook-stdin|--transcript <path>]` — scan a session transcript for durable-statement sentences and file each as `pending`; deterministic opener matching, no model, and only the human's own text (tool results, `<system-reminder>` spans, slash-command payloads, relayed subagent reports, and compaction summaries all live under the user role and are all excluded). Installed by `mem init claude-code` as both a `Stop` and a `PreCompact` hook with `--quiet` (same command, two triggers: `Stop` never fires for a killed or interrupted session, and `PreCompact` is the only event guaranteed to fire while the pre-compaction transcript is still on disk; the scan skips any candidate whose text is already stored, so the overlap files nothing twice -- unless that match is still `pending`, in which case the repeat is recorded as a **sighting** (a `sightings` counter plus a deduped source excerpt, `mem review`'s pending bucket sorts by it) rather than dropped; `mem import --from-md` records the same sighting on its own `skipped (already known)` outcome). Each fact is dated from the transcript entry's own `timestamp` when it carries one, not from the moment of the scan -- re-scanning an archived transcript would otherwise back-date nothing and mis-age everything, skewing preference decay, the `--stale` cutoff, recall's recency tie-break and the pending review order by the transcript's whole age. An entry with no timestamp, or one that is malformed or future-dated, falls back to now without failing the scan. The `sources` row's `stored_at` stays the scan time: when a thing was said and when mem stored it are different columns.
- `mem forget <id>` — soft-delete a fact (marks superseded, kept for audit) and audit-log it
- `mem pin <id>` — exempt a fact from time-decay (still subject to anchor-contradiction checks) and reserve it one of the 2 `--hint-format` slots held for pinned facts ahead of the per-kind caps; past those two, pins compete on relevance like anything else
- `mem used <id...> --session-id <id>` — record that facts recalled in that session were actually useful; feeds recall ranking as a third RRF rank list
- `mem edit <id>` — modify fact text, subject/value, anchor, or scope (`--force` is required for a `source_type=user` fact and is recorded in the audit log; `--undo` reverses the most recent edit, restoring only the fields it touched)
- `mem show <id>` — view a fact and its full provenance, including `history`: every audit row for the fact, oldest first. An edited fact's previous text is recorded there in full and nowhere else, since `mem edit` overwrites in place
- `mem list` — all facts, filtered by status/kind/subject/scope
- `mem facets` — extract and inspect the structured entity/topic terms behind `mem recall --entity`; no flags backfills facts missing terms, `--all` re-extracts everything after an extraction-rule change, `--fact <id>` shows one fact's terms, `--list-entities` lists the distinct entities with fact counts
- `mem embed` — compute embedding vectors for facts, enabling semantic recall alongside BM25; `--all` re-embeds everything after a model change, `--limit <n>` bounds the run. Off unless `TOKEN_GOAT_MEM_EMBED_URL` and `TOKEN_GOAT_MEM_EMBED_MODEL` are set, in which case fact text is sent to that endpoint to be embedded (`mem remember`/`mem suggest` send it too, on capture)
- `mem consolidate` — report near-duplicate facts (deterministic Jaccard over the `fact_terms` topic layer, same kind + same scope binding only, `--threshold` default 0.5), run alongside two exact-text passes that close that same-scope-binding blind spot without loosening the Jaccard comparison itself: the default run also reports (and, under `--apply`, supersedes) a live project-scope fact whose text exactly matches a same-kind global fact and whose subject and value also agree, keeping the global one -- text equality alone is not enough, since a same-worded subject ("the default branch name") can legitimately carry a different value in each scope, and that pair is an override, never a duplicate; `--cross-project` reports, **report-only, no `--apply` path**, same-kind/same-text facts (subject and value agreeing, by the same rule) restated under two or more distinct projects, with a paste-ready `mem edit <id> --scope global` for the newest. Or, with `--stale`, live facts captured before the `--stale-days` cutoff (default 90) that have gone unsurfaced for at least that long (windowed, not lifetime-never-surfaced -- a fact surfaced once, long before the window, is eligible again once it goes quiet for the window's length) and that nobody has ever marked useful (that exclusion is unbounded, not windowed). Dry run by default; `--apply` marks the losers `superseded` through the same audited soft-delete `mem forget` uses, never touching a pinned fact and never hard-deleting
- `mem dream` — report what a configured model thinks follows from several stored facts together. Writes nothing and has no flag that makes it; off unless `TOKEN_GOAT_MEM_DREAM_URL` + `TOKEN_GOAT_MEM_DREAM_MODEL` are set, in which case it sends stored fact text to that endpoint (`mem remember`/`mem suggest`/`mem embed`/`mem recall` reach a different endpoint the same way, when embeddings are configured -- see the opening paragraph above). Sends `active`/`pinned` facts only, newest first, capped at 200; every candidate must cite ≥2 of the sent facts by a resolving index and must not restate a stored fact, or it is dropped before printing
- `mem epoch` — emit a monotonic version number (for cache invalidation); `--gc` runs the retention pass first
- `mem doctor` — read-only health check; no options. Beyond db path/WAL/tables/epoch/status counts and embedding + dream configuration, two lines answer questions no other command can: **hint budget** (how many facts are recallable against the at-most-14 lines one `--hint-format` block carries, and how many are pinned against the 2 reserved slots — a store past the ceiling holds facts `mem list` shows and recall never sends), and **scope placement** (project/path-scoped facts whose `scope_root` is gone from disk — unreachable from any session, and counted as healthy and active by every other line)

## Data model

**fact_terms** table: `fact_id`, `term` (verbatim), `term_key` (normalized lookup form), `kind` (entity/topic) — the structured facet layer (`src/facets.ts`). Entities are the identifier-shaped tokens BM25's stemmer destroys (paths, dotted filenames, snake_case, camelCase, CLI flags, versions, `@scope/package`), stored exactly as written; topics are `tokenize`'s own stemmed terms. Written in the same transaction as the fact insert/edit, cascaded on delete, and read by `mem recall --entity`.

**facts** table: `id`, `text`, `kind` (preference/decision/fact/correction), `subject`, `value`, `scope` (global/project/path), `scope_root`, `scope_repo` (`<normalized git remote>#<root relative to the working tree>`, project scope only, `null` outside a checkout or with no unambiguous remote — recall matches a fact whose `scope_root` *or* `scope_repo` binds, so a fact survives a second clone, a worktree, and an export onto another machine, while the subpath half keeps two monorepo packages distinct; `TOKEN_GOAT_MEM_PROJECT_IDENTITY=path` opts out. Contradiction bucketing deliberately still keys on `scope_root` alone), `source_type` (user/derived), `source_ref`, `captured_at`, `anchor`, `status` (active/pending/superseded/contested/pinned), `confidence`, `embedding`. `last_surfaced_at` is a durable mirror of "recall has shown this fact at least once", written alongside every `recall_log` insert: the log itself rotates after 30 days, so it cannot answer that question for an old fact, and `mem consolidate --stale` would otherwise propose superseding facts it had surfaced months ago. `sightings` (`NOT NULL DEFAULT 0`) counts repeat restatements of a `pending` fact recorded by `mem scan-session`/`mem import --from-md` -- evidence for a human reading `mem review`'s pending bucket only, never read by any ground-truth or promotion path; local to the store it was recorded in, so it is not carried across `mem export`/`mem import --from-json`.

**Retrieval:** BM25 by default, with no configuration and no network. BM25 reduces `src/retrieval.ts` to `src`/`retriev`/`ts` and cannot tell a fact naming that file from one merely using those three words, which is the gap the facet layer closes — in two ways. `--entity` is a structured *filter* the caller opts into by naming the identifier. Separately, and with no flag, recall extracts entities from the query text itself and fuses an entity-overlap *rank list* into RRF alongside the others (`storage.getEntityOverlapForQuery` → `RetrievalOptions.entityOverlap`); it costs one indexed `fact_terms` lookup per identifier the query contains and is empty — so silent — for a query containing none, which is what keeps it from voting on queries it has no signal for. Setting `TOKEN_GOAT_MEM_EMBED_URL` + `TOKEN_GOAT_MEM_EMBED_MODEL` (optionally `TOKEN_GOAT_MEM_EMBED_API_KEY`) to an OpenAI-compatible embeddings endpoint adds a dense rank list fused with BM25 via RRF. The `meta` table records which model produced the stored vectors; a configured model that disagrees with it disables embedding ranking rather than comparing two vector spaces, and `mem embed --all` migrates.

**sources** table: `fact_id`, `excerpt` (screened for secrets and truncated to `MAX_SOURCE_EXCERPT_LENGTH`, full content never persisted; the truncation window is centred on the fact's own sentence rather than taken from the head, so an excerpt always contains the statement it is evidence for -- a long turn whose durable sentence came last used to yield a source row that did not mention the fact at all), `stored_at`. Fed from exactly two capture paths where the raw material is genuinely larger than the fact: `mem scan-session` (excerpt = the whole user turn the candidate sentence was pulled from) and `mem import --from-md` (excerpt = `<path>:<line>: <raw bullet line>`), both writing their source row in the same transaction as the fact via `capture.ts`'s `writeFact`. `mem remember` and `mem suggest <text>` never write one — there the caller's text *is* the fact, and a source row echoing it back would be provenance noise, not evidence. A screened-positive excerpt (secret detected past the extracted fact text) skips the source row and still captures the fact; it is never stored partially screened. `tests/guards/unfed-sources.test.ts` guards this shape: fed only from the two derived-capture paths, never from `remember`/`suggest`, always truncated and secret-screened.

**Contradiction resolution:** deterministic `subject`+`value` keying (value compared case-insensitively with internal whitespace collapsed, so "pnpm" and "Pnpm" agree rather than contradicting -- the raw value each fact stored is unaffected). Two active facts, same subject + scope, genuinely different value = mark loser `superseded`, prefer newer + higher-provenance. If genuinely ambiguous (same recency/provenance), mark `contested` and withhold from ground-truth surfacing. A subject holds exactly one value: capturing a second value against the same subject is read as a correction, not as adding to a set, so encode set membership as a distinct subject per member (`supported-node-lts`, not two values under `supported-node`).

## Token-Goat integration seam

Mem's integration into token-goat is stateless, live, and fail-open:

```bash
mem recall --hint-format --root <project-root> [--context-files a.ts,b.ts]
```

Returns `TGMEM/2` header + one line per fact (`pref  fresh=affirmed|unverified|contradicted  id=abc  display="..."`), then at most one shared footer line carrying only the clauses that apply: `mem show <id> for detail` when a fact line was emitted, `N more in scope, not sent` when the caps dropped results (2 of the block's 14 lines are reserved for pinned facts before the per-kind caps see the list), `N withheld; mem review to resolve contested/pending` when facts were held back, and `no match for this query -- showing recent facts instead` when a non-empty query matched nothing at all (no lexical, embedding, or usefulness signal), so the fact-lines it does carry are recency filler, not an answer. A response with nothing to follow up on has no footer; one with a filling review queue and no fact lines still does, since that shape is otherwise byte-identical to a project with no memory. When the store itself could not be opened, the footer instead says `store could not be read; mem doctor shows the underlying error` -- so that failure is not byte-identical to an empty store either. The same discipline covers the other two ways this call can come back empty without there being nothing to say: a retrieval time budget cutoff says `hint set empty; retrieval ran out of its time budget, not out of facts -- mem recall shows them`, and any other internal failure downstream of a successful store open says `hints unavailable; an internal error stopped retrieval -- mem doctor shows the store state`. Footer text is informational prose, deliberately outside the version-bump set. Token-goat surfaces `display` verbatim; trust caveat is embedded in the payload, not something the consumer reconstructs. Contested/low-trust facts excluded from `--hint-format` entirely. `TGMEM/1` (per-line CTA, no footer) is still fully supported by the programmatic seam via `protocolVersion: 1`.

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
  "don't...", "correction:", "that's wrong", or otherwise reaches a durable preference, decision, or
  correction, persist it yourself, right then:
  `mem remember "<short fact>" --kind preference|decision|fact|correction
  --scope project --root .`. Use --subject/--value for anything that can be
  contradicted later.
<!-- token-goat-mem:end -->
