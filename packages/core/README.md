# @untangle-code/core

The index-run pipeline: the connecting component introduced by
`packages/jobs/src/stages.ts` from its first line.

`@untangle-code/jobs` builds index-job MECHANICS: state machine (spec.md §11.1), queues with
backpressure, checkpoints after acknowledged upserts, resume, cancellation at safe batch
boundaries and generation commit. It knows domain stages only as interfaces. This package
implements them against scanner, parser registry, chunker, complexity module, embedding provider,
vector store, file graph and symbol graph, then supplies them to the runner.

<a id="was-hier-drin-ist"></a>

## Contents

| Stage (spec.md §11.1) | Module | Responsibility |
|---|---|---|
| `preparing_infrastructure` | `stages/infrastructure.ts` | Prepare embedder, collection and payload indexes |
| `discovering_files` | `stages/discovery.ts` | Scan, establish identities, compare with manifest |
| `parsing_and_chunking`, `computing_metrics` | `stages/analysis.ts` | Read, parse, chunk losslessly, measure, prepare text |
| `embedding` | `stages/embedding.ts` | Content-addressed cache, then embedding |
| `storing` | `stages/storage.ts` | Build dense/BM25 vectors, upsert idempotently |
| `building_graphs` | `stages/graphs.ts` | Build and persist file/symbol graphs |
| `finalizing` | `stages/commit.ts` | Manifests, deletions, ref/workspace records |

`pipeline.ts` wires everything (`runIndex`), `plan.ts` provides the dry run (`planIndex`),
`ledger.ts` records every skip with its reason (E4), and `offline-embedder.ts` provides a
network-free `EmbeddingProvider` for runs without an embedding service.

<a id="deklarierter-featureabgleich"></a>

## Declared feature alignment

`analyzeFrontendBoundaries` adds an index-free report on static HTTP relationships: current source
hashes, Vue/JS/TS import context, FastAPI routes, declared service bindings and feature/ownership
assignments. It executes neither project code nor servers. A complete repeated file scan and
feature-map check detect intervening changes; this is no atomic filesystem transaction.
Truncated/unresolved relationships remain visible. File imports are not reported as function
calls, and observed HTTP relationships do not change declared feature dependencies.

`analyzeProductAlignment` under `src/product-alignment/` is the local analysis service for
`untangle product` and MCP `untangle_product`. It connects an explicit feature map to the accepted
file inventory, exact vision/spec headings, declared owners and complete code/test scopes. It
requires no index, vector store or embedding provider and writes no files.

```ts
import { analyzeProductAlignment } from "@untangle-code/core";

const report = await analyzeProductAlignment({
  root: "/pfad/zum/projekt",
  maxCognitive: 15,
});
```

Metrics keep `execution_unit`, `self` and `top_level` separate; tests have their own measurement
scope. Shared files count once in `mappedCodeUnion`. Unanalyzable sources remain missing evidence.
An optional `ProductTestEvidenceV1` report must bind the complete current inventory before and
after actual test execution; this service runs no tests.

`semanticConformance` remains `not_independently_proven`, and `ownershipAuthority` remains
`manifest_declarations`. Proposed reviews and declared work roles receive no automatic
confirmation. Without a manifest, the result is `needs_manifest` with an empty draft.
[Manifests, test evidence and limits](../../docs/FEATURE_ALIGNMENT.md) describe the complete v1
contract; the larger automatic `reduce-complexity` loop remains unbuilt.

<a id="entscheidungen"></a>

## Decisions

**1. Incrementality belongs in discovery, not the provider.** A file is unchanged when its
content hash matches the stored manifest (spec.md §12.1: mtime is a hint, the hash is the truth).
Unchanged files are not planned and therefore never reparsed, rechunked, re-embedded or stored.
The content-addressed embedding cache (spec.md §9.4) also belongs in the embedding stage rather
than the provider, applying equally to every provider. Moved/copied code is therefore not
re-embedded even when its file is new.

**2. The complete graph is built even during incremental runs.** A graph containing only changed
files would be incorrect, not updated: edges to unchanged files would be missing, silently
corrupting cycles, dependents and resolution rates. The graph stage therefore reads and parses
unchanged files, but does not chunk, measure, embed or store them; the expensive work stays
skipped. The cheaper alternative—loading a predecessor graph and applying `applyChanges`—requires
a `FileDependencyGraph` restored from a snapshot; `@untangle-code/file-graph` currently offers no
such entry point. Until then, the only cheaper variant would have invisible holes.

**3. Embedder failure is failure, not an empty result.** The embedding stage never returns an
empty or partial batch: the runner would treat it as successfully processed and finish with a
"complete" empty index. It throws `EMBEDDING_UNAVAILABLE`; an incorrect vector length is
`EMBEDDING_DIMENSION_MISMATCH`, not a skipped point.

**4. The network-free embedder is independently implemented, not imported.**
`@untangle-code/testkit` is test infrastructure and must not become a production dependency—the
same decision `@untangle-code/storage-qdrant` made for BM25 vectorization. The algorithm is
intentionally bit-identical; `offline-embedder.test.ts` compares both implementations vector by
vector. This test immediately caught an invisible U+001F ending the sign-hash salt, which would
have disappeared from any display and escaped source inspection.

**5. The analysis collector retains data in memory.** Symbols, imports, calls and file content for
each planned file are retained for graphs and manifests. This is the largest individual memory
allocation in a run. It is documented to make it visible: pushing data needed only after storage
through pipeline queues would spend the memory budget (architecture.md §13.2) on the wrong data.

<a id="grenzen"></a>

## Limits

- **One repository per run.** `IndexTargetV1` describes exactly one repository and ref. A
  workspace with multiple repositories requires multiple runs.
- **No context-artifact index run.** The runner reserves `indexing_context`, but this package
  provides no implementation; `IndexJobStages.context` remains empty.
- **The symbol graph resides in one shard** (`graph_meta` / `symbol-graph`). The file graph uses
  `@untangle-code/file-graph`'s fine-grained sharding; there is no symbol-graph equivalent there.

<a id="lizenz"></a>

## License

**AGPL-3.0-only.** This package includes the complete license in [`LICENSE`](./LICENSE), the
license-choice rationale in [`NOTICE`](./NOTICE), and licenses for all third-party production
dependencies in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md). All three ship in the npm
tarball: AGPL-3.0-only §4 and §5 require recipients to receive the license; a README alone is not
a copy of the license.

Local use alone does not trigger an obligation. Copyleft obligations apply to redistribution and
providing a network service (AGPL §13).

Corresponding TypeScript source ships under `src/` in the same tarball; the complete repository
is available at <https://github.com/lboel/untangle>.
