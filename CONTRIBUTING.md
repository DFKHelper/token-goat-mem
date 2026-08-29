# Contributing

Dev environment notes specific to this repo. Shared conventions for agents and contributors live in [`AGENTS.md`](AGENTS.md); this file collects the rough edges around the local toolchain.

## Setup

```bash
npm install
npm test                     # full test suite (vitest run)
npm run test:guards          # fast I/O-free structural guards (~2s)
npm run typecheck            # type check (tsc --noEmit)
npm run lint                 # ESLint
npm run build                # bundle to dist/token-goat-mem.mjs
npm run dev                  # run the CLI from source (tsx src/main.ts)
```

## Line endings

`.gitattributes` pins every tracked text file to LF in the working tree, so a clone made with
`core.autocrlf=true` -- what the Windows git installer offers by default -- checks out the same bytes
as everywhere else. Repo files are read back and parsed in a few places (the doc-vs-code test in
`tests/wiring.test.ts` is one), and a CRLF checkout used to break them in a way invisible on an
LF machine.

If you cloned before this landed and your working tree is CRLF, git will report every file as
modified until you renormalize once:

```bash
git add --renormalize .
```

None of this applies to the files mem *edits*. A user's own `CLAUDE.md`, `AGENTS.md`, or
`settings.json` is frequently CRLF; `src/wiring.ts` detects each file's existing ending and writes
back in it, and the "config files authored with CRLF stay CRLF" tests hold it to that. Never hardcode
`\n` when writing into a file mem did not create.

## Test tiers

No hook manager is wired yet, so the gate is manual:

- **Before committing (fast):** `npm run lint && npm run typecheck && npm run test:guards`. The guards (`tests/guards/`) are pure-introspection invariants with no I/O — no bundle build, no SQLite DB. They catch the *implemented-but-unregistered / broken-schema* bug class before a commit lands.
- **Before pushing (full):** `npm test`, which includes end-to-end tests that build and exercise the shipped `dist/token-goat-mem.mjs` bundle against a real (isolated) SQLite database. Tests set `TOKEN_GOAT_MEM_HOME` to a temp directory via `tests/setup/`, so they never touch your real `~/.mem`.

A command with no E2E coverage fails the gate by design — if you add a CLI command, add a test that drives the built bundle.

## Docs discipline

Every documented flag and example must match the real CLI. If you change a command's surface, re-run `node dist/token-goat-mem.mjs <command> --help` and update `README.md`, `AGENTS.md`, and `docs/integrations/` in the same change. The README walkthrough is verified against a scratch `TOKEN_GOAT_MEM_HOME`; keep it copy-paste-runnable.

## Known dev-dependency advisories

`npm audit` reports zero advisories. It stayed at five dev-only ones in the esbuild/vite/vitest chain for several releases, on the reasoning that none of those packages are runtime dependencies and none reach the shipped `dist/token-goat-mem.mjs` bundle; the toolchain upgrade that cleared them (esbuild 0.24 to 0.28, vitest 2 to 4) has since landed. Keep it at zero: an advisory that is genuinely not worth fixing belongs here with its reasoning, not left unmentioned.

Do not add, remove, or bump runtime dependencies (`dependencies` / `optionalDependencies`) as a side effect of unrelated work — the runtime surface is `better-sqlite3`, `commander`, `zod`, and optional `sqlite-vec`, and it is kept deliberately small.

## Release flow

1. Bump `version` in `package.json` and run `npm install` to update `package-lock.json`.
2. Fold `[Unreleased]` CHANGELOG entries into the new `[X.Y.Z] - YYYY-MM-DD` heading.
3. Run the full gate: `npm run lint && npm run typecheck && npm test && npm run build`.
4. Commit, push `master`, tag `vX.Y.Z`, and publish with `npm publish`.
5. Verify at `https://www.npmjs.com/package/token-goat-mem`.
