# Security Policy

Token-Goat Mem runs on your machine, stores memory in a local SQLite database, and evaluates filesystem/git predicates as staleness anchors. The attack surface is real and the project treats security reports as a priority.

## Reporting a vulnerability

Email token-goat@dfkhelper.com. This is a private inbox, not a public issue tracker. Do not file security reports as GitHub issues; that exposes the finding before a fix ships. PGP key available on request.

A useful report contains:

- Affected Token-Goat Mem version (`mem --version`)
- Operating system and Node.js version
- Reproduction steps, ideally a minimal command sequence
- Observed impact and a short severity assessment
- Suggested fix, if known

## What to expect

Reports are acknowledged within 7 calendar days of receipt. If you have not heard back in that window, resend; mail does get lost. After triage, a target fix window is set based on severity and communicated back. Coordinated disclosure is preferred, with a typical 90-day window before public details. Reporters who want public credit are credited in the changelog and the release notes. Reporters who prefer to stay anonymous are kept anonymous.

## In scope

The following are treated as security issues:

- Remote code execution via CLI arguments, fact text, or anchor evaluation
- Local privilege escalation through Mem's installation or DB access
- Data exfiltration through Mem's database, cache, or audit log
- Injection vulnerabilities in fact capture, anchor evaluation, or CLI parsing
- Secret/credential leakage via fact storage, embeddings, or audit log
- Supply-chain concerns affecting the published `token-goat-mem` package
- Path traversal or symlink attacks on DB/anchor evaluation

## Out of scope

The following are not treated as security issues unless paired with a working proof of concept showing actual impact:

- Theoretical vulnerabilities without a reproducer
- Issues in upstream dependencies that do not manifest through Mem's surface
- Local denial of service via resource exhaustion (memory, disk, CPU) on the user's own machine
- Social-engineering attacks that require tricking the user into running malicious commands
- Issues that require an already-compromised local user account
- Anchor false negatives (a stale fact is not detected as stale) without an attack vector

## What secret screening does and does not catch

Every fact is screened before it is stored, and the check is deliberately a floor rather than a guarantee. Stating the boundary explicitly, because "refuses to store secrets" reads as broader than it is:

Screening fires on three things: a named credential format (AWS access key ids, GitHub/Slack/Google/Stripe/Anthropic/OpenAI-style keys, PEM private-key blocks, JWTs); a credential word followed by a `:` or `=` separator and a value, or followed within ~32 characters by a run of 32+ hex characters; and, as a generic fallback, any standalone high-entropy token of 32 characters or more, excluding pure-hex and pure-digit runs so that quoting a commit SHA is not treated as a credential.

The consequence worth knowing: **a short secret stated in prose is stored verbatim.** `password = Xk9mP2vL8nQ4wR` is refused, because the separator makes it an assignment. `the staging password is Xk9mP2vL8nQ4wR` is stored, because there is no separator, the value is not hex, and 14 characters is under the entropy floor. Raising that floor is not free -- it is what keeps ordinary project facts (file paths, identifiers, version strings, prose containing a credential word) from being refused -- so the boundary is an accepted design position, not an open defect. Report a bypass of a pattern that *should* have matched; a short prose secret is the documented limit.

Two things follow from this. Screening is a backstop against accidental paste, not a control you can rely on to sanitize untrusted input: do not point capture at a source you would not read yourself. And because the database is a plain local SQLite file, treat `~/.mem/mem.db` with the same care as any file that has passed through your shell history.

## Known advisories

`npm audit` reports no advisories, across both runtime and dev dependencies. The five dev-only advisories that previously affected the esbuild/vite/vitest toolchain were cleared in 0.2.2; history and the reasoning behind the upgrade are in [CONTRIBUTING.md](CONTRIBUTING.md#known-dev-dependency-advisories).

## License

Token-Goat Mem is source-available under the PolyForm Noncommercial License 1.0.0. Submitting a security report does not grant the reporter any license to Mem's code beyond what PolyForm Noncommercial already permits. See LICENSE for the full terms.
