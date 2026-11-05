# @untangle-code/graph-explorer

Produces one self-contained offline HTML explorer from an existing file graph and optional symbol
graph. The package reads no repositories, persists no graphs and builds no graphs. It has no
production dependencies and makes no network requests.

## API

```ts
import {
  createGraphExplorerHtml,
  writeGraphExplorerHtml,
  type GraphExplorerInputV1,
} from "@untangle-code/graph-explorer";

const input: GraphExplorerInputV1 = {
  fileGraph,
  symbolGraph,
  workspace,
};

const artifact = createGraphExplorerHtml(input, {
  title: "Payments workspace",
  initialView: "file",
  initialLayout: "repository-lanes",
  maxNodes: 600,
  maxEdges: 1_200,
});

await writeGraphExplorerHtml("./untangle-graph.html", input);
```

`createGraphExplorerHtml` returns HTML, UTF-8 byte count, SHA-256, effective limits and per-view
statistics. The same domain snapshot and options produce byte-identical HTML even when input
arrays order nodes, edges or repositories differently.

`writeGraphExplorerHtml` first writes to an exclusive temporary file in the same directory,
synchronizes it, then replaces the target through `rename`. The target directory must already
exist. Default file mode is `0o600`, configurable through `mode`.

Input types are intentionally structural. FileGraph, SymbolGraph and workspace snapshots can be
supplied without runtime dependencies on their producers. Workspace ID and graph generation must
agree; invalid or contradictory data produces `GraphExplorerInputError` with code
`GRAPH_EXPLORER_INPUT_INVALID`.

<a id="darstellung-und-bedienung"></a>

## Display and interaction

- File/symbol views; without a symbol graph, the file graph is explicitly shown as fallback and
  the symbol tab is disabled.
- Deterministic `repository-lanes` by default, plus `grid` and `circle`.
- Search highlighting, repository and edge-kind filters.
- Node selection with direct neighbors and cycle-safe reverse-transitive highlighting.
- Inspector with repository, ref, path, language, stable ID, generation and neighborhood.
- Keyboard-operable tabs, nodes, zoom and pan; visible focus and `prefers-reduced-motion`.
- PNG export of the current filtered SVG view through browser canvas, without an external library.
  The longest image side is capped at 4096 pixels.

<a id="grenzen-und-vollständigkeit"></a>

## Limits and completeness

By default, each view exports at most 600 nodes and 1,200 drawable connections. Maximum supported
limits are 10,000 nodes and 30,000 connections. Nodes are ordered by Unicode code points of
`repoId`, `filePath` and stable ID; connections are then deterministically ordered and bounded.

Bounded exports are labeled visibly. Detailed statistics distinguish input nodes, source edges,
expanded candidates, missing endpoints, connections lost to node limits, connections lost to
edge limits and source edges without drawable targets. Ambiguous symbol edges expand into
individual candidate connections without being presented as exact resolutions.

<a id="sicherheitsmodell"></a>

## Security model

Exports contain only explicitly permitted source-free metadata. File contents, signatures, raw
import specifications and unknown extra fields are not serialized. Normalized JSON is encoded as
Base64 in an inert `template` element. Browser code inserts user values only through
`createElement`, `createElementNS`, `textContent` and attributes; no `innerHTML` or comparable
markup sink is used.

CSS and JavaScript are embedded statically and allowed through SHA-256 hashes in a restrictive
CSP. `default-src` and `connect-src` are `'none'`; there are no remote resources, web fonts, CDN
references, dynamic imports or network interfaces. `img-src data: blob:` is required solely for
local canvas PNG export.

The HTML file requires a modern browser supporting SVG, `TextDecoder`, `Canvas`, `Blob` and
object URLs. Search dims nonmatches rather than removing them from the graph. Neighborhood and
reverse traversal always use the currently repository/edge-kind-filtered subset.

<a id="lizenz"></a>

## License

**AGPL-3.0-only.** Complete license text, project notice and production-dependency licenses are in
[`LICENSE`](./LICENSE), [`NOTICE`](./NOTICE) and
[`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md). TypeScript source ships under `src/` in the
same tarball.
