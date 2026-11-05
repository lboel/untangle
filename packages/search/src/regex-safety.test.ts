import { describe, expect, it } from "vitest";

import { assertSafeGrepPattern, findUnsafeGrepPattern } from "./regex-safety.js";

/**
 * Regression zu Befund A2 der Nachpruefung (Welle 3b).
 *
 * Die erste Reparatur pruefte die Sternhoehe — einen SYNTAKTISCHEN
 * Stellvertreter. Sie traf den gezeigten Fall `(a+)+$` und liess die
 * naheliegenden Varianten derselben Familie durch, waehrend sie harmlose
 * Muster ablehnte. Die Tests hier fixieren beide Richtungen.
 */
describe("findUnsafeGrepPattern", () => {
  // Ohne die Reparatur lieferten genau diese Muster `undefined` (= sicher) und
  // liefen anschliessend unbegrenzt lange. Gemessen: mit SIGALRM nach 30 s
  // getoetet, ohne je zurueckzukehren.
  it.each([
    ["(a|a)+$", "identische Alternativen"],
    ["(\\s|\\t)+$", "Zeilenendleerraum — \\t liegt in \\s"],
    ["([a-z]+|[0-9]+)+$", "zwei unbegrenzte Alternativen"],
    ["(\\w+|\\d+)+$", "ueberlappende unbegrenzte Alternativen"],
    ["(\\w+a)+$", "der Anker am Ende liegt selbst in \\w"],
    ["(a\\w+)+$", "der Anker am Anfang liegt selbst in \\w"],
    ["(x|xx)+$", "kuerzerer Zweig ist Praefix des laengeren"],
    ["(a?)+$", "der Rumpf kann leer matchen"],
  ])("lehnt %s ab (%s)", (pattern) => {
    expect(findUnsafeGrepPattern(pattern)).toBeDefined();
  });

  // Diese Muster hat die erste Reparatur ABGELEHNT, obwohl ihre Auswertung
  // hoechstens polynomiell ist: der Pflichtteil am Ende der Wiederholung ist
  // ein Trennzeichen, das die Zerlegung eindeutig macht.
  it.each([
    ["(a+b)+", "b kann kein a sein"],
    ["(\\w+\\.)+", "der Punkt liegt nicht in \\w"],
    ["([A-Z][a-z]+)+", "Grossbuchstabe trennt die Wiederholungen"],
    ["(\\w+\\s+)+", "Leerraum trennt die Wiederholungen"],
    ["(?:(?!foo)\\w)+", "ein Lookaround verbraucht kein Zeichen"],
    ["(\\d{1,3}\\.){3}\\d{1,3}", "begrenzte Wiederholung mit Trennzeichen"],
  ])("laesst %s durch (%s)", (pattern) => {
    expect(findUnsafeGrepPattern(pattern)).toBeUndefined();
  });

  it("beruecksichtigt das i-Flag, weil es Zweige erst ueberlappen laesst", () => {
    expect(findUnsafeGrepPattern("(a|A)+$")).toBeUndefined();
    expect(findUnsafeGrepPattern("(a|A)+$", { caseInsensitive: true })).toBeDefined();
  });

  it("erfindet keinen Sicherheitsgrund fuer ein syntaktisch fehlerhaftes Muster", () => {
    // E4: die zutreffende Meldung dazu ist der Syntaxfehler aus `new RegExp`,
    // nicht eine erfundene Aussage ueber Backtracking.
    expect(findUnsafeGrepPattern("(a+")).toBeUndefined();
    expect(findUnsafeGrepPattern("[a-")).toBeUndefined();
  });

  it("nennt in der Ausnahme den Grund und den betroffenen Teilausdruck", () => {
    expect(() => assertSafeGrepPattern("(\\s|\\t)+$")).toThrow(
      /rejected as unsafe: two alternatives inside "\(\\s\|\\t\)\+" can match the same text/u,
    );
  });
});

/**
 * Der eigentliche Beweis: jedes Muster, das die Pruefung DURCHLAESST, kehrt
 * gegen boesartige Eingaben auch wirklich zurueck. Eine Klassifikation ohne
 * diesen Gegencheck waere nur eine Behauptung (E5).
 */
describe("angenommene Muster kehren gegen boesartige Eingaben zurueck", () => {
  const evilInputs = [
    "a".repeat(32) + "!",
    "\t".repeat(32) + "x",
    "ab".repeat(18) + "!",
    "x" + "1".repeat(32) + "!",
    " ".repeat(32) + "z",
  ];

  it.each([
    "\\s+$",
    "[ \\t]+$",
    "(foo|bar)+",
    "(ab|ac)+",
    "(a+b)+",
    "(\\w+\\.)+",
    "([A-Z][a-z]+)+",
    "(\\w+\\s+)+",
    "(ba+)+",
    "(\\d+-)+",
  ])("%s laeuft in unter 250 ms durch", (pattern) => {
    expect(findUnsafeGrepPattern(pattern)).toBeUndefined();
    const expression = new RegExp(pattern, "gu");
    const started = process.hrtime.bigint();
    for (const input of evilInputs) {
      expression.lastIndex = 0;
      expression.exec(input);
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(250);
  });
});
