/**
 * Parser fuer SARIF 2.1.0 (OASIS „Static Analysis Results Interchange Format").
 *
 * SARIF ist ein FORMAT, kein Werkzeug (X9). Dieser Parser liest ausschliesslich
 * Felder, die die SARIF-Norm definiert; er kennt keinen Werkzeugnamen, keine
 * Regelkennung und keine Severity-Bedeutung eines bestimmten Werkzeugs. Welcher
 * Analysator die Datei erzeugt hat, steht in den Nutzerdaten
 * (`runs[].tool.driver.name`) und wird als Hinweis durchgereicht, nie als
 * Fallunterscheidung im Quelltext benutzt (E2).
 *
 * Toleranz (extensions.md §6.5): unbekannte Felder werden ignoriert, nie zum
 * Fehler. Was nicht gelesen werden kann, wird gezaehlt und begruendet (E4) —
 * gueltige Ergebnisse derselben Datei gehen dabei nicht verloren. Das gilt in
 * BEIDE Richtungen: ein kaputtes `run`-Element darf die uebrigen nicht
 * mitreissen, und es darf auch nicht spurlos verschwinden.
 */
import { SARIF_PARSER_VERSION } from "../versions.js";

import type {
  FormatParseIssueReason,
  FormatParseResultV1,
  RawFindingV1,
  RawPositionV1,
} from "./types.js";
import { FormatParseError, emptyParseResult } from "./types.js";
import {
  describeRawValue,
  isRecord,
  normalizeToolPath,
  readArray,
  readByteValue,
  readConfidenceValue,
  readFlagValue,
  readLineValue,
  readRecord,
  readString,
} from "./util.js";

/** Vom Parser gelesene SARIF-Fassung. */
export const SUPPORTED_SARIF_VERSION = "2.1.0";

/**
 * SARIF §3.27.10: fehlt `result.level` und liefert auch die Regel keinen
 * Vorgabewert, gilt `"warning"`. Das ist ein Wert der NORM, kein geratener
 * Untangle-Wert — deshalb darf er unveraendert in `originalSeverity`.
 */
const SARIF_DEFAULT_LEVEL = "warning";

interface RuleMetadata {
  readonly id: string;
  readonly defaultLevel: string | undefined;
  readonly helpText: string | undefined;
}

/** Liest `runs[].tool.driver.rules[]` als Nachschlagetabelle nach Index und ID. */
function collectRules(driver: Record<string, unknown> | undefined): {
  byIndex: RuleMetadata[];
  byId: Map<string, RuleMetadata>;
} {
  const byIndex: RuleMetadata[] = [];
  const byId = new Map<string, RuleMetadata>();
  for (const entry of readArray(driver, "rules") ?? []) {
    const id = readString(entry, "id") ?? "";
    const metadata: RuleMetadata = {
      id,
      defaultLevel: readString(readRecord(entry, "defaultConfiguration"), "level"),
      helpText:
        readString(readRecord(entry, "help"), "text") ??
        readString(readRecord(entry, "fullDescription"), "text"),
    };
    byIndex.push(metadata);
    if (id !== "") {
      byId.set(id, metadata);
    }
  }
  return { byIndex, byId };
}

/**
 * Uebersetzt eine SARIF-`region` (§3.30) in eine {@link RawPositionV1}.
 *
 * Liefert `undefined`, wenn die Region keine benutzbare Anfangsangabe traegt.
 * Ob das ein Fehler ist, entscheidet der Aufrufer: eine FEHLENDE Region
 * bedeutet nach der Norm „das ganze Artefakt", eine VORHANDENE ohne
 * benutzbaren Anfang ist eine kaputte Angabe.
 */
function readRegion(
  region: Record<string, unknown> | undefined,
  onIssue: (detail: string, reason?: FormatParseIssueReason) => void,
): RawPositionV1 | undefined {
  if (region === undefined) {
    return undefined;
  }
  const startLineRead = readLineValue(region["startLine"]);
  if (startLineRead.state === "unreadable") {
    onIssue(`region.startLine is ${startLineRead.raw}, not a 1-based integer line number`);
  }
  const byteOffsetRead = readByteValue(region["byteOffset"]);
  if (byteOffsetRead.state === "unreadable") {
    onIssue(`region.byteOffset is ${byteOffsetRead.raw}, not a non-negative integer`);
  }
  const startLine = startLineRead.state === "value" ? startLineRead.value : undefined;
  const byteOffset = byteOffsetRead.state === "value" ? byteOffsetRead.value : undefined;
  if (startLine === undefined && byteOffset === undefined) {
    return undefined;
  }
  const endLineRead = readLineValue(region["endLine"]);
  if (endLineRead.state === "unreadable") {
    onIssue(`region.endLine is ${endLineRead.raw}, not a 1-based integer line number`);
  }
  const endLine = endLineRead.state === "value" ? endLineRead.value : (startLine ?? 1);
  const startColumnRead = readLineValue(region["startColumn"]);
  if (startColumnRead.state === "unreadable") {
    onIssue(`region.startColumn is ${startColumnRead.raw}, not a 1-based integer column number`);
  }
  const endColumnRead = readLineValue(region["endColumn"]);
  if (endColumnRead.state === "unreadable") {
    onIssue(`region.endColumn is ${endColumnRead.raw}, not a 1-based integer column number`);
  }
  const byteLengthRead = readByteValue(region["byteLength"]);
  if (byteLengthRead.state === "unreadable") {
    onIssue(`region.byteLength is ${byteLengthRead.raw}, not a non-negative integer`);
  }
  if (startLine === undefined) {
    // WP-182: DIESER ZWEIG WAR TOT. Die Bedingung lautete
    // `startLine === undefined && byteOffset === undefined` — genau der Fall,
    // den die Funktion acht Zeilen weiter oben bereits mit `undefined`
    // verlassen hat. Eine Region mit AUSSCHLIESSLICH `byteOffset` bekam
    // deshalb die erfundene Zeile 1 ohne `lineUnknown`, ohne `issue` und ohne
    // Warnung: ein geratener Ort war von einem gemessenen nicht mehr zu
    // unterscheiden. Dass der Byte-Offset exakt ist, hilft nicht — die ZEILE
    // ist es nicht, und die Zeile ist es, die ausgegeben wird.
    onIssue(
      `region carries byteOffset ${String(byteOffset)} but no startLine; the line number 1 is a substitute, not a measurement`,
      "missing_required_field",
    );
  }
  return {
    startLine: startLine ?? 1,
    endLine: Math.max(endLine, startLine ?? 1),
    ...(startColumnRead.state === "value" ? { startColumn: startColumnRead.value } : {}),
    ...(endColumnRead.state === "value" ? { endColumn: endColumnRead.value } : {}),
    ...(byteOffset === undefined ? {} : { byteOffset }),
    ...(byteLengthRead.state === "value" ? { byteLength: byteLengthRead.value } : {}),
    ...(startLine === undefined ? { lineUnknown: true } : {}),
  };
}

/**
 * Liest einen SARIF-Log und liefert Rohbefunde je Fundstelle.
 *
 * Ein `result` mit mehreren `locations` erzeugt einen Rohbefund JE Fundstelle:
 * SARIF beschreibt damit mehrere betroffene Orte desselben Verstosses, und
 * jeder Ort ist eine eigene Datei-/Symbolzuordnung. Sie stillschweigend auf
 * die erste zu reduzieren waere ein Datenverlust (E4) — und genauso ist jede
 * NICHT uebernommene Fundstelle einzeln zu begruenden.
 *
 * @throws {FormatParseError} wenn die Gesamtausgabe kein JSON-Objekt mit
 * `runs`-Array ist — dann ist nicht ein Eintrag kaputt, sondern die Datei.
 */
export function parseSarif(text: string): FormatParseResultV1 {
  const result = emptyParseResult(SARIF_PARSER_VERSION);
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new FormatParseError(
      SARIF_PARSER_VERSION,
      `SARIF output is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
  const runs = readArray(document, "runs");
  if (runs === undefined) {
    throw new FormatParseError(
      SARIF_PARSER_VERSION,
      'SARIF output has no "runs" array; this is not a SARIF log',
    );
  }
  // WP-199: erkannter Bericht, auch wenn `runs` leer ist.
  result.recognizedReport = true;

  const version = readString(document, "version");
  if (version !== undefined && version !== SUPPORTED_SARIF_VERSION) {
    // Nicht abbrechen: spaetere Nebenversionen sind abwaertskompatibel lesbar.
    // Der Vermerk macht sichtbar, dass gelesen wurde, was nicht zugesichert ist.
    result.issues.push({
      rawLocation: "/version",
      reason: "unsupported_version",
      detail: `SARIF version "${version}" is not ${SUPPORTED_SARIF_VERSION}; parsed on a best-effort basis`,
    });
  }

  const findings: RawFindingV1[] = [];
  for (const [runIndex, run] of runs.entries()) {
    const runBase = `/runs/${String(runIndex)}`;
    if (!isRecord(run)) {
      // Ein kaputtes run-Element darf weder die Datei scheitern lassen noch
      // spurlos verschwinden: wie viele Ergebnisse darin standen, weiss
      // niemand mehr (E4, extensions.md §6.5).
      result.issues.push({
        rawLocation: runBase,
        reason: "invalid_entry",
        detail: `run is ${describeRawValue(run)}, not an object; its results cannot be read`,
      });
      continue;
    }
    const driver = readRecord(readRecord(run, "tool"), "driver");
    if (runIndex === 0) {
      const toolName = readString(driver, "name");
      const toolVersion = readString(driver, "version") ?? readString(driver, "semanticVersion");
      if (toolName !== undefined) {
        result.toolNameHint = toolName;
      }
      if (toolVersion !== undefined) {
        result.toolVersionHint = toolVersion;
      }
    }

    // SARIF §3.20: das Werkzeug berichtet ueber seinen eigenen Lauf. Sagt es
    // dort „nicht erfolgreich", ist die Ergebnisliste bestenfalls eine
    // Teilmenge — sie als vollstaendig zu behandeln waere die schaedlichste
    // Form von E4.
    readInvocations(run, runBase, result.issues);

    const rules = collectRules(driver);
    const rawResults = run["results"];
    if (rawResults !== undefined && !Array.isArray(rawResults)) {
      result.issues.push({
        rawLocation: `${runBase}/results`,
        reason: "invalid_entry",
        detail: `results is ${describeRawValue(rawResults)}, not an array; no result of this run could be read`,
      });
      continue;
    }
    const runResults: unknown[] = Array.isArray(rawResults) ? rawResults : [];
    for (const [resultIndex, sarifResult] of runResults.entries()) {
      const base = `${runBase}/results/${String(resultIndex)}`;
      result.entriesSeen += 1;
      if (!isRecord(sarifResult)) {
        result.issues.push({
          rawLocation: base,
          reason: "invalid_entry",
          detail: "result is not an object",
        });
        continue;
      }

      const ruleById = readString(sarifResult, "ruleId");
      // `ruleIndex` ist 0-basiert (SARIF §3.27.6) — deshalb `readByteValue`
      // und nicht die 1-basierte Zeilenlesung.
      const numericRuleIndex = readByteValue(sarifResult["ruleIndex"]);
      const ruleByIndex =
        numericRuleIndex.state === "value" ? rules.byIndex[numericRuleIndex.value] : undefined;
      if (numericRuleIndex.state === "unreadable") {
        result.issues.push({
          rawLocation: `${base}/ruleIndex`,
          reason: "unreadable_field",
          detail: `ruleIndex is ${numericRuleIndex.raw}, not a non-negative integer`,
        });
      } else if (numericRuleIndex.state === "value" && ruleByIndex === undefined) {
        result.issues.push({
          rawLocation: `${base}/ruleIndex`,
          reason: "unreadable_field",
          detail:
            `ruleIndex ${String(numericRuleIndex.value)} points past the end of ` +
            `tool.driver.rules (${String(rules.byIndex.length)} entries)`,
        });
      }
      const ruleId = ruleById ?? ruleByIndex?.id;
      if (ruleId === undefined || ruleId === "") {
        result.issues.push({
          rawLocation: base,
          reason: "missing_required_field",
          detail: "result has neither a resolvable ruleId nor a ruleIndex",
        });
        continue;
      }
      const rule = ruleByIndex ?? rules.byId.get(ruleId);

      const message = readString(readRecord(sarifResult, "message"), "text");
      if (message === undefined) {
        result.issues.push({
          rawLocation: base,
          reason: "missing_required_field",
          detail: `result for rule "${ruleId}" has no message.text`,
        });
        continue;
      }

      const rawLocations = sarifResult["locations"];
      if (rawLocations !== undefined && !Array.isArray(rawLocations)) {
        result.issues.push({
          rawLocation: `${base}/locations`,
          reason: "invalid_entry",
          detail: `locations is ${describeRawValue(rawLocations)}, not an array`,
        });
      }
      const locations: unknown[] = Array.isArray(rawLocations) ? rawLocations : [];
      const originalSeverity =
        readString(sarifResult, "level") ?? rule?.defaultLevel ?? SARIF_DEFAULT_LEVEL;
      const helpText = rule?.helpText;
      const properties = readRecord(sarifResult, "properties");

      const confidence = readConfidenceValue(properties?.["confidence"]);
      if (confidence.state === "unreadable") {
        result.issues.push({
          rawLocation: `${base}/properties/confidence`,
          reason: "unreadable_field",
          detail:
            `properties.confidence is ${confidence.raw}, not a number in [0,1]; the value is kept ` +
            "verbatim as the tool's own confidence but does not replace the normalized one",
        });
      }
      const heuristic = readFlagValue(properties?.["isHeuristic"]);
      if (heuristic.state === "unreadable") {
        result.issues.push({
          rawLocation: `${base}/properties/isHeuristic`,
          reason: "unreadable_field",
          detail: `properties.isHeuristic is ${heuristic.raw}, neither true nor false`,
        });
      }
      const originalConfidence = confidence.state === "unreadable" ? confidence.raw : undefined;

      let emitted = 0;
      for (const [locationIndex, location] of locations.entries()) {
        const locationPointer = `${base}/locations/${String(locationIndex)}`;
        if (!isRecord(location)) {
          result.issues.push({
            rawLocation: locationPointer,
            reason: "invalid_entry",
            detail: `location is ${describeRawValue(location)}, not an object`,
          });
          continue;
        }
        const physical = readRecord(location, "physicalLocation");
        const uri = readString(readRecord(physical, "artifactLocation"), "uri");
        if (uri === undefined) {
          // Rein logische Fundstellen (§3.28.3 `logicalLocations`) und
          // Adressangaben (§3.28.4 `address`) kennen keine Datei. Untangle
          // haengt jeden Befund an eine Datei — der Ort ginge sonst verloren,
          // also wird er hier gezaehlt und begruendet statt geraten.
          const logical = readArray(location, "logicalLocations");
          result.issues.push({
            rawLocation: locationPointer,
            reason: "no_location",
            detail:
              `location of rule "${ruleId}" carries no physicalLocation.artifactLocation.uri` +
              (logical === undefined
                ? ""
                : `; it names only ${String(logical.length)} logical location(s), which cannot be mapped to a file`),
          });
          continue;
        }
        const regionIssues: { detail: string; reason: FormatParseIssueReason }[] = [];
        const region = readRecord(physical, "region");
        const position = readRegion(region, (detail, reason) =>
          regionIssues.push({ detail, reason: reason ?? "unreadable_field" }),
        );
        for (const issue of regionIssues) {
          result.issues.push({
            rawLocation: `${locationPointer}/physicalLocation/region`,
            reason: issue.reason,
            detail: issue.detail,
          });
        }
        const effectivePosition: RawPositionV1 = position ?? {
          startLine: 1,
          endLine: 1,
          lineUnknown: true,
        };
        if (position === undefined && region !== undefined && regionIssues.length === 0) {
          result.issues.push({
            rawLocation: `${locationPointer}/physicalLocation/region`,
            reason: "unreadable_field",
            detail:
              `region of rule "${ruleId}" in "${uri}" carries neither startLine nor byteOffset; ` +
              "the finding is anchored at the start of the file and its line is not a measured one",
          });
        }
        findings.push({
          filePath: normalizeToolPath(uri),
          position: effectivePosition,
          ruleId,
          message,
          originalSeverity,
          ...(helpText === undefined ? {} : { remediationHint: helpText }),
          ...(confidence.state === "value" ? { confidenceValue: confidence.value } : {}),
          ...(originalConfidence === undefined ? {} : { originalConfidence }),
          ...(heuristic.state === "value" ? { isHeuristic: heuristic.value } : {}),
          rawLocation: locationPointer,
        });
        emitted += 1;
      }
      if (emitted === 0 && locations.length === 0) {
        result.issues.push({
          rawLocation: base,
          reason: "no_location",
          detail: `result for rule "${ruleId}" carries no locations at all`,
        });
      }
    }
  }
  result.findings = findings;
  return result;
}

/**
 * Liest `runs[].invocations[]` (SARIF §3.20) und meldet, was das Werkzeug
 * ueber SEINEN EIGENEN Lauf sagt.
 *
 * `executionSuccessful` ist in der Norm ein Pflichtfeld des `invocation`-
 * Objekts. Steht dort `false`, hat das Werkzeug abgebrochen — die
 * Ergebnisliste ist dann unvollstaendig, auch wenn sie syntaktisch einwandfrei
 * ist. Ohne diese Meldung saehe ein abgebrochener Lauf wie ein sauberer aus.
 */
function readInvocations(
  run: Record<string, unknown>,
  runBase: string,
  issues: FormatParseResultV1["issues"],
): void {
  const invocations = readArray(run, "invocations");
  if (invocations === undefined) {
    return;
  }
  for (const [index, invocation] of invocations.entries()) {
    const pointer = `${runBase}/invocations/${String(index)}`;
    if (!isRecord(invocation)) {
      issues.push({
        rawLocation: pointer,
        reason: "invalid_entry",
        detail: `invocation is ${describeRawValue(invocation)}, not an object`,
      });
      continue;
    }
    const successful = readFlagValue(invocation["executionSuccessful"]);
    if (successful.state === "unreadable") {
      issues.push({
        rawLocation: `${pointer}/executionSuccessful`,
        reason: "unreadable_field",
        detail: `executionSuccessful is ${successful.raw}, neither true nor false`,
      });
    } else if (successful.state === "value" && !successful.value) {
      const exitCode = invocation["exitCode"];
      issues.push({
        rawLocation: pointer,
        reason: "tool_reported_failure",
        detail:
          "the tool reports executionSuccessful=false for this run; its results are at best a " +
          `partial set${exitCode === undefined ? "" : ` (exitCode ${describeRawValue(exitCode)})`}`,
      });
    }
    for (const key of ["toolExecutionNotifications", "toolConfigurationNotifications"] as const) {
      for (const [noteIndex, note] of (readArray(invocation, key) ?? []).entries()) {
        if (readString(note, "level") !== "error") {
          continue;
        }
        issues.push({
          rawLocation: `${pointer}/${key}/${String(noteIndex)}`,
          reason: "tool_reported_failure",
          detail:
            `the tool reports an error-level notification: ` +
            `${readString(readRecord(note, "message"), "text") ?? "(no message text)"}`,
        });
      }
    }
  }
}
