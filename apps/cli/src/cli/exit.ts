/**
 * Exit codes and the error shapes that produce them.
 *
 * WARUM EIGENE CODES UND NICHT NUR 0/1: Der Nutzer will Untangle in eine
 * Schleife haengen („continuous complexity monitoring"). Eine Schleife muss
 * „das Werkzeug kann das noch nicht" von „die Umgebung laeuft nicht" und von
 * „die Schwelle wurde gerissen" unterscheiden koennen, ohne stderr zu parsen.
 * Genau dafuer sind die Codes belegt.
 *
 * BUILD_PLAN E4 gilt auch hier: {@link EXIT.unavailable} ist ein EIGENER Code,
 * damit eine noch nicht gebaute Faehigkeit nie wie ein Betriebsfehler aussieht
 * — und nie wie ein Erfolg.
 */

export const EXIT = {
  /** Alles gut. */
  ok: 0,
  /** Betriebsfehler: Datei unlesbar, Konfiguration ungueltig, Adapter warf. */
  operational: 1,
  /** Aufruffehler: unbekannter Befehl, unbekannte Option, fehlendes Argument. */
  usage: 2,
  /** Die Faehigkeit ist noch nicht gebaut. Kein Fehler des Nutzers. */
  unavailable: 3,
  /** Die Umgebung ist nicht bereit: Ollama/Qdrant nicht erreichbar, kein Index. */
  environment: 4,
  /** Eine Schwelle wurde gerissen (Quality Gate). Die Analyse selbst lief. */
  gate: 5,
  /** Abgebrochen (SIGINT/SIGTERM). */
  cancelled: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Ein Fehler, den die Oberflaeche selbst erzeugt hat.
 *
 * `nextStep` ist bewusst ein Pflichtfeld im Konstruktor jedes Untertyps, der
 * es tragen kann: eine Fehlermeldung ohne naechsten Schritt laesst den Nutzer
 * genau dort stehen, wo er nicht weiterkommt.
 */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly nextStep: string | undefined;

  constructor(
    message: string,
    exitCode: ExitCode,
    nextStep?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.name = "CliError";
    this.exitCode = exitCode;
    this.nextStep = nextStep;
  }
}

/** Falsch aufgerufen — unbekannter Befehl, unbekannte Option, fehlender Wert. */
export class UsageError extends CliError {
  constructor(message: string, nextStep?: string) {
    super(message, EXIT.usage, nextStep);
    this.name = "UsageError";
  }
}

/** Etwas ist schiefgegangen, das schiefgehen darf. */
export class OperationalError extends CliError {
  constructor(message: string, nextStep?: string, options?: { cause?: unknown }) {
    super(message, EXIT.operational, nextStep, options);
    this.name = "OperationalError";
  }
}

/**
 * Die Faehigkeit ist noch nicht gebaut.
 *
 * `reason` sagt, WAS fehlt und WO es hingehoert — nicht „nicht implementiert",
 * sondern die pruefbare Aussage. Ein Nutzer, der das liest, kann selbst
 * nachsehen, ob es inzwischen anders ist.
 */
export class UnavailableError extends CliError {
  constructor(message: string, nextStep: string) {
    super(message, EXIT.unavailable, nextStep);
    this.name = "UnavailableError";
  }
}

/** Die Umgebung ist nicht bereit. */
export class EnvironmentError extends CliError {
  constructor(message: string, nextStep: string, options?: { cause?: unknown }) {
    super(message, EXIT.environment, nextStep, options);
    this.name = "EnvironmentError";
  }
}
