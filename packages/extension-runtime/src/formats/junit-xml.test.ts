import { describe, expect, it } from "vitest";

import { readFixture } from "../test-support/fixtures.js";
import { JUNIT_XML_PARSER_VERSION } from "../versions.js";

import { parseJUnitXml } from "./junit-xml.js";
import { FormatParseError } from "./types.js";

const BASIC = readFixture("junit/basic.junit.xml");

describe("parseJUnitXml", () => {
  it("liest Fehlschlaege und Fehler aus einem echten JUnit-Bericht", () => {
    const result = parseJUnitXml(BASIC);

    expect(result.parserVersion).toBe(JUNIT_XML_PARSER_VERSION);
    // 6 Testfaelle; 2 failures + 1 error mit Datei, 1 failure ohne Datei.
    expect(result.entriesSeen).toBe(6);
    expect(result.findings).toHaveLength(3);
  });

  it("nimmt den Elementnamen als unveraenderte Severity des Formats", () => {
    const findings = parseJUnitXml(BASIC).findings;
    expect(findings.map((finding) => finding.originalSeverity)).toEqual([
      "failure",
      "failure",
      "error",
    ]);
  });

  it("liest Datei und Zeile aus den Attributen des Testfalls", () => {
    const [first] = parseJUnitXml(BASIC).findings;
    expect(first?.filePath).toBe("src/checkout/cart.ts");
    expect(first?.position).toEqual({ startLine: 42, endLine: 42 });
  });

  it("nimmt das type-Attribut als Regelkennung", () => {
    const findings = parseJUnitXml(BASIC).findings;
    expect(findings[0]?.ruleId).toBe("AssertionError");
    expect(findings[2]?.ruleId).toBe("NetworkError");
  });

  it("nimmt die Meldung aus dem Attribut, nicht aus dem Stacktrace", () => {
    const [first] = parseJUnitXml(BASIC).findings;
    expect(first?.message).toBe("expected 90 but received 100");
  });

  it("zaehlt einen Fehlschlag ohne Dateiangabe mit Grund, statt ihn zu verlieren", () => {
    const result = parseJUnitXml(BASIC);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.reason).toBe("no_location");
    expect(result.issues[0]?.detail).toContain("reporting.SummaryTest.renders the summary");
  });

  it("erzeugt fuer bestandene und uebersprungene Tests keinen Befund", () => {
    const findings = parseJUnitXml(BASIC).findings;
    expect(findings.some((finding) => finding.message.includes("not implemented"))).toBe(false);
  });

  it("liest auch einen Bericht mit <testsuite> als Wurzel", () => {
    const result = parseJUnitXml(readFixture("junit/single-suite.junit.xml"));
    expect(result.findings).toHaveLength(1);
    // Die Datei steht am Suite-Element und wird auf den Testfall vererbt.
    expect(result.findings[0]?.filePath).toBe("src/util/parse.ts");
    expect(result.findings[0]?.position.startLine).toBe(15);
    // Ohne `type`-Attribut ist der qualifizierte Testname die Kennung.
    expect(result.findings[0]?.ruleId).toBe("util.ParseTest.parses an empty string");
  });

  it("wirft, wenn der Text kein XML ist", () => {
    expect(() => parseJUnitXml("}{ not xml")).toThrow(FormatParseError);
  });

  it("wirft, wenn weder testsuites noch testsuite vorkommen", () => {
    expect(() => parseJUnitXml('<?xml version="1.0"?><results/>')).toThrow(
      /neither <testsuites> nor <testsuite>/,
    );
  });

  it("ist deterministisch", () => {
    expect(parseJUnitXml(BASIC)).toEqual(parseJUnitXml(BASIC));
  });
});
