/**
 * Ablage und Rueckladung ueber den ECHTEN `GraphStore`-Port.
 *
 * Gefahren wird gegen die In-Memory-Umsetzung aus `@untangle-code/testkit`,
 * die ihrerseits gegen die dortige Port-Kontraktsuite gruen ist. Damit
 * beweist dieser Test genau das, was er soll: die Abbildung Dateigraph ↔
 * Shards, nicht die Speicherimplementierung.
 */
import { InMemoryGraphStore } from "@untangle-code/testkit";
import { describe, expect, it, vi } from "vitest";

import {
  META_SHARD_ID,
  PATH_INDEX_SHARD_ID,
  fileGraphFileShardId,
  fileGraphMetaShardId,
  fileGraphPathIndexShardId,
  readGraphSnapshot,
  toGraphShards,
  writeGraphSnapshot,
} from "./persistence.js";
import {
  buildMiniWorkspace,
  TEST_GENERATION,
  TEST_WORKSPACE_ID,
} from "./test-support/workspace.js";
import type { FileGraphSnapshotV1 } from "./types.js";

const TEST_SCOPE = { workspaceId: TEST_WORKSPACE_ID, generationId: TEST_GENERATION } as const;

function withWorkspace(snapshot: FileGraphSnapshotV1, workspaceId: string): FileGraphSnapshotV1 {
  return {
    ...snapshot,
    workspaceId,
    nodes: snapshot.nodes.map((node) => ({ ...node, workspaceId })),
    edges: snapshot.edges.map((edge) => ({ ...edge, workspaceId })),
    metrics: { ...snapshot.metrics, workspaceId },
    topology: { ...snapshot.topology, workspaceId },
  };
}

const WORKSPACE = {
  "package.json": JSON.stringify({ name: "root", private: true }),
  "src/a.ts": 'import "./b.js";\nimport "node:fs";\nexport const a = 1;\n',
  "src/b.ts": 'import "./ghost.js";\nexport const b = 1;\n',
};

function readGate(): { opened: Promise<void>; open(): void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

const LARGE_WORKSPACE = {
  ...WORKSPACE,
  ...Object.fromEntries(
    Array.from({ length: 18 }, (_, i) => [`src/extra-${i}.ts`, `export const extra${i} = ${i};\n`]),
  ),
};

describe("Ablage ueber GraphStore", () => {
  it("schreibt je Datei einen Shard plus Metadaten und Pfadindex", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const shards = toGraphShards(graph.snapshot(), "write-1");
    expect(shards.filter((shard) => shard.collection === "graph_files")).toHaveLength(2);
    expect(
      shards.filter((shard) => shard.logicalShardId === fileGraphMetaShardId(TEST_WORKSPACE_ID)),
    ).toHaveLength(1);
    expect(
      shards.filter(
        (shard) => shard.logicalShardId === fileGraphPathIndexShardId(TEST_WORKSPACE_ID),
      ),
    ).toHaveLength(1);
    expect(shards.every((shard) => shard.generationId === TEST_GENERATION)).toBe(true);
  });

  it("laedt ein geschriebenes Abbild verlustfrei zurueck", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const store = new InMemoryGraphStore();
    const original = graph.snapshot();
    await writeGraphSnapshot(store, original, "write-1");

    const loaded = await readGraphSnapshot(store, TEST_SCOPE);
    expect(loaded.issues).toEqual([]);
    expect(JSON.stringify(loaded.snapshot)).toBe(JSON.stringify(original));
  });

  it("reicht PortCallOptions an Schreiben sowie jeden Read/List-Storeaufruf weiter", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const store = new InMemoryGraphStore();
    const signal = new AbortController().signal;
    const write = vi.spyOn(store, "writeShards");
    await writeGraphSnapshot(store, graph.snapshot(), "write-options", { signal });
    expect(write.mock.calls[0]?.[1]).toEqual({ signal });

    // Ohne Pfadindex muss der Leser zusaetzlich listShardIds benutzen. So ist
    // in einem Test belegt, dass BEIDE Lesepfade dasselbe Signal erhalten.
    await store.deleteShards("graph_indices", [fileGraphPathIndexShardId(TEST_WORKSPACE_ID)]);
    const read = vi.spyOn(store, "readShard");
    const list = vi.spyOn(store, "listShardIds");
    await readGraphSnapshot(store, TEST_SCOPE, { signal });
    expect(read.mock.calls.length).toBeGreaterThan(0);
    expect(read.mock.calls.every((call) => call[2]?.signal === signal)).toBe(true);
    expect(list.mock.calls.length).toBeGreaterThan(0);
    expect(list.mock.calls.every((call) => call[1]?.signal === signal)).toBe(true);
  });

  it("meldet fehlende Metadaten als Befund statt einen leeren Graphen zu liefern", async () => {
    const store = new InMemoryGraphStore();
    const loaded = await readGraphSnapshot(store, {
      workspaceId: TEST_WORKSPACE_ID,
      generationId: "gen-does-not-exist",
    });
    expect(loaded.snapshot).toBeNull();
    expect(loaded.issues[0]?.kind).toBe("missing_meta");
  });

  it("meldet einen unbrauchbaren Datei-Shard, statt den Knoten stillschweigend zu verlieren", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const store = new InMemoryGraphStore();
    const snapshot = graph.snapshot();
    await writeGraphSnapshot(store, snapshot, "write-1");
    // Ein Shard wird durch eine unbrauchbare Nutzlast ersetzt.
    const victim = snapshot.nodes[0]?.fileId as string;
    await store.writeShards([
      {
        logicalShardId: fileGraphFileShardId(TEST_WORKSPACE_ID, victim),
        collection: "graph_files",
        generationId: TEST_GENERATION,
        writeId: "write-2",
        payload: {
          persistenceSchemaVersion: 1,
          workspaceId: TEST_WORKSPACE_ID,
          graphGeneration: TEST_GENERATION,
          broken: true,
        },
      },
    ]);
    const loaded = await readGraphSnapshot(store, TEST_SCOPE);
    expect(loaded.issues.map((issue) => issue.kind)).toContain("malformed_payload");
    expect(loaded.snapshot?.nodes.length).toBe(snapshot.nodes.length - 1);
  });

  it("meldet einen GANZ FEHLENDEN Datei-Shard namentlich, statt leiser zu werden", async () => {
    // Regression: der haeufigste Verlustfall. Ein Shard, den es nicht mehr
    // gibt, wird von `listShardIds` schlicht nicht mehr aufgezaehlt — eine
    // Erwartungsmenge aus derselben Liste kann ihn also nie vermissen. Der
    // Pfadindex ist der unabhaengige Zeuge.
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const store = new InMemoryGraphStore();
    const snapshot = graph.snapshot();
    await writeGraphSnapshot(store, snapshot, "write-1");

    const victim = snapshot.nodes[0]?.fileId as string;
    await store.deleteShards("graph_files", [fileGraphFileShardId(TEST_WORKSPACE_ID, victim)]);

    const loaded = await readGraphSnapshot(store, TEST_SCOPE);
    const missing = loaded.issues.filter((issue) => issue.kind === "missing_file_shard");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain(victim);
    expect(loaded.issues.some((issue) => issue.kind === "count_mismatch")).toBe(true);
    expect(loaded.snapshot?.nodes.length).toBe(snapshot.nodes.length - 1);
  });

  it("meldet einen fehlenden Pfadindex, statt den fehlenden Shard nur zu zaehlen", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const store = new InMemoryGraphStore();
    const snapshot = graph.snapshot();
    await writeGraphSnapshot(store, snapshot, "write-1");
    await store.deleteShards("graph_indices", [fileGraphPathIndexShardId(TEST_WORKSPACE_ID)]);
    await store.deleteShards("graph_files", [
      fileGraphFileShardId(TEST_WORKSPACE_ID, snapshot.nodes[0]?.fileId as string),
    ]);

    const loaded = await readGraphSnapshot(store, TEST_SCOPE);
    expect(loaded.issues.map((issue) => issue.kind)).toContain("missing_path_index");
    // Der zweite, unabhaengige Zeuge greift trotzdem.
    expect(loaded.issues.map((issue) => issue.kind)).toContain("count_mismatch");
  });

  it("meldet einen kaputten graph_meta-Payload, statt Pflichtfelder still undefined zu lassen", async () => {
    // `snapshot.skipped.entries` ist eine Zusage des Vertrages. Wer sie
    // undefined weiterreicht, verschiebt einen TypeError in den Aufrufer und
    // verschweigt den eigentlichen Befund (E4).
    const store = new InMemoryGraphStore();
    await store.writeShards([
      {
        logicalShardId: fileGraphMetaShardId(TEST_WORKSPACE_ID),
        collection: "graph_meta",
        generationId: TEST_GENERATION,
        writeId: "write-1",
        payload: {
          persistenceSchemaVersion: 1,
          workspaceId: TEST_WORKSPACE_ID,
          graphGeneration: TEST_GENERATION,
        },
      },
    ]);

    const loaded = await readGraphSnapshot(store, TEST_SCOPE);
    expect(loaded.snapshot).toBeNull();
    const kinds = loaded.issues.map((issue) => issue.kind);
    expect(kinds).toEqual(["malformed_payload", "malformed_payload", "malformed_payload"]);
    const messages = loaded.issues.map((issue) => issue.message).join(" | ");
    expect(messages).toContain('"metrics"');
    expect(messages).toContain('"topology"');
    expect(messages).toContain('"skipped"');
  });
});

describe("bounded parallel file-shard reads", () => {
  it("reads at most eight files concurrently and preserves the complete scoped snapshot", async () => {
    const { graph } = await buildMiniWorkspace(LARGE_WORKSPACE);
    const original = graph.snapshot();
    const store = new InMemoryGraphStore();
    await writeGraphSnapshot(store, original, "write-concurrency");
    const firstBatch = readGate();
    const release = readGate();
    const signal = new AbortController().signal;
    const read = store.readShard.bind(store);
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    const spy = vi.spyOn(store, "readShard").mockImplementation(async (collection, id, options) => {
      if (collection !== "graph_files") return read(collection, id, options);
      active++;
      maximumActive = Math.max(maximumActive, active);
      if (++started === 8) firstBatch.open();
      await release.opened;
      try {
        return await read(collection, id, options);
      } finally {
        active--;
      }
    });
    const completion = readGraphSnapshot(store, TEST_SCOPE, { signal });
    try {
      await firstBatch.opened;
      expect(started).toBe(8);
      expect(active).toBe(8);
    } finally {
      release.open();
    }
    const loaded = await completion;
    expect(maximumActive).toBe(8);
    expect(active).toBe(0);
    expect(started).toBe(original.nodes.length);
    expect(loaded.issues).toEqual([]);
    expect(loaded.snapshot).toEqual(original);
    expect(spy.mock.calls.every((call) => call[2]?.generationId === TEST_GENERATION)).toBe(true);
    expect(spy.mock.calls.every((call) => call[2]?.signal === signal)).toBe(true);
  });

  it("reports missing shards in candidate order even when reads complete in reverse order", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const store = new InMemoryGraphStore();
    const original = graph.snapshot();
    await writeGraphSnapshot(store, original, "write-order");
    const fileIds = original.nodes.map((node) => node.fileId);
    const shardIds = fileIds.map((id) => fileGraphFileShardId(TEST_WORKSPACE_ID, id));
    await store.deleteShards("graph_files", shardIds);
    const expected = await readGraphSnapshot(store, TEST_SCOPE);
    const gates = new Map(shardIds.map((id) => [id, readGate()]));
    const bothStarted = readGate();
    const secondCompleted = readGate();
    const finished: string[] = [];
    const read = store.readShard.bind(store);
    let started = 0;
    vi.spyOn(store, "readShard").mockImplementation(async (collection, id, options) => {
      if (collection !== "graph_files") return read(collection, id, options);
      if (++started === shardIds.length) bothStarted.open();
      await gates.get(id)!.opened;
      const shard = await read(collection, id, options);
      finished.push(id);
      if (id === shardIds[1]) secondCompleted.open();
      return shard;
    });
    const completion = readGraphSnapshot(store, TEST_SCOPE);
    try {
      await bothStarted.opened;
      gates.get(shardIds[1]!)!.open();
      await secondCompleted.opened;
      gates.get(shardIds[0]!)!.open();
    } finally {
      for (const gate of gates.values()) gate.open();
    }
    const loaded = await completion;
    expect(finished).toEqual([...shardIds].reverse());
    expect(loaded).toEqual(expected);
    const missing = loaded.issues.filter((issue) => issue.kind === "missing_file_shard");
    expect(missing).toHaveLength(fileIds.length);
    for (const [index, fileId] of fileIds.entries())
      expect(missing[index]?.message).toContain(fileId);
    expect(loaded.issues.some((issue) => issue.kind === "count_mismatch")).toBe(true);
  });

  it("drains the active batch, throws its first candidate error and starts no later batch", async () => {
    const { graph } = await buildMiniWorkspace(LARGE_WORKSPACE);
    const store = new InMemoryGraphStore();
    await writeGraphSnapshot(store, graph.snapshot(), "write-errors");
    const firstBatch = readGate();
    const release = readGate();
    const firstError = new Error("first candidate's store failure");
    const laterError = new Error("later candidate failed sooner");
    const read = store.readShard.bind(store);
    let started = 0;
    let active = 0;
    vi.spyOn(store, "readShard").mockImplementation(async (collection, id, options) => {
      if (collection !== "graph_files") return read(collection, id, options);
      const index = started++;
      active++;
      if (started === 8) firstBatch.open();
      try {
        if (index === 6) throw laterError;
        await release.opened;
        if (index === 1) throw firstError;
        return await read(collection, id, options);
      } finally {
        active--;
      }
    });
    let settled = false;
    const completion = readGraphSnapshot(store, TEST_SCOPE);
    void completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = expect(completion).rejects.toBe(firstError);
    try {
      await firstBatch.opened;
      expect(started).toBe(8);
      expect(settled).toBe(false);
    } finally {
      release.open();
    }
    await rejected;
    expect(active).toBe(0);
    expect(started).toBe(8);
  });

  it("propagates cancellation to every active read and starts no next batch", async () => {
    const { graph } = await buildMiniWorkspace(LARGE_WORKSPACE);
    const store = new InMemoryGraphStore();
    await writeGraphSnapshot(store, graph.snapshot(), "write-abort");
    const controller = new AbortController();
    const reason = new Error("cancel the scoped graph read");
    const firstBatch = readGate();
    const read = store.readShard.bind(store);
    let started = 0;
    let active = 0;
    vi.spyOn(store, "readShard").mockImplementation(async (collection, id, options) => {
      if (collection !== "graph_files") return read(collection, id, options);
      expect(options?.signal).toBe(controller.signal);
      expect(options?.generationId).toBe(TEST_GENERATION);
      active++;
      if (++started === 8) firstBatch.open();
      try {
        await new Promise<void>((_resolve, reject) => {
          options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), {
            once: true,
          });
        });
        return await read(collection, id, options);
      } finally {
        active--;
      }
    });
    const completion = readGraphSnapshot(store, TEST_SCOPE, { signal: controller.signal });
    const rejected = expect(completion).rejects.toBe(reason);
    try {
      await firstBatch.opened;
      expect(active).toBe(8);
    } finally {
      controller.abort(reason);
    }
    await rejected;
    expect(active).toBe(0);
    expect(started).toBe(8);
  });
});

describe("workspace-sichere Ablage", () => {
  it("isoliert zwei Workspaces derselben Generation im selben Store", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const store = new InMemoryGraphStore();
    const alpha = withWorkspace(graph.snapshot(), "workspace-alpha");
    const beta = withWorkspace(graph.snapshot(), "workspace-beta");

    await writeGraphSnapshot(store, alpha, "write-alpha");
    await writeGraphSnapshot(store, beta, "write-beta");

    const loadedAlpha = await readGraphSnapshot(store, {
      workspaceId: alpha.workspaceId,
      generationId: alpha.graphGeneration,
    });
    const loadedBeta = await readGraphSnapshot(store, {
      workspaceId: beta.workspaceId,
      generationId: beta.graphGeneration,
    });

    expect(loadedAlpha.issues).toEqual([]);
    expect(loadedBeta.issues).toEqual([]);
    expect(loadedAlpha.snapshot?.workspaceId).toBe("workspace-alpha");
    expect(loadedBeta.snapshot?.workspaceId).toBe("workspace-beta");
    expect(
      loadedAlpha.snapshot?.nodes.every((node) => node.workspaceId === "workspace-alpha"),
    ).toBe(true);
    expect(loadedBeta.snapshot?.nodes.every((node) => node.workspaceId === "workspace-beta")).toBe(
      true,
    );
  });

  it("liest weder einen falschen Workspace noch eine falsche Generation", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const store = new InMemoryGraphStore();
    await writeGraphSnapshot(store, graph.snapshot(), "write-1");

    await expect(
      readGraphSnapshot(store, {
        workspaceId: "workspace-fremd",
        generationId: TEST_GENERATION,
      }),
    ).resolves.toMatchObject({ snapshot: null, issues: [{ kind: "missing_meta" }] });
    await expect(
      readGraphSnapshot(store, {
        workspaceId: TEST_WORKSPACE_ID,
        generationId: "generation-fremd",
      }),
    ).resolves.toMatchObject({ snapshot: null, issues: [{ kind: "missing_meta" }] });
  });

  it("lehnt eine alte ungescopte Signatur ab, statt den neuesten Workspace zu erraten", async () => {
    const store = new InMemoryGraphStore();
    const loaded = await readGraphSnapshot(store, TEST_GENERATION);
    expect(loaded.snapshot).toBeNull();
    expect(loaded.issues).toEqual([expect.objectContaining({ kind: "workspace_scope_required" })]);
  });

  it("uebergibt die Generation bei jedem Store-Lesezugriff explizit", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const store = new InMemoryGraphStore();
    await writeGraphSnapshot(store, graph.snapshot(), "write-1");
    const readShard = vi.spyOn(store, "readShard");
    const listShardIds = vi.spyOn(store, "listShardIds");

    await readGraphSnapshot(store, TEST_SCOPE);

    expect(readShard.mock.calls.length).toBeGreaterThan(0);
    expect(readShard.mock.calls.every((call) => call[2]?.generationId === TEST_GENERATION)).toBe(
      true,
    );
    expect(listShardIds.mock.calls.every((call) => call[1]?.generationId === TEST_GENERATION)).toBe(
      true,
    );
  });

  it("bricht bei einem manipulierten Workspace-Marker fail-closed ab", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const store = new InMemoryGraphStore();
    const snapshot = graph.snapshot();
    const shards = toGraphShards(snapshot, "write-1").map((shard) =>
      shard.collection === "graph_meta"
        ? { ...shard, payload: { ...shard.payload, workspaceId: "workspace-fremd" } }
        : shard,
    );
    await store.writeShards(shards);

    const loaded = await readGraphSnapshot(store, TEST_SCOPE);
    expect(loaded.snapshot).toBeNull();
    expect(loaded.issues.map((issue) => issue.kind)).toContain("scope_mismatch");
  });

  it("liest globale Legacy-Shards nur nach explizitem Opt-in und Scope-Pruefung", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const store = new InMemoryGraphStore();
    const legacyShards = toGraphShards(graph.snapshot(), "write-legacy").map((shard) => ({
      ...shard,
      logicalShardId:
        shard.collection === "graph_meta"
          ? META_SHARD_ID
          : shard.collection === "graph_indices"
            ? PATH_INDEX_SHARD_ID
            : String((shard.payload["node"] as { fileId: string }).fileId),
    }));
    await store.writeShards(legacyShards);

    expect((await readGraphSnapshot(store, TEST_SCOPE)).snapshot).toBeNull();
    const loaded = await readGraphSnapshot(store, TEST_SCOPE, { allowLegacyFallback: true });
    expect(loaded.issues).toEqual([]);
    expect(loaded.snapshot).toEqual(graph.snapshot());

    const wrongWorkspace = await readGraphSnapshot(
      store,
      { workspaceId: "workspace-fremd", generationId: TEST_GENERATION },
      { allowLegacyFallback: true },
    );
    expect(wrongWorkspace.snapshot).toBeNull();
    expect(wrongWorkspace.issues.map((issue) => issue.kind)).toContain("scope_mismatch");
  });
});

describe("Ablage: der Shard und der Knoten darin muessen dieselbe Datei sein", () => {
  const THREE = {
    "package.json": JSON.stringify({ name: "root", private: true }),
    "src/a.ts": 'import "./b.js";\nexport const a = 1;\n',
    "src/b.ts": "export const b = 1;\n",
    "src/c.ts": "export const c = 1;\n",
  };

  it("meldet einen Datei-Shard, der einen FREMDEN Knoten traegt", async () => {
    // Die Verfaelschung ist ZAHLENERHALTEND: der Shard ist gelistet, der
    // Pfadindex nennt ihn, und drei Shards liefern drei Knoten — die
    // Zaehlpruefung bescheinigt dem kaputten Abbild also Vollstaendigkeit.
    // Nur der Vergleich von Shard-ID und `node.fileId` sieht, dass ein Knoten
    // verschwunden und ein anderer doppelt ist (E4).
    const { graph } = await buildMiniWorkspace(THREE);
    const store = new InMemoryGraphStore();
    const snapshot = graph.snapshot();
    await writeGraphSnapshot(store, snapshot, "write-1");

    const impostor = snapshot.nodes[0] as (typeof snapshot.nodes)[number];
    const victim = snapshot.nodes[2]?.fileId as string;
    expect(victim).not.toBe(impostor.fileId);
    await store.writeShards([
      {
        logicalShardId: fileGraphFileShardId(TEST_WORKSPACE_ID, victim),
        collection: "graph_files",
        generationId: TEST_GENERATION,
        writeId: "write-2",
        payload: {
          persistenceSchemaVersion: 1,
          workspaceId: TEST_WORKSPACE_ID,
          graphGeneration: TEST_GENERATION,
          node: impostor,
          edges: [],
        },
      },
    ]);

    const loaded = await readGraphSnapshot(store, TEST_SCOPE);
    const fileIds = loaded.snapshot?.nodes.map((node) => node.fileId) ?? [];
    expect(new Set(fileIds).size).toBe(fileIds.length);
    expect(fileIds).not.toContain(victim);
    expect(loaded.issues.map((issue) => issue.kind)).toContain("malformed_payload");
    expect(loaded.issues.some((issue) => issue.message.includes(victim))).toBe(true);
  });
});
