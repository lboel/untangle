/**
 * Paketmanifest (`package.json`) → auswertbare Form.
 *
 * Nur die Felder, die fuer Aufloesung und Topologie zaehlen. Alles andere
 * bleibt unangetastet; `exports`/`imports` werden ABSICHTLICH als `unknown`
 * durchgereicht, weil ihre Grammatik (verschachtelte Bedingungen, Arrays,
 * Subpath-Muster) im Resolver ausgewertet wird und eine Vorab-Normalisierung
 * hier Information vernichten wuerde.
 */
import { compareCodepoints } from "@untangle-code/domain";

import { isJsonObject, parseJsonc, stringField, stringRecordField } from "./jsonc.js";

/** Abhaengigkeitsbloecke eines Manifests, in Auswertungsreihenfolge. */
export const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

/** Ausgewertetes Manifest. */
export interface ManifestV1 {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
  imports?: unknown;
  /** Block → (Paketname → Versionsangabe). */
  dependencies: Record<DependencyField, Record<string, string>>;
  /** `workspaces`-Feld (npm/Yarn), falls vorhanden. */
  workspaceGlobs: string[];
}

export type ManifestParseResult = { ok: true; manifest: ManifestV1 } | { ok: false; error: string };

/** Liest ein Manifest. Wirft nie — ein kaputtes Manifest ist ein Befund, kein Absturz. */
export function parseManifest(text: string): ManifestParseResult {
  const parsed = parseJsonc(text);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  if (!isJsonObject(parsed.value)) {
    return { ok: false, error: "manifest root is not a JSON object" };
  }
  const root = parsed.value;
  const dependencies = {} as Record<DependencyField, Record<string, string>>;
  for (const field of DEPENDENCY_FIELDS) {
    dependencies[field] = stringRecordField(root, field);
  }
  const manifest: ManifestV1 = {
    dependencies,
    workspaceGlobs: readWorkspaceGlobs(root),
  };
  const name = stringField(root, "name");
  if (name !== undefined) manifest.name = name;
  const version = stringField(root, "version");
  if (version !== undefined) manifest.version = version;
  const main = stringField(root, "main");
  if (main !== undefined) manifest.main = main;
  const moduleField = stringField(root, "module");
  if (moduleField !== undefined) manifest.module = moduleField;
  const types = stringField(root, "types");
  if (types !== undefined) manifest.types = types;
  if (root["exports"] !== undefined) manifest.exports = root["exports"];
  if (root["imports"] !== undefined) manifest.imports = root["imports"];
  return { ok: true, manifest };
}

/**
 * `workspaces` kennt zwei Schreibweisen: eine Liste von Globmustern und ein
 * Objekt mit `packages`. Beide werden gelesen — die Objektform stammt aus
 * Yarn und faellt sonst still unter den Tisch.
 */
function readWorkspaceGlobs(root: Record<string, unknown>): string[] {
  const value = root["workspaces"];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (isJsonObject(value) && Array.isArray(value["packages"])) {
    return (value["packages"] as unknown[]).filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  return [];
}

/**
 * True, wenn eine Versionsangabe auf ein Paket DESSELBEN Workspace zeigt.
 *
 * `workspace:*` ist das pnpm-/Yarn-Protokoll. `link:` und `file:` zeigen
 * ebenfalls in den Workspace, sind aber keine Katalogeintraege — sie werden
 * hier bewusst NICHT als Workspace-Abhaengigkeit gezaehlt, weil ihr Ziel ein
 * Pfad und kein Paketname ist; der Pfadfall gehoert in den Resolver, nicht in
 * die Topologie.
 */
export function isWorkspaceProtocol(range: string): boolean {
  return range.startsWith("workspace:");
}

/** Alle deklarierten Abhaengigkeiten, dedupliziert und codepoint-sortiert. */
export function declaredDependencyNames(manifest: ManifestV1): string[] {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest.dependencies[field])) {
      names.add(name);
    }
  }
  return [...names].sort(compareCodepoints);
}

/**
 * Versionsangabe eines Pakets im ersten Block, der es nennt. Reihenfolge ist
 * `DEPENDENCY_FIELDS`, damit dieselbe Antwort unabhaengig von der
 * Schluesselreihenfolge im JSON herauskommt.
 */
export function declaredRangeOf(
  manifest: ManifestV1,
  packageName: string,
): { field: DependencyField; range: string } | null {
  for (const field of DEPENDENCY_FIELDS) {
    const range = manifest.dependencies[field][packageName];
    if (range !== undefined) {
      return { field, range };
    }
  }
  return null;
}
