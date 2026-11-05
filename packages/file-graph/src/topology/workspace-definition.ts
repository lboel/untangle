/**
 * Workspace-Definition und Globabgleich.
 *
 * Quellen fuer die Liste der Teilprojekte, in dieser Reihenfolge:
 * 1. `pnpm-workspace.yaml` (`packages:`) — das pnpm-Protokoll;
 * 2. `workspaces` im Wurzelmanifest (npm/Yarn).
 *
 * Der Globabgleich deckt genau das ab, was Workspace-Definitionen wirklich
 * benutzen: `*` (ein Segment), `**` (beliebig viele Segmente), `?` (ein
 * Zeichen) und ein fuehrendes `!` als Ausschluss. Ein vollstaendiger
 * Glob-Dialekt waere hier ueberdimensioniert — und ein NICHT unterstuetztes
 * Muster wird gemeldet statt still ignoriert (E4).
 */
import { compareCodepoints } from "@untangle-code/domain";
import { parse as parseYaml } from "yaml";

import { normalizePath } from "../paths.js";

export type WorkspaceDefinitionResult =
  { ok: true; globs: string[] } | { ok: false; error: string };

/** Liest die `packages:`-Liste einer pnpm-Workspace-Definition. */
export function parsePnpmWorkspace(text: string): WorkspaceDefinitionResult {
  let document: unknown;
  try {
    document = parseYaml(text) as unknown;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { ok: false, error: "workspace document root is not a mapping" };
  }
  const packages = (document as Record<string, unknown>)["packages"];
  if (packages === undefined) {
    return { ok: false, error: 'workspace document has no "packages" list' };
  }
  if (!Array.isArray(packages)) {
    return { ok: false, error: '"packages" is not a list' };
  }
  const globs = packages.filter((entry): entry is string => typeof entry === "string");
  if (globs.length !== packages.length) {
    return { ok: false, error: '"packages" contains non-string entries' };
  }
  return { ok: true, globs };
}

/** Zerlegt eine Globliste in Einschluesse und Ausschluesse. */
export interface GlobSelectionV1 {
  include: string[];
  exclude: string[];
}

export function splitGlobs(globs: readonly string[]): GlobSelectionV1 {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const glob of globs) {
    if (glob.startsWith("!")) {
      exclude.push(normalizePath(glob.slice(1)));
    } else {
      include.push(normalizePath(glob));
    }
  }
  return { include: include.sort(compareCodepoints), exclude: exclude.sort(compareCodepoints) };
}

/**
 * Uebersetzt ein Workspace-Glob in einen Regulaerausdruck ueber Pfadsegmente.
 *
 * `**` frisst beliebig viele Segmente einschliesslich null, `*` genau ein
 * Segment ohne `/`, `?` genau ein Zeichen ohne `/`. Alles andere wird
 * woertlich verglichen.
 */
export function globToRegExp(glob: string): RegExp {
  const normalized = normalizePath(glob);
  let pattern = "";
  let index = 0;
  while (index < normalized.length) {
    const char = normalized[index] as string;
    if (char === "*") {
      const isDoubleStar = normalized[index + 1] === "*";
      if (isDoubleStar) {
        // `a/**/b` und `a/**` sollen auch `a/b` bzw. `a` treffen.
        if (normalized[index + 2] === "/") {
          pattern += "(?:.*/)?";
          index += 3;
          continue;
        }
        pattern += ".*";
        index += 2;
        continue;
      }
      pattern += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      pattern += "[^/]";
      index += 1;
      continue;
    }
    pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  return new RegExp(`^${pattern}$`);
}

/** True, wenn `directory` von der Globauswahl erfasst wird. */
export function matchesGlobSelection(selection: GlobSelectionV1, directory: string): boolean {
  const candidate = normalizePath(directory);
  const included = selection.include.some((glob) => globToRegExp(glob).test(candidate));
  if (!included) {
    return false;
  }
  return !selection.exclude.some((glob) => globToRegExp(glob).test(candidate));
}
