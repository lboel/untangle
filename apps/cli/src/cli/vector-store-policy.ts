/**
 * WP-222 — DIE EINE STELLE, DIE ENTSCHEIDET, WELCHER VEKTORSPEICHER BENUTZT
 * WERDEN DARF.
 *
 * Vorher stand diese Regel zweimal im Werkzeug, und die zwei Fassungen
 * widersprachen sich in einer Sicherheitsfrage:
 *
 *   `untangle init`   kannte spec.md §3.2 und prueft den ueblichen
 *                     Standardport eines fremden Vektorspeichers
 *                     ABSICHTLICH NICHT. Es schrieb den Grund sogar in die
 *                     erzeugte Konfiguration.
 *   `untangle doctor` kannte die Regel nicht. Es liess `qdrant.mode =
 *                     "managed"` vom Speicheradapter aufloesen, der ohne
 *                     `url` auf denselben Standardport zurueckfiel, fand
 *                     dort eine FREMDE Instanz mit fremden Daten, meldete
 *                     "[OK ] Qdrant — Erreichbar" und empfahl, dorthin zu
 *                     indizieren.
 *
 * Zwei Befehle desselben Werkzeugs, zwei Antworten, und die gefaehrlichere
 * gewann: der Nutzer folgt dem Diagnosewerkzeug, nicht dem Kommentar in
 * einer Datei. Die Ursache war nicht, dass eine der beiden Fassungen falsch
 * war — die Ursache war, dass es ZWEI gab.
 *
 * Also: hier steht sie einmal. `init` bezieht von hier, welche Adressen es
 * ueberhaupt anfassen darf; `doctor` und jeder andere Befehl bekommen ihren
 * Speicher ueber `cli/workspace.ts`, das vor dem Verdrahten hier fragt. Wer
 * eine dritte Fassung schreibt, muss diese Datei umgehen — und das faellt
 * auf.
 *
 * DIE REGEL, in einem Satz: Untangle benutzt seinen EIGENEN verwalteten
 * Speicher, es sei denn, der Nutzer hat eine Adresse ausdruecklich benannt.
 * Ein Zurueckfallen auf eine fremde Vorgabeadresse gibt es nicht.
 */

import type { QdrantConfig } from "@untangle-code/config";

import { OperationalError } from "./exit.js";

/**
 * Der verwaltete Qdrant-REST-Port (spec.md §3.1). Dieser Dienst gehoert
 * Untangle: eigener Container, eigenes Volume. Auf ihn darf geschrieben
 * werden.
 */
export const MANAGED_QDRANT_URL = "http://127.0.0.1:16333";

/**
 * Adressen, die Untangle von sich aus NIEMALS annimmt.
 *
 * `6333` ist der Vorgabeport von Qdrant selbst und damit genau der Port, auf
 * dem auf einem Entwicklungsrechner die Instanz von JEMAND ANDEREM liegt —
 * mit den Daten von jemand anderem. spec.md §3.2 verbietet, in fremde
 * Infrastruktur einzugreifen. Eine Konfiguration, die diesen Port
 * stillschweigend uebernaehme, wuerde beim naechsten Befehl hineinschreiben.
 */
export const FOREIGN_DEFAULT_QDRANT_URLS: readonly {
  readonly url: string;
  readonly reason: string;
}[] = [
  {
    url: "http://127.0.0.1:6333",
    reason:
      "Default port of a foreign instance; spec.md §3.2 prohibits modifying foreign " +
      "services. Select it explicitly with UNTANGLE_QDRANT_URL; otherwise `untangle` starts " +
      "an owned instance on 16333 with its own volume.",
  },
];

/** Woher die Adresse kommt — das ist der ganze Unterschied. */
export type VectorStoreOrigin =
  | "embedded"
  /** Aus `qdrant.url` einer Konfigurationsdatei. Der Nutzer hat sie hingeschrieben. */
  | "configured"
  /** Aus `UNTANGLE_QDRANT_URL`. Der Nutzer hat sie benannt. */
  | "environment"
  /** Untangles eigener verwalteter Speicher (spec.md §3.1). */
  | "managed";

export interface VectorStoreDecision {
  /** Die Adresse, die benutzt werden darf — oder die abgelehnte. */
  readonly url: string;
  readonly origin: VectorStoreOrigin;
  readonly allowed: boolean;
  /** Bei `allowed === false`: warum nicht. Sonst: wie die Adresse zustande kam. */
  readonly reason: string;
  /** Bei `allowed === false` Pflicht: GENAU EIN naechster Schritt. */
  readonly nextStep?: string;
}

function normalize(url: string): string {
  return url.trim().replace(/\/+$/u, "");
}

/** Steht diese Adresse auf der Liste der fremden Vorgabeadressen? */
export function foreignDefaultFor(url: string): { url: string; reason: string } | undefined {
  const wanted = normalize(url);
  return FOREIGN_DEFAULT_QDRANT_URLS.find((entry) => normalize(entry.url) === wanted);
}

/**
 * Die Entscheidung.
 *
 * Warum das Feld `qdrant.url` als „ausdrueckliche Nennung" zaehlt: es hat
 * KEINE Produktvorgabe (`DEFAULT_QDRANT_CONFIG` setzt nur `mode`). Steht dort
 * etwas, dann hat es eine Nutzerebene hingeschrieben — eine Datei, die
 * Umgebung oder ein Argument. Genau das ist die Zustimmung, die spec.md §3.2
 * verlangt, bevor Untangle eine fremde Instanz anfasst.
 */
export function decideVectorStore(input: {
  qdrant: QdrantConfig;
  env: Readonly<Record<string, string | undefined>>;
}): VectorStoreDecision {
  const fromConfig = input.qdrant.url;
  if (fromConfig !== undefined && fromConfig.length > 0) {
    const foreign = foreignDefaultFor(fromConfig);
    return {
      url: fromConfig,
      origin: "configured",
      allowed: true,
      reason:
        foreign === undefined
          ? "explicitly configured as `qdrant.url`"
          : "explicitly configured as `qdrant.url`; selecting this foreign " +
            "selecting the default address is therefore an explicit user decision (spec.md §3.2)",
    };
  }

  const fromEnv = input.env["UNTANGLE_QDRANT_URL"];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return {
      url: fromEnv,
      origin: "environment",
      allowed: true,
      reason: "explicitly selected through UNTANGLE_QDRANT_URL",
    };
  }

  if (input.qdrant.mode === "external") {
    // Kein Zurueckfallen. „external" ohne Adresse ist ein Konfigurationsfehler
    // und wird als solcher gemeldet, nicht durch Raten geheilt.
    return {
      url: "",
      origin: "configured",
      allowed: false,
      reason: 'qdrant.mode is "external", but no `qdrant.url` is set.',
      nextStep:
        "Set your own instance's address as `qdrant.url`, or set " + 'qdrant.mode to "managed".',
    };
  }

  return {
    url: MANAGED_QDRANT_URL,
    origin: "managed",
    allowed: true,
    reason: "Untangle's owned managed store (spec.md §3.1, port 16333)",
  };
}

/**
 * Der Riegel.
 *
 * Er sitzt hinter der Entscheidung, weil eine Adresse auch auf anderem Wege
 * dort landen kann — ein kuenftiger Adapter mit eigener Vorgabe, eine
 * Migration, ein Tippfehler in einer Vorgabekonstanten. Wird eine fremde
 * Vorgabeadresse benutzt, OHNE dass sie jemand benannt hat, bricht der
 * Befehl ab statt hineinzuschreiben.
 */
export function assertVectorStoreAllowed(decision: VectorStoreDecision, resolvedUrl: string): void {
  if (!decision.allowed) {
    throw new OperationalError(decision.reason, decision.nextStep ?? "See `untangle init`.");
  }
  if (decision.origin !== "managed") {
    return;
  }
  const foreign = foreignDefaultFor(resolvedUrl);
  if (foreign === undefined) {
    return;
  }
  throw new OperationalError(
    `${resolvedUrl} is the default port of a foreign Qdrant instance and was not explicitly ` +
      `selected; Untangle will not take it over automatically. ${foreign.reason}`,
    `Set UNTANGLE_QDRANT_URL=${resolvedUrl} if this instance is yours; ` +
      `otherwise start an owned instance on ${MANAGED_QDRANT_URL}.`,
  );
}

/**
 * Welche Adressen `init` ueberhaupt anfassen darf — dieselbe Regel, von der
 * anderen Seite gelesen.
 *
 * `probe` sind die Adressen, an die eine (ausschliesslich lesende) Anfrage
 * gehen darf. `skipped` sind die bewusst ausgelassenen, JEWEILS MIT GRUND:
 * eine ausgelassene Pruefung ohne Begruendung waere ein stilles
 * Ueberspringen (E4), und genau dieses Schweigen hat `doctor` gefehlt.
 */
export function qdrantProbePlan(env: Readonly<Record<string, string | undefined>>): {
  probe: string[];
  skipped: { url: string; reason: string }[];
} {
  const configured = env["UNTANGLE_QDRANT_URL"];
  const probe =
    configured === undefined || configured.length === 0
      ? [MANAGED_QDRANT_URL]
      : normalize(configured) === normalize(MANAGED_QDRANT_URL)
        ? [MANAGED_QDRANT_URL]
        : [configured, MANAGED_QDRANT_URL];

  const probing = new Set(probe.map(normalize));
  const skipped = FOREIGN_DEFAULT_QDRANT_URLS.filter(
    (entry) => !probing.has(normalize(entry.url)),
  ).map((entry) => ({ ...entry }));

  return { probe, skipped };
}
