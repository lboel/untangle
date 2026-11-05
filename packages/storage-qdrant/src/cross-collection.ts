/**
 * Cross-collection query rule (spec.md §13.4; architecture.md §11.3):
 *
 * - Cosine scores may only be compared under the SAME, verified embedding
 *   profile;
 * - RRF scores of SEPARATE collections are NEVER sorted directly as
 *   absolute relevance — collections sharing one profile are merged by an
 *   EXPLICIT normalization strategy (rank-based RRF over the per-collection
 *   rank lists);
 * - incompatible profiles produce SEPARATE result groups, and the response
 *   carries an explicit profile-separation notice.
 */
import type {
  HybridQueryV1,
  PortCallOptions,
  ScoredPointV1,
  VectorStore,
} from "@untangle-code/domain";

import { abortedRejection } from "./abort.js";
import { reciprocalRankFusion } from "./rrf.js";

/** Per-collection hybrid query result, tagged with its embedding profile. */
export interface CollectionQueryResultV1 {
  collection: string;
  embeddingProfileId: string;
  results: ScoredPointV1[];
}

/** A scored point with its source collection attached. */
export interface CrossCollectionScoredPointV1 extends ScoredPointV1 {
  collection: string;
}

/** One profile-homogeneous result group. */
export interface ProfileResultGroupV1 {
  embeddingProfileId: string;
  collections: string[];
  /**
   * For a single-collection group: the collection's own (RRF-fused) results.
   * For multiple collections sharing a profile: rank-based RRF fusion over
   * the per-collection rank lists — scores are fusion scores, comparable
   * only WITHIN this group.
   */
  results: CrossCollectionScoredPointV1[];
}

export interface CrossCollectionMergeV1 {
  groups: ProfileResultGroupV1[];
  /** True when more than one embedding profile was involved. */
  profileSeparation: boolean;
  /** Present exactly when `profileSeparation` is true (spec.md §13.4). */
  notice?: string;
}

export const PROFILE_SEPARATION_NOTICE =
  "results are grouped by embedding profile; scores are comparable only within " +
  "one group and must not be merged into a single ranking (spec.md 13.4)";

export interface MergeAcrossCollectionsOptions {
  /** Result limit per group after fusion. */
  limitPerGroup?: number;
  /** RRF smoothing constant for the same-profile merge. */
  rrfK?: number;
}

/**
 * Groups per-collection results by embedding profile and merges only
 * within a group (rank-based, never raw-score-based). Group order follows
 * the first appearance of each profile in `inputs`.
 */
export function mergeAcrossCollections(
  inputs: readonly CollectionQueryResultV1[],
  options: MergeAcrossCollectionsOptions = {},
): CrossCollectionMergeV1 {
  const byProfile = new Map<string, CollectionQueryResultV1[]>();
  for (const input of inputs) {
    const list = byProfile.get(input.embeddingProfileId);
    if (list === undefined) {
      byProfile.set(input.embeddingProfileId, [input]);
    } else {
      list.push(input);
    }
  }

  const groups: ProfileResultGroupV1[] = [];
  for (const [embeddingProfileId, collectionResults] of byProfile) {
    groups.push(mergeProfileGroup(embeddingProfileId, collectionResults, options));
  }
  const profileSeparation = groups.length > 1;
  return {
    groups,
    profileSeparation,
    ...(profileSeparation ? { notice: PROFILE_SEPARATION_NOTICE } : {}),
  };
}

function mergeProfileGroup(
  embeddingProfileId: string,
  collectionResults: CollectionQueryResultV1[],
  options: MergeAcrossCollectionsOptions,
): ProfileResultGroupV1 {
  const collections = collectionResults.map((result) => result.collection);
  if (collectionResults.length === 1) {
    const only = collectionResults[0] as CollectionQueryResultV1;
    const results = only.results.map((point): CrossCollectionScoredPointV1 => ({
      ...point,
      collection: only.collection,
    }));
    return {
      embeddingProfileId,
      collections,
      results: limited(results, options.limitPerGroup),
    };
  }

  // Same profile, several collections: fuse by RANK (explicit normalization
  // strategy) — RRF scores of separate collections are never sorted as
  // absolute relevance (spec.md §13.4). Ids are namespaced per collection so
  // identical ids in different collections stay distinct points.
  const pointByKey = new Map<string, CrossCollectionScoredPointV1>();
  const rankLists: string[][] = collectionResults.map((result) => {
    return result.results.map((point) => {
      const key = JSON.stringify([result.collection, point.id]);
      if (!pointByKey.has(key)) {
        pointByKey.set(key, { ...point, collection: result.collection });
      }
      return key;
    });
  });
  const fused = reciprocalRankFusion(rankLists, {
    ...(options.rrfK === undefined ? {} : { k: options.rrfK }),
  });
  const results = [...fused.entries()]
    .sort((a, b) => (b[1] === a[1] ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1]))
    .map(([key, score]): CrossCollectionScoredPointV1 => {
      const point = pointByKey.get(key) as CrossCollectionScoredPointV1;
      return { ...point, score };
    });
  return { embeddingProfileId, collections, results: limited(results, options.limitPerGroup) };
}

function limited<T>(results: T[], limit: number | undefined): T[] {
  return limit === undefined ? results : results.slice(0, limit);
}

/** One collection to query, tagged with its embedding profile. */
export interface CrossCollectionQueryTargetV1 {
  collection: string;
  embeddingProfileId: string;
  query: HybridQueryV1;
}

/**
 * Runs one hybrid query per target collection (dense + BM25 prefetch and
 * RRF fusion INSIDE each collection, payload filters in Qdrant) and merges
 * per the cross-collection rule above.
 */
export async function hybridQueryAcrossCollections(
  store: VectorStore,
  targets: readonly CrossCollectionQueryTargetV1[],
  options?: PortCallOptions & MergeAcrossCollectionsOptions,
): Promise<CrossCollectionMergeV1> {
  const aborted = abortedRejection<CrossCollectionMergeV1>(
    options,
    "hybrid_query_across_collections",
  );
  if (aborted) {
    return aborted;
  }
  const inputs: CollectionQueryResultV1[] = [];
  for (const target of targets) {
    const results = await store.hybridQuery(target.collection, target.query, options);
    inputs.push({
      collection: target.collection,
      embeddingProfileId: target.embeddingProfileId,
      results,
    });
  }
  return mergeAcrossCollections(inputs, {
    ...(options?.limitPerGroup === undefined ? {} : { limitPerGroup: options.limitPerGroup }),
    ...(options?.rrfK === undefined ? {} : { rrfK: options.rrfK }),
  });
}
