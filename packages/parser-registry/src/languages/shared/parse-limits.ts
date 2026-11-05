/**
 * Eingabepuffer und Groessengrenze fuer die native tree-sitter-Bindung
 * (WP-215).
 *
 * DER DEFEKT: `Parser#parse(text)` reicht den Quelltext ueber eine
 * Rueckruffunktion an die native Seite; die Bindung kopiert den
 * zurueckgegebenen Abschnitt in einen Puffer FESTER Groesse. Ohne
 * `options.bufferSize` ist dieser Puffer 32 KiB gross (`tree-sitter@0.21.1`,
 * `binding.cc`). Eine Datei ueber 32 KiB passt nicht hinein und die Bindung
 * wirft `Invalid argument` — ohne Zeile, ohne Spalte, ohne Hinweis auf die
 * Groesse. Auf dem eigenen Repository scheiterten daran ACHT Dateien:
 * `packages/complexity/src/scope-aggregate.ts` (31.246 B) wurde noch
 * gerechnet, `packages/search/src/regex-safety.ts` (33.871 B) nicht mehr.
 *
 * DIE GEGENMASSNAHME: `bufferSize` proportional zur Eingabelaenge uebergeben.
 * Gemessen im Paketkontext an `regex-safety.ts` (33.806 Zeichen / 33.871 Bytes):
 *
 *     ohne bufferSize:  FEHLER — Invalid argument
 *     mit bufferSize:   OK, root program | Kinder 66 | hasError false
 *
 * WARUM EINE OBERGRENZE NOETIG IST: `bufferSize` waechst mit der Datei, der
 * Syntaxbaum ebenfalls — nur schneller. Gemessen in ISOLIERTEN Prozessen
 * (`maxRSS` aus `process.resourceUsage()`, tree-sitter-typescript, Node 26.7.0,
 * darwin/arm64), erst das reine `parse()`:
 *
 *     Bytes        parse    Spitzen-RSS
 *      1.082.765     62 ms    112 MiB
 *      4.213.735    268 ms    252 MiB
 *      8.396.927    495 ms    441 MiB
 *     16.803.534    964 ms    683 MiB
 *     33.576.525   3136 ms   1087 MiB
 *     67.141.068   3814 ms   1545 MiB
 *
 * `parse()` allein ist aber NICHT, was der Aufrufer bezahlt. Der Adapter legt
 * anschliessend `analyzeTree` darueber und materialisiert JS-Wrapper fuer jeden
 * Knoten (bei 1 MiB Quelltext sind das 216.406 Knoten). Dieselbe Messung ueber
 * die VOLLE Strecke `parse()` + `computeComplexity()`:
 *
 *     Bytes        gesamt    Spitzen-RSS   Scopes
 *      1.082.765    8.899 ms    276 MiB     1.162
 *      2.126.275   13.227 ms    389 MiB     2.280
 *      4.213.735   22.990 ms    585 MiB     4.516
 *      5.259.533   32.394 ms    673 MiB     5.634
 *      8.316.481   50.179 ms    966 MiB     8.902
 *
 * Der bestimmende Posten ist also der BAUMLAUF, nicht das Parsen — rund sechs
 * Sekunden je Megabyte. Wer diese Tabelle liest, soll die Grenze nicht fuer
 * billig halten: eine Datei DICHT an der Grenze kostet eine knappe Minute und
 * fast ein Gigabyte.
 *
 * DIE GRENZE: {@link MAX_PARSE_SOURCE_BYTES} = 8 MiB. Sie ist eine MAUER gegen
 * den Speicher, kein Leistungsversprechen. Begruendung:
 *   - Bei 8,3 MB liegt die gemessene Spitze bei 966 MiB und damit noch unter
 *     einem Gigabyte; darueber ist der Prozess auf einem Entwicklerrechner
 *     nicht mehr verlaesslich. Bei 33 MB kostet schon das blosse Parsen ueber
 *     1 GiB, die volle Strecke waere weit jenseits davon.
 *   - Sie liegt UEBER der Vorgabegrenze des Scanners (5 MiB, siehe
 *     `packages/scanner/src/discovery.ts`), damit der Parser bei
 *     Standardkonfiguration NIE die engere, unausgesprochene Grenze ist. Wer
 *     hier abgewiesen wird, hat die Scannergrenze bewusst angehoben und
 *     bekommt dafuer einen benannten Grund statt eines Absturzes.
 *   - Die groesste echte Quelldatei dieses Repositorys hat 83.062 Bytes; die
 *     Grenze ist damit rund das Hundertfache des real Vorkommenden. In der
 *     Praxis reisst sie nur generierter Code oder ein gebuendeltes Artefakt.
 *
 * NICHT GELOEST, und hier ausdruecklich vermerkt: die sechs Sekunden je
 * Megabyte im Baumlauf sind ein eigener Leistungsdefekt. Diese Grenze
 * verhindert nur, dass er in einen Speicherabsturz umschlaegt.
 *
 * Eine Datei ueber der Grenze wird NICHT stillschweigend uebersprungen: der
 * Adapter wirft `AdapterParseError` mit `kind: "file_too_large"` und der
 * GEMESSENEN Groesse, woraus der Aufrufer einen Ledger-Eintrag mit genau
 * diesem Grund baut (E4).
 */
import { AdapterParseError, classifyAdapterFailure } from "@untangle-code/domain";

import type { TsParser, TsTree } from "./tree-sitter-types.js";

/**
 * Vorgabegroesse des Eingabepuffers der nativen Bindung, in Bytes.
 * Alles darunter braucht `bufferSize` nicht — alles darueber schon.
 * Nur dokumentarisch und fuer Tests; der Aufrufpfad uebergibt IMMER `bufferSize`.
 */
export const NATIVE_DEFAULT_BUFFER_BYTES = 32 * 1024;

/** Gemessene Obergrenze fuer eine einzelne Quelldatei, in Bytes (Begruendung siehe Modulkopf). */
export const MAX_PARSE_SOURCE_BYTES = 8 * 1024 * 1024;

/**
 * Aufschlag auf die Eingabelaenge.
 *
 * Gemessen genuegte schon der Faktor 1,0 (`bufferSize === byteLength`) fuer
 * jede gepruefte Groesse. Der Aufschlag von 25 % ist die Sicherheitsmarge
 * gegen die Frage, ob die Bindung intern noch ein Terminierungszeichen oder
 * eine Ausrichtung braucht — er kostet bei 8 MiB Eingabe 2 MiB und ist damit
 * gegenueber den gemessenen 441 MiB Spitze nicht der bestimmende Posten.
 */
const BUFFER_HEADROOM = 1.25;

/** Untergrenze: nie kleiner als die native Vorgabe, sonst wird eine kleine Datei schlechter gestellt. */
const MIN_BUFFER_BYTES = NATIVE_DEFAULT_BUFFER_BYTES;

/** Laenge des Quelltexts in UTF-8-Bytes — NICHT in Zeichen: die Bindung puffert Bytes. */
export function sourceByteLength(source: string): number {
  return Buffer.byteLength(source, "utf8");
}

/** Der `bufferSize`-Wert fuer eine Eingabe dieser Bytelaenge. */
export function parseBufferSizeFor(byteLength: number): number {
  return Math.max(MIN_BUFFER_BYTES, Math.ceil(byteLength * BUFFER_HEADROOM));
}

/**
 * DER EINZIGE erlaubte Aufruf von `Parser#parse` in diesem Paket.
 *
 * Wer `parser.parse(text)` direkt aufruft, baut den 32-KiB-Defekt neu ein.
 * Diese Funktion (a) prueft die Groessengrenze VOR dem Parsen, (b) uebergibt
 * `bufferSize` und (c) verwandelt jede Ausnahme der Bindung in einen
 * `AdapterParseError` mit benanntem Grund (WP-216), damit kein
 * Bibliothekstext mehr als "Grund" durchgereicht wird.
 */
export function parseWithBuffer(parser: TsParser, source: string): TsTree {
  const byteLength = sourceByteLength(source);

  if (byteLength > MAX_PARSE_SOURCE_BYTES) {
    throw new AdapterParseError(
      "file_too_large",
      `Source text with ${String(byteLength)} bytes exceeds the parser limit of ` +
        `${String(MAX_PARSE_SOURCE_BYTES)} Bytes.`,
      { measurements: { sizeBytes: byteLength, limitBytes: MAX_PARSE_SOURCE_BYTES } },
    );
  }

  try {
    return parser.parse(source, undefined, { bufferSize: parseBufferSizeFor(byteLength) });
  } catch (error) {
    const failure = classifyAdapterFailure(error, { sizeBytes: byteLength });
    // Weitergereicht wird der ROHE Ausnahmetext, nicht `failure.detail`: der
    // Aufrufer klassifiziert erneut, und ein bereits ausformuliertes Detail
    // wuerde dabei ein zweites Mal in "(Ausnahmetext: …)" eingewickelt.
    // Der benannte `kind` ueberlebt in der Klasse, nicht im Text.
    throw new AdapterParseError(failure.kind, failure.rawMessage, {
      measurements: { ...failure.measurements, bufferSize: parseBufferSizeFor(byteLength) },
      cause: error,
    });
  }
}
