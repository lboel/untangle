/**
 * Idempotency: what a second run would change.
 *
 * `init` compares the RENDERED text against the file on disk rather than
 * parsing the file back into a config object. That is a deliberate choice and
 * it buys three things at once:
 *
 * - it needs no TOML parser, so there is no second grammar to keep in step
 *   with the writer;
 * - it notices changes the user made BY HAND, including in the comments,
 *   which a value-level comparison would call "identical";
 * - it is only meaningful because `renderUntangleToml` is pure and carries no
 *   clock — otherwise every run would differ and the check would be theatre.
 *
 * The comparison is a line diff, so the report says which lines would be
 * added and which lost, not merely "the file differs".
 */

import type { ConfigChangeV1 } from "./types.js";

/** Above this line count the diff degrades to a set comparison (see `diffLines`). */
const LCS_LINE_BUDGET = 2_000;

/** Splits into lines, dropping the single trailing empty element of a final newline. */
export function toLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Line diff, longest-common-subsequence based.
 *
 * The dynamic-programming table is O(n·m); both sides are a configuration
 * file, so that is a few hundred by a few hundred. Above `LCS_LINE_BUDGET`
 * the function falls back to a multiset comparison — less precise about
 * ORDER, but still exact about which lines appear on only one side, and it
 * cannot be made to allocate gigabytes by a pathological input.
 */
export function diffLines(before: readonly string[], after: readonly string[]): ConfigChangeV1[] {
  if (before.length > LCS_LINE_BUDGET || after.length > LCS_LINE_BUDGET) {
    return multisetDiff(before, after);
  }

  const rows = before.length;
  const columns = after.length;
  // table[i][j] = length of the LCS of before[i…] and after[j…]
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0),
  );
  for (let i = rows - 1; i >= 0; i -= 1) {
    const row = table[i] as number[];
    const nextRow = table[i + 1] as number[];
    for (let j = columns - 1; j >= 0; j -= 1) {
      row[j] =
        before[i] === after[j]
          ? (nextRow[j + 1] as number) + 1
          : Math.max(nextRow[j] as number, row[j + 1] as number);
    }
  }

  const changes: ConfigChangeV1[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (before[i] === after[j]) {
      i += 1;
      j += 1;
      continue;
    }
    const row = table[i] as number[];
    const nextRow = table[i + 1] as number[];
    if ((nextRow[j] as number) >= (row[j + 1] as number)) {
      changes.push({ kind: "removed", line: (before[i] as string).trimEnd() });
      i += 1;
    } else {
      changes.push({ kind: "added", line: (after[j] as string).trimEnd() });
      j += 1;
    }
  }
  for (; i < rows; i += 1) {
    changes.push({ kind: "removed", line: (before[i] as string).trimEnd() });
  }
  for (; j < columns; j += 1) {
    changes.push({ kind: "added", line: (after[j] as string).trimEnd() });
  }
  return changes;
}

function multisetDiff(before: readonly string[], after: readonly string[]): ConfigChangeV1[] {
  const counts = new Map<string, number>();
  for (const line of before) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const changes: ConfigChangeV1[] = [];
  for (const line of after) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) {
      counts.set(line, remaining - 1);
    } else {
      changes.push({ kind: "added", line: line.trimEnd() });
    }
  }
  for (const [line, remaining] of counts) {
    for (let index = 0; index < remaining; index += 1) {
      changes.push({ kind: "removed", line: line.trimEnd() });
    }
  }
  return changes;
}

/** True when the file on disk already IS what `init` would write. */
export function isUnchanged(existing: string, rendered: string): boolean {
  return existing === rendered;
}
