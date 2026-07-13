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

No CI workflow is wired yet. The gate is manual: `npm run lint`, `npm run typecheck`, and full `npm test` must all pass before pushing.

## Architecture

Token-Goat Mem preserves durable conversational knowledge across AI coding sessions. It is a CLI tool (short-lived processes, no daemon) that stores facts in a local SQLite database with staleness detection via read-only filesystem/git anchors.

### Data flow

1. **Explicit capture** — user or agent says "remember that X". Fact is stored `active` after secret screening.
2. **Suggested capture** — `captureSuggested` (library seam in `src/capture.ts`, not yet exposed as a CLI command) stores candidates in `pending` status, always — no caller can request `active`. Pending facts never auto-promote; `mem review --promote <id>` / `--reject <id>` resolve them.
3. **Staleness detection** — anchors are pure read-only predicates (file-newer-than, glob match, git-tracked) evaluated against an explicit `--root`. Three-valued verdict: `affirmed` (predicate confirms), `unverified` (can't confirm or deny), `contradicted` (predicate denies). Only `affirmed` surfaces as ground truth.
4. **Contradiction resolution** — deterministic `subject`+`value` keying. Two active facts, same subject + scope, different value = mark loser `superseded`, prefer newer + higher-provenance. If genuinely ambiguous, mark `contested` and withhold from ground-truth surfacing.
5. **Recall** — BM25 ranking for relevance (an embedding backend is an injectable seam in `src/retrieval.ts`, but no concrete backend ships in v1, so retrieval runs BM25-only in practice), then correctness gate (freshness re-validation, trust filtering, contradiction/contested exclusion). Output annotated with kind, trust level, freshness verdict, and date.

### Storage

- **facts** table — the primary store. Columns: id, text, kind, subject, value, scope, scope_root, source_type, source_ref, captured_at, anchor, status, confidence, embedding.
- **sources** table — redacted previews for audit/provenance; full content never persisted. GC'd after N days.
- SQLite WAL mode for durability. Short-lived CLI processes + transactional single-writer.

### Testing

Test setup via `tests/setup/` points to an isolated temp `TOKEN_GOAT_MEM_HOME` so tests never touch a real `~/.mem`. All end-to-end tests exercise the real DB and wiring, not mocks. A command with no E2E test coverage fails the gate by design.

### Tool wiring (`mem init` / `mem uninstall`)

`src/wiring.ts` installs/removes mem's integration block in a coding tool's own config (CLAUDE.md, AGENTS.md, `~/.claude/settings.json`, etc.) for a supported tool name. Writes are atomic (temp file + rename) and take a one-time `<file>.token-goat-mem.bak` snapshot before the first write; that backup pattern is gitignored. `mem uninstall` reverses only what `mem init` wrote, via reference-counted markers, so it does not clobber unrelated edits to the same file.

### Token-goat integration

One-directional, pull-based, stateless function call. `token-goat` optionally calls `mem recall --hint-format --root <project>` with a ~150 ms timeout. Returns self-caveating `display` strings that token-goat surfaces verbatim. Fail-open if binary missing, timeout, or parse error. No shared state, no caching of results (live call = fresh freshness verdicts + instant forget/edit reflection).

### Reference

Shared agent conventions (commands, data model, integration seam) live in [AGENTS.md](AGENTS.md); this file adds only Claude-Code-specific guidance. For full design reasoning, adversarial review findings, and open questions, consult the memory-companion design plan (kept outside this repository).
