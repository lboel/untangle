/**
 * Der Zugang zu `@ast-grep/napi` — traege geladen, EINMAL registriert, und
 * ohne stillen Ausfall.
 *
 * DREI EIGENHEITEN DIESER BIBLIOTHEK BESTIMMEN DIESE DATEI:
 *
 *  1. `registerDynamicLanguage` WIRKT GENAU EINMAL. Der zweite Aufruf wirft
 *     nicht — er registriert schweigend nichts, und jeder spaetere
 *     `parse("<sprache>", ...)` scheitert dann mit "not supported in napi".
 *     Also: EINE Registrierung, aufgeschoben bis zum ersten Parse einer
 *     dynamischen Sprache, mit ALLEN Sprachen, deren Adapter bis dahin
 *     angemeldet wurden. Wer danach noch eine Sprache anmeldet, bekommt einen
 *     Fehler statt einer stillen Wirkungslosigkeit ({@link registerAstGrepLanguage}).
 *
 *  2. EIN FEHLENDER PREBUILD SCHEITERT BEI DER INSTALLATION STILL. Die
 *     `postinstall` der `@ast-grep/lang-*`-Pakete faengt den Baufehler und
 *     endet mit Exit 0; npm/pnpm melden Erfolg. Erst `require("<paket>")
 *     .libraryPath` wirft — ein Getter. Die Sprachpakete liefern Prebuilds nur
 *     fuer macOS x64/arm64, Linux x64/arm64 (glibc) und Windows x64: auf
 *     Alpine (musl), Windows ARM64 und Windows ia32 gibt es KEINEN. Deshalb
 *     wird jede Sprache einzeln geprueft, der Ausfall benannt festgehalten
 *     ({@link astGrepLanguageStatus}) und beim Parsen als
 *     `grammar_unavailable` gemeldet — woraus der Aufrufer einen
 *     Skip-Ledger-Eintrag mit Grund baut (E4). Kein Adapter tut so, als haette
 *     er geparst.
 *
 *  3. `SgNode#id()` IST ADRESSABGELEITET. Innerhalb eines Prozesses taugt es
 *     zum Vergleich zweier Knoten, ueber Prozesse hinweg zu gar nichts. Es
 *     darf deshalb NIE in Ergebnisdaten stehen; genutzt wird es einzig in
 *     `syntax.ts`, um den Feldnamen des aktuellen Knotens zu bestimmen.
 *
 * Der Kern (`@ast-grep/napi`) bringt TypeScript, TSX, JavaScript, HTML und CSS
 * fest eingebaut mit. Wir benutzen davon NICHTS: die JS/TS-Familie laeuft
 * weiter ueber tree-sitter (Begruendung in `README.md` dieses Verzeichnisses).
 */
import { createRequire } from "node:module";

import { AdapterParseError } from "@untangle-code/domain";

const require = createRequire(import.meta.url);

/** Die Knotenform von ast-grep, auf die Teilmenge reduziert, die wir benutzen. */
export interface SgNode {
  id(): number;
  kind(): string;
  text(): string;
  range(): { start: SgPos; end: SgPos };
  isLeaf(): boolean;
  isNamed(): boolean;
  children(): SgNode[];
  namedChildren(): SgNode[];
  parent(): SgNode | null;
  prev(): SgNode | null;
  field(name: string): SgNode | null;
}

export interface SgPos {
  /** 0-basierte Zeile. */
  line: number;
  /** 0-basierte Spalte, in UTF-16-Einheiten. */
  column: number;
  /**
   * ENTGEGEN der Typdefinition von ast-grep ("byte offset") ein
   * UTF-16-Offset — nachgemessen an Umlauten und Emoji. Die Umrechnung in
   * Bytes macht ausschliesslich die `ByteOffsetTable`.
   */
  index: number;
}

export interface SgRoot {
  root(): SgNode;
}

interface AstGrepModule {
  parse(lang: string, source: string): SgRoot;
  registerDynamicLanguage(langs: Record<string, LanguageRegistration>): void;
}

interface LanguageRegistration {
  libraryPath: string;
  extensions: string[];
  languageSymbol?: string;
  metaVarChar?: string;
  expandoChar?: string;
}

/** Wie es einer angemeldeten Sprache ergangen ist. */
export type AstGrepLanguageStatus =
  | { readonly state: "pending" }
  | { readonly state: "available" }
  | { readonly state: "unavailable"; readonly reason: string };

interface PendingLanguage {
  /** Name, unter dem ast-grep die Sprache kennt (auch der `parse`-Parameter). */
  languageName: string;
  /** npm-Paket mit Prebuild und Registrierungsangaben. */
  moduleName: string;
}

const pending = new Map<string, PendingLanguage>();
const status = new Map<string, AstGrepLanguageStatus>();
let registrationDone = false;
let cachedModule: AstGrepModule | undefined;

/**
 * Meldet eine Sprache fuer die EINE spaetere Registrierung an. Kostet nichts:
 * kein `require`, kein Laden einer Grammatik — genau wie die traege
 * Registrierung der tree-sitter-Adapter (`registry.ts`).
 */
export function registerAstGrepLanguage(languageName: string, moduleName: string): void {
  const already = pending.get(languageName);
  if (already !== undefined && already.moduleName === moduleName) {
    // DIESELBE Sprache aus DEMSELBEN Paket ein zweites Mal anzumelden ist
    // harmlos und passiert im Normalbetrieb: `createParserRegistry()` baut
    // jedes Mal frische Adapter, und ein Prozess darf mehr als eine Registry
    // haben (die CLI tut es je Befehl). Der Eintrag ist bereits da, die
    // Registrierung enthaelt die Sprache also — hier ist NICHTS zu tun und
    // nichts zu melden. Ohne diese Ausnahme warf die zweite Registry, obwohl
    // ihre Sprachen samt und sonders verfuegbar waren (WP-86).
    return;
  }
  if (registrationDone) {
    // Nach der Registrierung ist die Liste unveraenderlich (Eigenheit 1 im
    // Modulkopf). Ein spaeterer Eintrag waere wirkungslos — und wirkungslos
    // und unbemerkt ist genau das, was E4 verbietet.
    throw new AdapterParseError(
      "grammar_unavailable",
      `Sprache "${languageName}" was registered after the one-time ast-grep registration. ` +
        `registerDynamicLanguage only takes effect on its first call; the language would silently remain unavailable.`,
    );
  }
  pending.set(languageName, { languageName, moduleName });
  status.set(languageName, { state: "pending" });
}

function loadModule(): AstGrepModule {
  if (cachedModule === undefined) {
    cachedModule = require("@ast-grep/napi") as AstGrepModule;
  }
  return cachedModule;
}

/**
 * Fuehrt die EINE Registrierung aus (idempotent). Jede Sprache, deren Paket
 * fehlt oder deren Prebuild nicht gebaut wurde, faellt hier mit BENANNTEM
 * Grund heraus, statt erst beim Parsen unverstaendlich zu scheitern.
 */
function ensureRegistered(): AstGrepModule {
  const napi = loadModule();
  if (registrationDone) return napi;
  registrationDone = true;

  const registrations: Record<string, LanguageRegistration> = {};
  for (const language of pending.values()) {
    try {
      const registration = require(language.moduleName) as LanguageRegistration;
      // `libraryPath` ist ein GETTER, der genau dann wirft, wenn weder ein
      // Prebuild noch ein selbst gebauter Parser da ist. Der Zugriff hier ist
      // die Pruefung, nicht ein beilaeufiges Lesen.
      const libraryPath = registration.libraryPath;
      registrations[language.languageName] = { ...registration, libraryPath };
    } catch (error) {
      status.set(language.languageName, {
        state: "unavailable",
        reason: `Package "${language.moduleName}" could not be loaded or has no built parser for ${process.platform}/${process.arch}: ${errorText(error)}`,
      });
    }
  }

  if (Object.keys(registrations).length > 0) {
    try {
      napi.registerDynamicLanguage(registrations);
      for (const name of Object.keys(registrations)) {
        status.set(name, { state: "available" });
      }
    } catch (error) {
      for (const name of Object.keys(registrations)) {
        status.set(name, {
          state: "unavailable",
          reason: `registerDynamicLanguage failed: ${errorText(error)}`,
        });
      }
    }
  }

  return napi;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Zustand einer angemeldeten Sprache — fuer `doctor` und fuer Tests. Loest die
 * Registrierung NICHT aus: wer nur fragt, soll keine Grammatik laden.
 */
export function astGrepLanguageStatus(languageName: string): AstGrepLanguageStatus | null {
  return status.get(languageName) ?? null;
}

/** Alle angemeldeten Sprachen mit ihrem Zustand (Reihenfolge der Anmeldung). */
export function astGrepLanguageStates(): { languageName: string; status: AstGrepLanguageStatus }[] {
  return [...pending.keys()].map((languageName) => ({
    languageName,
    status: status.get(languageName) ?? { state: "pending" },
  }));
}

/**
 * Parst Quelltext mit ast-grep. Loest beim ERSTEN Aufruf die einmalige
 * Registrierung aus (siehe Modulkopf) und wirft einen benannten
 * `AdapterParseError`, wenn genau diese Sprache nicht verfuegbar ist.
 */
export function astGrepParse(languageName: string, source: string): SgNode {
  let napi: AstGrepModule;
  try {
    napi = ensureRegistered();
  } catch (error) {
    throw new AdapterParseError(
      "grammar_unavailable",
      `Could not load @ast-grep/napi: ${errorText(error)}`,
      { cause: error },
    );
  }

  const languageStatus = status.get(languageName);
  if (languageStatus === undefined) {
    throw new AdapterParseError(
      "grammar_unavailable",
      `Sprache "${languageName}" is not registered with this ast-grep backend.`,
    );
  }
  if (languageStatus.state === "unavailable") {
    throw new AdapterParseError(
      "grammar_unavailable",
      `Sprache "${languageName}" is unavailable: ${languageStatus.reason}`,
    );
  }

  try {
    return napi.parse(languageName, source).root();
  } catch (error) {
    throw new AdapterParseError(
      "parser_internal_error",
      `ast-grep could not parse "${languageName}" could not be parsed: ${errorText(error)}`,
      { cause: error },
    );
  }
}

/**
 * Nur fuer Tests: setzt Anmeldungen und Registrierungszustand zurueck. Der
 * NATIVE Zustand laesst sich damit NICHT zuruecksetzen — `registerDynamicLanguage`
 * bleibt im Prozess wirksam. Ein Test, der eine zweite, andere Registrierung
 * erzwingen will, braucht einen eigenen Prozess.
 */
export function resetAstGrepRegistrationForTests(): void {
  pending.clear();
  status.clear();
  registrationDone = false;
}
