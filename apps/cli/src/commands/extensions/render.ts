/**
 * The two output shapes the extension commands share.
 *
 * Payload goes to stdout, everything else to stderr (see `cli/io.ts`), so
 * `--format=json | jq` stays usable while warnings remain visible.
 */
import { line, type Io } from "../../cli/io.js";

/** Writes one JSON document to stdout. */
export function emitJson(io: Io, value: unknown): void {
  line(io, JSON.stringify(value, null, 2));
}

/**
 * Renders a table padded to the widest cell per column. Padding counts code
 * units, which is what a fixed-width terminal measures for the ASCII
 * identifiers, SPDX ids and paths shown here.
 */
export function renderTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string[] {
  const widths = header.map((cell, column) =>
    rows.reduce((widest, row) => Math.max(widest, (row[column] ?? "").length), cell.length),
  );
  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [render(header), render(widths.map((width) => "-".repeat(width))), ...rows.map(render)];
}
