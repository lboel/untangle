/**
 * Eine Frist um einen Portaufruf.
 *
 * WARUM DIE OBERFLAECHE EINE EIGENE FRIST BRAUCHT, obwohl jeder Adapter schon
 * eine hat: die Fristen der Adapter sind fuer den INDEXLAUF bemessen, und dort
 * ist Durchhalten mehr wert als Tempo. Gemessen an einem ausgelasteten Ollama
 * wiederholt die Bereitschaftsfolge des Embedding-Adapters ihren Zeitueberlauf
 * mit Backoff und meldet den Fehlschlag erst nach ueber DREI MINUTEN. Fuer
 * einen Menschen am Terminal, der eine Frage gestellt hat, ist das kaputt.
 *
 * Die Frist der Oberflaeche kuerzt nichts weg und verschweigt nichts: ein
 * abgebrochener Aufruf ist ein FEHLSCHLAG mit eigenem, benanntem Grund — nie
 * ein leeres Ergebnis, das wie „nichts gefunden" aussieht (BUILD_PLAN E4).
 */

/** Ergebnis eines Laufs mit Frist. `timedOut` unterscheidet Frist von Fehler. */
export type DeadlineOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly timedOut: boolean; readonly error: unknown };

/**
 * Fuehrt `work` mit einer eigenen Frist aus und reicht ihm dafuer ein Signal.
 *
 * Das Signal des Aufrufers bleibt wirksam: ein Strg-C bricht sofort ab, nicht
 * erst nach der Frist. `work` MUSS das gereichte Signal durchreichen — sonst
 * kehrt der Aufruf zwar zurueck, laeuft aber im Hintergrund weiter (siehe
 * `main()` in index.ts, das den Prozess deshalb ausdruecklich beendet).
 */
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outerSignal: AbortSignal,
): Promise<DeadlineOutcome<T>> {
  const controller = new AbortController();
  const onOuterAbort = (): void => {
    controller.abort(outerSignal.reason);
  };
  if (outerSignal.aborted) controller.abort(outerSignal.reason);
  else outerSignal.addEventListener("abort", onOuterAbort, { once: true });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Deadline of ${String(timeoutMs)}ms expired`));
  }, timeoutMs);

  try {
    return { ok: true, value: await work(controller.signal) };
  } catch (error) {
    // Der Abbruch des AUFRUFERS ist kein Fristablauf — er ist ein Abbruch.
    return { ok: false, timedOut: timedOut && !outerSignal.aborted, error };
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener("abort", onOuterAbort);
  }
}
