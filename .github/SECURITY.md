# Security reporting

Untangle is preparing its first public release. Security fixes are developed on
`main`; `0.1.0` is a prerelease candidate. There are no promised maintenance
branches or response deadlines. Include the affected commit or installed package
version when reporting a problem.

## Report privately

When GitHub private vulnerability reporting is enabled, use
[Report a vulnerability](https://github.com/lboel/untangle/security/advisories/new)
on this repository's Security → Advisories page. The form is a private reporting
channel only when GitHub makes it available. This document does not enable it.

The initial public activation must enable and verify that channel before the
release is announced. If the form is unavailable, request a private contact from
the maintainer through an issue containing only that request. Do not include the
affected component, exploit, credentials or other sensitive details in a public
issue, discussion or pull request.

A useful private report includes:

- The commit/package version, operating system and Node version.
- The expected security boundary, observed behavior and potential impact.
- A small reproducible fixture and the commands needed to reproduce the problem.
- Redacted diagnostics and repository-relative paths where possible.

Do not send real tokens, private indexes, proprietary repositories or personal
data. Prefer a small synthetic example that preserves the relevant behavior.
Coordinate disclosure with the maintainer through the private report.

For ordinary defects without security-sensitive details, use the repository's
issue tracker. Maintainer activation steps are in the
[public repository release checklist](../docs/PUBLIC_REPOSITORY_RELEASE.md).
