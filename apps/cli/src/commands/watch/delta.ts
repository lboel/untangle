/**
 * Deltas mit RICHTUNG — der eigentliche Zweck des Waechters.
 *
 * vision.md §1b: eine Aenderung, die Komplexitaet senkt, wird als
 * Verbesserung AUSGEWIESEN und nicht nur stillschweigend hingenommen; eine
 * Verschlechterung wird mit ihrer Beitragsstelle benannt. Eine nackte Zahl
 * leistet weder das eine noch das andere.
 *
 * Fuer alle vier Metriken gilt dieselbe Leserichtung: kleiner ist einfacher.
 * Ein negatives Delta heisst deshalb `"abgebaut"`, ein positives
 * `"aufgebaut"`.
 *
 * ## Was diese Datei NICHT behauptet
 *
 * vision.md §1b macht die Qualitaetsaussage von drei Bedingungen abhaengig
 * (unveraenderte oeffentliche Symboloberflaeche, unveraenderte Testergebnisse,
 * keine neuen Abhaengigkeitskanten). Der Waechter misst hier NUR die
 * Komplexitaet. `"abgebaut"` heisst also "die Komplexitaet ist gefallen" und
 * ausdruecklich NICHT "die Aenderung war eine Verbesserung" — das waere ein
 * Beweis, den eine statische Messung nicht fuehren kann.
 */
import { compareCodepoints } from "@untangle-code/domain";

import type { FileReadingV1, ScopeReadingV1 } from "./analyze.js";
import {
  METRIC_KEYS,
  zeroMetricValues,
  type ComplexityDirection,
  type MetricDeltaV1,
  type MetricKey,
  type MetricValues,
  type ScopeDeltaV1,
} from "./events.js";

/** Kleiner ist einfacher: negatives Delta = abgebaut. */
export function directionOf(delta: number): ComplexityDirection {
  if (delta < 0) return "abgebaut";
  if (delta > 0) return "aufgebaut";
  return "unveraendert";
}

/** Die Lesart, in der ein Metrikwert entstanden ist (siehe `analyze.ts`). */
export function readingOf(metric: MetricKey): "execution_unit" | "file_chunks" {
  return metric === "semantic" ? "file_chunks" : "execution_unit";
}

/**
 * Deltas je Metrik zwischen zwei Messungen derselben Datei. `previous` fehlt
 * bei einer neu hinzugekommenen Datei, `current` bei einer geloeschten — in
 * beiden Faellen wird die fehlende Seite als 0 gelesen, damit das Delta die
 * tatsaechliche Wirkung auf die Gesamtlage beschreibt.
 */
export function metricDeltas(
  previous: FileReadingV1 | undefined,
  current: FileReadingV1 | undefined,
): MetricDeltaV1[] {
  return METRIC_KEYS.map((metric) => {
    const before = previous === undefined ? null : previous.totals[metric];
    const after = current === undefined ? null : current.totals[metric];
    const delta = (after ?? 0) - (before ?? 0);
    return {
      metric,
      reading: readingOf(metric),
      previous: before,
      current: after,
      delta,
      direction: directionOf(delta),
    };
  });
}

/**
 * Deltas je Scope, ueber `metrics_scope_id` aggregiert und ueber den
 * stabilen `matchKey` zwischen den Staenden zugeordnet (siehe
 * `ScopeReadingV1.matchKey`: die eindeutige `metrics_scope_id` ist
 * byte-range-basiert und ueber zwei Staende hinweg absichtlich nicht stabil).
 *
 * Nur Scopes, die in der Lesart `"execution_unit"` ein Summand sind, kommen
 * vor — sonst zaehlte dieselbe Aenderung zweimal, einmal an der Closure und
 * einmal an ihrer umschliessenden Funktion.
 *
 * Sortierung: Betrag absteigend, bei Gleichstand Metrik-Reihenfolge, dann
 * Codepoint-Ordnung des Labels. Nie `localeCompare`.
 */
export function scopeDeltas(
  previous: FileReadingV1 | undefined,
  current: FileReadingV1 | undefined,
  limit: number,
): ScopeDeltaV1[] {
  const before = indexSelected(previous);
  const after = indexSelected(current);
  const keys = new Set<string>([...before.keys(), ...after.keys()]);
  const deltas: ScopeDeltaV1[] = [];

  for (const key of keys) {
    const from = before.get(key);
    const to = after.get(key);
    for (const metric of METRIC_KEYS) {
      if (metric === "semantic") continue; // semantische Ladung ist keine Scope-Groesse
      const previousValue = from === undefined ? null : from.values[metric];
      const currentValue = to === undefined ? null : to.values[metric];
      const delta = (currentValue ?? 0) - (previousValue ?? 0);
      if (delta === 0) continue;
      const anchor = to ?? from;
      if (anchor === undefined) continue;
      deltas.push({
        metricsScopeId: anchor.metricsScopeId,
        label: anchor.label,
        kind: anchor.kind,
        line: anchor.line,
        metric,
        previous: previousValue,
        current: currentValue,
        delta,
        direction: directionOf(delta),
      });
    }
  }

  deltas.sort(
    (a, b) =>
      Math.abs(b.delta) - Math.abs(a.delta) ||
      METRIC_KEYS.indexOf(a.metric) - METRIC_KEYS.indexOf(b.metric) ||
      compareCodepoints(a.label, b.label) ||
      a.line - b.line,
  );
  return deltas.slice(0, limit);
}

function indexSelected(reading: FileReadingV1 | undefined): Map<string, ScopeReadingV1> {
  const map = new Map<string, ScopeReadingV1>();
  if (reading === undefined) return map;
  for (const scope of reading.scopes) {
    if (!scope.selected) continue;
    map.set(scope.matchKey, scope);
  }
  return map;
}

/**
 * Gesamtrichtung einer Aenderung ueber alle vier Metriken.
 *
 * ENTSCHEIDUNG: gezaehlt werden die Metriken, nicht die Betraege — die vier
 * Metriken haben keine gemeinsame Einheit (ein semantisches Delta von 240
 * geschaetzten Tokens ist nicht mit 13 kognitiven Punkten verrechenbar), eine
 * Summe ueber sie waere eine erfundene Zahl. Ueberwiegt keine Richtung, ist
 * das Urteil `"unveraendert"` — das ist ehrlicher als eine Scheinpraezision.
 */
export function verdictOf(deltas: readonly MetricDeltaV1[]): ComplexityDirection {
  let down = 0;
  let up = 0;
  for (const delta of deltas) {
    if (delta.direction === "abgebaut") down++;
    if (delta.direction === "aufgebaut") up++;
  }
  if (down > up) return "abgebaut";
  if (up > down) return "aufgebaut";
  return "unveraendert";
}

/**
 * Gesamtrichtung einer Netto-Bilanz. Zaehlt wie `verdictOf` die Metriken,
 * nicht die Betraege — aus demselben Grund: die vier haben keine gemeinsame
 * Einheit.
 */
export function netDirectionOf(net: MetricValues): ComplexityDirection {
  let down = 0;
  let up = 0;
  for (const metric of METRIC_KEYS) {
    if (net[metric] < 0) down++;
    if (net[metric] > 0) up++;
  }
  if (down > up) return "abgebaut";
  if (up > down) return "aufgebaut";
  return "unveraendert";
}

/** Addiert Metrikwerte (fuer die Netto-Bilanz der Sitzung). */
export function addMetricValues(
  base: MetricValues,
  deltas: readonly MetricDeltaV1[],
): MetricValues {
  const next: Record<MetricKey, number> = { ...zeroMetricValues(), ...base };
  for (const delta of deltas) next[delta.metric] += delta.delta;
  return next;
}
