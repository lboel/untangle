/**
 * Pfadhilfen des Dateigraphen — ausschliesslich POSIX, ausschliesslich
 * repo-relativ.
 *
 * Warum eigene Helfer statt `node:path`: der Dateigraph rechnet nie auf
 * Betriebssystempfaden. Er kennt nur `"/"`-normalisierte, repo-relative
 * Pfade (spec.md §5.4), und `node:path` auf Windows wuerde aus `a/b`
 * beim Zusammensetzen `a\b` machen — damit haette dieselbe Codebasis auf
 * zwei Maschinen zwei verschiedene `file_id`s. `node:path/posix` deckt
 * einen Teil ab, liefert aber `".."`-Ergebnisse ausserhalb der Wurzel
 * still zurueck; hier wird das zu `null` und damit zu einem benannten
 * Fehlschlag (E4).
 */

/** Normalisiert Trennzeichen und entfernt fuehrende `"./"` sowie Mehrfachslashes. */
export function normalizePath(path: string): string {
  const forward = path.replace(/\\/g, "/");
  const collapsed = forward.replace(/\/{2,}/g, "/");
  const withoutLeadingDot = collapsed.startsWith("./") ? collapsed.slice(2) : collapsed;
  const withoutLeadingSlash = withoutLeadingDot.startsWith("/")
    ? withoutLeadingDot.slice(1)
    : withoutLeadingDot;
  return withoutLeadingSlash.endsWith("/") && withoutLeadingSlash.length > 1
    ? withoutLeadingSlash.slice(0, -1)
    : withoutLeadingSlash;
}

/** Verzeichnisanteil eines repo-relativen Pfades; `""` fuer Dateien in der Wurzel. */
export function dirnameOf(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

/** Dateiname ohne Verzeichnisanteil. */
export function basenameOf(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/** Erweiterung inklusive Punkt, kleingeschrieben; `""` bei Dotfiles und ohne Punkt. */
export function extensionOf(path: string): string {
  const name = basenameOf(path);
  const index = name.lastIndexOf(".");
  if (index <= 0) {
    return "";
  }
  return name.slice(index).toLowerCase();
}

/**
 * Setzt einen Basispfad und ein Segment zusammen und loest `.`/`..` auf.
 *
 * Gibt `null` zurueck, wenn die Aufloesung ueber die Repositorywurzel
 * hinauslaeuft. Ein Import wie `"../../../../etc/passwd"` aus `src/a.ts`
 * ist damit ein benannter Fehlschlag und kein still auf `etc/passwd`
 * gekuerzter Treffer.
 */
export function joinRelative(baseDir: string, segment: string): string | null {
  const base = normalizePath(baseDir);
  const parts = base === "" ? [] : base.split("/");
  const stack: string[] = [...parts];
  for (const raw of normalizePath(segment).split("/")) {
    if (raw === "" || raw === ".") {
      continue;
    }
    if (raw === "..") {
      if (stack.length === 0) {
        return null;
      }
      stack.pop();
      continue;
    }
    stack.push(raw);
  }
  return stack.join("/");
}

/** True, wenn `path` unterhalb von `directory` liegt (oder gleich ist). */
export function isWithin(directory: string, path: string): boolean {
  const dir = normalizePath(directory);
  const target = normalizePath(path);
  if (dir === "" || dir === ".") {
    return true;
  }
  return target === dir || target.startsWith(`${dir}/`);
}

/**
 * Pfad von `path` relativ zu `directory`; `null`, wenn `path` nicht darunter
 * liegt. Bewusst kein `..`-Ergebnis: der Aufrufer will hier wissen, ob etwas
 * INNERHALB eines Verzeichnisses liegt, nicht wie man hinaufkommt.
 */
export function relativeWithin(directory: string, path: string): string | null {
  if (!isWithin(directory, path)) {
    return null;
  }
  const dir = normalizePath(directory);
  const target = normalizePath(path);
  if (dir === "" || dir === ".") {
    return target;
  }
  return target === dir ? "" : target.slice(dir.length + 1);
}

/** True fuer `"./x"`, `"../x"` und `"."`/`".."` selbst. */
export function isRelativeSpecifier(specifier: string): boolean {
  return specifier === "." || specifier === ".." || /^\.\.?\//.test(specifier);
}

/**
 * Normalisiert nur die Trennzeichen und laesst einen fuehrenden `"/"` stehen.
 *
 * `normalizePath` ist fuer REPO-RELATIVE Pfade gedacht und entfernt deshalb
 * einen fuehrenden Schraegstrich. Auf einen absoluten Wurzelpfad angewandt
 * wuerde daraus ein relativer — und jeder Lesezugriff ginge ins Leere. Fuer
 * absolute Pfade (Repositorywurzeln, Eintraege des Dateisystemports) gilt
 * diese Funktion.
 */
export function normalizeSeparators(path: string): string {
  const forward = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return forward.length > 1 && forward.endsWith("/") ? forward.slice(0, -1) : forward;
}

/**
 * Pfad von `path` relativ zur absoluten Wurzel `root`; `null`, wenn `path`
 * nicht darunter liegt. Beide Angaben sind absolut.
 */
export function relativeToRoot(root: string, path: string): string | null {
  const normalizedRoot = normalizeSeparators(root);
  const normalizedPath = normalizeSeparators(path);
  if (normalizedPath === normalizedRoot) {
    return "";
  }
  const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : null;
}
