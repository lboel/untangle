/**
 * Die Trennung von Nutzdaten und Diagnose.
 *
 * REGEL, die das ganze Werkzeug traegt: NUTZDATEN nach stdout, ALLES ANDERE
 * nach stderr. Nur so bleibt `untangle query --format=jsonl | jq` benutzbar,
 * waehrend Warnungen und Hinweise trotzdem sichtbar sind. Ein Hinweis auf
 * stdout wuerde die Pipe des Nutzers vergiften.
 */

export interface Io {
  /** Nutzdaten. */
  out(text: string): void;
  /** Diagnose, Warnungen, Fehler, Hilfetexte zu Fehlern. */
  err(text: string): void;
}

export const processIo: Io = {
  out(text) {
    process.stdout.write(text);
  },
  err(text) {
    process.stderr.write(text);
  },
};

/** Sammelt statt zu schreiben — fuer Tests. */
export class BufferIo implements Io {
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];

  out(text: string): void {
    this.stdout.push(text);
  }

  err(text: string): void {
    this.stderr.push(text);
  }

  get outText(): string {
    return this.stdout.join("");
  }

  get errText(): string {
    return this.stderr.join("");
  }
}

/** Eine Zeile nach stdout. */
export function line(io: Io, text = ""): void {
  io.out(`${text}\n`);
}

/** Eine Zeile nach stderr. */
export function note(io: Io, text = ""): void {
  io.err(`${text}\n`);
}
