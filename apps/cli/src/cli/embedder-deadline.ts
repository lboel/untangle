/**
 * Eine Frist um JEDEN Aufruf des Einbettungsdienstes — und ein sichtbares
 * Lebenszeichen, solange er laeuft.
 *
 * WARUM (WP-227, gemessen, nicht vermutet): Beim Abnahmelauf gegen ein
 * Projekt mit NEUN Dateien lief `untangle index` ueber 300 Sekunden ohne eine
 * einzige Zeile Ausgabe und musste abgebrochen werden. Ursache war ein
 * Ollama, dessen `/api/embed` haengt, waehrend `/api/tags` sofort antwortet.
 * Die Rechnung dahinter: `embeddings.requestTimeoutMs` steht per Vorgabe auf
 * 120 000 ms, und die Bereitschaftsfolge wiederholt ihren Zeitueberlauf mit
 * Backoff — drei Versuche sind sechs Minuten. Fuer den Indexlauf ist langes
 * Durchhalten grundsaetzlich richtig; ein Mensch am Terminal, der nichts
 * sieht, weiss aber nicht einmal, OB etwas passiert. Das ist die
 * Oberflaechenform derselben Unehrlichkeit, gegen die E4 antritt.
 *
 * ES IST DASSELBE MUSTER WIE IN `untangle doctor`: eine eigene Frist der
 * Oberflaeche, und ein abgebrochener Aufruf gilt als FEHLGESCHLAGEN, nie als
 * bestanden. Der Unterschied ist nur, dass die Frist hier nicht um einen
 * Diagnosetest liegt, sondern um jeden einzelnen Aufruf des Dienstes.
 *
 * ZWEI DINGE, DIE DIESE HUELLE NIE TUT:
 *
 * 1. Sie faelscht kein Ergebnis. Laeuft die Frist ab, wirft sie
 *    `EMBEDDING_UNAVAILABLE` — nie einen leeren Vektorsatz, der weiter unten
 *    als „fertig" durchginge (spec.md §25.1, BUILD_PLAN E4).
 * 2. Sie taeuscht keinen Nutzerabbruch vor. Ein Fristablauf traegt bewusst
 *    NICHT den Namen `AbortError` und nicht den Code `JOB_CANCELLED`: der
 *    Laeufer unterscheidet Abbruch von Fehlschlag genau daran (siehe
 *    `packages/core/src/cancellation.ts`), und ein Fristablauf ist ein
 *    Fehlschlag der UMGEBUNG, kein Strg-C. Bricht dagegen der Nutzer wirklich
 *    ab, geht sein Fehler unveraendert weiter.
 */

import {
  UntangleError,
  type EmbeddingBatchResultV1,
  type EmbeddingProfile,
  type EmbeddingProvider,
  type EmbeddingReadinessV1,
  type PortCallOptions,
} from "@untangle-code/domain";

import { withDeadline, type DeadlineOutcome } from "./deadline.js";
import { systemClock } from "./system.js";

/**
 * Vorgabefrist je Aufruf.
 *
 * Grosszuegiger als die 15 s von `doctor`, weil ein Indexstapel echte Arbeit
 * ist (acht Dateien, ein kalt geladenes Modell) — und trotzdem endlich, weil
 * genau das der Unterschied zwischen „dauert" und „haengt" ist. Wem sie zu
 * knapp ist, der hebt sie mit `--timeout` an; wer schnell scheitern will,
 * senkt sie.
 */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 60_000;

/** Abstand der Lebenszeichen, solange ein Aufruf laeuft. */
export const DEFAULT_HEARTBEAT_MS = 5_000;

export interface EmbeddingDeadlineOptions {
  /** Frist je Aufruf in Millisekunden. */
  readonly timeoutMs: number;
  /**
   * Das Abbruchsignal des Befehls. Es gilt zusaetzlich zu dem, das der
   * Aufrufer je Aufruf mitgibt — Strg-C wirkt sofort, nicht erst zur Frist.
   */
  readonly outerSignal: AbortSignal;
  /** Wohin die Lebenszeichen gehen. In der Oberflaeche: stderr. */
  readonly onProgress?: ((text: string) => void) | undefined;
  /** Abstand der Lebenszeichen; 0 schaltet sie ab. */
  readonly heartbeatMs?: number | undefined;
  /**
   * Die Uhr der Lebenszeichen. Vorgabe ist der `systemClock`-Port — nie
   * `Date.now()` direkt (spec.md §5, Regel 5). Die gemessene Dauer ist
   * DIAGNOSE auf stderr und geht in keine Ergebnisdatei ein.
   */
  readonly clock?: { nowEpochMs(): number } | undefined;
}

/**
 * Legt {@link EmbeddingDeadlineOptions.timeoutMs} um jeden Aufruf von
 * `inner` und meldet, dass gewartet wird.
 */
export function withEmbeddingDeadline(
  inner: EmbeddingProvider,
  options: EmbeddingDeadlineOptions,
): EmbeddingProvider {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const clock = options.clock ?? systemClock;
  const now = (): number => clock.nowEpochMs();

  async function guarded<T>(
    label: string,
    startNote: string,
    call: (signal: AbortSignal) => Promise<T>,
    callerOptions: PortCallOptions | undefined,
  ): Promise<T> {
    options.onProgress?.(startNote);

    // Das Signal des Aufrufers ist das aeussere, wenn es eines gibt: der
    // Laeufer reicht sein internes Signal durch, und daran haengt Strg-C.
    const outer = callerOptions?.signal ?? options.outerSignal;
    const startedAt = now();
    const timer =
      heartbeatMs > 0 && options.onProgress !== undefined
        ? setInterval(() => {
            const elapsedMs = now() - startedAt;
            options.onProgress?.(
              `       … ${label}: waiting ${seconds(elapsedMs)} without a response ` +
                `(deadline ${seconds(options.timeoutMs)}).`,
            );
          }, heartbeatMs)
        : undefined;
    // Ein Lebenszeichen darf den Prozess nie am Leben halten.
    timer?.unref?.();

    let outcome: DeadlineOutcome<T>;
    try {
      outcome = await withDeadline<T>(call, options.timeoutMs, outer);
    } finally {
      if (timer !== undefined) clearInterval(timer);
    }

    if (outcome.ok) return outcome.value;
    if (!outcome.timedOut) throw outcome.error;

    throw new UntangleError(
      "EMBEDDING_UNAVAILABLE",
      `The embedding service did not answer "${label}" within ${String(options.timeoutMs)} ms ` +
        ". The call was cancelled; a cancelled call is not a " +
        "result but a failure.",
      {
        retryable: true,
        operation: "index.embed",
        context: { call: label, timeoutMs: options.timeoutMs, model: inner.profile.model },
        cause: outcome.error,
      },
    );
  }

  return {
    get profile(): EmbeddingProfile {
      return inner.profile;
    },
    get profileId(): string {
      return inner.profileId;
    },

    ensureReady(callerOptions?: PortCallOptions): Promise<EmbeddingReadinessV1> {
      return guarded<EmbeddingReadinessV1>(
        "Readiness check",
        `[  2%] Embedding service: readiness check running; model ${inner.profile.model}, ` +
          `deadline ${seconds(options.timeoutMs)} per call.`,
        (signal) => inner.ensureReady({ signal }),
        callerOptions,
      );
    },

    embedDocuments(
      preparedTexts: string[],
      callerOptions?: PortCallOptions,
    ): Promise<EmbeddingBatchResultV1> {
      return guarded<EmbeddingBatchResultV1>(
        `Embedding ${String(preparedTexts.length)} texts`,
        `       Embedding: ${String(preparedTexts.length)} texts in progress ` +
          `(deadline ${seconds(options.timeoutMs)}).`,
        (signal) => inner.embedDocuments(preparedTexts, { signal }),
        callerOptions,
      );
    },

    embedQuery(preparedText: string, callerOptions?: PortCallOptions): Promise<number[]> {
      return guarded<number[]>(
        "Query embedding",
        `       Query embedding in progress (deadline ${seconds(options.timeoutMs)}).`,
        (signal) => inner.embedQuery(preparedText, { signal }),
        callerOptions,
      );
    },
  };
}

/** „61 s" statt „61000 ms" — die Frist liest ein Mensch. */
function seconds(milliseconds: number): string {
  const value = milliseconds / 1000;
  return `${Number.isInteger(value) ? String(value) : value.toFixed(1)} s`;
}
