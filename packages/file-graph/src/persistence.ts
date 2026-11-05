/**
 * Ablage des Dateigraphen ueber den BESTEHENDEN `GraphStore`-Port
 * (domain `ports.ts`, architecture.md §6.11, §11.6).
 *
 * ENTSCHEIDUNG: Dieses Paket definiert KEINEN eigenen Speicher-Port. Der
 * `GraphStore` von `domain` hat mit `graph_files`, `graph_indices` und
 * `graph_meta` genau die drei Sammlungen, die ein Dateigraph braucht, und es
 * gibt bereits eine Kontraktsuite (`@untangle-code/testkit`,
 * `runGraphStoreContract`) plus zwei Adapter dagegen. Ein zweiter Port haette
 * dieselbe Semantik ein zweites Mal beschrieben und beide Adapter zur
 * Doppelimplementierung gezwungen.
 *
 * SHARD-AUFTEILUNG:
 * - `graph_meta` / `<workspace>:meta` — Metriken, Topologie, Skip-Ledger, Knotenzahl;
 * - `graph_files` / `<workspace>:file:<file_id>` — ein Knoten samt seiner Kanten;
 * - `graph_indices` / `<workspace>:by-path` — Repository + Pfad → `file_id`.
 *
 * Ein Shard je Datei (statt eines Riesenshards) ist Absicht: die inkrementelle
 * Fortschreibung schreibt dann genau die Dateien zurueck, die sie neu gerechnet
 * hat.
 */
import type {
  FileEdgeV1,
  FileNodeV1,
  GraphShardV1,
  GraphStore,
  PortCallOptions,
} from "@untangle-code/domain";
import { compareCodepoints } from "@untangle-code/domain";

import { compareEdges } from "./edges.js";
import { normalizePath } from "./paths.js";
import type { FileGraphSnapshotV1 } from "./types.js";

/** Vor Wave 8 verwendete globale Metadaten-ID; nur fuer expliziten Legacy-Fallback. */
export const META_SHARD_ID = "meta";
/** Vor Wave 8 verwendete globale Pfadindex-ID; nur fuer expliziten Legacy-Fallback. */
export const PATH_INDEX_SHARD_ID = "by-path";
/** Versionierter Praefix der workspace-sicheren Dateigraph-Shards. */
export const FILE_GRAPH_SHARD_NAMESPACE = "untangle:file-graph:v1";

/** Der vollstaendige Geltungsbereich eines persistierten Graphabbilds. */
export interface GraphSnapshotScope {
  workspaceId: string;
  generationId: string;
}

/** Opt-in fuer das Lesen vor Wave 8 erzeugter, nicht namespaceter Shards. */
export interface GraphSnapshotReadOptions extends PortCallOptions {
  /**
   * Nur ein explizites `true` aktiviert den Legacy-Pfad. Auch dann wird der
   * gelesene Payload strikt gegen `workspaceId` UND `generationId` geprueft.
   */
  allowLegacyFallback?: boolean;
}

/** Praefix aller Dateigraph-Shards eines Workspace. */
export function fileGraphWorkspaceShardPrefix(workspaceId: string): string {
  assertIdentifier("workspaceId", workspaceId);
  return `${FILE_GRAPH_SHARD_NAMESPACE}:${String(workspaceId.length)}:${workspaceId}:`;
}

/** Namespacete ID des Metadaten-Shards. */
export function fileGraphMetaShardId(workspaceId: string): string {
  return `${fileGraphWorkspaceShardPrefix(workspaceId)}meta`;
}

/** Namespacete ID des Pfadindex-Shards. */
export function fileGraphPathIndexShardId(workspaceId: string): string {
  return `${fileGraphWorkspaceShardPrefix(workspaceId)}by-path`;
}

/** Namespacete ID eines Datei-Shards. */
export function fileGraphFileShardId(workspaceId: string, fileId: string): string {
  assertIdentifier("fileId", fileId);
  return `${fileGraphWorkspaceShardPrefix(workspaceId)}file:${fileId}`;
}

/** Erzeugt alle Shards eines Abbilds, in stabiler Reihenfolge. */
export function toGraphShards(snapshot: FileGraphSnapshotV1, writeId: string): GraphShardV1[] {
  assertFileGraphSnapshotScope(snapshot);
  assertIdentifier("writeId", writeId);

  const edgesByFrom = new Map<string, FileEdgeV1[]>();
  for (const edge of snapshot.edges) {
    const bucket = edgesByFrom.get(edge.fromFileId) ?? [];
    bucket.push(edge);
    edgesByFrom.set(edge.fromFileId, bucket);
  }

  const shards: GraphShardV1[] = [
    {
      logicalShardId: fileGraphMetaShardId(snapshot.workspaceId),
      collection: "graph_meta",
      generationId: snapshot.graphGeneration,
      writeId,
      payload: {
        persistenceSchemaVersion: 1,
        schemaVersion: snapshot.schemaVersion,
        workspaceId: snapshot.workspaceId,
        graphGeneration: snapshot.graphGeneration,
        nodeCount: snapshot.nodes.length,
        edgeCount: snapshot.edges.length,
        metrics: snapshot.metrics,
        topology: snapshot.topology,
        skipped: snapshot.skipped,
      },
    },
  ];

  const pathIndex: Record<string, string> = {};
  /**
   * WP-197: Zwei Knoten mit DEMSELBEN Repository-Pfad ueberschrieben einander
   * im Pfadindex — ohne Befund, ohne Ledger. Der Pfadindex ist aber genau der
   * Zeuge, aus dem `readGraphSnapshot` seine Erwartungsmenge bildet: die
   * verlorene `file_id` wurde damit auch beim Zurueckladen nie vermisst, und
   * `missing_file_shard` konnte sie nicht nennen. Der Verlust war doppelt
   * verdeckt. Jetzt behaelt der Index den ERSTEN (nach `file_id` kleinsten)
   * Eintrag — bestimmt und damit reproduzierbar — und die Kollision steht als
   * eigener Eintrag im Skip-Ledger des Abbilds.
   */
  const pathCollisions: { key: string; kept: string; dropped: string }[] = [];
  for (const node of [...snapshot.nodes].sort((left, right) =>
    compareCodepoints(left.fileId, right.fileId),
  )) {
    const key = pathKey(node.repoId, node.filePath);
    const existing = pathIndex[key];
    if (existing !== undefined) {
      pathCollisions.push({ key, kept: existing, dropped: node.fileId });
    } else {
      pathIndex[key] = node.fileId;
    }
    shards.push({
      logicalShardId: fileGraphFileShardId(snapshot.workspaceId, node.fileId),
      collection: "graph_files",
      generationId: snapshot.graphGeneration,
      writeId,
      payload: {
        persistenceSchemaVersion: 1,
        workspaceId: snapshot.workspaceId,
        graphGeneration: snapshot.graphGeneration,
        node,
        edges: (edgesByFrom.get(node.fileId) ?? []).sort(compareEdges),
      },
    });
  }

  shards.push({
    logicalShardId: fileGraphPathIndexShardId(snapshot.workspaceId),
    collection: "graph_indices",
    generationId: snapshot.graphGeneration,
    writeId,
    payload: {
      persistenceSchemaVersion: 1,
      workspaceId: snapshot.workspaceId,
      graphGeneration: snapshot.graphGeneration,
      pathIndex,
      // Die verdraengten `file_id`s stehen NEBEN dem Index, nicht in ihm: der
      // Index bleibt damit formgleich zu bisherigen Generationen, und der
      // Verlust ist trotzdem benannt und nachlesbar.
      ...(pathCollisions.length === 0 ? {} : { pathIndexCollisions: pathCollisions }),
    },
  });

  return shards;
}

/** Schreibt ein vollstaendiges Abbild in den Speicher. */
export async function writeGraphSnapshot(
  store: GraphStore,
  snapshot: FileGraphSnapshotV1,
  writeId: string,
  options?: PortCallOptions,
): Promise<void> {
  await store.writeShards(toGraphShards(snapshot, writeId), options);
}

/**
 * Fehler beim Zurueckladen — als Wert, damit der Aufrufer ihn ins Ledger legen
 * kann.
 *
 * `missing_path_index` und `count_mismatch` sind KEINE Zierde: ohne sie
 * verlaeuft der haeufigste Verlustfall (ein Datei-Shard ist nicht mehr da und
 * wird deshalb auch nicht mehr aufgezaehlt) voellig geraeuschlos. Der
 * Pfadindex und die im Metadaten-Shard mitgeschriebenen Sollzahlen sind die
 * beiden unabhaengigen Zeugen dafuer, WIE VIEL da sein muesste.
 */
export interface SnapshotReadIssue {
  kind:
    | "missing_meta"
    | "missing_path_index"
    | "missing_file_shard"
    | "malformed_payload"
    | "count_mismatch"
    | "workspace_scope_required"
    | "scope_mismatch";
  message: string;
}

export interface SnapshotReadResult {
  snapshot: FileGraphSnapshotV1 | null;
  issues: SnapshotReadIssue[];
}

interface GraphShardLayout {
  metaShardId: string;
  pathIndexShardId: string;
  fileShardId(fileId: string): string;
  ownsFileShard(shardId: string): boolean;
  legacy: boolean;
}

interface FileShardCandidate {
  shardId: string;
  expectedFileId: string | null;
}

/** Bound store pressure while avoiding one network roundtrip per file in series. */
const FILE_SHARD_READ_CONCURRENCY = 8;

async function readFileShards(
  store: GraphStore,
  candidates: readonly FileShardCandidate[],
  generationId: string,
  options: PortCallOptions,
): Promise<Array<FileShardCandidate & { shard: GraphShardV1 | null }>> {
  const loaded: Array<FileShardCandidate & { shard: GraphShardV1 | null }> = [];
  for (let offset = 0; offset < candidates.length; offset += FILE_SHARD_READ_CONCURRENCY) {
    options.signal?.throwIfAborted();
    const batch = candidates.slice(offset, offset + FILE_SHARD_READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (candidate) => ({
        ...candidate,
        shard: await store.readShard("graph_files", candidate.shardId, {
          ...options,
          generationId,
        }),
      })),
    );
    // Wait for this bounded batch to settle before propagating the first error
    // in candidate order. No later batch starts after a failure, and no read
    // outlives the call. Completion timing never changes issue/error ordering.
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      loaded.push(result.value);
    }
  }
  return loaded;
}

/**
 * Laedt ein Abbild fuer GENAU einen Workspace und GENAU eine Generation.
 *
 * Die alte Signatur `(store, generationId)` bleibt absichtlich typkompatibel,
 * liest aber nichts mehr: ohne Workspace kann kein gespeicherter Graph sicher
 * zugeordnet werden. Alte, globale Shards werden nur ueber
 * `allowLegacyFallback: true` gelesen, nachdem ein vollstaendiger Scope
 * angegeben wurde; jeder Payload wird dabei gegen diesen Scope geprueft.
 */
export async function readGraphSnapshot(
  store: GraphStore,
  scope: GraphSnapshotScope | string,
  options: GraphSnapshotReadOptions = {},
): Promise<SnapshotReadResult> {
  if (typeof scope === "string") {
    return {
      snapshot: null,
      issues: [
        {
          kind: "workspace_scope_required",
          message: `generation "${scope}" was supplied without a workspaceId; use { workspaceId, generationId } so graph reads cannot cross workspace boundaries`,
        },
      ],
    };
  }
  assertGraphSnapshotScope(scope);
  const { allowLegacyFallback, ...callOptions } = options;

  const scopedLayout: GraphShardLayout = {
    metaShardId: fileGraphMetaShardId(scope.workspaceId),
    pathIndexShardId: fileGraphPathIndexShardId(scope.workspaceId),
    fileShardId: (fileId) => fileGraphFileShardId(scope.workspaceId, fileId),
    ownsFileShard: (shardId) =>
      shardId.startsWith(`${fileGraphWorkspaceShardPrefix(scope.workspaceId)}file:`),
    legacy: false,
  };
  const scoped = await readGraphSnapshotFromLayout(store, scope, scopedLayout, callOptions);
  if (
    allowLegacyFallback !== true ||
    scoped.snapshot !== null ||
    scoped.issues.some((issue) => issue.kind !== "missing_meta")
  ) {
    return scoped;
  }

  return readGraphSnapshotFromLayout(
    store,
    scope,
    {
      metaShardId: META_SHARD_ID,
      pathIndexShardId: PATH_INDEX_SHARD_ID,
      fileShardId: (fileId) => fileId,
      ownsFileShard: () => true,
      legacy: true,
    },
    callOptions,
  );
}

/**
 * Eigentliche Rueckladung fuer eine namespacete oder explizit angeforderte
 * Legacy-Ablage. Kein Store-Aufruf verzichtet auf `generationId`.
 */
async function readGraphSnapshotFromLayout(
  store: GraphStore,
  scope: GraphSnapshotScope,
  layout: GraphShardLayout,
  options: PortCallOptions,
): Promise<SnapshotReadResult> {
  const issues: SnapshotReadIssue[] = [];
  const { generationId, workspaceId } = scope;
  const metaShard = await store.readShard("graph_meta", layout.metaShardId, {
    ...options,
    generationId,
  });
  if (metaShard === null) {
    issues.push({
      kind: "missing_meta",
      message: `graph_meta/${layout.metaShardId} is absent for workspace "${workspaceId}" and generation "${generationId}"`,
    });
    return { snapshot: null, issues };
  }
  const meta = metaShard.payload;

  // Der Metadaten-Shard traegt die Pflichtteile des Abbilds. Fehlt einer, kann
  // `FileGraphSnapshotV1` nicht erfuellt werden — dann ist `null` mit
  // benanntem Befund die einzige ehrliche Antwort. Ein Objekt mit
  // `metrics: undefined` an einen Aufrufer zu geben, der laut Vertrag
  // `snapshot.skipped.entries` lesen darf, ist ein verstecktes Loch (E4).
  const metaIssues = validateMetaPayload(meta, scope, layout.metaShardId, metaShard.generationId);
  if (metaIssues.length > 0) {
    issues.push(...metaIssues);
    return { snapshot: null, issues };
  }

  const nodes: FileNodeV1[] = [];
  const edges: FileEdgeV1[] = [];

  // Erwartungsmenge NICHT aus `listShardIds` ableiten: ein Shard, den es nicht
  // mehr gibt, wird schlicht nicht aufgezaehlt, und ein Vergleich der Liste mit
  // sich selbst kann nie etwas finden. Der Pfadindex ist der unabhaengige
  // Zeuge, welche `file_id`s zu dieser Generation gehoeren.
  const pathIndexShard = await store.readShard("graph_indices", layout.pathIndexShardId, {
    ...options,
    generationId,
  });
  if (pathIndexShard !== null) {
    issues.push(
      ...validatePayloadScope(
        pathIndexShard.payload,
        scope,
        `graph_indices/${layout.pathIndexShardId}`,
        pathIndexShard.generationId,
        layout.legacy,
      ),
    );
    if (issues.some((issue) => issue.kind === "scope_mismatch")) {
      return { snapshot: null, issues };
    }
  }
  // WP-197: Die beim Schreiben verdraengten `file_id`s stehen im Payload des
  // Pfadindex. Sie hier zu ueberlesen hiesse, den Verlust genau an der Stelle
  // zu verschweigen, an der er wirkt: `expectedFileIds` kennt sie nicht, also
  // koennte `missing_file_shard` sie auch nie vermissen.
  const collisions = pathIndexShard?.payload["pathIndexCollisions"];
  if (Array.isArray(collisions)) {
    for (const collision of collisions) {
      if (!isRecord(collision)) continue;
      issues.push({
        kind: "malformed_payload",
        message: `graph_indices/${layout.pathIndexShardId} of generation "${generationId}" records a path collision: "${String(collision["key"])}" maps to file id "${String(collision["kept"])}", so "${String(collision["dropped"])}" is NOT named by the path index and a missing shard for it could not be detected`,
      });
    }
  }
  const expectedFileIds = expectedFileIdsOf(pathIndexShard?.payload);
  if (expectedFileIds === null) {
    issues.push({
      kind: "missing_path_index",
      message:
        pathIndexShard === null
          ? `graph_indices/${layout.pathIndexShardId} is absent for generation "${generationId}"; missing file shards cannot be named, only counted`
          : `graph_indices/${layout.pathIndexShardId} has no usable "pathIndex" payload for generation "${generationId}"; missing file shards cannot be named, only counted`,
    });
  }

  const shardCandidates =
    expectedFileIds === null
      ? (await store.listShardIds("graph_files", { ...options, generationId }))
          .filter(layout.ownsFileShard)
          .sort(compareCodepoints)
          .map((shardId) => ({ shardId, expectedFileId: null }))
      : expectedFileIds.map((fileId) => ({
          shardId: layout.fileShardId(fileId),
          expectedFileId: fileId,
        }));

  const fileShards = await readFileShards(store, shardCandidates, generationId, options);
  for (const { shardId, expectedFileId, shard } of fileShards) {
    if (shard === null) {
      issues.push({
        kind: "missing_file_shard",
        message:
          expectedFileId === null
            ? `graph_files/${shardId} was listed but could not be read`
            : `graph_files/${shardId} is named by the path index of generation "${generationId}" but is absent from the store`,
      });
      continue;
    }
    const payloadScopeIssues = validatePayloadScope(
      shard.payload,
      scope,
      `graph_files/${shardId}`,
      shard.generationId,
      layout.legacy,
    );
    issues.push(...payloadScopeIssues);
    if (payloadScopeIssues.length > 0) continue;

    const node = shard.payload["node"];
    const shardEdges = shard.payload["edges"];
    if (!isRecord(node) || !Array.isArray(shardEdges)) {
      issues.push({
        kind: "malformed_payload",
        message: `graph_files/${shardId} has no usable "node"/"edges" payload`,
      });
      continue;
    }
    // Der Shard und der Knoten darin muessen DIESELBE Datei sein.
    //
    // Ohne diesen Vergleich ist die haeufigste zahlenerhaltende Verfaelschung
    // unsichtbar: traegt `graph_files/F_c` den Knoten von `F_a`, dann ist der
    // Shard gelistet, der Pfadindex nennt ihn, und drei Shards liefern drei
    // Knoten — beide bisherigen Zeugen (`missing_file_shard`,
    // `count_mismatch`) bescheinigen dem Abbild ausdruecklich
    // Vollstaendigkeit, waehrend `F_c` verschwunden und `F_a` doppelt ist.
    // Ein Abbild, das die Eindeutigkeit der `file_id` verletzt, ist fuer
    // jeden Ableiter falsch, und es unbenannt zu liefern ist genau das
    // stille Ueberspringen, das E4 verbietet.
    const nodeFileId = node["fileId"];
    const expectedPhysicalShardId =
      typeof nodeFileId === "string" && nodeFileId !== "" ? layout.fileShardId(nodeFileId) : null;
    if (
      expectedPhysicalShardId === null ||
      expectedPhysicalShardId !== shardId ||
      (expectedFileId !== null && nodeFileId !== expectedFileId)
    ) {
      issues.push({
        kind: "malformed_payload",
        message: `graph_files/${shardId} carries a node with fileId ${
          typeof nodeFileId === "string" ? `"${nodeFileId}"` : "of a non-string type"
        }; the shard and the node it carries must be the same file`,
      });
      continue;
    }
    if (node["workspaceId"] !== workspaceId || node["graphGeneration"] !== generationId) {
      issues.push({
        kind: "scope_mismatch",
        message: `graph_files/${shardId} carries a node outside requested workspace "${workspaceId}" or generation "${generationId}"`,
      });
      continue;
    }
    const edgeScopeMismatch = shardEdges.some(
      (edge) =>
        !isRecord(edge) ||
        edge["workspaceId"] !== workspaceId ||
        edge["graphGeneration"] !== generationId ||
        edge["fromFileId"] !== nodeFileId,
    );
    if (edgeScopeMismatch) {
      issues.push({
        kind: "scope_mismatch",
        message: `graph_files/${shardId} carries an edge outside the requested scope or source file`,
      });
      continue;
    }
    nodes.push(node as unknown as FileNodeV1);
    edges.push(...(shardEdges as FileEdgeV1[]));
  }

  if (issues.some((issue) => issue.kind === "scope_mismatch")) {
    return { snapshot: null, issues };
  }

  // Sollzahlen gegen das tatsaechlich Geladene. Zweiter, vom Pfadindex
  // unabhaengiger Zeuge: er greift auch dann, wenn der Pfadindex selbst fehlt.
  const expectedNodeCount = countOf(meta["nodeCount"]);
  if (expectedNodeCount !== null && expectedNodeCount !== nodes.length) {
    issues.push({
      kind: "count_mismatch",
      message: `graph_meta/${layout.metaShardId} of generation "${generationId}" declares ${String(expectedNodeCount)} nodes, but ${String(nodes.length)} were loaded`,
    });
  }
  const expectedEdgeCount = countOf(meta["edgeCount"]);
  if (expectedEdgeCount !== null && expectedEdgeCount !== edges.length) {
    issues.push({
      kind: "count_mismatch",
      message: `graph_meta/${layout.metaShardId} of generation "${generationId}" declares ${String(expectedEdgeCount)} edges, but ${String(edges.length)} were loaded`,
    });
  }

  // WP-181: DER DRITTE ZEUGE, der bisher nie befragt wurde.
  //
  // `metrics.nodeCount`/`metrics.edgeCount` liegen im selben Payload und
  // wurden mit demselben Abbild geschrieben — sie sind aber eine EIGENE
  // Aussage, gerechnet vom Metrikpfad, nicht abgeschrieben von
  // `meta.nodeCount`. Wurden nur die aeusseren Zahlen fortgeschrieben und die
  // Metriken nicht (oder umgekehrt), lieferte `readGraphSnapshot` bisher ein
  // Abbild, das sich SELBST widerspricht: `snapshot.metrics.nodeCount` sagt
  // 12, `snapshot.nodes.length` sagt 11 — und beide stehen ohne Vermerk
  // nebeneinander in einem Objekt, das jeder Ableiter fuer in sich stimmig
  // haelt. Ein Widerspruch, den man vorliegen hat und nicht ausspricht, ist
  // dieselbe Klasse wie ein verschwiegener Verlust (E4).
  const metricsPayload = meta["metrics"];
  if (isRecord(metricsPayload)) {
    const metricsNodeCount = countOf(metricsPayload["nodeCount"]);
    if (metricsNodeCount !== null && metricsNodeCount !== nodes.length) {
      issues.push({
        kind: "count_mismatch",
        message: `graph_meta/${layout.metaShardId} of generation "${generationId}" carries metrics.nodeCount ${String(metricsNodeCount)}, but ${String(nodes.length)} nodes were loaded; the returned snapshot would contradict itself`,
      });
    }
    const metricsEdgeCount = countOf(metricsPayload["edgeCount"]);
    if (metricsEdgeCount !== null && metricsEdgeCount !== edges.length) {
      issues.push({
        kind: "count_mismatch",
        message: `graph_meta/${layout.metaShardId} of generation "${generationId}" carries metrics.edgeCount ${String(metricsEdgeCount)}, but ${String(edges.length)} edges were loaded; the returned snapshot would contradict itself`,
      });
    }
  }

  const snapshot: FileGraphSnapshotV1 = {
    schemaVersion: 1,
    workspaceId,
    graphGeneration: generationId,
    nodes: nodes.sort((left, right) => compareCodepoints(left.fileId, right.fileId)),
    edges: edges.sort(compareEdges),
    metrics: meta["metrics"] as FileGraphSnapshotV1["metrics"],
    topology: meta["topology"] as FileGraphSnapshotV1["topology"],
    skipped: meta["skipped"] as FileGraphSnapshotV1["skipped"],
  };
  return { snapshot, issues };
}

/**
 * Prueft die Pflichtteile des Metadaten-Shards.
 *
 * Geprueft wird nur die TRAGENDE Form — genau die Zusagen, auf die ein
 * Aufrufer sich ohne weitere Pruefung verlassen darf. Eine vollstaendige
 * Schemapruefung waere hier eine zweite Wahrheit neben `domain`; ein
 * ungeprueftes `as` waere gar keine.
 */
function validateMetaPayload(
  meta: Readonly<Record<string, unknown>>,
  scope: GraphSnapshotScope,
  shardId: string,
  storedGenerationId: string,
): SnapshotReadIssue[] {
  const issues = validatePayloadScope(
    meta,
    scope,
    `graph_meta/${shardId}`,
    storedGenerationId,
    false,
  );
  // WP-193: `String(meta["workspaceId"] ?? "")` machte aus einem FEHLENDEN
  // Workspace den Leerstring — und der Leerstring ist im ganzen Produkt die
  // Grenze, innerhalb derer eine Anfrage ueberhaupt gilt. Ein Abbild ohne
  // Workspace wurde damit zu einem Abbild MIT einem (leeren) Workspace, das
  // sich anschliessend gegen jede echte Workspace-Pruefung falsch verhaelt.
  // Ein Pflichtteil, der fehlt, ist ein Befund, kein Vorgabewert.
  const workspaceId = meta["workspaceId"];
  if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
    issues.push({
      kind: "malformed_payload",
      message: `graph_meta/${shardId} has no usable "workspaceId"; a snapshot without a workspace has no scope it could belong to`,
    });
  }
  const metrics = meta["metrics"];
  if (
    !isRecord(metrics) ||
    typeof metrics["nodeCount"] !== "number" ||
    metrics["workspaceId"] !== scope.workspaceId ||
    metrics["graphGeneration"] !== scope.generationId
  ) {
    issues.push({
      kind: "malformed_payload",
      message: `graph_meta/${shardId} has no usable, scope-matching "metrics" payload`,
    });
  }
  const topology = meta["topology"];
  if (
    !isRecord(topology) ||
    topology["workspaceId"] !== scope.workspaceId ||
    !Array.isArray(topology["packages"]) ||
    !Array.isArray(topology["services"]) ||
    !isRecord(topology["skipped"]) ||
    topology["skipped"]["generationId"] !== scope.generationId
  ) {
    issues.push({
      kind: "malformed_payload",
      message: `graph_meta/${shardId} has no usable, scope-matching "topology" payload`,
    });
  }
  const skipped = meta["skipped"];
  if (
    !isRecord(skipped) ||
    skipped["generationId"] !== scope.generationId ||
    !Array.isArray(skipped["entries"]) ||
    !isRecord(skipped["countsByReason"])
  ) {
    issues.push({
      kind: "malformed_payload",
      message: `graph_meta/${shardId} has no usable, scope-matching "skipped" payload`,
    });
  }
  return issues;
}

function validatePayloadScope(
  payload: Readonly<Record<string, unknown>>,
  scope: GraphSnapshotScope,
  subject: string,
  storedGenerationId: string,
  legacy: boolean,
): SnapshotReadIssue[] {
  const issues: SnapshotReadIssue[] = [];
  if (storedGenerationId !== scope.generationId) {
    issues.push({
      kind: "scope_mismatch",
      message: `${subject} was returned from generation "${storedGenerationId}" while "${scope.generationId}" was requested`,
    });
  }

  const payloadWorkspaceId = payload["workspaceId"];
  if (payloadWorkspaceId !== undefined && payloadWorkspaceId !== scope.workspaceId) {
    issues.push({
      kind: "scope_mismatch",
      message: `${subject} belongs to workspace "${String(payloadWorkspaceId)}", not requested workspace "${scope.workspaceId}"`,
    });
  } else if (!legacy && payloadWorkspaceId === undefined) {
    issues.push({
      kind: "scope_mismatch",
      message: `${subject} has no workspaceId persistence marker`,
    });
  }

  const payloadGeneration = payload["graphGeneration"];
  if (payloadGeneration !== undefined && payloadGeneration !== scope.generationId) {
    issues.push({
      kind: "scope_mismatch",
      message: `${subject} belongs to generation "${String(payloadGeneration)}", not requested generation "${scope.generationId}"`,
    });
  } else if (!legacy && payloadGeneration === undefined) {
    issues.push({
      kind: "scope_mismatch",
      message: `${subject} has no graphGeneration persistence marker`,
    });
  }
  return issues;
}

/** `file_id`s laut Pfadindex; `null`, wenn der Index unbrauchbar ist. */
function expectedFileIdsOf(
  payload: Readonly<Record<string, unknown>> | undefined,
): string[] | null {
  if (payload === undefined) return null;
  const pathIndex = payload["pathIndex"];
  if (!isRecord(pathIndex)) return null;
  const fileIds = new Set<string>();
  for (const value of Object.values(pathIndex)) {
    if (typeof value === "string" && value !== "") fileIds.add(value);
  }
  return [...fileIds].sort(compareCodepoints);
}

function countOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathKey(repoId: string, path: string): string {
  return `${repoId}\u001f${normalizePath(path)}`;
}

function assertGraphSnapshotScope(scope: GraphSnapshotScope): void {
  assertIdentifier("workspaceId", scope.workspaceId);
  assertIdentifier("generationId", scope.generationId);
}

function assertFileGraphSnapshotScope(snapshot: FileGraphSnapshotV1): void {
  assertGraphSnapshotScope({
    workspaceId: snapshot.workspaceId,
    generationId: snapshot.graphGeneration,
  });

  if (
    snapshot.metrics.workspaceId !== snapshot.workspaceId ||
    snapshot.metrics.graphGeneration !== snapshot.graphGeneration ||
    snapshot.topology.workspaceId !== snapshot.workspaceId ||
    snapshot.topology.skipped.generationId !== snapshot.graphGeneration ||
    snapshot.skipped.generationId !== snapshot.graphGeneration
  ) {
    throw new TypeError(
      "file graph metrics, topology and skip ledger must match the snapshot workspace and generation",
    );
  }
  for (const node of snapshot.nodes) {
    if (
      node.workspaceId !== snapshot.workspaceId ||
      node.graphGeneration !== snapshot.graphGeneration
    ) {
      throw new TypeError(
        `file graph node "${node.fileId}" does not match snapshot workspace/generation`,
      );
    }
  }
  for (const edge of snapshot.edges) {
    if (
      edge.workspaceId !== snapshot.workspaceId ||
      edge.graphGeneration !== snapshot.graphGeneration
    ) {
      throw new TypeError(
        `file graph edge "${edge.edgeId}" does not match snapshot workspace/generation`,
      );
    }
  }
}

function assertIdentifier(name: string, value: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}
