import { InMemoryGraphStore } from "@untangle-code/testkit";
import { describe, expect, it, vi } from "vitest";

import { buildSymbolGraph } from "./build.js";
import {
  LEGACY_SYMBOL_GRAPH_SHARD_ID,
  readSymbolGraphSnapshot,
  symbolGraphSnapshotShardId,
  toSymbolGraphShard,
  writeSymbolGraphSnapshot,
} from "./persistence.js";
import { makeFile } from "./test-support/fixtures.js";

const GENERATION = "generation-shared";

function graphFor(workspaceId: string) {
  const content =
    "orphan();\nexport function caller() { target(); }\nexport function target() {}\n";
  return buildSymbolGraph({
    workspaceId,
    graphGeneration: GENERATION,
    files: [
      makeFile({
        fileId: "file-shared",
        path: "src/calls.ts",
        content,
        symbols: [
          {
            name: "caller",
            snippet: "export function caller() { target(); }",
            exportedNames: ["caller"],
          },
          {
            name: "target",
            snippet: "export function target() {}",
            exportedNames: ["target"],
          },
        ],
        calls: [
          { calleeName: "orphan", snippet: "orphan()" },
          { calleeName: "target", snippet: "target()" },
        ],
      }),
    ],
  });
}

describe("Symbolgraph-Persistenz", () => {
  it("schreibt Knoten, Kanten, Metriken und Skip-Ledger in einen namespaceten Shard", () => {
    const graph = graphFor("workspace-alpha");
    const shard = toSymbolGraphShard(graph, "write-alpha");

    expect(shard.logicalShardId).toBe(symbolGraphSnapshotShardId("workspace-alpha"));
    expect(shard.generationId).toBe(GENERATION);
    expect(shard.payload).toMatchObject({
      workspaceId: "workspace-alpha",
      graphGeneration: GENERATION,
      nodes: graph.nodes,
      edges: graph.edges,
      metrics: graph.metrics,
      skipped: graph.skipped,
    });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.skipped.entries).toHaveLength(1);
  });

  it("laedt den vollstaendigen typisierten Graphen verlustfrei zurueck", async () => {
    const graph = graphFor("workspace-alpha");
    const store = new InMemoryGraphStore();
    await writeSymbolGraphSnapshot(store, graph, "write-alpha");

    const loaded = await readSymbolGraphSnapshot(store, {
      workspaceId: graph.workspaceId,
      generationId: graph.graphGeneration,
    });

    expect(loaded.issues).toEqual([]);
    expect(JSON.stringify(loaded.snapshot)).toBe(JSON.stringify(graph));
    expect(loaded.snapshot?.skipped).toEqual(graph.skipped);
  });

  it("reicht PortCallOptions beim Schreiben und Lesen bis zum GraphStore durch", async () => {
    const graph = graphFor("workspace-alpha");
    const store = new InMemoryGraphStore();
    const signal = new AbortController().signal;
    const write = vi.spyOn(store, "writeShards");
    await writeSymbolGraphSnapshot(store, graph, "write-options", { signal });
    expect(write.mock.calls[0]?.[1]).toEqual({ signal });

    const read = vi.spyOn(store, "readShard");
    await readSymbolGraphSnapshot(
      store,
      { workspaceId: graph.workspaceId, generationId: graph.graphGeneration },
      { signal },
    );
    expect(read.mock.calls).toHaveLength(1);
    expect(read.mock.calls[0]?.[2]).toEqual({ signal, generationId: GENERATION });
  });

  it("isoliert zwei Workspaces derselben Generation im selben InMemoryGraphStore", async () => {
    const alpha = graphFor("workspace-alpha");
    const beta = graphFor("workspace-beta");
    const store = new InMemoryGraphStore();
    await writeSymbolGraphSnapshot(store, alpha, "write-alpha");
    await writeSymbolGraphSnapshot(store, beta, "write-beta");

    const loadedAlpha = await readSymbolGraphSnapshot(store, {
      workspaceId: "workspace-alpha",
      generationId: GENERATION,
    });
    const loadedBeta = await readSymbolGraphSnapshot(store, {
      workspaceId: "workspace-beta",
      generationId: GENERATION,
    });

    expect(loadedAlpha.issues).toEqual([]);
    expect(loadedBeta.issues).toEqual([]);
    expect(loadedAlpha.snapshot).toEqual(alpha);
    expect(loadedBeta.snapshot).toEqual(beta);
  });

  it("liefert fuer falschen Workspace und falsche Generation keinen Graphen", async () => {
    const graph = graphFor("workspace-alpha");
    const store = new InMemoryGraphStore();
    await writeSymbolGraphSnapshot(store, graph, "write-alpha");

    await expect(
      readSymbolGraphSnapshot(store, {
        workspaceId: "workspace-beta",
        generationId: GENERATION,
      }),
    ).resolves.toMatchObject({ snapshot: null, issues: [{ kind: "missing_snapshot" }] });
    await expect(
      readSymbolGraphSnapshot(store, {
        workspaceId: "workspace-alpha",
        generationId: "generation-other",
      }),
    ).resolves.toMatchObject({ snapshot: null, issues: [{ kind: "missing_snapshot" }] });
  });

  it("validiert manipulierte Workspace- und Generation-Marker fail-closed", async () => {
    const graph = graphFor("workspace-alpha");
    const store = new InMemoryGraphStore();
    const shard = toSymbolGraphShard(graph, "write-alpha");
    await store.writeShards([
      {
        ...shard,
        payload: {
          ...shard.payload,
          workspaceId: "workspace-beta",
          graphGeneration: "generation-other",
        },
      },
    ]);

    const loaded = await readSymbolGraphSnapshot(store, {
      workspaceId: "workspace-alpha",
      generationId: GENERATION,
    });
    expect(loaded.snapshot).toBeNull();
    expect(loaded.issues.every((issue) => issue.kind === "scope_mismatch")).toBe(true);
  });

  it("liefert bei widerspruechlichen Metriken keinen scheinbar typisierten Graphen", async () => {
    const graph = graphFor("workspace-alpha");
    const store = new InMemoryGraphStore();
    const shard = toSymbolGraphShard(graph, "write-alpha");
    await store.writeShards([
      {
        ...shard,
        payload: {
          ...shard.payload,
          metrics: { ...graph.metrics, nodeCount: graph.metrics.nodeCount + 1 },
        },
      },
    ]);

    const loaded = await readSymbolGraphSnapshot(store, {
      workspaceId: graph.workspaceId,
      generationId: graph.graphGeneration,
    });
    expect(loaded.snapshot).toBeNull();
    expect(loaded.issues.map((issue) => issue.kind)).toContain("count_mismatch");
  });

  it("nutzt niemals die ungescopte latest-Lesung des Stores", async () => {
    const graph = graphFor("workspace-alpha");
    const store = new InMemoryGraphStore();
    await writeSymbolGraphSnapshot(store, graph, "write-alpha");
    const read = vi.spyOn(store, "readShard");

    await readSymbolGraphSnapshot(store, {
      workspaceId: graph.workspaceId,
      generationId: graph.graphGeneration,
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[2]).toEqual({ generationId: GENERATION });
  });

  it("liest globale Legacy-Shards nur nach explizitem Opt-in und Scope-Pruefung", async () => {
    const graph = graphFor("workspace-alpha");
    const store = new InMemoryGraphStore();
    const shard = toSymbolGraphShard(graph, "write-alpha");
    await store.writeShards([{ ...shard, logicalShardId: LEGACY_SYMBOL_GRAPH_SHARD_ID }]);
    const scope = { workspaceId: graph.workspaceId, generationId: graph.graphGeneration };
    const signal = new AbortController().signal;
    const read = vi.spyOn(store, "readShard");

    expect((await readSymbolGraphSnapshot(store, scope)).snapshot).toBeNull();
    read.mockClear();
    const loaded = await readSymbolGraphSnapshot(store, scope, {
      allowLegacyFallback: true,
      signal,
    });
    expect(loaded.issues).toEqual([]);
    expect(loaded.snapshot).toEqual(graph);
    expect(read.mock.calls).toHaveLength(2);
    expect(read.mock.calls.every((call) => call[2]?.signal === signal)).toBe(true);
    expect(read.mock.calls.every((call) => !("allowLegacyFallback" in (call[2] ?? {})))).toBe(true);

    const wrongWorkspace = await readSymbolGraphSnapshot(
      store,
      { workspaceId: "workspace-beta", generationId: GENERATION },
      { allowLegacyFallback: true },
    );
    expect(wrongWorkspace.snapshot).toBeNull();
    expect(wrongWorkspace.issues.map((issue) => issue.kind)).toContain("scope_mismatch");
  });
});
