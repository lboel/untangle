# Untangle — Product Definition

**Status:** Draft 0.1  
**Product:** Untangle  
**Goal:** Define product scope, user experience, distribution and the release plan.  
**Related documents:** [`vision.md`](./vision.md) · [`spec.md`](./spec.md) · [`architecture.md`](./architecture.md)

**Scope note:** This document defines the product's target state. The repository-built surface that
is verifiably available today is listed in the README project status; npm publication, plugins,
change history and quality gates remain planned where that status marks them as open.

---

## 1. Product summary

Untangle is a local search and complexity harness for Spec Driven Development and
Agentic Engineering. It adds repository context, declared feature responsibility and
verifiable implementation evidence to existing agent hosts. The product goal is to let
teams develop from specs while keeping complexity per feature small and visible.
The target scope connects CLI, MCP, npm API and plugins; today's repository build already
provides indexing, search, graphs, code complexity and Search Journeys. The complete target scope is:

- hybrid semantic and lexical code search;
- cross-repository search with repository, branch, path, language and symbol filters;
- AST-based, lossless chunking;
- file dependency and symbol call graphs;
- Impact Analysis, Blast Radius and Call Flow;
- Context Artifacts such as SQL schemas, OpenAPI, architecture and infrastructure files;
- cyclomatic and cognitive complexity;
- structural, textual, syntactic, Halstead and coupling metrics;
- before/after analysis of code changes;
- Complexity History, Hotspots, Change Risk and Quality Gates;
- explicitly recorded Search Journeys and dynamic Product Complexity indicators.

The product is not a standalone chat application. It delivers reliable, structured and reusable evidence to existing development environments and agents.

---

## 2. Positioning

### 2.1 Category

**Local search and complexity harness for spec-driven agentic engineering.**

The primary use case is a coding agent implementing a requirement from a spec in an
existing codebase. Untangle provides search context and quality evidence through CLI and
MCP. A project without specs can start with direct code analysis and add feature
declarations later.

### 2.2 Core message

> **Specs describe the goal. Untangle connects declared features to code, tests and
> ownership, making their complexity and agents' search effort visible.**

Public short form: **Keep spec-driven code easy to change.**

### 2.3 Value proposition

- **Understand the task:** Bring vision/spec references, declared feature boundaries, criteria and owners together.
- **Find the implementation:** Use local search paths and graphs for relevant symbols, callers and dependencies.
- **Assess the complete scope:** Show feature complexity including helpers and shared code; report tests separately.
- **Check the evidence:** Bind explicitly executed Vitest runs to sources and test identities; keep missing or stale evidence visible.
- **Observe search effort:** Use explicitly recorded attempts and reformulations as investigation signals for understandability.

The further goal is historical feature baselines, reliable before/after comparisons and
Quality Gates against additional complexity. An autonomous refactoring loop and automatic
semantic spec conformance are outside today's availability promise.

### 2.4 Main differentiation

The core distinction is the connection between **search, code complexity and declared
feature responsibility**. A spec describes the desired behavior; the feature map names
the code/test scope to inspect and its responsibility. Search and graphs help agents
understand that scope. Feature reports and Search Journeys expose different costs: the
structural complexity of the implementation and the observed effort required to find it.

The built core connects:

```text
Spec references + declared features/ownership + Retrieval + AST/Graph + Code Complexity + Search Journeys
```

Search, code and test metrics retain their own scope and provenance. A successful search
compensates for neither an exceeded complexity budget nor missing test evidence.
Extensions can add external analyzer findings. Historical change and risk models remain
target scope wherever project status does not yet identify them as built.

With explicit recording, Untangle can observe how hard a real product goal was for an
agent to locate. The question then includes how many searches, query reformulations,
candidates and navigation steps separated an intent from the confirmed target, alongside
the complexity of a file or function. Each task produces an evidence-bearing vector of
**Dynamic Search Complexity** indicators. **Dynamic Product Complexity** emerges only
from multiple completed, comparable journeys; Untangle reduces neither a task nor a cohort
to an opaque number and does not confuse either with Cognitive Complexity.

### 2.5 English product thesis

> **Product complexity is the distance between intent and implementation.**

When an agent receives a product request, how quickly and precisely can it find the explicitly
confirmed implementation target for the change? If the right implementation surface is easy to
find across repeated, comparable search journeys, that is evidence of a product that is
well-defined, clear, and easy to understand.

When discovery requires repeated reformulations, wide candidate sets and many navigation hops,
the observed effort may also reflect product-model ambiguity: unclear language, blurred
responsibilities and boundaries that do not map cleanly from user intent to code.

**Untangle turns that search effort into evidence.** Static metrics describe code. Search Journeys
provide a task-level signal about how understandable the product is in motion. A completed journey
closes the bounded discovery record when its caller explicitly confirms an implementation target;
active and abandoned journeys remain open. Whether the product creates value remains feedback-open
and belongs to real use, judgment and time. The resulting measurement is a sensor, not truth.
Persisted journeys are learning artifacts; v1 groups compatible runs into timeless cohorts and does
not claim a temporal trend or built-in before/after view.

Complicated work can become sufficiently verifier-closed for a named scope; complex reality remains
feedback-open. Untangle therefore treats executable checks as bounded evidence and leaves product
meaning and value open to observation in the world.

Comparable means more than sharing a retrieval configuration. Measurement-context v2 records the
ranker, ranking policy and limits together with each profile's associated embedding profile, index
generations and immutable corpus revision. Unversioned legacy contexts remain readable and visible
but can never be sufficient evidence. Callers can additionally declare their agent model, harness,
search strategy, task class, task mix and prior context. Different declared conditions remain in
separate cohorts; Untangle does not independently verify them or normalize the workload. The
signal therefore cannot assign causality to the product alone.

Short form: **Easy to find is evidence of a product that is easy to understand.**

### 2.6 Feature Probe: two axes, one inspectable mapping

A Feature Probe binds a caller-declared stable feature ID to one or more real Search Journeys.
Untangle pseudonymizes that identifier by default, observes how an agent searches the workspace,
and records the implementation target the agent explicitly confirms. It does not independently
verify feature semantics, stability or code ownership. The resulting feature-to-code mapping keeps
two questions separate:

1. **Search axis — how hard was the confirmed implementation target to find?** Searches,
   reformulations, candidate breadth, churn, navigation and target rank answer this question.
2. **Code axis — what structural complexity did the accepted indexed target carry?** Versioned
   metrics and their exact target/index provenance answer this question when the search hit contains
   sufficient evidence.

There is no combined score and no premise that a complex feature has a “complex embedding.”
Embeddings are retrieval representations. A feature can legitimately span several simple targets;
a small target can still be difficult to find. Keeping both axes visible lets teams ask whether the
product is as simple as possible and as complex as necessary without confusing retrieval friction
with control-flow complexity.

**Relation to Sentrux and SocratCode.** Neither is a shipped dependency of the Wave 9 path. Sentrux
is the repository-researched reference for a complementary structural-analysis lane and has
explicit follow-up work packages. SocratCode is retained only as a user-supplied conceptual
reference for reflective code-feedback loops; this repository does not yet claim a researched
capability mapping or integration for it. Static analyzers can surface structural and
cognitive-debt signals; Untangle's Search Journeys surface retrieval friction between product
language and implementation. A future evidence loop may connect those observations before and
after a verified change, but it must preserve their separate provenance and must not let a good
result on one axis compensate for a harmful result on another. The product principle is therefore
not “minimize every metric.” It is to keep product and code as simple as possible and as complex as
necessary, without silently accumulating cognitive debt.

The current loop ends at a confirmed implementation target. The complete product-learning loop is
broader: target → change → executable verifier → structural before/after evidence → real-use
feedback → revised product constraints. Those later lanes stay linked but separately interpretable;
they are not yet implemented by the Search Journey report.

Borrowing FOOL as a practical working vocabulary rather than a scientific maturity model, Untangle
observes one specific seam: whether a product's **Ontology**—its language, concepts and ownership
boundaries—maps cleanly to its **Operations** in code. It does not score **Foundation** or **Love**:
the intended human outcome and quality in real use remain feedback-open. A caller-confirmed target
can close the discovery record for a bounded task, but more context or tokens buy more search
attempts, not truth. Durable, inspectable Search Journeys turn those attempts into organizational
memory that can be revisited, compared and corrected.

---
## 3. Personas and Jobs-to-be-Done

### 3.1 Feature Engineer

**Situation:** A change affects unfamiliar or historically evolved code.  
**Job:** Quickly find the relevant logic, callers, callees, tests and contracts.  
**Success:** The change is implemented without overlooking a dependency.

Key capabilities:

- semantic search;
- symbol overview;
- Impact Analysis;
- relevant tests and Context Artifacts;
- Change Report after the patch.

### 3.2 Maintainer or Tech Lead

**Situation:** The team changes several services and libraries in parallel.  
**Job:** Detect architectural drift, new cycles and complexity growth.  
**Success:** New regressions become visible before merge.

Key capabilities:

- cross-repository graph;
- Hotspots;
- Complexity Trends;
- Quality Gates;
- CI and PR output.

### 3.3 AI Coding Agent

**Situation:** An agent must complete a task in a large codebase.  
**Job:** Obtain reliable context with a small number of tool calls.  
**Success:** The agent opens fewer irrelevant files and makes fewer incorrect assumptions.

Key capabilities:

- MCP tools with JSON output;
- search-before-read workflow;
- explicit Search Journeys with a measurable retrieval funnel;
- symbol, impact and flow tools;
- Change Verification;
- compact, bounded results.

### 3.4 Developer Experience or Platform Team

**Situation:** Several tools and teams need the same code intelligence.  
**Job:** Provide a private engine that can run centrally or locally.  
**Success:** CLI, IDE, CI and agents use consistent data models.

Key capabilities:

- external Qdrant and Ollama endpoints;
- workspace configuration;
- stable IDs and schema versions;
- Health, Observability and migrations;
- npm and plugin distribution.

---

## 4. Primary user journeys

## 4.1 Zero-configuration entry through npm

**Built entry V1:** From the repository build, `untangle init [PATH]` can already
inspect a specified project directory and propose a commented `untangle.toml`.
The noninteractive workflow probes services but does not start them; `--offline` skips
these network probes. The following npm and infrastructure steps remain the target
experience until their respective publication or implementation; the README describes
the current installation path.

The local product-context report captures candidates for vision, specification and an
optional product description with paths, content hashes, sections and document references.
`--vision=PATH` and `--spec=PATH` explicitly select sources relative to the project directory;
filename candidates remain provisional. Missing, ambiguous or incompletely inspected
sources receive their own status. Document assessment is bounded at 16,384 UTF-16 code units
per line, 4,096 `[` characters and 2,048 heading candidates per document. Exceeding a bound
preserves the hash, sets the source to `not_assessed` and the report to `incomplete`.
The editable review draft appears in `untangle init --format=json`, even when documents
are missing. It begins with empty feature and ownership lists and open questions.
Domain alignment with code remains `unverified`; a discovered document reference is only
path/hash evidence. Selected readable documents are referenced as Markdown
`contextArtifacts` in the proposed configuration. V1 generates no product documents,
requires no LLM for this report and starts no journey. Confirmed feature identities,
ownership and behavioral evidence remain the foundation of the broader target state.

```bash
npx -y @untangle-code/cli init
npx -y @untangle-code/cli index
npx -y @untangle-code/cli search "authentication middleware"
```


Expected experience:

1. Untangle detects the project root and Git metadata.
2. It probes native Qdrant/Ollama endpoints or starts managed containers.
3. It downloads the configured embedding model when needed.
4. It indexes code, creates metrics and builds graphs.
5. It saves checkpoints and optionally starts the watcher.
6. The first search returns repository, file, lines, symbol, score and metrics.

## 4.2 Installation as an MCP server

Per project or per user:

```json
{
  "mcpServers": {
    "untangle": {
      "command": "npx",
      "args": ["-y", "@untangle-code/cli", "mcp", "--stdio"]
    }
  }
}
```


Expected experience:

- The host discovers the tools automatically.
- The first `workspace_index` call sets up the infrastructure.
- Further sessions detect existing indexes and start incremental reconciliation.
- Tool output is both human-readable and structured.

## 4.3 Installation as an agent plugin

A plugin bundle contains:

- host manifest;
- MCP server configuration;
- skills and workflow instructions;
- commands for Index, Search, Impact and Change Review;
- version and compatibility metadata.

The plugin always starts the published engine from `@untangle-code/cli`. It contains no divergent copy of the analysis implementation.

## 4.4 Cross-repository workspace

The user defines a workspace file:

```json
{
  "$schema": "https://untangle.dev/schema/config-v1.json",
  "workspaceId": "commerce-platform",
  "repositories": [
    { "id": "backend", "path": "../backend", "label": "Backend API" },
    { "id": "frontend", "path": "../frontend", "label": "Web App" },
    { "id": "identity", "path": "../identity", "label": "Identity Library" }
  ],
  "search": {
    "defaultRepositories": ["backend", "frontend", "identity"]
  }
}
```


Then:

```bash
untangle workspace index
untangle search "where is refresh token rotation implemented" --repo backend,identity
untangle impact IdentityClient.rotateToken --cross-repo
```


## 4.5 Complexity assessment of a change

```bash
untangle changes analyze --base main --head HEAD
```


Output:

- changed files and symbols;
- rename and move candidates;
- cyclomatic/cognitive delta;
- new or removed imports and calls;
- new or removed cycles;
- Blast Radius;
- Risk Score with components;
- Quality Gate result.

## 4.6 IDE experience

The VS Code extension shows:

- status bar with index state;
- workspace/repository overview;
- search view;
- symbol and graph view;
- Complexity CodeLens above functions and methods;
- diagnostics for new gate violations;
- before/after hover for Git changes;
- commands that call the same CLI/MCP operations.

## 4.7 Dynamic Search Complexity from an agent task

An agent might receive the task “Improve the presentation of cards in the profile area.”
It starts a local Search Journey through `untangle_search_session` and can assign the
caller-declared stable feature ID `profile.cards.presentation`. Task text and feature ID
are stored by default only as separate, workspace-local, domain-separated HMAC-SHA-256
fingerprints. Each subsequent `untangle_search` request can attach to the journey with
`session: { id, step }` without changing hits, scores or ranking; only the visible
observation reference is added.

Untangle observes the retrieval funnel:

1. how many search attempts and distinct query fingerprints were necessary;
2. which embedding profiles, index generations and immutable corpus revisions were actually searched together;
3. how large the eligible candidate set was and how it was distributed across files;
4. which hits were returned at which profile-local ranks;
5. which file, symbol or graph steps the agent explicitly reported;
6. when the agent confirmed the target with a file, symbol or chunk locator;
7. which versioned static complexity evidence the accepted hit carried in that exact index generation, or why it could not be assigned safely.

Known generations belong to the searched profile group, not only to final hits. This keeps
a healthy attempt comparable even when ranking or relevance policy discards all candidates;
if no generation is known for a no-hit search, the measurement context remains visibly
incomplete. The same applies without the `corpusRevisionFingerprint`, which only a
successfully completed index state derives from the full confirmed file/content manifest.
Running, cancelled and failed states must not claim it. A measurement-healthy search profile
group binds the associated completed repository, ref, generation and corpus fingerprints
again in its own `corpusRevisionFingerprint`; if a link is missing, search remains usable
but its measurement context is incomplete.

Only explicit completion marks a hit as the accepted target. Untangle may therefore report
the rank, reciprocal rank, score margin and search effort for that target, but cannot claim
precision for the other unlabeled candidates. Abandoned and active journeys remain visible
in counts but do not enter Product Complexity cohorts. Cohorts are separated by ranker,
text-free ranking context, effective result/candidate limits and the per-profile connection
between embedding profile, index generations and corpus revision. Only at least three
completed journeys with complete measurement context constitute sufficient evidence for the
heuristic cohort signal. The v1 report has no timeline or before/after view.

Completeness additionally means every counted successful attempt carries
`measurementContextVersion: 2`, retrieval diagnostics and the same complete tuple of ranker,
ranking context, result/candidate limits and associated profile records containing embedding
profile, index generations and `corpusRevisionFingerprint`. These three profile components
remain connected rather than independently sorted sets. If a field is missing or this tuple
changes within a journey, the context remains visible but incomplete and insufficient.
Legacy contexts without version or corpus binding remain readable and visible in the report;
report construction always treats them as incomplete.

The workspace cohort report remains backward-compatible for existing general journeys.
Feature→code statements appear exclusively in `featureMappings`: Untangle groups by feature
fingerprint **and** `measurementContextId`, guesses no feature for older sessions and presents
search and code axes separately. Incomplete measurement contexts remain visible but can never
reach `sufficientEvidence: true`. Confirmed targets and their complexity variants are not
averaged across metric scope, metric version or index generation. Missing, ambiguous or legacy
metric references remain visibly `unavailable`; they are never interpreted as zero complexity.
Different locator precision can represent the same physical code surface as multiple targets.
`sessionCounts.featureTaggedCompleted` counts exactly all completed, explicitly tagged
journeys; the sum of `featureMappings[*].search.completedSessionCount` must agree with it.
The mapping remains caller evidence and independently verifies neither feature semantics nor
domain correctness, stability or code ownership.

Agent model, harness, prior context and search strategy are not yet part of the v1 measurement
context. Cohorts are therefore comparable only under externally controlled caller conditions
and cannot attribute causality solely to the product. Task mix and sampling are not normalized;
the cohort describes the workload actually observed.

Without `acceptedAttemptId`, Untangle counts every search attempt until completion and assigns
rank and score margin to the last matching attempt with a visible caveat. An explicit attempt
ID can deliberately close the search portion earlier and is retained additively in the outcome
of new completions for exact validation; existing outcomes without the field remain readable.
A partial provider or profile failure makes the context incomplete; the same applies to an
entirely failed attempt that is still counted as effort. Such journeys can never produce
`sufficientEvidence: true` on their own.

---

## 5. Product surfaces

| Surface | Purpose | Distribution |
|---|---|---|
| CLI | local use, scripting, CI | npm `@untangle-code/cli` |
| MCP Server | AI hosts and agents | in the CLI package, `mcp` subcommand |
| Core SDK | programmatic API | npm `@untangle-code/core` |
| Plugin SDK | host adapters and third-party plugins | npm `@untangle-code/plugin-sdk` |
| VS Code Extension | interactive IDE interface | VS Code Marketplace and Open VSX |
| Agent Plugins | skills, manifests, commands | GitHub Marketplace/host marketplace |
| GitHub Action | PR and quality gate checks | Marketplace and repository action |
| Docker Compose | local infrastructure startup | release assets and npm package |

---

## 6. npm and package strategy

### 6.1 Naming decision

The brand remains **Untangle** and the shell command remains `untangle`. Because the unscoped npm package `untangle` already exists, official packages are published under a dedicated scope. Working scope:

```text
@untangle-code
```


This scope must be reserved before publication and may be adjusted after the branding decision.

### 6.2 Public packages

| Package | Role | Public |
|---|---|---:|
| `@untangle-code/cli` | CLI, MCP runtime, infrastructure bootstrap | yes |
| `@untangle-code/core` | stable programmatic API and domain types | yes |
| `@untangle-code/config` | configuration loader and JSON schemas | yes |
| `@untangle-code/plugin-sdk` | adapter contract for hosts and plugins | yes |
| `@untangle-code/testkit` | fixtures, mock providers, contract tests | yes |
| `@untangle-code/action` | GitHub Action runtime | later |

Internal packages may remain private in the monorepo until their APIs stabilize.

### 6.3 CLI package

The package exports:

```json
{
  "name": "@untangle-code/cli",
  "type": "module",
  "bin": {
    "untangle": "dist/bin/untangle.js"
  },
  "exports": {
    ".": "./dist/index.js",
    "./mcp": "./dist/mcp.js",
    "./schema": "./dist/schema.js"
  },
  "engines": {
    "node": "^22.13.0 || >=24.0.0"
  },
  "files": [
    "dist",
    "assets",
    "docker",
    "schemas",
    "skills",
    "LICENSE",
    "README.md"
  ]
}
```


### 6.4 Installation paths

Temporarily through `npx`:

```bash
npx -y @untangle-code/cli index
```


Globally:

```bash
npm install --global @untangle-code/cli
untangle index
```


Per project:

```bash
npm install --save-dev @untangle-code/cli
npx untangle index
```


Programmatically:

```bash
npm install @untangle-code/core
```


### 6.5 Release channels

- `latest`: stable releases;
- `next`: public beta and release candidates;
- `canary`: commit-based test releases;
- SemVer for all public packages;
- synchronized versions for CLI, MCP manifests and official plugins;
- independent patch versions only for host UI-only packages when their compatibility range permits it.

### 6.6 Supply chain requirements

- npm Trusted Publishing or short-lived OIDC credentials;
- signed Git tags and GitHub Releases;
- npm Provenance;
- reproducible build;
- SBOM per release;
- `npm pack --dry-run` and tarball inspection in CI;
- no secrets, test data or local indexes in the package;
- minimal runtime dependencies;
- lockfile and dependency review;
- separate publish jobs per package with environment protection.

---

## 7. Plugin product strategy

### 7.1 Principle

Plugins provide distribution and workflow, not a second engine. The engine stays versioned through npm and testable. A host plugin contains at most:

- manifest;
- installation definition for `@untangle-code/cli`;
- skills and instructions;
- host commands;
- optional UI;
- compatibility metadata.

### 7.2 Supported hosts

**Public Beta:**

- generic MCP over stdio;
- Claude Code plugin/skill;
- Cursor plugin/skill;
- VS Code extension with MCP registration;
- Codex-compatible MCP configuration and skills.

**After Beta:**

- Gemini CLI extension;
- OpenCode;
- Cline/Roo/Continue-specific onboarding flows;
- JetBrains, provided a stable adapter path is defined.

### 7.3 Repository artifacts

```text
.claude-plugin/
.cursor-plugin/
.codex-plugin/
skills/
agents/
hooks/
mcp.json
server.json
gemini-extension.json
```


Each manifest references the same engine version or a compatible SemVer range.

### 7.4 Plugin compatibility contract

```json
{
  "pluginVersion": "0.3.0",
  "engine": {
    "package": "@untangle-code/cli",
    "range": ">=0.3.0 <0.4.0"
  },
  "protocol": {
    "mcpTools": 1,
    "resultSchema": 1
  }
}
```


A plugin must show understandable update instructions when the engine is incompatible.

---

## 8. Scope by product pillar

## 8.1 Indexing

- full index of a repository or workspace;
- incremental updates by hash and Git status;
- native file watchers with debounce;
- periodic reconciliation;
- checkpoint after each batch;
- cancellation and resume;
- parallel scanning and controlled embedding;
- ignore rules and size limits;
- branch-aware and optionally commit-aware snapshots;
- status, health and progress.

## 8.2 Search

- dense search through Ollama embeddings;
- BM25 through Qdrant sparse vectors;
- Qdrant RRF fusion;
- single- and cross-repository queries;
- filters by workspace, repository, ref, path, language, symbol and metrics;
- score components and provenance;
- deduplication at file/symbol scope;
- optional diversification;
- context expansion through symbol and graph relationships;
- semantic search in code, Context Artifacts and Change Events.

## 8.3 Graph Intelligence

- file import graph;
- re-exports and dynamic imports;
- symbol definitions and calls;
- edge confidence;
- reverse indexes;
- cycles and strongly connected components;
- entry-point detection;
- Symbol 360° View;
- Call Flow;
- Blast Radius;
- cross-repository edges through package/workspace resolvers;
- interactive visualization.

## 8.4 Complexity Intelligence

- classic and extended cyclomatic complexity;
- cognitive complexity with contributions;
- LOC/SLOC, comments, nesting and exit points;
- Halstead metrics;
- AST size, depth and node histogram;
- identifier and literal metrics;
- coupling and centrality;
- Maintainability Index;
- file-, repository- and workspace-level aggregates;
- complexity filters, Hotspots and Trends.

## 8.5 Change Intelligence

- base/head or working-tree comparison;
- symbol matching through stable IDs and fingerprints;
- Add, Modify, Delete, Rename and Move;
- AST, text, metric and graph deltas;
- new/removed cycles;
- Blast Radius assessment;
- Risk Score with components;
- persistent Change Events;
- semantic change search;
- Quality Gates on new deltas.

## 8.6 Context Artifacts

- declared artifacts from files or directories;
- SQL, OpenAPI, AsyncAPI, Protobuf, Markdown, ADR, Terraform, Kubernetes, Docker and other text formats;
- dedicated chunkers per format;
- separate artifact collection or point type;
- automatic staleness detection;
- name and type filters;
- links to code paths and symbols wherever deterministically possible.

## 8.7 Dynamic Product Complexity

- explicit start rather than silent or global telemetry;
- workspace-local, domain-separated HMAC-SHA-256 fingerprints of the task, an optional caller-declared stable feature ID and queries by default; no raw failure-reason text and never chunk or source text;
- optional, failure-tolerant attachment of ordinary searches to a Search Journey;
- separate capture of successful and failed retrieval attempts;
- profile- and generation-local candidate ranks, score margins and retrieval diagnostics;
- immutable `corpusRevisionFingerprint` only for completed index evidence; measurement context v2 preserves each profile's connection between embedding profile, generations and corpus revision;
- explicit navigation events and completion on an explicitly confirmed implementation target;
- separate static complexity evidence with provenance for the accepted hit, or a discriminated reason why it is not safely available;
- task-based indicators for searches, reformulations, candidate load, file dispersion, candidate churn, selection delay and tool/file hops;
- cohort aggregation only for compatible measurement contexts comprising ranker, search mode, ranking policy, effective limits and complete v2 profile records; legacy and other incomplete cohorts stay diagnostically visible but can never reach `sufficientEvidence: true`;
- feature mappings only for explicitly tagged journeys, separated by feature fingerprint and measurement context; exact `featureTaggedCompleted` accounting and no averaging of incompatible complexity variants;
- no opaque overall score, no “complex embeddings” and no precision claims for unlabeled candidates.

## 8.8 Declared feature alignment V1

`untangle product` and MCP `untangle_product` inspect an explicit feature map against
current local sources. Stable feature IDs, vision/spec headings, complete code/test
scopes, criteria and ownership declarations are connected through content hashes and
visible gaps. A feature's code complexity uses complete AST responsibilities rather
than embedding distances or individual search hits. Code and tests remain separate;
shared files are counted once in the total union.

An executed test report can bind the entire accepted inventory before and after execution.
Criteria receive specific test identities or explicit complete regression-test-file
contracts; skips are not success. The command does not execute tests. Budgets and
structural agent hints are inspectable indications of required changes, not a universal
product score.

`untangle.features.json` is Untangle's own declared map. Reviews remain `proposed`,
evidenced working roles remain `declared`, and unknown responsibilities stay open.
`evidence_consistent` confirms source consistency; domain conformance remains
`not_independently_proven`, and ownership authority remains `manifest_declarations`.
Without a map, `needs_manifest` returns an empty draft. `init --feature-map` can
additionally inspect the map without inventing features or owners. Complete feature
discovery, historical feature baselines and the automatic `reduce-complexity` loop
remain development goals.

The [detailed contract](./docs/FEATURE_ALIGNMENT.md) describes the manifest, test evidence,
scope interpretations and limits. The number of declared features depends on the chosen
taxonomy and does not measure objective feature richness.

---

## 9. MCP tool portfolio

### 9.1 Workspace and index

```text
workspace_init
workspace_index
workspace_update
workspace_stop
workspace_remove
workspace_watch
workspace_status
workspace_health
workspace_list
```


### 9.2 Search and context

```text
code_search
search_session
change_search
context_list
context_index
context_search
context_remove
```


### 9.3 Graph and symbols

```text
graph_build
graph_status
graph_query
graph_stats
graph_cycles
graph_visualize
symbol_list
symbol_get
symbol_flow
impact_analyze
cross_repo_impact
```


### 9.4 Complexity and changes

```text
complexity_get
complexity_explain
complexity_hotspots
complexity_diff
change_analyze
change_report
quality_gate
```


Final tool names and schemas are normatively defined in [`spec.md`](./spec.md).

The built declared feature alignment adds `untangle_product` to this portfolio as specified
in §8.8; complete Change Intelligence remains target scope.

---

## 10. CLI product scope

```text
untangle init
untangle doctor
untangle index [path]
untangle update [path]
untangle watch [path]
untangle status
untangle search <query>
untangle context search <query>
untangle graph build|show|cycles|stats
untangle symbols list|get
untangle impact <target>
untangle flow <entrypoint>
untangle complexity get|explain|hotspots|diff
untangle changes analyze|show|search
untangle gate
untangle mcp --stdio
untangle config show|validate
untangle projects list|remove
untangle version
```


Every read command supports:

```text
--format text|json|jsonl|markdown
--quiet
--no-color
```


Machine-readable formats have stable, versioned schemas.

---

## 11. Configuration

Project file: `.untangle.json`

```json
{
  "$schema": "https://untangle.dev/schema/config-v1.json",
  "workspaceId": "commerce-platform",
  "projectId": "backend",
  "repositories": [
    { "id": "backend", "path": "." },
    { "id": "identity", "path": "../identity" }
  ],
  "qdrant": {
    "mode": "managed",
    "url": "http://127.0.0.1:16333",
    "collectionPrefix": "untangle_"
  },
  "embeddings": {
    "provider": "ollama",
    "mode": "auto",
    "url": "http://127.0.0.1:11434",
    "model": "nomic-embed-text",
    "dimensions": 768,
    "queryPrefix": "search_query: ",
    "documentPrefix": "search_document: "
  },
  "index": {
    "watch": true,
    "maxFileSizeMb": 5,
    "targetChunkTokens": 900,
    "maxChunkTokens": 1500
  },
  "complexity": {
    "enabled": true,
    "cognitiveAlgorithm": "untangle-cognitive-v1"
  },
  "qualityGate": {
    "newCognitivePerSymbolMax": 20,
    "cognitiveDeltaPerSymbolMax": 5,
    "newCyclesAllowed": 0,
    "minimumParseQuality": "partial"
  }
}
```


Secrets are not recommended in the project file. API keys for external Qdrant or Ollama proxies come from environment variables or secret stores.

---

## 12. User experience and output

### 12.1 Principles

- Every response states scope and data freshness.
- Results contain repository, ref, file, lines and symbol where available.
- Scores are reported separately by component.
- Uncertainty and incomplete analysis are visibly marked.
- Quality and risk values include explanations.
- Text output is optimized for people; JSON is the stable automation interface.

### 12.2 Example search output

```text
1. [identity/main] src/tokens/rotation.ts:42-91
   Symbol: TokenRotator.rotate
   Score: 0.842 (dense 0.791, hybrid rank 1, graph boost +0.031)
   Complexity: cyclomatic 9 · cognitive 14 · risk 0.43

   Rotates refresh tokens and invalidates the previous token family...
```


### 12.3 Example change gate

```text
FAILED — 2 new maintainability regressions

1. backend/src/auth/service.ts · AuthService.validateUser
   Cognitive: 14 → 24 (+10), allowed delta: +5
   Main contributors: nested if at L83 (+4), catch at L102 (+3)
   Blast radius: 18 symbols in 3 repositories

2. New dependency cycle
   backend/auth → identity/client → shared/http → backend/auth
```


---

## 13. MVP, Beta and GA

### 13.1 MVP — Local Intelligence Core

- npm CLI and MCP;
- managed or external Qdrant/Ollama;
- TypeScript/JavaScript and Python as the first deep languages;
- AST chunking with lossless fallback;
- full index, update, watcher, checkpoints and resume;
- single- and cross-repository hybrid search;
- file import graph;
- basic symbol definitions and calls;
- cyclomatic, cognitive, SLOC, nesting and Halstead;
- JSON and text output.

### 13.2 Public Beta — Change Intelligence

- broader language support;
- symbol graph and cross-repository resolvers;
- Impact, Flow and Cycles;
- Context Artifacts;
- Change Events, Rename/Move, Complexity Diff;
- Hotspots, Risk Score and Quality Gate;
- VS Code extension;
- Claude, Cursor and Codex plugin bundles;
- GitHub Action preview.

### 13.3 GA — Production Hardening

- schema and index migrations;
- remote team mode;
- reliable branch/commit snapshots;
- large monorepo and multi-repository benchmarks;
- Security Review, SBOM and signed releases;
- documented SLOs;
- plugin marketplace releases;
- upgrade and rollback paths;
- long-term support plan.

---

## 14. Non-functional product requirements

### Privacy

- Source code stays in the user's environment by default.
- Telemetry is disabled by default.
- Search Journeys are persisted locally only after an explicit start; target, query, failure-reason and free-form abandonment text are stored only with `retainText`. Otherwise targets and queries remain reduced to workspace-local, domain-separated HMAC-SHA-256 fingerprints.
- The HMAC key is stored separately from sessions at `.untangle/product-complexity/fingerprint.key`. This is pseudonymization, not anonymization or encryption: someone with the complete local state including the key can guess short or frequent text through dictionary comparison. Locator, rank, score, explicit tool and lifecycle metadata and a controlled abandonment reason code remain present without `retainText` and must not contain secrets. The local POSIX adapter creates key and journey files with mode `0600`. Journey files remain local until the local `.untangle/product-complexity` state is deliberately removed.
- Logs may contain source text only with explicit debug opt-in.
- External endpoints are transparently shown in the Health Report.

### Reliability

- every mutating index operation supports checkpoints;
- idempotent upserts;
- controlled deletion only through explicit remove commands;
- generation IDs prevent mixed partial states;
- periodic reconciliation corrects lost watcher events.

### Performance

- unchanged files are not embedded again;
- one query embedding is reused per compatible profile;
- graph payloads are loaded lazily and cached;
- Qdrant queries run in parallel within configured budgets;
- large upserts are bounded by count and bytes.

### Accessibility

- CLI usable without color;
- structured output;
- keyboard-operable VS Code UI;
- no information conveyed exclusively through color.

---

## 15. Product metrics

### Activation

- installation to first successful index;
- installation to first successful search;
- proportion of automatically resolved infrastructure setups;
- plugin installations with a successful Health Check.

### Usage

- Search, Impact, Flow and Change requests;
- number of indexed repositories per workspace;
- proportion of cross-repository queries;
- re-embeddings avoided through incremental updates.

### Quality

- Retrieval Recall@k on fixture suites;
- symbol and call resolution rate;
- rename/move matching precision;
- Quality Gate false-positive rate;
- proportion of responses with complete provenance.

### Dynamic Product Complexity

- median and p90 searches to the confirmed target;
- median query reformulations and inspected eligible candidates;
- median exposed files, mean file dispersion and candidate churn rate;
- Direct Hit, Target Returned, Healthy Retrieval and Candidate Limit Hit rates;
- profile-local target rank and reciprocal rank when the confirmed target was returned;
- proportion of sufficient cohorts with at least three compatible completed journeys;
- number of explicitly confirmed implementation targets per feature and measurement context, and proportion of observed versus explicitly unavailable target-code complexity evidence;
- number of completed, explicitly tagged journeys and reconciliation with sessions accounted for in `featureMappings`.

These metrics are local heuristic observations of real tasks. They are not published as
static code properties, universal agent assessments, unlabeled retrieval precision or
proof of semantic feature correctness.

### Reliability

- index job success rate;
- resume success rate;
- watcher reconciliation discrepancies;
- Qdrant/Ollama error rate;
- plugin/engine compatibility failures.

---

## 16. Open product decisions

Before Public Beta, the following decisions must be made explicitly:

1. final brand name and npm scope;
2. licensing model for Core, CLI, Extension and Enterprise extensions;
3. first officially deep-supported languages;
4. whether graph data is stored exclusively in Qdrant or also in local artifacts;
5. default model and recommended alternative Ollama model;
6. Git history scope in default local operation;
7. Quality Gate defaults: warn or block;
8. telemetry and crash-reporting model;
9. plugin and `npx` startup update behavior;
10. timing and form of an optional team/cloud offering.

---

## 17. Definition of Product Success

Untangle succeeds as a product when a developer or agent making a complex change no longer
has to reconstruct manually which repositories, symbols, contracts and quality risks belong
together. The engine delivers this context quickly, locally, with versioning and inspectable
evidence, whether invoked through npm, MCP, an IDE or a plugin. For recurring tasks measured
under compatible conditions, that progress appears as lower search, candidate and navigation
effort, rather than only a subjective impression or static file metric.
