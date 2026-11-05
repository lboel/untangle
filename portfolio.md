# Untangle — Portfolio Intelligence & Architecture Harness

**Status:** Draft 0.1  
**Normative version:** `portfolio-v1`  
**Product:** Untangle  
**Purpose:** Binding functional and non-functional requirements for the Portfolio Intelligence & Architecture Harness pillar: technology inventory, stack matrix, convention detection, architecture archetypes, tech radar and a Greenfield Blueprint Advisor across all repositories in a workspace.  
**Related documents:** [`vision.md`](./vision.md) · [`product.md`](./product.md) · [`spec.md`](./spec.md) · [`architecture.md`](./architecture.md)

If this document conflicts with [`spec.md`](./spec.md), `spec.md` takes precedence for the foundations it governs: identity model, configuration, Qdrant rules, MCP envelope and error principles. This document is normative for the portfolio pillar itself.

---

## 1. Normative language

**MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are normative as defined in [`spec.md`](./spec.md) section 1:

- **MUST / MUST NOT:** mandatory for conformance;
- **SHOULD / SHOULD NOT:** recommended default; deviations require a documented reason;
- **MAY:** optional capability.

An implementation conforms to `portfolio-v1` only when every MUST requirement is satisfied and the contract tests in section 16 pass.

---

## 2. Motivation and context

### 2.1 Original request

> “An important addition would be a harness and architecture overview across all projects: who uses what, to select a good starting architecture for greenfield projects.”

Untangle already indexes multiple workspace repositories with AST, graph, complexity and change data. The portfolio pillar lifts these data from individual repositories to the portfolio level:

1. **Inventory:** Which technologies does each repository use: runtimes, languages, frameworks, libraries, toolchain, CI, containers, IaC, databases, brokers and authentication?
2. **Who uses what:** Which repositories use technology T, at what version and depth?
3. **House standards:** Which conventions are established in practice, with evidence and counterexamples?
4. **Archetypes:** Which architectural forms actually exist in the portfolio?
5. **Radar:** Where do versions and solutions diverge, and is the portfolio converging or diverging over time?
6. **Greenfield:** Which starting architecture is recommended for a new project of a given kind, grounded in the user's portfolio rather than generic training knowledge?

### 2.2 Adherence to principles

The portfolio pillar MUST follow the product principles in [`vision.md`](./vision.md) section 8:

- **Evidence-first:** Every statement (inventory entry, convention, archetype, recommendation) MUST carry provenance (source file, line range, detector) and confidence. LLM guesses are not permitted as a detection source.
- **Local-first:** Every mandatory capability uses only local data. Cloud or registry requests are optional, opt-in and disableable (section 13).
- **Structure before embeddings:** Detection is deterministic from manifests, lockfiles, configuration files and file/symbol graphs. Embeddings only search records already created.
- **Stable identity:** Every portfolio entity receives a UUIDv5-based ID following [`spec.md`](./spec.md) section 5.
- **Compatibility is versioned:** Detectors, classifiers and advisors carry versioned algorithm IDs.

### 2.3 Relationship to existing engines

The portfolio pillar creates no separate parser, graph or metric implementation. It MUST consume:

| Source | Use |
|---|---|
| Scanner + File Manifests | manifest discovery, content hashes, staleness |
| File Graph ([`spec.md`](./spec.md) §14) | import evidence, usage depth, cross-repository package catalog |
| Symbol Graph ([`spec.md`](./spec.md) §15) | convention signals such as error classes and logging calls |
| Complexity Engine ([`spec.md`](./spec.md) §16) | health components for recommendations |
| Change Intelligence ([`spec.md`](./spec.md) §17) | first/last use, convergence/divergence trends |
| Context Artifacts ([`spec.md`](./spec.md) §19) | Dockerfile, Compose, K8s, Terraform and CI detection |

---

## 3. Terms

| Term | Meaning |
|---|---|
| **Technology** | identifiable external dependency or tool class: runtime, language, package manager, framework, library, build/test/lint tool, CI system, container/IaC stack, database, message broker, authentication solution |
| **Technology Record** | one detected technology in exactly one repository/ref, with version, usage, provenance and confidence |
| **Repository Profile** | aggregated portfolio view of one repository: languages, technologies, archetype, health |
| **Stack Matrix** | workspace technology × repository matrix with adoption and version spread |
| **Convention** | a portfolio-derived house standard with evidence, counterexamples and confidence |
| **Archetype** | deterministically classified architectural form of a repository |
| **Blueprint** | recommended starting architecture for a new project kind, derived from portfolio evidence |
| **Tech Radar Entry** | assessment of a portfolio technology: ring, version drift, duplicates, trend |
| **Detector** | deterministic, versioned rule creating a record from a source file or graph signal |
| **Portfolio Generation** | complete portfolio scan run with its own `generation_id`, following [`spec.md`](./spec.md) §10.6 |

---

## 4. Non-goals of `portfolio-v1`

- no automatic code generation except explicitly requested blueprint scaffolding (section 11);
- no mandatory public-registry queries (npm, PyPI, crates.io, Maven Central); online enrichment is strictly opt-in;
- no license compliance analysis as a primary capability (license fields MAY be retained);
- no CVE/security scanner capability; Untangle does not replace an SCA tool;
- no organization-wide governance workflows (approval, ownership, policy enforcement) before Horizon 3;
- no LLM classification of archetypes or conventions; all classifiers are rule-based and versioned;
- no single Architecture Score without disclosed components;
- no automatic migration of existing repositories to recommended blueprints.

---

## 5. Identity model

All IDs follow the UUIDv5 pattern in [`spec.md`](./spec.md) section 5. Namespaces and inputs are normative:

```text
technology_id       = UUIDv5(workspace_id + category + ecosystem + canonical_name)
tech_record_id      = UUIDv5(technology_id + repo_id + ref_id + usage + detector_id)
repo_profile_id     = UUIDv5(workspace_id + repo_id + ref_id + "portfolio_profile")
stack_matrix_id     = UUIDv5(workspace_id + "stack_matrix" + generation_id)
convention_id       = UUIDv5(workspace_id + convention_kind + rule_fingerprint)
archetype_id        = UUIDv5(workspace_id + repo_id + ref_id + classifier_version)
blueprint_id        = UUIDv5(workspace_id + blueprint_kind + advisor_version + generation_id)
recommendation_id   = UUIDv5(blueprint_id + topic)
radar_entry_id      = UUIDv5(workspace_id + technology_id + radar_version)
```


Requirements:

- `canonical_name` MUST be normalized: lowercase, trimmed and ecosystem-specific alias resolution through a versioned alias table (`portfolio-alias-v1`). For example, `@types/react → react (usage: dev)` stays separate, while `psycopg2-binary → psycopg2` is merged.
- `rule_fingerprint` MUST be the SHA256 of the convention rule's canonical JSON (section 8.3).
- Line numbers MUST NOT be part of a primary ID; they are provenance metadata.
- With unchanged input, every ID MUST stay stable (determinism; no time or random components).

---

## 6. Technology inventory

### 6.1 Categories

```text
runtime            (node, deno, bun, python, jvm, go, dotnet, php, ruby)
language           (typescript, javascript, python, go, rust, java, kotlin, csharp, php, ruby, c, cpp)
package_manager    (npm, pnpm, yarn, pip, poetry, uv, cargo, maven, gradle, nuget, composer, bundler)
framework          (e.g. express, fastify, nestjs, next, react, vue, django, fastapi, spring, axum)
library            (all other code dependencies)
build_tool         (tsc, vite, esbuild, webpack, rollup, turbo, nx, make)
test_tool          (vitest, jest, pytest, go test, junit, playwright)
lint_tool          (eslint, biome, prettier, ruff, black, clippy, checkstyle)
ci_system          (github_actions, gitlab_ci, circleci, jenkins, azure_pipelines)
container          (docker, compose, podman)
orchestration      (kubernetes, helm, nomad)
iac                (terraform, pulumi, cloudformation, cdk, ansible)
database           (postgres, mysql, sqlite, mongodb, redis, qdrant, elasticsearch)
message_broker     (kafka, rabbitmq, nats, sqs, redis_streams)
auth               (keycloak, auth0, passport, next-auth, oidc/oauth2 libraries, jose, jwt)
observability      (opentelemetry, prometheus, sentry, pino, winston)
other
```


The mapping `canonical_name → category` and `canonical_name → problem_domain` (section 10) uses the bundled, versioned table `portfolio-domain-map-v1`. Entries outside the table receive `category: "library"` and `problem_domain: null`. The table MUST be versioned in the repository as a data artifact and MUST NOT be downloaded at runtime.

### 6.2 Detection sources

The portfolio scanner MUST deterministically evaluate at least these manifest and configuration files:

```text
package.json, package-lock.json, pnpm-lock.yaml, yarn.lock, pnpm-workspace.yaml
tsconfig.json, .nvmrc, .node-version
requirements*.txt, pyproject.toml, poetry.lock, uv.lock, setup.py, setup.cfg, Pipfile
go.mod, go.sum, go.work
Cargo.toml, Cargo.lock
pom.xml, build.gradle, build.gradle.kts, settings.gradle, gradle/libs.versions.toml
*.csproj, *.fsproj, Directory.Packages.props, packages.config, global.json
composer.json, composer.lock
Gemfile, Gemfile.lock
Dockerfile*, docker-compose*.yml, compose*.yml
Kubernetes manifests (apiVersion/kind detection), Helm Chart.yaml/values.yaml
*.tf, *.tf.json, Pulumi.yaml
.github/workflows/*.yml, .gitlab-ci.yml, .circleci/config.yml, azure-pipelines.yml, Jenkinsfile
.eslintrc*, eslint.config.*, biome.json, .prettierrc*, ruff.toml, .editorconfig
vitest.config.*, jest.config.*, playwright.config.*, pytest.ini, tox.ini
```


Import evidence from the File Graph MUST also contribute: importing-file count per technology per repository. A declared technology with no imports MUST be identifiable as `declaredOnly`; an imported but undeclared technology MUST be identifiable as `importOnly` (Phantom Dependency).

### 6.3 Deterministic detection rules

Every detector has an ID (`detector_id`), version and fixed confidence. This table is normative for the minimum set; confidence values are fixed per rule rather than estimated at runtime. `H` marks heuristics.

| Detector ID | Source file / field | Produces | Category | Confidence | Basis |
|---|---|---|---|---:|---|
| `npm.engines.node` | `package.json` → `engines.node` | Runtime `node` + version range | runtime | 1.00 | deterministic |
| `npm.packageManager` | `package.json` → `packageManager` | package manager + exact version | package_manager | 1.00 | deterministic |
| `npm.lockfile.kind` | existence of `pnpm-lock.yaml` / `yarn.lock` / `package-lock.json` | package manager | package_manager | 0.95 | deterministic |
| `npm.dependencies` | `package.json` → `dependencies[k]` | library/framework `k`, `versionRaw` | by mapping | 0.95 | deterministic |
| `npm.devDependencies` | `package.json` → `devDependencies[k]` | technology `k`, `usage: "dev"` | by mapping | 0.95 | deterministic |
| `npm.lock.resolved` | lockfile entry for `k` | exact `versionResolved` | — (supplements record) | 1.00 | deterministic |
| `ts.tsconfig` | presence of `tsconfig*.json` | language `typescript` | language | 1.00 | deterministic |
| `py.pyproject.deps` | `pyproject.toml` → `project.dependencies` / tool sections | library, `versionRaw` | by mapping | 0.95 | deterministic |
| `py.requirements` | `requirements*.txt` line | library, `versionRaw` | by mapping | 0.90 | deterministic |
| `py.lock.resolved` | `poetry.lock` / `uv.lock` | `versionResolved` | — | 1.00 | deterministic |
| `py.requires-python` | `pyproject.toml` → `requires-python` | runtime `python` + range | runtime | 1.00 | deterministic |
| `go.mod` | `go.mod` → `go` directive, `require` | runtime `go`, libraries with exact versions | runtime/library | 1.00 | deterministic |
| `rust.cargo` | `Cargo.toml` → `[dependencies]` | libraries, `versionRaw` | by mapping | 0.95 | deterministic |
| `rust.cargo.lock` | `Cargo.lock` | `versionResolved` | — | 1.00 | deterministic |
| `jvm.pom` | `pom.xml` → `<dependency>` | libraries with group/artifact/version | by mapping | 0.95 | deterministic |
| `jvm.gradle.catalog` | `libs.versions.toml` | libraries + versions | by mapping | 0.95 | deterministic |
| `jvm.gradle.script` | `build.gradle(.kts)` dependency strings | libraries; version only for literals | by mapping | 0.80 | H (script parsing) |
| `dotnet.csproj` | `*.csproj` → `<PackageReference>` | libraries + versions | by mapping | 0.95 | deterministic |
| `php.composer` | `composer.json` / `composer.lock` | libraries, runtime `php` from `require.php` | by mapping | 0.95 | deterministic |
| `docker.baseimage` | `Dockerfile` → `FROM` lines | container + base image (e.g. `node:22-alpine` ⇒ runtime evidence) | container/runtime | 0.90 | deterministic |
| `compose.services` | `docker-compose*.yml` → `services[*].image` | databases/brokers/infrastructure mapped from image names | database/message_broker/… | 0.85 | H (image name ⇒ technology) |
| `k8s.kinds` | YAML with `apiVersion` + `kind` | orchestration `kubernetes`; workload types as metadata | orchestration | 0.95 | deterministic |
| `helm.chart` | `Chart.yaml` | orchestration `helm` + chart dependencies | orchestration | 0.95 | deterministic |
| `tf.providers` | `*.tf` → `required_providers`, `provider` blocks | IaC `terraform` + versioned providers | iac | 0.95 | deterministic |
| `ci.github` | `.github/workflows/*.yml` | CI `github_actions` + versioned actions (`uses:`) | ci_system | 1.00 | deterministic |
| `ci.gitlab` | `.gitlab-ci.yml` | CI `gitlab_ci` | ci_system | 1.00 | deterministic |
| `lint.config` | ESLint/Biome/Prettier/Ruff configuration file | lint tool + manifest version | lint_tool | 0.95 | deterministic |
| `test.config` | Vitest/Jest/Playwright/Pytest configuration file | test tool | test_tool | 0.95 | deterministic |
| `graph.import` | File Graph: resolved import to package `k` | import evidence (`importingFiles`, `importOnly` if undeclared) | — (supplements record) | 0.90 | deterministic |
| `db.connstring` | connection-string patterns in configuration (`postgres://`, `mongodb://`, `amqp://`, `redis://`) | database/broker | database/message_broker | 0.60 | H (string patterns) |
| `auth.wellknown` | mapped authentication libraries (`passport`, `next-auth`, `keycloak-js`, `jose`, `spring-security`, …) | authentication solution | auth | 0.90 | deterministic |

Rules:

- Every produced record MUST carry `detector_id`, detector version, source file and, for line-based sources, the line range in its provenance.
- If several detectors recognize the same technology in one repository, records MUST merge into one `TechnologyRecordV1` with several provenance entries. Result confidence is the maximum individual confidence; lockfile `versionResolved` takes precedence over `versionRaw`.
- Heuristic detectors MUST set `confidence.basis = "heuristic"`. Purely heuristic results SHOULD be labeled as heuristics in output.
- Unparseable manifests MUST NOT abort the scan; they MUST count as `manifestsFailed` in the Repository Profile and be reported as warnings.
- Transitive lockfile dependencies MAY be captured with `usage: "transitive"` but SHOULD be hidden from Stack Matrix and Radar by default (`includeTransitive` filter).

### 6.4 Version normalization

- SemVer-like versions MUST normalize to comparable tuples (`major.minor.patch`, preserving prereleases).
- Range declarations (`^`, `~`, `>=`, Maven ranges, PEP 440 specifiers) MUST remain in `versionRaw`; `versionResolved` comes only from lockfiles or exact pins.
- Incomparable version formats MUST set `versionComparable: false` and MUST NOT enter numeric spread calculations.

---

## 7. Data contracts

All contracts are versioned (`schemaVersion: 1`) and carry provenance and confidence. Shared components:

```ts
interface PortfolioProvenanceV1 {
  workspaceId: string;
  repoId: string;
  refId: string;
  commitSha?: string;
  sourceFile: string;        // repository-relative path, normalized to "/"
  startLine?: number;
  endLine?: number;
  detectorId: string;        // e.g. "npm.dependencies"
  detectorVersion: string;   // e.g. "portfolio-detect-v1"
  evidenceKind:
    | "manifest"
    | "lockfile"
    | "config"
    | "import_graph"
    | "symbol_graph"
    | "ci"
    | "container"
    | "iac"
    | "change_history"
    | "heuristic";
}

interface PortfolioConfidenceV1 {
  value: number;                          // [0,1]
  basis: "deterministic" | "heuristic";
  signals: string[];                      // contributing detectorIds
}
```


### 7.1 `TechnologyRecordV1`

One detected technology in exactly one repository/ref.

```ts
interface TechnologyRecordV1 {
  schemaVersion: 1;
  recordId: string;             // tech_record_id
  technologyId: string;
  workspaceId: string;
  repoId: string;
  refId: string;
  generationId: string;

  name: string;                 // canonical_name
  displayName?: string;         // original spelling
  category: string;             // section 6.1
  ecosystem?: string;           // "npm" | "pypi" | "go" | "crates" | "maven" | "nuget" | "composer" | "rubygems" | "docker" | "github-actions" | "terraform"
  problemDomain?: string;       // from portfolio-domain-map-v1, otherwise null

  versionRaw?: string;          // as declared, e.g. "^18.2.0"
  versionResolved?: string;     // from lockfile, e.g. "18.3.1"
  versionComparable: boolean;
  versionSource?: "manifest" | "lockfile" | "runtime_file" | "import_only";

  usage: "runtime" | "dev" | "build" | "test" | "ci" | "infra" | "peer" | "optional" | "transitive";
  declaredOnly: boolean;        // declared without import evidence
  importOnly: boolean;          // import evidence without declaration (Phantom Dependency)
  importingFileCount: number;   // from File Graph; 0 when inapplicable

  firstSeenAt?: string;         // ISO-8601, from Change History; absent without history
  lastSeenAt?: string;

  provenance: PortfolioProvenanceV1[];   // at least 1 entry
  confidence: PortfolioConfidenceV1;
}
```


Requirements:

- `provenance` MUST contain at least one entry; records without provenance are invalid.
- `firstSeenAt`/`lastSeenAt` MUST come from Change History or Git metadata; without history the fields remain absent and MUST NOT be estimated.
- Timestamps MUST come through the `Clock` port; `Date.now()` is forbidden in domain logic.

### 7.2 `RepositoryProfileV1`

```ts
interface RepositoryHealthV1 {
  metricsVersion: string;                 // from Complexity Engine
  measuredAt: string;
  maintainabilityIndexMedian?: number;
  cognitiveP90?: number;
  cyclomaticP90?: number;
  dependencyCycleCount?: number;
  hotspotShare?: number;                  // share of files above hotspot threshold [0,1]
  unresolvedImportRatio?: number;
  parseFailureRatio?: number;
  caveats: string[];                      // e.g. "no complexity index for ref"
}

interface LanguageShareV1 {
  language: string;
  supportLevel: "deep" | "structural" | "text";
  fileCount: number;
  slocShare: number;                      // [0,1]
}

interface RepositoryProfileV1 {
  schemaVersion: 1;
  profileId: string;
  workspaceId: string;
  repoId: string;
  repoLabel: string;
  refId: string;
  commitSha?: string;
  generationId: string;
  analyzerVersion: string;                // "untangle-portfolio-v1"
  generatedAt: string;

  languages: LanguageShareV1[];
  technologyRecordIds: string[];          // references to TechnologyRecordV1
  runtimeSummary: { name: string; versionRange?: string }[];
  packageManagers: string[];

  archetypeId?: string;                   // reference to ArchetypeV1
  matchedConventionIds: string[];
  violatedConventionIds: string[];

  health?: RepositoryHealthV1;

  completeness: {
    manifestsFound: number;
    manifestsParsed: number;
    manifestsFailed: number;
    importGraphAvailable: boolean;
    changeHistoryAvailable: boolean;
    complexityAvailable: boolean;
  };
}
```


A Repository Profile with `manifestsFailed > 0` or missing data sources MUST be identifiable as incomplete. Derived statements (Matrix, Radar, Blueprint) MUST propagate that incompleteness as warnings.

### 7.3 `StackMatrixV1`

```ts
interface StackMatrixEntryV1 {
  technologyId: string;
  name: string;
  category: string;
  ecosystem?: string;
  problemDomain?: string;

  adoption: {
    repoCount: number;
    repoShare: number;                    // repoCount / analyzed repositories
    repoIds: string[];
  };

  versionSpread: {
    distinctVersions: string[];           // versionResolved, otherwise versionRaw
    byRepo: Record<string, string | null>;
    majorSpread: number;                  // max(major) - min(major) over comparable versions
    comparable: boolean;
  };

  usageDepth: {
    importingFilesByRepo: Record<string, number>;
    declaredOnlyRepos: string[];
    importOnlyRepos: string[];
  };

  firstSeenAt?: string;
  lastSeenAt?: string;

  confidence: PortfolioConfidenceV1;      // minimum over contributing records
}

interface StackMatrixV1 {
  schemaVersion: 1;
  matrixId: string;
  workspaceId: string;
  generationId: string;
  generatedAt: string;
  analyzerVersion: string;
  repositories: { repoId: string; refId: string; profileId: string }[];
  entries: StackMatrixEntryV1[];
  warnings: string[];                     // e.g. incomplete profiles
}
```


The reverse question “which repositories use technology T” MUST be answerable from the matrix without rescanning (`who-uses`, sections 12/14).

### 7.4 `ConventionV1`

```ts
interface ConventionRuleV1 {
  ruleKind:
    | "path_exists"          // directory/file pattern exists
    | "path_layout"          // set of globs describes layout
    | "naming_pattern"       // regex over file/symbol names
    | "dependency_present"   // technology/category exists
    | "layering"             // forbidden/expected import directions (Glob → Glob)
    | "symbol_pattern"       // pattern over Symbol Graph (e.g. "class * extends Error")
    | "config_pattern";      // key/value in configuration file
  expression: Record<string, unknown>;    // canonical JSON; basis of rule_fingerprint
  humanReadable: string;                  // English short form, e.g. "tests are co-located as *.test.ts"
}

interface ConventionCounterexampleV1 {
  repoId: string;
  provenance: PortfolioProvenanceV1;
  note?: string;
}

interface ConventionV1 {
  schemaVersion: 1;
  conventionId: string;
  workspaceId: string;
  generationId: string;
  kind:
    | "directory_layout"
    | "layering"
    | "naming"
    | "test_setup"
    | "error_handling"
    | "config_handling"
    | "logging";
  title: string;
  description: string;
  rule: ConventionRuleV1;

  evidence: {
    applicableRepos: string[];            // repositories to which the rule applies
    supportingRepos: string[];
    matchCount: number;                   // matches across all repositories
    counterexamples: ConventionCounterexampleV1[];
    sampleProvenance: PortfolioProvenanceV1[];  // at most 20 evidence locations
  };

  confidence: PortfolioConfidenceV1;
  detectorId: string;
  detectorVersion: string;
  heuristic: boolean;
}
```


Confidence formula (normative, deterministic):

```text
support_share        = |supportingRepos| / max(|applicableRepos|, 1)
counterexample_share = |counterexample_repos| / max(|applicableRepos|, 1)
confidence.value     = clamp(support_share * (1 - counterexample_share), 0, 1)
```


A convention MUST NOT be reported without supporting repositories, match count, counterexamples (possibly empty) and confidence. Conventions with `applicableRepos < 2` SHOULD be suppressed by default (`minRepos`, default 2).

### 7.5 `ArchetypeV1`

```ts
interface ArchetypeSignalV1 {
  signalId: string;                       // e.g. "npm.bin_field"
  description: string;
  weight: number;
  matched: boolean;
  contribution: number;                   // weight on match, otherwise 0
  provenance?: PortfolioProvenanceV1;
  heuristic: boolean;
}

interface ArchetypeV1 {
  schemaVersion: 1;
  archetypeId: string;
  workspaceId: string;
  repoId: string;
  refId: string;
  generationId: string;
  classifierVersion: "untangle-archetype-v1";

  archetype:
    | "layered_service"
    | "hexagonal_service"
    | "modular_monolith"
    | "api_service"
    | "worker"
    | "cli_tool"
    | "library"
    | "frontend_app"
    | "mcp_server"
    | "infra_repo"
    | "monorepo_root"
    | "unclassified";

  score: number;                          // sum of contributions, normalized [0,1]
  alternatives: { archetype: string; score: number }[];  // descending, at most 3
  signals: ArchetypeSignalV1[];           // complete list including unmatched required signals
  confidence: PortfolioConfidenceV1;
}
```


Classification rules (`untangle-archetype-v1`, minimum set; `H` = heuristic):

| Signal ID | Description | Supports | Weight | Basis |
|---|---|---|---:|---|
| `npm.bin_field` | `package.json` contains `bin` | cli_tool | 0.40 | deterministic |
| `pkg.exports_no_entrypoint` | library exports exist, no server/CLI entry point | library | 0.35 | deterministic |
| `dep.http_framework` | framework in `http_server` domain exists | api_service | 0.35 | deterministic |
| `dep.frontend_framework` | framework in `frontend` domain exists | frontend_app | 0.40 | deterministic |
| `dep.mcp_sdk` | MCP SDK dependency exists | mcp_server | 0.45 | deterministic |
| `dep.queue_consumer_no_http` | broker client exists, no HTTP framework | worker | 0.35 | deterministic |
| `layout.hexagonal_dirs` | directories such as `domain/` + `adapters/`/`ports/` | hexagonal_service | 0.30 | H |
| `layout.layered_dirs` | layers such as `controllers/` + `services/` + `repositories/` | layered_service | 0.30 | H |
| `layout.packages_workspace` | workspace manifest with multiple packages | monorepo_root | 0.40 | deterministic |
| `graph.module_boundaries` | several self-contained import clusters without inter-cluster cycles | modular_monolith | 0.25 | H |
| `files.only_iac` | ≥ 80% of files are IaC/CI/container files | infra_repo | 0.45 | deterministic |

- The archetype with the highest normalized score wins; scores < 0.30 MUST yield `unclassified`.
- Alternatives and all signals MUST appear in output; an archetype without its signal list is invalid.
- Heuristic signals MUST be marked as such.

### 7.6 `BlueprintV1`

```ts
interface BlueprintDirectoryEntryV1 {
  path: string;                           // relative layout, e.g. "src/domain/"
  kind: "directory" | "file";
  purpose: string;
  sourceConventionId?: string;            // convention from which the entry derives
}

interface BlueprintDependencyV1 {
  technologyId: string;
  name: string;
  ecosystem: string;
  version: string;                        // exact recommended version from the portfolio
  usage: "runtime" | "dev";
  recommendationId: string;               // justification, required
}

interface BlueprintFileV1 {
  path: string;
  templateId: string;                     // versioned internal template
  contentPreviewHash: string;             // SHA256 of generated content
  sizeBytes: number;
}

interface BlueprintV1 {
  schemaVersion: 1;
  blueprintId: string;
  workspaceId: string;
  generationId: string;
  advisorVersion: "untangle-blueprint-v1";
  generatedAt: string;

  kind: "api-service" | "worker" | "cli" | "library" | "web-app" | "mcp-server";
  language: string;
  runtime: { name: string; versionRange: string };

  directoryLayout: BlueprintDirectoryEntryV1[];
  dependencies: BlueprintDependencyV1[];
  toolchain: BlueprintDependencyV1[];     // build/test/lint, usage: "dev"
  testSetup: { framework: string; layout: string; recommendationId: string };
  ciSkeleton: { system: string; workflowFiles: string[]; recommendationId: string };

  appliedConventionIds: string[];
  recommendationIds: string[];            // all BlueprintRecommendationV1
  files?: BlueprintFileV1[];              // only for scaffolding preview/application

  evidenceSummary: {
    reposConsidered: number;
    reposMatchingKind: string[];          // repositories of the same archetype as primary source
    portfolioGenerationId: string;
  };
  warnings: string[];
}
```


### 7.7 `BlueprintRecommendationV1`

```ts
interface RecommendationComponentV1 {
  name: "adoption" | "recency" | "health" | "version_consistency";
  value: number;                          // [0,1], normalized
  weight: number;
  contribution: number;                   // value * weight
  inputs: Record<string, unknown>;        // raw values, e.g. { repoShare: 0.75, repoIds: [...] }
}

interface BlueprintAlternativeV1 {
  technologyId: string;
  name: string;
  version?: string;
  fitScore: number;
  components: RecommendationComponentV1[];
  note?: string;
}

interface BlueprintRiskV1 {
  kind:
    | "outdated_version"
    | "low_adoption"
    | "high_hotspot_share"
    | "version_divergence"
    | "single_repo_evidence"
    | "declared_only_evidence"
    | "heuristic_evidence";
  severity: "info" | "warning" | "critical";
  message: string;
  evidence: PortfolioProvenanceV1[];
}

interface BlueprintRecommendationV1 {
  schemaVersion: 1;
  recommendationId: string;
  blueprintId: string;
  workspaceId: string;
  generationId: string;
  advisorVersion: "untangle-blueprint-v1";

  topic: string;                          // e.g. "http_framework", "test_runner", "ci_system"
  recommended: { technologyId: string; name: string; version?: string };

  fitScore: number;                       // [0,1]
  components: RecommendationComponentV1[]; // required: all four components
  evidence: {
    supportingRepoIds: string[];
    supportingRecordIds: string[];        // TechnologyRecordV1 references
    healthByRepo: Record<string, RepositoryHealthV1 | null>;
  };

  alternatives: BlueprintAlternativeV1[]; // at least 1 when candidates exist
  risks: BlueprintRiskV1[];
  confidence: PortfolioConfidenceV1;
}
```


Fit score formula (normative; default weights configurable; output always includes components):

```text
fit = 0.40 * adoption
    + 0.20 * recency
    + 0.25 * health
    + 0.15 * version_consistency
```


- `adoption` = repoShare among repositories relevant to the blueprint kind;
- `recency` = normalized age of `lastSeenAt` (history required; without history 0.5 with caveat);
- `health` = normalized health of using repositories (median MI, hotspot share, cycles); without complexity data 0.5 with caveat;
- `version_consistency` = 1 − normalized major spread.

A `fitScore` MUST NOT be reported without `components`. A recommendation without at least one supporting repository MUST NOT appear as a portfolio recommendation; the tool MUST return `BLUEPRINT_EVIDENCE_INSUFFICIENT` (section 15) or explicitly report the gap as “no portfolio evidence” with an empty recommendation.

### 7.8 `TechRadarEntryV1`

```ts
interface RadarTrendPointV1 {
  window: string;                         // e.g. "2026-Q1"
  repoCount: number;
  distinctVersionCount: number;
}

interface TechRadarEntryV1 {
  schemaVersion: 1;
  entryId: string;
  workspaceId: string;
  generationId: string;
  radarVersion: "untangle-radar-v1";
  technologyId: string;
  name: string;
  category: string;
  problemDomain?: string;

  ring: "adopt" | "maintain" | "consolidate" | "retire";
  ringReason: string[];                   // rule IDs that determined the ring

  versionDrift: {
    distinctVersions: string[];
    majorSpread: number;
    byRepo: Record<string, string | null>;
    comparable: boolean;
  };

  duplicates: {
    problemDomain: string;
    competingTechnologyIds: string[];     // other technologies in the same portfolio domain
  }[];

  trend: {
    direction: "converging" | "diverging" | "stable" | "declining" | "new" | "unknown";
    points: RadarTrendPointV1[];          // from Change History; empty without history
  };

  evidence: PortfolioProvenanceV1[];
  confidence: PortfolioConfidenceV1;
}
```


Ring assignment (`untangle-radar-v1`, deterministic, thresholds configurable):

```text
R1 adopt        repoShare >= 0.50 AND no competing technology in the same
                problem_domain with higher repoShare AND majorSpread <= 1
R2 maintain     0.20 <= repoShare < 0.50 AND no R3/R4 criterion matches
R3 consolidate  >= 2 technologies in the same portfolio problem_domain
                OR majorSpread >= 2
R4 retire       lastSeenAt older than retireAfterDays (default 540) AND
                trend "declining" over the last 2 windows
```


Rules are checked in order R4 → R3 → R1 → R2; the first matching rule wins. `ringReason` MUST contain applied rule IDs. Without Change History, R4 and trend claims MUST NOT be asserted; `trend.direction = "unknown"`.

---

## 8. Convention detection

### 8.1 Detectors

`portfolio-v1` MUST contain at least these convention detectors (`H` = heuristic):

| Detector ID | Kind | Detects | Basis |
|---|---|---|---|
| `conv.layout.src` | directory_layout | shared root layout (`src/`, `tests/`, `docs/`, …) as normalized glob set | deterministic |
| `conv.layout.package_structure` | directory_layout | recurring package substructure in workspaces (e.g. `packages/*/src/index.ts`) | deterministic |
| `conv.layering.import_direction` | layering | dominant import directions between layer globs; violations are counterexamples | deterministic (graph) |
| `conv.naming.file_case` | naming | dominant filename style (kebab/camel/snake/Pascal) per language | H (regex classification) |
| `conv.naming.test_suffix` | naming | test-file patterns (`*.test.ts`, `*_test.go`, `test_*.py`) | deterministic |
| `conv.test.colocated` | test_setup | co-located tests versus separate test directory; dominant runner | deterministic |
| `conv.error.custom_classes` | error_handling | `class * extends Error` or language equivalent through Symbol Graph | H |
| `conv.error.result_types` | error_handling | Result/Either types instead of exceptions | H |
| `conv.config.env_layer` | config_handling | dominant configuration pattern (dotenv, typed configuration, schema validation) through dependency and import evidence | deterministic |
| `conv.logging.library` | logging | dominant logging library per ecosystem and `console.*`/`print` call share as counterexamples | H (call counts) |

### 8.2 Requirements

- Every detected convention MUST populate all of `ConventionV1`: supporting repositories, match count, counterexamples and confidence from the formula in 7.4.
- Counterexamples MUST carry provenance (repository, file and lines where applicable) so they can be inspected.
- Convention detectors MUST NOT send source code to external services.
- Users MAY pin conventions in `.untangle.json` (`portfolio.conventions.pinned`) or suppress them (`portfolio.conventions.suppressed`). Pinned conventions appear regardless of confidence; suppressed ones never appear. Pins and suppressions MUST be labeled in output.
- Conventions contribute to the Blueprint Advisor (directory layout, test setup, logging, configuration handling). Every adopted convention MUST be referenced in the blueprint through `appliedConventionIds`.

### 8.3 Rule Fingerprint

`rule_fingerprint = SHA256(canonical_json(rule.expression))`. Canonicalization: sorted keys, no whitespace variance, normalized globs. This keeps `convention_id` stable across scans while the rule remains unchanged.

---

## 9. Portfolio scan pipeline

### 9.1 Flow

```text
queued
→ loading_workspace           (repositories, refs, last index generations)
→ collecting_manifests        (Scanner + File Manifests, Content Hashes)
→ detecting_technologies      (detectors from section 6.3)
→ enriching_from_graph        (import evidence, Phantom Dependencies)
→ enriching_from_history      (firstSeenAt/lastSeenAt, trends; optional)
→ building_profiles           (RepositoryProfileV1 including Health)
→ detecting_conventions
→ classifying_archetypes
→ building_matrix
→ building_radar
→ storing                     (Qdrant, section 12)
→ finalizing                  (Generation Commit)
→ completed
```


Error states: `failed`, `cancel_requested`, `cancelled`, identical to the state machine in [`spec.md`](./spec.md) §11.1.

### 9.2 Requirements

- The scan MUST be incremental: repositories with unchanged relevant manifest hashes and graph generation are carried forward from the last portfolio generation.
- The scan MUST run without an existing search/embedding index. Without a File Graph, import evidence and layering conventions are unavailable and reported as incomplete.
- The scan MUST NOT access network endpoints outside configured Qdrant/Ollama endpoints unless online enrichment (section 13) is enabled.
- A scan across N repositories MUST support isolated per-repository failure; the overall result carries warnings instead of aborting entirely (following [`architecture.md`](./architecture.md) §22.2).
- The scan MUST be deterministic: identical inputs (files, hashes, configuration, detector versions) produce byte-identical records except `generatedAt` timestamps from the `Clock` port.
- Incomplete generation results MUST NOT be reported as complete ([`spec.md`](./spec.md) §10.6).

---

## 10. Tech Radar and drift

- The radar MUST be deterministically derivable from Stack Matrix and Change History. A radar run without a fresh matrix MUST warn `PORTFOLIO_STALE` or implicitly refresh the matrix (`--refresh` CLI flag).
- Version drift MUST be reported per technology: distinct versions, major spread and version per repository.
- Competing solutions to one problem MUST be detected through `problem_domain` from `portfolio-domain-map-v1` (e.g. two HTTP frameworks or logging libraries). Domains outside the table produce no duplicate claim.
- Convergence/divergence MUST be calculated over Change History windows: falling distinct-version and duplicate counts ⇒ `converging`; rising counts ⇒ `diverging`. Without history: `unknown`, never guessed.
- Every radar statement carries `ringReason`, evidence and confidence.

---

## 11. Greenfield Blueprint Advisor and scaffolding

### 11.1 Advisor

For a requested project kind (`api-service`, `worker`, `cli`, `library`, `web-app`, `mcp-server`), the advisor MUST provide:

1. directory layout derived from layout conventions of repositories with the same archetype;
2. dependency set with exact versions: one `BlueprintRecommendationV1` per topic (`http_framework`, `orm`, `validation`, `logging`, `config`, …);
3. toolchain (build, test, lint) with versions;
4. test setup (runner, layout);
5. CI skeleton (system, workflow files).

Requirements:

- Every recommendation MUST be justified by portfolio evidence: which repositories, how many, how recent and how healthy (complexity/maintainability/cycles of using repositories). Raw values appear in `components[].inputs`.
- Every recommendation MUST show alternatives with their own component breakdown and risks (`outdated_version`, `low_adoption`, `high_hotspot_share`, `version_divergence`, `single_repo_evidence`, …).
- Recommended versions MUST come from the portfolio (highest resolved version of the technology if `versionComparable`). Without opt-in enrichment, the advisor MUST NOT claim a latest registry version.
- When portfolio evidence is absent for a required topic, the gap MUST be explicit rather than replaced with an evidence-free recommendation.
- The advisor MUST work without an LLM: it deterministically evaluates Matrix, Conventions, Archetypes and Health data.

### 11.2 Blueprint scaffolding (optional)

Untangle MAY generate starting files from a blueprint. Safety rules (all MUST unless otherwise marked):

1. Scaffolding occurs only after an explicit user instruction (`--apply` in CLI; MCP `apply: true`). Every call without that instruction is a dry run.
2. Dry run is the default and returns a full preview: every file to create with path, size and content hash; optionally (`--show-content`) full content.
3. The target directory MUST be empty or absent. If it contains entries, including hidden files, the call MUST fail with `BLUEPRINT_TARGET_NOT_EMPTY`. `.git/` is the only permitted exception and only with `--allow-git-dir`.
4. Existing files MUST NEVER be overwritten; there is no `--force`.
5. The target MUST be within allowed roots (workspace roots or a path explicitly provided through CLI); apply path traversal and symlink checks from [`architecture.md`](./architecture.md) §23.1. A violation yields `BLUEPRINT_TARGET_OUTSIDE_ALLOWED`.
6. Written files receive no executable permissions; scaffolding runs no package installation, Git initialization or other commands. Next steps such as `pnpm install` appear only as text.
7. After writing, a generated-file manifest (`.untangle-blueprint.json` in the target) MUST contain `blueprintId`, `advisorVersion`, file list and hashes.
8. Writing MUST support atomic operations: complete generation first in a temporary area under the target, then rename. On failure, partial state is removed and the error reported.
9. In MCP, scaffolding is a mutating tool under [`spec.md`](./spec.md) §21.3: scope and target path MUST explicitly appear in the response.

---

## 12. Persistence in Qdrant

### 12.1 Collections

In addition to the layout in [`architecture.md`](./architecture.md) §11.1 (configurable prefix, `untangle_` default):

```text
untangle_portfolio_v1                    required; non-vector portfolio records
untangle_blueprints_<profile>_v1         optional; embedded Blueprint/Recommendation/Radar text
                                         for semantic search, a profile suffix following
                                         untangle_code_<profile>_v1
```


`untangle_portfolio_v1` uses dummy vectors like the metadata collection ([`architecture.md`](./architecture.md) §11.5). `untangle_blueprints_<profile>_v1` uses dense + bm25 like the code collection; RRF scores MUST NOT be compared with other collections ([`spec.md`](./spec.md) §13.4).

Status-only reads MUST NOT create collections as a side effect. Every scan writes under a `generation_id`; readers default to the last completed portfolio generation.

### 12.2 Payload `untangle_portfolio_v1`

One point per record, with discriminator `point_type`:

```ts
interface PortfolioPointPayloadV1 {
  schema_version: 1;
  point_type:
    | "technology_record"
    | "repository_profile"
    | "stack_matrix"
    | "convention"
    | "archetype"
    | "radar_entry"
    | "blueprint"
    | "blueprint_recommendation";
  workspace_id: string;
  repo_id?: string;                       // absent for workspace-wide records
  ref_id?: string;
  generation_id: string;
  analyzer_version: string;
  created_at_epoch_ms: number;

  // shared filter fields (set where applicable):
  technology_id?: string;
  technology_name?: string;
  technology_category?: string;
  ecosystem?: string;
  problem_domain?: string;
  version_resolved?: string;
  usage?: string;
  archetype?: string;
  convention_kind?: string;
  radar_ring?: string;
  blueprint_kind?: string;
  confidence_value?: number;
  confidence_basis?: "deterministic" | "heuristic";
  adoption_repo_count?: number;
  adoption_repo_share?: number;
  major_spread?: number;
  last_seen_at_epoch_ms?: number;

  // complete record as JSON:
  record: Record<string, unknown>;        // TechnologyRecordV1 | RepositoryProfileV1 | ...
}
```


Large records (Stack Matrix, blueprints with file lists) MUST follow the multipart/byte-budget logic in [`architecture.md`](./architecture.md) §11.7 (`logical_shard_id`, `part_index`, `part_count`, `write_id`, `checksum`).

### 12.3 Payload indexes

Keyword indexes MUST exist at least for:

```text
point_type, workspace_id, repo_id, ref_id, generation_id,
technology_id, technology_name, technology_category, ecosystem,
problem_domain, usage, archetype, convention_kind, radar_ring,
blueprint_kind, confidence_basis
```


Numeric indexes SHOULD exist for:

```text
confidence_value, adoption_repo_count, adoption_repo_share,
major_spread, last_seen_at_epoch_ms, created_at_epoch_ms
```


### 12.4 Payload `untangle_blueprints_<profile>_v1`

Optional. Points contain prepared text (e.g. “Recommended fastify 4.28 for api-service: used in 6 of 8 backend repositories, median maintainability 71, no cycles…”) plus the filter fields in 12.2 and `embedding_profile_id`, `embedding_truncated` following [`spec.md`](./spec.md) §10.3. This makes questions such as “which recommendation exists for background jobs?” searchable semantically. This collection is optional; every mandatory query (section 14) works without it through payload filters.

---

## 13. Optional online enrichment

- Default: entirely disabled. Without opt-in, the portfolio pillar MUST NOT contact registries or other internet endpoints.
- Configuration:

```ts
interface PortfolioEnrichmentConfig {
  enabled: boolean;                       // Default false
  registries: ("npm" | "pypi" | "crates" | "maven" | "nuget" | "go" | "composer")[];
  registryUrls?: Record<string, string>;  // custom mirrors allowed
  cacheTtlHours: number;                  // Default 168
  timeoutMs: number;
}
```


- When enabled, enrichment MAY add the latest published version, release date of the used version and deprecation flag per technology. These fields MUST be marked as `enrichment` with source and retrieval timestamp and MUST NOT mix with local evidence.
- Only package name and version MAY be transmitted: never source code, paths or workspace names.
- Enrichment failures fall back to local operation with warning `ENRICHMENT_UNAVAILABLE`, never scan abortion.
- Health/status output MUST show active enrichment and target endpoints (transparency principle in [`spec.md`](./spec.md) §24).

---

## 14. Interface

### 14.1 CLI

New command group (global options from [`spec.md`](./spec.md) §20.1 apply):

```text
untangle portfolio scan [--repo <id,...>] [--refresh-history] [--background]
untangle portfolio stacks [--category <c,...>] [--include-transitive] [--min-adoption <share>]
untangle portfolio who-uses <tech> [--version <range>] [--category <c>] [--depth]
untangle portfolio conventions [--kind <k,...>] [--min-confidence <v>] [--show-counterexamples]
untangle portfolio archetypes [--repo <id,...>] [--explain]
untangle portfolio radar [--ring <r,...>] [--category <c,...>] [--domain <d>]
untangle portfolio blueprint <kind> [--language <lang>] [--out <dir>] [--apply]
                              [--show-content] [--allow-git-dir] [--topics <t,...>]
```


Requirements:

- Every read command supports `--format text|json|jsonl|markdown`; JSON contains the unmodified data contracts from section 7.
- `who-uses` MUST support both directions: default technology → repositories (version, usage, depth with `--depth`); `--repo` filters to one repository.
- `blueprint` without `--out` returns only a report; with `--out` and no `--apply`, a dry run with full file preview; `--apply` writes according to section 11.2.
- Exit codes: `0` success, `2` configuration/infrastructure error, `3` incomplete analysis when completeness was requested (`--strict`), `4` cancelled, consistent with [`spec.md`](./spec.md) §18.3.

### 14.2 MCP tools

New tools (envelope under [`spec.md`](./spec.md) §21.2; every response in `data`):

```text
untangle_portfolio_scan
untangle_stack_matrix
untangle_who_uses
untangle_conventions
untangle_archetypes
untangle_tech_radar
untangle_blueprint
```


#### `untangle_portfolio_scan`

```ts
interface PortfolioScanInputV1 {
  workspaceId?: string;
  repositories?: string[];
  refreshHistory?: boolean;        // recalculate trends from Change History
  background?: boolean;
}

interface PortfolioScanResultV1 {
  schemaVersion: 1;
  jobId: string;
  generationId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  repositoriesPlanned: number;
  repositoriesCompleted: number;
  technologiesDetected?: number;
  conventionsDetected?: number;
  warnings: string[];
}
```


`background: true` MAY return `jobId` immediately; progress through `untangle_status`.

#### `untangle_stack_matrix`

```ts
interface StackMatrixInputV1 {
  workspaceId?: string;
  categories?: string[];
  includeTransitive?: boolean;     // Default false
  minAdoptionShare?: number;       // Default 0
  generationId?: string;           // default: last completed
}

// Output: data: StackMatrixV1 (section 7.3), optionally filtered
```


#### `untangle_who_uses`

```ts
interface WhoUsesInputV1 {
  technology: string;              // name or technologyId
  workspaceId?: string;
  versionRange?: string;           // SemVer range filter over versionResolved
  includeDepth?: boolean;          // importingFileCount per repository
  includeDeclaredOnly?: boolean;   // Default true
}

interface WhoUsesResultV1 {
  schemaVersion: 1;
  technology: { technologyId: string; name: string; category: string; ecosystem?: string };
  generationId: string;
  usages: {
    repoId: string;
    repoLabel: string;
    refId: string;
    versionRaw?: string;
    versionResolved?: string;
    usage: string;
    declaredOnly: boolean;
    importOnly: boolean;
    importingFileCount?: number;
    firstSeenAt?: string;
    lastSeenAt?: string;
    provenance: PortfolioProvenanceV1[];
  }[];
  notUsingRepoIds: string[];
  warnings: string[];
}
```


Unknown technology ⇒ error `TECHNOLOGY_UNKNOWN` with similar-name suggestions (`details.suggestions`), rather than an empty successful result.

#### `untangle_conventions`

```ts
interface ConventionsInputV1 {
  workspaceId?: string;
  kinds?: string[];
  minConfidence?: number;          // Default 0.5
  includeCounterexamples?: boolean;// Default true
}

interface ConventionsResultV1 {
  schemaVersion: 1;
  generationId: string;
  conventions: ConventionV1[];
  suppressedCount: number;
  warnings: string[];
}
```


#### `untangle_archetypes`

```ts
interface ArchetypesInputV1 {
  workspaceId?: string;
  repositories?: string[];
  explain?: boolean;               // output complete signals, default true
}

interface ArchetypesResultV1 {
  schemaVersion: 1;
  generationId: string;
  classifierVersion: string;
  assignments: ArchetypeV1[];
  warnings: string[];
}
```


#### `untangle_tech_radar`

```ts
interface TechRadarInputV1 {
  workspaceId?: string;
  rings?: ("adopt" | "maintain" | "consolidate" | "retire")[];
  categories?: string[];
  problemDomain?: string;
}

interface TechRadarResultV1 {
  schemaVersion: 1;
  generationId: string;
  radarVersion: string;
  entries: TechRadarEntryV1[];
  historyAvailable: boolean;
  warnings: string[];
}
```


#### `untangle_blueprint`

```ts
interface BlueprintInputV1 {
  kind: "api-service" | "worker" | "cli" | "library" | "web-app" | "mcp-server";
  workspaceId?: string;
  language?: string;               // default: dominant portfolio language for this kind
  topics?: string[];               // restrict to topics
  targetDir?: string;              // enables scaffolding path validation
  apply?: boolean;                 // Default false ⇒ Dry-Run
  showContent?: boolean;           // Default false
}

interface BlueprintResultV1 {
  schemaVersion: 1;
  blueprint: BlueprintV1;
  recommendations: BlueprintRecommendationV1[];
  scaffold?: {
    mode: "dry_run" | "applied";
    targetDir: string;
    files: BlueprintFileV1[];
    manifestPath?: string;         // only for "applied"
  };
  warnings: string[];
}
```


`apply: true` is mutating under [`spec.md`](./spec.md) §21.3: the response's text segment MUST explicitly name the target directory, and all section 11.2 safety rules apply.

### 14.3 Programmatic API

`@untangle-code/core` SHOULD add:

```ts
interface UntangleEngine {
  // existing methods from spec.md §22 …
  portfolioScan(request: PortfolioScanInputV1): AsyncIterable<JobEvent>;
  stackMatrix(request: StackMatrixInputV1): Promise<StackMatrixV1>;
  whoUses(request: WhoUsesInputV1): Promise<WhoUsesResultV1>;
  conventions(request: ConventionsInputV1): Promise<ConventionsResultV1>;
  archetypes(request: ArchetypesInputV1): Promise<ArchetypesResultV1>;
  techRadar(request: TechRadarInputV1): Promise<TechRadarResultV1>;
  blueprint(request: BlueprintInputV1): Promise<BlueprintResultV1>;
}
```


All methods MUST support Abort Signals.

### 14.4 Configuration

`UntangleConfigV1` gains an optional field (normative definition here; entry in `spec.md` §4.2: see section 18):

```ts
interface PortfolioConfig {
  enabled?: boolean;                        // Default true
  includeTransitive?: boolean;              // Default false
  conventionMinRepos?: number;              // Default 2
  conventions?: {
    pinned?: string[];                      // conventionIds
    suppressed?: string[];
  };
  radar?: {
    adoptShareMin?: number;                 // Default 0.5
    maintainShareMin?: number;              // Default 0.2
    retireAfterDays?: number;               // Default 540
  };
  blueprint?: {
    weights?: {
      adoption?: number; recency?: number;  // Defaults 0.40 / 0.20
      health?: number; versionConsistency?: number; // 0.25 / 0.15
    };
  };
  enrichment?: PortfolioEnrichmentConfig;   // section 13, default disabled
}
```


Weights MUST validate to a sum of 1.0 (tolerance ±0.001), otherwise `CONFIG_INVALID`.

---

## 15. Error classes

In addition to [`spec.md`](./spec.md) §25.1:

```text
PORTFOLIO_INCOMPLETE            portfolio generation incomplete; partial result only with explicit opt-in
PORTFOLIO_GENERATION_MISSING    no completed portfolio generation; scan required
PORTFOLIO_STALE                 underlying index/graph generation newer than portfolio generation
MANIFEST_PARSE_FAILED           individual manifest cannot be parsed (warning, no abortion)
TECHNOLOGY_UNKNOWN              requested technology absent from portfolio
BLUEPRINT_KIND_UNKNOWN          unsupported blueprint kind
BLUEPRINT_EVIDENCE_INSUFFICIENT no portfolio evidence for required topic and no explicit permission for gaps
BLUEPRINT_TARGET_NOT_EMPTY      scaffolding target exists and is not empty
BLUEPRINT_TARGET_OUTSIDE_ALLOWED scaffolding target outside allowed roots or symlink escape
BLUEPRINT_WRITE_FAILED          scaffolding write error; partial state removed
ENRICHMENT_DISABLED             enrichment requested but not enabled
ENRICHMENT_UNAVAILABLE          registry unavailable; local operation continues (warning)
```


The principles in [`spec.md`](./spec.md) §25.2 remain unchanged: not found ≠ infrastructure error; scaffolding fails closed; reads degrade in a controlled way with visible warnings.

---

## 16. Tests and conformance

### 16.1 Test levels

- Unit tests per detector: fixture manifest → expected `TechnologyRecordV1` set, including confidence and provenance (golden tests).
- Determinism tests: two scans of identical fixtures yield identical IDs and records (excluding `generatedAt`).
- Merge tests: manifest + lockfile + import evidence for one technology ⇒ one record with correct precedence.
- Convention tests: fixtures with known conventions and built-in counterexamples ⇒ confidence from formula 7.4.
- Archetype golden tests: at least one fixture per archetype; compare score, signals and alternatives.
- Radar tests: assignment to all four rings, including rule order and `unknown` trend without history.
- Blueprint tests: recommendations with full component breakdown; `BLUEPRINT_EVIDENCE_INSUFFICIENT` for an empty portfolio.
- Scaffolding safety tests: nonempty target, symlink escape, dry-run default, no overwrite, manifest generation and cleanup after injected write failure.
- MCP contract tests for all seven tools, including envelope, error codes and mutating `apply` path.
- CLI snapshot tests for `stacks`, `who-uses`, `radar`, `blueprint` in `text` and `json`.
- Qdrant integration tests: collection provisioning, payload indexes, generation changes, multipart matrix.

Unit tests MUST NOT use real Qdrant, Ollama or network access; ports are mocked through the testkit.

### 16.2 Required fixtures

In addition to [`spec.md`](./spec.md) §27.2:

1. TypeScript monorepo with pnpm workspace, ESLint, Vitest, GitHub Actions;
2. Python service with `pyproject.toml`, Ruff, Pytest, Dockerfile, Compose with Postgres and Redis;
3. Go service with `go.mod`, Kafka client and no HTTP framework (worker archetype);
4. library repository without entry points;
5. infrastructure repository with only Terraform and CI;
6. portfolio with intentional version divergence in one library (three major versions);
7. portfolio with two competing solutions in one problem domain (e.g. two logging libraries);
8. repository with a Phantom Dependency (import without declaration) and a declared-only dependency;
9. broken manifest (syntax error) to test degradation;
10. empty and nonempty target directories for scaffolding.

---

## 17. Definition of Done for `portfolio-v1`

The portfolio pillar is functionally complete when:

1. `untangle portfolio scan` runs across all configured repositories, works incrementally and persists a completed generation in `untangle_portfolio_v1`;
2. the technology inventory captures all 6.1 categories through 6.3 detectors with provenance and confidence;
3. import evidence exposes declared-only and Phantom Dependencies;
4. Stack Matrix and `who-uses` answer both directions with version spread, first/last use and usage depth;
5. conventions are reported with evidence, counterexamples and confidence from formula 7.4;
6. archetype classification is deterministic with complete signals and alternatives;
7. Tech Radar deterministically explains rings, version drift, duplicates and trends when history exists;
8. Blueprint Advisor provides recommendations for all six project kinds with component breakdown, alternatives and risks, explicitly reporting evidence gaps;
9. scaffolding demonstrably satisfies every 11.2 safety rule through tests;
10. all seven MCP tools and the CLI command group work with versioned JSON contracts;
11. online enrichment is strictly opt-in and its failure does not impair local operation;
12. every section 15 error class is implemented and tested;
13. section 16 determinism, golden, safety and contract tests pass.

---

## 18. Integration into existing documents

This document does not change existing documents. The following additions are due at the next revision:

### 18.1 `spec.md` (spec-v1 → spec-v1.1)

- **§4.2 Main schema:** add `portfolio?: PortfolioConfig;` to `UntangleConfigV1`; reference `portfolio.md` §14.4.
- **§10.1 Collection strategy:** add `{prefix}portfolio_v1` (required when portfolio is enabled) and `{prefix}blueprints_{profile_short_id}_v1` (optional).
- **§20.2 Commands:** add `untangle portfolio scan|stacks|who-uses|conventions|archetypes|radar|blueprint` to the command list.
- **§21.1 Tool names:** add `untangle_portfolio_scan`, `untangle_stack_matrix`, `untangle_who_uses`, `untangle_conventions`, `untangle_archetypes`, `untangle_tech_radar`, `untangle_blueprint`.
- **§21.3 MCP safety:** add “`untangle_blueprint` with `apply: true` is mutating; target path and empty-directory checks follow `portfolio.md` §11.2.”
- **§25.1 Error classes:** add the codes from `portfolio.md` §15.
- **§27.2 Required fixtures:** add fixtures 1–10 from `portfolio.md` §16.2 as items 11 onward.
- **§28 Definition of Done:** add “16. Portfolio Intelligence under `portfolio-v1` (Scan, Matrix, Conventions, Archetypes, Radar, Blueprint Advisor) works,” or mark as a Beta criterion if portfolio belongs to Public Beta.
- **§29 Out of scope:** clarify that automatic migration of existing repositories to blueprints and mandatory registry queries stay excluded.

### 18.2 `product.md`

- **§1 Product summary:** add “Portfolio overview: technology inventory, Stack Matrix, conventions, architecture archetypes, Tech Radar and Greenfield Blueprints.”
- **§3 Personas:** for 3.2 (Tech Lead) and 3.4 (Platform Team), add the jobs “Who uses what?”, “Enforce convergence” and “Define starting architecture for new services”; optionally add a Staff Engineer / Architect with Greenfield Assignment persona.
- **§4 User journeys:** add “4.7 Greenfield start with portfolio evidence” (scan → radar → blueprint → optional scaffolding) with example commands.
- **§8 Scope:** add “8.7 Portfolio Intelligence & Architecture Harness” with the capability list from `portfolio.md` §2.1.
- **§9 MCP tool portfolio:** add group “9.5 Portfolio” with the seven tool names.
- **§10 CLI product scope:** add `untangle portfolio …` lines.
- **§13 MVP/Beta/GA:** assign portfolio to Public Beta (Scan/Matrix/who-uses may be near MVP), scaffolding as a Beta feature.
- **§15 Product metrics:** add time to first Blueprint recommendation, proportion of recommendations with complete evidence and version convergence over time.

### 18.3 `architecture.md` (architecture-v1 → v1.1)

- **§5 Monorepo structure:** add `packages/portfolio/` (detectors, Matrix, Conventions, Archetypes, Radar, Blueprint Advisor, scaffolding writer). Dependency rules: `portfolio` consumes `domain`, file/symbol graph ports, Complexity and Change read models; it MUST NOT depend on CLI/MCP.
- **§6 Core modules:** add “6.15 Portfolio Engine” with the pipeline from `portfolio.md` §9.1.
- **§10 Data model:** reference the eight contracts in `portfolio.md` §7.
- **§11.1 Collection Layout:** add `untangle_portfolio_v1` and `untangle_blueprints_<profile>_v1`; explicitly extend the §11.5 no-create-as-side-effect rule to portfolio collections.
- **§21.1 Lock Keys:** add `workspace:<workspace_id>:portfolio` for exclusive portfolio scans.
- **§23 Security:** document scaffolding path rules (empty target, no overwrite, temporary files and rename) as a Path Sandbox use case.
- **§29 ADRs:** add “ADR-009: Portfolio records as non-vector points in one collection with a `point_type` discriminator; optional embedding collection per profile,” justified by one operational component and sufficient payload filters for mandatory queries.
- **§30 Implementation order:** add “Phase I — Portfolio Intelligence” after Phase G (requires File Graph, Complexity, Change History; independent of Phase H and parallelizable).

### 18.4 `vision.md`

- **§7 Strategic product pillars:** add “7.7 Portfolio Intelligence & Architecture Harness”: Untangle answers both “Where is the logic?” and “How do we build software here, and how do we start the next project correctly?”
- **§1 Vision:** add a fifth question: “5. Which technologies and conventions does the portfolio use, and what is the right starting architecture for new work?”
- **§9 Differentiation:** add table row “Tech Radar/EA tools | manual maintenance | automatically derived from manifests, graphs and history, with evidence and confidence.”
- **§12 Development horizons:** add portfolio inventory, Stack Matrix, conventions, archetypes, Tech Radar and Blueprint Advisor to Horizon 2; governance aspects (policy packs on radar rings) remain Horizon 3.
