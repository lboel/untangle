/**
 * `untangle watch` — der laufende Strom.
 *
 * Hier laufen fuenf Pakete zu EINEM Waechter zusammen:
 *
 *   scanner          Grundmessung: welche Dateien gehoeren ueberhaupt dazu
 *   watcher          `RepoWatcher`: native Ereignisse, Entprellung,
 *                    periodischer Abgleich, Ref-Lock
 *   jobs             `BoundedQueue`: Rueckstau zwischen Watcher und Messung,
 *                    mit sichtbarem Speicherbudget (architecture.md §13.2)
 *   parser-registry  Sprachadapter
 *   chunker          semantische Ladung
 *   complexity       die drei Scope-Metriken und ihre Aggregation
 *
 * ## Warum eine Queue zwischen Watcher und Messung
 *
 * Die Messung einer Datei ist um Groessenordnungen teurer als das Ereignis,
 * das sie ausloest. Ohne Grenze wuerde ein `git checkout` mit tausend
 * geaenderten Dateien tausend Syntaxbaeume gleichzeitig in den Speicher
 * ziehen. `BoundedQueue` laesst den Watcher stattdessen WARTEN, sobald das
 * Budget erreicht ist — genau der Rueckstau, fuer den das Paket gebaut ist.
 * Der Waechter benutzt hier bewusst NUR diese Mechanik von `jobs` und nicht
 * `IndexJobRunner`: der Runner verlangt Embedding- und Speicherstufen
 * (Ollama, Qdrant), die ein reiner Komplexitaetswaechter nicht braucht und
 * ohne die er `completed` nie erreichen koennte.
 *
 * ## Sauberes Beenden
 *
 * SIGINT/SIGTERM loesen genau eine Abbaufolge aus: Signalgriff abmelden (ein
 * zweites Strg-C beendet dann hart), Watcher stoppen, Queue schliessen und
 * leerlaufen lassen, Lock-Zustand PRUEFEN statt behaupten, Abschlussereignis
 * schreiben, Mitschrift schliessen. Der Lock wird von `RepoWatcher.stop()`
 * freigegeben; dass er wirklich weg ist, steht anschliessend im
 * Abschlussereignis — nachgesehen, nicht angenommen.
 */
import path from "node:path";

import { aggregate, type AggregationEntry } from "@untangle-code/complexity";
import {
  compareCodepoints,
  buildSkipLedgerEntry,
  type Clock,
  type Random,
  type SkipLedgerEntryV1,
} from "@untangle-code/domain";
import { BoundedQueue } from "@untangle-code/jobs";
import { createParserRegistry } from "@untangle-code/parser-registry";
import { discoverFiles, hashBytes, type ScanSkipV1 } from "@untangle-code/scanner";
import { NodeFileSystem } from "@untangle-code/scanner/node-fs";
import {
  buildStateDirLayout,
  ensureStateDirLayout,
  FileLockProvider,
  LocalFileSystem,
} from "@untangle-code/storage-local";
import {
  buildWatchLockKey,
  NodeNativeWatcher,
  NodeScheduler,
  RepoWatcher,
  type WatchedFileSnapshotV1,
  type WatcherEventV1,
} from "@untangle-code/watcher";

import { createFileAnalyzer, type FileReadingV1 } from "./analyze.js";
import { addMetricValues, metricDeltas, netDirectionOf, scopeDeltas, verdictOf } from "./delta.js";
import {
  zeroMetricValues,
  type MetricValues,
  type WatchStreamEventDraftV1,
  type WatchStreamEventV1,
} from "./events.js";
import type { WatchOptionsV1 } from "./options.js";
import { renderJson, renderText } from "./render.js";
import { createIgnorePredicate, createStreamSink, STATE_DIR_NAME } from "./runtime.js";

export interface RunWatchDeps {
  clock: Clock;
  random: Random;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  /** Meldet einen Signalgriff an und liefert dessen Abmeldung zurueck. */
  installSignalHandler: (handler: (signal: string) => void) => () => void;
  /** Rechnername fuer den Lock-Datensatz. */
  host: string;
}

/** Ein Element der Rueckstau-Queue: ein Watcher-Ereignis, das noch zu messen ist. */
interface PendingChange {
  event: WatcherEventV1;
  /** Grobe Kostenschaetzung fuer das Byte-Budget der Queue. */
  bytes: number;
}

const QUEUE_CAPACITY = 512;
const QUEUE_BUDGET_BYTES = 32 * 1024 * 1024;

export async function runWatch(options: WatchOptionsV1, deps: RunWatchDeps): Promise<number> {
  const startedAtMs = deps.clock.nowEpochMs();
  const sink = createStreamSink({ stdout: deps.stdout, outPath: options.outPath });
  let sequence = 0;

  const emit = (event: WatchStreamEventDraftV1): void => {
    const full = { ...event, sequence: sequence++, at: deps.clock.nowIso() } as WatchStreamEventV1;
    sink.write(
      options.format === "json" ? renderJson(full) : renderText(full, { color: options.color }),
    );
  };

  const readings = new Map<string, FileReadingV1>();
  let unanalyzedCount = 0;
  const emitUnanalyzed = (origin: "baseline" | "change", entry: SkipLedgerEntryV1): void => {
    unanalyzedCount++;
    emit({ kind: "unanalyzed", origin, entry });
  };

  const nodeFs = new NodeFileSystem();
  const stateRoot = path.join(options.root, STATE_DIR_NAME);
  const localFs = new LocalFileSystem([stateRoot]);
  const layout = buildStateDirLayout(stateRoot);
  await ensureStateDirLayout(localFs, layout);
  const lockProvider = new FileLockProvider(
    localFs,
    layout.locks,
    deps.clock,
    deps.random,
    deps.host,
  );
  const lockKey = buildWatchLockKey(options.repoId, options.refId);

  emit({
    kind: "started",
    root: options.root,
    repoId: options.repoId,
    refId: options.refId,
    lockKey,
  });

  const analyze = createFileAnalyzer({
    registry: createParserRegistry(),
    repoId: options.repoId,
    refId: options.refId,
    workspaceId: `ws-${options.repoId}`,
    refName: options.refId,
    repoLabel: options.repoId,
  });

  // ---------------------------------------------------------------------
  // Grundmessung. Ohne sie waere jedes spaetere Delta gegen Nichts gemessen
  // und damit wertlos.
  // ---------------------------------------------------------------------
  const baselineStartMs = deps.clock.nowEpochMs();
  const snapshots: WatchedFileSnapshotV1[] = [];
  const scannerSkips: ScanSkipV1[] = [];
  let excludedByRules = 0;
  let scopeIdCollisions = 0;
  let nodeKindFallbacks = 0;

  for await (const file of discoverFiles({
    fs: nodeFs,
    roots: [options.root],
    repoRoot: options.root,
    maxFileSizeBytes: options.maxFileBytes,
    onSkip: (skip) => {
      if (isRuleExclusion(skip.reason)) {
        excludedByRules++;
        return;
      }
      scannerSkips.push(skip);
    },
  })) {
    snapshots.push({
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      mtimeEpochMs: file.mtimeEpochMs,
      contentHash: file.contentHash,
    });
    let content: string;
    try {
      content = await nodeFs.readTextFile(file.absolutePath);
    } catch (error) {
      emitUnanalyzed(
        "baseline",
        buildSkipLedgerEntry({
          stage: "scan",
          subjectKind: "file",
          path: file.relativePath,
          reason: "provider_unavailable",
          detail: `Cannot read file: ${error instanceof Error ? error.message : String(error)}`,
          recoverable: true,
        }),
      );
      continue;
    }
    const outcome = analyze(file.relativePath, content);
    if (!outcome.ok) {
      emitUnanalyzed("baseline", outcome.entry);
      continue;
    }
    readings.set(file.relativePath, outcome.reading);
    scopeIdCollisions += outcome.reading.scopeIdCollisions;
    nodeKindFallbacks += outcome.reading.nodeKindFallbacks;
  }

  // Dateien, die der SCANNER ausgeschlossen hat (binaer, zu gross, unlesbar),
  // gehen in keine Zahl ein — der WATCHER beobachtet sie aber weiter, weil
  // sein Ignorier-Praedikat inhaltsunabhaengig ist. Ohne einen Schnappschuss
  // meldete der erste Abgleichlauf sie deshalb als frisch hinzugekommen, und
  // der Nutzer saehe dieselbe Datei zweimal: einmal vom Scanner, einmal vom
  // Watcher. Der Schnappschuss verhindert genau diese Doppelmeldung, ohne die
  // Datei aus der Beobachtung zu nehmen: aendert sie sich WIRKLICH, meldet der
  // Watcher sie — und die Messung sagt dann erneut, warum sie nicht geht.
  for (const skip of scannerSkips) {
    const absolute = path.join(options.root, skip.relativePath);
    const stat = await nodeFs.stat(absolute);
    if (stat === null || stat.kind !== "file") continue;
    try {
      const bytes = await nodeFs.readFile(absolute);
      snapshots.push({
        relativePath: skip.relativePath,
        sizeBytes: stat.sizeBytes,
        mtimeEpochMs: stat.mtimeEpochMs,
        contentHash: hashBytes(bytes),
      });
    } catch {
      // Unlesbar — dann gibt es auch keinen Schnappschuss. Der Grund steht
      // ohnehin gleich als Ledger-Eintrag im Strom.
    }
  }

  for (const skip of scannerSkips) {
    emitUnanalyzed(
      "baseline",
      buildSkipLedgerEntry({
        stage: "scan",
        subjectKind: "file",
        path: skip.relativePath,
        reason: scannerReason(skip.reason),
        detail:
          `Excluded by the scanner (${skip.reason})` +
          (skip.detail === undefined ? "." : `: ${skip.detail}`) +
          " This file contributes to no measurement and its change produces no delta.",
        recoverable: skip.reason === "unreadable",
      }),
    );
  }

  const totals = totalsOf(readings);
  emit({
    kind: "baseline",
    filesAnalyzed: readings.size,
    filesUnanalyzed: unanalyzedCount,
    filesExcludedByRules: excludedByRules,
    totals,
    scopeCount: [...readings.values()].reduce((sum, reading) => sum + reading.scopeCount, 0),
    scopeIdCollisions,
    nodeKindFallbacks,
    durationMs: deps.clock.nowEpochMs() - baselineStartMs,
  });

  // ---------------------------------------------------------------------
  // Der laufende Strom.
  // ---------------------------------------------------------------------
  const queue = new BoundedQueue<PendingChange>({
    capacity: QUEUE_CAPACITY,
    maxBytes: QUEUE_BUDGET_BYTES,
    sizeOf: (item) => item.bytes,
  });

  let changesObserved = 0;
  let net: MetricValues = zeroMetricValues();
  let stopping = false;
  let stopReason: "signal" | "limit" | "baseline" | "error" = "signal";
  let stopSignal: string | null = null;
  let stopResolve: (() => void) | null = null;
  const stopped = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });

  const requestStop = (
    reason: "signal" | "limit" | "baseline" | "error",
    signal: string | null,
  ): void => {
    if (stopping) return;
    stopping = true;
    stopReason = reason;
    stopSignal = signal;
    stopResolve?.();
  };

  const watcher = new RepoWatcher({
    repoId: options.repoId,
    refId: options.refId,
    rootPath: options.root,
    fs: nodeFs,
    nativeWatcher: new NodeNativeWatcher(),
    scheduler: new NodeScheduler(),
    clock: deps.clock,
    lockProvider,
    ignore: createIgnorePredicate(options.root),
    initialSnapshots: snapshots,
    debounceMs: options.debounceMs,
    reconciliationIntervalMs: options.reconciliationIntervalMs,
  });

  watcher.onStatusChange((status) => {
    emit({
      kind: "status",
      status: status.status,
      detail: status.error === undefined ? null : `${status.error.code}: ${status.error.message}`,
    });
  });

  watcher.onChange(async (events) => {
    for (const event of events) {
      if (stopping) return;
      await queue.push({ event, bytes: estimateBytes(event) });
    }
  });

  const worker = (async (): Promise<void> => {
    for (;;) {
      const pulled = await queue.pull();
      if (pulled.done) return;
      await handleChange(pulled.value.event);
      if (options.exitAfterChanges !== null && changesObserved >= options.exitAfterChanges) {
        requestStop("limit", null);
        return;
      }
    }
  })();

  async function handleChange(event: WatcherEventV1): Promise<void> {
    const analysisStartMs = deps.clock.nowEpochMs();
    const previous = readings.get(event.relativePath);

    if (event.changeKind === "deleted") {
      readings.delete(event.relativePath);
      const deltas = metricDeltas(previous, undefined);
      changesObserved++;
      net = addMetricValues(net, deltas);
      emit({
        kind: "change",
        changeKind: "deleted",
        path: event.relativePath,
        languageId: previous?.languageId ?? null,
        contentHash: null,
        metrics: deltas,
        scopes: scopeDeltas(previous, undefined, options.scopeLimit),
        verdict: verdictOf(deltas),
        notes:
          previous === undefined
            ? [
                "This file contributed to no measurement (no language adapter or not " +
                  "analyzable); its removal does not change the overall measurements.",
              ]
            : [],
        analysisMs: deps.clock.nowEpochMs() - analysisStartMs,
      });
      return;
    }

    if (event.sizeBytes > options.maxFileBytes) {
      emitUnanalyzed(
        "change",
        buildSkipLedgerEntry({
          stage: "scan",
          subjectKind: "file",
          path: event.relativePath,
          reason: "file_too_large",
          detail:
            `${String(event.sizeBytes)} bytes exceed the limit of ` +
            `${String(options.maxFileBytes)} bytes (--max-file-bytes). This file's previous measurement ` +
            `is retained as its last known state.`,
          recoverable: true,
        }),
      );
      return;
    }

    let content: string;
    try {
      content = await nodeFs.readTextFile(path.join(options.root, event.relativePath));
    } catch (error) {
      emitUnanalyzed(
        "change",
        buildSkipLedgerEntry({
          stage: "scan",
          subjectKind: "file",
          path: event.relativePath,
          reason: "provider_unavailable",
          detail:
            `Cannot read file after the change event: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          recoverable: true,
        }),
      );
      return;
    }

    const outcome = analyze(event.relativePath, content);
    if (!outcome.ok) {
      // BEWUSST: der letzte gute Messwert bleibt stehen. Wer eine Datei
      // gerade halbfertig speichert, will beim naechsten gelungenen Parse
      // das Delta gegen den letzten MESSBAREN Stand sehen, nicht gegen
      // Nichts. Dass zwischenzeitlich nicht gemessen werden konnte, sagt
      // dieses Ereignis.
      emitUnanalyzed("change", outcome.entry);
      return;
    }

    if (previous !== undefined && previous.contentHash === outcome.reading.contentHash) {
      // Inhaltsgleich: der Watcher hat eine Beruehrung gemeldet, keine
      // Aenderung. Kein Delta-Ereignis, aber auch kein Schweigen ueber eine
      // echte Aenderung — der Hash ist die Autoritaet (spec.md §12.1).
      readings.set(event.relativePath, outcome.reading);
      return;
    }

    readings.set(event.relativePath, outcome.reading);
    const deltas = metricDeltas(previous, outcome.reading);
    changesObserved++;
    net = addMetricValues(net, deltas);
    emit({
      kind: "change",
      changeKind: event.changeKind,
      path: event.relativePath,
      languageId: outcome.reading.languageId,
      contentHash: outcome.reading.contentHash,
      metrics: deltas,
      scopes: scopeDeltas(previous, outcome.reading, options.scopeLimit),
      verdict: verdictOf(deltas),
      notes: outcome.reading.notes,
      analysisMs: deps.clock.nowEpochMs() - analysisStartMs,
    });
  }

  const uninstall = deps.installSignalHandler((signal) => {
    requestStop("signal", signal);
  });

  let exitCode = 0;
  try {
    await watcher.start();
    if (options.baselineOnly) {
      requestStop("baseline", null);
    }
    await stopped;
  } catch (error) {
    exitCode = 1;
    stopReason = "error";
    deps.stderr(`untangle watch: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    uninstall();
    await watcher.stop();
    queue.close();
    await worker.catch(() => {
      // Die Queue wurde geschlossen, waehrend ein Push wartete — kein Fehler:
      // der Abbau laeuft ohnehin gerade.
    });
    const held = await lockProvider.inspect(lockKey);
    const queueStats = queue.stats();
    emit({
      kind: "stopped",
      reason: stopReason,
      signal: stopSignal,
      changesObserved,
      filesUnanalyzed: unanalyzedCount,
      net,
      netDirection: netDirectionOf(net),
      queue: {
        maxDepthObserved: queueStats.maxDepthObserved,
        maxBytesObserved: queueStats.maxBytesObserved,
        overBudgetAdmissions: queueStats.overBudgetAdmissions,
      },
      lockReleased: held === null,
      durationMs: deps.clock.nowEpochMs() - startedAtMs,
    });
    await sink.close();
  }
  return exitCode;
}

/**
 * Summe der vier Metriken ueber alle gemessenen Dateien.
 *
 * Die drei Scope-Metriken werden ueber `aggregate()` gefuehrt, also ueber
 * `metrics_scope_id` dedupliziert (spec.md §16.10) — dieselbe Scope-Id kann
 * nicht zweimal in die Summe eingehen, auch wenn zwei Dateien sie melden
 * sollten. Die semantische Ladung ist eine Datei-Groesse und wird schlicht
 * addiert.
 */
function totalsOf(readings: ReadonlyMap<string, FileReadingV1>): MetricValues {
  const paths = [...readings.keys()].sort(compareCodepoints);
  const entriesPerMetric: Record<"structural" | "cyclomatic" | "cognitive", AggregationEntry[]> = {
    structural: [],
    cyclomatic: [],
    cognitive: [],
  };
  let semantic = 0;
  for (const filePath of paths) {
    const reading = readings.get(filePath) as FileReadingV1;
    semantic += reading.totals.semantic;
    for (const scope of reading.scopes) {
      if (!scope.selected) continue;
      for (const metric of ["structural", "cyclomatic", "cognitive"] as const) {
        entriesPerMetric[metric].push({
          metricsScopeId: `${filePath}${scope.metricsScopeId}`,
          value: scope.values[metric],
        });
      }
    }
  }
  return {
    structural: aggregate(entriesPerMetric.structural).sum,
    semantic,
    cyclomatic: aggregate(entriesPerMetric.cyclomatic).sum,
    cognitive: aggregate(entriesPerMetric.cognitive).sum,
  };
}

/** Grobe Kostenschaetzung eines wartenden Ereignisses fuer das Byte-Budget. */
function estimateBytes(event: WatcherEventV1): number {
  if (event.changeKind === "deleted") return 256;
  // Der Syntaxbaum einer Datei kostet ein Vielfaches ihres Textes; Faktor 8
  // ist eine bewusst konservative, dokumentierte Schaetzung, kein Messwert.
  return 256 + event.sizeBytes * 8;
}

/** Ausschluesse, die auf einer Ignorierregel beruhen (siehe `WatchBaselineEventV1`). */
function isRuleExclusion(reason: ScanSkipV1["reason"]): boolean {
  return (
    reason === "config-exclude" ||
    reason === "untangleignore" ||
    reason === "gitignore" ||
    reason === "default-exclude" ||
    reason === "security"
  );
}

/** Bildet die Scanner-Ausschlussgruende auf die geschlossene `SKIP_REASONS`-Menge ab. */
function scannerReason(reason: ScanSkipV1["reason"]): SkipLedgerEntryV1["reason"] {
  switch (reason) {
    case "binary":
      return "binary_content";
    case "size-limit":
      return "file_too_large";
    case "unreadable":
      return "provider_unavailable";
    default:
      return "excluded_by_configuration";
  }
}
