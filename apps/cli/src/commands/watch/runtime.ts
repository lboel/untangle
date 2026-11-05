/**
 * Die Laufzeitkanten des Waechters: Uhr, Zufall, Ignorierregeln, Ausgabe.
 *
 * Alles hier ist bewusst DUENN. Es ist der Kompositionswurzel-Anteil des
 * CLI — die Stelle, an der die reinen Pakete an echte Uhr, echten Zufall und
 * echte Dateien angeschlossen werden. Kein Paket unterhalb davon liest
 * jemals selbst die Uhr oder `node:fs` (siehe die Port-Dokumentation in
 * `packages/domain/src/ports.ts`).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, readFileSync, type WriteStream } from "node:fs";
import path from "node:path";

import type { Clock, Random } from "@untangle-code/domain";
import { createIgnoreEngine } from "@untangle-code/scanner";

/**
 * Wanduhrzeit fuer Protokollzeitstempel und die Buchfuehrung der Lock-Lease.
 * Ergebnisdaten (Metriken, Deltas) enthalten NIE eine Uhrzeit — dort waere
 * sie ein Determinismusbruch; hier ist sie genau der Zweck.
 */
export class SystemClock implements Clock {
  nowEpochMs(): number {
    // Die EINZIGE echte Uhrzeitablesung des Waechters, und zwar mit Absicht
    // an genau dieser Stelle: `SystemClock` IST die Umsetzung des
    // `Clock`-Ports. Jede andere Datei dieses Kommandos liest die Zeit nur
    // ueber den Port (`deps.clock`), damit ein Test sie durch eine feste Uhr
    // ersetzen kann. Dieselbe Ausnahme, dieselbe Begruendung wie in
    // `packages/storage-local/src/real-time.ts` und `@untangle-code/testkit`.
    // eslint-disable-next-line no-restricted-syntax -- siehe Begruendung darueber.
    return Date.now();
  }
  nowIso(): string {
    return new Date(this.nowEpochMs()).toISOString();
  }
}

/**
 * Kryptografischer Zufall fuer Lock-Datensatz-Ids. Ebenfalls kein Bestandteil
 * von Ergebnisdaten — `FileLockProvider` braucht eine eindeutige Kennung je
 * Lease, sonst koennte ein zweiter Prozess eine fremde Lease erneuern.
 */
export class CryptoRandom implements Random {
  nextFloat(): number {
    const buffer = randomBytes(6).readUIntBE(0, 6);
    return buffer / 2 ** 48;
  }
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`nextInt requires a positive integer; received ${maxExclusive}`);
    }
    return Math.floor(this.nextFloat() * maxExclusive);
  }
  bytes(length: number): Uint8Array {
    return new Uint8Array(randomBytes(length));
  }
  uuid(): string {
    return randomUUID();
  }
}

/**
 * Ignorierregeln fuer den Watcher.
 *
 * `RepoWatcher`/`reconcileTree` kennen absichtlich keine
 * `.gitignore`-Schichtung (siehe deren Modul-Doku: "a caller wiring a real
 * indexing pipeline is expected to pass an `ignore` backed by scanner's own
 * `IgnoreEngine`") — genau das passiert hier.
 *
 * DER EIGENE ZUSTANDSORDNER IST IMMER AUSGESCHLOSSEN. `.untangle/` steht zwar
 * in der `.gitignore` DIESES Repositories, aber darauf darf sich der Waechter
 * nicht verlassen: wird ein Unterverzeichnis ohne eigene `.gitignore` als
 * `--root` beobachtet, legt der Waechter dort seinen Lock ab, sieht die
 * Lock-Datei als Aenderung, erneuert die Lease, sieht die naechste Aenderung —
 * eine Rueckkopplung auf sich selbst. Der Ausschluss ist deshalb fest
 * verdrahtet und nicht ueber eine Regeldatei erschlagen.
 *
 * BEKANNTE GRENZE, ausdruecklich benannt statt verschwiegen: der Watcher
 * ruft das Praedikat mit einem Pfad auf, OHNE zu sagen, ob es ein
 * Verzeichnis ist (der `stat` folgt erst danach). Das Praedikat fragt die
 * `IgnoreEngine` deshalb in beiden Lesarten und ignoriert, sobald eine der
 * beiden ignoriert. Ausserdem wird nur die `.gitignore` der Baumwurzel als
 * Schicht gelegt, keine verschachtelten — der Scanner leistet das im
 * Indexlauf, der Waechter hier nicht.
 */
/** Der Zustandsordner des Waechters, relativ zum beobachteten Baum. */
export const STATE_DIR_NAME = ".untangle";

export function createIgnorePredicate(rootPath: string): (relativePath: string) => boolean {
  const engine = createIgnoreEngine();
  const rootGitignore = readFileIfPresent(path.join(rootPath, ".gitignore"));
  if (rootGitignore !== null) engine.pushGitignoreLayer("", rootGitignore);
  const rootUntangleignore = readFileIfPresent(path.join(rootPath, ".untangleignore"));
  if (rootUntangleignore !== null) engine.pushUntangleIgnoreLayer("", rootUntangleignore);

  const cache = new Map<string, boolean>();
  return (relativePath: string): boolean => {
    const cached = cache.get(relativePath);
    if (cached !== undefined) return cached;
    const decision =
      relativePath === STATE_DIR_NAME ||
      relativePath.startsWith(`${STATE_DIR_NAME}/`) ||
      engine.decide(relativePath, false).ignored ||
      engine.decide(relativePath, true).ignored;
    cache.set(relativePath, decision);
    return decision;
  };
}

function readFileIfPresent(absolutePath: string): string | null {
  try {
    return readFileSync(absolutePath, "utf8");
  } catch {
    return null;
  }
}

/** Wohin der Strom geht: stdout und, wenn gewuenscht, zusaetzlich eine Datei. */
export interface StreamSink {
  write(line: string): void;
  close(): Promise<void>;
}

export interface StreamSinkOptions {
  stdout: (chunk: string) => void;
  /** Absoluter Pfad der Mitschrift, oder `null`. */
  outPath: string | null;
}

export function createStreamSink(options: StreamSinkOptions): StreamSink {
  let file: WriteStream | null = null;
  if (options.outPath !== null) {
    file = createWriteStream(options.outPath, { flags: "a", encoding: "utf8" });
  }
  return {
    write(line: string): void {
      options.stdout(`${line}\n`);
      file?.write(`${stripAnsi(line)}\n`);
    },
    async close(): Promise<void> {
      const stream = file;
      if (stream === null) return;
      await new Promise<void>((resolve) => {
        stream.end(() => {
          resolve();
        });
      });
    },
  };
}

/**
 * Entfernt ANSI-Steuerzeichen fuer die Mitschrift. Eine Logdatei voller
 * Farbcodes ist keine Mitschrift.
 */
export function stripAnsi(text: string): string {
  // Es GEHT hier um ein Steuerzeichen: die Regel warnt vor einem versehentlich
  // in ein Muster geratenen Steuerzeichen, und genau dieses soll entfernt
  // werden.
  // eslint-disable-next-line no-control-regex -- siehe Begruendung darueber.
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

/** SHA-256-Hex, fuer die kurze Kennung des gemessenen Standes. */
export function shortDigest(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}
