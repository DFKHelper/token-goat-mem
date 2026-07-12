# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Commands

```bash
npm install                          # Install dependencies
npm run build                        # Build the shipping bundle (dist/token-goat-mem.mjs)
npm test                             # Run all tests (vitest run)
npx vitest run tests/db.test.ts      # Run a single test file
npm run lint                         # Lint (eslint src tests)
npm run typecheck                    # Type check (tsc --noEmit)
```

CI runs on `ubuntu-latest` with Node 22, as two gating jobs: `lint` (lint + typecheck) and `test` (full `npm test`). Both must pass.

## Architecture

Token-Goat Mem preserves durable conversational knowledge across AI coding sessions. It is a CLI tool (short-lived processes, no daemon) that stores facts in a local SQLite database with staleness detection via read-only filesystem/git anchors.

### Data flow

1. **Explicit capture** — user or agent says "remember that X". Fact is stored `active` after secret screening.
2. **Suggested capture** — conservative extractor proposes candidates in `pending` status. Pending facts never auto-promote; only explicit confirmation or consistent use-without-correction moves them to `active`.
3. **Staleness detection** — anchors are pure read-only predicates (file-newer-than, glob match, git-tracked) evaluated against an explicit `--root`. Three-valued verdict: `affirmed` (predicate confirms), `unverified` (can't confirm or deny), `contradicted` (predicate denies). Only `affirmed` surfaces as ground truth.
4. **Contradiction resolution** — deterministic `subject`+`value` keying. Two active facts, same subject + scope, different value = mark loser `superseded`, prefer newer + higher-provenance. If genuinely ambiguous, mark `contested` and withhold from ground-truth surfacing.
5. **Recall** — hybrid BM25 + embedding rank fusion for relevance, then correctness gate (freshness re-validation, trust filtering, contradiction/contested exclusion). Output annotated with kind, trust level, freshness verdict, and date.

### Storage

- **facts** table — the primary store. Columns: id, text, kind, subject, value, scope, source_type, source_ref, captured_at, anchor, status, confidence, embedding.
- **sources** table — redacted previews for audit/provenance; full content never persisted. GC'd after N days.
- SQLite WAL mode for durability. Short-lived CLI processes + transactional single-writer.

### Testing

Test setup via `tests/setup/` points to an isolated temp `TOKEN_GOAT_MEM_HOME` so tests never touch a real `~/.mem`. All end-to-end tests exercise the real DB and wiring, not mocks. A command with no E2E test coverage fails the gate by design.

### Token-goat integration

One-directional, pull-based, stateless function call. `token-goat` optionally calls `mem recall --hint-format --root <project>` with a ~150 ms timeout. Returns self-caveating `display` strings that token-goat surfaces verbatim. Fail-open if binary missing, timeout, or parse error. No shared state, no caching of results (live call = fresh freshness verdicts + instant forget/edit reflection).

### Reference

For full design reasoning, adversarial review findings, and open questions, read the design plan at the project root.
