/**
 * WP-240/WP-246: `doctor` darf keine Sprache versprechen, die es hier nicht
 * gibt — und die Sprachliste an der Vertragsgrenze muss stimmen.
 *
 * DREI PRUEFUNGEN, drei verschiedene Sorten Beleg:
 *
 *  1. GEGEN DIE ECHTE REGISTRY: jede registrierte Sprache hat in
 *     `@untangle-code/domain` ein Backend, und jede Sprache der Tabelle ist
 *     registriert. Das ist die Pruefung, auf die sich der Kommentar in
 *     `packages/domain/src/versions.ts` beruft; ohne sie waere die Tabelle
 *     eine Behauptung, die still veraltet.
 *  2. GEGEN DIE ECHTE MASCHINE: `probeAllLanguageSupport` laedt jede
 *     Grammatik wirklich. Auf einer Maschine mit vollstaendigen Prebuilds
 *     muessen alle achtzehn verfuegbar sein — und die gemessene Stufe muss
 *     dann mit der behaupteten uebereinstimmen.
 *  3. GEGEN EINE MASCHINE OHNE GRAMMATIK: hier wird der Ausfall
 *     UNTERGESCHOBEN, weil das Umbenennen eines Sprachpakets im Repo den
 *     Rest der Testreihe beschaedigen wuerde. Der Beweis, dass derselbe Weg
 *     auch mit einem WIRKLICH fehlenden Paket haelt, steht im
 *     Abnahmeprotokoll dieser Welle: dort wurde `@ast-grep/lang-kotlin` in
 *     einer Kopie des Baums umbenannt.
 */
import type { LanguageAdapter, ParserRegistry, SupportLevel } from "@untangle-code/domain";
import {
  AdapterParseError,
  knownParserLanguages,
  parserBackendForLanguage,
} from "@untangle-code/domain";
import { createParserRegistry } from "@untangle-code/parser-registry";
import { describe, expect, it } from "vitest";

import { probeAllLanguageSupport, type LanguageSupportV1 } from "../cli/language-support.js";

import { checkLanguages, type LanguageProbeSource } from "./doctor.languages.js";

/** Ein Adapter, dessen Grammatik fehlt — genau der Fall aus WP-240. */
function brokenAdapter(languageId: string, moduleName: string): LanguageAdapter {
  return {
    languageId,
    extensions: [`.${languageId}`],
    supportLevel: "deep",
    parse() {
      throw new AdapterParseError(
        "grammar_unavailable",
        `Sprache "${languageId}" ist nicht verfuegbar: Paket "${moduleName}" nicht ladbar oder ` +
          `ohne gebauten Parser fuer linux/x64: Cannot find module '${moduleName}'`,
      );
    },
    extractChunks: () => [],
    extractSymbols: () => [],
    extractImports: () => [],
    extractCalls: () => [],
    computeComplexity: () => {
      throw new Error("nicht erreichbar");
    },
    tokenizeForHalstead: () => {
      throw new Error("nicht erreichbar");
    },
  } as unknown as LanguageAdapter;
}

function workingAdapter(languageId: string, supportLevel: SupportLevel): LanguageAdapter {
  return {
    languageId,
    extensions: [`.${languageId}`],
    supportLevel,
    parse: () => ({ parseQuality: "complete", ast: null, diagnostics: [] }),
    extractChunks: () => [],
    extractSymbols: () => [],
    extractImports: () => [],
    extractCalls: () => [],
    computeComplexity: () => ({}),
    tokenizeForHalstead: () => ({}),
  } as unknown as LanguageAdapter;
}

function registryOf(adapters: LanguageAdapter[]): ParserRegistry {
  return {
    listAdapters: () => adapters,
    getAdapterByLanguage: (languageId) =>
      adapters.find((adapter) => adapter.languageId === languageId) ?? null,
    getAdapterForPath: () => null,
    supportLevelOf: (languageId) =>
      adapters.find((adapter) => adapter.languageId === languageId)?.supportLevel ?? null,
  };
}

function sourceOf(adapters: LanguageAdapter[], astGrepUnavailable: string[]): LanguageProbeSource {
  const registry = registryOf(adapters);
  return {
    measure: () => probeAllLanguageSupport(registry),
    astGrepUnavailable: () => astGrepUnavailable,
  };
}

describe("Sprachliste an der Vertragsgrenze (WP-240)", () => {
  it("kennt fuer jede registrierte Sprache ein Backend — und kennt keine Sprache, die es nicht gibt", () => {
    const registered = createParserRegistry()
      .listAdapters()
      .map((adapter) => adapter.languageId)
      .sort();
    const declared = [...knownParserLanguages()].sort();

    expect(registered).toEqual(declared);
    for (const languageId of registered) {
      expect(parserBackendForLanguage(languageId), languageId).not.toBeNull();
    }
  });
});

describe("probeAllLanguageSupport gegen die echte Maschine", () => {
  it("misst jede Sprache, statt ihre Tabelle zu wiederholen", () => {
    const measured = probeAllLanguageSupport(createParserRegistry());
    expect(measured.length).toBe(knownParserLanguages().length);

    const unavailable = measured.filter((entry) => !entry.available);
    // Diese Maschine hat alle Prebuilds. Faellt diese Erwartung irgendwo,
    // sagt sie genau das, was WP-240 sichtbar machen soll — deshalb steht der
    // Grund in der Meldung.
    expect(
      unavailable.map((entry) => `${entry.languageId}: ${entry.reason ?? "no reason given"}`),
    ).toEqual([]);
    for (const entry of measured) {
      expect(entry.effectiveSupportLevel, entry.languageId).toBe(entry.declaredSupportLevel);
    }
  });

  it("stuft eine Sprache ohne Grammatik auf 'text' herab, statt 'deep' zu behaupten", () => {
    const measured = probeAllLanguageSupport(
      registryOf([
        workingAdapter("typescript", "deep"),
        brokenAdapter("kotlin", "@ast-grep/lang-kotlin"),
      ]),
    );
    const kotlin = measured.find((entry) => entry.languageId === "kotlin") as LanguageSupportV1;

    expect(kotlin.available).toBe(false);
    expect(kotlin.declaredSupportLevel).toBe("deep");
    expect(kotlin.effectiveSupportLevel).toBe("text");
    expect(kotlin.failureKind).toBe("grammar_unavailable");
    expect(kotlin.reason).toContain("@ast-grep/lang-kotlin");
    expect(kotlin.nextStep).toContain("tree-sitter-cli");
  });
});

describe("checkLanguages", () => {
  it("besteht, wenn jede Grammatik laedt, und nennt je Sprache Backend und Stufe", async () => {
    // Der VOLLE Sprachsatz, aber mit Attrappen: so haengt dieser Test nicht
    // an den Prebuilds der Maschine (das prueft der Test darueber), sondern
    // nur daran, dass ein vollstaendiger, ladbarer Satz als "ok" durchgeht.
    const all = createParserRegistry()
      .listAdapters()
      .map((adapter) => workingAdapter(adapter.languageId, adapter.supportLevel));
    const check = await checkLanguages(sourceOf(all, []));

    expect(check.status).toBe("ok");
    expect(check.facts?.["sprache:typescript"]).toBe("tree-sitter · deep · available");
    expect(check.facts?.["sprache:markdown"]).toBe("handwritten · text · available");
    expect(check.facts?.["astgrep:nichtVerfuegbar"]).toBe("(none)");
  });

  it("faellt durch, wenn eine Grammatik fehlt — mit Grund, Folge und genau einem Schritt", async () => {
    const check = await checkLanguages(
      sourceOf(
        [workingAdapter("typescript", "deep"), brokenAdapter("kotlin", "@ast-grep/lang-kotlin")],
        ["kotlin"],
      ),
    );

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("kotlin (grammar_unavailable)");
    expect(check.detail).toContain("@ast-grep/lang-kotlin");
    expect(check.detail).toContain("line windows");
    expect(check.facts?.["sprache:kotlin"]).toBe(
      "ast-grep · claimed deep, measured text · unavailable (grammar_unavailable)",
    );
    expect(check.facts?.["astgrep:nichtVerfuegbar"]).toBe("kotlin");
    expect(check.nextStep).toContain("npm install --no-save tree-sitter-cli && npm rebuild");
    // GENAU EIN Schritt: keine Aufzaehlung, keine Alternative.
    expect(check.nextStep?.split("`").length).toBe(3);
  });

  it("meldet eine registrierte Sprache ohne Backendzuordnung als Fehlschlag", async () => {
    const check = await checkLanguages(sourceOf([workingAdapter("brainfuck", "deep")], []));

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("brainfuck is registered");
    expect(check.detail).toContain("no backend mapping");
    expect(check.facts?.["sprache:brainfuck"]).toContain("NO BACKEND MAPPING");
  });

  it("meldet auch die Gegenrichtung: in domain gefuehrt, aber nicht registriert", async () => {
    const check = await checkLanguages(sourceOf([workingAdapter("typescript", "deep")], []));

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("is listed in @untangle-code/domain but is not registered");
    expect(check.detail).toContain("kotlin");
  });

  it("verschweigt den zweiten Befund nicht hinter dem ersten", async () => {
    const check = await checkLanguages(
      sourceOf([brokenAdapter("kotlin", "@ast-grep/lang-kotlin")], ["kotlin"]),
    );

    expect(check.status).toBe("fail");
    expect(check.detail).toContain("kotlin (grammar_unavailable)");
    expect(check.detail).toContain("The language table and registry also disagree");
  });
});
