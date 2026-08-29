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

`npm install` runs the `prepare` script, which points `core.hooksPath` at `.githooks/`. The fast gate
below then runs automatically on every commit. To skip it once, `git commit --no-verify`; to disable it
entirely, `git config --unset core.hooksPath`.

- **Before committing (fast):** `npm run lint && npm run typecheck && npm run test:guards`. The guards (`tests/guards/`) are pure-introspection invariants with no I/O — no bundle build, no SQLite DB. They catch the *implemented-but-unregistered / broken-schema* bug class before a commit lands.
- **Before pushing (full):** `npm test`. Tests set `TOKEN_GOAT_MEM_HOME` to a temp directory via `tests/setup/`, so they never touch your real `~/.mem`. Three tiers run here:
  - **`tests/*.test.ts` (root level)** — end-to-end against the CLI surface, driving the real `run()` entry point in-process against a real (isolated) SQLite database. This is where a new command's coverage belongs.
  - **`tests/unit/`** — direct imports of a single `src/` module, for behaviour that has no clean CLI expression (a ranking function, a scope predicate, a permission mode). Four modules have both tiers; put a test here only when it cannot be stated through a command.
  - **`tests/bundle/`** — spawns the built `dist/token-goat-mem.mjs` as a subprocess. Deliberately small: it guards the bundling layer itself (externals resolving at runtime, the esbuild `define`, native-module loading, exit codes, stdout vs stderr) and asserts on file *bytes* for the config files `mem init` edits. Every other tier loads transformed TS and cannot see any of that.

A command with no E2E coverage fails the gate by design. Add it to the root-level tier; add a `tests/bundle/` case as well when the command writes to a file the user owns, since only byte-level assertions against the real artifact catch formatting damage.

`npm run test:coverage` runs the same suite with v8 coverage over `src/` and enforces the floors in `vitest.config.ts`. CI runs this rather than a bare `npm test`, so a module losing its tests fails the build. The floors are ratchets set a couple of points under actual coverage — raise them when real coverage rises; do not lower one to make a build pass.

## Docs discipline

Every documented flag and example must match the real CLI. If you change a command's surface, re-run `node dist/token-goat-mem.mjs <command> --help` and update `README.md`, `AGENTS.md`, and `docs/integrations/` in the same change. The README walkthrough is verified against a scratch `TOKEN_GOAT_MEM_HOME`; keep it copy-paste-runnable.

## Known dev-dependency advisories

`npm audit` reports zero advisories. It stayed at five dev-only ones in the esbuild/vite/vitest chain for several releases, on the reasoning that none of those packages are runtime dependencies and none reach the shipped `dist/token-goat-mem.mjs` bundle; the toolchain upgrade that cleared them (esbuild 0.24 to 0.28, vitest 2 to 4) has since landed. Keep it at zero: an advisory that is genuinely not worth fixing belongs here with its reasoning, not left unmentioned.

Do not add, remove, or bump runtime dependencies (`dependencies` / `optionalDependencies`) as a side effect of unrelated work — the runtime surface is `better-sqlite3`, `commander`, and `jsonc-parser` -- the same three esbuild marks `external`, resolved from `node_modules` at runtime -- and it is kept deliberately small. `tests/guards/dependencies.test.ts` fails if a declared runtime dependency is imported nowhere in `src/`, which is how `zod` and `sqlite-vec` sat in the manifest unused through six releases.

## Release flow

1. Bump `version` in `package.json` and run `npm install` to update `package-lock.json`.
2. Fold `[Unreleased]` CHANGELOG entries into the new `[X.Y.Z] - YYYY-MM-DD` heading.
3. Run the full gate: `npm run lint && npm run typecheck && npm test && npm run build`.
4. Commit, push `master`, tag `vX.Y.Z`, and publish with `npm publish`.
5. Verify at `https://www.npmjs.com/package/token-goat-mem`.
