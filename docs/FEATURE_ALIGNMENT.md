# Declared feature alignment V1

`untangle product` connects declared intent to complete local code scopes, tests and
ownership declarations. Agents can inspect that chain and measure code complexity per
feature without an index, Qdrant, Ollama, an LLM or embeddings.

```bash
untangle product --root=/path/to/project --format=json
untangle product --root=/path/to/project --path=src/accounts/lookup.ts
untangle product --root=/path/to/project --manifest=docs/features.json --feature=accounts.lookup --format=text
untangle product --root=/path/to/project --max-cognitive=15 --require-complete --format=json
```

The default manifest is `untangle.features.json`. Untangle invents no features or owners
for a new codebase: without declarations, the report is `needs_manifest` with an empty
draft. `init --feature-map=docs/features.json` adds declared alignment to document
inspection; otherwise it looks for the default. Inspection itself writes no feature map
and confirms no implementation.

## Start with or without an existing specification

`init --offline --dry-run` inspects the current project and documents without services.
An existing literal code path and a caller-chosen ID can seed an explicit review draft:

```bash
untangle product --draft --feature=accounts.lookup --path=src/accounts/lookup.ts --format=json
```

Only when the manifest is missing does `report.draft` contain this proposal. No file is
written. Extend the initial path to cover private helpers and the complete responsibility;
intent, ownership, tests and criteria remain empty until declared. `planned`/`proposed`
confirm no implementation. Existing maps are preserved.

[Spec Kit and OpenSpec connectors](./SDD_CONNECTORS.md) provide a concrete alternative:
they inspect local requirements/tasks and explicit file references, then save an explicitly
requested, source-bound draft under `.untangle/sdd/`. Framework checkboxes are not test
execution evidence. Review and complete the resulting manifest before treating its
boundaries as authoritative.

Once reviewed, a literal search-hit path connects search to declared responsibility:

```bash
untangle product --path=src/accounts/lookup.ts --format=json
```

`selection.matches` includes every matching feature and its `code`, `test`, `intent` or
`ownership` roles. A file may serve multiple features. Each selected report still measures
its **entire declared scope**; the path filter changes neither global status/coverage nor
the shared-code union. `missing`, `not_in_scan`, `unmapped`, `changed` and `unreadable`
remain distinct. Globs/traversal are invalid here. MCP exposes the same lookup through
`untangle_product({path: "src/accounts/lookup.ts"})`.

## Manifest and domain review

A stable ID is an explicit project decision. A search term, document name, embedding or
Journey HMAC does not replace it. Use the same declared `featureId` in an explicitly
started Search Journey to compare reports without merging their evidence meanings.

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
          "description": "All reported regression cases in lookup.test.ts pass without skips.",
          "tests": ["src/accounts/lookup.test.ts"]
        }
      ],
      "dependsOn": [],
      "budgets": { "maxCognitivePerUnit": 15 }
    }
  ]
}
```

Referenced documents, headings and test files must exist. Headings are normalized, not
matched by guessed semantic similarity. `code` includes the whole declared responsibility
and private helpers; `tests` is separate. Path selectors never authorize reading ignored
or excluded sources. Every code/test include selector must resolve to an accepted file
inside its selection. Criterion test selectors must resolve within the feature's selected
tests. Ignored, excluded or unmatched selectors remain visible gaps.

`stage: implemented` is a declaration; `review: proposed` leaves domain review open. A
work-package role is legitimate declared evidence, not an authenticated person or confirmed
durable owner. `confirmed` and `confirmedBy` record explicit manifest confirmation without
independently verifying the actor's identity. Unknown ownership remains a gap.

## Executed tests and source binding

Existing test files are not execution evidence. `--test-evidence` accepts an actual report
in the `ProductTestEvidenceV1` contract:

```json
{
  "schemaVersion": 1,
  "sourceTreeBefore": "<accepted inventory digest before the test run>",
  "sourceTreeAfter": "<the same digest after the test run>",
  "command": ["pnpm", "test", "--", "src/accounts/lookup.test.ts"],
  "exitCode": 0,
  "tests": [
    {
      "path": "src/accounts/lookup.test.ts",
      "name": "returns the account for the exact identifier",
      "status": "passed"
    }
  ]
}
```

Placeholders are not acceptance evidence. The runner must capture actual outcomes and
inventory binding. Both digests must equal the current report's `sourceTreeDigest`; HEAD
alone is insufficient. Invalid/stale evidence is reported. `proof: supplied_source_bound_report`
means Untangle reads supplied data without executing or authenticating that runner.

Store execution reports in ignored metadata such as `.untangle/product-tests.json` to
avoid a report including its own hash in its inventory. Explicit evidence files inside
the root can be read from ignored metadata; product sources remain scan-bound.

Feature inventories/digests always exclude the root `<root>/.untangle/` metadata area,
even without an ignore rule. Index/cache/Journey files there consume no inventory budget
and do not stale unchanged product sources/test evidence. The same exclusion applies to
supplied init/scanner censuses. Actual code changes still alter the digest; similar names
such as `src/.untangle/` and `.untangleignore` remain ordinary inputs. General scanner/parser
rules are unchanged.

File-level criteria require all reported cases of the selected files to pass without
skips. Narrower criteria can declare exact `testNames`. One passing case does not prove
unrelated requirements in the same file; choose the full regression file or explicit cases.

```bash
untangle product --test-evidence=.untangle/product-tests.json --format=json
untangle product --path=src/accounts/lookup.ts --run-tests -- pnpm exec vitest run src/accounts/lookup.test.ts
```

Arguments after `--` execute without a shell. Untangle supplies JSON reporter/output
arguments and rejects conflicting caller reporter/output flags. Only Vitest-compatible
JSON is supported. Default timeout is 120 seconds; `--test-timeout=MS` permits at most
one hour. stdout/stderr share a 16 MiB limit; JSON has another 16 MiB limit. Timeout and
cancellation terminate the child-process tree.

Full test names must be unique within each file. Parameterized `it.each` titles need
distinguishable values or indices. Duplicates identify the file/name and invalidate the
report; identical names in different files are allowed. Runner exit 0 does not replace
unique identities or valid source binding.

`testRun.directory`/`receiptPath` identify an exclusive OS-temporary directory with complete
before/after inventories, actual argv/exit, original report, raw copy, identities and
artifact hashes. Archive it for retention; the OS may remove temporary files. A full
post-cancellation inventory preserves binding but can delay responses on large projects.
External toolchains, configuration outside the accepted inventory and compatible-runner
correctness remain unauthenticated.

Failing tests exit 5 and remain `bound_failed`; skips do not satisfy criteria. Source changes
yield `stale`. Timeout, spawn failure, cancellation, output limit and invalid reports remain
distinct; runner failures exit 1. `--run-tests` and `--test-evidence` are mutually exclusive.
The MCP product tool remains read-only and executes no processes.

`pnpm e2e:product` exercises built interfaces on isolated TypeScript/Python projects with
real passing/failing/skipped/source-changing Vitest cases. Python gets AST measurements
and an honest `not_run` status. These fixtures test contracts, not productivity gains.

## Measurements and agent hints

Reports measure complete selected files from the local inventory. Code and tests have
separate metrics, hashes and coverage. Cognitive and cyclomatic classic/extended readings
include `execution_unit`, `self` and `top_level`, plus SLOC, scopes and execution units.
Cyclomatic includes a base per contributing scope, so adding a helper may raise the total.

`execution_unit` is the primary reading: outer functions carry nested responsibility;
nested functions are not added again. Refactors compare the complete scope including new
helpers, individual hotspots and other readings. Unreadable, changed, partial or unsupported
files are never zero complexity. Ignore rules and analysis limits remain visible.

V1 input limits:

| Input | Limit |
|---|---|
| Accepted files | 50,000 |
| Analyzed file | 5 MiB, checked before and after reading |
| Features / owners | 128 each |
| Intent references / criteria per feature | 32 / 128 |
| Entries per path selection | 512 |
| Selectors across the manifest | 8,192 |
| Consecutive `*` groups in a glob | Four per segment, 16 total |
| Document parse | 16,384 characters per line; 2,048 headings |
| Test report | 16 MiB; 100,000 identities |

These are not hard time, memory or I/O guarantees.

Shared files appear in each feature; `mappedCodeUnion` counts their unique union once.
Summing per-feature totals therefore does not yield global complexity. If a declared code
scope is incomplete, the union is `null`; a measurable subset does not replace a complete
total. Unmapped code remains visible. `dependencyCycles` concerns declared `dependsOn`, not
a resolved file/symbol graph.

Budgets and hints identify large units, many files, shared code, owner spread and cycles as
structural heuristics. Suggested fresh symbol/path queries can inspect callers/callees and
neighbors; search hits do not replace full-file measurement. `--max-cognitive=15` sets the
per-unit threshold. Without `--require-complete`, a produced report exits 0 even for open
review or violations; with it every status except `evidence_consistent` exits 5, while
stdout still contains the report.

Overall statuses are `needs_manifest`, `invalid_manifest`, `needs_review`, `incomplete`,
`violated` and `evidence_consistent`. Even consistent evidence retains
`semanticConformance: not_independently_proven` and `ownershipAuthority: manifest_declarations`.
A proposed self-map is not presented as human-approved success.

## Interactive feature/code map

```bash
untangle graph features --format=json
untangle graph features --feature-map=.untangle/sdd/<connection>/untangle.features.json --format=json
```

The offline HTML and JSON snapshot stay in `.untangle/feature-map/`. The 3D wool-like network
uses actual declared associations; rotation, zoom, filtering and neighbor isolation help
inspect shared responsibilities. Spatial proximity is a layout choice, not semantic proof.
No cloud/CDN or live-code watcher is implied. English controls preserve original project
labels. Node/edge caps truncate rendering explicitly, while complete feature reports retain
their measurement scopes. Keyboard/list access and reduced-motion behavior are provided;
static/runtime tests are separate from actual browser visual/accessibility acceptance.

The **Untangle by** selector is independent of the layer filter. Each choice provides its
own reversible layout: declared feature scopes, code directories, test directories,
declared owner context, source-document context, or unassigned file directories. For code
and tests, the directory key is the first two repository-relative directory segments;
root files remain explicit. Mixed code/test roles are retained. Ownership and document
context follow typed declarations through features, without inferring file ownership or
specification conformance. A node spanning several contexts stays in Shared context;
missing context stays explicit. Switching categories returns to the tangle and waits for
an explicit action. Every mode preserves nodes, edges, measurements and evidence states.
The keyboard-accessible **Groups** disclosure lists complete names and snapshot-node counts
at normal UI text size. Filters show visible/total counts; these are not complexity readings.

## Inspect frontend and backend together

`graph boundaries` reads current sources directly without an index or running backend.
It adds an HTTP dependency report; HTTP requests are not synchronous function calls and do
not redefine existing file/call graphs.

```bash
untangle graph boundaries --root=/path/to/project --path=src/Orders.vue --format=json
untangle product --root=/path/to/project --path=src/Orders.vue --format=json
```

Declare service boundaries in `.untangle/services.json`:

```json
{
  "schemaVersion": 1,
  "services": [
    {
      "id": "browser-api",
      "frontendRoots": ["apps/web/src"],
      "backendRoots": ["backend/app"],
      "sameOrigin": true
    }
  ]
}
```

`sameOrigin` declares relative-browser-request responsibility, for example after reviewing
proxy configuration. `origins` can add allowed HTTP(S) origins. No secret environment values
are read and no service is contacted. Unmapped requests remain `unresolved`; multiple
matching routes remain `ambiguous`. Matching URL paths alone prove no service boundary.
`--services=other/path.json` selects a control file; changes during analysis prevent confirmed
results.

The first scope supports Vue scripts and existing JS/TS/JSX/TSX parsers, statically resolvable
`fetch` and bounded local wrappers, plus FastAPI routes with import aliases, router prefixes
and static `include_router`. Unsupported expressions, mutable values, foreign origins and
unclear registrations stay visible. Runtime activation, authentication and executed branches
are not proven.

`importContext` connects relative imports from a Vue/JSX/TS file to its HTTP client; it does
not prove template-event/function execution. Declared feature code/test scopes and owners
are attached to affected paths. Observed HTTP edges never automatically alter feature
`dependsOn` or confirm boundaries. Path filtering follows complete route inventory;
`--max-relations` reports truncation. MCP exposes `untangle_boundaries` with `path`,
`servicesFile` and `maxRelations`.

Vue's official SFC parser splits blocks before existing adapters analyze original inline
scripts. Symbols/imports/calls/control-flow metrics retain source positions. Templates,
directives, styles/custom blocks are outside script complexity and reported as
`analysis_scope_limited`/`no_metric_defined`. File SLOC includes the physical SFC. External or
unknown scripts, template-only and damaged SFCs do not yield complete code measurement.
Svelte/Astro remain unimplemented. Reindex after switching to the Vue adapter: freshness
binds registered parser versions and does not label an old text index as current AST data.

## Untangle inspects Untangle

[`untangle.features.json`](../untangle.features.json) is the declared self-map, linking built
areas and infrastructure to real source/test paths and headings. Roles originate in the
[ownership matrix](./BUILD_PLAN.md#4-dateibesitz-matrix): owners remain `declared`, reviews
`proposed`, and newer areas without a clear matrix entry keep ownership open. Full Change
Intelligence and independent artifact indexing/search remain planned, separate features.

Feature count is a taxonomy decision, not an objective feature-richness score. A same-feature
simplification compares criteria, test identities, CLI/MCP/API contracts, actual search cases
and complete measurement scopes before/after. The [repository procedure](../CONTRIBUTING.md)
still applies; the general automatic `reduce-complexity` loop is not implemented. Agents get
the same report through `untangle_product` with an explicit root; `untangle_search_session`
remains a separate, explicitly started search sensor.
