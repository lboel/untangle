/**
 * Der Trockenlauf: entdecken und vergleichen, aber nichts anfassen.
 *
 * Er beantwortet genau die Frage, die vor einem echten Lauf zaehlt: WAS wuerde
 * passieren — wie viele Dateien sind neu oder geaendert, wie viele
 * unveraendert, wie viele fallen aus welchem Grund weg, und was ist
 * verschwunden. Er schreibt nichts, weder in den Vektorspeicher noch in die
 * Metadaten, und er braucht keinen Einbetter.
 *
 * ER LUEGT AUCH NICHT UEBER SEINE EIGENEN GRENZEN: Sind die Manifeste der
 * Vorgeneration nicht lesbar (Speicher aus, noch nie indiziert), steht das als
 * `previousUnavailable` im Ergebnis und ALLE Dateien gelten als geplant — nie
 * eine stille „alles unveraendert"-Meldung, die genau falsch herum irrte.
 */
import type {
  PortCallOptions,
  SkipLedgerEntryV1,
  SkipReason,
  SkipStage,
} from "@untangle-code/domain";
import type { PlannedFileV1 } from "@untangle-code/jobs";

import { SkipCollector } from "./ledger.js";
import { createDiscoveryStage, createDiscoveryState } from "./stages/discovery.js";
import type { IndexPortsV1, IndexTargetV1, IndexTuningV1 } from "./types.js";

export interface PlanIndexOptions {
  ports: Pick<IndexPortsV1, "fs" | "metadataStore">;
  target: IndexTargetV1;
  tuning?: IndexTuningV1 | undefined;
  incremental?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface IndexPlanV1 {
  schemaVersion: 1;
  planned: PlannedFileV1[];
  filesSeen: number;
  filesUnchanged: number;
  filesIgnored: number;
  removedFileIds: string[];
  /** Gesetzt, wenn die Vorgeneration nicht gelesen werden konnte — mit Grund. */
  previousUnavailable?: string | undefined;
  skipped: SkipLedgerEntryV1[];
  skippedByReason: Partial<Record<SkipReason, number>>;
  skippedByStage: Partial<Record<SkipStage, number>>;
  skippedTruncated: number;
}

export async function planIndex(options: PlanIndexOptions): Promise<IndexPlanV1> {
  const ledger = new SkipCollector();
  const state = createDiscoveryState();

  let previousUnavailable: string | undefined;
  let incremental = options.incremental ?? true;
  if (incremental) {
    try {
      await options.ports.metadataStore.listFileManifests(options.target.refId);
    } catch (error) {
      previousUnavailable = error instanceof Error ? error.message : String(error);
      incremental = false;
    }
  }

  const stage = createDiscoveryStage({
    fs: options.ports.fs,
    metadataStore: options.ports.metadataStore,
    target: options.target,
    tuning: options.tuning ?? {},
    ledger,
    state,
    incremental,
  });

  const callOptions: PortCallOptions | undefined =
    options.signal === undefined ? undefined : { signal: options.signal };
  const result = await stage.discover(callOptions);

  return {
    schemaVersion: 1,
    planned: result.planned,
    filesSeen: result.totalFiles,
    filesUnchanged: result.unchangedFiles,
    filesIgnored: result.ignoredFiles,
    removedFileIds: state.removedFileIds,
    ...(previousUnavailable === undefined ? {} : { previousUnavailable }),
    skipped: ledger.list(),
    skippedByReason: ledger.counts,
    skippedByStage: ledger.countsByStage,
    skippedTruncated: ledger.truncated,
  };
}
