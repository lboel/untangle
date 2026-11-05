/**
 * WELCHE SPRACHE AUF DIESER MASCHINE WIRKLICH FUNKTIONIERT — gemessen, nicht
 * aus einer Tabelle gelesen (WP-240).
 *
 * DAS PROBLEM. Ein `LanguageAdapter` traegt sein `supportLevel` als KONSTANTE
 * in seiner Sprachtabelle: elf Sprachen melden dort `"deep"`, weil ihre
 * Tabelle das Wort enthaelt. Ob die zugehoerige Grammatik auf DIESER Maschine
 * ueberhaupt geladen werden kann, weiss die Tabelle nicht. Die
 * `@ast-grep/lang-*`-Pakete liefern Prebuilds nur fuer macOS x64/arm64,
 * Linux x64/arm64 (glibc) und Windows x64. Auf Alpine (musl), Windows ARM64
 * und Windows ia32 gibt es keinen — und der Ersatzbau in der `postinstall`
 * braucht `tree-sitter-cli`, eine optionale Peer-Abhaengigkeit, die per
 * Vorgabe NICHT installiert wird. Schlaegt er fehl, FAENGT die `postinstall`
 * den Fehler und endet mit Exit 0: npm meldet Erfolg, und der Ausfall zeigt
 * sich erst beim ersten Parse.
 *
 * Eine Oberflaeche, die in dieser Lage `"deep"` sagt, behauptet eine
 * Faehigkeit, die es hier nicht gibt. Genau das verbietet E4.
 *
 * DIE MESSUNG. Dieses Modul fragt keine Tabelle, sondern laesst jeden Adapter
 * EINEN winzigen Quelltext parsen. Das ist der einzige Weg, der die Grammatik
 * wirklich anfasst: `parse()` laedt sie beim ersten Aufruf (tree-sitter ueber
 * `grammar-loader.ts`, ast-grep ueber die EINE `registerDynamicLanguage`).
 * Gelingt der Aufruf, ist die Sprache verfuegbar; wirft er, steht der Grund
 * BENANNT im `AdapterParseError` (`kind`, WP-216) und wird woertlich
 * weitergereicht.
 *
 * WARUM DIE HERABSTUFUNG "text" HEISST UND NICHT "gar nichts". Nachgelesen in
 * `@untangle-code/core`, `stages/analysis.ts`: wirft ein Adapter, faengt der
 * Indexlauf die Ausnahme, klassifiziert sie (`classifyAdapterFailure`), legt
 * einen Skip-Ledger-Eintrag mit benanntem Grund an UND indiziert die Datei
 * als Zeilenfenster (`TEXT_ONLY_PARSE`). Textsuche funktioniert also weiter;
 * Symbole, Importe und Komplexitaet nicht. Das ist genau die Stufe `"text"` —
 * "kein Code, aber auffindbar". `untangle complexity` und der Watcher
 * dagegen rechnen nichts und legen einen Ledger-Eintrag an. Beides ist
 * ehrlich, beides steht in {@link LanguageSupportV1.consequence}.
 *
 * KOSTEN. Die Messung laedt Grammatiken, und das ist Absicht: eine Auskunft
 * ueber Verfuegbarkeit, die nichts anfasst, ist wieder nur eine Tabelle. Sie
 * schreibt nichts und fasst kein Netz an — `doctor` bleibt damit rein lesend.
 * Das Ergebnis wird je Registry-Instanz zwischengespeichert, damit ein
 * Aufrufer, der nur einzelne Sprachen braucht (`init`), nicht alle laedt.
 */

import {
  classifyAdapterFailure,
  compareCodepoints,
  parserBackendForLanguage,
  sha256Hex,
} from "@untangle-code/domain";
import type {
  AdapterFailureKind,
  LanguageAdapter,
  ParserBackend,
  ParserRegistry,
  SupportLevel,
} from "@untangle-code/domain";

/**
 * Der Quelltext der Messung. Ein einzelnes Wort: es ist in jeder der
 * achtzehn Sprachen entweder ein Bezeichner oder Prosa, es kostet nichts, und
 * es reicht, weil die Frage nicht "parst das korrekt?" lautet, sondern "laesst
 * sich die Grammatik ueberhaupt laden?". Ein Baum mit Fehlerknoten
 * beantwortet sie mit JA.
 */
const PROBE_SOURCE = "untangle\n";

/** Was aus einer Sprache auf DIESER Maschine geworden ist. */
export interface LanguageSupportV1 {
  readonly languageId: string;
  /** Dateiendungen des Adapters, aufsteigend nach Codepoints. */
  readonly extensions: readonly string[];
  /** `null`, wenn die Sprache in `@untangle-code/domain` keine Backendzuordnung hat. */
  readonly backend: ParserBackend | null;
  /** Was der Adapter BEHAUPTET — die Konstante aus seiner Sprachtabelle. */
  readonly declaredSupportLevel: SupportLevel;
  /** Was hier GEMESSEN wurde. Bei fehlender Grammatik `"text"`, nie `"deep"`. */
  readonly effectiveSupportLevel: SupportLevel;
  /** Ob der Probeparse gelungen ist. */
  readonly available: boolean;
  /** Nur bei `available === false`: der benannte Grund (WP-216). */
  readonly failureKind?: AdapterFailureKind;
  /** Nur bei `available === false`: der Wortlaut der Adapterausnahme. */
  readonly reason?: string;
  /** Nur bei `available === false`: was das fuer die Befehle heisst. */
  readonly consequence?: string;
  /** Nur bei `available === false`: GENAU EIN naechster Schritt. */
  readonly nextStep?: string;
}

/**
 * Der eine naechste Schritt bei fehlender Grammatik.
 *
 * Er nennt KEIN einzelnes Paket, obwohl der Grund es tut — und das ist
 * Absicht: `npm rebuild` ohne Argument baut alle fehlenden Grammatiken auf
 * einmal, und der Schritt bleibt richtig, gleich WELCHE fehlt. Das
 * vorangestellte `tree-sitter-cli` ist die Ursache und nicht Beiwerk: ohne
 * es scheitert der Bau in der `postinstall` still mit Exit 0 — genau der
 * Ausfall, der hier gemeldet wird.
 */
const REBUILD_STEP =
  "Build the missing grammar in the Untangle installation directory: " +
  "`npm install --no-save tree-sitter-cli && npm rebuild`. Without tree-sitter-cli, " +
  "the build can silently exit 0, hiding the failure until the first parse.";

const CONSEQUENCE_TEXT =
  "`untangle index` still indexes this language's files as line windows; " +
  "text search works, but symbols, imports, graph edges and complexity do not. " +
  "`untangle complexity` and `untangle watch` compute no measurements and create one " +
  "skip-ledger entry per file with a reason.";

const probeCache = new WeakMap<ParserRegistry, Map<string, LanguageSupportV1>>();

function cacheOf(registry: ParserRegistry): Map<string, LanguageSupportV1> {
  const existing = probeCache.get(registry);
  if (existing !== undefined) return existing;
  const fresh = new Map<string, LanguageSupportV1>();
  probeCache.set(registry, fresh);
  return fresh;
}

/**
 * Misst EINE Sprache. Das Ergebnis haengt an der Registry-Instanz: ein
 * zweiter Aufruf laedt keine Grammatik erneut.
 */
export function probeLanguageSupport(
  registry: ParserRegistry,
  languageId: string,
): LanguageSupportV1 | null {
  const cache = cacheOf(registry);
  const cached = cache.get(languageId);
  if (cached !== undefined) return cached;

  const adapter = registry.getAdapterByLanguage(languageId);
  if (adapter === null) return null;

  const measured = measure(adapter);
  cache.set(languageId, measured);
  return measured;
}

/**
 * Misst ALLE registrierten Sprachen, sortiert nach `languageId` (Codepoints,
 * nie `localeCompare`).
 */
export function probeAllLanguageSupport(registry: ParserRegistry): LanguageSupportV1[] {
  const adapters = [...registry.listAdapters()].sort((a, b) =>
    compareCodepoints(a.languageId, b.languageId),
  );
  const cache = cacheOf(registry);
  const result: LanguageSupportV1[] = [];
  for (const adapter of adapters) {
    const cached = cache.get(adapter.languageId);
    const measured = cached ?? measure(adapter);
    cache.set(adapter.languageId, measured);
    result.push(measured);
  }
  return result;
}

function measure(adapter: LanguageAdapter): LanguageSupportV1 {
  const base = {
    languageId: adapter.languageId,
    extensions: [...adapter.extensions].sort(compareCodepoints),
    backend: parserBackendForLanguage(adapter.languageId),
    declaredSupportLevel: adapter.supportLevel,
  } as const;

  try {
    adapter.parse({
      fileId: `probe:${adapter.languageId}`,
      repoId: "probe",
      refId: "probe:probe",
      path: `probe/${adapter.languageId}`,
      languageId: adapter.languageId,
      content: PROBE_SOURCE,
      contentHash: sha256Hex(PROBE_SOURCE),
      sizeBytes: Buffer.byteLength(PROBE_SOURCE, "utf8"),
    });
  } catch (error) {
    // WP-216: der Ausnahmetext ist kein Grund. `classifyAdapterFailure`
    // macht daraus einen benannten `kind` — auch aus einer Ausnahme, die kein
    // `AdapterParseError` ist.
    const failure = classifyAdapterFailure(error, { sizeBytes: PROBE_SOURCE.length });
    return {
      ...base,
      // NIE die behauptete Stufe. Was hier bleibt, ist die Textstufe: die
      // Datei ist auffindbar, aber nicht verstanden (Begruendung im Modulkopf).
      effectiveSupportLevel: "text",
      available: false,
      failureKind: failure.kind,
      reason: failure.detail,
      consequence: CONSEQUENCE_TEXT,
      nextStep:
        failure.kind === "grammar_unavailable"
          ? REBUILD_STEP
          : `Report this as a defect in adapter "${adapter.languageId}" — ` +
            `it is a failure to parse one word, not a grammar-loading problem.`,
    };
  }

  return { ...base, effectiveSupportLevel: adapter.supportLevel, available: true };
}
