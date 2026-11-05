# @untangle-code/symbol-graph

Untangle's symbol graph (`spec.md` §15, `architecture.md` §17). It answers three questions:

- **Who calls this symbol?** (reverse traversal, impact)
- **What does it call?** (forward traversal, call flow)
- **Which path leads here from an entry point?** (path search, entry point detection)

Pure and deterministic: no I/O, `Date.now()`, `Math.random()` or `localeCompare`.
Callers that need a time budget supply a time source (`now`); the package does not obtain one.

Normative sources: [`spec.md`](../../spec.md) §15 (takes precedence in conflicts),
[`architecture.md`](../../architecture.md) §17, `docs/BUILD_PLAN.md` §12 (E4) and WP-88.

<a id="die-eine-regel"></a>

## The governing rule

**An edge never claims greater precision than its derivation supports.**

| Resolution kind | When | Confidence basis |
|---|---|---|
| `exact` | A declaration in the same file, or an import binding whose module the **file graph** resolved, whose **alias mapping the adapter reported** (`RawImport.bindings`), and whose target file contains exactly one matching export | `deterministic`, value 1 |
| `heuristic` | A name match without proof: a workspace-wide unique name; a qualifier matching a known scope | `heuristic` |
| `ambiguous` | Multiple candidates match. **All** remain on the edge | `heuristic`, value < 1 |
| `unresolved` | No candidate. Named reason **and** mandatory detail | `heuristic`, value 0 |

A qualified call (`service.run()`) **never** reaches `exact`: its receiver is not statically
proven. Nowhere in this package does ambiguity silently select one candidate. This is the
core of E4 for graphs.

**Why alias mapping is a condition:** `RawImport.importedNames` carries only the *local* name.
For `import { run as go } from "./lib"`, it contains `go`; comparing that name with the target
file's exports would bind `lib.go` instead of `lib.run` and report it as `exact`/`deterministic`.
`validateSymbolEdge` cannot catch this: the edge is internally consistent, but its target is
wrong. Enforcement therefore sits where `exact` is *claimed* (`resolve.ts`), rather than only
on the finished edge. If an adapter reports no bindings, the edge remains `heuristic` with the
`import_alias_unreported` signal.

If a file binds the same name more than once (`from alpha import run` and `from beta import run`),
**no** binding wins: all contribute candidates, the edge becomes `ambiguous`, and the collision
is recorded in the ledger with both specifiers.

<a id="modulübersicht"></a>

## Module overview

| Module | Contents |
|---|---|
| `types.ts` | Input and output wrappers: `SymbolGraphFileInput`, `SymbolGraphV1`, `CallPathV1`, `ImpactResultV1`, `EntryPointV1` … All persisted data retains domain types |
| `collect.ts` | Bridge from `LanguageAdapter`/`ParseResult` to graph input; catches failures and explains them in the ledger |
| `file-graph-bridge.ts` | `resolvedImportsFromFileEdges()` — file graph edges (`FileEdgeV1`, a domain type) as additional input |
| `nodes.ts` | One `SymbolNodeV1` per `ExtractedSymbol`; `contentHash` over actual source bytes |
| `resolve.ts` | Name indexes and resolution with accurately reported confidence |
| `build.ts` | Construction: nodes, edges, ordinals, ledger, metrics |
| `bindings.ts` | Edge → binding(s): an ambiguous edge produces **one binding per candidate** |
| `graph-index.ts` | Adjacency index (`callees`/`callers`) in deterministic order |
| `traverse.ts` | Breadth-first search with all four limits and cycle protection |
| `paths.ts` | Shortest path and all paths up to depth N |
| `impact.ts` | Reverse traversal weighted by resolution confidence |
| `entry-points.ts` | Entry point detection (WP-88), structurally typed as a heuristic |
| `metrics.ts` | Graph metrics |
| `persistence.ts` | Workspace- and generation-scoped roundtrip of nodes, edges, metrics and skip ledger through `GraphStore` |

<a id="benutzung"></a>

## Usage

```ts
import { createParserRegistry } from "@untangle-code/parser-registry";
import {
  analyzeImpact,
  buildSymbolGraph,
  collectSymbolGraphFiles,
  createSymbolGraphIndex,
  detectEntryPoints,
  findShortestCallPath,
  readSymbolGraphSnapshot,
  writeSymbolGraphSnapshot,
} from "@untangle-code/symbol-graph";

const registry = createParserRegistry();
const parsed = sources.map((source) => {
  const adapter = registry.getAdapterForPath(source.path);
  if (adapter === null) return null;
  return { adapter, source, parseResult: adapter.parse(source) };
});

const collected = collectSymbolGraphFiles(parsed.filter((entry) => entry !== null));

const graph = buildSymbolGraph({
  workspaceId,
  graphGeneration,
  files: collected.files,
  // Optional but valuable: the file graph's module resolution result.
  // Without it, import edges remain heuristic rather than claiming false certainty.
  resolvedImports,
});

const index = createSymbolGraphIndex(graph);
const path = findShortestCallPath(index, { fromSymbolId, toSymbolId, limits });
const impact = analyzeImpact(index, { rootSymbolIds: [changedSymbolId], limits });
const entryPoints = detectEntryPoints(index);

await writeSymbolGraphSnapshot(store, graph, writeId);
const persisted = await readSymbolGraphSnapshot(store, {
  workspaceId,
  generationId: graphGeneration,
});
```

<a id="entscheidungen"></a>

## Decisions

1. **Call site → caller symbol through range containment, not `callerScopeId`.**
   `RawCall.callerScopeId` is an adapter-internal identifier; its structure belongs to the
   language adapter and is not a public contract (`ExtractedSymbol` does not even carry it).
   Instead, this package chooses the **innermost symbol whose byte range contains the call
   site**. The rule is the same for every language and needs only what `ExtractedSymbol`
   already provides. An integration test against the real parser confirms that both approaches
   produce the same result.

2. **Calls outside every symbol do not become edges — and are not silently discarded.**
   Module-level code has no source symbol, so it cannot form a symbol-to-symbol edge. Each
   such site receives a skip ledger entry with reason `missing_index_entry` (E4).

3. **This package does not resolve module specifiers itself.** That belongs to the file graph;
   its result arrives as `ResolvedImportTargetV1[]`. A second, competing module resolver would
   split the contract. Without this input, the edge remains `heuristic` with the
   `module_resolution_missing` signal. `resolvedImportsFromFileEdges()` performs the conversion
   against the **domain type** `FileEdgeV1`, keeping this package independent of the file graph
   package.

4. **`contentHash` covers actual source bytes.** `ExtractedSymbol` provides `astHash` and
   `tokenFingerprint`; both answer “did the *shape* change”, rather than “did the *content*
   change”. `SymbolGraphFileInput` therefore requires the file content, and `nodes.ts` slices
   out the symbol range through a `Buffer` (byte offsets, not character indexes).

5. **One edge per call site, not per target name.** `occurrenceOrdinal` numbers identical
   (source, kind, target name, qualifier) occurrences; `sites` contains exactly the single
   originating site. The edge ID deliberately depends only on the source side: a better
   resolver changes resolution, not identity. A test verifies this.

6. **Impact uses the product of binding weights, not their minimum.** Each additional uncertain
   binding weakens the claim: three consecutive heuristic steps provide less support than one.
   The search chooses the path with the **largest product**, rather than the shortest path;
   a longer certain path gives stronger support.

7. **No SCC/centrality calculation.** `spec.md` §14.4 requires this for the **file graph**;
   calculating it here as well would give two formulas for the same question. Traversal's
   cycle protection remains visible: skipped revisits appear in
   `TraversalResultV1.revisitSkippedSymbolIds`.

8. **The path limit is not a traversal reason.** `TRAVERSAL_TRUNCATION_REASONS` includes depth,
   nodes, edges, time and cancellation, but no path count. Rather than using an inaccurate
   reason, `AllCallPathsResultV1` has its own explicit `pathLimitReached` field, plus
   `droppedPathCount` and a ledger entry.

9. **Entry point detection is structurally a heuristic.** `EntryPointV1.isHeuristic` is typed
   as the literal `true` and `confidence.basis` as `"heuristic"`, the same design as
   `FindabilityDiagnosisV1` in the domain. Negative type tests (`@ts-expect-error`) verify
   that the result cannot masquerade as a measurement.

10. **Route detection without framework names (E2).** Detection recognizes a **directory
    convention** (segments such as `routes`, `controllers`, `endpoints`), not a particular
    product. The result's explanation states this explicitly.

11. **Persistence has two scope dimensions.** The logical shard ID contains a collision-free,
    length-prefixed workspace ID; every store read also specifies the generation. The payload
    is then checked again for workspace and generation. There is no unscoped `latest` read.
    The global `symbol-graph` shard from older versions is read only with explicit
    `{ allowLegacyFallback: true }` and must carry the same scope and a complete skip ledger.

<a id="sprachagnostik"></a>

## Language independence

The graph does not assume that every language has symbols (`vision.md` §1c). For Markdown,
text and configuration, an **empty symbol graph is the correct result** — neither an error
nor a ledger entry: nothing was skipped because nothing was present. A ledger entry arises
only when something present is omitted (a failed parse, duplicate, call without a source
symbol, discarded candidate or unknown root).

<a id="e4-im-einzelnen"></a>

## E4 in detail

These locations write to the skip ledger instead of silently dropping information:

| Location | Reason | When |
|---|---|---|
| `collect.ts` | `parse_failed` | No AST, or an extractor throws |
| `nodes.ts` | `duplicate` | Two symbols derive the same ID |
| `build.ts` | `duplicate` | The same `fileId` is supplied more than once |
| `build.ts` | `missing_index_entry` | Call outside every symbol range |
| `build.ts` | `resolution_failed` | Empty target name; edge violates `validateSymbolEdge` |
| `build.ts` | `ambiguous_resolution` | A candidate exceeds `maxCandidates`; a name has multiple bindings; two conflicting module results refer to the same specifier |
| `traverse.ts`, `impact.ts` | `missing_index_entry` | Unknown root symbol |
| `traverse.ts`, `impact.ts` | `excluded_by_configuration` | Reachable symbol excluded by a limit (`maxDepth`, `maxNodes`, time) — **named**, not just `truncated` |
| `impact.ts` | `excluded_by_configuration` | Path below the confidence threshold (checked **against the result**: an included symbol never appears in the ledger) |
| `paths.ts` | `excluded_by_configuration` | Path beyond `maxPaths` |

## Tests

```bash
pnpm --filter @untangle-code/symbol-graph run test
pnpm --filter @untangle-code/symbol-graph run typecheck
```

145 tests in 17 files. `src/integration.test.ts` runs against the **real** parser
(`@untangle-code/parser-registry`) with its actual grammars, rather than a recreated adapter (E5).

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
