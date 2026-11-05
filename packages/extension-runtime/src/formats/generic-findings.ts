/**
 * Parser fuer `generic-findings` — Untangles eigenes, dokumentiertes
 * Befundformat (extensions.md §17, X9: „ein dokumentiertes JSON-Schema mit
 * deklarativem Feld-Mapping").
 *
 * Es ist der Auffangweg fuer Werkzeuge ohne Standardformat: der
 * Extension-Autor bringt ihre Ausgabe per Vorschaltbefehl
 * (`ExtensionPreprocessV1`) hierher ODER beschreibt im Manifest ein
 * FELD-MAPPING, das die vorhandenen Schluessel auf die kanonischen abbildet.
 * Beides ist reine Daten — es laeuft kein fremder Code bei uns (X4), und im
 * Quelltext steht kein Werkzeugname (E2).
 *
 * Kanonischer Eintrag (JSON Lines, ein Objekt je Zeile):
 *
 * ```json
 * {"path":"src/a.ts","startLine":12,"endLine":14,"ruleId":"no-eval",
 *  "message":"eval is forbidden","severity":"ERROR","confidence":0.9}
 * ```
 *
 * Pflichtfelder sind `path`, `startLine`, `ruleId`, `message` und `severity`.
 * Fehlt eines, wird der Eintrag gezaehlt und begruendet (E4) — die uebrigen
 * Eintraege derselben Ausgabe bleiben erhalten.
 */
import { GENERIC_FINDINGS_PARSER_VERSION } from "../versions.js";

import { readJsonEntries, readPath } from "./json-lines.js";
import type { FormatParseResultV1, RawFindingV1, RawPositionV1 } from "./types.js";
import { emptyParseResult } from "./types.js";
import type { FieldReadV1 } from "./util.js";
import {
  isRecord,
  normalizeToolPath,
  readByteValue,
  readConfidenceValue,
  readFlagValue,
  readLineValue,
} from "./util.js";

/**
 * Deklaratives Feld-Mapping: kanonisches Feld → Punktpfad in der
 * Werkzeugausgabe. Nicht genannte Felder benutzen den kanonischen Namen.
 */
export interface GenericFindingFieldMappingV1 {
  path?: string;
  startLine?: string;
  endLine?: string;
  startColumn?: string;
  endColumn?: string;
  byteOffset?: string;
  byteLength?: string;
  ruleId?: string;
  message?: string;
  severity?: string;
  remediation?: string;
  confidence?: string;
  confidenceOriginal?: string;
  isHeuristic?: string;
  ruleset?: string;
  rulesetVersion?: string;
}

/** Die kanonischen Schluesselnamen — zugleich das Default-Mapping. */
export const DEFAULT_GENERIC_FINDING_FIELDS: Required<GenericFindingFieldMappingV1> = {
  path: "path",
  startLine: "startLine",
  endLine: "endLine",
  startColumn: "startColumn",
  endColumn: "endColumn",
  byteOffset: "byteOffset",
  byteLength: "byteLength",
  ruleId: "ruleId",
  message: "message",
  severity: "severity",
  remediation: "remediation",
  confidence: "confidence",
  confidenceOriginal: "confidenceOriginal",
  isHeuristic: "isHeuristic",
  ruleset: "ruleset",
  rulesetVersion: "rulesetVersion",
};

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

/** Liest `generic-findings` mit optionalem, deklarativem Feld-Mapping. */
export function parseGenericFindings(
  text: string,
  mapping: GenericFindingFieldMappingV1 = {},
): FormatParseResultV1 {
  const fields = { ...DEFAULT_GENERIC_FINDING_FIELDS, ...mapping };
  const result = emptyParseResult(GENERIC_FINDINGS_PARSER_VERSION);
  const read = readJsonEntries(text, GENERIC_FINDINGS_PARSER_VERSION, "findings");
  result.issues.push(...read.issues);

  const findings: RawFindingV1[] = [];
  for (const entry of read.entries) {
    result.entriesSeen += 1;
    if (!isRecord(entry.value)) {
      result.issues.push({
        rawLocation: entry.rawLocation,
        reason: "invalid_entry",
        detail: "entry is not a JSON object",
      });
      continue;
    }
    const source = entry.value;
    /**
     * Meldet ein Feld, das DA ist, dessen Wert aber unbrauchbar ist. Ein
     * fehlendes Feld ist etwas anderes und bleibt stumm; ein vorhandenes,
     * unlesbares stillschweigend durch einen Vorgabewert zu ersetzen, waere
     * eine erfundene Angabe mit dem Anschein einer gelieferten (E4).
     */
    const reportUnreadable = (field: string, raw: string, expectation: string): void => {
      result.issues.push({
        rawLocation: entry.rawLocation,
        reason: "unreadable_field",
        detail: `"${field}" is ${raw}, ${expectation}`,
      });
    };

    const filePath = asString(readPath(source, fields.path));
    const ruleId = asString(readPath(source, fields.ruleId));
    const message = asString(readPath(source, fields.message));
    const severity = asString(readPath(source, fields.severity));
    const startLineRead = readLineValue(readPath(source, fields.startLine));
    const startLine = startLineRead.state === "value" ? startLineRead.value : undefined;

    if (
      filePath === undefined ||
      ruleId === undefined ||
      message === undefined ||
      severity === undefined
    ) {
      const missing = [
        filePath === undefined ? fields.path : undefined,
        ruleId === undefined ? fields.ruleId : undefined,
        message === undefined ? fields.message : undefined,
        severity === undefined ? fields.severity : undefined,
      ].filter((name): name is string => name !== undefined);
      result.issues.push({
        rawLocation: entry.rawLocation,
        reason: "missing_required_field",
        detail: `entry lacks required field(s): ${missing.join(", ")}`,
      });
      continue;
    }
    if (startLine === undefined) {
      result.issues.push({
        rawLocation: entry.rawLocation,
        reason: "invalid_number",
        detail:
          startLineRead.state === "unreadable"
            ? `"${fields.startLine}" is ${startLineRead.raw}, not a 1-based integer line number`
            : `"${fields.startLine}" must be a 1-based integer line number`,
      });
      continue;
    }

    const endLineRead = readLineValue(readPath(source, fields.endLine));
    if (endLineRead.state === "unreadable") {
      reportUnreadable(fields.endLine, endLineRead.raw, "not a 1-based integer line number");
    }
    const endLine = endLineRead.state === "value" ? endLineRead.value : startLine;
    if (endLineRead.state === "value" && endLineRead.value < startLine) {
      reportUnreadable(
        fields.endLine,
        String(endLineRead.value),
        `before "${fields.startLine}" (${String(startLine)}); the range was collapsed to the start line`,
      );
    }
    const startColumn = readOptional(
      readPath(source, fields.startColumn),
      readLineValue,
      fields.startColumn,
      "not a 1-based integer column number",
      reportUnreadable,
    );
    const endColumn = readOptional(
      readPath(source, fields.endColumn),
      readLineValue,
      fields.endColumn,
      "not a 1-based integer column number",
      reportUnreadable,
    );
    const byteOffset = readOptional(
      readPath(source, fields.byteOffset),
      readByteValue,
      fields.byteOffset,
      "not a non-negative integer byte offset",
      reportUnreadable,
    );
    const byteLength = readOptional(
      readPath(source, fields.byteLength),
      readByteValue,
      fields.byteLength,
      "not a non-negative integer byte length",
      reportUnreadable,
    );
    const position: RawPositionV1 = {
      startLine,
      endLine: Math.max(endLine, startLine),
      ...(startColumn === undefined ? {} : { startColumn }),
      ...(endColumn === undefined ? {} : { endColumn }),
      ...(byteOffset === undefined ? {} : { byteOffset }),
      ...(byteLength === undefined ? {} : { byteLength }),
    };

    const remediation = asString(readPath(source, fields.remediation));
    const confidence = readConfidenceValue(readPath(source, fields.confidence));
    if (confidence.state === "unreadable") {
      reportUnreadable(
        fields.confidence,
        confidence.raw,
        "not a number in [0,1]; the value is kept verbatim as the tool's own confidence but " +
          "does not replace the normalized one",
      );
    }
    const confidenceValue = confidence.state === "value" ? confidence.value : undefined;
    const confidenceOriginal =
      asString(readPath(source, fields.confidenceOriginal)) ??
      (confidence.state === "unreadable" ? confidence.raw : undefined);
    const heuristic = readFlagValue(readPath(source, fields.isHeuristic));
    if (heuristic.state === "unreadable") {
      reportUnreadable(fields.isHeuristic, heuristic.raw, "neither true nor false");
    }
    const ruleset = asString(readPath(source, fields.ruleset));
    const rulesetVersion = asString(readPath(source, fields.rulesetVersion));

    findings.push({
      filePath: normalizeToolPath(filePath),
      position,
      ruleId,
      message,
      originalSeverity: severity,
      ...(remediation === undefined ? {} : { remediationHint: remediation }),
      ...(confidenceValue === undefined ? {} : { confidenceValue }),
      ...(confidenceOriginal === undefined ? {} : { originalConfidence: confidenceOriginal }),
      ...(heuristic.state === "value" ? { isHeuristic: heuristic.value } : {}),
      ...(ruleset === undefined ? {} : { ruleset }),
      ...(rulesetVersion === undefined ? {} : { rulesetVersion }),
      rawLocation: entry.rawLocation,
    });
  }
  result.findings = findings;
  return result;
}

/**
 * Liest ein optionales Zahlenfeld und meldet den Verlust, wenn es DA ist,
 * aber nicht gelesen werden kann.
 */
function readOptional(
  raw: unknown,
  reader: (value: unknown) => FieldReadV1<number>,
  field: string,
  expectation: string,
  report: (field: string, raw: string, expectation: string) => void,
): number | undefined {
  const read = reader(raw);
  if (read.state === "unreadable") {
    report(field, read.raw, expectation);
    return undefined;
  }
  return read.state === "value" ? read.value : undefined;
}
