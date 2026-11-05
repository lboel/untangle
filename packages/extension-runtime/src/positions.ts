/**
 * Positionsabbildung Zeile → Byte-Range (extensions.md §7.1).
 *
 * Externe Werkzeuge liefern Zeilen und Spalten, Untangle rechnet in Bytes
 * (`SourceRange`: `startByte` inklusiv, `endByte` exklusiv). Die Uebersetzung
 * braucht den Dateiinhalt des Generationsstandes — deshalb ist sie ein
 * eingespritzter Aufloeser und keine Annahme im Parser.
 *
 * Kann eine Position NICHT aufgeloest werden, liefert der Aufloeser `null`.
 * Die Normalisierung erfindet dann KEINE Bytes, sondern schreibt einen
 * Skip-Ledger-Eintrag mit Grund und haelt den Rohbefund fest (E4).
 */
import type { SourceRange } from "@untangle-code/domain";

import type { RawPositionV1 } from "./formats/types.js";

/** Uebersetzt eine Werkzeugposition in einen Byte-Range, oder `null`. */
export type PositionResolver = (filePath: string, position: RawPositionV1) => SourceRange | null;

const encoder = new TextEncoder();

/** Byte-Laenge eines Strings in UTF-8. */
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Zeilenanfaenge einer Datei als Byte-Offsets. Index `i` ist der Offset der
 * (1-basierten) Zeile `i + 1`. `\r\n` und `\n` werden beide erkannt; der
 * Zeilenumbruch gehoert zur vorangehenden Zeile.
 */
export function buildLineOffsets(content: string): { offsets: number[]; lines: string[] } {
  const lines = content.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    // +1 fuer das entfernte "\n"; bei der letzten Zeile ohne Umbruch ist der
    // Wert nie wieder gefragt.
    offset += utf8Length(line) + 1;
  }
  return { offsets, lines };
}

/**
 * Baut einen {@link PositionResolver} ueber bekannte Dateiinhalte.
 *
 * Rein: `contents` bildet repo-relativen Pfad → Dateitext ab, es findet kein
 * I/O statt. Der Aufrufer entscheidet, woher die Inhalte kommen (Index-
 * Generation, Arbeitsverzeichnis, Test-Fixture).
 */
export function createLineOffsetResolver(contents: ReadonlyMap<string, string>): PositionResolver {
  const cache = new Map<string, { offsets: number[]; lines: string[] }>();
  return (filePath, position) => {
    const content = contents.get(filePath);
    if (content === undefined) {
      return null;
    }
    let index = cache.get(filePath);
    if (index === undefined) {
      index = buildLineOffsets(content);
      cache.set(filePath, index);
    }
    const { offsets, lines } = index;
    if (position.startLine > lines.length) {
      return null;
    }
    const endLine = Math.min(position.endLine, lines.length);
    const startLineText = lines[position.startLine - 1] ?? "";
    const endLineText = lines[endLine - 1] ?? "";
    const startLineOffset = offsets[position.startLine - 1] ?? 0;
    const endLineOffset = offsets[endLine - 1] ?? 0;

    const startColumnOffset =
      position.startColumn === undefined
        ? 0
        : utf8Length(startLineText.slice(0, Math.max(0, position.startColumn - 1)));
    // SARIF-Konvention: `endColumn` ist 1-basiert und EXKLUSIV.
    const endColumnOffset =
      position.endColumn === undefined
        ? utf8Length(endLineText)
        : utf8Length(endLineText.slice(0, Math.max(0, position.endColumn - 1)));

    const startByte = startLineOffset + startColumnOffset;
    const endByte = Math.max(startByte, endLineOffset + endColumnOffset);
    return { startLine: position.startLine, endLine, startByte, endByte };
  };
}

/**
 * Aufloeser, der nie aufloest. Kein Platzhalter aus Bequemlichkeit: er macht
 * den Fall „Dateiinhalt liegt nicht vor" sichtbar, statt ihn mit Nullbytes zu
 * kaschieren. Jeder Befund landet dann begruendet im Skip-Ledger (E4).
 */
export function createUnresolvedPositionResolver(): PositionResolver {
  return () => null;
}

/**
 * Byte-Range direkt aus einer Position, die das FORMAT bereits in Bytes
 * angibt (SARIF `region.byteOffset`/`byteLength`). Die genauere Angabe des
 * Werkzeugs gewinnt gegen jede Nachrechnung.
 */
export function sourceRangeFromByteOffsets(position: RawPositionV1): SourceRange | null {
  if (position.byteOffset === undefined) {
    return null;
  }
  const startByte = position.byteOffset;
  return {
    startLine: position.startLine,
    endLine: Math.max(position.endLine, position.startLine),
    startByte,
    endByte: startByte + (position.byteLength ?? 0),
  };
}
