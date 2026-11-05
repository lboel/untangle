/**
 * Parser fuer JUnit-XML-Testberichte.
 *
 * JUnit-XML ist ein FORMAT, kein Werkzeug (X9): Dutzende Testlaeufer schreiben
 * es. Der Parser liest ausschliesslich die verbreitete Elementstruktur
 * (`testsuites` → `testsuite` → `testcase` → `failure`/`error`) und kennt
 * keinen einzigen Laeufer namentlich (E2).
 *
 * Die Struktur ist REKURSIV, und zwar in BEIDEN suitetragenden Elementen: das
 * Format erlaubt `testsuite` in `testsuite`, verbreitete Laeufer schreiben
 * daneben `testsuites` innerhalb einer Suite, und ein `testcase` kann direkt
 * unter `testsuites` haengen. Der Parser sucht deshalb an JEDER Stelle nach
 * beiden Elementnamen und liest die Testfaelle auch am Containerelement. Nur
 * die oberste Ebene oder nur einen der beiden Namen zu lesen hiesse, ganze
 * Aeste stillschweigend zu verlieren (E4).
 *
 * Abbildung auf Befunde:
 * - je `<failure>` bzw. `<error>` ein Rohbefund; `originalSeverity` ist der
 *   Elementname (`"failure"` / `"error"`), also ein Wert des Formats, kein
 *   geratener Untangle-Wert;
 * - `ruleId` ist das `type`-Attribut, sonst der Elementname — Testberichte
 *   kennen keine Regelkennung;
 * - bestandene und uebersprungene Testfaelle erzeugen keinen Befund. Das ist
 *   kein Ueberspringen im Sinne von E4: es gibt dort nichts zu melden.
 *   Ein FEHLSCHLAG ohne Dateiangabe dagegen ist ein verlorener Befund und
 *   wird als `no_location` gezaehlt und begruendet.
 * - fehlt oder taugt das `line`-Attribut nicht, wird der Befund am
 *   Dateianfang verankert UND die Position als nicht gemessen markiert
 *   ({@link RawPositionV1.lineUnknown}). Eine erfundene Zeile, die von einer
 *   belegten nicht zu unterscheiden ist, waere die schaedlichere Antwort.
 */
import { XMLParser } from "fast-xml-parser";

import { JUNIT_XML_PARSER_VERSION } from "../versions.js";

import type { FormatParseResultV1, RawFindingV1, RawPositionV1 } from "./types.js";
import { FormatParseError, emptyParseResult } from "./types.js";
import {
  describeRawValue,
  isRecord,
  normalizeToolPath,
  readLineValue,
  readString,
} from "./util.js";

const ATTRIBUTE_PREFIX = "@_";
const TEXT_NODE = "#text";

/** Elemente, die auch bei genau einem Vorkommen als Array gelesen werden. */
const ALWAYS_ARRAY = new Set(["testsuites", "testsuite", "testcase", "failure", "error"]);

/** Obergrenze der Schachtelungstiefe; schuetzt gegen entartete Dokumente. */
const MAX_SUITE_DEPTH = 64;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTRIBUTE_PREFIX,
  allowBooleanAttributes: true,
  // Attribute bleiben Strings: `line="007"` darf nicht zu 7 werden, bevor der
  // Parser selbst entschieden hat, was eine gueltige Zeilennummer ist.
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  textNodeName: TEXT_NODE,
  isArray: (name) => ALWAYS_ARRAY.has(name),
});

/** Liest ein Attribut als String. */
function attribute(node: unknown, name: string): string | undefined {
  return readString(node, `${ATTRIBUTE_PREFIX}${name}`);
}

/** Liest den Textinhalt eines Elements (bei Attributen unter `#text`). */
function textContent(node: unknown): string | undefined {
  if (typeof node === "string") {
    return node === "" ? undefined : node;
  }
  return readString(node, TEXT_NODE);
}

/**
 * Namen der Elemente, die Suiten tragen koennen. Beide sind rekursiv: das
 * Format erlaubt `testsuite` in `testsuite`, und mehrere verbreitete Laeufer
 * schreiben zusaetzlich `testsuites` INNERHALB einer Suite. Deshalb wird an
 * jeder Stelle nach beiden gesucht, nicht nur an der Dokumentwurzel.
 */
const SUITE_BEARING = ["testsuites", "testsuite"] as const;

/** Eine Suite samt ihrer Herkunft im Dokument. */
interface SuiteEntry {
  /** Das Element selbst. */
  readonly node: Record<string, unknown>;
  /** Zeiger auf die Stelle im Dokument, inklusive Schachtelung. */
  readonly pointer: string;
  /**
   * Naechstgelegenes `file`-Attribut auf dem Weg von der Wurzel hierher.
   * Eine innere Suite ohne eigenes `file` gehoert zur Datei ihrer aeusseren —
   * dieselbe Regel, nach der ein `testcase` auf seine Suite zurueckfaellt.
   */
  readonly inheritedFile: string | undefined;
}

/**
 * Sammelt ALLE suitetragenden Elemente, gleich wie tief und in welcher
 * Reihenfolge `testsuites` und `testsuite` einander enthalten.
 *
 * Auch das Containerelement `testsuites` wird als Suite gefuehrt: ein
 * `testcase` direkt darunter waere sonst ein stiller Totalverlust (E4).
 *
 * Meldet zugleich jedes Element, das an einer Suite-Stelle steht, aber keines
 * ist — auch ein solcher Ast waere sonst still verloren.
 */
function collectSuites(
  document: Record<string, unknown>,
  issues: FormatParseResultV1["issues"],
): { suites: SuiteEntry[]; sawSuiteElement: boolean } {
  const suites: SuiteEntry[] = [];
  /**
   * Ob ueberhaupt ein suitetragendes Element im Dokument stand — auch ein
   * leeres oder kaputtes. Nur wenn KEINES vorkam, ist der Text kein
   * JUnit-Bericht.
   */
  let sawSuiteElement = false;

  /**
   * Steigt in die suitetragenden Kinder von `node` ab. `pointer` zeigt auf
   * `node` selbst und ist an der Dokumentwurzel leer.
   */
  function descend(
    node: Record<string, unknown>,
    pointer: string,
    inherited: string | undefined,
    depth: number,
  ): void {
    for (const key of SUITE_BEARING) {
      const children = node[key];
      if (children === undefined) {
        continue;
      }
      if (!Array.isArray(children)) {
        issues.push({
          rawLocation: `${pointer}/${key}`,
          reason: "invalid_entry",
          detail: `${key} is ${describeRawValue(children)}, not an element`,
        });
        continue;
      }
      for (const [index, child] of children.entries()) {
        walk(child, `${pointer}/${key}[${String(index)}]`, key, inherited, depth);
      }
    }
  }

  /** Besucht ein einzelnes suitetragendes Element. */
  function walk(
    node: unknown,
    pointer: string,
    elementName: (typeof SUITE_BEARING)[number],
    inherited: string | undefined,
    depth: number,
  ): void {
    sawSuiteElement = true;
    if (node === "") {
      // `<testsuite/>` bzw. `<testsuites/>` ohne Inhalt und ohne Attribute:
      // ein leeres Element ist kein Fehler, es gibt dort nichts zu melden.
      return;
    }
    if (!isRecord(node)) {
      issues.push({
        rawLocation: pointer,
        reason: "invalid_entry",
        detail: `${elementName} is ${describeRawValue(node)}, not an element; its test cases cannot be read`,
      });
      return;
    }
    const file = attribute(node, "file") ?? inherited;
    suites.push({ node, pointer, inheritedFile: file });
    if (depth >= MAX_SUITE_DEPTH) {
      issues.push({
        rawLocation: pointer,
        reason: "invalid_entry",
        detail: `nested testsuites exceed the depth limit of ${String(MAX_SUITE_DEPTH)}; deeper suites were not read`,
      });
      return;
    }
    descend(node, pointer, file, depth + 1);
  }

  descend(document, "", undefined, 0);

  return { suites, sawSuiteElement };
}

/**
 * Liest einen JUnit-XML-Bericht.
 *
 * @throws {FormatParseError} wenn der Text kein XML ist oder weder
 * `<testsuites>` noch `<testsuite>` enthaelt.
 */
export function parseJUnitXml(text: string): FormatParseResultV1 {
  const result = emptyParseResult(JUNIT_XML_PARSER_VERSION);
  let document: unknown;
  try {
    document = xmlParser.parse(text) as unknown;
  } catch (cause) {
    throw new FormatParseError(
      JUNIT_XML_PARSER_VERSION,
      `JUnit output is not valid XML: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    );
  }
  if (!isRecord(document)) {
    throw new FormatParseError(JUNIT_XML_PARSER_VERSION, "JUnit output is not an XML document");
  }
  const { suites, sawSuiteElement } = collectSuites(document, result.issues);
  if (!sawSuiteElement) {
    throw new FormatParseError(
      JUNIT_XML_PARSER_VERSION,
      "JUnit output contains neither <testsuites> nor <testsuite>; this is not a JUnit report",
    );
  }
  // WP-199: Ab hier steht fest, dass ein JUnit-Bericht vorlag — auch ein
  // leerer. Diese Tatsache darf die Laufzeit nicht mehr verlieren.
  result.recognizedReport = true;

  const findings: RawFindingV1[] = [];
  for (const suite of suites) {
    const suiteFile = suite.inheritedFile;
    const rawCases = suite.node["testcase"];
    if (rawCases !== undefined && !Array.isArray(rawCases)) {
      result.issues.push({
        rawLocation: `${suite.pointer}/testcase`,
        reason: "invalid_entry",
        detail: `testcase is ${describeRawValue(rawCases)}, not an element`,
      });
    }
    const caseList: unknown[] = Array.isArray(rawCases) ? rawCases : [];
    for (const [caseIndex, testCase] of caseList.entries()) {
      const base = `${suite.pointer}/testcase[${String(caseIndex)}]`;
      result.entriesSeen += 1;
      if (!isRecord(testCase)) {
        result.issues.push({
          rawLocation: base,
          reason: "invalid_entry",
          detail: "testcase is not an element",
        });
        continue;
      }
      const caseName = attribute(testCase, "name") ?? "";
      const className = attribute(testCase, "classname");
      const filePath = attribute(testCase, "file") ?? suiteFile;
      const qualifiedName =
        className === undefined || className === "" ? caseName : `${className}.${caseName}`;
      const lineRead = readLineValue(attribute(testCase, "line"));
      if (lineRead.state === "unreadable") {
        result.issues.push({
          rawLocation: `${base}/@line`,
          reason: "unreadable_field",
          detail:
            `the line attribute of test "${qualifiedName}" is ${lineRead.raw}, not a 1-based ` +
            "integer; the finding is anchored at the start of the file and its line is not a measured one",
        });
      }
      const position: RawPositionV1 =
        lineRead.state === "value"
          ? { startLine: lineRead.value, endLine: lineRead.value }
          : { startLine: 1, endLine: 1, lineUnknown: true };

      for (const kind of ["failure", "error"] as const) {
        const entries = testCase[kind];
        if (entries === undefined) {
          continue;
        }
        if (!Array.isArray(entries)) {
          result.issues.push({
            rawLocation: `${base}/${kind}`,
            reason: "invalid_entry",
            detail: `${kind} is ${describeRawValue(entries)}, not an element`,
          });
          continue;
        }
        for (const [entryIndex, entry] of entries.entries()) {
          const rawLocation = `${base}/${kind}[${String(entryIndex)}]`;
          const message =
            attribute(entry, "message") ??
            textContent(entry) ??
            (caseName === "" ? kind : `${kind} in ${caseName}`);
          if (filePath === undefined) {
            result.issues.push({
              rawLocation,
              reason: "no_location",
              detail:
                `${kind} of test "${qualifiedName}" ` +
                "carries no file attribute; JUnit reports without file locations cannot be mapped to a file",
            });
            continue;
          }
          findings.push({
            filePath: normalizeToolPath(filePath),
            position,
            // Ein Testbericht kennt keine Regelkennung. Das `type`-Attribut ist
            // die naechstliegende ("AssertionError"); fehlt es, ist der
            // qualifizierte Testname die stabilste Kennung des Fehlschlags —
            // ihn fallen zu lassen waere Informationsverlust.
            ruleId: attribute(entry, "type") ?? (qualifiedName === "" ? kind : qualifiedName),
            message,
            originalSeverity: kind,
            rawLocation,
          });
        }
      }
    }
  }
  result.findings = findings;
  return result;
}
