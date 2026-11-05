/**
 * Die Ausgabe von `untangle index`.
 *
 * ZWEI REGELN, die den Text tragen:
 * 1. Fortschritt geht nach STDERR, der Bericht nach STDOUT. Nur so bleibt
 *    `untangle index --format=json | jq` benutzbar, waehrend man beim Laufen
 *    trotzdem etwas sieht.
 * 2. Die Zahl „uebersprungen" steht IMMER da — auch wenn sie 0 ist. Eine Zahl,
 *    die nur bei Problemen erscheint, liest sich beim Fehlen wie „alles gut",
 *    und genau das ist der Unterschied zwischen „nichts uebersprungen" und
 *    „nicht nachgesehen".
 */
import type { IndexPlanV1, IndexReportV1 } from "@untangle-code/core";
import { compareCodepoints, type JobEvent } from "@untangle-code/domain";

import { line, note, type Io } from "../../cli/io.js";

/**
 * Der laufende Stand eines Indexlaufs — AUSSCHLIESSLICH fuer die Anzeige.
 *
 * Er zaehlt mit, was die Ereignisse melden, damit eine Fortschrittszeile
 * „12 von 47 Dateien" sagen kann statt nur „Stapel 3". Diese Zahlen sind
 * keine Ergebnisdaten: der Bericht am Ende zaehlt selbst (siehe
 * `IndexCountsV1`), und beide muessen sich decken.
 */
export interface IndexProgressV1 {
  plannedFiles: number;
  embeddedFiles: number;
  storedPoints: number;
}

export function createIndexProgress(): IndexProgressV1 {
  return { plannedFiles: 0, embeddedFiles: 0, storedPoints: 0 };
}

/**
 * Die Kopfzeilen VOR dem ersten Ereignis.
 *
 * WP-227: Der Laeufer meldet eine Stufe erst, wenn sie FERTIG ist. Haengt die
 * erste Stufe — und genau das tut sie, wenn der Einbettungsdienst nicht
 * antwortet —, dann gibt es ohne diese Zeilen ueberhaupt keine Ausgabe. Der
 * Nutzer sieht dann nicht einmal, WORAUF gewartet wird. Deshalb steht hier,
 * was gleich passiert, bevor irgendetwas passiert.
 */
export function renderRunHeader(
  io: Io,
  input: {
    rootPath: string;
    repoId: string;
    refName: string;
    collection: string;
    embedder: string;
    timeoutMs: number;
  },
): void {
  note(io, `[  0%] Target: ${input.rootPath}`);
  note(
    io,
    `       Repository ${input.repoId}, Ref ${input.refName}, collection ${input.collection}.`,
  );
  note(
    io,
    `       Embedder ${input.embedder}, deadline ${String(input.timeoutMs)} ms per call ` +
      "(--timeout). Five stages: check services, discover files, process, " +
      "build graphs, commit.",
  );
}

/** Eine Fortschrittszeile je Ereignis — kurz, und nie auf stdout. */
export function renderEvent(
  io: Io,
  event: JobEvent,
  verbose: boolean,
  progress: IndexProgressV1 = createIndexProgress(),
): void {
  switch (event.kind) {
    case "job_queued":
      note(io, `[  1%] Job ${event.jobId} queued. Stage 1/5: embedding service and collection.`);
      return;
    case "infrastructure_ready":
      note(
        io,
        `[ 10%] Ready: ${Object.entries(event.endpoints)
          .sort(([a], [b]) => compareCodepoints(a, b))
          .map(([key, value]) => `${key}=${value}`)
          .join("  ")}`,
      );
      note(io, "[ 15%] Stage 2/5: discovering files …");
      return;
    case "files_discovered":
      progress.plannedFiles = event.changedFiles;
      note(
        io,
        `[ 20%] Found: ${String(event.totalFiles)} files, including ` +
          `${String(event.changedFiles)} planned, ${String(event.unchangedFiles)} unchanged, ` +
          `${String(event.ignoredFiles)} ignoriert.`,
      );
      note(
        io,
        event.changedFiles === 0
          ? "[ 25%] Stage 3/5: nothing to process; every discovered file is unchanged."
          : `[ 25%] Stage 3/5: ${String(event.changedFiles)} files to parse, embed and store …`,
      );
      return;
    case "file_analyzed":
      if (verbose) {
        note(
          io,
          `       analysiert  ${event.filePath}  (${String(event.chunkCount)} Chunks, ` +
            `${String(event.symbolCount)} symbols, parse=${event.parseQuality})`,
        );
      }
      return;
    case "embedding_batch_completed":
      progress.embeddedFiles += event.batchSize;
      note(
        io,
        `[${percentOfPipeline(progress)}] Batch ${String(event.batchIndex)}: ` +
          `${String(event.batchSize)} files embedded ` +
          `(${String(progress.embeddedFiles)} of ${String(progress.plannedFiles)}), ` +
          `${String(event.cacheHits)} from cache, ` +
          `${String(event.truncatedCount)} gekuerzt.`,
      );
      return;
    case "points_stored":
      progress.storedPoints += event.pointCount;
      note(
        io,
        `[${percentOfPipeline(progress)}] Stored: ${String(event.pointCount)} points in ` +
          `${event.collection} (${String(event.serializedBytes)} Bytes, ` +
          `${String(progress.storedPoints)} total).`,
      );
      return;
    case "checkpoint_saved":
      if (verbose) {
        note(io, `       Checkpoint at ${event.stage}: ${String(event.completedFileCount)} files.`);
      }
      return;
    case "graph_updated":
      note(
        io,
        `[ 85%] Stage 4/5 — graph ${event.graph}: ${String(event.nodeCount)} nodes, ` +
          `${String(event.edgeCount)} edges.`,
      );
      return;
    case "job_completed":
      note(io, `[100%] Finished in ${String(event.durationMs)} ms.`);
      return;
    case "job_failed":
      note(io, `[ !! ] Failed: ${event.errorCode} — ${event.message}`);
      return;
    case "job_cancelled":
      note(io, `[ -- ] Cancelled. Checkpoint saved: ${event.checkpointSaved ? "ja" : "no"}.`);
      return;
    default:
      return;
  }
}

/**
 * Der Anteil der Verarbeitungsstufe am Ganzen: sie liegt zwischen 25 % und
 * 80 %. Ohne bekannte Dateizahl bleibt es bei 50 % — eine erfundene
 * Genauigkeit waere schlimmer als gar keine.
 */
function percentOfPipeline(progress: IndexProgressV1): string {
  if (progress.plannedFiles <= 0) return " 50%";
  const done = Math.min(progress.embeddedFiles, progress.plannedFiles);
  const percent = 25 + Math.floor((55 * done) / progress.plannedFiles);
  return `${String(percent).padStart(3, " ")}%`;
}

/** Der Bericht als Text. */
export function renderReport(io: Io, report: IndexReportV1): void {
  const c = report.counts;
  line(io, `Outcome:          ${report.outcome}`);
  line(io, `Repository:        ${report.repoId}`);
  line(io, `Ref:               ${report.refId}`);
  line(io, `Generation:        ${report.generationId ?? "(none)"}`);
  line(io, `Collection:        ${report.collection}`);
  line(io, `Profile:           ${report.embeddingProfileId}`);
  line(io, "");
  line(io, `Files discovered: ${String(c.filesSeen)}`);
  line(io, `  planned:        ${String(c.filesPlanned)}`);
  line(io, `  unchanged:      ${String(c.filesUnchanged)}   (not recomputed)`);
  line(io, `  ignoriert:       ${String(c.filesIgnored)}`);
  line(io, `Files analyzed:   ${String(c.filesAnalyzed)}`);
  line(io, `Files removed:    ${String(c.filesRemoved)}`);
  line(io, `Chunks:            ${String(c.chunks)}`);
  line(io, `Symbols:          ${String(c.symbols)}`);
  line(io, `Points stored:    ${String(c.points)}`);
  line(
    io,
    `Embeddings:       ${String(c.embeddingsComputed)} computed, ` +
      `${String(c.embeddingCacheHits)} from cache, ` +
      `${String(c.truncated)} gekuerzt`,
  );
  line(io, analysisCacheLine(c));
  line(
    io,
    `File graph:       ${String(c.fileGraphNodes)} nodes, ${String(c.fileGraphEdges)} edges`,
  );
  line(
    io,
    `Symbol graph:     ${String(c.symbolGraphNodes)} nodes, ${String(c.symbolGraphEdges)} edges`,
  );
  line(io, "");
  renderSkips(
    io,
    report.skipped.length,
    report.skippedByReason,
    report.skippedByStage,
    report.skippedTruncated,
  );
  if (report.failure !== undefined) {
    line(io, "");
    line(io, `FAILURE ${report.failure.code}: ${report.failure.message}`);
    line(io, `Retryable: ${report.failure.retryable ? "ja" : "no"}`);
  }
}

/** Der Trockenlauf als Text. */
export function renderPlan(io: Io, plan: IndexPlanV1, showFiles: number): void {
  line(io, `Files discovered: ${String(plan.filesSeen)}`);
  line(io, `  would plan:     ${String(plan.planned.length)}`);
  line(io, `  unchanged:      ${String(plan.filesUnchanged)}`);
  line(io, `  ignoriert:       ${String(plan.filesIgnored)}`);
  line(io, `  entfernt:        ${String(plan.removedFileIds.length)}`);
  if (plan.previousUnavailable !== undefined) {
    line(io, "");
    line(
      io,
      `Note: the previous generation could not be read (${plan.previousUnavailable}). ` +
        "All files are therefore considered planned; this number is an upper bound, " +
        "not a comparison.",
    );
  }
  line(io, "");
  renderSkips(
    io,
    plan.skipped.length,
    plan.skippedByReason,
    plan.skippedByStage,
    plan.skippedTruncated,
  );
  if (showFiles > 0 && plan.planned.length > 0) {
    line(io, "");
    line(io, `Planned work (first ${String(Math.min(showFiles, plan.planned.length))}):`);
    for (const file of plan.planned.slice(0, showFiles)) {
      line(io, `  ${file.filePath}`);
    }
    if (plan.planned.length > showFiles) {
      line(io, `  … and ${String(plan.planned.length - showFiles)} weitere.`);
    }
  }
}

/**
 * Stufen, die von DATEIEN handeln. Alles andere handelt von Kanten und
 * Kandidaten — zwei Dinge, die in einer gemeinsamen Zahl nur verwirren:
 * „9207 uebersprungen" liest sich wie ein kaputter Index, ist aber die
 * normale Meldung des Symbolgraphen ueber Aufrufe nach ausserhalb.
 */
const FILE_STAGES = new Set(["scan", "parse", "chunk", "embed", "store"]);

function renderSkips(
  io: Io,
  listed: number,
  byReason: Readonly<Record<string, number | undefined>>,
  byStage: Readonly<Record<string, number | undefined>>,
  truncated: number,
): void {
  const total = Object.values(byReason).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const fileTotal = Object.entries(byStage)
    .filter(([stage]) => FILE_STAGES.has(stage))
    .reduce<number>((sum, [, value]) => sum + (value ?? 0), 0);

  line(io, `Skipped:          ${String(total)}   (each entry includes a reason)`);
  line(io, `  files:          ${String(fileTotal)}`);
  line(io, `  graph/search:    ${String(total - fileTotal)}`);
  line(io, "");
  line(io, "  by stage:");
  for (const stage of Object.keys(byStage).sort(compareCodepoints)) {
    line(io, `    ${stage.padEnd(26)} ${String(byStage[stage] ?? 0)}`);
  }
  line(io, "  by reason:");
  for (const reason of Object.keys(byReason).sort(compareCodepoints)) {
    line(io, `    ${reason.padEnd(26)} ${String(byReason[reason] ?? 0)}`);
  }
  if (truncated > 0) {
    line(
      io,
      `  (${String(truncated)} entries are counted but omitted from the list ` +
        `listed individually; ${String(listed)} appear in --format=json)`,
    );
  }
}

/**
 * Die Trefferquote der drei inhaltsadressierten Analyse-Caches (WP-100).
 *
 * Sie steht IM BERICHT und nicht nur im Protokoll, weil ein Cache, ueber den
 * niemand etwas erfaehrt, nicht ueberpruefbar ist: erst die Quote zeigt, ob
 * der zweite Lauf wirklich gespart hat oder ob nur die Uhr guenstig stand.
 */
function analysisCacheLine(c: {
  parseCacheHits: number;
  parseCacheMisses: number;
  chunkCacheHits: number;
  chunkCacheMisses: number;
  metricsCacheHits: number;
  metricsCacheMisses: number;
}): string {
  const hits = c.parseCacheHits + c.chunkCacheHits + c.metricsCacheHits;
  const lookups = hits + c.parseCacheMisses + c.chunkCacheMisses + c.metricsCacheMisses;
  if (lookups === 0) {
    return "Analysis cache:   off (no cache connected)";
  }
  const rate = ((hits / lookups) * 100).toFixed(1);
  return (
    `Analysis cache:   ${String(hits)}/${String(lookups)} hits (${rate} %) — ` +
    `Parse ${String(c.parseCacheHits)}/${String(c.parseCacheHits + c.parseCacheMisses)}, ` +
    `Chunk ${String(c.chunkCacheHits)}/${String(c.chunkCacheHits + c.chunkCacheMisses)}, ` +
    `metric ${String(c.metricsCacheHits)}/${String(c.metricsCacheHits + c.metricsCacheMisses)}`
  );
}
