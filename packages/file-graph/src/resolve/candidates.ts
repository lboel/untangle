/**
 * Kandidatenbildung: aus einem Pfad ohne Erweiterung die Liste der Dateien,
 * die gemeint sein koennen — in fester Reihenfolge.
 *
 * DREI DINGE, DIE HIER PASSIEREN und ohne die jeder zweite Import dieses
 * Repositories „unresolved" waere:
 *
 * 1. ERWEITERUNGSPROBE. `"./util"` kann `util.ts`, `util.tsx`, `util.js`,
 *    … oder `util/index.ts` meinen.
 *
 * 2. RUECKABBILDUNG DER ESM-ENDUNG. TypeScript unter `NodeNext` schreibt
 *    `import "./registry.js"` und meint `registry.ts`. Wer nur exakt
 *    vergleicht, findet in einem modernen TypeScript-Monorepo praktisch
 *    keinen einzigen relativen Import.
 *
 * 3. RUECKABBILDUNG DER BUILD-AUSGABE. Eine `exports`-Map zeigt auf
 *    `dist/index.js`. Im Quellindex gibt es nur `src/index.ts`. Mit
 *    `rootDir`/`outDir` aus der Projektkonfiguration wird daraus wieder eine
 *    Quelldatei — und der Workspace-Import zeigt auf echten Quelltext statt
 *    auf ein Artefakt, das gar nicht indiziert ist.
 *
 * Jede Probe, die NICHT getroffen hat, wird mitgefuehrt und landet als
 * `rejectedCandidates` an der unaufgeloesten Kante (E4): wer die Aufloesung
 * spaeter debuggt, sieht, wonach gesucht wurde.
 */
import { basenameOf, extensionOf, joinRelative, normalizePath, relativeWithin } from "../paths.js";
import type { ResolveContextV1, WorkspacePackageV1 } from "../types.js";

/** Erweiterungen in Probierreihenfolge. Quelltext vor Build-Ausgabe. */
export const DEFAULT_EXTENSION_ORDER = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".py",
  ".vue",
] as const;

/**
 * Endung, wie sie im Spezifizierer steht → Endungen, die tatsaechlich gemeint
 * sein koennen. Die geschriebene Endung steht bewusst mit in der Liste, denn
 * es gibt Projekte, in denen `./bundle.js` wirklich `bundle.js` meint.
 *
 * WELCHE ZUERST PROBIERT WIRD, haengt an der Sprache der QUELLDATEI
 * (`preferSourceExtension`): in einer TypeScript-Datei meint `./util.js`
 * unter `NodeNext` die Datei `util.ts`, also gewinnt dort die Quellendung.
 * In einer JavaScript-Datei ist `./util.js` woertlich gemeint, also gewinnt
 * dort die geschriebene Endung. Liegen `util.ts` und `util.js` nebeneinander,
 * ist das der einzige Fall, in dem die Reihenfolge ueberhaupt zaehlt — und
 * dann ist sie so, wie der jeweilige Uebersetzer sie auch waehlt.
 */
export const ESM_EXTENSION_REMAP: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx", ".d.ts", ".js"],
  ".jsx": [".tsx", ".jsx"],
  ".mjs": [".mts", ".d.mts", ".mjs"],
  ".cjs": [".cts", ".d.cts", ".cjs"],
};

/** Erweiterungen, die als „nicht ausfuehrbarer Inhalt" gelten (spec.md §19/§20). */
export const ASSET_EXTENSIONS = new Set([
  ".avif",
  ".css",
  ".gif",
  ".graphql",
  ".ico",
  ".jpeg",
  ".jpg",
  ".less",
  ".md",
  ".mdx",
  ".png",
  ".sass",
  ".scss",
  ".svg",
  ".txt",
  ".webp",
  ".woff",
  ".woff2",
]);

/** Ergebnis einer Kandidatenprobe. */
export interface CandidateProbeV1 {
  /** Gefundener repo-relativer Pfad; `null`, wenn keine Probe traf. */
  path: string | null;
  /** Alle geprueften Pfade in Probierreihenfolge — auch der Treffer. */
  tried: string[];
}

/**
 * Bildet alle Kandidatenpfade zu einem Basispfad, ohne den Index zu befragen.
 * Reihenfolge ist Teil des Vertrags: sie entscheidet, welche Datei gewinnt,
 * wenn mehrere existieren.
 */
export function candidatePaths(
  basePath: string,
  extensionOrder: readonly string[] = DEFAULT_EXTENSION_ORDER,
  options: { preferSourceExtension?: boolean } = {},
): string[] {
  const preferSourceExtension = options.preferSourceExtension ?? true;
  const normalized = normalizePath(basePath);
  const candidates: string[] = [];
  const push = (candidate: string): void => {
    if (!candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  };

  const written = extensionOf(normalized);
  if (written !== "") {
    const remap = ESM_EXTENSION_REMAP[written];
    if (remap === undefined || !preferSourceExtension) {
      push(normalized);
    }
    if (remap !== undefined) {
      const stem = normalized.slice(0, normalized.length - written.length);
      for (const extension of remap) {
        push(`${stem}${extension}`);
      }
      push(normalized);
    }
    // Ein Punkt im Namen ist NICHT immer eine Erweiterung: `./vitest.config`
    // meint `vitest.config.ts`. Deshalb wird nur dann noch eine Erweiterung
    // angehaengt, wenn der geschriebene Suffix keine bekannte ist — sonst
    // entstuenden Unsinnskandidaten wie `context.js.cts`, die die
    // `rejectedCandidates` unlesbar machen.
    if (!isKnownExtension(written, extensionOrder)) {
      for (const extension of extensionOrder) {
        push(`${normalized}${extension}`);
      }
    }
    // Auch ein Pfad mit Punkt kann ein Verzeichnis sein.
    for (const extension of extensionOrder) {
      push(`${normalized}/index${extension}`);
    }
    return candidates;
  }

  push(normalized);
  for (const extension of extensionOrder) {
    push(`${normalized}${extension}`);
  }
  for (const extension of extensionOrder) {
    push(`${normalized}/index${extension}`);
  }
  // Python: ein Paketverzeichnis wird ueber seine Initialisierungsdatei erreicht.
  push(`${normalized}/__init__.py`);
  return candidates;
}

/**
 * Bildet einen Pfad in der Build-Ausgabe eines Pakets auf den entsprechenden
 * Quellpfad ab. `null`, wenn der Pfad nicht in einer bekannten Build-Ausgabe
 * liegt oder das Paket keine Abbildung deklariert.
 */
export function reverseBuildOutput(
  packages: Iterable<WorkspacePackageV1>,
  repoId: string,
  path: string,
): string | null {
  const normalized = normalizePath(path);
  for (const entry of packages) {
    if (entry.repoId !== repoId) continue;
    if (entry.outDir === undefined || entry.rootDir === undefined) continue;
    const withinOutput = relativeWithin(entry.outDir, normalized);
    if (withinOutput === null || withinOutput === "") continue;
    const mapped = joinRelative(entry.rootDir, withinOutput);
    if (mapped !== null) {
      return mapped;
    }
  }
  return null;
}

/**
 * Sucht die erste existierende Datei zu einem Basispfad.
 *
 * Zuerst die direkten Kandidaten, danach — und nur, wenn keiner traf — die
 * ueber `rootDir`/`outDir` zurueckgebildeten. Diese Reihenfolge ist wichtig:
 * existiert die Build-Ausgabe wirklich im Index (weil jemand `dist/` mit
 * indiziert hat), gewinnt sie, und wir erfinden keine Quelldatei.
 */
export function probeCandidates(
  context: ResolveContextV1,
  repoId: string,
  basePath: string,
): CandidateProbeV1 {
  const tried: string[] = [];
  // In einer JavaScript-Quelle ist die geschriebene Endung woertlich gemeint;
  // in einer TypeScript-Quelle ist sie die Endung der BUILD-Ausgabe.
  const probeOptions = { preferSourceExtension: context.fromLanguageId !== "javascript" };
  const direct = candidatePaths(basePath, context.extensionOrder, probeOptions);
  for (const candidate of direct) {
    tried.push(candidate);
    if (context.files.hasFile(repoId, candidate)) {
      return { path: candidate, tried };
    }
  }
  const mapped = reverseBuildOutput(context.packageCatalog.all(), repoId, basePath);
  if (mapped === null) {
    return { path: null, tried };
  }
  for (const candidate of candidatePaths(mapped, context.extensionOrder, probeOptions)) {
    if (tried.includes(candidate)) continue;
    tried.push(candidate);
    if (context.files.hasFile(repoId, candidate)) {
      return { path: candidate, tried };
    }
  }
  return { path: null, tried };
}

function isKnownExtension(extension: string, extensionOrder: readonly string[]): boolean {
  return (
    extensionOrder.includes(extension) ||
    extension in ESM_EXTENSION_REMAP ||
    ASSET_EXTENSIONS.has(extension)
  );
}

/** True, wenn der Spezifizierer auf eine Nicht-Code-Ressource zeigt. */
export function isAssetSpecifier(specifier: string): boolean {
  const withoutQuery = specifier.split("?")[0] ?? specifier;
  return ASSET_EXTENSIONS.has(extensionOf(basenameOf(withoutQuery)));
}
