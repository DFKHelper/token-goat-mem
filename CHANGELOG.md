# Changelog

All notable changes to Token-Goat Mem are documented in this file. **This file is the canonical version history** — `package.json` mirrors the latest release; if a version string anywhere disagrees with this file, this file wins. Format follows Keep a Changelog. Token-Goat Mem follows Semantic Versioning starting at 1.0.

## [Unreleased]

### Added

- `mem recall --stable` — forces deterministic id-sorted output ordering (both plain `recall` and `--hint-format`), overriding the default relevance/recency order. Strictly additive: same facts, same caps, only the ordering changes.
- `HintFormatOptions.protocolVersion` on the programmatic token-goat seam (`buildHintFormat()`) — selects `TGMEM/1` or `TGMEM/2` explicitly. The CLI always emits the current default.

### Changed

- **TGMEM/2** is now the default `--hint-format` wire-format version. Per-fact `display` strings no longer carry a trailing `" — <follow-up command>"` CTA; instead, one shared `footer` line (`footer  mem show <id> for detail; mem review to resolve contested/pending`) is appended after the fact lines, when there is at least one. `TGMEM/1` (original per-line CTA, no footer) remains fully supported via `protocolVersion: 1`.

### Added

- `mem recall --hint-style <full|terse>` (default `full`) — `terse` drops the footer/CTA content and shortens kind labels to `pref`/`dec`/`fact`/`corr`. `full` is byte-identical to the pre-existing default format.
- `mem review --summary` — prints per-bucket fact counts (`pending`, `contested`, `contradicted`, `pins`) instead of the full listing.
- `mem review --section <pending|contested|contradicted|pins>` — restricts output to a single bucket.
- `mem review --since-epoch <n>` — only includes facts written after write-epoch `n`. Backed by a new `facts.epoch` column (idempotent migration in `ensureStorageSchema`; pre-migration rows default to `0`), stamped from the same monotonic epoch counter used by `mem epoch` on every insert/update/status change.

## [0.1.0] - 2026-07-12

Initial build: a local-first, correctness-focused long-term memory CLI for AI coding agents (Claude Code, Copilot CLI, Copilot in VS Code, Codex).

### Added

- **Nine CLI commands** (`mem`, bundled to `dist/token-goat-mem.mjs`): `remember`, `recall`, `list`, `show`, `forget` (soft delete, kept for audit), `pin`, `edit`, `review` (with `--promote`/`--reject` for pending facts), and `epoch` (with `--gc` retention pass: persists contradiction resolutions, prunes superseded facts/sources/audit rows, applies preference decay).
- **SQLite storage** at `~/.mem/mem.db` (override via `TOKEN_GOAT_MEM_HOME`), WAL mode, three tables (`facts`, `sources`, `audit_log` + `meta`), monotonic write epoch, zero network calls.
- **Anchor-based staleness detection** — pure read-only filesystem/git predicates (`file-exists`, `file-absent`, `file-newer-than`, `file-contains`, `file-not-contains`, `glob-exists`, `git-branch-is`, `git-tracked`) evaluated per recall with three-valued verdicts: `affirmed` / `unverified` / `contradicted`. Only `affirmed` is ground-truth eligible; contradicted facts are excluded from recall and routed to `mem review`. No shell-out, bounded I/O, paths confined to `--root`.
- **Deterministic contradiction resolution** — `subject`+`value` keying; same subject + scope with a different value marks the loser `superseded` (newer + higher-provenance wins), or `contested` and withheld from ground truth when genuinely ambiguous.
- **Secret screening on capture** — named secret patterns plus a generic high-entropy screen; refused facts name a `.mem/allowlist` escape hatch. Suggested (derived) capture exists as a library seam that can only ever store `pending` facts.
- **BM25 recall with a correctness gate** — relevance ranking, then freshness re-validation, trust filtering, and contradiction/contested exclusion. An embedding backend is an injectable seam; no concrete backend ships in v1 (BM25-only in practice).
- **Token-goat seam** — `mem recall --hint-format --root <project-root>` emits the `TGMEM/1` wire format with self-caveating display strings; one-directional, stateless, fail-open.
- **Test suite** — 190 vitest tests including fast I/O-free structural guards (`npm run test:guards`) and end-to-end tests against the shipped bundle, isolated from real user data via `TOKEN_GOAT_MEM_HOME`.
- **Docs** — README with a verified copy-paste walkthrough, integration guides for Claude Code / Copilot CLI / Copilot in VS Code / Codex, `AGENTS.md` + `CLAUDE.md`, `SECURITY.md`.
