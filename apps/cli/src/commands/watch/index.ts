/**
 * `untangle watch` — der Komplexitaetswaechter (vision.md §1b, §1d).
 *
 * Dies ist die EINZIGE oeffentliche Schnittstelle des Kommandos; `main.ts`
 * und die Tests importieren nur von hier.
 */
export { createFileAnalyzer, ORDERED_METRICS } from "./analyze.js";
export type {
  AnalysisOutcomeV1,
  FileAnalyzerOptions,
  FileReadingV1,
  ScopeReadingV1,
} from "./analyze.js";
export {
  addMetricValues,
  directionOf,
  metricDeltas,
  netDirectionOf,
  readingOf,
  scopeDeltas,
  verdictOf,
} from "./delta.js";
export { METRIC_KEYS, zeroMetricValues } from "./events.js";
export type {
  ComplexityDirection,
  MetricDeltaV1,
  MetricKey,
  MetricReadingKind,
  MetricValues,
  ScopeDeltaV1,
  WatchBaselineEventV1,
  WatchChangeEventV1,
  WatchStartedEventV1,
  WatchStatusEventV1,
  WatchStoppedEventV1,
  WatchStreamEventDraftV1,
  WatchStreamEventV1,
  WatchUnanalyzedEventV1,
} from "./events.js";
export { parseWatchArgs, WATCH_USAGE } from "./options.js";
export type { ParseWatchArgsEnv, WatchOptionsV1 } from "./options.js";
export { formatNumber, formatSigned, renderJson, renderText } from "./render.js";
export { runWatch } from "./run.js";
export type { RunWatchDeps } from "./run.js";
export {
  createIgnorePredicate,
  createStreamSink,
  CryptoRandom,
  STATE_DIR_NAME,
  stripAnsi,
  SystemClock,
} from "./runtime.js";
export { runWatchCli } from "./cli.js";
