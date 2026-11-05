/**
 * @untangle-code/extension-runtime — die Laufzeit fuer Analyzer-Extensions
 * (extensions.md, insbesondere §17 „X9").
 *
 * Dieses Paket enthaelt die LAUFZEIT, das MANIFEST-SCHEMA und die
 * FORMATPARSER. Es enthaelt KEIN Wissen ueber einzelne Werkzeuge: kein
 * Werkzeugname steht im Quelltext (E2), keine Fallunterscheidung kennt einen
 * Analysator. Untangle kennt AUSGABEFORMATE, nicht WERKZEUGE.
 *
 * Eine Analyzer-Extension ist ein externes Artefakt, das der Nutzer bewusst
 * unter `~/.untangle/extensions/<id>/manifest.toml` ablegt — nie etwas, das
 * ein geklontes Repository mitbringt (siehe `paths.ts`).
 *
 * Dieses Modul ist der EINZIGE oeffentliche Export des Pakets.
 */

// Versionskennungen (je Format eine Parserversion, X9).
export {
  EXTENSION_RUNTIME_VERSION,
  FORMAT_PARSER_VERSIONS,
  GENERIC_FINDINGS_PARSER_VERSION,
  GENERIC_METRICS_PARSER_VERSION,
  JUNIT_XML_PARSER_VERSION,
  SARIF_PARSER_VERSION,
  formatParserVersion,
} from "./versions.js";
export type { ExtensionRuntimeVersion } from "./versions.js";

// Fehlerklassen (extensions.md §6.8).
export {
  EXTENSION_FAILURE_REASONS,
  extensionFailed,
  extensionImageMismatch,
  extensionLicenseUnacknowledged,
  extensionTimeout,
  extensionUnavailable,
} from "./errors.js";
export type { ExtensionFailureReason } from "./errors.js";

// Speicherorte und die Sicherheitsgrenze zum Projektverzeichnis.
export {
  EXTENSIONS_HOME_ENV,
  MANIFEST_FILE_NAME,
  extensionDirectory,
  extensionManifestPath,
  isInsideDirectory,
  isProjectLocalManifest,
  resolveExtensionRoots,
  userDataDirectory,
} from "./paths.js";
export type { ExtensionPathEnvironmentV1 } from "./paths.js";

// Manifest: strenge Pruefung und Laden.
export { parseExtensionManifest } from "./manifest/shape.js";
export type { ManifestParseResultV1 } from "./manifest/shape.js";
export {
  MANIFEST_ORIGINS,
  discoverExtensions,
  loadExtensionFrom,
  loadExtensionManifestFile,
} from "./manifest/load.js";
export type {
  DiscoverExtensionsOptions,
  ExtensionDiscoveryResultV1,
  IgnoredManifestV1,
  LoadExtensionFromOptions,
  LoadedExtensionV1,
  ManifestOrigin,
  RejectedManifestV1,
} from "./manifest/load.js";

// Formatparser: Text rein, Rohbefunde raus. Kein Werkzeugwissen.
export { parseOutputFormat } from "./formats/index.js";
export { buildHttpAuthHeaders, formatOptionsFromManifest } from "./runtime.js";
export * from "./container/index.js";
export type { OutputFormatOptions } from "./formats/index.js";
export { SUPPORTED_SARIF_VERSION, parseSarif } from "./formats/sarif.js";
export { parseJUnitXml } from "./formats/junit-xml.js";
export {
  DEFAULT_GENERIC_FINDING_FIELDS,
  parseGenericFindings,
} from "./formats/generic-findings.js";
export type { GenericFindingFieldMappingV1 } from "./formats/generic-findings.js";
export { DEFAULT_GENERIC_METRIC_FIELDS, parseGenericMetrics } from "./formats/generic-metrics.js";
export type { GenericMetricFieldMappingV1 } from "./formats/generic-metrics.js";
export { FORMAT_PARSE_ISSUE_REASONS, FormatParseError, emptyParseResult } from "./formats/types.js";
export type {
  FormatParseIssueReason,
  FormatParseIssueV1,
  FormatParseResultV1,
  RawFindingV1,
  RawMeasurementV1,
  RawPositionV1,
} from "./formats/types.js";
export {
  describeRawValue,
  isRecord,
  isRelativeRepoPath,
  normalizeToolPath,
  readArray,
  readBoolean,
  readByteValue,
  readConfidenceValue,
  readFlagValue,
  readLineNumber,
  readLineValue,
  readNumber,
  readRecord,
  readString,
} from "./formats/util.js";
export type { FieldReadV1 } from "./formats/util.js";
export { readJsonEntries, readPath } from "./formats/json-lines.js";
export type { JsonEntriesV1, JsonEntryV1 } from "./formats/json-lines.js";

// Positionsabbildung Zeile → Byte (extensions.md §7.1).
export {
  buildLineOffsets,
  createLineOffsetResolver,
  createUnresolvedPositionResolver,
  sourceRangeFromByteOffsets,
  utf8Length,
} from "./positions.js";
export type { PositionResolver } from "./positions.js";

// Normalisierung auf `ExternalFindingV1` (extensions.md §7).
export {
  DEFAULT_CONFIDENCE_DETERMINISTIC,
  DEFAULT_CONFIDENCE_HEURISTIC,
  normalizeFindings,
} from "./normalize.js";
export type {
  FileResolutionV1,
  FileResolver,
  FindingNormalizationContextV1,
  NormalizationResultV1,
  SymbolResolutionV1,
  SymbolResolver,
} from "./normalize.js";

// Lizenz-Gate und Regelsatz-Gate (X5, extensions.md §9).
export {
  ACKNOWLEDGMENT_FILE_NAME,
  LICENSE_GATE_STATUSES,
  acknowledgmentFilePath,
  buildAcknowledgment,
  evaluateLicenseGate,
  loadLicenseAcknowledgments,
} from "./license-gate.js";
export type {
  GateOutcomeV1,
  LicenseAcknowledgmentFileV1,
  LicenseAcknowledgmentV1,
  LicenseGateDecisionV1,
  LicenseGateInput,
  LicenseGateStatus,
  LoadedAcknowledgmentsV1,
} from "./license-gate.js";

// Prozess- und Netzgrenze (X4).
export {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  PROCESS_OUTCOMES,
  defaultProcessLimits,
  isLoopbackUrl,
  redactSecrets,
} from "./process/types.js";
export type {
  HttpInvocationV1,
  HttpResultV1,
  HttpRunnerPort,
  ProcessInvocationV1,
  ProcessLimitsV1,
  ProcessOutcome,
  ProcessResultV1,
  ProcessRunnerPort,
} from "./process/types.js";
export { createNodeProcessRunner } from "./process/node-runner.js";
export { createFetchHttpRunner } from "./process/http-runner.js";
export type { FetchLike } from "./process/http-runner.js";

// Lauf- und Zustandsvertraege.
export { EXTENSION_RUN_EXIT_STATUSES, emptyFindingCounts } from "./types.js";
export type {
  ExtensionHealthV1,
  ExtensionRunExitStatus,
  ExtensionRunV1,
  ExtensionSkippedFileV1,
} from "./types.js";

// Lebenszyklus (extensions.md §6).
export {
  INVOCATION_PLACEHOLDERS,
  buildExtensionRunId,
  compareVersions,
  describeAbnormalExit,
  detectExtension,
  resolvePlaceholders,
  runExtension,
} from "./runtime.js";
export type {
  DetectExtensionInput,
  ExtensionRunResultV1,
  ExtensionRuntimeDeps,
  InvocationPlaceholder,
  RunExtensionInput,
} from "./runtime.js";
