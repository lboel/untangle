# Release guide

Use the version in the root `package.json` and publish preview releases to **`next`**.
Verify the exact source commit and all package artifacts before publication.

## Publication status and evidence scope

Untangle `0.1.0` was the first npm release. For a new version, publication and an
installation from the public registry are separate checks. Use the
[npm package page](https://www.npmjs.com/package/@untangle-code/cli) for current availability.

The public history starts from a new root snapshot on 5 November 2026. The earlier
repository and its Actions history remain private. See the
[source-history and publication record](./PUBLIC_REPOSITORY_RELEASE.md).

CI and the Linux/macOS × Node 22/24 release-candidate matrix must pass for the release
commit. Evidence from previous commits does not certify that commit.
Keep exact-commit original artifacts and acceptance records; refresh them after changes.
The frozen website example identifies its historical measurement and renderer revisions;
it is not a fresh measurement of the public checkout or evidence that its tests ran.

For each package release, verify current npm authentication and rights to `@untangle-code`
and every package name. Earlier anonymous `E404` responses establish no name rights.
No verification workflow changes publishing rights or account protections.

## Inspect sources and history before sharing

Scan the actual workspace, intended public refs and their reachable history for credentials
and private content before pushing a candidate. Archive scanner version/rules, ref/commit
inventory, exits and redacted results. Distinguish test dummies from actual credentials using
source context. No-findings output is not proof of complete secrecy. Report reflogs,
unreachable objects and local snapshot refs separately; they are not automatically part of
an ordinary branch push.

If real credentials are confirmed, have their owner revoke/rotate them first. History
rewriting needs separate explicit authorization. Never silently force-push or publish before
review completes. Indexes, private extension credentials and local agent sessions belong in
neither public history nor npm tarballs.

Local `.untangle/`, `.helix/sessions/` and `.claude/scheduled_tasks.lock` stay excluded.
Do not change product-source selection or improve a complexity number through these
exclusions. Preserve original files and others' open work.

## Acceptance against an existing external project

The recorded 21 October walkthrough used an existing TypeScript/Vue/Python/Rust project.
Its checkout entry produced AST evidence without search services. When parallel development
began, further checks moved to a copy of the initially clean commit, with all 467 original
sources checked byte-for-byte. Workspace imports pointed to that copy; original concurrent
work was preserved.

The walkthrough linked two explicitly proposed engine-feature boundaries to real documents,
technical roles and tests. Shared helpers counted fully in each feature and once in the
union. Budget violations and unconfirmed ownership remained findings despite passing tests.
It proved neither complete feature mapping nor productivity gains.

Required contracts from that exercise:

- Root metadata/index/cache files do not change the feature source digest or valid test
  evidence when product sources are unchanged; actual code changes remain detectable.
- Duplicate full Vitest names invalidate evidence and identify file/name. Unique selected
  tests can be captured independently with source binding.
- Relative manifest/evidence paths resolve to the same physical project under a root alias;
  outside-file and symlink checks remain enforced.

Private sources and detailed local cases are excluded from public release artifacts. Their
ignored local evidence supplements small E2E projects, not the remote matrix.

## Verify first value without search services

```bash
pnpm setup:local --project=/absolute/path/to/test-project
```

With supported Node and pnpm 10.34.5, the helper checks versions, installs frozen dependencies,
builds the checkout and analyzes the target directly. Without `--project`, it analyzes
Untangle. Outputs include coverage, hotspots, omissions, next commands and an MCP template
with actual absolute Node/CLI/project paths. No index, Qdrant, Ollama, LLM or feature manifest
is needed.

```bash
pnpm setup:local --project=/absolute/path/to/test-project --dry-run
pnpm setup:local --project=/absolute/path/to/test-project --skip-build --format=json
```

Dry-run executes nothing. Skip-build performs neither installation nor build and proves no
source/Dist correspondence. The helper changes no target configuration, feature declarations,
ignore rules, host/shell settings or global installation, and starts no services/tests.
Users explicitly import the MCP template. Linux/macOS are the tested setup platforms; this
helper belongs to the checkout, not the installed CLI package.

Also check a small external project with offline init/dry-run, explicit
`product --draft --feature=<id> --path=<literal>` and the reviewed feature map. Save only
`report.draft`, not the entire report. Explicit `product --run-tests -- <argv>` needs an
available Vitest-compatible runner. Passing/failing/skipped/stale/timed-out/cancelled states
remain distinct; source binding does not authenticate toolchains or domain completeness.

## Check the candidate

A `release-candidate/**` branch starts regular Linux CI and four release jobs:
Linux/macOS × Node 22/24. None publishes packages. `scripts/release-evidence.mjs` retains ten
parent gates: frozen install, build, typecheck, lint, unit, serial package tests, licenses,
tarball validation, E2E smoke and isolated npm/pnpm release installations.

The E2E smoke gate runs these separate acceptances in sequence:

1. Built adapter/graph contracts: `scripts/e2e-smoke.mjs`.
2. Independent TypeScript/Python feature workflows and real test evidence:
   `scripts/feature-workflow-smoke.mjs` (`pnpm e2e:product`).
3. Checkout first value and usable MCP template: `scripts/quickstart-smoke.mjs`.
4. Guided init, actual terminal cancellation/restoration, automation contracts and index-free
   feature/code artifacts: `scripts/init-setup-smoke.mjs`.
5. Real embedded LanceDB search using the default storage path, persistent tables, fresh
   retrieval and MCP (`scripts/lancedb-search-smoke.mjs`).

Terminal acceptance requires Python 3/POSIX PTYs on Linux/macOS and starts no external analyzer
or search service. Missing toolchains must not be recorded as success. A failed substep fails
the parent gate. Feature acceptance preserves failures, skips and source changes; it does
not claim Python test execution or productivity gains.

Release installation first requests only the CLI, proving transitive dependency resolution.
It checks native parsers, public imports, CLI/MCP, product/init contracts and stale evidence.
Both installed npm/pnpm consumers also index and query real LanceDB tables with offline
embeddings and record that proof in `release-report.json`.
Independent installed-consumer fixtures also verify Vue scripts and static frontend/FastAPI
boundaries; workspace imports are insufficient installation evidence. New SDD connections
must be checked through the actual public CLI and consumed by feature analysis/map output.
Browser visual/accessibility acceptance of the 3D map remains distinct from mathematical,
static and VM interaction tests.

Each job retains source/Dist manifests, toolchain, Git/Actions identity, exit codes and hashed
logs. Failed attempts remain evidence, not verified bundles. A passing `bundle/` contains 21
original tarballs, `SHA256SUMS`, `publish-order.json`, `release-report.json` and a CycloneDX
SBOM from the actual installed production tree. No workspace links or existing Dist files
replace these checks.

Download and validate all four artifacts against **the same expected commit**:

```bash
gh run download <run-id> --repo lboel/untangle --pattern 'untangle-candidate-*-attempt-<attempt>' --dir <new-artifact-directory>
node scripts/verify-release-candidate.mjs --artifacts-dir=<artifact-directory> --commit=<40-character-sha> --out=<new-compatibility-manifest.json>
```

The compatibility manifest binds all four and selects Linux/Node 22 as the canonical bundle.
Runner-specific tarball hashes may differ; publish only the selected checked originals.
Local evidence proves no other platform. Windows/additional optional parser peers are
outside the matrix.

After a fresh build, run `pnpm run e2e:lancedb` for standalone acceptance of the default search
backend. It exercises the built CLI and MCP with real LanceDB tables and offline embeddings.
The candidate matrix already runs this check through `pnpm run e2e:smoke`.

For separate semantic and hybrid coverage with LanceDB, run `pnpm run e2e:lancedb --semantic`
with the configured local Ollama model. For the optional Qdrant backend, `pnpm run e2e:search`
runs end-to-end coverage with real reachable Qdrant and Ollama. Record the source commit,
infrastructure, model and results for each service-backed run. Mark missing infrastructure
`unverified` for that run.

## Public approval

A maintainer must actually confirm:

1. The exact commit, license/NOTICE and public repository access. Candidate verification
   does not change visibility.
2. npm authentication, control of `@untangle-code`, all 21 package names and chosen version.
   `npm whoami` and authenticated permission checks are required; anonymous `E404` proves
   no name rights.
3. All four matrix jobs and required regular CI jobs pass at that commit, with archived
   compatibility and embedded-search evidence. Archive any additional service-backed search
   runs separately.
4. `next` as the release channel. A later explicit `latest` update is a tag change, not
   republishing an identical package version.
5. Signed tag `v<version>` on the checked commit and durable evidence retention; Actions artifacts
   expire after 30 days.

Do not change versions, sources or manifests after verification. No workspace `npm pack`
or repacking before publication; any change requires a new candidate.

## Publish original tarballs

For interactive publication, an authorized maintainer signs in with
`npm login --registry=https://registry.npmjs.org` and completes npm's two-factor authentication
challenge when prompted. npm provenance requires public packages and a public repository.

After explicit approval and complete candidate verification, run these checks in the
canonical `bundle/` directory.

```bash
sha256sum --check SHA256SUMS
# macOS: shasum -a 256 --check SHA256SUMS
npm whoami --registry=https://registry.npmjs.org
```

`publish-order.json` lists dependencies before consumers. Publish each recorded file directly
with `npm publish <file> --access=public --tag=next --registry=https://registry.npmjs.org`.
Follow npm's two-factor authentication prompt when it appears during publication.
On partial failure, stop and record actual registry state. Do not overwrite published versions
or hide errors by packing again.

The prepared protected [publish workflow](../.github/workflows/publish.yml) uses those same
originals with provenance. Once the packages exist, use npm Trusted Publishing (OIDC) for
subsequent automated releases. Configure each package's Trusted Publisher for the exact
repository, workflow and environment with direct publish rights. The workflow requires
human approval in `npm-release`, npm ≥11.5.1, Node ≥22.14 and GitHub-hosted runners.

Until npm removes granular-token direct publishing in January 2027, the workflow also
supports a one-time bootstrap using a short-lived granular token with direct publish access,
the minimum publishing scope and bypass 2FA. Store it as `NPM_BOOTSTRAP_TOKEN` exclusively in
the protected `npm-release` environment. After the run, remove the secret and revoke the
token. Run the workflow on the checked commit after it reaches the default branch. Inspect
registry state before retrying a partial publication.
[npm access-token deprecation](https://docs.npmjs.com/about-access-tokens/#direct-publishing-is-being-deprecated)

See [npm two-factor authentication](https://docs.npmjs.com/accessing-npm-using-2fa/),
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/),
[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/),
and [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

## Verify public installation

After actual publication, in fresh directories without local workspace/registry overrides:

```bash
# Set this to the release version from the checked commit.
VERSION=0.1.1
npm install --omit=dev --engine-strict "@untangle-code/cli@$VERSION"
npx --no-install untangle --version
npx --no-install untangle --help
# Use a separate project for pnpm:
pnpm add --prod "@untangle-code/cli@$VERSION"
pnpm exec untangle --version
pnpm exec untangle --help
```

Run `node scripts/public-registry-smoke.mjs --bundle=<canonical-bundle-dir> --out=<new-report.json>`
from the checkout. It compares registry integrity for all 21 packages to the canonical report
and repeats CLI-only resolution, native analysis, product/init/MCP, public-import and embedded
LanceDB search checks. Create the GitHub release with the signed tag, original tarballs, hashes,
SBOM, compatibility and matrix evidence, any separately recorded service-backed search evidence
and version limits. Update README/website to the available public entry only afterward.

## Release notes

See [CHANGELOG.md](../CHANGELOG.md) for implemented capabilities, including independent fresh
retrieval, AST/graph evidence, Vue/HTTP boundaries, declared feature complexity, explicit
Search Journeys, format-based analyzers, guided setup, English product text, the local 3D map
and native SDD connectors. Full change/policy gates, confirmed ownership, independent semantic
conformance and complete Sonar parity remain open. Direct analysis/offline init need no
services. Indexed search defaults to embedded LanceDB, with Qdrant available as an alternative;
service embeddings need their configured provider.
