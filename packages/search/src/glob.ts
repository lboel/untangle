/**
 * Deterministischer Glob-Abgleich fuer Pfad-Ein- und -Ausschluss
 * (Nutzerwunsch A4: „Pfad-Ein-/Ausschluss" wie ein grep-Werkzeug).
 *
 * Warum eine eigene, kleine Implementierung statt einer Bibliothek: der
 * Abgleich muss auf „/"-normalisierten, repo-relativen Pfaden arbeiten
 * (spec.md §5.2), darf keine Dateisystemzugriffe machen (wir globben ueber
 * INDIZIERTE Pfade, nicht ueber die Platte) und muss auf jeder Maschine
 * dieselbe Antwort geben. Die unterstuetzte Teilmenge ist bewusst klein und
 * hier vollstaendig dokumentiert:
 *
 * | Muster   | Bedeutung |
 * |---|---|
 * | `?`      | genau ein Zeichen, aber nie `/` |
 * | `*`      | beliebig viele Zeichen, aber nie `/` |
 * | `**`     | beliebig viele Zeichen inklusive `/` |
 * | `[abc]`  | eine Zeichenklasse, `[!abc]`/`[^abc]` negiert |
 * | sonst    | Literal |
 *
 * Ein Muster ohne `/` wird zusaetzlich gegen den BASENAMEN geprueft, damit
 * `*.ts` das tut, was jeder erwartet, ohne dass der Nutzer `**\/*.ts`
 * schreiben muss. Diese Bequemlichkeit ist eine bewusste Entscheidung und in
 * der README als solche vermerkt.
 */

/** Wandelt ein Glob-Muster in einen verankerten regulaeren Ausdruck. */
export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index] as string;
    if (char === "*") {
      const isDouble = pattern[index + 1] === "*";
      if (isDouble) {
        // `a/**/b` soll auch `a/b` treffen: der Schraegstrich hinter `**`
        // wird optional mitgeschluckt.
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 3;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close === -1) {
        // Unpaarige Klammer ist ein Literal, kein Fehler — ein Suchmuster
        // darf nicht daran scheitern, dass jemand `[` im Pfad meint.
        source += "\\[";
        index += 1;
        continue;
      }
      const body = pattern.slice(index + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      const content = negated ? body.slice(1) : body;
      source += `[${negated ? "^" : ""}${content.replace(/[\\\]]/g, "\\$&")}]`;
      index = close + 1;
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  source += "$";
  try {
    return new RegExp(source, "u");
  } catch (error) {
    // Ein fehlerhaftes Muster ist ein EINGABEFEHLER des Nutzers. Ohne diesen
    // Rahmen wandert der rohe `SyntaxError` durch den Abgleich bis in ein
    // catch, das ihn als Speicherausfall verbucht — der Nutzer bekaeme dann
    // „Provider nicht verfuegbar" fuer sein eigenes Zeichenklassenmuster.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`glob pattern "${pattern}" is not a valid pattern: ${message}`);
  }
}

/**
 * Prueft eine Musterliste, BEVOR sie benutzt wird.
 *
 * Warum vorab und nicht erst beim Abgleich: der Abgleich laeuft je Kandidat,
 * tief in der Auswertung. Ein Fehler dort trifft eine Stelle, die ihn nur noch
 * als „dieses Ziel hat nicht geantwortet" deuten kann. Vorab geprueft, ist er
 * das, was er ist: eine abgelehnte Anfrage mit benanntem Muster.
 */
export function assertValidGlobPatterns(patterns: readonly string[], label: string): void {
  for (const pattern of patterns) {
    try {
      globToRegExp(normalizeGlobPath(pattern));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`search query field "${label}" contains an invalid pattern: ${message}`);
    }
  }
}

/** Kanonisiert einen Pfad fuer den Abgleich: Backslashes zu `/`, kein `./`. */
export function normalizeGlobPath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  return slashed.startsWith("./") ? slashed.slice(2) : slashed;
}

/** True, wenn `path` auf `pattern` passt (siehe Modulkommentar). */
export function matchesGlob(path: string, pattern: string): boolean {
  const normalizedPath = normalizeGlobPath(path);
  const normalizedPattern = normalizeGlobPath(pattern);
  const expression = globToRegExp(normalizedPattern);
  if (expression.test(normalizedPath)) {
    return true;
  }
  if (!normalizedPattern.includes("/")) {
    const basename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
    return expression.test(basename);
  }
  return false;
}

/** True, wenn `path` auf mindestens eines der Muster passt. */
export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

/**
 * Entscheidet ueber Ein-/Ausschluss eines Pfades.
 *
 * - leere Einschlussliste heisst „alles einschliessen" (wie in SearchFiltersV1
 *   dokumentiert: eine leere Liste ist kein Filter);
 * - Ausschluss gewinnt immer gegen Einschluss.
 */
export function isPathSelected(
  path: string,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  if (exclude.length > 0 && matchesAnyGlob(path, exclude)) {
    return false;
  }
  if (include.length === 0) {
    return true;
  }
  return matchesAnyGlob(path, include);
}
