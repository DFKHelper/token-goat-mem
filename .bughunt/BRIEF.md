# Shared reviewer brief — token-goat-mem bug hunt

You are a READ-ONLY adversarial bug hunter. You MUST NOT edit, create, or delete any file
in the repository. Report only.

## Repo
`C:\Projects\token-goat-mem` — a local-first CLI (`mem`) storing durable facts in SQLite for
AI coding agents. Node 18+, TypeScript, vitest, better-sqlite3. Short-lived CLI processes,
WAL mode, single-writer transactions. Read `AGENTS.md` and `CLAUDE.md` for the data model.

## token-goat gate (MANDATORY, applies to you and any sub-agent you brief)
**Before every file read, ask first — is there a token-goat command that returns just what I
need?** If yes, run it. A read tool invoked without answering the gate is a violation, not an
oversight. Per file: batched or parallel reads do not exempt it.
Failure shapes → replacement command:
- function body → `token-goat read "file::symbol"`
- symbol + callers + docs → `token-goat brief "file::symbol"`
- one heading of a doc → `token-goat section "file::Heading"`
- a symbol's callers → `token-goat refs file::symbol --callers`
- searching a *concept* not a literal → `token-goat semantic "description"`
- orienting in the repo → `token-goat map --compact`
- one value from JSON/YAML → `token-goat json-query file 'a.b.c'`
Exemptions: file under ~200 lines and needed whole; never indexed; opaque binary; no symbol handle.

## What counts as a finding
A finding is a **defect**, not a preference. It must name:
1. `file:line`
2. The invariant violated, or the contract (doc/comment/test) contradicted.
3. A **concrete failure scenario**: specific inputs or state -> specific wrong output, crash,
   data loss, or silent no-op. "Could be confusing" is not a finding.
4. Whether an existing test should have caught it, and why it did not.

Rank by severity: data loss > silent wrong answer > crash > wrong exit code > misleading output.

## What does NOT count
- Style, naming, formatting, missing comments.
- "Add a feature X" — this is a bug hunt, not a design review.
- Anything you cannot tie to a specific line.
- Speculation you did not check. If you could not verify, say "UNVERIFIED" explicitly.

## Especially wanted (this codebase has been bitten by these twice)
- **Tests that encode buggy behaviour as expected.** A green test asserting the wrong thing.
- **Unfalsifiable output**: a payload where "nothing to report" is byte-identical to
  "something was withheld/truncated".
- **Docs that promise something the code does not do**, or vice versa.
- **Dead/unreachable defensive branches** claimed as covered.
- Transaction boundaries: a read backing a write decision that sits outside `tx.immediate()`.
- Path handling: `..`, absolute paths, Windows case-insensitivity, symlinks.

## Output format
Numbered list, most severe first. For each: `SEVERITY | file:line | one-line claim` then 2-4
lines of evidence and the failure scenario. End with a count. If you find nothing real, say so
plainly — a padded list is worse than an empty one. Cap at 8 findings; quality over volume.
