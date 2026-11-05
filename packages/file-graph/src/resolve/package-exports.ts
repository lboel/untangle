/**
 * Auswertung der `exports`- und `imports`-Karten eines Paketmanifests
 * (spec.md §14.3 „Node Package Exports").
 *
 * Was hier abgedeckt ist: die String-Kurzform, die Bedingungsobjekte
 * (`types`/`node`/`import`/`require`/`default`), die Subpfadkarte, die
 * Musterform mit `*`, Arrays als Fallbackliste und `null` als bewusste
 * Sperre eines Subpfads.
 *
 * BEDINGUNGSREIHENFOLGE: Laufzeitbedingungen kommen VOR `types`. Grund: ein
 * `types`-Treffer zeigt auf eine Deklarationsdatei (`.d.ts`), und die ist im
 * Quellindex eines Monorepos praktisch nie vorhanden — die Kante waere
 * unaufgeloest, obwohl das Paket eindeutig bestimmt ist. Ueber die
 * Laufzeitbedingung landet man auf der Build-Ausgabe, und die
 * `rootDir`/`outDir`-Rueckabbildung fuehrt von dort zur Quelldatei.
 *
 * `null` als Ziel ist KEIN „nicht gefunden": es ist die ausdrueckliche
 * Aussage des Paketautors, dass dieser Subpfad nicht importiert werden darf.
 * Das wird als eigener Grund gemeldet und nicht mit einem Fehlschlag
 * verwechselt (E4).
 */
import { joinRelative, normalizePath } from "../paths.js";
import type { WorkspacePackageV1 } from "../types.js";

/** Bedingungen in Auswertungsreihenfolge. */
export const DEFAULT_EXPORT_CONDITIONS = ["node", "import", "require", "default", "types"] as const;

/** Ergebnis der Subpfadauswertung. */
export type SubpathResolution =
  | { status: "target"; target: string; via: "exports" | "imports" | "manifest-field" | "direct" }
  | { status: "blocked"; detail: string }
  | { status: "no_match"; detail: string };

/**
 * Loest einen Subpfad eines Pakets auf einen repo-relativen Basispfad auf.
 *
 * `subpath` ist `"."` fuer den Paketwurzel-Import oder `"./unter/pfad"`.
 * Das Ergebnis ist ein Pfad OHNE Existenzpruefung — die uebernimmt
 * `probeCandidates`.
 */
export function resolvePackageSubpath(
  entry: WorkspacePackageV1,
  subpath: string,
  conditions: readonly string[] = DEFAULT_EXPORT_CONDITIONS,
): SubpathResolution {
  const normalizedSubpath = subpath === "" ? "." : subpath;

  if (entry.exports !== undefined) {
    const matched = matchExportsMap(entry.exports, normalizedSubpath, conditions);
    if (matched.status === "target") {
      const joined = joinRelative(entry.packageDir, matched.target);
      if (joined === null) {
        return {
          status: "no_match",
          detail: `exports target "${matched.target}" escapes the package directory "${entry.packageDir}"`,
        };
      }
      return { status: "target", target: joined, via: "exports" };
    }
    if (matched.status === "blocked") {
      return matched;
    }
    // Kein Subpfadtreffer in einer vorhandenen exports-Karte: das Paket
    // kapselt seinen Inhalt, der Import ist ungueltig. Kein stiller Rueckfall
    // auf den Verzeichnispfad — das waere geraten.
    return {
      status: "no_match",
      detail: `package "${entry.name}" declares "exports" but no entry matches subpath "${normalizedSubpath}"`,
    };
  }

  if (normalizedSubpath === ".") {
    for (const field of ["module", "main", "types"] as const) {
      const value = entry[field];
      if (value === undefined) continue;
      const joined = joinRelative(entry.packageDir, value);
      if (joined !== null) {
        return { status: "target", target: joined, via: "manifest-field" };
      }
    }
    const indexPath = joinRelative(entry.packageDir, "index");
    if (indexPath === null) {
      return {
        status: "no_match",
        detail: `package directory "${entry.packageDir}" is not usable`,
      };
    }
    return { status: "target", target: indexPath, via: "direct" };
  }

  const joined = joinRelative(entry.packageDir, normalizedSubpath);
  if (joined === null) {
    return {
      status: "no_match",
      detail: `subpath "${normalizedSubpath}" escapes the package directory "${entry.packageDir}"`,
    };
  }
  return { status: "target", target: joined, via: "direct" };
}

/** Loest einen `#`-Subpath-Import gegen die `imports`-Karte eines Pakets auf. */
export function resolvePackageImports(
  entry: WorkspacePackageV1,
  specifier: string,
  conditions: readonly string[] = DEFAULT_EXPORT_CONDITIONS,
): SubpathResolution {
  if (entry.imports === undefined) {
    return {
      status: "no_match",
      detail: `package "${entry.name}" declares no "imports" map for "${specifier}"`,
    };
  }
  const matched = matchExportsMap(entry.imports, specifier, conditions);
  if (matched.status !== "target") {
    return matched;
  }
  const joined = joinRelative(entry.packageDir, matched.target);
  if (joined === null) {
    return {
      status: "no_match",
      detail: `imports target "${matched.target}" escapes the package directory "${entry.packageDir}"`,
    };
  }
  return { status: "target", target: joined, via: "imports" };
}

type MapMatch =
  | { status: "target"; target: string }
  | { status: "blocked"; detail: string }
  | { status: "no_match"; detail: string };

function matchExportsMap(map: unknown, key: string, conditions: readonly string[]): MapMatch {
  // Kurzform: `"exports": "./dist/index.js"` gilt nur fuer ".".
  if (typeof map === "string") {
    return key === "."
      ? { status: "target", target: map }
      : { status: "no_match", detail: `string "exports" only covers subpath "."` };
  }
  if (map === null) {
    return { status: "blocked", detail: `"exports" is null — the package blocks all subpaths` };
  }
  if (Array.isArray(map)) {
    return selectFromList(map, key, conditions);
  }
  if (typeof map !== "object") {
    return { status: "no_match", detail: `"exports" is neither string, array nor object` };
  }

  const record = map as Record<string, unknown>;
  const keys = Object.keys(record);
  const isSubpathMap = keys.some(
    (entry) => entry === "." || entry.startsWith("./") || entry.startsWith("#"),
  );

  if (!isSubpathMap) {
    // Reines Bedingungsobjekt: gilt fuer ".".
    if (key !== ".") {
      return { status: "no_match", detail: `condition-only "exports" only covers subpath "."` };
    }
    return selectCondition(record, conditions);
  }

  const exact = record[key];
  if (exact !== undefined) {
    return resolveConditionValue(exact, conditions, key);
  }

  // Musterform: "./features/*": "./dist/features/*.js"
  let best: { pattern: string; value: unknown; captured: string } | null = null;
  for (const pattern of keys) {
    const starIndex = pattern.indexOf("*");
    if (starIndex === -1) continue;
    const prefix = pattern.slice(0, starIndex);
    const suffix = pattern.slice(starIndex + 1);
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    if (key.length < prefix.length + suffix.length) continue;
    const captured = key.slice(prefix.length, key.length - suffix.length);
    // Node waehlt bei mehreren Mustern das mit dem laengsten Praefix.
    if (best === null || prefix.length > best.pattern.indexOf("*")) {
      best = { pattern, value: record[pattern], captured };
    }
  }
  if (best === null) {
    return { status: "no_match", detail: `no "exports" entry matches "${key}"` };
  }
  const resolved = resolveConditionValue(best.value, conditions, key);
  if (resolved.status !== "target") {
    return resolved;
  }
  return { status: "target", target: resolved.target.split("*").join(best.captured) };
}

function resolveConditionValue(
  value: unknown,
  conditions: readonly string[],
  key: string,
): MapMatch {
  if (value === null) {
    return {
      status: "blocked",
      detail: `"exports" entry for "${key}" is null — import is forbidden`,
    };
  }
  if (typeof value === "string") {
    return { status: "target", target: value };
  }
  if (Array.isArray(value)) {
    return selectFromList(value, key, conditions);
  }
  if (typeof value === "object") {
    return selectCondition(value as Record<string, unknown>, conditions);
  }
  return { status: "no_match", detail: `"exports" entry for "${key}" has an unusable type` };
}

function selectFromList(
  list: readonly unknown[],
  key: string,
  conditions: readonly string[],
): MapMatch {
  const details: string[] = [];
  for (const candidate of list) {
    const resolved = resolveConditionValue(candidate, conditions, key);
    if (resolved.status === "target") {
      return resolved;
    }
    details.push(resolved.detail);
  }
  return {
    status: "no_match",
    detail: `no usable entry in "exports" array for "${key}" (${details.join("; ")})`,
  };
}

function selectCondition(record: Record<string, unknown>, conditions: readonly string[]): MapMatch {
  for (const condition of conditions) {
    if (!(condition in record)) continue;
    const value = record[condition];
    const resolved = resolveConditionValue(value, conditions, condition);
    if (resolved.status === "target" || resolved.status === "blocked") {
      return resolved;
    }
  }
  return {
    status: "no_match",
    detail: `none of the conditions [${conditions.join(", ")}] is present in [${Object.keys(record).join(", ")}]`,
  };
}

/** Zerlegt einen Paketspezifizierer in Paketname und Subpfad. */
export function splitPackageSpecifier(specifier: string): { name: string; subpath: string } | null {
  const normalized = normalizePath(specifier);
  if (normalized === "") {
    return null;
  }
  const segments = normalized.split("/");
  if (normalized.startsWith("@")) {
    if (segments.length < 2 || segments[1] === undefined || segments[1] === "") {
      return null;
    }
    const name = `${segments[0] as string}/${segments[1]}`;
    const rest = segments.slice(2).join("/");
    return { name, subpath: rest === "" ? "." : `./${rest}` };
  }
  const name = segments[0] as string;
  const rest = segments.slice(1).join("/");
  return { name, subpath: rest === "" ? "." : `./${rest}` };
}
