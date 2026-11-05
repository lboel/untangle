/**
 * Die fuenf Prosa-Masse (WP-217, vision.md §1c) — jedes an einem Dokument
 * nachgezaehlt, dessen Zahlen man von Hand nachrechnen kann.
 *
 * Und die eine Zusage, die keine Zahl ist: ohne Aufloeser bleibt
 * `unresolvedLinkRatio` `null`. „Niemand hat gesucht" darf nie wie „alle
 * Verweise sind heil" aussehen (vision.md §1d).
 */
import { describe, expect, it } from "vitest";

import { compareProseByStructureLoad, computeProseMetrics } from "./metrics.js";

const DOC = [
  "# Titel", // h1
  "Ein Satz.",
  "",
  "## A", // h2
  "Verweis auf [x](./x.md) und [y](./fehlt.md).",
  "Ein Satz.",
  "",
  "### A.1", // h3
  "Zeile.",
  "Zeile.",
  "Zeile.",
  "Zeile.",
  "",
].join("\n");

describe("computeProseMetrics", () => {
  it("misst Abschnittstiefe, Abschnittslaenge und Strukturlast", () => {
    const m = computeProseMetrics("doc.md", DOC);
    expect(m.sectionCount.value).toBe(3);
    expect(m.sectionDepth.value).toBe(3);
    // Strukturlast = 1 + 2 + 3.
    expect(m.structureLoad.value).toBe(6);
    // Der h3-Abschnitt reicht bis zum Dateiende: Zeilen 8..13.
    expect(m.maxSectionLines.value).toBe(6);
  });

  it("misst Verweisdichte je 100 Inhaltszeilen", () => {
    const m = computeProseMetrics("doc.md", DOC);
    expect(m.contentLines.value).toBe(10);
    expect(m.links).toHaveLength(2);
    expect(m.linkDensity.value).toBe(20);
  });

  it("misst Wiederholung woertlich gleicher Inhaltszeilen", () => {
    const m = computeProseMetrics("doc.md", DOC);
    // "Ein Satz." einmal wiederholt, "Zeile." dreimal -> 4 von 10.
    expect(m.repetitionRatio.value).toBe(0.4);
  });

  it("laesst unresolvedLinkRatio null, wenn niemand aufgeloest hat (vision.md §1d)", () => {
    const m = computeProseMetrics("doc.md", DOC);
    expect(m.unresolvedLinkRatio).toBeNull();
    for (const link of m.links) expect(link.resolved).toBeNull();
  });

  it("misst tote Verweise, sobald ein Aufloeser gestellt ist", () => {
    const m = computeProseMetrics("doc.md", DOC, {
      resolveLink: (_document, target) => target === "./x.md",
    });
    expect(m.unresolvedLinkRatio?.value).toBeCloseTo(0.5, 4);
    expect(m.unresolvedLinkRatio?.unit).toBe("ratio");
  });

  it("wertet einen reinen Anker nicht als toten Dateiverweis", () => {
    const m = computeProseMetrics("doc.md", "# T\n[a](#t)\n", { resolveLink: () => false });
    // Ein Anker ist gar kein Dateiverweis -> geht nicht in die Quote ein.
    expect(m.unresolvedLinkRatio).toBeNull();
  });

  it("liefert nur Prosa-Messwerte, nie blanke Zahlen", () => {
    const m = computeProseMetrics("doc.md", DOC);
    for (const key of [
      "sectionDepth",
      "maxSectionLines",
      "linkDensity",
      "repetitionRatio",
      "structureLoad",
      "sectionCount",
      "contentLines",
    ] as const) {
      expect(m[key], key).toMatchObject({ proseMeasurement: true });
    }
  });

  it("kommt mit einem leeren Dokument aus, ohne NaN zu erfinden", () => {
    const m = computeProseMetrics("leer.md", "");
    expect(m.sectionCount.value).toBe(0);
    expect(m.linkDensity.value).toBe(0);
    expect(m.repetitionRatio.value).toBe(0);
    expect(m.structureLoad.value).toBe(0);
  });

  it("ordnet nach Strukturlast, deterministisch auch bei Gleichstand", () => {
    const a = computeProseMetrics("a.md", "# X\n");
    const b = computeProseMetrics("b.md", "# X\n");
    const big = computeProseMetrics("c.md", DOC);
    expect([a, big, b].sort(compareProseByStructureLoad).map((m) => m.path)).toEqual([
      "c.md",
      "a.md",
      "b.md",
    ]);
  });

  it("ist bitgleich reproduzierbar", () => {
    expect(JSON.stringify(computeProseMetrics("doc.md", DOC))).toBe(
      JSON.stringify(computeProseMetrics("doc.md", DOC)),
    );
  });
});
