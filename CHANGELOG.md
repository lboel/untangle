# Changes

## 0.1.1

- The npm package README shows how to pin Untangle in a project, try it without adding a
  dependency, or install it globally for use across repositories.
- The guide starts with a complexity report and shows how to preview offline setup and
  connect the installed CLI to an agent via MCP.
- The CLI and MCP report `0.1.1`.

## 0.1.0 — 2026-11-10

First public npm release. Fresh npm and pnpm consumers verified installation from the
public registry. See the [release guide](./docs/RELEASE.md) for the acceptance procedure.

### Repository context for coding agents

- Embedded LanceDB is the default for new local indices; Qdrant remains selectable.
  Backend and path changes select separate, freshness-checked indices without copying
  or deleting the previous backend's data.
- Independent symbol, lexical and semantic retrieval with hybrid fusion. Index/query
  share versioned identifier tokenization.
- Inspectable index freshness, explicit `require-fresh`, refresh/reindex and visible
  partial failures when retrieval branches are unavailable.
- AST complexity, hotspots, file/symbol graphs, callers/dependencies, and explicit
  measurement/resolution gaps.
- Vue inline-script symbols and complexity; templates/styles remain outside script AST
  measurement. Static frontend/FastAPI HTTP boundaries are available through CLI/MCP;
  unresolved dynamic/ambiguous requests remain visible, without claiming a runtime callgraph.

### Feature responsibility and search work

- `init` inspects existing product context with or without a spec-driven framework;
  offline/dry-run need no search services.
- Guided terminal setup previews configuration, optional analyzers/search services and
  a local map before confirmation; preparation and execution remain separate choices.
- Concrete Spec Kit/OpenSpec connectors read local artifacts and produce source-bound,
  proposed feature manifests without executing framework scripts or inventing ownership.
- Declared Vision → Spec → Feature → Code/Tests → Ownership alignment with complete
  feature scopes, shared files, budgets and `agentHints`.
- An interactive local 3D feature/code map with English controls, filters, selection,
  spatial navigation and inspectable HTML/JSON artifacts under `.untangle/`.
- Actual Vitest evidence after explicit invocation, bound to source content. Test paths
  alone are not execution evidence.
- Opt-in Search Journeys with attempts, reformulations, confirmed targets, abandoned
  tasks and explicit measurement conditions.
- Explicitly enabled analyzer extensions; provenance and metric definitions stay separate
  from Untangle's own measurements. The catalog offers SonarQube, Sentrux, local search
  and generic manifest-based integrations.
- English product help, diagnostics, generated comments and repository-owned map labels;
  inspected project content and immutable historical evidence retain their original text.

### Entry and distribution

- A badge-based English README, light/dark yarn marks and a transparent 3D brand
  illustration, with repository-wide first-party AGPL licensing and asset provenance.
- A separate GitHub Pages workflow publishes the checked static website and its license
  notices. Website deployment, repository visibility and npm publication are independent
  actions.
- Checkout setup produces an initial index-free report and a project-specific stdio-MCP
  template, without automatically registering agent clients.
- [Agent workflow](./docs/AGENT_WORKFLOW.md) with a copyable task brief, feature manifest,
  search examples and error handling.
- Release gates cover sources/builds, tests, licenses, original tarballs, SBOM and isolated
  npm/pnpm consumers, with a configured Linux/macOS × Node 22/24 matrix.
- Installed-package consumer checks include Vue, frontend/backend boundaries and guided
  setup; local agent-session data remains outside the repository sources.
- Lease contract tests use the adapters' injected clocks for exact renewal/expiry
  boundaries. Real filesystem, polling, wait-budget and cancellation checks remain;
  deterministic lease time removes the scheduler-dependent renewal assertion without
  changing the production lock implementations.

### Limits

Feature boundaries and owners are declarations. Test/search evidence proves neither complete
semantic conformance nor durable ownership or general productivity gains. Untangle is not a
complete Sonar/Sentrux replacement. Unresolved relationships and parse gaps stay visible.
Windows is outside the release matrix. Evidence applies only to the exact sources and platforms
actually checked.
