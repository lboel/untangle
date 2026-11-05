/**
 * File-backed `CheckpointStorePort` (architecture.md §6.14, §13.3) on top of
 * the injected `FileSystemPort` — atomic via the temp+rename pattern the
 * port guarantees for `rename`.
 *
 * Error semantics (spec.md §25.2): a MISSING checkpoint is `null` — never an
 * error; a CORRUPT checkpoint file is an `UntangleError` with code
 * `INDEX_INCOMPLETE` — never silently treated as "not found", because that
 * would silently discard confirmed work and restart from scratch.
 */
import type {
  FileSystemPort,
  IndexCheckpointV1,
  PortCallOptions,
  CheckpointStorePort,
} from "@untangle-code/domain";
import { sha256Hex } from "@untangle-code/domain";
import { indexIncompleteError } from "@untangle-code/observability";

import { throwIfAborted } from "./abort.js";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => isStringArray(entry));
}

/** Structural guard for the exact `IndexCheckpointV1` shape (§13.3). */
export function isIndexCheckpointV1(value: unknown): value is IndexCheckpointV1 {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["jobId"] === "string" &&
    typeof record["generationId"] === "string" &&
    typeof record["workspaceId"] === "string" &&
    typeof record["repoId"] === "string" &&
    typeof record["refId"] === "string" &&
    typeof record["effectiveProfileId"] === "string" &&
    isStringArray(record["completedFiles"]) &&
    isStringArrayRecord(record["storedPointIdsByFile"]) &&
    isStringRecord(record["manifestHashes"]) &&
    typeof record["stage"] === "string" &&
    typeof record["savedAt"] === "string"
  );
}

export interface FileCheckpointStoreOptions {
  /** Directory the checkpoint JSON files live in; created on first save. */
  directory: string;
}

export class FileCheckpointStore implements CheckpointStorePort {
  private readonly fs: FileSystemPort;
  private readonly directory: string;
  private tmpCounter = 0;

  public constructor(fs: FileSystemPort, options: FileCheckpointStoreOptions) {
    this.fs = fs;
    this.directory = options.directory.replace(/\/+$/u, "");
  }

  private pathFor(jobId: string): string {
    // jobIds are usually UUIDs, but the file name must stay collision-free
    // and path-safe for ANY id: sanitize, then disambiguate with a hash.
    const safe = jobId.replace(/[^A-Za-z0-9._-]/gu, "_");
    return `${this.directory}/${safe}-${sha256Hex(jobId).slice(0, 8)}.json`;
  }

  public async save(checkpoint: IndexCheckpointV1, options?: PortCallOptions): Promise<void> {
    throwIfAborted(options?.signal, "checkpoint_save");
    if (!isIndexCheckpointV1(checkpoint)) {
      throw indexIncompleteError("refusing to persist a malformed checkpoint", {
        retryable: false,
        operation: "checkpoint_save",
      });
    }
    await this.fs.mkdir(this.directory, { recursive: true, ...(options ?? {}) });
    const path = this.pathFor(checkpoint.jobId);
    this.tmpCounter += 1;
    const tmpPath = `${path}.tmp-${this.tmpCounter}`;
    const bytes = new TextEncoder().encode(`${JSON.stringify(checkpoint, null, 2)}\n`);
    await this.fs.writeFile(tmpPath, bytes, options);
    await this.fs.rename(tmpPath, path, options);
  }

  public async load(jobId: string, options?: PortCallOptions): Promise<IndexCheckpointV1 | null> {
    throwIfAborted(options?.signal, "checkpoint_load");
    const path = this.pathFor(jobId);
    const stat = await this.fs.stat(path, options);
    if (stat === null) {
      return null;
    }
    const text = await this.fs.readTextFile(path, options);
    return this.parseCheckpoint(text, path);
  }

  public async loadLatest(
    repoId: string,
    refId: string,
    options?: PortCallOptions,
  ): Promise<IndexCheckpointV1 | null> {
    throwIfAborted(options?.signal, "checkpoint_load_latest");
    const dirStat = await this.fs.stat(this.directory, options);
    if (dirStat === null) {
      return null;
    }
    const entries = await this.fs.readDir(this.directory, options);
    let latest: IndexCheckpointV1 | null = null;
    for (const entry of entries) {
      if (entry.kind !== "file" || !entry.name.endsWith(".json")) {
        continue;
      }
      const text = await this.fs.readTextFile(entry.path, options);
      const checkpoint = this.parseCheckpoint(text, entry.path);
      if (checkpoint.repoId !== repoId || checkpoint.refId !== refId) {
        continue;
      }
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

  public async delete(jobId: string, options?: PortCallOptions): Promise<void> {
    throwIfAborted(options?.signal, "checkpoint_delete");
    // `FileSystemPort.remove` is force-style: a missing file is not an error,
    // which makes delete idempotent by design.
    await this.fs.remove(this.pathFor(jobId), options);
  }

  private parseCheckpoint(text: string, path: string): IndexCheckpointV1 {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw indexIncompleteError(`checkpoint file is not valid JSON: ${path}`, {
        retryable: false,
        operation: "checkpoint_load",
        context: { path },
        cause,
      });
    }
    if (!isIndexCheckpointV1(parsed)) {
      throw indexIncompleteError(`checkpoint file has an invalid shape: ${path}`, {
        retryable: false,
        operation: "checkpoint_load",
        context: { path },
      });
    }
    return parsed;
  }
}
