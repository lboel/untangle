/**
 * Normalisierung: Rohbefund → `ExternalFindingV1` (extensions.md §7).
 *
 * Hier — und nur hier — bekommt ein Befund Untangle-Identitaeten: Byte-Range
 * (§7.1), umschliessendes Symbol (§7.2), normalisierte Severity (§7.3),
 * Confidence (§7.4) und eine deterministische `findingId` (§4.3).
 *
 * Drei Regeln bestimmen den Code:
 * - X3: Externe Zahlen werden zu `ExternalNumberV1`-Objekten, nie zu `number`
 *   an einer Metrikstelle.
 * - X9: Es gibt keinen Zweig „wenn Werkzeug X". Alles Werkzeugspezifische
 *   kommt als DATEN herein — Severity-Abbildung aus dem Manifest,
 *   Werkzeugname aus den Nutzerdaten.
 * - E4: Ein Befund, der sich nicht aufloesen laesst, wird NICHT verworfen. Er
 *   bekommt einen Skip-Ledger-Eintrag mit Grund, und sein Rohsatz bleibt in
 *   `unresolved` erhalten.
 */
import type {
  ExtensionComplexitySignalV1,
  ExtensionInvocationMode,
  ExtensionOutputFormat,
  ExtensionProvenanceV1,
  ExternalFindingV1,
  ExternalMeasurementV1,
  SeverityMappingV1,
  SkipLedgerEntryV1,
  SourceRange,
} from "@untangle-code/domain";
import {
  buildExternalFindingId,
  buildSkipLedgerEntry,
  makeExternalNumber,
  resolveNormalizedSeverity,
} from "@untangle-code/domain";

import type { RawFindingV1, RawMeasurementV1 } from "./formats/types.js";
import { isRelativeRepoPath } from "./formats/util.js";
import type { PositionResolver } from "./positions.js";
import { sourceRangeFromByteOffsets } from "./positions.js";
import { formatParserVersion } from "./versions.js";

/**
 * Defaults aus extensions.md §7.4: deterministische Regeln 0.8, heuristische
 * Verfahren 0.5. Sie greifen NUR, wenn das Werkzeug keine eigene Confidence
 * liefert; `basis` weist den Unterschied aus.
 */
export const DEFAULT_CONFIDENCE_DETERMINISTIC = 0.8;
export const DEFAULT_CONFIDENCE_HEURISTIC = 0.5;

/** Trenner der ID-Bestandteile (U+001F), wie im Identitaetsmodell. */
const UNIT_SEPARATOR = "\u001f";

/** Ergebnis der Dateiaufloesung (extensions.md §7.2). */
export interface FileResolutionV1 {
  /** Repo-relativer, "/"-normalisierter Pfad; Grundlage der Befund-ID. */
  relativePath?: string;
  fileId?: string;
  /** Pflicht, wenn `fileId` fehlt (E4). */
  fileIdMissingReason?: string;
  projectId?: string;
}

/** Bildet den Werkzeugpfad auf Index-Wissen ab. */
export type FileResolver = (toolPath: string) => FileResolutionV1;

/** Ergebnis der Symbolaufloesung (extensions.md §7.2). */
export interface SymbolResolutionV1 {
  symbolId?: string;
  symbolFqn?: string;
  /** Pflicht, wenn kein Symbol gefunden wurde (E4), z. B. "no_enclosing_symbol". */
  note?: string;
}

/** Bestimmt das kleinste umschliessende Symbol eines Byte-Ranges. */
export type SymbolResolver = (relativePath: string, range: SourceRange) => SymbolResolutionV1;

/** Alles, was ein Rohbefund fuer den Aufstieg zu `ExternalFindingV1` braucht. */
export interface FindingNormalizationContextV1 {
  workspaceId: string;
  repoId: string;
  refId: string;
  extensionRunId: string;
  extensionId: string;
  /** Werkzeugkennung aus den Nutzerdaten — nie ein Literal aus dem Quelltext (E2). */
  tool: string;
  toolVersion: string;
  /** ISO-8601 des Laufs; kommt vom Clock-Port des Aufrufers. */
  detectedAt: string;
  outputFormat: ExtensionOutputFormat;
  invocation: ExtensionInvocationMode;
  imageDigest?: string;
  severityMapping: SeverityMappingV1;
  /**
   * Bedeutung einzelner Ausgabeschluessel aus dem Manifest (X8). Ohne Eintrag
   * bleibt ein Kennwert eine Zahl mit Namen.
   */
  complexitySignals?: readonly ExtensionComplexitySignalV1[];
  ruleset?: string;
  rulesetVersion?: string;
  resolveFile: FileResolver;
  resolvePosition: PositionResolver;
  resolveSymbol?: SymbolResolver;
  /** Ueberschreibt die Defaults aus §7.4. */
  confidenceDefaults?: { deterministic: number; heuristic: number };
}

/** Ergebnis der Normalisierung. */
export interface NormalizationResultV1 {
  findings: ExternalFindingV1[];
  measurements: ExternalMeasurementV1[];
  /** Nicht aufgeloeste Gegenstaende MIT Grund (E4). */
  skipped: SkipLedgerEntryV1[];
  /** Rohsaetze der uebersprungenen Befunde — nichts geht verloren (E4). */
  unresolved: RawFindingV1[];
  /** Rohsaetze der uebersprungenen Kennwerte — nichts geht verloren (E4). */
  unresolvedMeasurements: RawMeasurementV1[];
  /** Wie oft der Severity-Fallback griff; sichtbar zu machen (E4). */
  severityFallbackCount: number;
  warnings: string[];
}

/**
 * True, wenn `path` KEIN repo-relativer Untangle-Pfad ist.
 *
 * Das schliesst nicht nur absolute Pfade ein, sondern auch solche, die mit
 * `../` aus dem Repository hinausfuehren: ein Befund in `../andere-repo/x.ts`
 * traegt einen Pfad, den kein Untangle-Vertrag zulaesst. Ihn zurechtzuschneiden
 * waere geraten, ihn durchzureichen eine falsche Zusicherung.
 */
function isOutsideRepository(path: string): boolean {
  return !isRelativeRepoPath(path);
}

/** Baut den Provenienzsatz eines Befundes/Kennwerts. */
function buildProvenance(
  context: FindingNormalizationContextV1,
  rawLocation: string,
): ExtensionProvenanceV1 {
  return {
    extensionId: context.extensionId,
    formatParserVersion: formatParserVersion(context.outputFormat),
    outputFormat: context.outputFormat,
    toolVersion: context.toolVersion,
    ...(context.imageDigest === undefined ? {} : { imageDigest: context.imageDigest }),
    invocation: context.invocation,
    rawLocation,
  };
}

/** Schluessel fuer `ordinal_within_identical_location` (extensions.md §4.3). */
function locationKey(
  tool: string,
  ruleId: string,
  relativePath: string,
  startByte: number,
): string {
  return [tool, ruleId, relativePath, String(startByte)].join(UNIT_SEPARATOR);
}

/**
 * Hebt Rohbefunde und Rohkennwerte auf die Domaenenvertraege.
 *
 * Reihenfolge und damit `ordinalWithinLocation` folgen der Reihenfolge der
 * Werkzeugausgabe. Das ist deterministisch fuer eine gegebene Ausgabe — und
 * die Ausgabe IST die Eingabe, nicht eine Laune der Laufzeit.
 */
export function normalizeFindings(
  raw: { findings: readonly RawFindingV1[]; measurements: readonly RawMeasurementV1[] },
  context: FindingNormalizationContextV1,
): NormalizationResultV1 {
  const result: NormalizationResultV1 = {
    findings: [],
    measurements: [],
    skipped: [],
    unresolved: [],
    unresolvedMeasurements: [],
    severityFallbackCount: 0,
    warnings: [],
  };
  const ordinals = new Map<string, number>();
  /**
   * Fundstellen, deren Zeile das Format nicht hergab und die deshalb am
   * Dateianfang verankert sind. Ohne diesen Vermerk waere die Zeile 1 von
   * einer gemessenen nicht zu unterscheiden (E4).
   */
  const anchoredWithoutLine: string[] = [];
  const defaults = context.confidenceDefaults ?? {
    deterministic: DEFAULT_CONFIDENCE_DETERMINISTIC,
    heuristic: DEFAULT_CONFIDENCE_HEURISTIC,
  };

  for (const finding of raw.findings) {
    const file = context.resolveFile(finding.filePath);
    const relativePath = file.relativePath ?? finding.filePath;
    if (isOutsideRepository(relativePath)) {
      // Der Werkzeugpfad liegt ausserhalb des Repositories oder konnte nicht
      // darauf bezogen werden. Ihn zurechtzuschneiden waere geraten.
      result.skipped.push(
        buildSkipLedgerEntry({
          stage: "extension",
          subjectKind: "file",
          path: finding.filePath,
          repoId: context.repoId,
          refId: context.refId,
          reason: "resolution_failed",
          detail:
            `finding of rule "${finding.ruleId}" points at "${finding.filePath}", which the file ` +
            "resolver could not map to a repository-relative path",
          recoverable: true,
        }),
      );
      result.unresolved.push(finding);
      continue;
    }

    const range =
      sourceRangeFromByteOffsets(finding.position) ??
      context.resolvePosition(relativePath, finding.position);
    if (range === null) {
      result.skipped.push(
        buildSkipLedgerEntry({
          stage: "extension",
          subjectKind: "range",
          path: relativePath,
          repoId: context.repoId,
          refId: context.refId,
          reason: "missing_index_entry",
          detail:
            `line ${String(finding.position.startLine)} of "${relativePath}" could not be ` +
            `translated into a byte range (rule "${finding.ruleId}"); the file content of the ` +
            "run's index generation was not available",
          recoverable: true,
        }),
      );
      result.unresolved.push(finding);
      continue;
    }

    const severity = resolveNormalizedSeverity(context.severityMapping, finding.originalSeverity);
    if (!severity.matched) {
      result.severityFallbackCount += 1;
      result.warnings.push(
        `severity "${finding.originalSeverity}" is not covered by mapping ` +
          `${context.severityMapping.mappingVersion}; fell back to "${severity.normalized}"`,
      );
    }

    const symbol = context.resolveSymbol?.(relativePath, range) ?? {};
    const symbolId = symbol.symbolId;
    const hasSymbol = symbolId !== undefined && symbolId !== "";

    const key = locationKey(context.tool, finding.ruleId, relativePath, range.startByte);
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);

    if (finding.position.lineUnknown === true) {
      anchoredWithoutLine.push(finding.rawLocation);
    }

    const isHeuristic = finding.isHeuristic ?? false;
    const confidenceValue =
      finding.confidenceValue ?? (isHeuristic ? defaults.heuristic : defaults.deterministic);
    const ruleset = finding.ruleset ?? context.ruleset;
    const rulesetVersion = finding.rulesetVersion ?? context.rulesetVersion;

    result.findings.push({
      schemaVersion: 1,
      evidenceOnly: true,
      findingId: buildExternalFindingId({
        extensionRunId: context.extensionRunId,
        tool: context.tool,
        ruleId: finding.ruleId,
        relativePath,
        startByte: range.startByte,
        ordinalWithinLocation: ordinal,
      }),
      workspaceId: context.workspaceId,
      repoId: context.repoId,
      refId: context.refId,
      ...(file.projectId === undefined ? {} : { projectId: file.projectId }),
      ...(file.fileId === undefined
        ? {
            fileIdMissingReason:
              file.fileIdMissingReason ??
              `file "${relativePath}" is not part of the index generation of this run`,
          }
        : { fileId: file.fileId }),
      filePath: relativePath,
      sourceRange: range,
      ...(hasSymbol
        ? {
            symbolId,
            ...(symbol.symbolFqn === undefined ? {} : { symbolFqn: symbol.symbolFqn }),
            symbolResolution: "symbol" as const,
          }
        : {
            symbolResolution: "file_only" as const,
            symbolResolutionNote: symbol.note ?? "no_enclosing_symbol",
          }),
      tool: context.tool,
      toolVersion: context.toolVersion,
      ruleId: finding.ruleId,
      ...(ruleset === undefined ? {} : { ruleset }),
      ...(rulesetVersion === undefined ? {} : { rulesetVersion }),
      severity: {
        normalized: severity.normalized,
        original: finding.originalSeverity,
        mappingVersion: context.severityMapping.mappingVersion,
        mappingMatched: severity.matched,
      },
      message: finding.message,
      ...(finding.remediationHint === undefined
        ? {}
        : { remediationHint: finding.remediationHint }),
      confidence: {
        value: confidenceValue,
        basis: finding.confidenceValue === undefined ? "mapped" : "tool",
        ...(finding.originalConfidence === undefined
          ? {}
          : { original: finding.originalConfidence }),
      },
      isHeuristic,
      detectedAt: context.detectedAt,
      extensionRunId: context.extensionRunId,
      provenance: buildProvenance(context, finding.rawLocation),
    });
  }

  if (anchoredWithoutLine.length > 0) {
    const shown = anchoredWithoutLine.slice(0, 20);
    result.warnings.push(
      `${String(anchoredWithoutLine.length)} finding(s) carry no line number from the tool output ` +
        "and are anchored at the start of their file; their sourceRange is a placeholder, not a " +
        `measured position (${shown.join(", ")}${
          anchoredWithoutLine.length > shown.length
            ? `, and ${String(anchoredWithoutLine.length - shown.length)} more`
            : ""
        })`,
    );
  }

  for (const measurement of raw.measurements) {
    const file: FileResolutionV1 =
      measurement.filePath === undefined ? {} : context.resolveFile(measurement.filePath);
    const relativePath = file.relativePath ?? measurement.filePath;
    if (relativePath !== undefined && isOutsideRepository(relativePath)) {
      // Dieselbe Pruefung wie fuer Befunde. Ohne sie traegt ein Kennwert einen
      // Pfad, den kein Untangle-Vertrag zulaesst — und niemand erfaehrt davon.
      // Den Pfad einfach wegzulassen waere die staerkere Aussage „diese Groesse
      // gilt fuer das ganze Repository"; das hat das Werkzeug nicht gesagt.
      result.skipped.push(
        buildSkipLedgerEntry({
          stage: "extension",
          subjectKind: "file",
          path: measurement.filePath ?? relativePath,
          repoId: context.repoId,
          refId: context.refId,
          reason: "resolution_failed",
          detail:
            `measurement "${measurement.key}" points at "${String(measurement.filePath)}", which ` +
            "the file resolver could not map to a repository-relative path",
          recoverable: true,
        }),
      );
      result.unresolvedMeasurements.push(measurement);
      continue;
    }
    const declared = (context.complexitySignals ?? []).find(
      (candidate) => candidate.key === measurement.key,
    );
    let signal: ExtensionComplexitySignalV1 | undefined = declared;
    if (declared !== undefined && declared.scope !== "repository" && relativePath === undefined) {
      // Der Bezug ist so bindend wie die Bedeutung. Einen Wert ohne Pfad als
      // Datei- oder Symbolgroesse zu fuehren waere eine Aussage, die das
      // Werkzeug nicht gemacht hat — und sie wuerde ihn fuer eine Gegenprobe
      // gegen die falsche Untangle-Groesse freigeben (X8).
      signal = undefined;
      result.warnings.push(
        `measurement "${measurement.key}" is declared with scope "${declared.scope}" but arrived ` +
          "without a file path; it is kept as an unnamed measurement and is not comparable",
      );
    }
    result.measurements.push({
      schemaVersion: 1,
      evidenceOnly: true,
      workspaceId: context.workspaceId,
      repoId: context.repoId,
      refId: context.refId,
      ...(relativePath === undefined ? {} : { filePath: relativePath }),
      key: measurement.key,
      ...(signal === undefined ? {} : { signal }),
      // X3: der Wert verlaesst diesen Punkt nur als ExternalNumberV1 — er
      // passt damit an keine Untangle-Metrikstelle.
      value:
        measurement.unit === undefined
          ? makeExternalNumber(measurement.value)
          : makeExternalNumber(measurement.value, measurement.unit),
      extensionRunId: context.extensionRunId,
      measuredAt: context.detectedAt,
      provenance: buildProvenance(context, measurement.rawLocation),
    });
  }

  return result;
}
