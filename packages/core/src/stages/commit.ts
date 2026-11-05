/**
 * Stufe 11 des Indexlaufs (spec.md §11.1 `finalizing`, architecture.md §13.4).
 *
 * Erst hier wird die Generation SICHTBAR: Manifeste, Ref-Datensatz und
 * Workspace-Datensatz werden geschrieben, und erst danach meldet der Laeufer
 * `completed`. Vorher liegt zwar alles im Speicher, aber kein Leser haelt es
 * fuer den aktuellen Stand.
 *
 * LOESCHUNGEN GEHOEREN HIERHER. Eine Datei, die es nicht mehr gibt, verliert
 * hier ihre Punkte UND ihr Manifest — in dieser Reihenfolge, damit im
 * Zwischenzustand hoechstens ein Manifest ohne Punkte steht (auffindbar als
 * Fehlbestand) und nie Punkte ohne Manifest (unauffindbarer Muell).
 * Auch verwaiste Codepunkte aelterer oder fehlender Generationen werden vor
 * der Completed-Publikation entfernt. Diese Bereinigung bleibt auf genau
 * Workspace, Repository und Ref begrenzt und erhaelt die aktuelle Generation.
 *
 * WAS DIESE STUFE NICHT TUT: Sie prueft die Vollstaendigkeit nicht selbst. Das
 * tut der Laeufer mit `assertGenerationComplete` (domain `invariants.ts`),
 * bevor er ueberhaupt `completed` sagt. Zwei Pruefungen an zwei Orten waeren
 * zwei Gelegenheiten, sie auseinanderlaufen zu lassen.
 */
import {
  CHUNKER_VERSION,
  compareCodepoints,
  PARSER_VERSION,
  type EmbeddingProfile,
  type FileManifestV1,
  type MetadataStore,
  type PortCallOptions,
  type Clock,
} from "@untangle-code/domain";
import type {
  GenerationCommitInputV1,
  GenerationCommitResultV1,
  GenerationCommitStage,
} from "@untangle-code/jobs";

import type { AnalysisCollector } from "../collected.js";
import type { IndexTargetV1 } from "../types.js";

import type { DiscoveryStateV1 } from "./discovery.js";

/**
 * Die Versionskennungen, die auf jedem Manifest stehen. Sie kommen aus
 * `@untangle-code/domain` und nicht aus einem Chunk-Entwurf, damit ein Lauf
 * ohne einen einzigen Chunk (leere Datei) dieselbe Provenienz traegt wie jeder
 * andere.
 */
const PARSER_VERSION_OF_RUN: string = PARSER_VERSION;
const CHUNKER_VERSION_OF_RUN: string = CHUNKER_VERSION;

export interface CommitStageDeps {
  metadataStore: MetadataStore;
  clock: Clock;
  target: IndexTargetV1;
  collector: AnalysisCollector;
  discovery: DiscoveryStateV1;
  profile: EmbeddingProfile;
  embeddingProfileId: string;
  configHash: string;
  /** Loescht die Punkte entfernter Dateien; getrennt, damit die Stufe testbar bleibt. */
  deletePointsOfFiles: (fileIds: readonly string[], options?: PortCallOptions) => Promise<void>;
  /** Removes obsolete points, including legacy orphans absent from the file manifests. */
  pruneObsoleteGeneration: (generationId: string, options?: PortCallOptions) => Promise<void>;
  counts: { removed: number };
}

export function createCommitStage(deps: CommitStageDeps): GenerationCommitStage {
  return {
    async commit(
      input: GenerationCommitInputV1,
      options?: PortCallOptions,
    ): Promise<GenerationCommitResultV1> {
      const confirmed = new Set(input.confirmedFileIds);

      const manifests: FileManifestV1[] = [];
      for (const file of deps.collector.all()) {
        if (!confirmed.has(file.fileId)) continue;
        manifests.push({
          fileId: file.fileId,
          repoId: file.repoId,
          refId: file.refId,
          relativePath: file.filePath,
          contentHash: file.contentHash,
          sizeBytes: file.sizeBytes,
          language: file.languageId,
          parseQuality: file.parseQuality,
          chunkIds: [...file.chunkIds].sort(compareCodepoints),
          symbolIds: [...file.symbolIds].sort(compareCodepoints),
          metricsScopeId: file.metricsScopeId,
          parserVersion: PARSER_VERSION_OF_RUN,
          chunkerVersion: CHUNKER_VERSION_OF_RUN,
          generationId: input.generationId,
        });
      }
      manifests.sort((a, b) => compareCodepoints(a.fileId, b.fileId));
      if (manifests.length > 0) {
        await deps.metadataStore.putFileManifests(manifests, options);
      }

      const removed = deps.discovery.removedFileIds;
      if (removed.length > 0) {
        await deps.deletePointsOfFiles(removed, options);
        await deps.metadataStore.deleteFileManifests(removed, options);
        deps.counts.removed += removed.length;
      }

      // The runner has confirmed every file and graph before entering commit.
      // Keep its renewable job lease and cancellation signal active while pruning;
      // failed cleanup must never publish a completed ref or local index state.
      await deps.pruneObsoleteGeneration(input.generationId, options);

      await deps.metadataStore.putEmbeddingProfile(deps.embeddingProfileId, deps.profile, options);

      const now = deps.clock.nowIso();
      const existing = await deps.metadataStore.getWorkspace(deps.target.workspaceId, options);
      await deps.metadataStore.putWorkspace(
        {
          schemaVersion: 1,
          workspaceId: deps.target.workspaceId,
          configHash: deps.configHash,
          repositories: [
            {
              repoId: deps.target.repoId,
              label: deps.target.repoLabel,
              canonicalPath: deps.target.rootPath,
              remoteUrls: [],
            },
          ],
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        },
        options,
      );

      await deps.metadataStore.putRefRecord(
        {
          refId: deps.target.refId,
          repoId: deps.target.repoId,
          refName: deps.target.refName,
          ...(deps.target.commitSha === undefined ? {} : { commitSha: deps.target.commitSha }),
          generationId: input.generationId,
          indexStatus: "completed",
        },
        options,
      );

      return { metadataStatus: "completed" };
    },
  };
}
