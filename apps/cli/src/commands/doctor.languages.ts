/**
 * Der Sprachtest von `untangle doctor` (WP-246) — eigene Datei, weil er als
 * einziger Test dieses Befehls eine INJIZIERBARE Abhaengigkeit braucht: die
 * Ehrlichkeit im Ausfall laesst sich sonst nur pruefen, indem man auf der
 * Testmaschine wirklich eine Grammatik zerstoert.
 */
import { compareCodepoints, knownParserLanguages } from "@untangle-code/domain";

import { probeAllLanguageSupport, type LanguageSupportV1 } from "../cli/language-support.js";

import type { CheckResult } from "./doctor.js";

/**
 * Woher der Sprachtest seine Tatsachen nimmt. Die Vorgabe misst wirklich;
 * ein Test schiebt stattdessen eine Maschine unter, auf der eine Grammatik
 * fehlt.
 */
export interface LanguageProbeSource {
  /** Alle registrierten Sprachen, gemessen. */
  measure(): LanguageSupportV1[];
  /**
   * Die ast-grep-EIGENEN Namen der Sprachen, die das Backend selbst als nicht
   * verfuegbar fuehrt. Sie unterscheiden sich von unseren Sprach-IDs ("bash"
   * gegen "shell") und nennen damit das Paket, um das es geht.
   */
  astGrepUnavailable(): string[];
}

/** Die echte Quelle: Registry bauen, jede Grammatik einmal anfassen. */
export async function defaultLanguageProbeSource(): Promise<LanguageProbeSource> {
  const { astGrepLanguageStates, createParserRegistry } =
    await import("@untangle-code/parser-registry");
  const registry = createParserRegistry();
  return {
    measure: () => probeAllLanguageSupport(registry),
    // WP-246: der Zustand, den das ast-grep-Backend SELBST fuehrt — gelesen
    // NEBEN der Messung, nicht an ihrer Stelle. Er ist erst nach dem ersten
    // Parse gefuellt, also nach `measure()`.
    astGrepUnavailable: () =>
      astGrepLanguageStates()
        .filter((entry) => entry.status.state === "unavailable")
        .map((entry) => entry.languageName)
        .sort(compareCodepoints),
  };
}

/**
 * WP-246: WELCHE SPRACHEN HIER WIRKLICH FUNKTIONIEREN.
 *
 * Bis hierher konnte ein Nutzer das nicht herausfinden. Die Registry meldet
 * achtzehn Sprachen, elf davon mit Stufe "deep" — aber "deep" steht als
 * Konstante in einer Tabelle und nicht in der Maschine. Fehlt der Prebuild
 * eines `@ast-grep/lang-*`-Pakets (auf Alpine, Windows ARM64 und Windows
 * ia32 gibt es keinen), meldete die Installation trotzdem Erfolg, und der
 * Ausfall zeigte sich erst beim ersten Parse.
 *
 * Dieser Test misst deshalb (`cli/language-support.ts`) und nennt je Sprache
 * Backend, gemessene Stufe und im Fehlschlag den benannten Grund. Ein
 * Fehlschlag ist hier ein FAIL und kein WARN: eine Sprache, die als "deep"
 * angekuendigt ist und nur Text liefert, ist ein Umgebungsdefekt — und genau
 * dafuer gibt es Exit-Code 4.
 */
export async function checkLanguages(
  source?: LanguageProbeSource | Promise<LanguageProbeSource>,
): Promise<CheckResult> {
  let measured: LanguageSupportV1[];
  let astGrepUnavailable: string[];
  try {
    const probe = await (source ?? defaultLanguageProbeSource());
    measured = probe.measure();
    astGrepUnavailable = probe.astGrepUnavailable();
  } catch (error) {
    return {
      id: "languages",
      title: "Languages",
      status: "fail",
      detail: `Could not load the language table: ${errorText(error)}`,
      nextStep: "Reinstall dependencies: `npm install` in the Untangle installation directory.",
    };
  }

  const unavailable = measured.filter((entry) => !entry.available);
  const unknownBackend = measured.filter((entry) => entry.backend === null);
  // Die Gegenrichtung: eine Sprache, die `@untangle-code/domain` kennt, die
  // aber keinen Adapter mehr hat. Beides zusammen ist die Vertragsgrenze aus
  // WP-240 — eine Falschaussage in JEDE Richtung wird hier sichtbar.
  const registered = new Set(measured.map((entry) => entry.languageId));
  const orphaned = knownParserLanguages()
    .filter((languageId) => !registered.has(languageId))
    .sort(compareCodepoints);

  const facts: Record<string, string | number | boolean> = {
    "astgrep:nichtVerfuegbar":
      astGrepUnavailable.length === 0 ? "(none)" : astGrepUnavailable.join(", "),
    "sprachen:registriert": measured.length,
    "sprachen:verfuegbar": measured.length - unavailable.length,
  };
  for (const entry of measured) {
    facts[`sprache:${entry.languageId}`] = describeLanguageSupport(entry);
  }

  if (unavailable.length === 0 && unknownBackend.length === 0 && orphaned.length === 0) {
    return {
      id: "languages",
      title: "Languages",
      status: "ok",
      detail:
        `All ${String(measured.length)} registered languages are actually available here, ` +
        "measured by parsing a word with each adapter to load its grammar.",
      facts,
    };
  }

  // Die Vertragsgrenze aus WP-240, in BEIDE Richtungen. Sie wird auch dann
  // ausgesprochen, wenn zugleich Grammatiken fehlen — ein zweiter Befund
  // verschwindet nicht hinter dem ersten (E4).
  const driftNotes: string[] = [];
  if (unknownBackend.length > 0) {
    driftNotes.push(
      `${unknownBackend.map((entry) => entry.languageId).join(", ")} is registered, ` +
        "but has no backend mapping in @untangle-code/domain",
    );
  }
  if (orphaned.length > 0) {
    driftNotes.push(
      `${orphaned.join(", ")} is listed in @untangle-code/domain but is not registered`,
    );
  }
  const driftSuffix =
    driftNotes.length === 0
      ? ""
      : ` The language table and registry also disagree: ${driftNotes.join("; ")}.`;

  if (unavailable.length > 0) {
    const first = unavailable[0] as LanguageSupportV1;
    return {
      id: "languages",
      title: "Languages",
      status: "fail",
      detail:
        `${String(unavailable.length)} of ${String(measured.length)} languages are not available here: ` +
        `unavailable: ${unavailable.map((entry) => `${entry.languageId} (${entry.failureKind ?? "no reason given"})`).join(", ")}. ` +
        `They are therefore reported as tier "text", not the claimed tier "${first.declaredSupportLevel}". ` +
        `REASON (${entry0Kind(first)}): ${first.reason ?? "no details"} ` +
        `CONSEQUENCE: ${first.consequence ?? "no details"}${driftSuffix}`,
      nextStep: first.nextStep ?? "Reinstall dependencies.",
      facts,
    };
  }

  // Kein Ausfall der Grammatiken, aber die Tabelle in
  // `@untangle-code/domain` und die Registry sind auseinandergelaufen.
  return {
    id: "languages",
    title: "Languages",
    status: "fail",
    detail:
      "All grammars load, but the language table and registry disagree: " +
      `${driftNotes.join("; ")}. ` +
      "Either the parser version or the backend declaration for this language is incorrect.",
    nextStep:
      "Compare `packages/domain/src/versions.ts` with the registered adapters; " +
      "the corresponding check is in `apps/cli/src/commands/doctor.languages.test.ts`.",
    facts,
  };
}

/** Eine Zeile je Sprache: Backend, gemessene Stufe, und im Ausfall der Grund. */
function describeLanguageSupport(entry: LanguageSupportV1): string {
  const backend = entry.backend ?? "NO BACKEND MAPPING";
  if (entry.available) {
    return `${backend} · ${entry.effectiveSupportLevel} · available`;
  }
  return (
    `${backend} · claimed ${entry.declaredSupportLevel}, measured ` +
    `${entry.effectiveSupportLevel} · unavailable (${entry.failureKind ?? "no reason given"})`
  );
}

/** Der benannte Grund einer Sprache, oder ein ehrlicher Ersatz. */
function entry0Kind(entry: LanguageSupportV1): string {
  return entry.failureKind ?? "no reason specified";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
