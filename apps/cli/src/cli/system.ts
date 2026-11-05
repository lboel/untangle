/**
 * Die Systemadapter der Ports, die praktisch jeder Befehl braucht.
 *
 * ZUR DETERMINISMUS-REGEL: `Date.now()` und `crypto.randomUUID()` stehen hier
 * — und NUR hier — hinter den Ports `Clock` und `Random`. Sie fliessen nie
 * ungefragt in Ergebnisdaten: die Uhr wird vom Abrufkern ausschliesslich fuer
 * den Recency-Boost und von Adaptern fuer Protokollstempel verwendet, der
 * Zufall nur fuer Korrelations-IDs. Wer deterministische Ergebnisse braucht,
 * injiziert stattdessen die Fakes des testkits — genau deshalb sind es Ports.
 */

import { getRandomValues, randomUUID } from "node:crypto";

import type { Clock, LogEvent, LoggerPort, Random } from "@untangle-code/domain";

/**
 * Die Systemuhr.
 *
 * `Date.now()` steht hier — und die Determinismusregel des Repos verbietet es
 * ueberall sonst. Das ist kein Widerspruch, sondern der Zweck: eine Regel, die
 * die Wanduhr aus der Analyse-Logik heraushaelt, braucht GENAU EINE Stelle, an
 * der die Wanduhr trotzdem gelesen wird. Diese ist es. Deshalb steht die
 * Ausnahme in `eslint.config.js` auf diese Datei beschraenkt und nicht als
 * `eslint-disable`-Kommentar im Code, wo sie sich unbemerkt ausbreiten wuerde.
 */
export const systemClock: Clock = {
  nowEpochMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

/**
 * Die Systemzufallsquelle.
 *
 * Bewusst `node:crypto` und NICHT `Math.random()`: der Port liefert unter
 * anderem `uuid()` fuer Korrelations- und Schreib-IDs, und dafuer ist ein
 * vorhersagbarer Generator die falsche Wahl. Dass die Determinismusregel
 * `Math.random()` ohnehin verbietet, faellt damit zusammen — der bessere Code
 * ist hier auch der regelkonforme.
 */
export const systemRandom: Random = {
  nextFloat: () => {
    // 53 Bit aus 8 Zufallsbytes: dieselbe Aufloesung, die ein Double traegt.
    const bytes = getRandomValues(new Uint8Array(8));
    let value = 0;
    for (const byte of bytes) value = value * 256 + byte;
    return value / 2 ** 64;
  },
  nextInt: (maxExclusive: number) => {
    if (maxExclusive <= 0) return 0;
    // Verwerfen statt Modulo: Modulo verzerrt, wenn 2^32 kein Vielfaches von
    // `maxExclusive` ist. Die Schleife endet mit Wahrscheinlichkeit 1.
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    for (;;) {
      const [draw] = getRandomValues(new Uint32Array(1));
      if (draw !== undefined && draw < limit) return draw % maxExclusive;
    }
  },
  bytes: (length: number) => getRandomValues(new Uint8Array(length)),
  uuid: () => randomUUID(),
};

/**
 * Ein Logger, der NUR nach stderr schreibt und standardmaessig schweigt.
 *
 * Grund: Protokollzeilen auf stdout wuerden die Nutzdaten der `--format=json`-
 * Ausgabe zerstoeren. Und ein Werkzeug, das ungefragt protokolliert, ist im
 * Terminal unbrauchbar — deshalb ist `error` die Vorgabestufe und `--verbose`
 * hebt sie an.
 */
const LEVEL_ORDER: Record<string, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

export function createStderrLogger(
  level: "error" | "warn" | "info" | "debug" | "trace",
  bindings: Readonly<Record<string, unknown>> = {},
): LoggerPort {
  const threshold = LEVEL_ORDER[level] ?? 0;
  const logger: LoggerPort = {
    log(event: LogEvent): void {
      const eventLevel = LEVEL_ORDER[event.level] ?? 0;
      if (eventLevel > threshold) return;
      process.stderr.write(`${JSON.stringify({ ...bindings, ...event })}\n`);
    },
    child(childBindings) {
      return createStderrLogger(level, { ...bindings, ...childBindings });
    },
  };
  return logger;
}
