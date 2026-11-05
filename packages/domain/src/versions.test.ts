/**
 * WP-220: die Parserversion haengt an der Sprache, weil zwei Backends laufen.
 *
 * Die Pruefung ist klein, aber sie sichert die Stelle, an der ein stiller
 * Falschtreffer entstuende: gaebe `parserVersionForLanguage` fuer eine
 * ast-grep-Sprache dieselbe Version zurueck wie fuer TypeScript, lieferten die
 * inhaltsadressierten Caches (`analysis-cache-key.ts`) nach einem
 * Backendwechsel Werte der alten AST-Form — ohne Fehler, ohne Hinweis.
 */
import { describe, expect, it } from "vitest";

import { buildParseCacheKey } from "./analysis-cache-key.js";
import type { AnalysisIdentityKeyPartsV1 } from "./analysis-cache-key.js";
import {
  ASTGREP_PARSER_VERSION,
  VUE_SFC_PARSER_VERSION,
  knownParserLanguages,
  PARSER_BACKENDS,
  PARSER_VERSION,
  parserBackendForLanguage,
  parserVersionForLanguage,
} from "./versions.js";

function identityFor(languageId: string): AnalysisIdentityKeyPartsV1 {
  return {
    workspaceId: "ws",
    repoId: "repo",
    refId: "repo:main",
    fileId: "file",
    filePath: `a.${languageId}`,
    languageId,
  };
}

describe("parserVersionForLanguage", () => {
  it("gibt fuer die ast-grep-Sprachen eine eigene Version zurueck", () => {
    expect(parserVersionForLanguage("go")).toBe(ASTGREP_PARSER_VERSION);
    expect(parserVersionForLanguage("rust")).toBe(ASTGREP_PARSER_VERSION);
    // WP-239: Python ist vom handgeschriebenen Parser auf ast-grep gewechselt
    // und MUSS deshalb die andere Version bekommen. Stuende hier noch
    // `PARSER_VERSION`, lieferten die Caches aus WP-100 nach dem Wechsel
    // Chunk-IDs und Fingerabdruecke der alten AST-Form (E4).
    expect(parserVersionForLanguage("python")).toBe(ASTGREP_PARSER_VERSION);
    expect(ASTGREP_PARSER_VERSION).not.toBe(PARSER_VERSION);
  });

  it("laesst jede andere Sprache bei der bisherigen Version — bestehende Indizes bleiben gueltig", () => {
    for (const languageId of ["typescript", "javascript", "tsx", "jsx", "markdown"]) {
      expect(parserVersionForLanguage(languageId), languageId).toBe(PARSER_VERSION);
    }
    expect(parserVersionForLanguage("voellig-unbekannt")).toBe(PARSER_VERSION);
  });

  it("erzeugt damit verschiedene Cache-Schluessel fuer verschiedene Backends", () => {
    const goKey = buildParseCacheKey({
      contentHash: "sha256:same",
      parserVersion: parserVersionForLanguage("go"),
      identity: identityFor("go"),
    });
    const tsKey = buildParseCacheKey({
      contentHash: "sha256:same",
      parserVersion: parserVersionForLanguage("typescript"),
      identity: identityFor("typescript"),
    });
    expect(goKey).not.toBe(tsKey);
    expect(goKey.startsWith(`parse ${ASTGREP_PARSER_VERSION} `)).toBe(true);
  });
});

describe("parserBackendForLanguage", () => {
  it("nennt fuer jede bekannte Sprache genau ein Backend aus der geschlossenen Menge", () => {
    const languages = knownParserLanguages();
    expect(languages.length).toBeGreaterThan(0);
    for (const languageId of languages) {
      const backend = parserBackendForLanguage(languageId);
      expect(backend, languageId).not.toBeNull();
      expect(PARSER_BACKENDS, languageId).toContain(backend);
    }
  });

  it("gibt fuer eine unbekannte Sprache null zurueck statt eines geratenen Backends", () => {
    expect(parserBackendForLanguage("voellig-unbekannt")).toBeNull();
  });

  it("keeps backend and parser version bound for native and SFC adapters", () => {
    for (const languageId of knownParserLanguages()) {
      const expected =
        languageId === "vue"
          ? VUE_SFC_PARSER_VERSION
          : parserBackendForLanguage(languageId) === "ast-grep"
            ? ASTGREP_PARSER_VERSION
            : PARSER_VERSION;
      expect(parserVersionForLanguage(languageId), languageId).toBe(expected);
    }
  });
});
