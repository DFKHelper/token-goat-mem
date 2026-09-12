# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Commands

```bash
npm install                          # Install dependencies
npm run build                        # Build the shipping bundle (dist/token-goat-mem.mjs)
npm test                             # Run all tests (vitest run)
npx vitest run tests/storage.test.ts # Run a single test file
npm run lint                         # Lint (eslint src tests)
npm run typecheck                    # Type check (tsc --noEmit)
```

CI runs `npm run lint`, `npm run typecheck`, and `npm run test:coverage` on push and pull request (across ubuntu-latest and windows-latest with Node 20, plus Node 18 runtime floor check). The gate is the workflow status (`.github/workflows/ci.yml`).

## Architecture

Token-Goat Mem preserves durable conversational knowledge across AI coding sessions. It is a CLI tool (short-lived processes, no daemon) that stores facts in a local SQLite database with staleness detection via read-only filesystem/git anchors.

### Data flow

1. **Explicit capture** — user or agent says "remember that X". Fact is stored `active` after secret screening.
2. **Suggested capture** — `captureSuggested` (`src/capture.ts`, surfaced as `mem suggest`) stores candidates in `pending` status, always — no caller can request `active`. Pending facts never auto-promote; `mem review --promote <id>` / `--reject <id>` resolve them, and `mem pin` refuses a pending fact rather than promoting it by a side door.
3. **Staleness detection** — anchors are pure read-only predicates (file-newer-than, glob match, git-tracked) evaluated against an explicit `--root`. Three-valued verdict: `affirmed` (predicate confirms), `unverified` (can't confirm or deny), `contradicted` (predicate denies). Only `affirmed` surfaces as ground truth.
4. **Contradiction resolution** — deterministic `subject`+`value` keying. Two active facts, same subject + scope, different value = mark loser `superseded`, prefer newer + higher-provenance. If genuinely ambiguous, mark `contested` and withhold from ground-truth surfacing.
5. **Recall** — BM25 ranking for relevance (`src/embeddings.ts` adds a dense rank list fused by RRF when `TOKEN_GOAT_MEM_EMBED_URL` + `TOKEN_GOAT_MEM_EMBED_MODEL` point at an OpenAI-compatible endpoint; unset, retrieval is BM25-only), then correctness gate (freshness re-validation, trust filtering, contradiction/contested exclusion). Output annotated with kind, trust level, freshness verdict, and date.

### Storage

- **facts** table — the primary store. Columns: id, text, kind, subject, value, scope, scope_root, source_type, source_ref, captured_at, anchor, status, confidence, embedding.
- **sources** table — schema, storage API (`insertSource`/`listSourcesForFact`/`deleteSourcesOlderThan`), `mem show --json` surfacing, and gc pruning all exist and are tested. Fed from exactly two capture paths where the raw material is genuinely larger than the fact -- `mem scan-session` (excerpt = the whole user turn) and `mem import --from-md` (excerpt = `<path>:<line>: <raw bullet line>`) -- each writing its source row in the same transaction as the fact. `mem remember`/`mem suggest <text>` never write one: there the caller's text is the fact, so a source row would just echo it back. Excerpts are truncated to `MAX_SOURCE_EXCERPT_LENGTH` and secret-screened before storage (`capture.ts`'s `buildScreenedExcerpt`); a screened-positive excerpt is dropped and the fact is still captured. Never the full source content.
- SQLite WAL mode for durability. Short-lived CLI processes + transactional single-writer.

### Testing

Test setup via `tests/setup/` points to an isolated temp `TOKEN_GOAT_MEM_HOME` so tests never touch a real `~/.mem`. All end-to-end tests exercise the real DB and wiring, not mocks. A command with no E2E test coverage fails the gate by design.

### Tool wiring (`mem init` / `mem uninstall`)

`src/wiring.ts` installs/removes mem's integration block in a coding tool's own config (CLAUDE.md, AGENTS.md, `~/.claude/settings.json`, etc.) for a supported tool name. Install is atomic (temp file + rename) and takes a one-time `<file>.token-goat-mem.bak` snapshot of any pre-existing file before its first write; `*.token-goat-mem.bak` is gitignored in this repository only -- a target project has no reason of its own to ignore it, so `mem init --help` tells the user to add the pattern there. `mem uninstall` never takes a backup (there is nothing pre-existing to snapshot on the way out) and deletes a file whose entire content was mem's rather than leaving it empty; otherwise it reverses only what `mem init` wrote, via reference-counted markers, so it does not clobber unrelated edits to the same file.

### Token-goat integration

One-directional, pull-based, stateless. `token-goat` reads `mem epoch` (cache invalidation) and does not consume the `TGMEM/2` recall seam today; that seam is published for host tools, and the consumer that exists is mem itself -- `mem init claude-code` installs hooks running `mem recall --hint-format` on `SessionStart` and `UserPromptSubmit`. Returns self-caveating `display` strings the host surfaces verbatim. Fail-open if binary missing, timeout, or parse error. No shared state, no caching of results (live call = fresh freshness verdicts + instant forget/edit reflection).

### Reference

Shared agent conventions (commands, data model, integration seam) live in [AGENTS.md](AGENTS.md); this file adds only Claude-Code-specific guidance. For full design reasoning, adversarial review findings, and open questions, consult the memory-companion design plan (kept outside this repository).

<!-- token-goat-mem:claude-code:start -->
## Memory

This machine has token-goat-mem installed. Do not wait to be asked to run
`mem remember` — when I say things like "remember that...", "always...",
"from now on...", "never...", "don't...", or otherwise state a durable
preference, decision, or correction, persist it yourself, right then:
`mem remember "<short fact>" --kind preference|decision|fact|correction --scope project --root .`
Use --subject/--value for anything that can be contradicted later.
Add `--anchor "<predicate> <args>"` when a fact can be re-verified later instead
of staying caveated forever, e.g. `--anchor "file-exists pnpm-lock.yaml"`.
Predicates: file-exists, file-absent, file-newer-than, glob-exists, git-tracked,
newest-of. The anchor path must stay inside --root (no "..", no absolute path).
<!-- token-goat-mem:claude-code:end -->
