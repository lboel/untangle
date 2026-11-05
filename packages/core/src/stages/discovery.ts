/**
 * Stufe 3 des Indexlaufs (spec.md §11.1 `discovering_files`): entdecken,
 * Identitaeten bilden, gegen das Manifest der letzten Generation vergleichen.
 *
 * HIER SITZT DIE INKREMENTALITAET, und sie sitzt an genau einer Stelle: eine
 * Datei ist unveraendert, wenn ihr INHALTS-HASH mit dem des gespeicherten
 * Manifests uebereinstimmt (spec.md §12.1 — mtime ist ein Hinweis, der Hash ist
 * die Wahrheit). Unveraenderte Dateien werden NICHT geplant, also nie erneut
 * geparst, gechunkt, eingebettet oder abgelegt.
 *
 * ENTFERNTE DATEIEN: Ein Manifest, zu dem der Scanner keine Datei mehr findet,
 * ist kein Zufall, sondern eine Loeschung. Sie wird hier festgehalten und in
 * der Commit-Stufe vollzogen (Punkte und Manifest weg) — sonst bliebe eine
 * geloeschte Datei fuer immer suchbar.
 */
import {
  buildFileId,
  compareCodepoints,
  normalizeRelativePath,
  UntangleError,
  type FileManifestV1,
  type FileSystemPort,
  type MetadataStore,
  type PortCallOptions,
} from "@untangle-code/domain";
import type { DiscoveryResultV1, DiscoveryStage, PlannedFileV1 } from "@untangle-code/jobs";
import { discoverFiles, type ScanSkipV1, type ScannedFileV1 } from "@untangle-code/scanner";

import type { SkipCollector } from "../ledger.js";
import { scannerSkipReason } from "../skip-reasons.js";
import type { IndexTargetV1, IndexTuningV1 } from "../types.js";

/** Was die Entdeckung ausser dem Plan noch hinterlaesst. */
export interface DiscoveryStateV1 {
  /** file_id → gescannte Datei; die Analysestufe liest hier den Pfad nach. */
  scanned: Map<string, ScannedFileV1>;
  /** Manifeste der Vorgeneration, file_id → Manifest. */
  previous: Map<string, FileManifestV1>;
  /** file_ids, deren Datei es nicht mehr gibt. */
  removedFileIds: string[];
  /** Zahlen fuer den Bericht. */
  counts: { seen: number; planned: number; unchanged: number; ignored: number };
}

export interface DiscoveryStageDeps {
  fs: FileSystemPort;
  metadataStore: MetadataStore;
  target: IndexTargetV1;
  tuning: IndexTuningV1;
  ledger: SkipCollector;
  state: DiscoveryStateV1;
  /** Ohne ihn wird jede Datei geplant — der erste Lauf, oder `--no-incremental`. */
  incremental: boolean;
  /**
   * Darf der Lauf die Manifeste der sichtbaren Generation wiederverwenden?
   *
   * Ein inkrementeller Vergleich ist nur dann generationssicher, wenn der
   * Job dieselbe Generation aus einem passenden Checkpoint fortsetzt. Ein
   * frischer Lauf muss dagegen jede Datei neu schreiben, damit seine spaeter
   * publizierten Graphen nicht neben Chunk-Payloads der Vorgeneration stehen.
   * Der Plan-Trockenlauf braucht diese Laufzeitpruefung nicht und laesst die
   * Funktion deshalb weg.
   */
  previousGenerationToReuse?: ((options?: PortCallOptions) => Promise<string | null>) | undefined;
}

export function createDiscoveryState(): DiscoveryStateV1 {
  return {
    scanned: new Map(),
    previous: new Map(),
    removedFileIds: [],
    counts: { seen: 0, planned: 0, unchanged: 0, ignored: 0 },
  };
}

export function createDiscoveryStage(deps: DiscoveryStageDeps): DiscoveryStage {
  return {
    async discover(options?: PortCallOptions): Promise<DiscoveryResultV1> {
      const { target, state, ledger } = deps;
      const previousGenerationToReuse =
        deps.incremental && deps.previousGenerationToReuse !== undefined
          ? await deps.previousGenerationToReuse(options)
          : undefined;

      // Auch ein frischer Vollauf braucht die Vorgeneration, um Dateien zu
      // erkennen, die inzwischen entfernt wurden. Wiederverwendet werden ihre
      // Punkte aber nur, wenn der passende Checkpoint exakt dieselbe Generation
      // fortsetzt.
      for (const manifest of await deps.metadataStore.listFileManifests(target.refId, options)) {
        state.previous.set(manifest.fileId, manifest);
      }

      const planned: PlannedFileV1[] = [];

      const stream = discoverFiles({
        fs: deps.fs,
        roots: [target.rootPath],
        repoRoot: target.rootPath,
        ...(deps.tuning.maxFileSizeBytes === undefined
          ? {}
          : { maxFileSizeBytes: deps.tuning.maxFileSizeBytes }),
        ...(deps.tuning.scanConcurrency === undefined
          ? {}
          : { concurrency: deps.tuning.scanConcurrency }),
        ignore: {
          ...(deps.tuning.excludePatterns === undefined
            ? {}
            : { configExclude: deps.tuning.excludePatterns }),
          ...(deps.tuning.includePatterns === undefined
            ? {}
            : { configInclude: deps.tuning.includePatterns }),
        },
        onSkip: (skip: ScanSkipV1) => {
          state.counts.ignored++;
          ledger.add({
            stage: "scan",
            subjectKind: "file",
            path: skip.relativePath,
            repoId: target.repoId,
            refId: target.refId,
            reason: scannerSkipReason(skip.reason),
            detail:
              `Excluded by the scanner (${skip.reason})` +
              (skip.detail === undefined ? "." : `: ${skip.detail}`),
            recoverable: skip.reason === "unreadable",
          });
        },
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });

      for await (const file of stream) {
        if (options?.signal?.aborted === true) {
          throw new UntangleError("JOB_CANCELLED", "Discovery was cancelled.", {
            operation: "index.discover",
          });
        }
        state.counts.seen++;
        const relativePath = normalizeRelativePath(file.relativePath);
        const fileId = buildFileId({
          workspaceId: target.workspaceId,
          repoId: target.repoId,
          refId: target.refId,
          relativePath,
        });
        state.scanned.set(fileId, file);

        const previous = state.previous.get(fileId);
        const generationMatches =
          previousGenerationToReuse === undefined ||
          previous?.generationId === previousGenerationToReuse;
        if (
          deps.incremental &&
          previous !== undefined &&
          generationMatches &&
          previous.contentHash === file.contentHash
        ) {
          state.counts.unchanged++;
          continue;
        }
        planned.push({ fileId, filePath: relativePath, contentHash: file.contentHash });
      }

      for (const [fileId, manifest] of state.previous) {
        if (state.scanned.has(fileId)) continue;
        state.removedFileIds.push(fileId);
        ledger.add({
          stage: "scan",
          subjectKind: "file",
          subjectId: fileId,
          path: manifest.relativePath,
          repoId: target.repoId,
          refId: target.refId,
          reason: "missing_index_entry",
          detail:
            "The file appeared in the previous generation's manifest but was not found; " +
            "its points and manifest will be removed.",
          recoverable: false,
        });
      }
      state.removedFileIds.sort(compareCodepoints);

      planned.sort((a, b) => compareCodepoints(a.filePath, b.filePath));
      state.counts.planned = planned.length;

      const corpusManifestHashes = Object.fromEntries(
        [...state.scanned.entries()]
          .sort(([left], [right]) => compareCodepoints(left, right))
          .map(([fileId, file]) => [fileId, file.contentHash]),
      );

      return {
        planned,
        corpusManifestHashes,
        totalFiles: state.counts.seen,
        unchangedFiles: state.counts.unchanged,
        ignoredFiles: state.counts.ignored,
      };
    },
  };
}
