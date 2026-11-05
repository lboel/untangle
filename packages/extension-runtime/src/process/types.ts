/**
 * Die Prozessgrenze (extensions.md §3 X4, §6.4, §8, §10.2).
 *
 * ## Warum ueberhaupt eine Grenze
 *
 * Fremder Analysecode wird NIE gelinkt, gebuendelt oder in den
 * Untangle-Prozess geladen. Zulaessig sind ausschliesslich: ein eigenstaendiger
 * Prozess (Argumentarray, niemals eine Shell), ein Container, oder der Aufruf
 * einer HTTP-API.
 *
 * Das hat zwei Gruende, und beide sind hart:
 *
 * 1. **Lizenz.** Untangle ist AGPL-3.0-only (E1). Werkzeuge stehen unter
 *    anderen, teils einschraenkenden Lizenzen. Ueber eine Prozess- bzw.
 *    Netzgrenze werden ausschliesslich serialisierte Daten ausgetauscht — das
 *    ist blosse Aggregation getrennter Programme, kein kombiniertes Werk.
 *    Weder erstreckt sich die AGPL auf das Werkzeug, noch die Werkzeuglizenz
 *    auf Untangle. Wuerde fremder Code in unserem Prozess laufen, waere genau
 *    diese Argumentation hinfaellig.
 * 2. **Betrieb.** Ein abgestuerztes, speicherfressendes oder haengendes
 *    Werkzeug darf den Indexer nicht mitreissen. Zeit- und
 *    Ausgabegroessenbudget sind nur ausserhalb des eigenen Prozesses
 *    durchsetzbar.
 *
 * Deshalb gibt es hier einen PORT und keine Bibliothekseinbindung. Was der
 * Port ausfuehrt, ist ein Programmname plus Argumentarray — nie ein
 * Shell-String, in den sich etwas hineininterpretieren liesse.
 */

/** Zeitbudget je Lauf; Vorgabe aus extensions.md §10.2 (15 Minuten). */
export const DEFAULT_TIMEOUT_MS = 900_000;

/** Obergrenze der eingesammelten Ausgabe; Vorgabe aus extensions.md §5.4. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Frist zwischen freundlichem und hartem Abbruch eines Unterprozesses. */
export const DEFAULT_KILL_GRACE_MS = 5_000;

/** Ein Programmaufruf. `command` ist ein Programmname, kein Shell-String. */
export interface ProcessInvocationV1 {
  command: string;
  args: readonly string[];
  cwd?: string;
  /**
   * Umgebung des Unterprozesses. Geheimnisse gehoeren AUSSCHLIESSLICH hierhin,
   * nie in `args` — Argumente stehen in jeder Prozessliste des Systems
   * (extensions.md §6.4).
   */
  env?: Readonly<Record<string, string>>;
  /** Optionale Eingabe auf stdin. */
  stdin?: string;
}

/** Budgets eines Laufs (extensions.md §10.2). */
export interface ProcessLimitsV1 {
  timeoutMs: number;
  maxOutputBytes: number;
  /** Frist bis zum harten Kill nach dem Abbruchsignal. */
  killGraceMs?: number;
}

/** Vorgabebudgets. */
export function defaultProcessLimits(): ProcessLimitsV1 {
  return {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    killGraceMs: DEFAULT_KILL_GRACE_MS,
  };
}

/** Wie ein Lauf geendet hat. */
export const PROCESS_OUTCOMES = [
  "completed",
  "timeout",
  "cancelled",
  "output_limit_exceeded",
  "spawn_failed",
] as const;

export type ProcessOutcome = (typeof PROCESS_OUTCOMES)[number];

/** Ergebnis eines Laufs an der Prozessgrenze. */
export interface ProcessResultV1 {
  outcome: ProcessOutcome;
  /** `null`, wenn der Prozess durch ein Signal endete oder nie startete. */
  exitCode: number | null;
  /** Signalname, wenn der Prozess durch ein Signal endete. */
  signal: string | null;
  stdout: string;
  stderr: string;
  /** Wie viele Bytes stdout wirklich hatte, auch wenn gekuerzt wurde. */
  stdoutBytes: number;
  stderrBytes: number;
  /** True, wenn die Ausgabegrenze griff — nie stilles Kuerzen (E4). */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  wallTimeMs: number;
  /** Begruendung bei jedem `outcome` ausser `completed` (E4). */
  failureDetail?: string;
}

/**
 * Port fuer den Start eines externen Programms.
 *
 * Eine Implementierung MUSS: ohne Shell starten, das Zeitbudget ueber ein
 * Abbruchsignal durchsetzen, die Ausgabegroesse begrenzen und das Ergebnis
 * auch im Fehlerfall zurueckgeben statt zu werfen — eine gescheiterte
 * Extension ist kein Absturz des Kerns (X2).
 */
export interface ProcessRunnerPort {
  run(
    invocation: ProcessInvocationV1,
    limits: ProcessLimitsV1,
    options?: { signal?: AbortSignal },
  ): Promise<ProcessResultV1>;
}

/** Ergebnis eines HTTP-Aufrufs gegen eine laufende Werkzeug-API. */
export interface HttpResultV1 {
  outcome: ProcessOutcome;
  status: number | null;
  body: string;
  bodyBytes: number;
  bodyTruncated: boolean;
  wallTimeMs: number;
  failureDetail?: string;
}

/** Ein HTTP-Aufruf gegen eine bereits laufende Werkzeug-API (X4). */
export interface HttpInvocationV1 {
  url: string;
  method?: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

/** Port fuer den HTTP-Weg der Prozessgrenze. */
export interface HttpRunnerPort {
  request(
    invocation: HttpInvocationV1,
    limits: ProcessLimitsV1,
    options?: { signal?: AbortSignal },
  ): Promise<HttpResultV1>;
}

/**
 * Ersetzt Geheimniswerte durch `***` (extensions.md §8.5, Test 13.2.8).
 *
 * Wird auf jede Ausgabe angewandt, die in Logs, `status` oder einen
 * Konfigurationsabzug geraten koennte. Leere Werte werden uebersprungen —
 * sonst wuerde jede Zeichenluecke zu `***`.
 */
export function redactSecrets(text: string, secretValues: readonly string[]): string {
  let redacted = text;
  for (const value of secretValues) {
    if (value === "") {
      continue;
    }
    redacted = redacted.split(value).join("***");
  }
  return redacted;
}

/**
 * True, wenn `url` auf die Loopback-Schnittstelle zeigt (extensions.md §8.1).
 *
 * Ein Manifest mit `networkAccess: "loopback"` darf nur lokal sprechen; ein
 * Endpunkt im Netz waere ein unangekuendigter Datenabfluss.
 */
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
