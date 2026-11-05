# @untangle-code/file-graph

Untangle's file dependency graph (spec.md §14, architecture.md §16).

It answers three questions:

1. **Which file depends on which?** — `dependenciesOf(fileId)`
2. **What could break if I change this file?** — `dependentsOf(fileId)`
3. **How are a monorepo's subprojects connected?** — `loadWorkspaceTopology(...)`,
   at **two** levels: packages (`workspace:` protocol, `exports` maps) **and**
   container services (`depends_on`, shared networks).

The package does not parse source itself. It receives the `RawImport` lists produced by a
`LanguageAdapter` (`@untangle-code/parser-registry`), so the parser can be replaced independently.

`analyzeHttpBoundaries` also processes the parser package's `HttpBoundaryFileFactsV1`
AST projections. These HTTP relationships form a separate report; they do not add import
or synchronous call edges. Associations require explicit `HttpServiceBindingV1`
declarations; unknown origins, methods, registrations and multiple candidates are not
resolved through guesses. Static route construction does not confirm that the route is
actually active in the deployed ASGI process. The local entry point and its limits are
described in [feature alignment](../../docs/FEATURE_ALIGNMENT.md#frontend-und-backend-gemeinsam-prüfen).

---

<a id="benutzung"></a>

## Usage

```ts
import { NodeFileSystem } from "@untangle-code/scanner/node-fs";
import {
  aliasRulesFromConfigs,
  buildFileGraph,
  loadWorkspaceTopology,
} from "@untangle-code/file-graph";

const fs = new NodeFileSystem();
const repositories = [{ repoId, refId, rootPath: "/abs/path/to/repo" }];

// 1. Read topology (the ONLY part that touches the file system)
const { topology, projectConfigs } = await loadWorkspaceTopology(fs, {
  workspaceId,
  generationId,
  repositories,
});

// 2. Build the graph (pure, without I/O)
const graph = buildFileGraph({
  workspaceId,
  graphGeneration: generationId,
  repositories,
  files, // FileImportsV1[] from the scanner and parser
  topology,
  projectAliases: aliasRulesFromConfigs(projectConfigs),
});

// 3. Query the graph
const impact = graph.dependentsOf(fileId, { maxDepth: 12 });
const metrics = graph.metrics();
const snapshot = graph.snapshot(); // serializable, deterministic

// 4. Update incrementally instead of rebuilding
graph.applyChanges([{ kind: "modified", file: changedFile }]);
```

Persist through the existing `GraphStore` port:

```ts
import { readGraphSnapshot, writeGraphSnapshot } from "@untangle-code/file-graph";

await writeGraphSnapshot(store, graph.snapshot(), writeId);
const { snapshot, issues } = await readGraphSnapshot(store, {
  workspaceId,
  generationId,
});
```

---

<a id="aufbau"></a>

## Structure

| Module | Responsibility |
| --- | --- |
| `paths.ts` | Repository-relative POSIX path arithmetic; `joinRelative` returns `null` instead of clamping at the root |
| `file-index.ts` | Lookup table of all known files — the sole source for resolution |
| `topology/` | `package.json`, `tsconfig*.json` (with `extends`), `pnpm-workspace.yaml`, composition files |
| `resolve/` | Candidate generation, `exports`/`imports` maps, the eight resolvers, the pipeline |
| `edges.ts` | `RawImport` → `FileEdgeV1`, boundary calculation, skip ledger |
| `metrics.ts` | Tarjan SCCs, cycles, orphans, centrality, distributions — all iterative |
| `graph.ts` | Node construction, traversal, incremental updates |
| `persistence.ts` | Mapping to `GraphShardV1` through the existing `GraphStore` port |

### Resolver pipeline

In the order specified by architecture.md §16.2:

```
relative-path → runtime-builtin → subpath-import (#) → python-module
              → project-alias → configured-alias → workspace-package → installed-package
```

A resolver that claims an import but finds **no** match does **not** end the search — the
next applicable resolver can try. An unresolved edge is created only after every applicable
resolver has been tried, and it records the trace of all attempts.

---

<a id="entscheidungen"></a>

## Decisions

**1. No separate storage port.** `GraphStore` from `@untangle-code/domain` already provides
exactly the three collections a file graph needs: `graph_files`, `graph_indices` and
`graph_meta`, with a contract suite in `@untangle-code/testkit` and two adapters. A second
port would describe the same semantics twice. Instead, `persistence.ts` maps the graph to
`GraphShardV1` — one shard per file, so incremental updates write back exactly the files
that were recomputed. Each logical shard ID is namespaced with a length-prefixed workspace
ID; the generation remains the store's explicit version dimension.

**2. A dedicated traversal type.** `TraversalResultV1` from `domain` uses `*SymbolIds` field
names, which would be incorrect for files. `FileTraversalResultV1` keeps the mandatory parts
(`TraversalLimitsV1`, `TraversalDirection`, `TraversalTruncationReason`) unchanged, gives the
fields file-specific names and adds `cycles`. No domain type was renamed: three other agents
were building against `domain` at the same time.

**3. `unresolvedImportCount` counts by `resolution.status`, not `kind`.** The `FileNodeV1`
documentation comment says “edges with `kind: "unresolved"`”, but the normative rule in
`validateFileEdge` requires an unresolvable import to retain `kind: "import"`. Counting by kind
would produce 0 in every real run, concealing exactly what the metric is meant to reveal
(E4). The count therefore uses resolution status.

**4. Resolution without file system access.** All module resolution operates against
`FileIndex`. Resolution that reads from disk is neither reproducible nor testable without a
real repository. Reads occur only in `topology/load.ts`, and even there use `FileSystemPort`,
never `node:fs`.

**5. Three reverse mappings this repository needs.**

- *ESM extension*: TypeScript under `NodeNext` writes `./registry.js` and means `registry.ts`.
  The source file's language determines which extension is tried first: the source extension
  wins in TypeScript, the written extension in JavaScript.
- *Build output*: an `exports` map points to `dist/index.js`; the project configuration's
  `rootDir`/`outDir` maps it back to `src/index.ts`.
- *Condition order*: runtime conditions (`node`, `import`, `require`, `default`) precede
  `types`, because a `types` match points to a `.d.ts` file absent from the source index.

**6. Two kinds of service edges.** `depends_on` is directed and answers “who needs whom
first”; `shared-network` is undirected (represented as two opposing edges) and answers
“who can reach whom”. Services without their own `networks` declaration join the implicit
`default` network. Omitting this would report zero reachability edges for the most common
composition files, even though every service can reach every other service.

**7. A package name in the catalog IS a workspace edge**, even without a `workspace:` prefix.
pnpm resolves `"^1.0.0"` to a local package when its version matches; checking only the protocol
would lose those edges.

**8. An established YAML reader (`yaml`, licensed under ISC).** An ad hoc parser would be
particularly costly here: composition files use anchor references, block scalars and both
forms of `depends_on`. `@untangle-code/context-artifacts` has its own `yaml-lite`, but it is
internal to that package and designed to split text into blocks rather than read a structure.

**9. No overlap with `context-artifacts`.** That package splits composition files into
*retrieval chunks* (one chunk per service). This package reads *topology* from the same file:
startup order, networks, build contexts and file → service associations. These are two
different questions about the same file; there is no shared code or duplicate assertion.

**10. A tolerant JSON reader instead of `JSON.parse`.** Project configurations may contain
comments and trailing commas (this repository's `tsconfig.base.json` does). Throwing an error
here would silently remove every path alias from a package.

---

<a id="e4-in-diesem-paket"></a>

## E4 in this package

“No silent skipping.” Specifically:

| Case | Behavior |
| --- | --- |
| Unresolvable import | Retained as an **edge** with `kind: "import"`, `status: "unresolved"`, a named reason, mandatory detail text and the list of checked candidates |
| Import without a specifier | No edge is possible (`rawSpecifier` must never be empty) → **ledger entry** with source range |
| Import list not extracted | `importsMissingReason` → **ledger entry**; otherwise an unparsed file would appear to have no imports |
| Unreadable manifest/composition file | **Ledger entry**; a subproject never silently disappears from the topology |
| `depends_on` names an unknown service | **Warning** in the ledger, no invented edge |
| Cycle list reaches its budget | `truncationReason` on the metrics |
| Traversal reaches its budget | `truncated` + `truncationReason` |
| Cycle during traversal | `cycles` **and** `revisitSkippedFileIds` — reported, not broken |

Checked candidates serve more than diagnostics: incremental updates use them to recompute
**exactly** the files whose resolution could change when a file is added.

---

<a id="inkrementelle-fortschreibung"></a>

## Incremental updates

- `modified` (content changed, path unchanged): **only** the file itself. Its existence did not
  change, so no other file's resolution could have changed.
- `added` / `removed`: also every file whose resolution depends on this path's existence,
  identified through unresolved edges' `rejectedCandidates`, previous dependents and the
  shadowing case (a new `util.ts` shadows an existing `util.js`).

Tests measure every claim against a **complete rebuild**: after each incremental update,
the snapshot must match, character for character, the result of rebuilding the same file state.

---

<a id="determinismus"></a>

## Determinism

- Never `String#localeCompare` — only `compareCodepoints` from `@untangle-code/domain`.
- No `Date.now()`/`Math.random()` in result data. Traversal accepts an **injectable** clock for
  its time budget; no time value ever enters the result.
- Every list, counter object and ledger entry has canonical ordering, so two runs produce the
  same document and therefore the same hash. This is checked against this repository.

---

## Tests

```bash
pnpm --filter @untangle-code/file-graph test
```

`src/real-repo.test.ts` runs against **this** repository: the real scanner
(`@untangle-code/scanner`), real parser adapters (`@untangle-code/parser-registry`), and real
`package.json`, `tsconfig.json` and composition files. Fourteen packages, the `workspace:`
protocol, `exports` maps, inherited project configurations and ESM extensions in TypeScript
source form exactly the combination that can break resolution tested only against fixtures.

---

<a id="bekannte-grenzen"></a>

## Known limits

- **Language coverage.** The JavaScript/TypeScript family and relative Python imports are
  complete. There are no resolvers yet for Go, Cargo, Maven, .NET or Composer (spec.md §14.3);
  their imports remain unresolved **with** a named reason, rather than being discarded.
  `ImportResolverV1` is the extension point.
- **Packages with the same name in different repositories.** The package catalog is keyed
  by repository *and* name (`WorkspacePackageCatalogV1`, `package-catalog.ts`). A package-name
  import is searched for in its **own** repository first. If none exists there and exactly one
  exists elsewhere, a cross-repository edge is created; multiple external candidates produce
  `ambiguous_candidates` instead of a guess. The name collision itself appears as
  `ambiguous_resolution` in the topology's skip ledger. `boundary.crossPackage` compares
  package *identity* (repository + directory), not its name. `cross-repo.test.ts` exercises a
  workspace with multiple repositories; it does not replace a real multi-repository fixture.
- **Traversal with multiple roots.** A depth limit cuts off only the current branch. Only an
  exhausted global budget (nodes, edges, time) stops traversal entirely, and roots never entered
  are listed in `unvisitedRootFileIds`.
- **Loading snapshots.** `readGraphSnapshot` checks the `graph_meta` payload for its required
  parts (`metrics`, `topology`, `skipped`). If any are missing it returns `null` **with** a named
  issue, rather than a snapshot containing `undefined` fields. Missing file shards are named
  through the path index and also checked against the metadata shard's expected counts
  (`count_mismatch`); a smaller graph without an issue is not possible. The reader always
  requires `{ workspaceId, generationId }`; the old string signature reads nothing. Global
  shards from older versions are accessible only with `{ allowLegacyFallback: true }`, and
  even then are strictly checked against both scope values.
- **`exports` conditions** are evaluated in a fixed order; custom conditions (`development`,
  `browser`) must be passed as parameters.
- **Cycle enumeration** is exponential in the worst case and therefore uses a budget. An
  exhausted budget is recorded in `truncationReason`; the list never claims completeness.

<a id="lizenz"></a>

## License

**AGPL-3.0-only.** This package includes the full license text in [`LICENSE`](./LICENSE),
the rationale for the license choice in [`NOTICE`](./NOTICE), and the licenses of all
third-party production dependencies in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md).
All three files are part of the npm tarball — AGPL-3.0-only §4 and §5 require every recipient
to receive the license, and a README alone is not a copy of the license.

Local use creates no obligation. Copyleft obligations apply to redistribution and provision
as a network service (AGPL §13).

The corresponding TypeScript source is included under `src/` in the same tarball; the full
repository is available at <https://github.com/lboel/untangle>.
