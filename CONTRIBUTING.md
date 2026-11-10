# Contributing to Untangle

Normative sources for implementation decisions: [`spec.md`](./spec.md) takes precedence
in conflicts, followed by [`architecture.md`](./architecture.md), [`product.md`](./product.md),
[`vision.md`](./vision.md), [`portfolio.md`](./portfolio.md) and the parallel work plan
in [`docs/BUILD_PLAN.md`](./docs/BUILD_PLAN.md).

## Pull requests and contribution license

Pull requests are welcome. Fork the repository, create a focused branch, explain the
problem and resulting behavior, and include the relevant verification. Follow the
required checks below. Report security-sensitive findings through the
[private reporting procedure](./.github/SECURITY.md), rather than a public PR.

Contributions use **AGPL-3.0-only**, the same license as Untangle. Contributors retain
their copyright; no copyright assignment, separate CLA or DCO sign-off is required.
Submit work only when you have the right to license it under those terms. This follows
GitHub's [contributions under the repository license](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#6-contributions-under-repository-license)
model. Third-party dependencies and grammars retain their original copyrights, licenses
and notices. Preserve their provenance and follow [the licensing checks](./docs/LICENSING.md)
before adding a dependency; do not replace third-party attribution with Untangle's name.

## Setup

Requirements: Node.js `^22.13.0 || >=24.0.0` and the `pnpm` version declared in
`package.json`'s `packageManager` field.

CI uses `22.x`, including current patches in that line. The locked
`eslint-visitor-keys` engine contract requires at least Node 22.13 on Node 22 and
excludes Node 23. `engine-strict=true` checks this during installation.

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run test:unit
```

Local LanceDB tests use native temporary tables without services. Qdrant/Ollama
infrastructure remains optional for integration tests:
[`docker/README.md`](./docker/README.md).

### Root scripts

| Script | Purpose |
|---|---|
| `pnpm run build` | Delegate to each package's `build` script through `pnpm -r`. |
| `pnpm run typecheck` | Delegate to each package's `typecheck` script. |
| `pnpm run test` | Run each package's own test contract through `pnpm -r`; this is the authoritative package gate. |
| `pnpm run test:unit` | Run the Vitest workspace using `packages/*/vitest.config.ts` in one process for fast local feedback. |
| `pnpm run lint` | ESLint repository sources, including new untracked files; local runtime data/archives under `.untangle/` are excluded. |
| `pnpm run lint:evidence -- <helper-path> [...]` | Lint explicitly selected active `.untangle/` evidence helpers with repository rules and record source hashes. |
| `pnpm run format` / `format:check` | Write/check Prettier formatting. |
| `pnpm run clean` | Remove build artifacts (`dist`, `.turbo`, `coverage`, `*.tsbuildinfo`) across the repository. |
| `pnpm run check-licenses` | Check the production dependency license allowlist. |
| `pnpm run check-publishable` | Pack and inspect actual distribution tarballs, entry points, sources and licenses. |
| `pnpm run e2e:smoke` | Check built adapters/graphs, real feature workflow, checkout/MCP entry, actual terminal setup and embedded LanceDB search without external services. |
| `pnpm run e2e:lancedb` | Check real embedded search, reopen, backend/path switching, graph generations and freshness without external services. Add `--semantic` for the configured local Ollama acceptance. |
| `pnpm run e2e:search` | Check the optional Qdrant backend with real Qdrant and Ollama, including freshness, outages, watch and migration. |
| `pnpm run e2e:product` | Check built CLI/MCP on independent TypeScript/Python projects, including real Vitest reports, failures, skips and source changes. |
| `pnpm run e2e:quickstart` | Check index-free entry and an unchanged usable MCP template on an external project without Git/configuration. |
| `pnpm run e2e:setup` | Check actual TUI cancellation/terminal restoration, scriptable init and local feature/code artifacts; Python 3 on Linux/macOS, no external services. |
| `pnpm run setup:local` | Explicitly install/build the checkout and produce a first local analysis; `--dry-run` shows the plan and `--skip-build` uses existing Dist files. |
| `pnpm run e2e:release` | Install packed CLI packages through isolated npm/pnpm consumers and check the binary, native parsers, public exports and MCP stdio. |

## Conventions

- Strict TypeScript, ESM (`"type": "module"`), Node `^22.13.0 || >=24.0.0`, Vitest.
- Each package has `package.json` (`@untangle-code/<name>`; public packages are listed
  in `spec.md` §2.2, others are `private: true`), a `tsconfig.json` extending
  `../../tsconfig.base.json`, `src/index.ts` as its sole public module, and a README
  with a **Decisions** section for choices left open by normative documents.
- Co-locate tests in `src/**/*.test.ts`; do not create a separate `test/` directory.
- Domain/analysis logic uses `Clock` and `Random` ports, never direct `Date.now()` or
  `Math.random()` calls (`spec.md` §5). Root ESLint rules enforce this.
- IDs follow UUIDv5 identities from `spec.md` §5; do not invent competing ID schemes.
- Unit tests use in-memory ports and deterministic embedding from
  `@untangle-code/testkit`, without networking or actual Qdrant/Ollama. Live/integration
  suites are separate, explicitly invoked Vitest projects (`vitest.live.config.ts`,
  `test:integration` or `test:live`) and are never implicit unit/CI blockers
  (`docs/BUILD_PLAN.md`, risk R3).
- **Untangle's product language is English:** CLI/TUI/MCP help, diagnostics, generated
  configuration comments, graph controls, repository-owned labels, documentation,
  identifiers, comments, log events and new test names. Preserve machine identifiers,
  error codes, API fields and the original content/names of inspected repositories.
  Historical immutable evidence and third-party license text are not rewritten.
- Finished code must not contain placeholder implementations (`TODO: implement` or
  thrown `not implemented`). Unbuilt scope belongs in the work report's `openIssues`.
- Exactly one owner per path (`docs/BUILD_PLAN.md` §4). Request another owner's file
  rather than editing it concurrently.

## Required tests

- New logic requires meaningful Vitest unit tests, not empty snapshot placeholders.
- Architecture port-contract tests run against in-memory `@untangle-code/testkit`
  implementations (`architecture.md` §2.1).
- Before each commit, run `pnpm run typecheck && pnpm run lint && pnpm run test:unit`.
- CI (`.github/workflows/ci.yml`) is the authoritative gate: build, typecheck, lint,
  license/tarball checks, E2E smoke, isolated release installation and tests must pass.
  The Qdrant integration job intentionally uses `continue-on-error`; it does not
  replace the unit suite.

## Golden-test review rule (`architecture.md` §27.3)

Golden files contain expected symbols, imports, calls, cyclomatic/cognitive
contributions, Halstead tokens, AST depth and per-language chunk coverage. They are
not ordinary test inputs: editing one may change an algorithm's meaning.

- Every golden change needs an explicit review of the rationale for the new expected
  values, beyond checking that the suite passes.
- The PR must explain **why** the value changed: metric-definition fix, language
  adapter update or deliberate specification change.
- Automatically updating a golden merely to turn a test green is rejected.
- Goldens/snapshots belong to the testing package, not `fixtures/`; that directory
  contains inputs/ground truth (`docs/BUILD_PLAN.md` §4).

## Prepare a public release

A release candidate must work outside the monorepo. Workspace links and existing
Dist files are not installation evidence. After a fresh build, `pnpm run e2e:release`
checks unchanged `pnpm pack` tarballs in isolated npm/pnpm projects. A temporary local
registry serves only the unpublished Untangle packages; external production
dependencies come from the public npm registry. The first installation selects only
the CLI, proving transitive dependency resolution. Other public exports are checked
separately.

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run test:unit
pnpm --workspace-concurrency=1 -r --if-present run test
pnpm run check-licenses
pnpm run check-publishable
pnpm run e2e:smoke
pnpm run e2e:release --out-dir=".untangle/releases/<new-candidate-id>"
```

The smoke gate includes the default search acceptance, which can also run on its own as
`pnpm run e2e:lancedb` after building. Use `pnpm run e2e:lancedb --semantic` for additional
semantic and hybrid coverage with the configured local Ollama model, or `pnpm run e2e:search`
for the optional Qdrant/Ollama acceptance.

The output contains actual checked tarballs, SHA-256 hashes, package versions,
dependency order and verification report. A failed run must never mark a candidate
verified. The bundle includes the installed LanceDB checks. Record any service-backed search
acceptance separately with the infrastructure used.

[Release candidate](./.github/workflows/release-candidate.yml) runs on
`release-candidate/**` branches and manual GitHub Actions dispatch. It checks
Linux/macOS × Node 22/24 and exposes only passing candidates as time-limited workflow
artifacts. Regular CI checks both Node lines on Linux. A local run proves no unrun
CI/platform check. Windows is outside this matrix.

Before publishing, set the intended version in every public package and rerun the
package gates against the concrete candidate. `publish-order.json` lists internal
dependencies before consumers. Do not repack after checking or rewrite tarball
manifests. Resolved `workspace:` dependencies from `pnpm pack` are the distribution
contract; direct `npm pack` inside the workspace remains blocked.

Repository visibility, npm scope/package permissions, first publication and the
distribution tag are separate release actions. Verification does not change them.
Advertise public installation only after actual publication and registry installation.
The full procedure, matrix evidence, original tarballs, SBOM and initial publishing
are in [docs/RELEASE.md](./docs/RELEASE.md).

<a id="untangle-verbessert-untangle-bei-gleichem-featureset"></a>

## Untangle improves Untangle with the same feature set

The development loop uses **built** search, graph and AST capabilities:
`baseline → select → simplify → verify → report`. A run accepts at most one small
simplification. The larger [`reduce-complexity` design](./docs/superpowers/specs/2026-09-08-reduce-complexity-loop-design.md),
with capability clusters and dedicated loop commands, is not implemented. Embedding
similarity helps discovery; it does not prove preserved behavior.

### Selection and immutable baseline

Before edits, capture the actual workspace, including existing uncommitted/untracked
sources. HEAD alone is insufficient. Preserve others' changes. Give each run its own
unindexed `.untangle/self-improvement/runs/<runId>/` with `run.json`, `before/`,
`after/` and `verdict.json`; never overwrite baseline reports.

`run.json` declares the objective, allowed files, measurement scopes, source hashes,
Node/pnpm versions, configuration and commands. First use Untangle to find the
responsibility, inspect AST hotspots and read callers, callees and failure paths.
Record missing hits honestly. The measured scope includes the entire responsibility
and every new helper. Do not optimize merely for the largest number.

After a successful baseline build, for example:

```bash
run_dir=".untangle/self-improvement/runs/<unique-run-id>"
mkdir -p "$run_dir/before" "$run_dir/after"
node scripts/complexity-report.mjs --json --top=100 > "$run_dir/before/complexity.json"
pnpm exec vitest run --reporter=json --outputFile="$run_dir/before/unit.json"
pnpm run e2e:search > "$run_dir/before/real-search.log" 2>&1
node apps/cli/dist/index.js query "createEmbeddingStage" --mode=symbol --require-fresh --context --linked --format=json > "$run_dir/before/search.json"
```

Also hash sources and existing tests/fixtures. Capture `COMMANDS` specifications,
public exports/type declarations and actual MCP input/output schemas from a built
`mcp --stdio` client. Record registered and executable tools separately. Schema
identity does not replace validation/error tests. Every report needs source binding,
command exit code and file hash.

### Simplification and acceptance

Preserve product responsibilities, features, failures, cancellation, caching,
output/API contracts and retrieval paths. Leave existing tests, assertions, fixtures,
skips and configuration unchanged. Missing characterization tests must pass on the
original implementation before simplification. New tests may be added. Never alter
parsers, metric algorithms, thresholds or ignore rules to improve the numbers.

Rebuild after the change, repeat the same measurements and compare to baseline.
`verified_improvement` requires every mandatory guard:

| Guard | Required evidence |
|---|---|
| Behavior and interfaces | Existing tests pass with identical identities/statuses and byte-identical sources/fixtures; new characterizations pass; CLI/MCP/public package contracts are unchanged. |
| Complexity | Cognitive decreases across the complete target, including helpers; production-wide Cognitive totals do not rise. Report `execution_unit`, `self`, `top_level` separately without adding inclusive parent/child values. |
| Coverage | Same metric version/selection, without new parse gaps, lost sources, duplicates or invariant failures; existing gaps remain visible. |
| Dependencies | Compare import edges and review new edges/cycles; missing/stale graphs cannot pass. |
| Real search | Identical cases pass against real services with preserved ranks, freshness, outage/error behavior and migration checks; fake vectors do not replace live evidence. |
| Workspace | Only predeclared files changed; foreign/concurrent changes detected and preserved. |

Report raw cyclomatic numbers and execution-unit counts. `M = 1 + decision_points`
contains a base per unit, so extra helpers may increase it. More helpers, indirection
and SLOC are part of the judgment; shrinking one orchestration function is not enough.
Report new tests separately from production code.

Build, typecheck, lint and full unit suite are mandatory. Add affected package tests,
E2E smoke and real search acceptance. Refresh the self-index, then repeat symbol,
lexical and semantic queries with `--require-fresh` and graph context. Preserve the
configuration/embedding profile; a new corpus revision is normal after source edits.
Index and full AST file selection can differ; do not equate their counts.

`verdict.json` marks each source-bound guard `passed`, `failed` or `unverified`.
Missing services and measurement gaps are unverified. Retain no unverified
simplification: revert only owned edits whose hashes still match. On a collision,
leave the path intact and report the need; never use `git reset` or `git clean`.
Automatic runs commit/merge only with explicit user authorization and a passing
source-bound overall verdict. If the baseline contains other open work, isolate and
check the exact subtree being committed. Exclude foreign changes and preserve
branch/CI protections. Pushes and publication require separate authorization.
Report a verified improvement, new defect or required human action; stay quiet on
unchanged, non-actionable state.

### Active helpers and historical evidence

`.untangle/` contains local indexes, caches and immutable run reports, including
source copies, external build artifacts and frozen helpers. These historical bytes
are outside normal source lint. Do not rewrite them or present a new run as their
reverification. Normal lint excludes this local area in addition to existing
build/fixture exceptions; new repository sources remain checked.

Put new executable run helpers in a dedicated `helpers/` directory and source copies
in `.txt`/`.source` files, separate from outputs. Existing `verification-helpers/`
paths may be explicitly checked. Before freezing and before production edits, run:

```bash
pnpm run lint
pnpm run lint:evidence -- .untangle/self-improvement/runs/<runId>/helpers
```

Explicitly include every other executed local helper, even outside that directory.
`lint:evidence` requires a nonempty explicit selection under `.untangle/`, follows no
symlinks and uses all repository rules without autofix. Its report lists checked
paths, SHA-256 hashes and actual count. Omitted files or changed bytes fail the
check. Record command, exit code, report hash and source/Dist bindings; then freeze
the helpers. Passing source lint alone does not validate active evidence helpers.

These guards establish preserved **tested** behavior, not formal equivalence or a
complete product-ownership/feature map. Unproven features, implicit contracts and
coverage gaps remain open evidence.

## Decisions

1. **Separate typecheck and build.** Composite TypeScript projects cannot combine
   `-b` and `noEmit`: dependents require emitted declarations. Root typecheck delegates
   to appropriate package scripts (`tsc -p tsconfig.json --noEmit`, or `tsc -b` when
   composite references require it); build emits artifacts. Root `tsconfig.json`
   contains only references and `files: []`.
2. **`test` versus `test:unit`.** `test` runs each package's complete declared test
   contract; `test:unit` runs standard Vitest projects in one process for faster
   feedback and never implicitly adds live/integration suites.
3. **`eslint-plugin-import-x`.** The maintained fork provides ESLint 9 flat-config
   and ESM support for import rules, replacing incomplete support in the original
   plugin at scaffold creation.
4. **Architecture boundaries through `no-restricted-imports`.** Path-specific rules
   enforce domain→adapter, parser→MCP/CLI, storage-qdrant→UI and complexity→embedding
   restrictions for scoped names and relative imports. The future VS Code extension
   must enforce its own indexer-internals boundary (`architecture.md` §5.2).
5. **Health checks without curl/wget.** Pinned Qdrant/Ollama images do not guarantee
   those tools; their Bash `/dev/tcp` facility supplies TCP checks without extra
   dependencies.
6. **pnpm without a fallback.** The declared pnpm version was available and working
   during scaffold creation. No npm-workspace fallback was needed; see NOTICE.
7. **Production license checks through pnpm.** `pnpm licenses list --json --prod`
   avoids another production dependency or license-checker maintenance burden.
