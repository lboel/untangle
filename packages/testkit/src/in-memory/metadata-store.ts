/**
 * In-memory `MetadataStore` (architecture.md §11.5). "Not found" is always
 * `null`, never thrown, and read methods never create backing state.
 */
import type {
  EmbeddingProfile,
  FileManifestV1,
  IndexCheckpointV1,
  MetadataStore,
  PortCallOptions,
  RefRecord,
  WorkspaceRecord,
} from "@untangle-code/domain";

import { abortedRejection } from "./abort.js";

export class InMemoryMetadataStore implements MetadataStore {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly refRecords = new Map<string, RefRecord>();
  private readonly fileManifests = new Map<string, FileManifestV1>();
  private readonly embeddingProfiles = new Map<string, EmbeddingProfile>();
  private readonly checkpoints = new Map<string, IndexCheckpointV1>();
  private readonly genericRecords = new Map<string, Map<string, Record<string, unknown>>>();

  public getWorkspace(
    workspaceId: string,
    options?: PortCallOptions,
  ): Promise<WorkspaceRecord | null> {
    return (
      abortedRejection<WorkspaceRecord | null>(options, "metadata_store_get_workspace") ??
      Promise.resolve(this.workspaces.get(workspaceId) ?? null)
    );
  }

  public putWorkspace(record: WorkspaceRecord, options?: PortCallOptions): Promise<void> {
    const aborted = abortedRejection<void>(options, "metadata_store_put_workspace");
    if (aborted) {
      return aborted;
    }
    this.workspaces.set(record.workspaceId, record);
    return Promise.resolve();
  }

  public getRefRecord(refId: string, options?: PortCallOptions): Promise<RefRecord | null> {
    return (
      abortedRejection<RefRecord | null>(options, "metadata_store_get_ref_record") ??
      Promise.resolve(this.refRecords.get(refId) ?? null)
    );
  }

  public putRefRecord(record: RefRecord, options?: PortCallOptions): Promise<void> {
    const aborted = abortedRejection<void>(options, "metadata_store_put_ref_record");
    if (aborted) {
      return aborted;
    }
    this.refRecords.set(record.refId, record);
    return Promise.resolve();
  }

  public listRefRecords(repoId: string, options?: PortCallOptions): Promise<RefRecord[]> {
    return (
      abortedRejection<RefRecord[]>(options, "metadata_store_list_ref_records") ??
      Promise.resolve([...this.refRecords.values()].filter((ref) => ref.repoId === repoId))
    );
  }

  public getFileManifest(
    fileId: string,
    options?: PortCallOptions,
  ): Promise<FileManifestV1 | null> {
    return (
      abortedRejection<FileManifestV1 | null>(options, "metadata_store_get_file_manifest") ??
      Promise.resolve(this.fileManifests.get(fileId) ?? null)
    );
  }

  public listFileManifests(refId: string, options?: PortCallOptions): Promise<FileManifestV1[]> {
    const aborted = abortedRejection<FileManifestV1[]>(
      options,
      "metadata_store_list_file_manifests",
    );
    if (aborted) {
      return aborted;
    }
    return Promise.resolve(
      [...this.fileManifests.values()].filter((manifest) => manifest.refId === refId),
    );
  }

  public putFileManifests(manifests: FileManifestV1[], options?: PortCallOptions): Promise<void> {
    const aborted = abortedRejection<void>(options, "metadata_store_put_file_manifests");
    if (aborted) {
      return aborted;
    }
    for (const manifest of manifests) {
      this.fileManifests.set(manifest.fileId, manifest);
    }
    return Promise.resolve();
  }

  public deleteFileManifests(fileIds: string[], options?: PortCallOptions): Promise<void> {
    const aborted = abortedRejection<void>(options, "metadata_store_delete_file_manifests");
    if (aborted) {
      return aborted;
    }
    for (const fileId of fileIds) {
      this.fileManifests.delete(fileId);
    }
    return Promise.resolve();
  }

  public getEmbeddingProfile(
    profileId: string,
    options?: PortCallOptions,
  ): Promise<EmbeddingProfile | null> {
    return (
      abortedRejection<EmbeddingProfile | null>(options, "metadata_store_get_embedding_profile") ??
      Promise.resolve(this.embeddingProfiles.get(profileId) ?? null)
    );
  }

  public putEmbeddingProfile(
    profileId: string,
    profile: EmbeddingProfile,
    options?: PortCallOptions,
  ): Promise<void> {
    const aborted = abortedRejection<void>(options, "metadata_store_put_embedding_profile");
    if (aborted) {
      return aborted;
    }
    this.embeddingProfiles.set(profileId, profile);
    return Promise.resolve();
  }

  public getCheckpoint(
    jobId: string,
    options?: PortCallOptions,
  ): Promise<IndexCheckpointV1 | null> {
    return (
      abortedRejection<IndexCheckpointV1 | null>(options, "metadata_store_get_checkpoint") ??
      Promise.resolve(this.checkpoints.get(jobId) ?? null)
    );
  }

  public putCheckpoint(checkpoint: IndexCheckpointV1, options?: PortCallOptions): Promise<void> {
    const aborted = abortedRejection<void>(options, "metadata_store_put_checkpoint");
    if (aborted) {
      return aborted;
    }
    this.checkpoints.set(checkpoint.jobId, checkpoint);
    return Promise.resolve();
  }

  public getLatestCheckpoint(
    repoId: string,
    refId: string,
    options?: PortCallOptions,
  ): Promise<IndexCheckpointV1 | null> {
    const aborted = abortedRejection<IndexCheckpointV1 | null>(
      options,
      "metadata_store_get_latest_checkpoint",
    );
    if (aborted) {
      return aborted;
    }
    let latest: IndexCheckpointV1 | null = null;
    for (const checkpoint of this.checkpoints.values()) {
      if (checkpoint.repoId !== repoId || checkpoint.refId !== refId) {
        continue;
      }
      if (!latest || Date.parse(checkpoint.savedAt) > Date.parse(latest.savedAt)) {
        latest = checkpoint;
      }
    }
    return Promise.resolve(latest);
  }

  public getRecord(
    kind: string,
    id: string,
    options?: PortCallOptions,
  ): Promise<Record<string, unknown> | null> {
    return (
      abortedRejection<Record<string, unknown> | null>(options, "metadata_store_get_record") ??
      Promise.resolve(this.genericRecords.get(kind)?.get(id) ?? null)
    );
  }

  public putRecord(
    kind: string,
    id: string,
    record: Record<string, unknown>,
    options?: PortCallOptions,
  ): Promise<void> {
    const aborted = abortedRejection<void>(options, "metadata_store_put_record");
    if (aborted) {
      return aborted;
    }
    let byId = this.genericRecords.get(kind);
    if (!byId) {
      byId = new Map();
      this.genericRecords.set(kind, byId);
    }
    byId.set(id, record);
    return Promise.resolve();
  }

  public listRecords(
    kind: string,
    filter?: Record<string, string>,
    options?: PortCallOptions,
  ): Promise<Record<string, unknown>[]> {
    const aborted = abortedRejection<Record<string, unknown>[]>(
      options,
      "metadata_store_list_records",
    );
    if (aborted) {
      return aborted;
    }
    const byId = this.genericRecords.get(kind);
    if (!byId) {
      return Promise.resolve([]);
    }
    const records = [...byId.values()];
    if (!filter) {
      return Promise.resolve(records);
    }
    const entries = Object.entries(filter);
    return Promise.resolve(
      records.filter((record) =>
        entries.every(([key, value]) => String(record[key] ?? "") === value),
      ),
    );
  }

  public deleteRecord(kind: string, id: string, options?: PortCallOptions): Promise<void> {
    const aborted = abortedRejection<void>(options, "metadata_store_delete_record");
    if (aborted) {
      return aborted;
    }
    this.genericRecords.get(kind)?.delete(id);
    return Promise.resolve();
  }
}
