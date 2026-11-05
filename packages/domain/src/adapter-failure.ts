/**
 * Benannte Gruende fuer eine geworfene Ausnahme eines `LanguageAdapter`
 * (WP-216; E4 aus docs/BUILD_PLAN.md).
 *
 * WARUM DIESES MODUL EXISTIERT: Bis WP-216 landete der Text einer
 * Adapterausnahme WOERTLICH im Skip-Ledger — `"Der Adapter warf beim Parsen:
 * Invalid argument"`. Das ist keine Diagnose. `Invalid argument` ist der
 * `errno`-Text einer nativen Bindung; er sagt niemandem, WELCHE Bedingung
 * verletzt wurde und was zu tun ist. E4 verlangt einen GRUND, nicht
 * irgendeinen Text: eine geschlossene, zaehlbare Menge, gegen die man Regeln
 * schreiben und Regressionen messen kann.
 *
 * Der Weg ist deshalb ZWEISTUFIG:
 *
 *   1. Ein Adapter, der die Bedingung selbst kennt, wirft {@link AdapterParseError}
 *      MIT `kind` und mit den GEMESSENEN Zahlen (`measurements`) — z. B.
 *      `file_too_large` mit `sizeBytes`/`limitBytes`.
 *   2. Jeder Aufrufer, der eine Adapterausnahme faengt, schickt sie durch
 *      {@link classifyAdapterFailure}, bevor er einen Ledger-Eintrag baut.
 *      Auch eine voellig unbekannte Ausnahme bekommt dort einen benannten
 *      `kind` (`parser_internal_error` / `unknown_adapter_failure`) — der
 *      Bibliothekstext ueberlebt nur noch als ANHANG hinter dem Grund,
 *      nie als der Grund selbst.
 *
 * Die Erlaeuterungstexte sind DEUTSCH (E3: Doku deutsch, Code englisch) und
 * enthalten jeweils eine Handlungsanweisung, weil ein Grund ohne Konsequenz
 * dem Leser des Ledgers nichts nuetzt.
 */
import type { SkipReason } from "./types/skip-ledger.js";

/**
 * Geschlossene Menge der benannten Fehlschlagsgruende eines Adapters.
 *
 * Geschlossen aus demselben Grund wie `SKIP_REASONS`: nur so bleiben die
 * Gruende zaehlbar. Feiner als `SkipReason`, weil mehrere Adapterfehler auf
 * denselben Ledger-Grund abgebildet werden (drei verschiedene Ursachen sind
 * alle `parse_failed`) und die Unterscheidung sonst verloren ginge.
 */
export const ADAPTER_FAILURE_KINDS = [
  /** Die Datei ist groesser als die gemessene Obergrenze des Parsers. */
  "file_too_large",
  /** Der Eingabepuffer der Parserbindung reichte fuer die Datei nicht. */
  "parser_buffer_exhausted",
  /** Grammatik/native Bindung nicht ladbar (fehlend, falsche ABI, kaputte Installation). */
  "grammar_unavailable",
  /** Der Speicher reichte fuer den Syntaxbaum nicht. */
  "parser_out_of_memory",
  /** Der Quelltext war nicht als Text verwertbar (Binaeranteil, kaputte Kodierung). */
  "source_not_decodable",
  /** Der Parser lief in einen eigenen Defekt (Ausnahme mit bekannter Fehlerklasse). */
  "parser_internal_error",
  /** Geworfen wurde etwas, das nicht einmal ein `Error` war. */
  "unknown_adapter_failure",
] as const;

export type AdapterFailureKind = (typeof ADAPTER_FAILURE_KINDS)[number];

/** Auf welchen Ledger-Grund ein benannter Adapterfehler abgebildet wird. */
const SKIP_REASON_OF: Readonly<Record<AdapterFailureKind, SkipReason>> = {
  file_too_large: "file_too_large",
  parser_buffer_exhausted: "parse_failed",
  grammar_unavailable: "provider_unavailable",
  parser_out_of_memory: "parse_failed",
  source_not_decodable: "binary_content",
  parser_internal_error: "parse_failed",
  unknown_adapter_failure: "parse_failed",
};

/**
 * Ob ein erneuter Versuch derselben Datei ueberhaupt anders ausgehen KANN.
 *
 * `file_too_large` ist nicht wiederholbar: dieselbe Datei ist beim naechsten
 * Lauf genauso gross. `parser_out_of_memory` schon: mit mehr Speicher oder
 * weniger Nebenlast kann derselbe Lauf gelingen.
 */
const RECOVERABLE_OF: Readonly<Record<AdapterFailureKind, boolean>> = {
  file_too_large: false,
  parser_buffer_exhausted: true,
  grammar_unavailable: true,
  parser_out_of_memory: true,
  source_not_decodable: false,
  parser_internal_error: false,
  unknown_adapter_failure: false,
};

/** Deutsche Erlaeuterung MIT Handlungsanweisung, je benanntem Grund. */
const EXPLANATION_OF: Readonly<Record<AdapterFailureKind, string>> = {
  file_too_large:
    "The file exceeds the parser's measured size limit and contributes to no measurement. " +
    "Raise the limit only if enough memory is available.",
  parser_buffer_exhausted:
    "The parser binding's input buffer was too small for this file. " +
    "This is a call-site defect, not a file defect: the buffer must grow with the input length.",
  grammar_unavailable:
    "The grammar or native binding could not be loaded. " +
    "Check dependency installation, including the correct Node ABI and a complete node_modules tree.",
  parser_out_of_memory:
    "Insufficient memory for this file's syntax tree. " +
    "Lower the file-size limit or provide more memory to the process.",
  source_not_decodable:
    "The content was not usable as source text (binary content or invalid encoding). " +
    "Add the file to the exclusion list.",
  parser_internal_error:
    "The parser failed on this file. " +
    "Report this adapter defect rather than attributing it to the file.",
  unknown_adapter_failure:
    "The adapter threw a non-Error value, so its cause cannot be inspected. " +
    "The throwing code must provide a typed error.",
};

/** Zusatzangaben, die eine Klassifikation praeziser machen. */
export interface AdapterFailureContext {
  /** Groesse des Quelltexts in Bytes, sofern bekannt. */
  sizeBytes?: number;
  /** Repo-relativer Pfad, nur fuer die Erlaeuterung. */
  path?: string;
}

/** Das Ergebnis einer Klassifikation: benannter Grund plus fertige Ledger-Felder. */
export interface AdapterFailure {
  kind: AdapterFailureKind;
  reason: SkipReason;
  recoverable: boolean;
  /** Fertiger `detail`-Text fuer den Skip-Ledger: Grund, Erlaeuterung, Messwerte, Rohtext. */
  detail: string;
  /** Gemessene Zahlen, die den Grund BELEGEN (z. B. `sizeBytes`, `limitBytes`). */
  measurements: Readonly<Record<string, number>>;
  /** Der urspruengliche Ausnahmetext — Anhang, nie der Grund selbst. */
  rawMessage: string;
}

/**
 * Eine Ausnahme, die ein Adapter MIT bereits bekanntem Grund wirft.
 *
 * Wer diese Klasse wirft, hat die Bedingung selbst geprueft und kennt die
 * Zahlen; {@link classifyAdapterFailure} uebernimmt sie dann unveraendert,
 * statt am Text zu raten.
 */
export class AdapterParseError extends Error {
  public readonly kind: AdapterFailureKind;
  public readonly measurements: Readonly<Record<string, number>>;

  public constructor(
    kind: AdapterFailureKind,
    message: string,
    options: { measurements?: Record<string, number>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AdapterParseError";
    this.kind = kind;
    this.measurements = options.measurements ?? {};
  }
}

/** Typwaechter fuer {@link AdapterParseError} (auch ueber Paketgrenzen hinweg). */
export function isAdapterParseError(value: unknown): value is AdapterParseError {
  return (
    value instanceof Error && (value as Partial<AdapterParseError>).name === "AdapterParseError"
  );
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Ordnet die Ausnahme einer NICHT selbst klassifizierten Quelle einem
 * benannten Grund zu.
 *
 * Die Reihenfolge ist Absicht: die spezifischste Erkennung zuerst. `Invalid
 * argument` ist der Text, mit dem die native tree-sitter-Bindung einen zu
 * kleinen Eingabepuffer meldet — sie kennt keinen eigenen Fehlercode dafuer.
 */
function inferKind(error: unknown): AdapterFailureKind {
  if (!(error instanceof Error)) return "unknown_adapter_failure";
  const message = error.message;
  const code = (error as { code?: unknown }).code;

  if (
    code === "MODULE_NOT_FOUND" ||
    /Cannot find module|different Node\.js version|NODE_MODULE_VERSION/i.test(message)
  ) {
    return "grammar_unavailable";
  }
  if (/Invalid argument/i.test(message)) return "parser_buffer_exhausted";
  if (
    error instanceof RangeError ||
    /out of memory|Array buffer allocation failed|Invalid string length|Maximum call stack/i.test(
      message,
    )
  ) {
    return "parser_out_of_memory";
  }
  return "parser_internal_error";
}

function formatMeasurements(measurements: Readonly<Record<string, number>>): string {
  const keys = Object.keys(measurements).sort();
  if (keys.length === 0) return "";
  return ` [${keys.map((key) => `${key}=${String(measurements[key])}`).join(", ")}]`;
}

/**
 * Bildet eine beliebige Adapterausnahme auf einen benannten Grund ab.
 *
 * NIE den Rueckgabewert umgehen und `error.message` direkt in ein Ledger
 * schreiben: genau das war WP-216.
 */
export function classifyAdapterFailure(
  error: unknown,
  context: AdapterFailureContext = {},
): AdapterFailure {
  const rawMessage = messageOf(error);
  const known = isAdapterParseError(error) ? error : null;
  const kind: AdapterFailureKind = known !== null ? known.kind : inferKind(error);

  const measurements: Record<string, number> = { ...(known?.measurements ?? {}) };
  if (context.sizeBytes !== undefined && measurements["sizeBytes"] === undefined) {
    measurements["sizeBytes"] = context.sizeBytes;
  }

  const detail =
    `${kind}: ${EXPLANATION_OF[kind]}${formatMeasurements(measurements)}` +
    ` (exception text: ${rawMessage})`;

  return {
    kind,
    reason: SKIP_REASON_OF[kind],
    recoverable: RECOVERABLE_OF[kind],
    detail,
    measurements,
    rawMessage,
  };
}

/** Der Ledger-Grund, auf den ein benannter Adapterfehler abgebildet wird. */
export function skipReasonOfAdapterFailure(kind: AdapterFailureKind): SkipReason {
  return SKIP_REASON_OF[kind];
}
