# Native spec-driven development connectors

Untangle complements spec-driven development by tracing local declarations into explicit
feature/code/test evidence. It does not replace your framework's workflow or execute its
agents. The concrete connectors are **Spec Kit** and **OpenSpec**.

## Start without changing the project

```bash
untangle product connect auto --root=/path/to/project --dry-run --format=json
```

The connector reads supported framework artifacts and explicit literal file references.
It returns `report.frameworks`, source hashes, requirements, tasks, file-reference provenance,
issues and `report.draft`. No framework script, tool installer, test, embedding provider or
network service is executed. A supported marker without usable declarations is incomplete,
not a successful feature import.

To explicitly save the connection:

```bash
untangle product connect spec-kit --root=/path/to/project --format=json
untangle product connect openspec --root=/path/to/project --format=json
```

The result includes `manifestPath` and `reportPath` under
`<physical-project-root>/.untangle/sdd/<framework>-<artifact-digest>/`. Files are versioned,
exclusive and idempotent for unchanged inputs. Differing existing files and symlinks are
preserved/rejected rather than overwritten. The writer re-inspects sources and rejects a
stale preview. It does not modify upstream specs, task checkboxes, ownership files or
existing Untangle declarations.

## Spec Kit

Supported local layout:

```text
.specify/
  memory/constitution.md
  feature.json                 # optional current feature_directory
specs/
  001-accounts/
    spec.md
    plan.md
    tasks.md
    research.md
    data-model.md
    quickstart.md
    contracts/...              # read only when explicitly referenced
```

The `.specify` marker identifies the framework. Feature specs under `specs/<feature>/spec.md`
are grouped with supported sibling documents. Explicit references may also identify contract files. The current Spec Kit
`feature.json` `feature_directory` can select a custom physical directory inside the
chosen project; traversal, outside paths and symlinks are rejected.

The connector reads explicit `FR-*` requirements and `SC-*` success criteria from supported
specification sections, plus task IDs, checkboxes and optional `[US*]` story references.
Explicit file references in plans/tasks/docs are resolved to actual in-root files, with
source line and content hashes. Missing/unsafe/ambiguous references remain visible.
Neither a story marker nor a checked task establishes a feature dependency or passing test.

This adapter is grounded in the official upstream artifacts at revision
`ba8363f8ab56b2da456a81299cfdbfee1ef7b871`:
[specification template](https://github.com/github/spec-kit/blob/ba8363f8ab56b2da456a81299cfdbfee1ef7b871/templates/spec-template.md),
[task template](https://github.com/github/spec-kit/blob/ba8363f8ab56b2da456a81299cfdbfee1ef7b871/templates/tasks-template.md),
[feature-directory resolution](https://github.com/github/spec-kit/blob/ba8363f8ab56b2da456a81299cfdbfee1ef7b871/scripts/bash/common.sh).
The report records these references. This identifies the implemented artifact contract,
not compatibility with every future framework release.

## OpenSpec

Supported local layout:

```text
openspec/
  specs/
    accounts/spec.md
  changes/
    add-account-lookup/
      proposal.md
      design.md
      tasks.md
      specs/accounts/spec.md
    archive/...                # deliberately excluded
```

Current capability specs and active change directories produce separate proposed feature
identities. Requirements/scenarios retain headings, bodies, source lines and hashes.
`ADDED`, `MODIFIED` and `REMOVED` requirement sections retain their delta meaning; removed
requirements remain evidence without becoming proposed acceptance criteria. Checkbox state
is recorded separately from implementation/test evidence.

The connector does not execute schemas, generators, commands or remote stores. Archive
imports and arbitrary custom framework layouts are outside this version's scope. The
implemented contract is grounded in upstream revision
`2bd5bc3be964404657439f538857fcdf550f7398`:
[concepts](https://github.com/Fission-AI/OpenSpec/blob/2bd5bc3be964404657439f538857fcdf550f7398/docs/concepts.md),
[spec-driven schema](https://github.com/Fission-AI/OpenSpec/blob/2bd5bc3be964404657439f538857fcdf550f7398/schemas/spec-driven/schema.yaml).

## Review the resulting feature manifest

All imported features remain `stage: planned`, `review: proposed`, with no invented
owners. Code/test scopes contain only actual resolved literal references, not inferred
whole-feature boundaries. Requirements become proposed criteria without guessed per-case
test mappings. No feature dependencies are inferred. Task completion does not promote any
of these declarations.

Review the returned manifest, include private helpers/other responsibility, declare owners
and authoritative intent, and map actual acceptance tests. Then use its actual path:

```bash
untangle product --root=/path/to/project --manifest=.untangle/sdd/<connection>/untangle.features.json --format=json
untangle graph features --root=/path/to/project --feature-map=.untangle/sdd/<connection>/untangle.features.json --format=json
```

`<connection>` is a placeholder for the real saved directory. Existing feature declarations
are not merged automatically. Until you deliberately adopt the draft, keep using your
existing manifest as authority. Product analysis independently checks scan acceptance,
full feature metrics, ownership and source-bound test evidence. A connector reading an
ignored document does not make that document accepted by the product scanner.

The 3D map is a local source-bound snapshot. It can show the imported proposed features,
actual referenced code/tests and missing ownership, without converting visual proximity into
semantic proof. Review draft status and gaps remain visible.

## Guided setup

Choose **Spec-driven setup** in `untangle init --interactive`. If no explicit feature
manifest was chosen, detected supported workspaces are offered. Discovery is read-only;
the final setup review names the proposed import and metadata area. Only final confirmation
writes connector artifacts and passes the saved manifest explicitly to that setup's final
feature inspection/map. Cancelling writes no connector draft. A stale connector preview
fails before applying actions.

## Bounds and evidence

Connector reads are bounded: 512 documents, 2 MiB per file, 16 MiB total bytes, 4,096
walked entries, depth 12 and 128 feature groups. The report distinguishes limits, invalid
input, unresolved templates, unsafe sources, missing requirements and stale content.
Those limits are not hard elapsed-time or memory guarantees. Hashes bind inspected files,
not an atomic snapshot of every repository source. Reconnect after framework/source changes.

Core port tests cover both frameworks, custom directories, task/requirement semantics,
unsafe/missing inputs, bounds, cancellation and staleness. CLI tests exercise real local
artifact writes and product consumption. Public CLI workflow fixtures independently
connect both frameworks, measure actual referenced code and generate the map; tests remain
`not_run` unless separately executed. These are contract proofs for the supported layouts,
not semantic conformance, ownership authentication or a productivity claim.
