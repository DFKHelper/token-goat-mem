# Architecture

`token-goat-mem` (the `mem` CLI) is a local-first, SQLite-backed store of discrete facts --
preferences, decisions, project facts, corrections -- that AI coding agents write to and read from
across sessions. This document is a map of the source tree plus the load-bearing shape decisions
that aren't obvious from any single file.

## Two entry points, one ranking function

There are two live recall paths, and both converge on the same ranking function, `retrieve()` in
`src/retrieval.ts`. Plain `mem recall` reaches it through `src/cli.ts`. The TGMEM/2 wire-format path
reaches it through `buildHintFormatUnsafe` in `src/integration-seam.ts`, which is what the
`SessionStart` and `UserPromptSubmit` hooks installed by `mem init claude-code` invoke on every
prompt. Neither path re-implements ranking, trust classification, or contradiction resolution --
`retrieve()` is the single place all of that happens.

Both paths load the **entire** `facts` table with no `WHERE` clause and filter and rank in JS. That
is a documented, deliberate tradeoff, not an oversight: `retrieve()` resolves contradictions across
its whole input pool before any filter runs, and a pre-filtered pool is a partial one -- narrowing in
SQL surfaced a genuinely contested fact as clean ground truth, because the other side of the
contradiction had already been filtered out before resolution ever saw it.

## Ranking

Ranking is hybrid: BM25 over Porter-stemmed, stopword-filtered text, fused by reciprocal rank fusion
(RRF) with rank lists from embeddings, entity overlap, and usefulness feedback. A BM25 list whose
every score is zero is deliberately excluded from fusion -- it is a ranking, but not a signal, and
letting an all-zero list into RRF allowed recency to outvote a real embedding match.

Structured facet extraction (`src/facets.ts`) exists because BM25's tokenizer destroys exactly the
tokens a query is most likely to be about: identifiers, paths, and version strings collapse into
unrelated stems or fragments once lowercased, split, and Porter-stemmed. Facets preserve those tokens
verbatim. The path into ranking is indirect, and deliberately so: `src/storage.ts` extracts a fact's
facets at write time into the `fact_terms` table, then extracts a *query's* facets at read time to
join against it, handing `retrieve()` a finished entity-overlap map. `src/retrieval.ts` never imports
`facets.ts` -- the dependency runs one way only (facets -> retrieval, for the shared tokenizer), which
is what keeps the ranking module free of any knowledge of storage or facet extraction.

## Trust, decay, anchors

Trust (`ground-truth`, `hint`, or `withheld`) is computed per query and never stored. Anchors --
read-only predicates attached to a `Fact` -- are re-evaluated on every recall under a time budget; a
budget-exhausted check reads as `unverified`, which classifies as `hint` rather than being suppressed
outright, so a slow filesystem never silently drops a fact from view.

Facts of kind `preference` decay on a 180-day half-life computed fresh from `captured_at` on every
read and never persisted back to storage. Decay can demote a fact from `ground-truth` to `hint`, and
never further than that -- decay alone cannot withhold a fact.

## Storage

Storage is SQLite via `better-sqlite3`. `src/db.ts` owns the `facts`, `audit_log`, and `meta` tables,
and with them the whole-database `PRAGMA user_version` counter: `openDb` runs `src/migrations.ts` on
every connection open. `src/storage.ts` owns `sources`, `recall_log`, and `fact_terms` but carries no
schema logic of its own -- every table and column any module needs is one ordered step in the single
migration list.

Each step is individually idempotent, guarded by a `PRAGMA table_info` column check rather than by
catching SQLite's "duplicate column" error text, because a store written by an older build arrives
with every column already present and `user_version` still at 0. Replaying the baseline against it
has to be a silent no-op, so a fresh database and a years-old one converge on the same shape the
first time a newer build opens either.

## Integration seam

`src/integration-seam.ts` publishes TGMEM/2, a line-oriented wire format with a versioned header, one
line per fact, and an optional trailing footer line. This module never imports or reads token-goat's
own state -- it is a one-directional, pull-based, pure-CLI contract: it shapes CLI output for a
caller like token-goat to consume via `mem recall --hint-format`. Line shape, field order, separator,
and the closed tag/verdict sets are version-committed; the footer's prose is explicitly not, so it can
change without bumping the wire version.

## Keeping this map current

The table below the marker comment is **generated**, not hand-maintained. `scripts/sync-arch-docs.mjs`
discovers every module in `src/` via `git ls-files`, classifies it into a layer from
`.arch-doc-sync.json`, and extracts a Role (from the module's own doc-comment) and its key exports.

- `npm run arch:write` regenerates the table in place.
- `npm run arch:check` is read-only and fails (exit 1) on any drift -- a new or removed module, a
  changed export list, or a module that matches no declared layer. It runs as part of the guards tier
  (`tests/guards/arch-docs.test.ts`), which the pre-commit hook and CI both enforce.
- A Role you edit by hand is preserved as curated: as long as it differs from what fresh extraction
  would produce for that path, `--write` never overwrites it, and a rename or split is followed via
  git history so a curated Role survives a `git mv` too.

<!-- ARCH_COMPONENTS_START -->

| Module | Layer | Role | Key exports |
| --- | --- | --- | --- |
| `src/cli.ts` | Entry | Commander-based CLI wiring for `mem` (design plan Sections 3/4/5/6, AGENTS.md's command list) | EXIT_SUCCESS, EXIT_USER_ERROR, EXIT_INTERNAL_ERROR, UsageError, buildProgram |
| `src/index.ts` | Entry | Library entry point | — |
| `src/main.ts` | Entry | Package executable | — |
| `src/anchors.ts` | Retrieval | Anchor evaluation (design plan P3, Section 3, review S1/S4) | AnchorVerdict, AnchorCacheStore, clearAnchorCaches, _clearAnchorMemoForTests, isGenuineAbsence |
| `src/contradiction.ts` | Retrieval | Deterministic subject+value contradiction detection (design plan P4, Section 6, review S5/S8) | ContradictionGroup, FactStatusUpdate, ContradictionDetectionResult, computeProjectIdentityGroups, computeContradictionBucketGroups |
| `src/embeddings.ts` | Retrieval | A concrete `EmbeddingBackend` (retrieval.ts) speaking the OpenAI `/v1/embeddings` wire shape, plus the config plumbing t | EMBED_URL_ENV, EMBED_MODEL_ENV, EMBED_API_KEY_ENV, DEFAULT_EMBED_REQUEST_TIMEOUT_MS, EmbeddingConfig |
| `src/facets.ts` | Retrieval | Structured facet extraction: the tokens BM25's tokenizer destroys, preserved verbatim | FactFacets, MAX_ENTITIES_PER_FACT, MAX_TOPICS_PER_FACT, normalizeTermKey, extractFacets |
| `src/factgraph.ts` | Retrieval | The co-occurrence fact graph and score propagation over it (design plan Section 3 extension, "Retrieval" layer) | FactGraphOptions, PropagateOptions, neighbours, propagate, getGraphScoresForQuery |
| `src/retrieval.ts` | Retrieval | Hybrid retrieval (design plan Section 3 "Retrieval", P8, review S10) | EmbeddingBackend, EmbeddingBackendLoader, TrustLevel, ContradictionOutcome, RetrievalOptions |
| `src/capture.ts` | Capture | The two-mode capture pipeline (design plan Section 3, principles P1/P7, review findings S7/S9) | MAX_SOURCE_EXCERPT_LENGTH, CaptureValidationError, InvalidAnchorError, SecretMatchSummary, SecretDetectedError |
| `src/consolidate.ts` | Capture | Near-duplicate clustering and stale-fact detection -- the two halves of `mem consolidate` | DEFAULT_DUPLICATE_THRESHOLD, DEFAULT_STALE_AGE_DAYS, DuplicateMember, DuplicateCluster, jaccard |
| `src/dream.ts` | Capture | Cross-fact inference ("dreaming"): propose facts that follow from several stored facts but that nobody stated outright | DREAM_URL_ENV, DREAM_MODEL_ENV, DREAM_API_KEY_ENV, MAX_DREAM_FACTS, DreamConfig |
| `src/exportImport.ts` | Capture | `mem import --from-json <path>` -- the full-fidelity counterpart to `mem import --from-md` (src/import.ts) | JSON_EXPORT_SCHEMA_VERSION, MAX_IMPORT_FILE_SIZE_BYTES, JsonImportError, planImportFromJson, ImportFromJsonOptions |
| `src/import.ts` | Capture | `mem import --from-md <path>` -- the mem-side half of the "advisory CLAUDE.md->mem migration probe" (the other half, `to | MarkdownImportError, MarkdownBullet, extractMarkdownBullets, ImportFromMarkdownOptions, ImportCandidate |
| `src/sessionScan.ts` | Capture | Deterministic extraction of durable-preference candidates from a session transcript | MAX_SCANNED_TURNS, MAX_CANDIDATE_LENGTH, Candidate, userTurnText, extractCandidates |
| `src/db.ts` | Storage | SQLite connection and schema for the `facts` table (design plan Section 3), plus two small infra tables every write path | resolveMemHome, resolveDbPath, openDb, SUPERSEDED_BY_FACT_PREFIX, SUPERSEDED_AS_DUPLICATE_PREFIX |
| `src/migrations.ts` | Storage | Ordered schema migrations for the mem database, keyed on SQLite's own `PRAGMA user_version` | MigrationStep, MigrationResult, hasColumn, addColumn, MIGRATIONS |
| `src/storage.ts` | Storage | Storage layer: schema and typed CRUD for the `sources` table plus a write epoch, and typed CRUD for the `facts` table (d | ensureStorageSchema, openStorage, createAnchorCacheStore, clearAnchorCacheStore, BufferedAnchorVerdict |
| `src/hook-envelope.ts` | Integration | Parsing for the JSON envelope a coding tool's hook hands `mem recall --hook-stdin` on stdin | HOOK_PROMPT_KEYS, HOOK_SESSION_KEY, HOOK_TRANSCRIPT_KEY, HookEnvelope, parseHookEnvelope |
| `src/integration-seam.ts` | Integration | The token-goat integration seam (design plan Section 4) | TGMEM_PROTOCOL_VERSION, TGMEM_HEADER, FOLLOW_UP_SHOW_DETAIL, FOLLOW_UP_REVIEW, TGMEM_FOOTER_LINE |
| `src/wiring.ts` | Integration | Automates what docs/integrations/*.md currently ask a human to hand-copy: `install()` writes exactly the config snippets | WiringOpts, WiringFileAction, WiringChange, WiringResult, WiringPlanEntry |
| `src/factText.ts` | Support | The normalized-text key `storage.ts` and `migrations.ts` both need for fact deduplication | normalizeFactText, hashFactText |
| `src/fileUtils.ts` | Support | Shared filesystem error handling for imports | readFileWithErrorMapping, statFileWithErrorMapping |
| `src/pathUtils.ts` | Support | Case-folds a path for comparison on filesystems that ignore case | normalizePath |
| `src/projectIdentity.ts` | Support | Repository-relative identity for a project root, so a project-scoped fact survives the path it was captured at | PROJECT_IDENTITY_ENV, clearProjectIdentityCache, normalizeRemoteUrl, resolveProjectIdentity, identityMatches |
| `src/types.ts` | Support | Shared domain types for token-goat-mem | FACT_KINDS, FactKind, FACT_SCOPES, FactScope, FactSourceType |

<!-- ARCH_COMPONENTS_END -->
