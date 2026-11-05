/**
 * Projektkonfiguration (`tsconfig.json` und Verwandte) → Pfad-Aliase und
 * Ausgabeverzeichnisse.
 *
 * Zwei Dinge braucht der Dateigraph daraus:
 *
 * 1. `baseUrl` + `paths` — die Pfad-Aliase, die Schritt 3 der Resolver-
 *    Pipeline (architecture.md §16.2) aufloest.
 * 2. `rootDir` + `outDir` — die Rueckabbildung von Build-Ausgabe auf Quelle.
 *    Ohne sie zeigt jeder Workspace-Import ueber eine `exports`-Map auf
 *    `dist/index.js`, also auf eine Datei, die im Quellindex gar nicht
 *    vorkommt; die Kante waere dann „unresolved", obwohl das Ziel bekannt
 *    ist. Mit ihr wird `dist/index.js` zu `src/index.ts`.
 *
 * `extends` wird verfolgt, weil in einem Monorepo praktisch jede
 * Paketkonfiguration von einer gemeinsamen Basis erbt und `paths` fast immer
 * genau dort steht.
 */
import { dirnameOf, joinRelative, normalizePath } from "../paths.js";

import { isJsonObject, parseJsonc, stringField } from "./jsonc.js";

/** Ausgewertete Projektkonfiguration eines Verzeichnisses. */
export interface ProjectConfigV1 {
  /** repo-relativer Pfad der Konfigurationsdatei. */
  configPath: string;
  /** repo-relativ aufgeloester `baseUrl`; `undefined`, wenn nicht gesetzt. */
  baseUrl?: string;
  /** Aliasmuster → repo-relative Ziele. */
  paths: Record<string, string[]>;
  /** repo-relativ aufgeloester `rootDir`. */
  rootDir?: string;
  /** repo-relativ aufgeloester `outDir`. */
  outDir?: string;
  /** Konfigurationen, von denen geerbt wurde, in Erbfolge. */
  extendsChain: string[];
}

/** Eine einzelne, bereits gelesene Konfigurationsdatei. */
export interface RawProjectConfigV1 {
  /** repo-relativer Pfad. */
  path: string;
  text: string;
}

export type ProjectConfigResult =
  { ok: true; config: ProjectConfigV1; warnings: string[] } | { ok: false; error: string };

/**
 * Wertet eine Projektkonfiguration samt `extends`-Kette aus.
 *
 * `readConfig` liefert den Text einer Konfigurationsdatei oder `null`, wenn es
 * sie nicht gibt. Ein fehlendes `extends`-Ziel ist KEIN Abbruch, sondern eine
 * Warnung im Ergebnis — sonst verlieren wir wegen einer nicht eingecheckten
 * Basisdatei die Aliase des ganzen Pakets, ohne dass es jemand merkt (E4).
 */
export function resolveProjectConfig(
  configPath: string,
  readConfig: (path: string) => string | null,
): ProjectConfigResult {
  const warnings: string[] = [];
  const extendsChain: string[] = [];
  const seen = new Set<string>();

  // Von der Wurzel der Erbkette zum konkreten Projekt hin sammeln, damit
  // spaetere (spezifischere) Werte frueher gelesene ueberschreiben.
  const layers: { path: string; options: Record<string, unknown> }[] = [];

  let current: string | null = normalizePath(configPath);
  let depth = 0;
  while (current !== null) {
    if (seen.has(current)) {
      return { ok: false, error: `circular "extends" chain at ${current}` };
    }
    seen.add(current);
    depth += 1;
    if (depth > 32) {
      return { ok: false, error: `"extends" chain longer than 32 at ${current}` };
    }
    const text = readConfig(current);
    if (text === null) {
      if (layers.length === 0) {
        return { ok: false, error: `configuration file not found: ${current}` };
      }
      warnings.push(`extends target not found: ${current}`);
      break;
    }
    const parsed = parseJsonc(text);
    if (!parsed.ok) {
      if (layers.length === 0) {
        return { ok: false, error: `${current}: ${parsed.error}` };
      }
      warnings.push(`extends target unreadable (${current}): ${parsed.error}`);
      break;
    }
    if (!isJsonObject(parsed.value)) {
      warnings.push(`${current}: root is not a JSON object`);
      break;
    }
    const root = parsed.value;
    const options = isJsonObject(root["compilerOptions"]) ? root["compilerOptions"] : {};
    layers.push({ path: current, options });

    const extendsValue = stringField(root, "extends");
    if (extendsValue === undefined) {
      break;
    }
    const next = joinRelative(dirnameOf(current), extendsValue);
    if (next === null) {
      warnings.push(`extends target escapes the repository root: ${extendsValue}`);
      break;
    }
    extendsChain.push(next);
    // `extends` ohne Erweiterung meint eine JSON-Datei.
    current = /\.json$/i.test(next) ? next : `${next}.json`;
  }

  const config: ProjectConfigV1 = {
    configPath: normalizePath(configPath),
    paths: {},
    extendsChain,
  };

  // Von der Basis (letzte Schicht) zum Projekt (erste Schicht) anwenden.
  for (const layer of [...layers].reverse()) {
    const dir = dirnameOf(layer.path);
    const baseUrl = stringField(layer.options, "baseUrl");
    if (baseUrl !== undefined) {
      const resolved = joinRelative(dir, baseUrl);
      if (resolved === null) {
        warnings.push(`baseUrl escapes the repository root in ${layer.path}: ${baseUrl}`);
      } else {
        config.baseUrl = resolved;
      }
    }
    const rootDir = stringField(layer.options, "rootDir");
    if (rootDir !== undefined) {
      const resolved = joinRelative(dir, rootDir);
      if (resolved === null) {
        warnings.push(`rootDir escapes the repository root in ${layer.path}: ${rootDir}`);
      } else {
        config.rootDir = resolved;
      }
    }
    const outDir = stringField(layer.options, "outDir");
    if (outDir !== undefined) {
      const resolved = joinRelative(dir, outDir);
      if (resolved === null) {
        warnings.push(`outDir escapes the repository root in ${layer.path}: ${outDir}`);
      } else {
        config.outDir = resolved;
      }
    }
    const pathsValue = layer.options["paths"];
    if (isJsonObject(pathsValue)) {
      // `paths` ist relativ zu `baseUrl`, ersatzweise zum Verzeichnis der
      // Datei, in der `paths` steht (TypeScript-Verhalten seit 4.1).
      const anchor = config.baseUrl ?? dir;
      for (const [pattern, targets] of Object.entries(pathsValue)) {
        if (!Array.isArray(targets)) {
          warnings.push(`paths["${pattern}"] in ${layer.path} is not an array`);
          continue;
        }
        const resolvedTargets: string[] = [];
        for (const target of targets) {
          if (typeof target !== "string") {
            warnings.push(`paths["${pattern}"] in ${layer.path} contains a non-string target`);
            continue;
          }
          const resolved = joinRelative(anchor, target);
          if (resolved === null) {
            warnings.push(`paths["${pattern}"] target escapes the repository root: ${target}`);
            continue;
          }
          resolvedTargets.push(resolved);
        }
        config.paths[pattern] = resolvedTargets;
      }
    }
  }

  return { ok: true, config, warnings };
}
