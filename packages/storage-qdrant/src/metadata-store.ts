/**
 * `MetadataStore` adapter over the metadata collection (`{prefix}metadata_v1`,
 * spec.md §10.1; architecture.md §11.5).
 *
 * Every record is one point with a dummy dense vector `[0]` and a payload of
 * the shape `{ point_type, record_id, …promoted filter fields…, record }`.
 * Promoted fields (`repo_id`, `ref_id`, `record_kind`, `saved_at`) let list
 * operations filter INSIDE Qdrant instead of scanning client-side.
 *
 * Side-effect discipline (architecture.md §11.5): reads that only check
 * status NEVER create the collection — a missing collection is `null`/`[]`.
 * Writes provision the collection lazily, exactly once per store instance.
 * "Not found" is `null`, never an infrastructure error (spec.md §25.2).
 */
import type {
  CollectionSpecV1,
  EmbeddingProfile,
  FileManifestV1,
  IndexCheckpointV1,
  MetadataStore,
  PayloadFilter,
  PortCallOptions,
  RefRecord,
  VectorPointV1,
  VectorStore,
  WorkspaceRecord,
} from "@untangle-code/domain";
import { qdrantUnavailableError } from "@untangle-code/observability";

import { abortedRejection } from "./abort.js";
import { metadataCollectionName } from "./collections.js";

/** `point_type` values of the metadata collection (architecture.md §11.5). */
export const METADATA_POINT_TYPES = {
  workspace: "workspace",
  refRecord: "ref_record",
  fileManifest: "file_manifest",
  embeddingProfile: "embedding_profile",
  checkpoint: "checkpoint",
  record: "record",
} as const;

/** Collection schema for metadata points: 1-dim dummy vector, no sparse. */
export function metadataCollectionSpec(name: string): CollectionSpecV1 {
  return {
    name,
    denseDimensions: 1,
    denseDistance: "Dot",
    sparseBm25: false,
    onDiskPayload: true,
  };
}

export interface QdrantMetadataStoreOptions {
  vectorStore: VectorStore;
  /** Collection prefix (architecture.md §11.1); default "untangle_". */
  collectionPrefix?: string;
}

/** Collision-free logical point id for a metadata record. */
function metadataPointKey(pointType: string, components: string[]): string {
  return JSON.stringify(["metadata", pointType, ...components]);
}

const DUMMY_DENSE: number[] = [0];

export class QdrantMetadataStore implements MetadataStore {
  private readonly store: VectorStore;
  private readonly collection: string;
  private provisioned = false;

  public constructor(options: QdrantMetadataStoreOptions) {
    this.store = options.vectorStore;
    this.collection = metadataCollectionName(options.collectionPrefix ?? "untangle_");
  }

  // -- workspace ------------------------------------------------------------

  public async getWorkspace(
    workspaceId: string,
    options?: PortCallOptions,
  ): Promise<WorkspaceRecord | null> {
    return this.readRecord<WorkspaceRecord>(METADATA_POINT_TYPES.workspace, [workspaceId], options);
  }

  public async putWorkspace(record: WorkspaceRecord, options?: PortCallOptions): Promise<void> {
    await this.writePoints(
      [
        this.toPoint(METADATA_POINT_TYPES.workspace, [record.workspaceId], record, {
          record_id: record.workspaceId,
        }),
      ],
      options,
    );
  }

  // -- ref records ----------------------------------------------------------

  public async getRefRecord(refId: string, options?: PortCallOptions): Promise<RefRecord | null> {
    return this.readRecord<RefRecord>(METADATA_POINT_TYPES.refRecord, [refId], options);
  }

  public async putRefRecord(record: RefRecord, options?: PortCallOptions): Promise<void> {
    await this.writePoints(
      [
        this.toPoint(METADATA_POINT_TYPES.refRecord, [record.refId], record, {
          record_id: record.refId,
          repo_id: record.repoId,
        }),
      ],
      options,
    );
  }

  public async listRefRecords(repoId: string, options?: PortCallOptions): Promise<RefRecord[]> {
    return this.listRecordsByFilter<RefRecord>(
      {
        must: [
          { field: "point_type", match: { eq: METADATA_POINT_TYPES.refRecord } },
          { field: "repo_id", match: { eq: repoId } },
        ],
      },
      options,
    );
  }

  // -- file manifests -------------------------------------------------------

  public async getFileManifest(
    fileId: string,
    options?: PortCallOptions,
  ): Promise<FileManifestV1 | null> {
    return this.readRecord<FileManifestV1>(METADATA_POINT_TYPES.fileManifest, [fileId], options);
  }

  public async listFileManifests(
    refId: string,
    options?: PortCallOptions,
  ): Promise<FileManifestV1[]> {
    return this.listRecordsByFilter<FileManifestV1>(
      {
        must: [
          { field: "point_type", match: { eq: METADATA_POINT_TYPES.fileManifest } },
          { field: "ref_id", match: { eq: refId } },
        ],
      },
      options,
    );
  }

  public async putFileManifests(
    manifests: FileManifestV1[],
    options?: PortCallOptions,
  ): Promise<void> {
    const aborted = abortedRejection<void>(options, "metadata_store_put_file_manifests");
    if (aborted) {
      return aborted;
    }
    if (manifests.length === 0) {
      return;
    }
    await this.writePoints(
      manifests.map((manifest) =>
        this.toPoint(METADATA_POINT_TYPES.fileManifest, [manifest.fileId], manifest, {
          record_id: manifest.fileId,
          repo_id: manifest.repoId,
          ref_id: manifest.refId,
          generation_id: manifest.generationId,
        }),
      ),
      options,
    );
  }

  public async deleteFileManifests(fileIds: string[], options?: PortCallOptions): Promise<void> {
    const aborted = abortedRejection<void>(options, "metadata_store_delete_file_manifests");
    if (aborted) {
      return aborted;
    }
    if (fileIds.length === 0) {
      return;
    }
    await this.store.deleteByFilter(
      this.collection,
      {
        must: [
          { field: "point_type", match: { eq: METADATA_POINT_TYPES.fileManifest } },
          { field: "record_id", match: { in: fileIds } },
        ],
      },
      options,
    );
  }

  // -- embedding profiles ---------------------------------------------------

  public async getEmbeddingProfile(
    profileId: string,
    options?: PortCallOptions,
  ): Promise<EmbeddingProfile | null> {
    return this.readRecord<EmbeddingProfile>(
      METADATA_POINT_TYPES.embeddingProfile,
      [profileId],
      options,
    );
  }

  public async putEmbeddingProfile(
    profileId: string,
    profile: EmbeddingProfile,
    options?: PortCallOptions,
  ): Promise<void> {
    await this.writePoints(
      [
        this.toPoint(METADATA_POINT_TYPES.embeddingProfile, [profileId], profile, {
          record_id: profileId,
        }),
      ],
      options,
    );
  }

  // -- checkpoints ----------------------------------------------------------

  public async getCheckpoint(
    jobId: string,
    options?: PortCallOptions,
  ): Promise<IndexCheckpointV1 | null> {
    return this.readRecord<IndexCheckpointV1>(METADATA_POINT_TYPES.checkpoint, [jobId], options);
  }

  public async putCheckpoint(
    checkpoint: IndexCheckpointV1,
    options?: PortCallOptions,
  ): Promise<void> {
    await this.writePoints(
      [
        this.toPoint(METADATA_POINT_TYPES.checkpoint, [checkpoint.jobId], checkpoint, {
          record_id: checkpoint.jobId,
          repo_id: checkpoint.repoId,
          ref_id: checkpoint.refId,
          generation_id: checkpoint.generationId,
          saved_at: checkpoint.savedAt,
        }),
      ],
      options,
    );
  }

  public async getLatestCheckpoint(
    repoId: string,
    refId: string,
    options?: PortCallOptions,
  ): Promise<IndexCheckpointV1 | null> {
    const checkpoints = await this.listRecordsByFilter<IndexCheckpointV1>(
      {
        must: [
          { field: "point_type", match: { eq: METADATA_POINT_TYPES.checkpoint } },
          { field: "repo_id", match: { eq: repoId } },
          { field: "ref_id", match: { eq: refId } },
        ],
      },
      options,
    );
    let latest: IndexCheckpointV1 | null = null;
    for (const checkpoint of checkpoints) {
      if (
        latest === null ||
        checkpoint.savedAt > latest.savedAt ||
        (checkpoint.savedAt === latest.savedAt && checkpoint.jobId > latest.jobId)
      ) {
        latest = checkpoint;
      }
    }
    return latest;
  }

  // -- generic versioned records (BUILD_PLAN §3 additive evolution) ---------

  public async getRecord(
    kind: string,
    id: string,
    options?: PortCallOptions,
  ): Promise<Record<string, unknown> | null> {
    return this.readRecord<Record<string, unknown>>(
      METADATA_POINT_TYPES.record,
      [kind, id],
      options,
    );
  }

  public async putRecord(
    kind: string,
    id: string,
    record: Record<string, unknown>,
    options?: PortCallOptions,
  ): Promise<void> {
    await this.writePoints(
      [
        this.toPoint(METADATA_POINT_TYPES.record, [kind, id], record, {
          record_id: id,
          record_kind: kind,
        }),
      ],
      options,
    );
  }

  public async listRecords(
    kind: string,
    filter?: Record<string, string>,
    options?: PortCallOptions,
  ): Promise<Record<string, unknown>[]> {
    const records = await this.listRecordsByFilter<Record<string, unknown>>(
      {
        must: [
          { field: "point_type", match: { eq: METADATA_POINT_TYPES.record } },
          { field: "record_kind", match: { eq: kind } },
        ],
      },
      options,
    );
    if (filter === undefined) {
      return records;
    }
    // Generic record kinds have arbitrary field sets, so the equality filter
    // is applied client-side after the kind-scoped server-side scroll
    // (documented decision, README "Entscheidungen").
    const entries = Object.entries(filter);
    return records.filter((record) => entries.every(([key, value]) => record[key] === value));
  }

  public async deleteRecord(kind: string, id: string, options?: PortCallOptions): Promise<void> {
    const aborted = abortedRejection<void>(options, "metadata_store_delete_record");
    if (aborted) {
      return aborted;
    }
    await this.store.deleteByFilter(
      this.collection,
      {
        must: [
          { field: "point_type", match: { eq: METADATA_POINT_TYPES.record } },
          { field: "record_kind", match: { eq: kind } },
          { field: "record_id", match: { eq: id } },
        ],
      },
      options,
    );
  }

  // -- internals ------------------------------------------------------------

  private toPoint(
    pointType: string,
    idComponents: string[],
    record: unknown,
    promotedFields: Record<string, string>,
  ): VectorPointV1 {
    return {
      id: metadataPointKey(pointType, idComponents),
      dense: DUMMY_DENSE,
      payload: {
        point_type: pointType,
        ...promotedFields,
        record: record as Record<string, unknown>,
      },
    };
  }

  private async readRecord<T>(
    pointType: string,
    idComponents: string[],
    options?: PortCallOptions,
  ): Promise<T | null> {
    const aborted = abortedRejection<T | null>(options, "metadata_store_read");
    if (aborted) {
      return aborted;
    }
    const points = await this.store.retrieve(
      this.collection,
      [metadataPointKey(pointType, idComponents)],
      options,
    );
    const payload = points[0]?.payload;
    if (payload === undefined) {
      return null;
    }
    return (payload["record"] as T | undefined) ?? null;
  }

  private async listRecordsByFilter<T>(
    filter: PayloadFilter,
    options?: PortCallOptions,
  ): Promise<T[]> {
    const aborted = abortedRejection<T[]>(options, "metadata_store_list");
    if (aborted) {
      return aborted;
    }
    const records: T[] = [];
    let offset: string | undefined;
    for (;;) {
      const page = await this.store.scroll(
        this.collection,
        { filter, limit: 256, ...(offset === undefined ? {} : { offset }) },
        options,
      );
      for (const point of page.points) {
        const record = point.payload["record"] as T | undefined;
        if (record !== undefined) {
          records.push(record);
        }
      }
      if (page.nextOffset === undefined) {
        return records;
      }
      if (page.nextOffset === offset) {
        throw qdrantUnavailableError(
          `Metadata scroll cursor did not advance (collection "${this.collection}")`,
          { operation: "metadata_store_list", context: { collection: this.collection } },
        );
      }
      offset = page.nextOffset;
    }
  }

  private async writePoints(points: VectorPointV1[], options?: PortCallOptions): Promise<void> {
    const aborted = abortedRejection<void>(options, "metadata_store_write");
    if (aborted) {
      return aborted;
    }
    if (!this.provisioned) {
      // Lazy provisioning on the WRITE path only — status reads must never
      // create the collection (architecture.md §11.5).
      await this.store.ensureCollection(metadataCollectionSpec(this.collection), options);
      this.provisioned = true;
    }
    await this.store.upsert(this.collection, points, options);
  }
}
