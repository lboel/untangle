/**
 * Eine Regel fuer eine Frage — und fuer Prosa eine andere Antwort.
 *
 * Bis Welle 13 gab es die Minified-Frage an ZWEI Orten mit VERSCHIEDENEN
 * Schwellen: der Scanner entschied bei 500 Zeichen Einzelzeile auf einer
 * 8-KB-Stichprobe, der Chunker bei 1000 auf dem ganzen Inhalt. Welche Regel
 * griff, hing davon ab, ob eine Datei ueber den Index- oder den Watch-Pfad
 * kam — dieselbe Datei konnte also beides sein.
 *
 * Der zweite Fehler war inhaltlich: die Einzelzeilenregel ist fuer Prosa
 * falsch. Eine lange Markdown-Tabellenzeile ist normal, keine Minifizierung.
 * Vier der wichtigsten Dokumente dieses Repositoriums — README, Bauplan,
 * Paritaetsmatrix, Domain-README — lagen deshalb als strukturlose Bytefenster
 * im Index, und eine beantwortbare Frage nach den unveraenderlichen
 * Entscheidungen bekam Schweigen.
 *
 * Ob eine Datei betroffen war, entschied ausserdem die Stichprobenlage: die
 * erste lange Zeile musste zufaellig in die ersten 8 KB fallen. `PARITY.md`
 * war mit 314 Bytes Abstand betroffen, `product.md` mit gleicher Struktur
 * nicht.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_MINIFIED_RULE, isMinifiedShape } from "./minified-rule.js";

/** Eine minifizierte Bundle-Datei: eine sehr lange Zeile, hoher Durchschnitt. */
const BUNDLE = { maxLineLength: 240_000, averageLineLength: 60_000 };
/** Gewoehnlicher Quelltext. */
const SOURCE = { maxLineLength: 118, averageLineLength: 31 };
/** Der Bauplan dieses Repositoriums, wirklich gemessen. */
const BUILD_PLAN = { maxLineLength: 1401, averageLineLength: 116 };
/** Die Paritaetsmatrix, wirklich gemessen — der haerteste Prosafall. */
const PARITY = { maxLineLength: 2384, averageLineLength: 258 };

describe("isMinifiedShape — Code", () => {
  it("erkennt ein Bundle", () => {
    expect(isMinifiedShape(BUNDLE, { textFormat: null })).toBe(true);
  });

  it("laesst gewoehnlichen Quelltext in Ruhe", () => {
    expect(isMinifiedShape(SOURCE, { textFormat: null })).toBe(false);
  });

  it("bewahrt Methodenidentitaeten bei einer einzelnen langen Diagnosezeile in formatiertem Code", () => {
    expect(
      isMinifiedShape({ maxLineLength: 900, averageLineLength: 40 }, { textFormat: null }),
    ).toBe(false);
  });

  it("erkennt dichten Code weiterhin am Durchschnitt ohne eine Zeile ueber 500", () => {
    expect(
      isMinifiedShape({ maxLineLength: 350, averageLineLength: 350 }, { textFormat: null }),
    ).toBe(true);
  });
});

describe("isMinifiedShape — Prosa", () => {
  it("haelt eine lange Tabellenzeile NICHT fuer Minifizierung", () => {
    expect(isMinifiedShape(BUILD_PLAN, { textFormat: "prose" })).toBe(false);
    expect(isMinifiedShape(PARITY, { textFormat: "prose" })).toBe(false);
  });

  it("erkennt tatsaechlich minifizierte Prosa weiterhin am Durchschnitt", () => {
    // Eine Markdown-Datei ohne Zeilenumbrueche ueberhaupt: hoher Durchschnitt.
    expect(
      isMinifiedShape(
        { maxLineLength: 90_000, averageLineLength: 45_000 },
        { textFormat: "prose" },
      ),
    ).toBe(true);
  });

  it("behaelt die Einzelzeilenregel fuer strukturierte Daten", () => {
    expect(
      isMinifiedShape(
        { maxLineLength: 900, averageLineLength: 40 },
        { textFormat: "structured_data" },
      ),
    ).toBe(true);
  });
});

describe("dieselbe Regel an beiden Pfaden", () => {
  it("haelt genau eine Vorgabe bereit, nicht zwei", () => {
    expect(DEFAULT_MINIFIED_RULE).toEqual({
      maxLineLengthThreshold: 500,
      averageLineLengthThreshold: 300,
    });
  });

  it("laesst die Schwellen ueberschreiben, ohne die Prosaregel aufzuheben", () => {
    const strict = { maxLineLengthThreshold: 100, averageLineLengthThreshold: 300 };
    expect(isMinifiedShape(BUILD_PLAN, { textFormat: "prose" }, strict)).toBe(false);
    expect(isMinifiedShape(BUILD_PLAN, { textFormat: null }, strict)).toBe(false);
    expect(isMinifiedShape(BUILD_PLAN, { textFormat: "structured_data" }, strict)).toBe(true);
    expect(
      isMinifiedShape(SOURCE, { textFormat: null }, { ...strict, averageLineLengthThreshold: 30 }),
    ).toBe(true);
  });
});
