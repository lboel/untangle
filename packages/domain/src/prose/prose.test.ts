/**
 * Die drei Zusagen der Prosa-Grundlage (vision.md §1c, WP-110/WP-217):
 * die Gliederung ist ueberschriftenbewusst, die Textklassifikation trifft
 * eine BEGRUENDETE Entscheidung je Format, und ein Prosa-Messwert kann
 * strukturell nicht in eine Code-Metrik geraten.
 */
import { describe, expect, it } from "vitest";

import { assertUntangleMetricNumber, makeExternalNumber } from "../types/extensions.js";
import { formatProseNumber, isProseNumber, makeProseNumber } from "../types/prose.js";

import {
  classifyLinkTarget,
  countContentLines,
  findMarkdownLinks,
  linkFilePath,
  normalizedContentLines,
} from "./markdown-links.js";
import { findMarkdownHeadings, outlineMarkdown } from "./markdown-outline.js";
import { classifyTextFormat, textFormatExtensions } from "./text-formats.js";

const DOC = [
  "Vorspann vor jeder Ueberschrift.",
  "",
  "# Titel",
  "Text unter dem Titel.",
  "",
  "## Erster Unterpunkt",
  "Siehe [spec](./spec.md) und [extern](https://example.invalid).",
  "",
  "```md",
  "# Das ist eine Ueberschrift IM Codeblock",
  "[kein Verweis](./nope.md)",
  "```",
  "",
  "### Tief",
  "Text unter dem Titel.",
  "",
  "## Erster Unterpunkt",
  "Doppelte Ueberschrift, absichtlich.",
];

describe("outlineMarkdown", () => {
  it("ignoriert Ueberschriften in eingezaeunten Codebloecken", () => {
    const headings = findMarkdownHeadings(DOC);
    expect(headings.map((h) => h.title)).toEqual([
      "Titel",
      "Erster Unterpunkt",
      "Tief",
      "Erster Unterpunkt",
    ]);
  });

  it("liefert eine lueckenlose, ueberlappungsfreie Partition mit Vorspann", () => {
    const sections = outlineMarkdown(DOC);
    expect(sections[0]).toMatchObject({ level: 0, startLine: 1, endLine: 2, breadcrumb: "" });
    let expectedStart = 1;
    for (const section of sections) {
      expect(section.startLine).toBe(expectedStart);
      expectedStart = section.endLine + 1;
    }
    expect(sections.at(-1)?.endLine).toBe(DOC.length);
  });

  it("traegt den Ueberschriftenpfad als Breadcrumb", () => {
    const sections = outlineMarkdown(DOC);
    expect(sections.map((s) => s.breadcrumb)).toEqual([
      "",
      "Titel",
      "Titel › Erster Unterpunkt",
      "Titel › Erster Unterpunkt › Tief",
      "Titel › Erster Unterpunkt",
    ]);
  });

  it("laesst einen leeren Vorspann weg statt einen leeren Abschnitt zu behaupten", () => {
    expect(outlineMarkdown(["# Sofort", "Text"])[0]).toMatchObject({ level: 1, startLine: 1 });
  });
});

describe("findMarkdownLinks", () => {
  it("erfasst Inline-Verweise, aber nichts aus einem Codeblock", () => {
    const links = findMarkdownLinks(DOC);
    expect(links.map((l) => l.target)).toEqual(["./spec.md", "https://example.invalid"]);
  });

  it("klassifiziert Ziele nach Aufloesbarkeit", () => {
    expect(classifyLinkTarget("./spec.md#7-1")).toBe("relative_file");
    expect(classifyLinkTarget("https://example.invalid")).toBe("absolute_url");
    expect(classifyLinkTarget("mailto:a@b.c")).toBe("absolute_url");
    expect(classifyLinkTarget("#abschnitt")).toBe("anchor");
    expect(classifyLinkTarget("")).toBe("other");
    expect(linkFilePath("./spec.md#7-1")).toBe("./spec.md");
    expect(linkFilePath("#nur-anker")).toBe("");
  });

  it("zaehlt Inhaltszeilen ohne Leerzeilen und ohne Codebloecke", () => {
    expect(countContentLines(DOC)).toBe(9);
  });

  it("normalisiert Zeilen fuer den Wiederholungsvergleich", () => {
    const normalized = normalizedContentLines(DOC);
    const repeated = normalized.filter((l, i) => normalized.indexOf(l) !== i);
    expect(repeated).toEqual(["text unter dem titel.", "## erster unterpunkt"]);
  });
});

describe("classifyTextFormat", () => {
  it("trennt Prosa, strukturierte Daten und Erzeugtes", () => {
    expect(classifyTextFormat("docs/adr/0001.md")).toBe("prose");
    expect(classifyTextFormat("NOTES.TXT")).toBe("prose");
    expect(classifyTextFormat("package.json")).toBe("structured_data");
    expect(classifyTextFormat("untangle.toml")).toBe("structured_data");
    expect(classifyTextFormat(".github/workflows/ci.yml")).toBe("structured_data");
    expect(classifyTextFormat("src/main.ts")).toBeNull();
  });

  it("erkennt Erzeugtes VOR dem Format — eine Lockdatei ist niemandes Text", () => {
    expect(classifyTextFormat("pnpm-lock.yaml")).toBe("generated");
    expect(classifyTextFormat("package-lock.json")).toBe("generated");
    expect(classifyTextFormat("sub/dir/Cargo.lock")).toBe("generated");
  });

  it("liefert Endungen deterministisch sortiert", () => {
    expect(textFormatExtensions("prose")).toEqual([".markdown", ".md", ".mdx", ".rst", ".txt"]);
  });
});

describe("Prosa-Messwerte sind eine eigene Familie (WP-217)", () => {
  it("ist ein Objekt mit Einheit, keine blanke Zahl", () => {
    const value = makeProseNumber(0.25, "ratio");
    expect(isProseNumber(value)).toBe(true);
    expect(isProseNumber(0.25)).toBe(false);
    expect(formatProseNumber(value)).toBe("25.0 %");
  });

  it("wird auf jedem Code-Metrikpfad abgewiesen — wie ein externer Befund", () => {
    expect(() => assertUntangleMetricNumber(makeProseNumber(3, "levels"), "cognitive")).toThrow(
      /prose metrics are their own family/,
    );
    expect(() => assertUntangleMetricNumber(makeExternalNumber(3), "cognitive")).toThrow(
      /external findings are evidence/,
    );
    expect(assertUntangleMetricNumber(3, "cognitive")).toBe(3);
  });

  it("lehnt nicht-endliche Werte ab statt NaN weiterzureichen", () => {
    expect(() => makeProseNumber(Number.NaN, "ratio")).toThrow(/finite/);
  });
});
