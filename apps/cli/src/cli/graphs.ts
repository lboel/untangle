/**
 * Der LESEWEG zu den beiden Graphen — die Stelle, die `untangle graph` und
 * `untangle flow` bisher gefehlt hat.
 *
 * `untangle index` baut Datei- und Symbolgraph und legt sie ueber den
 * `GraphStore`-Port workspace- und generationsgebunden ab. Der zuletzt
 * geschriebene, namespacete Symbolsnapshot ist zugleich der Publish-Marker
 * fuer das zusammengehoerige Graphpaar. Dieses Modul holt beide zurueck.
 *
 * DREI ENTSCHEIDUNGEN:
 *
 * 1. DIE GENERATION WIRD NICHT GERATEN. Gelesen wird der workspace-spezifische
 *    Publish-Marker. Seine validierte `generationId` ist danach die Generation
 *    ALLER weiteren Lesevorgaenge — sonst mischte eine Abfrage Knoten aus zwei
 *    Laeufen, und niemand saehe es.
 *
 * 2. EIN LOECHRIGES ABBILD WIRD GEMELDET, NICHT GEGLAETTET. `readGraphSnapshot`
 *    gibt seine Befunde als Daten zurueck (fehlender Datei-Shard, fehlender
 *    Pfadindex, Zahlen, die nicht zusammenpassen). Sie landen in
 *    {@link LoadedGraphsV1.issues} und gehen auf stderr — ein Graph, dem
 *    unbemerkt Knoten fehlen, ist schlimmer als gar keiner (E4).
 *
 * 3. „KEIN INDEX" IST NICHT „KEIN ERGEBNIS". Fehlt der Graph, endet der Befehl
 *    mit Exit-Code 4 und dem naechsten Schritt — nie mit einer leeren Liste
 *    und Exit-Code 0. Das ist derselbe Fehler, der in Welle 4 in `query`
 *    gefunden wurde.
 */

import type { GraphStore } from "@untangle-code/domain";
import {
  readGraphSnapshot,
  restoreFileGraph,
  type RestoredFileGraph,
  type SnapshotReadIssue,
} from "@untangle-code/file-graph";
import {
  readSymbolGraphSnapshot,
  symbolGraphSnapshotShardId,
  type SymbolGraphV1,
} from "@untangle-code/symbol-graph";

import { EnvironmentError, OperationalError } from "./exit.js";
import { errorMessage, loadWorkspace, wireStorage, type WorkspaceView } from "./workspace.js";

/**
 * Der Symbolgraph, wie er aus dem Shard zurueckkommt — samt expliziter Angabe,
 * ob sein Skip-Ledger aus demselben Snapshot stammt.
 *
 * Das aktuelle persistierte Format schreibt den vollständigen Symbolsnapshot
 * einschließlich Ledger und liefert deshalb `ledgerInShard: true`. Das Feld
 * bleibt im Vertrag sichtbar: ein zukünftiger Kompatibilitätspfad darf ein
 * fehlendes Ledger nicht als nachgewiesen leeres Ledger ausgeben (E4).
 */
export interface LoadedSymbolGraphV1 {
  graph: SymbolGraphV1;
  ledgerInShard: boolean;
}

export interface LoadedGraphsV1 {
  view: WorkspaceView;
  /** Generation, aus der ALLE gelesenen Shards stammen. */
  generationId: string;
  fileGraph: RestoredFileGraph;
  /** Befunde des Zurueckladens; leer heisst vollstaendig. */
  issues: readonly SnapshotReadIssue[];
  /** Null, wenn `untangle index` keinen Symbolgraphen abgelegt hat. */
  symbolGraph: LoadedSymbolGraphV1 | null;
  /** Pflicht, wenn `symbolGraph` null ist (E4). */
  symbolGraphMissingReason?: string;
}

export interface LoadGraphsOptions {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  /** Projektverzeichnis aus `--root`, bereits aufgeloest. */
  root?: string | undefined;
}

/** Laedt Datei- und Symbolgraph der neuesten vollstaendigen Generation. */
export async function loadGraphs(options: LoadGraphsOptions): Promise<LoadedGraphsV1> {
  const view = loadWorkspace({
    cwd: options.root ?? options.cwd,
    env: options.env,
    strict: true,
  });
  const storage = wireStorage(view, options.env);
  const store: GraphStore = storage.storage.graphStore;

  const generationId = await readPublishedGeneration(
    store,
    view.workspaceId,
    options.signal,
    storage.qdrantConfig.url,
  );
  const scope = { workspaceId: view.workspaceId, generationId };

  const { snapshot, issues } = await readGraphSnapshot(store, scope, { signal: options.signal });
  if (snapshot === null) {
    throw new EnvironmentError(
      `Could not reload file-graph generation "${generationId}": ` +
        issues.map((issue) => `${issue.kind}: ${issue.message}`).join("; "),
      "Rebuild the index with `untangle index`. Nothing was evaluated; this is not the same as an empty graph.",
    );
  }

  const symbol = await readSymbolGraph(store, scope, options.signal);

  return {
    view,
    generationId,
    fileGraph: restoreFileGraph(snapshot),
    issues,
    symbolGraph: symbol.graph,
    ...(symbol.missingReason === undefined
      ? {}
      : { symbolGraphMissingReason: symbol.missingReason }),
  };
}

async function readPublishedGeneration(
  store: GraphStore,
  workspaceId: string,
  signal: AbortSignal,
  storeUrl: string,
): Promise<string> {
  let shard;
  try {
    // Der namespacete Symbolgraph wird NACH dem Dateigraphen geschrieben und
    // ist damit der Publish-Marker des zusammengehoerigen Graphpaares. Ein
    // abgebrochener neuer Dateigraph kann diese Auswahl nicht verschieben.
    shard = await store.readShard("graph_meta", symbolGraphSnapshotShardId(workspaceId), {
      signal,
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new EnvironmentError(
      `The graph store at ${storeUrl} could not be read: ${errorMessage(error)}`,
      "Check the vector store with `untangle doctor`, then run `untangle index`.",
      { cause: error },
    );
  }
  if (shard === null) {
    throw new EnvironmentError(
      `In ${storeUrl} has no published graph pair for workspace "${workspaceId}". ` +
        `Nothing was evaluated; this does not ` +
        "mean there are no dependencies.",
      "Run `untangle index` to build and store file and symbol graphs.",
    );
  }
  if (shard.generationId === "") {
    throw new OperationalError(
      "The workspace-graph publish shard has no generation.",
      "Rebuild the index with `untangle index`.",
    );
  }
  if (
    shard.payload["workspaceId"] !== workspaceId ||
    shard.payload["graphGeneration"] !== shard.generationId
  ) {
    throw new OperationalError(
      "The workspace-graph publish shard conflicts with its workspace or generation scope.",
      "Rebuild the index with `untangle index`.",
    );
  }
  return shard.generationId;
}

async function readSymbolGraph(
  store: GraphStore,
  scope: { workspaceId: string; generationId: string },
  signal: AbortSignal,
): Promise<{ graph: LoadedSymbolGraphV1 | null; missingReason?: string }> {
  let result;
  try {
    result = await readSymbolGraphSnapshot(store, scope, { signal });
  } catch (error) {
    signal.throwIfAborted();
    return {
      graph: null,
      missingReason: `Could not read the symbol graph: ${errorMessage(error)}`,
    };
  }
  if (result.snapshot === null) {
    return {
      graph: null,
      missingReason: result.issues.map((issue) => `${issue.kind}: ${issue.message}`).join("; "),
    };
  }
  return { graph: { graph: result.snapshot, ledgerInShard: true } };
}
