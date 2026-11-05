/**
 * Deterministische Ordnungshilfen (docs/BUILD_PLAN.md §3, Regel „Determinismus").
 *
 * `String#localeCompare` ist verboten: die Sortierung haengt von der Locale der
 * Maschine ab, und eine locale-abhaengige Reihenfolge erzeugt je nach Rechner
 * andere Listen, andere kanonische JSON-Dokumente und damit andere IDs. Alle
 * Sortierungen in Untangle vergleichen deshalb Unicode-Codepoints.
 */

/**
 * Vergleicht zwei Strings anhand ihrer Unicode-Codepoints (`<` / `>`), nicht
 * anhand einer Locale. Rueckgabe wie bei `Array#sort`: negativ, 0, positiv.
 */
export function compareCodepoints(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Kopiert `values` und sortiert die Kopie nach Codepoints. */
export function sortByCodepoints(values: readonly string[]): string[] {
  return [...values].sort(compareCodepoints);
}

/**
 * Kopiert `values`, entfernt Duplikate und sortiert nach Codepoints. Ergebnis
 * ist die kanonische Form einer Menge von Strings (Filterwerte, ID-Listen).
 */
export function uniqueSortedByCodepoints(values: readonly string[]): string[] {
  return sortByCodepoints([...new Set(values)]);
}

/** True, wenn `values` bereits aufsteigend nach Codepoints sortiert ist. */
export function isSortedByCodepoints(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCodepoints(values[index - 1] as string, values[index] as string) > 0) {
      return false;
    }
  }
  return true;
}

/**
 * Vergleicht zwei Objekte anhand einer Schluesselfolge: erst nach `keys[0]`,
 * bei Gleichstand nach `keys[1]` usw. Alle verglichenen Werte sind Strings —
 * numerische Felder werden vorher vom Aufrufer formatiert (feste Breite), weil
 * eine Mischung aus Zahl- und Stringvergleich nicht stabil dokumentierbar ist.
 */
export function compareByKeys<T>(keys: readonly (keyof T)[], a: T, b: T): number {
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (typeof left !== "string" || typeof right !== "string") {
      throw new TypeError(`compareByKeys expects string fields, key "${String(key)}" is not`);
    }
    const result = compareCodepoints(left, right);
    if (result !== 0) {
      return result;
    }
  }
  return 0;
}
