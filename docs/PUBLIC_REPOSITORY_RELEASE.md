# Prepare public repository access

The initial public distribution is **source only**. Repository access, GitHub Pages and
npm package publication are separate actions. No npm publication or release tag is part
of this source release; package publication follows [RELEASE.md](./RELEASE.md).

## Clean public history

The 5 November 2026 migration starts the public Git history with a new root snapshot.
The earlier development repository is retained privately with its original history,
Actions output and private verification records. It is not force-pushed or deleted.
No earlier commits or refs are imported; only the tracked source snapshot is copied.
Old Actions logs, artifacts, secrets and settings stay in the private repository.
Existing notices, contribution terms and upstream license attribution remain in the
source snapshot.

The website's frozen example still identifies its original measurement and renderer
revisions. Those revisions belong to the private development history and are not
reachable commits in the new public repository. Their content hashes and public
projection remain unchanged. They are historical provenance, not a claim of a fresh
public-checkout measurement or publicly accessible old Git objects. The current source
can produce a new local graph; updating the frozen example requires its own new evidence.

The new snapshot receives its own exact-commit CI and release-candidate matrix checks
before the public switch. The remaining sections describe activation and future rechecks;
they do not claim settings are applied merely because this document exists. The private
migration receipt records the actual repository IDs, names, settings, run IDs and hashes.

## Record the exact candidate

Keep a private release record with the intended full commit, source/Dist hashes,
toolchain, scan inventories, CI run IDs, original artifact hashes and owner
decisions. Refresh it after every source change and immediately before activation.
An earlier passing candidate never certifies a later commit.

Read-only preflight commands:

```bash
git status --short
git rev-parse HEAD
git show-ref --head
git ls-remote origin
gh repo view lboel/untangle --json url,isPrivate,defaultBranchRef
gh api repos/lboel/untangle/branches/main/protection
gh api repos/lboel/untangle/rulesets
gh api repos/lboel/untangle/environments
gh api repos/lboel/untangle/private-vulnerability-reporting
gh api --paginate 'repos/lboel/untangle/actions/runs?per_page=100'
gh api --paginate 'repos/lboel/untangle/actions/artifacts?per_page=100'
```

A missing/forbidden API response is a finding to resolve, not a passed setting
check. Confirm permissions before interpreting a `404` as an absent setting.

The 5 November 2026 preflight observed a private repository, unprotected `main`,
no rulesets, and only the `github-pages` environment. Private vulnerability
reporting was unavailable or unverified; `npm-release` was absent. These are dated
observations, not a claim that the settings remain unchanged or are ready.

## Review everything that will be exposed

- Inventory intended branches, tags, advertised remote refs and commits referenced
  by pull requests or Actions. Compare them with the locally scanned history;
  record missing coverage rather than assuming that local refs are complete.
- Scan reachable history and a hash-bound snapshot of tracked and nonignored
  untracked sources. Preserve scanner version/rules, exit codes and redacted
  reports. Review commit identities and private content as well as credentials.
- Inventory all available Actions logs and artifacts. Inspect their contents,
  including nested archives, with file hashes and explicit scan coverage. Record
  expired, unavailable, unsupported or size-limited material separately. A clean
  Git scan does not clear Actions output.
- Keep `.untangle/` indexes, credentials, local sessions, external project sources
  and private evidence outside public refs and published packages. Check actual
  tracked files and archives; ignore patterns alone prove nothing.
- If a credential is confirmed, stop activation and have its owner revoke or
  rotate it. History rewriting, artifact/run deletion and force-pushing require
  separate authorization. Do not silently remove evidence to obtain a clean scan.

GitHub states that private → public makes code and Actions history/logs publicly
accessible, allows public forks, disables push rulesets and publishes repository
activity. Private forks are detached; stars/watchers may be lost. Review the
[complete visibility consequences](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)
before approving the change. Making a repository private again cannot recall
copies already obtained by others.

## Close owner decisions and technical gates

- Preserve the confirmed attribution to Luke Bölling and contributors, the
  AGPL-3.0-only license and PR contribution terms in [NOTICE](../NOTICE).
  Contributors retain their rights; no separate CLA or DCO gate is required.
  Trademark checks, npm-scope rights and concrete network-deployment source
  availability remain separate owner decisions. This checklist does not clear them.
- Review README, package metadata, license/third-party notices and public assets.
  Keep prerelease, coverage and installation limitations accurate. Do not advertise
  public npm installation before the actual registry installation has passed.
- Require regular Node 22/24 CI and all four Linux/macOS × Node 22/24 release
  cells at the exact candidate. Verify their original archives with the existing
  compatibility verifier; preserve failed attempts. Run configured live-search
  acceptance separately and mark missing infrastructure `unverified`.
- Approve and apply the intended `main` protection policy. A proposed minimum is
  required `build (node 22.x)` and `build (node 24.x)` checks, with force-push and
  branch deletion disabled. The owner must choose PR/review requirements and
  administrator bypass behavior. Recheck protections after visibility changes;
  this proposal has not configured them.
- Prepare the private reporting channel described in
  [the reporting policy](../.github/SECURITY.md). Verify it after activation and
  before announcing public availability.
- For a later npm release, separately configure the protected `npm-release`
  environment with human reviewers and the package publishing permissions required
  by [the publish workflow](../.github/workflows/publish.yml). Repository visibility
  grants neither npm name rights nor publishing authorization.

## Prepared activation command — not executed

Only after the owner approves the exact repository, candidate and exposure record:

```bash
gh repo edit lboel/untangle --visibility public --accept-visibility-change-consequences
```

The acceptance flag is required by the
[GitHub CLI](https://cli.github.com/manual/gh_repo_edit). Preparing this command is
not approval to execute it.

After the authorized visibility change, an administrator can enable private
vulnerability reporting and read back the actual result:

```bash
gh api --method PUT repos/lboel/untangle/private-vulnerability-reporting
gh api repos/lboel/untangle/private-vulnerability-reporting
```

Expect successful enablement and `enabled: true`; also verify that the intended
reporter can reach the private form. Do not infer success from the existence of
this policy file. See GitHub's
[reporting setup](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)
and [repository REST endpoints](https://docs.github.com/en/rest/repos/repos#enable-private-vulnerability-reporting-for-a-repository).

Finally verify repository access without an authenticated maintainer session,
the intended branch/tag inventory, protections and security settings, community
policy links, Pages assets and installation instructions. Record actual results
before announcing the repository. No npm publication or signed release tag is
created by this visibility procedure.
