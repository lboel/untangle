/**
 * Einstiegspunkt-Erkennung fuer den Call Flow (WP-88; spec.md §14.4 nennt sie,
 * `untangle flow` braucht sie).
 *
 * Das hier ist eine HEURISTIK und nichts anderes. Sie ist deshalb strukturell
 * als solche typisiert: `EntryPointV1.isHeuristic` ist auf das Literal `true`
 * festgenagelt und `confidence.basis` auf `"heuristic"` — dieselbe Bauart, die
 * `FindabilityDiagnosisV1` in der Domain benutzt. Jede erkannte Art traegt
 * eine Pflichtbegruendung; eine Heuristik ohne Begruendung ist eine
 * Behauptung.
 *
 * Vier Arten:
 * - `orphan`: kein einziger Aufrufer im aufgeloesten Graphen. Der klassische
 *   Startpunkt — und zugleich die unzuverlaessigste Art, weil ein fehlender
 *   Aufrufer auch heissen kann, dass die Aufloesung ihn nicht gefunden hat.
 * - `conventional_name`: der Name ist eine verbreitete Startkonvention.
 * - `test_symbol`: das Symbol steht in einer Testdatei; Tests sind der
 *   haeufigste reale Einstieg in eine Bibliothek.
 * - `framework_route`: der Pfad liegt in einem Verzeichnis, dessen Name
 *   ueblicherweise Routen/Endpunkte enthaelt. Bewusst pfadbasiert und ohne
 *   jeden Produktnamen (E2): Untangle erkennt hier eine Ablagekonvention,
 *   kein bestimmtes Rahmenwerk.
 */
import { compareCodepoints, uniqueSortedByCodepoints } from "@untangle-code/domain";

import type { SymbolGraphIndex } from "./graph-index.js";
import type {
  EntryPointDetectionOptions,
  EntryPointKind,
  EntryPointSetV1,
  EntryPointSignalV1,
  EntryPointV1,
} from "./types.js";
import { ENTRY_POINT_KINDS } from "./types.js";

/** Verbreitete Startnamen. Sprach- und produktneutral (E2). */
export const DEFAULT_CONVENTIONAL_ENTRY_NAMES: readonly string[] = [
  "bootstrap",
  "handler",
  "main",
  "run",
  "serve",
  "setup",
  "start",
];

/** Pfadmarker fuer Testdateien; geprueft auf dem kleingeschriebenen Pfad. */
export const DEFAULT_TEST_PATH_MARKERS: readonly string[] = [
  "-test.",
  ".spec.",
  ".test.",
  "/__tests__/",
  "/spec/",
  "/test/",
  "/tests/",
  "/test_",
  "_test.",
];

/** Verzeichnissegmente, die ueblicherweise Routen oder Endpunkte enthalten. */
export const DEFAULT_ROUTE_DIRECTORY_SEGMENTS: readonly string[] = [
  "api",
  "controllers",
  "endpoints",
  "handlers",
  "routes",
];

/**
 * Gewicht je Art. Bewusst niedrig: keine dieser Beobachtungen beweist einen
 * Einstiegspunkt, sie machen ihn nur wahrscheinlicher.
 */
export const ENTRY_POINT_WEIGHTS: Readonly<Record<EntryPointKind, number>> = {
  conventional_name: 0.6,
  test_symbol: 0.7,
  orphan: 0.45,
  framework_route: 0.4,
};

/** Obergrenze der kombinierten Confidence — eine Heuristik erreicht nie 1. */
export const MAX_ENTRY_POINT_CONFIDENCE = 0.95;

function normalizedPath(path: string): string {
  const lower = path.toLowerCase();
  return lower.startsWith("/") ? lower : `/${lower}`;
}

function matchedTestMarker(path: string, markers: readonly string[]): string | null {
  const haystack = normalizedPath(path);
  for (const marker of markers) {
    if (haystack.includes(marker)) return marker;
  }
  return null;
}

function matchedRouteSegment(path: string, segments: readonly string[]): string | null {
  const parts = normalizedPath(path).split("/");
  // Das letzte Segment ist der Dateiname und zaehlt nicht als Verzeichnis.
  const directories = parts.slice(0, Math.max(0, parts.length - 1));
  for (const segment of segments) {
    if (directories.includes(segment)) return segment;
  }
  return null;
}

/**
 * Kombiniert die Einzelgewichte zu einer Confidence:
 * `1 - Π(1 - gewicht)`, gedeckelt auf {@link MAX_ENTRY_POINT_CONFIDENCE}.
 * Zwei schwache Belege ergeben so mehr als einer, aber nie Gewissheit.
 */
export function combineEntryPointWeights(weights: readonly number[]): number {
  let complement = 1;
  for (const weight of weights) complement *= 1 - weight;
  return Math.min(MAX_ENTRY_POINT_CONFIDENCE, 1 - complement);
}

/** Erkennt Einstiegspunkte im gebauten Graphen. */
export function detectEntryPoints(
  index: SymbolGraphIndex,
  options: EntryPointDetectionOptions = {},
): EntryPointSetV1 {
  const conventionalNames = new Set(
    (options.conventionalNames ?? DEFAULT_CONVENTIONAL_ENTRY_NAMES).map((name) =>
      name.toLowerCase(),
    ),
  );
  const testMarkers = options.testPathMarkers ?? DEFAULT_TEST_PATH_MARKERS;
  const routeSegments = options.routeDirectorySegments ?? DEFAULT_ROUTE_DIRECTORY_SEGMENTS;
  const eligibleKinds =
    options.eligibleSymbolKinds === undefined ? null : new Set(options.eligibleSymbolKinds);

  const countsByKind = {} as Record<EntryPointKind, number>;
  for (const kind of ENTRY_POINT_KINDS) countsByKind[kind] = 0;

  const entryPoints: EntryPointV1[] = [];

  for (const node of index.nodes()) {
    if (eligibleKinds !== null && !eligibleKinds.has(node.kind)) continue;

    const signals: EntryPointSignalV1[] = [];

    if (index.inDegree(node.id) === 0) {
      signals.push({
        kind: "orphan",
        reason: `no resolved call edge in this graph targets "${node.qualifiedName}"; it is either a real entry point or a target the resolver did not reach`,
        weight: ENTRY_POINT_WEIGHTS.orphan,
      });
    }
    if (conventionalNames.has(node.name.toLowerCase())) {
      signals.push({
        kind: "conventional_name",
        reason: `the symbol name "${node.name}" is a conventional entry-point name`,
        weight: ENTRY_POINT_WEIGHTS.conventional_name,
      });
    }
    const testMarker = matchedTestMarker(node.filePath, testMarkers);
    if (testMarker !== null) {
      signals.push({
        kind: "test_symbol",
        reason: `the file path "${node.filePath}" matches the test marker "${testMarker}"`,
        weight: ENTRY_POINT_WEIGHTS.test_symbol,
      });
    }
    const routeSegment = matchedRouteSegment(node.filePath, routeSegments);
    if (routeSegment !== null) {
      signals.push({
        kind: "framework_route",
        reason: `the file lies in a "${routeSegment}" directory, a common placement for routes or endpoints; this recognizes a layout convention, not a specific framework`,
        weight: ENTRY_POINT_WEIGHTS.framework_route,
      });
    }

    if (signals.length === 0) continue;

    signals.sort((a, b) => compareCodepoints(a.kind, b.kind));
    for (const signal of signals) countsByKind[signal.kind] += 1;
    const kinds = uniqueSortedByCodepoints(
      signals.map((signal) => signal.kind),
    ) as EntryPointKind[];

    entryPoints.push({
      schemaVersion: 1,
      symbolId: node.id,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      repoId: node.repoId,
      isHeuristic: true,
      kinds,
      signals,
      confidence: {
        value: combineEntryPointWeights(signals.map((signal) => signal.weight)),
        basis: "heuristic",
        signals: kinds,
      },
    });
  }

  entryPoints.sort((a, b) => compareCodepoints(a.symbolId, b.symbolId));
  return { schemaVersion: 1, isHeuristic: true, entryPoints, countsByKind };
}
