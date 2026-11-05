/**
 * Regressionstests zu den Befunden der Welle 3 am JUnit-XML-Parser.
 *
 * Gepruefte Zusicherungen: verschachtelte Suiten gehen nicht verloren (E4),
 * und eine fehlende Zeilenangabe wird als solche kenntlich gemacht statt als
 * Zeile 1 erfunden.
 */
import { describe, expect, it } from "vitest";

import { parseJUnitXml } from "./junit-xml.js";

const NESTED = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="outer" file="src/outer.ts">
    <testsuite name="inner" file="src/inner.ts">
      <testcase classname="I" name="t0" line="7"><failure message="inner failed"/></testcase>
      <testcase classname="I" name="t1" line="9"><error message="inner errored"/></testcase>
    </testsuite>
    <testsuite name="deep">
      <testcase classname="D" name="t0" line="3"><failure message="deep failed"/></testcase>
    </testsuite>
    <testcase classname="O" name="t0" line="1"><failure message="outer failed"/></testcase>
  </testsuite>
</testsuites>`;

describe("parseJUnitXml — verschachtelte testsuite-Elemente (Befund 3)", () => {
  const parsed = parseJUnitXml(NESTED);

  it("besucht auch Suiten innerhalb von Suiten", () => {
    expect(parsed.findings.map((finding) => finding.message)).toEqual([
      "outer failed",
      "inner failed",
      "inner errored",
      "deep failed",
    ]);
  });

  it("zaehlt jeden besuchten Testfall, nicht nur die der obersten Ebene", () => {
    expect(parsed.entriesSeen).toBe(4);
    expect(parsed.issues).toEqual([]);
  });

  it("vererbt das file-Attribut der aeusseren Suite an eine innere ohne eigenes", () => {
    const deep = parsed.findings.find((finding) => finding.message === "deep failed");
    expect(deep?.filePath).toBe("src/outer.ts");
    const inner = parsed.findings.find((finding) => finding.message === "inner failed");
    expect(inner?.filePath).toBe("src/inner.ts");
  });

  it("zeigt die Schachtelung im Zeiger auf die Rohausgabe", () => {
    const inner = parsed.findings.find((finding) => finding.message === "inner failed");
    expect(inner?.rawLocation).toBe(
      "/testsuites[0]/testsuite[0]/testsuite[0]/testcase[0]/failure[0]",
    );
  });
});

describe("parseJUnitXml — unbrauchbares line-Attribut (Befund 7)", () => {
  const parsed = parseJUnitXml(`<?xml version="1.0"?>
<testsuite name="s" file="src/s.ts">
  <testcase classname="C" name="a" line="nicht-eine-zahl"><failure message="m1"/></testcase>
  <testcase classname="C" name="b"><failure message="m2"/></testcase>
  <testcase classname="C" name="c" line="12"><failure message="m3"/></testcase>
</testsuite>`);

  it("markiert eine nicht gemessene Zeile, statt sie wie eine gemessene aussehen zu lassen", () => {
    expect(parsed.findings.map((finding) => finding.position)).toEqual([
      { startLine: 1, endLine: 1, lineUnknown: true },
      { startLine: 1, endLine: 1, lineUnknown: true },
      { startLine: 12, endLine: 12 },
    ]);
  });

  it("meldet ein VORHANDENES, aber unlesbares line-Attribut (E4)", () => {
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]?.reason).toBe("unreadable_field");
    expect(parsed.issues[0]?.rawLocation).toBe("/testsuite[0]/testcase[0]/@line");
    expect(parsed.issues[0]?.detail).toContain("nicht-eine-zahl");
  });
});

describe("parseJUnitXml — strukturell kaputte Suiten", () => {
  it("meldet ein Element an Suite-Stelle, das keines ist, statt den Ast zu verlieren", () => {
    const parsed = parseJUnitXml(`<?xml version="1.0"?>
<testsuites>
  <testsuite name="ok" file="src/a.ts">
    <testcase classname="C" name="a" line="2"><failure message="m"/></testcase>
  </testsuite>
  <testsuite>kein Element</testsuite>
</testsuites>`);
    expect(parsed.findings).toHaveLength(1);
    const issue = parsed.issues.find((entry) => entry.reason === "invalid_entry");
    expect(issue?.rawLocation).toBe("/testsuites[0]/testsuite[1]");
    expect(issue?.detail).toContain("not an element");
  });

  it("behandelt eine leere Suite als leer, nicht als kaputt", () => {
    const parsed = parseJUnitXml(`<?xml version="1.0"?>
<testsuites><testsuite/></testsuites>`);
    expect(parsed.findings).toEqual([]);
    expect(parsed.issues).toEqual([]);
  });
});

describe("parseJUnitXml — <testsuites> unterhalb der Wurzel (Befund A1/B1)", () => {
  const NESTED_CONTAINER = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="a" file="src/a.ts">
    <testsuites>
      <testsuite name="b" file="src/b.ts">
        <testcase classname="B" name="t" line="5"><failure message="verloren?"/></testcase>
      </testsuite>
      <testsuite name="c">
        <testcase classname="C" name="t"><error message="auch verloren?"/></testcase>
      </testsuite>
    </testsuites>
  </testsuite>
</testsuites>`;

  it("steigt in ein testsuites-Element ab, das INNERHALB einer Suite steht", () => {
    const parsed = parseJUnitXml(NESTED_CONTAINER);
    expect(parsed.findings.map((finding) => finding.message)).toEqual([
      "verloren?",
      "auch verloren?",
    ]);
    expect(parsed.entriesSeen).toBe(2);
    expect(parsed.issues).toEqual([]);
  });

  it("zeigt das innere testsuites im Zeiger auf die Rohausgabe", () => {
    const [first] = parseJUnitXml(NESTED_CONTAINER).findings;
    expect(first?.rawLocation).toBe(
      "/testsuites[0]/testsuite[0]/testsuites[0]/testsuite[0]/testcase[0]/failure[0]",
    );
  });

  it("vererbt das file-Attribut ueber das innere testsuites hinweg", () => {
    const parsed = parseJUnitXml(NESTED_CONTAINER);
    const inherited = parsed.findings.find((finding) => finding.message === "auch verloren?");
    // Suite "c" hat kein eigenes file; die aeussere Suite "a" ist zustaendig.
    expect(inherited?.filePath).toBe("src/a.ts");
  });

  it("liest einen Testfall, der direkt unter testsuites haengt", () => {
    const parsed = parseJUnitXml(`<?xml version="1.0"?>
<testsuites>
  <testcase name="orphan" file="src/o.ts" line="3"><failure message="orphan failed"/></testcase>
  <testsuite name="s" file="src/s.ts">
    <testcase name="regular"><failure message="regular failed"/></testcase>
  </testsuite>
</testsuites>`);
    expect(parsed.entriesSeen).toBe(2);
    expect(parsed.findings.map((finding) => [finding.filePath, finding.rawLocation])).toEqual([
      ["src/o.ts", "/testsuites[0]/testcase[0]/failure[0]"],
      ["src/s.ts", "/testsuites[0]/testsuite[0]/testcase[0]/failure[0]"],
    ]);
    expect(parsed.issues).toEqual([]);
  });

  it("meldet ein kaputtes testsuites-Element an Suite-Stelle, statt den Ast zu verlieren", () => {
    const parsed = parseJUnitXml(`<?xml version="1.0"?>
<testsuites>
  <testsuite name="a" file="src/a.ts">
    <testsuites>kein Element</testsuites>
  </testsuite>
</testsuites>`);
    const issue = parsed.issues.find((entry) => entry.reason === "invalid_entry");
    expect(issue?.rawLocation).toBe("/testsuites[0]/testsuite[0]/testsuites[0]");
    expect(issue?.detail).toContain("not an element");
  });

  it("haelt die Tiefengrenze auch ueber abwechselnde testsuites/testsuite ein", () => {
    const open = "<testsuites><testsuite>".repeat(40);
    const close = "</testsuite></testsuites>".repeat(40);
    const parsed = parseJUnitXml(`<?xml version="1.0"?><testsuites>${open}${close}</testsuites>`);
    const issue = parsed.issues.find((entry) => entry.detail.includes("depth limit"));
    expect(issue?.reason).toBe("invalid_entry");
  });
});

describe("parseJUnitXml — leeres Containerelement", () => {
  it("haelt <testsuites></testsuites> fuer einen leeren, gueltigen Bericht", () => {
    // Folge derselben Regel: ein gesehenes suitetragendes Element zaehlt, auch
    // ein leeres. Vorher warf der Parser hier mit der Begruendung, das
    // Dokument enthalte kein <testsuites> — es enthaelt genau das.
    const parsed = parseJUnitXml(`<?xml version="1.0"?><testsuites></testsuites>`);
    expect(parsed.findings).toEqual([]);
    expect(parsed.issues).toEqual([]);
    expect(parsed.entriesSeen).toBe(0);
  });
});
