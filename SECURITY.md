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

## Known advisories

`npm audit` currently reports advisories in dev-only transitive dependencies (the esbuild/vite/vitest toolchain). These affect the local dev server only; none of the packages are runtime dependencies or present in the shipped `dist/token-goat-mem.mjs` bundle. Details and status are tracked in [CONTRIBUTING.md](CONTRIBUTING.md#known-dev-dependency-advisories).

## License

Token-Goat Mem is source-available under the PolyForm Noncommercial License 1.0.0. Submitting a security report does not grant the reporter any license to Mem's code beyond what PolyForm Noncommercial already permits. See LICENSE for the full terms.
