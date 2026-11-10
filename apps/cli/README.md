# @untangle-code/cli

Untangle's CLI and MCP entry point: the **`untangle`** binary. It connects local search,
code complexity and declared feature responsibility. Requires Node.js **`^22.13.0 || >=24.0.0`**.

The [agent workflow](https://github.com/lboel/untangle/blob/main/docs/AGENT_WORKFLOW.md)
connects MCP, search, complete feature scopes and real tests, with a copyable task brief for
spec-driven development and agentic engineering.

## Install in an npm project

From the directory containing your project's `package.json`, add Untangle as a pinned
development dependency and run a first analysis.

```bash
npm install --save-dev --save-exact @untangle-code/cli@0.1.1
npm exec -- untangle --version
npm exec -- untangle complexity --top=10
```

Direct complexity analysis runs on the current project without an index or search services.
Commit the manifest and lockfile changes to share the version with your team.

Preview the project setup, then create `untangle.toml` when you're ready.

```bash
npm exec -- untangle init --offline --dry-run
npm exec -- untangle init --offline
```

Offline init inspects local files and skips network probes. Dry-run previews the
configuration. The second command creates it in a new project and reports any differences
with an existing configuration.

## Try it in any repository

Run a one-off analysis from a project directory, including repositories without a `package.json`.

```bash
npm exec --yes --package=@untangle-code/cli@0.1.1 -- untangle complexity --top=10
```

`npm exec` fetches the package into the npm cache if needed. To preview setup the same way,
replace `complexity --top=10` with `init --offline --dry-run`.

## Install once for multiple projects

Install the npm preview globally if you prefer to run `untangle` directly from each project.

```bash
npm install --global @untangle-code/cli@next
untangle --version
cd /path/to/your/project
untangle complexity --top=10
```

For a project installation, prefix the `untangle` examples below with `npm exec --`.

## Build from a source checkout

From the checkout root with **pnpm 10.34.5**:

```bash
pnpm setup:local --project=/absolute/path/to/your/project
```

This explicit helper checks pnpm, installs frozen dependencies, builds the checkout and
measures the target directly. The first report needs no index, Qdrant, Ollama, LLM or feature
map. Without `--project` it analyzes Untangle. Unanalyzed sources/reasons remain visible.
It writes no target configuration, feature declarations or ignore rules; registers no host,
changes no shell profile and starts no tests, global install or services. It prints follow-up
commands and an MCP template using actual absolute Node/CLI/project paths.

```bash
pnpm setup:local --project=/absolute/path/to/project --dry-run
pnpm setup:local --project=/absolute/path/to/project --skip-build --format=json
```

Dry-run executes nothing. Skip-build uses existing Dist files without proving they match
edited sources. JSON includes plan, executed steps, analysis, next commands and MCP template.
The helper targets Linux/macOS and belongs to the checkout, not the installed CLI package.
For later calls in the same shell:

```bash
UNTANGLE_CLI="$PWD/apps/cli/dist/index.js"
untangle() { node "$UNTANGLE_CLI" "$@"; }
cd /path/to/your/project
untangle --help
```

An agent host uses the MCP template rather than this shell function. Standalone `changes`
and `gate` commands are not implemented; `complexity --max-*` thresholds are available.

## Workflow

```bash
untangle complexity                 # Direct AST analysis, no services/index
untangle init --offline --dry-run    # Inspect local context without writing
untangle product                    # Declared features, ownership and code/test metrics
untangle scan                       # Own metrics and explicitly enabled extensions
untangle init --interactive          # Guided configuration and optional tool setup
untangle product connect auto --dry-run --format=json
untangle graph features             # Local interactive 3D feature/code map
untangle doctor                     # Inspect config, parsers, services and index
untangle index                      # Index/graphs; selected storage and embedder
untangle query "..."                 # Hybrid, lexical, symbol, semantic or grep-like
untangle graph visualize --out=graph.html
untangle mcp --stdio                 # Local server for agent hosts
```

New projects store their index in LanceDB under `.untangle/index/lancedb`, without a database
service. `init --storage=qdrant` selects Qdrant; existing Qdrant configurations keep that backend.
Lexical/symbol retrieval needs a compatible index but no query embedding.
`index --embedder=offline` builds one without Ollama; its deterministic vectors have no
language-model semantics. Semantic retrieval needs its configured embedding provider.
Noninteractive init starts no services/models. Explicit scan can run enabled analyzers;
container provisioning requires separate consent.

Guided init previews its file/command plan and separates preparation from execution. Offers
include embedded LanceDB (default), local Qdrant/Ollama, local/existing SonarQube, a hash-verified Sentrux binary/MCP
template and custom SARIF/JUnit/JSON extensions. Tokens use environment-variable names, not
project-stored values. Existing files and foreign containers are preserved. Tool installation
is not scan evidence.

The map stores HTML/JSON under `<project>/.untangle/feature-map/`. Its 3D positions, perspective,
rotation, zoom, filters, neighbor selection and accessible list inspect declared relationships.
Complete feature metrics and gaps stay visible independently of rendering caps. Missing
features are not invented. Spatial distance is not semantic proof. Controls are English;
inspected names/source content are preserved. JSON, pipes and dry-run never open a TUI;
`init --no-interactive --offline --format=json` remains scriptable.

## Product context in init

Init inspects candidates for vision, specification and product descriptions from the accepted
scan. Filename roles are provisional; ambiguity remains open. Select other paths explicitly:

```bash
untangle init /path/to/project --vision=docs/vision.md --spec=docs/requirements.md --offline --dry-run --format=json
```

Paths are project-relative. Offline suppresses network probes; document inspection needs no
provider/LLM/embeddings. `findings.productContext` contains paths, content hashes, sections,
selection reasons and local references, with `needs_context`, `needs_selection`,
`ready_for_review` or `incomplete`. Vision/specification are required; product description is
optional. Ignore/security/read limits still apply and missing/unassessed sources are explicit.

After 256 references, `referencesTruncated: true` marks incomplete inspection. Parse limits
are 16,384 UTF-16 units per line, 4,096 `[` openings and 2,048 heading candidates per document.
Exceeded budgets retain the hash but mark `not_assessed`/`incomplete`.

Even `ready_for_review` leaves `alignment.status: unverified` and empty feature/ownership
review drafts. A `present` reference proves only its accepted path/hash, not anchors, behavior
or ownership. Selected readable documents become markdown `[[contextArtifacts]]` in the TOML
proposal. Ordinary Markdown search works after indexing; independent artifact search remains
unimplemented in CLI/MCP.

Configuration-only init writes no documents/Journey data; dry-run writes nothing. Differing
configuration needs `--force` or explicit guided replacement. `--feature-map=docs/features.json`
selects an existing declared map; otherwise init looks for `untangle.features.json`. That
inspection neither writes nor confirms declarations and leaves document-context assessment
independent. It adds no MCP init tool.

## Concrete SDD connectors

```bash
untangle product connect auto --dry-run --format=json
untangle product connect spec-kit --format=json
untangle product connect openspec --format=json
```

Spec Kit/OpenSpec adapters read supported local specs, plans, tasks and change artifacts.
They record actual requirement/task identities, checked state and explicit file-reference
provenance/hashes without running framework scripts. An explicit connection saves versioned
`.untangle/sdd/` report/manifest files after source revalidation; dry-run writes nothing.
Drafts stay `planned`/`proposed`, without invented owners, dependencies or passing-test claims.
Inspect and complete the returned manifest, then pass its real path to `product --manifest`
and `graph features --feature-map`. Existing declarations are never silently merged/replaced.
The spec-driven TUI offers detected workspaces when no explicit feature manifest is selected,
and writes only after final confirmation.
[Supported artifact layouts and limits](https://github.com/lboel/untangle/blob/main/docs/SDD_CONNECTORS.md).

## Declared feature alignment

```bash
untangle product --root=/path/to/project --format=json
untangle product --path=src/accounts/lookup.ts
untangle product --draft --feature=accounts.lookup --path=src/accounts/lookup.ts --format=json
untangle product --path=src/accounts/lookup.ts --run-tests -- pnpm exec vitest run src/accounts/lookup.test.ts
untangle product --test-evidence=.untangle/product-tests.json --max-cognitive=15 --require-complete --format=json
```

The default map is `untangle.features.json`; `--manifest` selects another in-root path.
The index-free report connects declared IDs to exact vision/spec headings, owners and full
code/test scopes. Code/tests stay separate, shared sources count once in the overall union,
and missing/partial sources remain gaps.

`--path` accepts a literal search hit. `selection.matches` reports every feature association
as code/test/intent/ownership while retaining complete measurements, including helpers.
MCP exposes `untangle_product({path: "src/accounts/lookup.ts"})`.

With a missing map, `--draft --feature=ID --path=PATH` supplies an unreviewed **`report.draft`**,
not an entire-report manifest. Review/extend all code, tests, intent and owners before saving;
the command writes nothing and invents no owner.

Default analysis executes no tests. `--test-evidence` reads a real report bound to the entire
accepted inventory before/after execution; `testNames` can identify exact criteria cases.
Only explicit `--run-tests -- <argv>` executes a Vitest-compatible command without a shell
inside the target. The runner must exist; Untangle installs none. Reporter/output arguments
are supplied by Untangle and caller overrides rejected; other test frameworks are unsupported.

`testRun.receiptPath` records inventories, actual argv/exit, original reports and hashes in an
exclusive OS-temporary directory; archive it for durable evidence. Timeout defaults to 120s,
with `--test-timeout` at most one hour. stdout/stderr share 16 MiB; JSON has another 16 MiB.
Timeout/abort stop the child tree. Changed sources are `stale`, failures `bound_failed`, skips
satisfy no criterion. Failing tests exit 5; runner errors exit 1. Binding authenticates neither
external toolchain nor runner. `--run-tests` and `--test-evidence` are mutually exclusive;
MCP remains read-only.

Default `--max-cognitive=15` is per execution unit. Normal report exit 0 can include open
review; `--require-complete` exits 5 except for `evidence_consistent`. Missing maps yield
`needs_manifest`. Consistent declarations prove neither semantic behavior nor owner identity.
The [feature contract](https://github.com/lboel/untangle/blob/main/docs/FEATURE_ALIGNMENT.md)
details source binding, scopes and budgets. Untangle's own map has proposed reviews/declared
roles, not human approval or an objective feature-richness score.

## Command status

| Command | Status and scope |
|---|---|
| `init` | Implemented: commented configuration, context inventory, optional guided setup. |
| `query` | Implemented: hybrid/lexical/symbol/semantic/pattern retrieval; scoped profile auto-selection. |
| `complexity` | Implemented: direct measurements without services/index, threshold exit 5. |
| `product` | Implemented: declared alignment, separate metrics, source-bound evidence and optional gate. |
| `product connect` | Implemented: native local Spec Kit/OpenSpec imports into proposed manifests. |
| `scan` | Implemented: own analysis, enabled extensions and explained failures; explicit container consent. |
| `doctor` | Implemented: read-only checks, exactly one next step per failed check. |
| `watch` | Implemented: complexity deltas; optional serialized index refresh. |
| `extensions` | Implemented: analyzer manifest/import/activation/execution. |
| `index` | Implemented: complete core pipeline, incremental/dry-run/offline modes. |
| `graph` | Implemented: file/symbol context, frontend/FastAPI boundaries, offline explorers/3D feature map. |
| `flow` | Implemented: symbol paths, impact, entry points and confidence. |
| `mcp` | Implemented: stdio runtime; specified unbuilt capabilities explicitly unavailable. |

Command specifications/`--help` are executable truth. Registered but unbuilt MCP tools return
`FEATURE_UNAVAILABLE`. For a project installation, configure the MCP host with the absolute
paths to your Node executable, installed CLI and project root.

```json
{
  "mcpServers": {
    "untangle": {
      "command": "/absolute/path/to/node",
      "args": [
        "/path/to/your/project/node_modules/@untangle-code/cli/dist/index.js",
        "mcp",
        "--stdio",
        "--root=/path/to/your/project"
      ]
    }
  }
}
```

## Exit codes and streams

| Code | Meaning |
|---|---|
| 0 | Success/report produced; inspect report status. |
| 1 | Operational error: unreadable file, invalid configuration, adapter/runner failure. |
| 2 | Invalid arguments, command or option. |
| 3 | Capability unimplemented, not a user error. |
| 4 | Environment/index unavailable, unconfirmed required freshness or incomplete retrieval. |
| 5 | Analysis/evidence threshold or explicit tests failed. |
| 130 | Cancelled by SIGINT/SIGTERM. |

Unavailable capability, environment and quality-gate failures stay distinct without parsing
stderr. MCP tool errors remain structured on a live connection rather than terminating its
server. Scan can exit 0 with individual extension failures in its report.

**Payload to stdout, human diagnostics to stderr.** JSON also contains structured warnings,
freshness and skipped data. JSONL begins with a header; hits are under `hit`:

```bash
untangle query "retry" --format=jsonl | jq -r 'select(.kind == "hit") | .hit.filePath'
```

Inspect the search exit code too; `set -o pipefail` prevents jq from hiding it.

## Query

```bash
untangle query "where is a payment triggered"             # hybrid
untangle query "charge" --mode=symbol --explain
untangle query "user id" --mode=lexical --require-fresh
untangle query "renew a token" --mode=semantic
untangle query "charge" --context --linked
untangle query --regex "await\s+fetch\(" -C 2 --path='src/**' --exclude='**/*.test.ts'
```

`--explain` exposes raw score values, weights and contributions, helping investigate both
high and missing rankings. Auto embedding selection reads bounded `.untangle/index-states-v1/`
records scoped to workspace/repository/ref/profile and generation-bound current pointers.
Multiple refs/profiles/logical repositories on one physical root remain separate. Incompatible
selected spaces require explicit `service`/`offline` rather than silently searching a subset.
The old `.untangle/index-state.json` is read-only migration fallback.

Every query checks content hashes and reports freshness/time/reasons per repository.
`--require-fresh` requires confirmed currency; `--refresh` updates stale checked-out refs first,
with stderr progress. `watch --index` repeats serially at its reconciliation interval.
Historical unchecked-out refs remain `unknown`; refresh cannot assign them the current tree.
MCP exposes the same freshness and read-only `requireFresh`.

Lexical uses sparse/BM25, symbol uses symbols, semantic uses dense retrieval. The first two
need no query embedding but do need a compatible index. Offline indexing needs no Ollama and
claims no model semantics. Hybrid fuses independent paths, with a ten-second per-branch budget
preventing a hung service from hiding ready hits. Partial failures preserve hits/warnings on
stdout and exit 4. Versioned identifier tokenization requires legacy migration/reindex;
refresh handles this. Stale/incomplete contexts are not complete Journey measurements.

Strict abstention is default: insufficient evidence clears hits. `--abstention=evidence`
retains candidates/verdict for inspection without overriding warnings/freshness/exit status.
MCP partial errors retain data under `error.details.data`.

## Observe search effort through MCP

An explicitly started Search Journey connects a caller-declared feature ID to actual
attempts and a confirmed target. Effort remains separate from complexity; it proves neither
semantic correctness nor causes of findability and produces no combined score.

```jsonc
// Send to untangle_search_session; retain session.sessionId.
{
  "action": "start",
  "goal": "Find profile card rendering and its tests",
  "featureId": "profile.cards.presentation",
  "executionContext": {
    "agentModel": "model-with-exact-version",
    "harness": "my-harness-v2",
    "searchStrategy": "hybrid-then-symbol-and-graph-v1",
    "taskClass": "find-feature-code-and-tests",
    "taskMix": "fixed-eight-task-suite-v1",
    "priorContext": "fresh-session-no-open-files"
  }
}
// Send to untangle_search.
{ "query": "profile card component", "session": { "id": "<session-id>", "step": 1 } }
// Confirm the actual target through untangle_search_session.
{ "action": "complete", "sessionId": "<session-id>", "target": { "filePath": "src/profile/ProfileCard.tsx" } }
{ "action": "report" }
```

Optional `executionContext` is entirely caller-declared. When present it requires model,
harness, strategy and task class; task mix/prior context are optional. Values are trimmed
identifiers of at most 256 UTF-16 units. No hidden environment inference occurs. Different
contexts create separate cohorts; absent conditions remain `not-recorded`/`uncontrolledDimensions`.
Even complete declarations do not independently prove controlled conditions.

Actions are `start`, `get`, `observe`, `complete`, `abandon`, `report`. Observe records explicit
`open-file`, `open-symbol`, `graph-query`, `other-tool` steps. Completion needs at least one
search attempt and an explicit file/chunk/symbol target. `acceptedAttemptId` can bind a specific
attempt. Steps are positive integers ≤128; numbered/unnumbered attempts cannot mix. Identical
repeated steps are idempotent; differing data conflicts. Limits: 128 attempts and 512 navigation
events per Journey.

Successful recording returns `searchObservation.status: recorded` and `attemptId`. Optional
recording failure preserves search with `not_recorded`/`SEARCH_SESSION_RECORDING_FAILED`.
Stale/failed/incomplete retrieval is not full evidence. Cohorts separate ranker, ranking
context, hit/candidate limits, profile, generation and immutable corpus revision. Legacy
incomplete revisions remain readable/insufficient; fewer than three compatible completions
set `sufficientEvidence: false`, without independently confirming caller conditions.

`cohorts`/feature search mappings retain completed-task views. `outcomeCohorts` adds active,
completed and abandoned sessions with effort/reasons. `terminalCompletionRate` uses completed
plus abandoned as denominator and is null without terminals. Active sessions stay separate;
easy successes do not hide abandoned effort. Feature mappings require explicit IDs/unambiguous
target evidence and do not average incompatible metric versions.

Recording is local/opt-in. Default `retainText: false` uses separate workspace HMAC domains
for goals, feature IDs, queries and context. Candidate paths, ranks/scores and declared tool
metadata/reason codes remain; source/chunk content and free error/abort text are not retained.
`retainText: true` additionally retains those texts. The separate key is
`.untangle/product-complexity/fingerprint.key`. This is neither encryption nor anonymity;
access to full local state permits testing guessed values.
[Context, denominators and privacy](https://github.com/lboel/untangle/blob/main/docs/SEARCH-JOURNEY-CONTEXT.md)
do not imply automatic time trends, ROI or productivity measurement.

## Decisions

- The custom closed argument parser rejects unknown options instead of silently treating
  typos as positional inputs. Help is generated from the option specification.
- Doctor has a per-check deadline (`--timeout`, default 15s). Adapter retry/backoff suited
  to indexing must not leave diagnosis hanging. Deadline is a failed check; outer abort is
  whole-command exit 130/MCP `CANCELLED`.
- A failed retrieval target is a failure, not empty success. Provider-unavailable data stays
  visible in warnings/ledger and query exits 4.
- Query has its own default 60s deadline, allowing model warm-up without indefinite hanging.
- Main explicitly exits after flushing streams; it does not wait for lingering adapter work
  once the final outcome is known.
- MCP is another interface to the same analysis, not a second implementation. The public
  CLI export owns runtime; private MCP app only re-exports it. Canonical roots, JSON-RPC-only
  stdout, validated inputs/envelopes/data, disjoint success/failure, explicit availability,
  hard graph/flow/impact/visualization budgets and in-flight cancellation have contract tests.

## Known limits

- Each search requires compatible embedding spaces; explicit profiles search their own
  collection. Profile changes need a matching index.
- Query searches the index, not disk; absent indexes exit 4 rather than claim no hits.
- Complexity measures only available deep adapters; other sources remain explained skips.
- Graph context is generation-bound. Context/linked data uses direct/exact resolved edges
  from the same generation without changing rank/count. New payloads include `generation_id`
  and `metrics_version`; missing legacy values remain `unknown`, requiring one deliberate
  `index --no-incremental --no-resume`, without attaching an unrelated current graph.
- Damaged syntax trees contribute no complexity numbers because unreliable scopes/hotspots
  are worse than explicitly incomplete coverage.
- Retrieval depends on parsers, chunks, model and ranking. Missing hits do not prove absent
  implementation. Real acceptance covers targeted identifier/language/freshness/migration/
  outage cases, not complete recall.
- Ownership and feature richness are not automatically proven. Declared IDs and confirmed
  target observations remain caller evidence. The general capability/reduce-complexity loop
  is unimplemented; embedding similarity is not behavior equivalence.

## Combined analysis report

```bash
untangle scan --root=/path/to/project --format=json
untangle scan --feature=accounts.lookup --format=json
```

Scan runs own analysis and enabled extensions, separating own metrics, external evidence and
explained omissions. Without `--yes`, no container provisioning occurs; with it, resources are
shown on stderr first and license gates remain. Exit 0 means report produced, even if some
extensions failed. JSON retains run status, provenance, findings and diagnostics.

`--feature` adds `featureAlignment`, not a smaller repository/analyzer scan. Explicit
`--manifest`/`--test-evidence` require a feature and execute no tests. Sentrux/Sonar/other tools
use reviewed definitions in the user profile. Repository metrics stay `repository_context`;
file/symbol findings attach only through real paths. Values are neither summed with own metrics
nor apportioned into features. Sonar retrieval proves no analysis of the current commit.
[Provider boundaries](https://github.com/lboel/untangle/blob/main/docs/ANALYZER-FEATURE-WORKFLOW.md).

Complexity/scan totals use `totalsReading: execution_unit`: inclusive outer functions plus
self contributions outside them, without re-adding nested functions. `executionUnits` counts
all functions; `executionUnitRoots` counts outer ones. Legacy double-counted totals require a
new measured baseline.

## License

**AGPL-3.0-only.** The tarball includes [`LICENSE`](./LICENSE), [`NOTICE`](./NOTICE),
[`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md) and corresponding TypeScript under `src/`.
A README is not a substitute for the full license copy. Repository:
<https://github.com/lboel/untangle>.
