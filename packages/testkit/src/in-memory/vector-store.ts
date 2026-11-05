/**
 * In-memory `VectorStore` (architecture.md §6.9, §11; spec.md §10). Backs the
 * port-contract suite in `contracts/vector-store.contract.ts` and stands in
 * for Qdrant in every unit test that needs dense + sparse hybrid search.
 *
 * Decisions (see README "Entscheidungen"):
 * - a missing collection is a read-safe empty result for `hybridQuery`,
 *   `retrieve`, `scroll` and `countByFilter` (never auto-created — see
 *   architecture.md §11.5), but `upsert`/`ensurePayloadIndexes` require an
 *   explicit prior `ensureCollection` and throw `QDRANT_UNAVAILABLE`
 *   otherwise (domain has no dedicated "collection not provisioned" code);
 * - sparse scoring is Okapi BM25 over hashed token sets (`bm25.ts`), matching
 *   the "idf" modifier semantics of spec.md §10.2;
 * - `hybridQuery` fuses dense + sparse via Reciprocal Rank Fusion (`rrf.ts`)
 *   when both branches are present, per spec.md §13.4 ("only RRF, only
 *   within one collection").
 */
import { UntangleError } from "@untangle-code/domain";
import type {
  CollectionSpecV1,
  HybridQueryV1,
  PayloadFilter,
  PayloadIndexSpecV1,
  PortCallOptions,
  ScoredPointV1,
  ScrollPageV1,
  ScrollRequestV1,
  VectorPointV1,
  VectorStore,
} from "@untangle-code/domain";

import { Bm25Index } from "../bm25.js";
import { cosineSimilarity } from "../math.js";
import { matchesPayloadFilter } from "../payload-filter.js";
import { reciprocalRankFusion } from "../rrf.js";

import { abortedRejection } from "./abort.js";

interface StoredCollection {
  spec: CollectionSpecV1;
  points: Map<string, VectorPointV1>;
  indexes: PayloadIndexSpecV1[];
  bm25: Bm25Index;
}

interface RankedHit {
  id: string;
  score: number;
}

/**
 * First index in `sortedById` (ascending by `id`) whose point sorts strictly
 * after `offset` — via binary search, so it works whether or not a point
 * with exactly this id still exists.
 *
 * This is deliberately NOT `indexOf(offset) + 1` (falling back to `0` via
 * `-1 + 1` when the id is gone): a scroll cursor naming a point that was
 * legitimately deleted since the previous page (or, worse, a stale/foreign
 * cursor) would then silently restart the scroll from the very beginning,
 * replaying already-consumed points to the caller — the kind of silent
 * wrong behavior this project explicitly rejects (BUILD_PLAN §12 E4: no
 * silent skipping/redoing without it being visible). Ordering by "strictly
 * after" instead means a deleted last-seen id still resumes correctly at
 * the next surviving point, and a cursor that sorts at or past the end
 * correctly yields an empty, exhausted page instead of restarting.
 */
function resumeIndexAfter(sortedById: readonly VectorPointV1[], offset: string): number {
  let low = 0;
  let high = sortedById.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const candidateId = sortedById[mid]?.id ?? "";
    if (candidateId <= offset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

export class InMemoryVectorStore implements VectorStore {
  private readonly collections = new Map<string, StoredCollection>();

  private requireCollection(name: string): StoredCollection {
    const collection = this.collections.get(name);
    if (!collection) {
      throw new UntangleError("QDRANT_UNAVAILABLE", `Collection "${name}" is not provisioned`, {
        operation: "vector_store_write",
        context: { collection: name },
      });
    }
    return collection;
  }

  public collectionExists(name: string, options?: PortCallOptions): Promise<boolean> {
    return (
      abortedRejection<boolean>(options, "vector_store_collection_exists") ??
      Promise.resolve(this.collections.has(name))
    );
  }

  public ensureCollection(spec: CollectionSpecV1, options?: PortCallOptions): Promise<void> {
    const aborted = abortedRejection<void>(options, "vector_store_ensure_collection");
    if (aborted) {
      return aborted;
    }
    const existing = this.collections.get(spec.name);
    if (existing) {
      existing.spec = spec;
      return Promise.resolve();
    }
    this.collections.set(spec.name, {
      spec,
      points: new Map(),
      indexes: [],
      bm25: new Bm25Index(),
    });
    return Promise.resolve();
  }

  // `async` (rather than a plain function returning `Promise.resolve(...)`) is
  // deliberate here: `requireCollection` can throw, and every `VectorStore`
  // method is documented to reject its returned Promise on failure, never to
  // throw synchronously — a plain function would throw before a Promise even
  // exists, breaking callers that attach `.catch()`/`await ... catch` uniformly
  // across every port call.
  public async ensurePayloadIndexes(
    collection: string,
    indexes: PayloadIndexSpecV1[],
    options?: PortCallOptions,
  ): Promise<void> {
    const aborted = abortedRejection<void>(options, "vector_store_ensure_payload_indexes");
    if (aborted) {
      return aborted;
    }
    const stored = this.requireCollection(collection);
    for (const index of indexes) {
      const position = stored.indexes.findIndex((existing) => existing.field === index.field);
      if (position === -1) {
        stored.indexes.push(index);
      } else {
        stored.indexes[position] = index;
      }
    }
  }

  public async upsert(
    collection: string,
    points: VectorPointV1[],
    options?: PortCallOptions,
  ): Promise<{ upsertedCount: number }> {
    const aborted = abortedRejection<{ upsertedCount: number }>(options, "vector_store_upsert");
    if (aborted) {
      return aborted;
    }
    const stored = this.requireCollection(collection);
    for (const point of points) {
      const previous = stored.points.get(point.id);
      if (previous?.sparse) {
        stored.bm25.removeDocument(point.id, previous.sparse);
      }
      stored.points.set(point.id, point);
      if (point.sparse) {
        stored.bm25.addDocument(point.id, point.sparse);
      }
    }
    return { upsertedCount: points.length };
  }

  public deleteByFilter(
    collection: string,
    filter: PayloadFilter,
    options?: PortCallOptions,
  ): Promise<void> {
    const aborted = abortedRejection<void>(options, "vector_store_delete_by_filter");
    if (aborted) {
      return aborted;
    }
    const stored = this.collections.get(collection);
    if (!stored) {
      return Promise.resolve();
    }
    for (const [id, point] of [...stored.points.entries()]) {
      if (matchesPayloadFilter(point.payload, filter)) {
        if (point.sparse) {
          stored.bm25.removeDocument(id, point.sparse);
        }
        stored.points.delete(id);
      }
    }
    return Promise.resolve();
  }

  public hybridQuery(
    collection: string,
    query: HybridQueryV1,
    options?: PortCallOptions,
  ): Promise<ScoredPointV1[]> {
    const aborted = abortedRejection<ScoredPointV1[]>(options, "vector_store_hybrid_query");
    if (aborted) {
      return aborted;
    }
    const stored = this.collections.get(collection);
    if (!stored) {
      return Promise.resolve([]);
    }
    let candidates = [...stored.points.values()];
    if (query.filter) {
      candidates = candidates.filter((point) => matchesPayloadFilter(point.payload, query.filter));
    }
    const candidateLimit = query.candidateLimit ?? candidates.length;

    const denseRanked: RankedHit[] | null = query.dense
      ? this.rankByDense(candidates, query.dense).slice(0, candidateLimit)
      : null;
    const sparseRanked: RankedHit[] | null = query.sparse
      ? this.rankBySparse(candidates, query.sparse, stored.bm25).slice(0, candidateLimit)
      : null;

    const denseScoreById = new Map((denseRanked ?? []).map((hit) => [hit.id, hit.score]));
    const sparseRankById = new Map((sparseRanked ?? []).map((hit, rank) => [hit.id, rank]));

    let fusedIds: { id: string; score: number }[];
    if (denseRanked && sparseRanked) {
      const fused = reciprocalRankFusion([
        denseRanked.map((hit) => hit.id),
        sparseRanked.map((hit) => hit.id),
      ]);
      fusedIds = [...fused.entries()]
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score);
    } else if (denseRanked) {
      fusedIds = denseRanked;
    } else if (sparseRanked) {
      fusedIds = sparseRanked;
    } else {
      fusedIds = [];
    }

    const limited = fusedIds.slice(0, query.limit);
    const results: ScoredPointV1[] = limited.map(({ id, score }) => {
      const point = stored.points.get(id);
      const denseScore = denseScoreById.get(id);
      const sparseRank = sparseRankById.get(id);
      const result: ScoredPointV1 = {
        id,
        score,
        ...(denseScore !== undefined ? { denseScore } : {}),
        ...(sparseRank !== undefined ? { sparseRank } : {}),
      };
      if (query.withPayload && point) {
        result.payload = point.payload;
      }
      return result;
    });
    return Promise.resolve(results);
  }

  private rankByDense(candidates: VectorPointV1[], queryDense: number[]): RankedHit[] {
    return candidates
      .filter((point): point is VectorPointV1 & { dense: number[] } => point.dense !== undefined)
      .map((point) => ({ id: point.id, score: cosineSimilarity(queryDense, point.dense) }))
      .sort((a, b) => b.score - a.score);
  }

  private rankBySparse(
    candidates: VectorPointV1[],
    querySparse: NonNullable<VectorPointV1["sparse"]>,
    bm25: Bm25Index,
  ): RankedHit[] {
    return candidates
      .filter(
        (point): point is VectorPointV1 & { sparse: NonNullable<VectorPointV1["sparse"]> } =>
          point.sparse !== undefined,
      )
      .map((point) => ({ id: point.id, score: bm25.score(querySparse, point.sparse) }))
      .sort((a, b) => b.score - a.score);
  }

  public retrieve(
    collection: string,
    ids: string[],
    options?: PortCallOptions & { withVectors?: boolean },
  ): Promise<VectorPointV1[]> {
    const aborted = abortedRejection<VectorPointV1[]>(options, "vector_store_retrieve");
    if (aborted) {
      return aborted;
    }
    const stored = this.collections.get(collection);
    if (!stored) {
      return Promise.resolve([]);
    }
    const withVectors = options?.withVectors ?? false;
    const results: VectorPointV1[] = [];
    for (const id of ids) {
      const point = stored.points.get(id);
      if (!point) {
        continue;
      }
      results.push(withVectors ? point : { id: point.id, payload: point.payload });
    }
    return Promise.resolve(results);
  }

  // `async` (see the comment on `ensurePayloadIndexes`): the degenerate
  // `limit === 0` case below throws, and every `VectorStore` method must
  // reject its Promise, never throw synchronously.
  public async scroll(
    collection: string,
    request: ScrollRequestV1,
    options?: PortCallOptions,
  ): Promise<ScrollPageV1> {
    const aborted = abortedRejection<ScrollPageV1>(options, "vector_store_scroll");
    if (aborted) {
      return aborted;
    }
    const stored = this.collections.get(collection);
    if (!stored) {
      return { points: [] };
    }
    let candidates = [...stored.points.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    if (request.filter) {
      candidates = candidates.filter((point) =>
        matchesPayloadFilter(point.payload, request.filter),
      );
    }
    const startIndex = request.offset ? resumeIndexAfter(candidates, request.offset) : 0;
    if (request.limit === 0 && request.offset === undefined && startIndex < candidates.length) {
      // Decision (documented, see README "Entscheidungen"): `limit: 0` asks
      // for "no points, just tell me whether this cursor is exhausted" —
      // meaningful only relative to a cursor the caller already holds.
      // Without a prior `offset` there is nothing to hand back unchanged in
      // `nextOffset` (the type's own contract says it is absent exactly
      // when exhausted, spec.md's opaque-cursor convention), and returning
      // an empty page with no `nextOffset` here would be exactly the
      // silent "looks exhausted but is not" bug being fixed for the other
      // branch below. Rather than lie either way, this combination throws.
      throw new Error(
        'InMemoryVectorStore.scroll(): "limit: 0" without an "offset" cannot express ' +
          '"more data available" through an opaque nextOffset cursor — request at least one ' +
          "point on the first page, or pass limit: 0 only together with an offset you already hold.",
      );
    }
    const page = candidates.slice(startIndex, startIndex + request.limit);
    const withVectors = request.withVectors ?? false;
    const points = page.map((point) =>
      withVectors ? point : { id: point.id, payload: point.payload },
    );
    // Compare against `page.length`, not the requested `request.limit`: with
    // `limit: 0`, `page` is always empty, so comparing against `limit`
    // itself (`startIndex + 0 < candidates.length`, i.e. really just
    // `startIndex < candidates.length`) used to look right by accident for
    // that one case but the ORIGINAL bug used `request.limit` in a context
    // that silently under-counted whenever fewer than `limit` points
    // remained. Using the actual returned count is correct for every limit,
    // including 0.
    const hasMore = startIndex + page.length < candidates.length;
    const lastPoint = page[page.length - 1];
    // When something was actually returned, resume after the last returned
    // point as usual. When nothing was returned but more data still exists
    // (only possible with `limit: 0`), the cursor has not moved — hand the
    // caller's own `offset` straight back rather than silently claiming
    // exhaustion.
    const nextOffset = hasMore ? (lastPoint ? lastPoint.id : request.offset) : undefined;
    return {
      points,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
    };
  }

  public countByFilter(
    collection: string,
    filter: PayloadFilter,
    options?: PortCallOptions,
  ): Promise<number> {
    const aborted = abortedRejection<number>(options, "vector_store_count_by_filter");
    if (aborted) {
      return aborted;
    }
    const stored = this.collections.get(collection);
    if (!stored) {
      return Promise.resolve(0);
    }
    let count = 0;
    for (const point of stored.points.values()) {
      if (matchesPayloadFilter(point.payload, filter)) {
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
}
