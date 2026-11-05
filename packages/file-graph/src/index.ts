/**
 * `@untangle-code/file-graph` — der Dateiabhaengigkeitsgraph (spec.md §14,
 * architecture.md §16).
 *
 * Beantwortet drei Fragen:
 * - Welche Datei haengt von welcher ab (`dependenciesOf`)?
 * - Wer bricht, wenn ich diese Datei aendere (`dependentsOf`)?
 * - Wie haengen die Teilprojekte eines Monorepos zusammen
 *   (`loadWorkspaceTopology`: Pakete UND Container-Dienste)?
 *
 * Dieses Modul ist der EINZIGE oeffentliche Export des Pakets.
 */

// Pfadhilfen (POSIX, repo-relativ)
export * from "./paths.js";

// Vertraege des Pakets
export * from "./types.js";

// Dateiverzeichnis der Aufloesung
export * from "./file-index.js";

// Zuordnung Datei → Paket / Container-Dienst
export * from "./assignment.js";

// Topologie: Manifeste, Projektkonfigurationen, Workspace-Definition, Compose
export * from "./topology/jsonc.js";
export * from "./topology/manifest.js";
export * from "./topology/project-config.js";
export * from "./topology/workspace-definition.js";
export * from "./topology/compose.js";
export * from "./topology/load.js";

// Modulaufloesung
export * from "./resolve/candidates.js";
export * from "./resolve/package-exports.js";
export * from "./resolve/resolvers.js";
export * from "./resolve/pipeline.js";

// Kanten, Metriken, Graph
export * from "./edges.js";
export * from "./metrics.js";
export * from "./graph.js";

// Die Traversierung als freie Funktion — sie bedient den gebauten UND den
// zurueckgeladenen Graphen. `DEFAULT_TRAVERSAL_LIMITS` und `MonotonicClock`
// stehen bewusst NICHT hier, sondern kommen weiter aus `graph.js`: sie waren
// immer schon dort zu haben, und zwei Sternexporte desselben Namens waeren
// ein doppelter Ausgang fuer eine einzige Sache.
export { traverseFileGraph } from "./traverse.js";
export type { FileGraphNeighborhoodV1, TraverseFileGraphOptionsV1 } from "./traverse.js";

// Ablage ueber den bestehenden GraphStore-Port
export * from "./persistence.js";

// Lesepfad: aus einem Abbild wieder einen abfragbaren Graphen machen
export * from "./restore.js";
export * from "./boundaries/index.js";
