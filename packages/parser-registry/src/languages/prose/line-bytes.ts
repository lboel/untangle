/**
 * Zeilenanfaenge als UTF-8-Byte-Versaetze.
 *
 * `SourceRange` (domain `types/common.ts`) ist auf BYTES normativ; die
 * Prosa-Gliederung arbeitet in ZEILEN. Diese Tabelle ist die Uebersetzung.
 * Geschnitten wird ausschliesslich unmittelbar nach `\n` (0x0A) — ein
 * Einzelbyte, nie ein UTF-8-Folgebyte —, damit jede erzeugte Grenze eine
 * gueltige Zeichengrenze ist.
 */

export interface LineByteIndex {
  /** Byte-Versatz jedes Zeilenanfangs, plus ein Schlusswaechter = Dateigroesse. */
  readonly lineStarts: readonly number[];
  /** Anzahl physischer Zeilen. */
  readonly lineCount: number;
  readonly totalBytes: number;
}

export function buildLineByteIndex(content: string): LineByteIndex {
  const buffer = Buffer.from(content, "utf8");
  const lineStarts: number[] = [0];
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a) lineStarts.push(i + 1);
  }
  const lineCount = lineStarts.length;
  lineStarts.push(buffer.length);
  return { lineStarts, lineCount, totalBytes: buffer.length };
}

/** Byte-Versatz des Anfangs der 1-basierten Zeile `line`, geklemmt. */
export function lineStartByte(index: LineByteIndex, line: number): number {
  const clamped = Math.min(Math.max(line, 1), index.lineStarts.length);
  return index.lineStarts[clamped - 1] ?? index.totalBytes;
}

/**
 * `SourceRange` fuer die 1-basierte inklusive Zeilenspanne. `endByte` ist der
 * Anfang der Zeile NACH `endLine`, also sind zwei benachbarte Spannen
 * lueckenlos und ueberlappungsfrei.
 */
export function rangeForLines(
  index: LineByteIndex,
  startLine: number,
  endLine: number,
): { startLine: number; endLine: number; startByte: number; endByte: number } {
  return {
    startLine,
    endLine,
    startByte: lineStartByte(index, startLine),
    endByte: lineStartByte(index, endLine + 1),
  };
}
