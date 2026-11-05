<a id="index-teilung-über-worktrees-branches-und-projekte"></a>

# Sharing indexes across worktrees, branches and projects

**Status:** Draft, **not normative yet**. This requires changing the identity
model (`spec.md` §5.6), with a prototype proving the approach first.
**As of:** 2026-09-04; all figures were measured.

<a id="1-gemessene-ausgangslage"></a>

## 1. Measured baseline

Chunk density in this repository (411 files, 52,851 lines, 1500-token budget):

| | |
|---|---:|
| Chunks per kLOC | **57.8** |
| Lines per chunk | 17.3 |
| Mean chunk content | 647 characters |
| Storage per point | ~5.0 KB (dense f32 1024 = 4 KB + content + payload) |

This gives the following **per ref** (branch or worktree):

| Size | Points | Storage per ref | With 10 refs | Embedding time (93 chunks/s) |
|---|---:|---:|---:|---:|
| 100 kLOC | 5,782 | 0.03 GB | 0.3 GB | ~62 s |
| 1 MLOC | 57,823 | 0.28 GB | 2.8 GB | ~10 min |
| 2.45 MLOC | 141,666 | 0.68 GB | 6.8 GB | ~25 min |
| 40 MLOC | 2.31 million | 11.3 GB | 113 GB | ~6.9 h |

<a id="2-was-heute-schon-richtig-ist--und-was-nicht"></a>

## 2. What already works and what does not

The embedding cache is already content-addressed (`spec.md` §9.4:
`embedding_profile_id + SHA256(prepared_text)`). A second worktree with unchanged
content therefore requires no new embedding. The most expensive stage is already
covered.

Qdrant points remain ref-bound because `file_id` contains the ref (`spec.md`
§5.4), and `chunk_id` derives from it (§5.6). Despite embedding-cache hits, a
second worktree therefore incurs:

- **Full upsert cost:** rewriting all 141,666 points at 2.45 MLOC.
- **Full storage duplication:** 0.68 GB per ref even if only 1% differs.
- **Full parse, chunk and complexity cost:** those stages also lack a
  content-addressed cache at this baseline.

Ten parallel agent worktrees over a 2.45-MLOC repository therefore require
**6.8 GB and 1.4 million points for roughly 1% actual differences**. This is the
scaling problem rather than computation speed.

<a id="3-vorschlag-vektor-einmal-vorkommen-mehrfach"></a>

## 3. Proposal: one vector, multiple occurrences

Use two layers:

```ts
/** Vector identity depends only on content and profile, not ref/repo/workspace. */
interface ChunkVectorPointV1 {
  pointId: string;              // UUIDv5(embedding_profile_id + content_hash(prepared_text))
  vector: { dense: number[]; bm25: SparseVector };
  content: string;
  contentHash: string;
  chunkerVersion: string;
  occurrences: ChunkOccurrenceV1[];   // Payload array
}

/** Where this content occurs; multiple occurrences per vector. */
interface ChunkOccurrenceV1 {
  workspaceId: string; repoId: string; refId: string;
  projectId?: string;                 // A3
  filePath: string; startLine: number; endLine: number;
  symbolId?: string; symbolFqn?: string;
  metricsScopeId: string;
}
```

Expected effects:

| Operation | Baseline | With content addressing |
|---|---|---|
| New worktree, 1% difference | 141,666 points, 0.68 GB | **~1,400 points, ~7 MB** |
| 10 worktrees | 10× storage | **~1.1×** |
| Merge B into main | Full main reindex | Add ref label to existing points; **zero new embeddings** |
| Delete a branch | Delete points | Remove occurrences; delete points only at refcount 0 |
| Same vendored file in two repositories | Embedded twice | **Once** |

The merge case is the requested behavior: move the occurrence instead of
rebuilding it. Only genuinely new content is embedded.

<a id="4-die-ehrlichen-nachteile"></a>

## 4. Tradeoffs

This proposal has costs that must be considered before adoption:

1. **Identity-model break.** `spec.md` §5.6 currently derives `chunk_id` from a
   ref-bound scope. Content addressing is a breaking change requiring a new
   collection version and migration (`_v2`).
2. **Payload hotspots.** A trivial repeated chunk, such as a license header,
   `export {}` or a standard import block, accumulates thousands of files times
   ten refs in one payload. This requires a cap with overflow points or an
   exception for trivial chunks.
3. **Filtering cost.** Ref, project and path filters become nested conditions over
   an object array rather than a flat keyword index. Qdrant supports this, but
   latency must be measured; `spec.md` §26.2 requires P95 below 2 s.
4. **Deduplication and ranking.** `architecture.md` §18.4 deduplicates by
   `repo_id + ref_id + metrics_scope_id`. Shared points require occurrence-level
   deduplication or the same result will appear once per ref.
5. **Complexity stays ref-bound.** Metrics belong to symbols rather than chunk
   content and are not deduplicated. This change affects retrieval points only.

<a id="5-der-billigere-zwischenschritt"></a>

## 5. A cheaper intermediate step

Independent of section 3 and possible without a specification break:

Content-addressed caches for parsing, chunking and complexity, analogous to the
embedding cache. Keys use `content_hash + parser_version`, `+ chunker_version`,
or `+ metrics_version`. A second worktree could skip parsing, chunking and metric
computation for unchanged files, measured as **86.6% + 12.5% of analysis time**.
Upsert and storage cost would remain.

This is the preferred first step: substantial gains without an identity-contract
break or the risk of the larger redesign.

<a id="51-gemessen-nachdem-wp-100-gebaut-war"></a>

### 5.1 Measurements after WP-100 was built

**As of 2026-09-05.** Corpus: 109 TypeScript files, 22,463 lines, 1,159 chunks,
1,196 symbols (`--embedder=offline`, owned Qdrant instance on 16333). Every run
used `--no-incremental --no-resume` so every file passed through analysis and
storage.

| Run | Embedding cache | Analysis cache | Duration |
|---|---|---|---:|
| 1 | cold | cold | 49,088 ms |
| 2 | warm | warm | 11,107 ms |
| 3 (control) | warm | **deleted** | 31,289 ms |
| 4 | warm | warm | 14,882 ms |
| 5 (control) | warm | **deleted** | 23,127 ms |
| 6 | warm | warm | 7,636 ms |

The controls isolate the gain: with a warm embedding cache, missing the analysis
cache costs 31.3 s instead of 14.9 s, or 23.1 s instead of 7.6 s: **2.1–3.0×**
on the part affected by WP-100. Variation comes from vector-store load generated
by other runs during measurement; cache hit rate remains **327/327 (100%)**.

The result is unchanged, not merely faster: all 1,159 stored points, including
chunk ID, content hash, line range, `symbol_fqn`, classic/extended cyclomatic,
cognitive and SLOC, are byte-identical between computed and cached runs.

Cross-check: changing one character in a file (`* 0.2` → `* 0.3`) gives
`Parse 9/10, Chunk 9/10, Metric 9/10`; exactly one entry expires and one point's
`content_hash` changes. Reverting it restores `10/10` without recomputation.

Remaining limit: keys currently include an identity fingerprint (`workspace_id`,
`repo_id`, `ref_id`, `file_id`, path, language), because cached values contain
ref-bound identifiers (`AstRegion.scopeId`, `RawCall.callerScopeId`,
`CodeChunkDraft.chunkId`). A second worktree therefore does not hit yet. Ref-free
identity in section 3 (WP-102/WP-103) is still needed. The measured gain applies
to repeated runs over the same worktree.

<a id="6-empfohlene-reihenfolge"></a>

## 6. Recommended order

1. **WP-100:** content-addressed parse/chunk/complexity caches; no specification break.
2. **WP-101:** measure the actual cost of a second worktree afterwards. That result
   determines whether step 3 is justified or unnecessary.
3. **WP-102:** prototype content addressing, including payload hotspots and latency
   measurements against real Qdrant. Results determine the specification change.
4. **WP-103:** only then change `spec.md` §5.6 and introduce collection `_v2` with
   migration.

Do not reverse this order. Measurements must justify the expensive redesign.

<a id="7-zur-übrigen-frage-reicht-die-leistung-sonst"></a>

## 7. Is other performance sufficient?

| Case | Assessment | Reason |
|---|---|---|
| Watchers across worktrees | **Low concern** | One OS-backed watcher per `repo_id:ref_id`; the 2000-ms debounce dominates computation |
| Multiple agent sessions | **Low concern** | Read-heavy; Qdrant supports concurrent reads. Locks apply only to writes per ref (WP-89) |
| Cross-project search | **Already addressed** | One query embedding per profile, not per repository (`architecture.md` §18.1); the expensive stage does not scale with repository count |
| Incremental single-file update | **Low concern** | One file ≈ 10 ms analysis plus one embedding batch |
| **Many worktrees of one repository** | **The actual problem** | Storage and upsert scale with ref count rather than changed content |
