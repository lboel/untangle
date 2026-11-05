# Untangle in an agent workflow

This workflow connects a coding agent to local repository search, declared feature boundaries
and inspectable measurements, with or without spec-driven development. Domain decisions and
authorization to edit sources remain with the team or calling harness.

## 1. Choose the checkout, project and host

In an available Untangle checkout:

```bash
pnpm setup:local --project=/absolute/path/to/project
```

The command installs locked checkout dependencies, builds and produces an index-free complexity
report with absolute follow-up commands and an MCP template. The project root must exist.
`--dry-run` shows the plan; `--skip-build` trusts existing artifacts without proving source/Dist
correspondence. A temporary shorthand for the following examples:

```bash
UNTANGLE_CLI="$PWD/apps/cli/dist/index.js"
untangle() { node "$UNTANGLE_CLI" "$@"; }
cd /absolute/path/to/project
```

MCP hosts instead use the printed absolute Node/CLI paths and
`mcp --stdio --root=/absolute/path/to/project`. A shell function is not a host executable,
and the template is not automatic client registration.

`complexity`, `product`, `init --offline` and `graph boundaries` need no index/embedding
service. An offline dry-run writes nothing:

```bash
untangle complexity --top=10 --format=json
untangle init --offline --dry-run --format=json
untangle product --format=json
```

Configuration-only init inspects languages, topology, services, ignore rules and product
documents. Without dry-run it writes commented `untangle.toml`, preserving differing existing
configuration without `--force`. It writes no `.untangle.json` or feature declarations and
creates no metadata directory just for ordinary noninteractive init. Explicit indexing,
Search Journeys, connector preparation and confirmed guided setup may use `.untangle/`.
Ignore local metadata before sharing a project; private index/Journey/credential data does
not belong in public history or release artifacts.

```bash
untangle init --vision=docs/vision.md --spec=docs/requirements.md --offline --dry-run --format=json
```

`findings.productContext` distinguishes `needs_context`, `needs_selection`, `ready_for_review`
and `incomplete`; alignment remains `unverified`. Names/references establish provenance, not
semantic conformance. Missing/unaccepted documents and length/heading/reference limits remain
explicit.

## 2. Give the agent a bounded assignment

This is a task template for your calling agent, not autonomous Untangle execution:

```text
Use Untangle for repository context and review of this change.

Before editing:
- Inspect the current workspace and preserve others' changes.
- Read the feature report for the affected path or declared feature ID.
- Search the responsibility with requireFresh and graph/symbol context.
- Confirm implementation, callers, tests and declared owners against actual sources.
- Keep missing specs, ownership, parse coverage and graph relationships open.

During the change:
- Change a bounded responsibility and preserve error/cancellation contracts.
- Include every new helper in the complete target measurement.
- Record search work only through an explicitly started Search Journey.

During review:
- Build and run appropriate existing tests without weakening assertions.
- Compare complete metrics, tests, dependencies and public contracts.
- Refresh the index and repeat the same fresh search cases.
- Report before/after, remaining gaps and actual test evidence.
```

CLI/MCP provide evidence. Your host controls edits, test processes, approvals and Git
operations according to its assignment; Untangle does not execute this development loop
on its own.

## 3. Declare feature boundaries and responsibility

Accounts paths below are replaceable examples. Documents, headings, code and tests must
exist. The default manifest is `untangle.features.json`.

For supported existing SDD workspaces:

```bash
untangle product connect auto --dry-run --format=json
untangle product connect spec-kit --format=json
untangle product connect openspec --format=json
```

The explicit connection saves a source-bound report and proposed manifest under
`.untangle/sdd/`. It reads Spec Kit/OpenSpec artifacts and literal code/test references,
without running framework scripts. Checked tasks do not become implemented features or
passing tests. Inspect `manifestPath`, complete the responsibility and owners, then select
it explicitly with `product --manifest=…` and `graph features --feature-map=…`.
The spec-driven TUI offers detected workspaces when no explicit feature manifest was chosen;
preview is read-only until final confirmation. See [SDD connectors](./SDD_CONNECTORS.md).

Without a framework/map, a literal accepted source path can seed a review draft:

```bash
untangle product --draft --feature=accounts.lookup --path=src/accounts/lookup.ts --format=json
```

This writes nothing. Only `report.draft` is the proposed manifest, not the entire report.
One file is not a complete feature boundary: add private helpers, other code, tests, intent,
criteria and ownership. Existing declarations require review and are not replaced.

```json
{
  "schemaVersion": 1,
  "owners": [
    {
      "id": "role.accounts",
      "label": "Accounts module role",
      "kind": "role",
      "status": "declared",
      "sources": [{ "path": "docs/ownership.md", "heading": "Accounts" }]
    }
  ],
  "features": [
    {
      "id": "accounts.lookup",
      "title": "Find an account by identifier",
      "stage": "implemented",
      "review": "proposed",
      "intent": [
        { "role": "vision", "path": "vision.md", "heading": "Account management" },
        { "role": "specification", "path": "spec.md", "heading": "Account lookup" }
      ],
      "owners": ["role.accounts"],
      "code": {
        "include": ["src/accounts/**/*.ts"],
        "exclude": ["**/*.test.ts", "**/test-support/**"]
      },
      "tests": { "include": ["src/accounts/**/*.test.ts"] },
      "criteria": [
        {
          "id": "lookup.regression-file",
          "description": "Every case in lookup.test.ts passes without skips.",
          "tests": ["src/accounts/lookup.test.ts"]
        }
      ],
      "dependsOn": [],
      "budgets": { "maxCognitivePerUnit": 15 }
    }
  ]
}
```

Selectors must match accepted files. Ignored/unsupported/missing/partial sources remain
coverage gaps. Stage, review and ownership are declarations, not authenticated human
responsibility. Confirm review deliberately; see the [feature contract](./FEATURE_ALIGNMENT.md).

```bash
untangle product --path=src/accounts/lookup.ts --format=json
untangle product --feature=accounts.lookup --format=json
```

A literal path can serve several features; each report retains the complete scope. Shared
files are not divided, and the combined union counts them once. `execution_unit`, `self`
and `top_level` remain separate; extracted helpers do not disappear from responsibility.
MCP `untangle_product` accepts:

```json
{
  "root": "/absolute/path/to/project",
  "path": "src/accounts/lookup.ts"
}
```

A search hit's `filePath` becomes this repository-relative `path`; no index is needed for
the feature report.

## 4. Bind real tests to source content

```bash
untangle product --feature=accounts.lookup --run-tests -- \
  pnpm exec vitest run src/accounts/lookup.test.ts
```

Only the explicitly supplied argv executes, without a shell. Untangle captures Vitest JSON,
identities, original reports, exit and accepted inventories before/after. Failure, skips,
timeout and cancellation remain distinct; source changes stale the evidence. Paths alone
are not execution evidence.

`testRun.directory` and `receiptPath` identify the original run. Successful report capture
writes a compatible `evidence.json` there. Archive the entire original directory into a new
owned `.untangle/` evidence area before later evaluation and select the actual report:

```bash
untangle product --feature=accounts.lookup \
  --test-evidence=.untangle/product-tests.json \
  --max-cognitive=15 --require-complete --format=json
```

That example path must exist and match current sources. Never invent digests or save the
entire product report as test evidence. Binding authenticates neither external toolchains
nor complete domain coverage. Default MCP executes no test processes; `untangle_product`
accepts existing evidence through `testEvidence`.

Without `--require-complete`, product exit 0 initially means report produced. With it, every
status except `evidence_consistent` exits 5. Even consistent reports retain
`semanticConformance: not_independently_proven` and `ownershipAuthority: manifest_declarations`.

<a id="suchdienste-und-index-einrichten"></a>

## Set up search services and the index

`untangle init --interactive` shows project findings, optional search services, SonarQube,
Sentrux and custom format extensions. Final confirmation separates preparation from actual
installation/execution. Agents use `--no-interactive`/structured output; do not acknowledge
licenses or trust external manifests on a user's behalf without authorization.
[Integration guide](./INIT_INTEGRATIONS.md).

```bash
untangle graph features --format=json
untangle graph features --feature-map=.untangle/features.json --format=json
```

This index-free snapshot saves HTML/JSON under `.untangle/feature-map/`. The 3D network
connects declared features, code/tests, shared files, ownership, intent and complete metrics.
Rotate/zoom, filter and inspect neighbors; English controls preserve project content. It
executes no tests and loads no external browser resources. Missing declarations remain
unmapped; declared/unresolved edges are not runtime calls. Spatial proximity is a layout
choice, not a semantic-distance metric.

Direct analysis works before service setup. Indexed retrieval needs Qdrant; service
embeddings additionally need the configured model. Noninteractive init starts no services
and downloads no models; guided setup does so only after deliberate selection/confirmation.
The optional pinned Compose setup binds loopback ports:

| Service | Host port |
|---|---:|
| Qdrant REST | 16333 |
| Qdrant gRPC | 16334 |
| Ollama container | 11435 |

In the Untangle checkout, start it explicitly and pull the model:

```bash
docker compose -f docker/docker-compose.yml up -d
docker compose -f docker/docker-compose.yml exec ollama ollama pull nomic-embed-text
```

See the [Docker guide](../docker/README.md). Native Ollama may use 11434. In the **target
project**, run `untangle init --no-interactive` and edit existing `untangle.toml` tables for
your selected setup; do not duplicate tables:

```toml
[qdrant]
mode = "external"
url = "http://127.0.0.1:16333"

[embeddings]
provider = "ollama"
mode = "external"
url = "http://127.0.0.1:11435"
model = "nomic-embed-text"
dimensions = 768
contextLength = 2048
```

This is the default profile. The pinned Ollama 0.5.4 image does not support Qwen3. For
`qwen3-embedding:0.6b`, use an actually compatible newer native/external service and update
its endpoint, model, `dimensions = 1024` and `contextLength = 32768` together. Qwen3 is not
part of the Compose example.

```bash
untangle doctor
untangle index
untangle query "lookupAccount" --mode=symbol --require-fresh --context --linked
untangle query "find an account by its identifier" --mode=hybrid --require-fresh --context --linked --explain
```

With Qdrant but no embedding service:

```bash
untangle index --embedder=offline
untangle query "lookupAccount" --embedder=offline --mode=symbol --require-fresh --context --linked
untangle query "account identifier" --embedder=offline --mode=lexical --require-fresh
```

Offline vectors are deterministic, without language-model semantics. Profiles remain
separate and are not ranked together as though comparable. Compatible service indexes
support symbol/lexical queries without a running embedding provider. Ambiguous current
embedding spaces require explicit `--embedder=service` or `--embedder=offline` selection.

After edits, `query --refresh --require-fresh` or `watch --index` creates current revisions.
`indexFreshness` checks full content hashes; unknown/incompatible versions stay unverified.
Migration can require `index --no-incremental --no-resume` without blanket deletion of other
workspaces/profiles. Graph context binds the hit's generation; unknown legacy hits do not
inherit a new graph.

## 5. Observe search work explicitly

Start MCP `untangle_search_session`:

```json
{
  "action": "start",
  "goal": "Find account lookup code and tests",
  "featureId": "accounts.lookup",
  "executionContext": {
    "agentModel": "model-with-exact-version",
    "harness": "my-coding-harness-v2",
    "searchStrategy": "hybrid-then-symbol-and-graph-v1",
    "taskClass": "find-feature-code-and-tests",
    "taskMix": "fixed-task-suite-v1",
    "priorContext": "fresh-session-no-open-files"
  }
}
```

Use the returned ID in `untangle_search`, incrementing step numbers for each attempt:

```json
{
  "query": "lookupAccount",
  "mode": "symbol",
  "requireFresh": true,
  "includeContext": true,
  "includeLinked": true,
  "session": { "id": "<returned session ID>", "step": 1 }
}
```

Complete only with a confirmed target:

```json
{
  "action": "complete",
  "sessionId": "<returned session ID>",
  "target": { "filePath": "src/accounts/lookup.ts" }
}
```

Examples use the host's fixed root; tools also accept explicit `root`. Symbol/chunk locators
are more precise than file paths. `acceptedAttemptId` can identify an actually accepted
prior attempt; otherwise effort counts through completion. Explicit `observe` supports
`open-file`, `open-symbol`, `graph-query` and `other-tool` navigation.

Without a confirmed target, abandon rather than invent success:

```json
{
  "action": "abandon",
  "sessionId": "<returned session ID>",
  "reasonCode": "other"
}
```

Allowed reason codes are in the schema; `reasonCode` is optional. `get` reads a session and
`report` reads workspace cohorts. Completed medians use completed tasks; outcome cohorts
also report active/abandoned/terminal sessions with effort, denominators and controlled
reasons. Failed search remains part of observed work.

Feature/context declarations come from the caller. Different models, harnesses, strategies
and task conditions create separate contexts; missing conditions are not invented.
`sufficientEvidence` requires compatible complete retrieval evidence, not controlled caller
conditions or causal product improvement. Sampling/task mix are not normalized automatically.
See [cohort semantics](./SEARCH-JOURNEY-CONTEXT.md).

### Measurement context and persistence

Only a successfully committed index supplies immutable `corpusRevisionFingerprint` from its
full file/content manifest. Running/cancelled/failed generations do not claim it. Unconfirmed
hits may remain useful with `INDEX_CONTEXT_INCOMPLETE`, but linked Journeys lack full evidence.
Known generations remain profile-bound even without final hits; unknown generations do not
join successful cohorts.

Comparable evidence needs matching ranker/ranking context, effective hit/candidate limits,
and the associated profile/generation/corpus revisions. Legacy observations remain visible
and incomplete. `sufficientEvidence` requires at least three compatible completed sessions;
it is neither accuracy nor confirmation of external conditions. Feature mappings aggregate
only matching declared IDs/contexts. Unknown/ambiguous target metrics remain unavailable,
never zero complexity.

CLI current pointers are scoped to workspace/repository/ref/profile; legacy singleton data
remains a migration input. Long-running indexing renews repository/ref/publication leases,
checks ownership before publication and uses generation CAS. Local filesystem mode does
not guarantee fencing of already-started rename syscalls or distributed locks.

Queries/targets default to workspace-local HMAC-SHA-256 fingerprints. Plain text requires
`retainText: true`. Key/data files live in `.untangle/product-complexity/` with POSIX `0600`.
Locators, ranks, scores and explicitly supplied tool metadata remain; source code is not
copied into Journey records. This is data minimization/pseudonymization, not anonymity or
encryption. Do not put secrets into labels, goals or execution context.

## 6. Read measurements and other tools together

```bash
untangle scan --feature=accounts.lookup --format=json
untangle graph src/accounts/lookup.ts --direction=both
untangle flow lookupAccount --impact
```

Scan uses own metrics and installed/enabled extensions, without automatically installing
Sonar/Sentrux. Own/external/unmeasured categories stay separate. HTTP reads prior analyzer
state; check its source identity/freshness independently. Definitions, license acknowledgments
and credentials remain in the user profile, not the feature map.
[Analyzer workflow](./ANALYZER-FEATURE-WORKFLOW.md).

`graph boundaries` adds a local report connecting supported imports, static `fetch` and mounted
FastAPI routes using declared service bindings. It proves no template events, runtime
activation or authentication. See [feature alignment](./FEATURE_ALIGNMENT.md#inspect-frontend-and-backend-together).

<a id="fehler-sind-teil-des-vertrags"></a>

## Errors are part of the contract

| Observation | Meaning and next action |
|---|---|
| `needs_manifest` | Review an explicit draft and declare the complete responsibility. |
| `needs_review` / `incomplete` | Intent, review, ownership, test evidence or measurement coverage remains open; inspect reasons. |
| `violated` | A budget/criterion failed; inspect scope/evidence rather than increasing thresholds to hide it. |
| `stale` / `unknown` / `incompatible` | Current search sources are unconfirmed; inspect profile/index reasons and refresh deliberately. |
| `SEARCH_BRANCH_UNAVAILABLE` | Retrieval branch unavailable; CLI exit 4, usable partial hits are not complete retrieval evidence. |
| `INDEX_CONTEXT_INCOMPLETE` / `INCOMPLETE_PAYLOAD` | Hits can remain usable without complete linked Journey evidence. |
| `FEATURE_UNAVAILABLE` | Registered capability is not executable; use a built CLI path where available. |
| `CANCELLED` | Cancellation remains cancellation, not a successful partial report. |
| Extension in `notMeasured` | Missing/failed license, consent, secret, provider or run; inspect the actual next step. |

Scan exit 0 can contain analyzer failures. If search succeeds but Journey persistence fails,
search remains successful with `searchObservation.status: not_recorded` and a warning code.
Insufficient evidence does not become product-complexity proof.

Path sandboxing canonicalizes against the allowed workspace, including symlinks. MCP stdout
is reserved for JSON-RPC. Traversal/result/runtime bounds and truncation remain visible;
calling harnesses should inspect them rather than swallow them as empty success.

## Review the complete change

A smaller function is insufficient if responsibility moves into helpers. Include every
affected production file/helper; compare `execution_unit`, `self`, `top_level`, cyclomatic
bases, helper count, indirection and SLOC separately. Code, tests, prose and external metrics
retain separate meanings.

Preserved behavior requires existing identities/assertions/skips, error/cancellation/cache
and side-effect ordering, plus CLI/MCP/API contracts. Rebuild, refresh and repeat actual search
cases with graph context. This is inspectable regression evidence, not formal equivalence
for every JavaScript/product configuration. See the [self-improvement procedure](../CONTRIBUTING.md).
