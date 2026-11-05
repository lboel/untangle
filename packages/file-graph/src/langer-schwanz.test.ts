/**
 * Der lange Schwanz aus BUILD_PLAN §25 fuer `file-graph`:
 * WP-181, WP-193, WP-194, WP-195, WP-196, WP-197.
 *
 * Alle sechs sind Aussagen, die mehr behaupten, als beobachtet wurde: eine
 * unbekannte Wurzel gilt als bearbeitet, eine unmoegliche Loeschung als
 * ausgefuehrt, ein Abschneidegrund nennt die falsche Grenze, ein Pfadindex
 * verliert eine Datei, ein Abbild widerspricht sich selbst, und ein fehlender
 * Workspace wird zum leeren Workspace.
 */
import { InMemoryGraphStore } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import {
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

const TEST_SCOPE = { workspaceId: TEST_WORKSPACE_ID, generationId: TEST_GENERATION } as const;

const WORKSPACE = {
  "package.json": JSON.stringify({ name: "root", private: true }),
  "src/a.ts": 'import "./b.js";\nexport const a = 1;\n',
  "src/b.ts": "export const b = 1;\n",
};

/** Zwei unabhaengige Aeste, damit Tiefe und Knotenbudget getrennt greifen. */
const TWO_ROOTS = {
  "package.json": JSON.stringify({ name: "root", private: true }),
  "src/a.ts": 'import "./b.js";\nexport const a = 1;\n',
  "src/b.ts": 'import "./c.js";\nexport const b = 1;\n',
  "src/c.ts": "export const c = 1;\n",
  "src/x.ts": 'import "./y.js";\nexport const x = 1;\n',
  "src/y.ts": 'import "./z.js";\nexport const y = 1;\n',
  "src/z.ts": "export const z = 1;\n",
};

describe("WP-194 — eine Wurzel, die der Graph nicht kennt, gilt nicht als bearbeitet", () => {
  it("nennt sie in unknownRootFileIds statt ein leeres, unauffaelliges Ergebnis zu liefern", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const known = graph.nodes()[0]?.fileId as string;
    const result = graph.traverse([known, "gibt-es-nicht"], { direction: "forward" });

    expect(result.unknownRootFileIds).toEqual(["gibt-es-nicht"]);
    // Der bekannte Ast wird trotzdem vollstaendig bearbeitet.
    expect(result.truncated).toBe(false);
  });

  it("laesst eine bekannte, aber kantenlose Wurzel unmarkiert — sie WURDE bearbeitet", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const isolated = graph.nodes().find((node) => node.filePath === "src/b.ts")?.fileId as string;
    const result = graph.traverse([isolated], { direction: "forward" });
    expect(result.unknownRootFileIds).toBeUndefined();
    expect(result.visitedFileIds).toEqual([]);
  });
});

describe("WP-196 — der Abschneidegrund nennt die Grenze, an der etwas verloren ging", () => {
  it("meldet max_nodes, auch wenn zuvor die Tiefengrenze einen Ast beschnitten hat", async () => {
    const { graph } = await buildMiniWorkspace(TWO_ROOTS);
    const byPath = new Map(graph.nodes().map((node) => [node.filePath, node.fileId]));
    const roots = [byPath.get("src/a.ts") as string, byPath.get("src/x.ts") as string].sort();

    // maxDepth=1 beschneidet zuerst den Ast der ersten Wurzel (a → b, b
    // haette noch c). Danach reisst maxNodes=1 auf dem zweiten Ast das
    // GLOBALE Budget. Frueher blieb `max_depth` als Grund stehen — die
    // Grenze, die gerade NICHT den Verlust verursacht hat.
    const result = graph.traverse(roots, {
      direction: "forward",
      limits: { maxDepth: 1, maxNodes: 1 },
    });

    expect(result.truncated).toBe(true);
    expect(result.visitedFileIds).toHaveLength(1);
    expect(
      result.truncationReason,
      "der genannte Grund muss der sein, an dem Knoten verloren gingen",
    ).toBe("max_nodes");
  });

  it("meldet weiterhin max_depth, wenn NUR die Tiefe greift", async () => {
    const { graph } = await buildMiniWorkspace(TWO_ROOTS);
    const byPath = new Map(graph.nodes().map((node) => [node.filePath, node.fileId]));
    const result = graph.traverse(
      [byPath.get("src/a.ts") as string, byPath.get("src/x.ts") as string],
      { direction: "forward", limits: { maxDepth: 1 } },
    );
    expect(result.truncationReason).toBe("max_depth");
    expect(result.unvisitedRootFileIds).toBeUndefined();
  });
});

describe("WP-195 — eine Loeschung fuer eine unbekannte file_id ist ein Befund", () => {
  it("legt sie in den Skip-Ledger, statt sie spurlos zu verwerfen", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const before = graph.nodes().length;
    const update = graph.applyChanges([{ kind: "removed", fileId: "nie-dagewesen" }]);

    expect(graph.nodes()).toHaveLength(before);
    expect(
      update.skipped.some(
        (entry) => entry.subjectId === "nie-dagewesen" && entry.reason === "missing_index_entry",
      ),
      "die unmoegliche Loeschung fehlt im Ledger",
    ).toBe(true);
  });

  it("schweigt bei einer echten Loeschung", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const existing = graph.nodes().find((node) => node.filePath === "src/b.ts")?.fileId as string;
    const update = graph.applyChanges([{ kind: "removed", fileId: existing }]);
    expect(update.skipped.some((entry) => entry.reason === "missing_index_entry")).toBe(false);
  });
});

describe("WP-193 — ein fehlender workspaceId wird nicht zum Leerstring", () => {
  it("meldet ihn als Befund und liefert kein Abbild mit leerem Geltungsbereich", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const store = new InMemoryGraphStore();
    const snapshot = graph.snapshot();
    await writeGraphSnapshot(store, snapshot, "write-1");

    const shards = toGraphShards(snapshot, "write-2").map((shard) =>
      shard.logicalShardId === fileGraphMetaShardId(TEST_WORKSPACE_ID)
        ? {
            ...shard,
            payload: Object.fromEntries(
              Object.entries(shard.payload).filter(([key]) => key !== "workspaceId"),
            ),
          }
        : shard,
    );
    await store.writeShards(shards);

    const loaded = await readGraphSnapshot(store, TEST_SCOPE);
    expect(loaded.snapshot).toBeNull();
    expect(loaded.issues.some((issue) => issue.message.includes("workspaceId"))).toBe(true);
  });
});

describe("WP-181 — ein Abbild darf sich nicht selbst widersprechen", () => {
  it("befragt metrics.nodeCount als dritten Zeugen", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const store = new InMemoryGraphStore();
    const snapshot = graph.snapshot();

    // Nur die METRIKEN werden verfaelscht — `nodeCount` und `edgeCount` des
    // Metadaten-Shards bleiben richtig, der Pfadindex ebenfalls. Genau dieser
    // Fall lief bisher ohne einen einzigen Befund durch.
    const shards = toGraphShards(snapshot, "write-1").map((shard) =>
      shard.logicalShardId === fileGraphMetaShardId(TEST_WORKSPACE_ID)
        ? {
            ...shard,
            payload: {
              ...shard.payload,
              metrics: { ...snapshot.metrics, nodeCount: snapshot.nodes.length + 1 },
            },
          }
        : shard,
    );
    await store.writeShards(shards);

    const loaded = await readGraphSnapshot(store, TEST_SCOPE);
    expect(loaded.issues.some((issue) => issue.message.includes("metrics.nodeCount"))).toBe(true);
    expect(loaded.issues.every((issue) => issue.kind === "count_mismatch")).toBe(true);
  });

  it("schweigt bei einem stimmigen Abbild", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const store = new InMemoryGraphStore();
    await writeGraphSnapshot(store, graph.snapshot(), "write-1");
    expect((await readGraphSnapshot(store, TEST_SCOPE)).issues).toEqual([]);
  });
});

describe("WP-197 — eine Kollision im Pfadindex wird benannt", () => {
  it("haelt den verdraengten file_id fest, statt ihn ersatzlos zu verlieren", async () => {
    const { graph } = await buildMiniWorkspace(WORKSPACE);
    const snapshot = graph.snapshot();
    const first = snapshot.nodes[0];
    const second = snapshot.nodes[1];
    if (first === undefined || second === undefined) throw new Error("Fixture zu klein");

    // Zwei Knoten mit demselben repo-relativen Pfad — verschiedene file_ids.
    const colliding = {
      ...snapshot,
      nodes: [first, { ...second, filePath: first.filePath }],
    };
    const shards = toGraphShards(colliding, "write-1");
    const indexShard = shards.find(
      (shard) => shard.logicalShardId === fileGraphPathIndexShardId(TEST_WORKSPACE_ID),
    );
    const collisions = indexShard?.payload["pathIndexCollisions"];
    expect(Array.isArray(collisions)).toBe(true);
    expect(JSON.stringify(collisions)).toContain(second.fileId);

    // Und beim Zurueckladen wird die Kollision zum Befund — genau dort, wo
    // sie wirkt: die verdraengte file_id kann kein fehlender Shard mehr sein.
    const store = new InMemoryGraphStore();
    await store.writeShards(shards);
    const loaded = await readGraphSnapshot(store, TEST_SCOPE);
    expect(loaded.issues.some((issue) => issue.message.includes("path collision"))).toBe(true);
  });
});
