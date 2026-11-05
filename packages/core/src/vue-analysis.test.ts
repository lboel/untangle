import type { ProductFeatureManifestV1 } from "@untangle-code/domain";
import { buildRefId, parserVersionForLanguage } from "@untangle-code/domain";
import { FileCheckpointStore } from "@untangle-code/jobs";
import { createParserRegistry } from "@untangle-code/parser-registry";
import {
  DeterministicRandom,
  FakeClock,
  InMemoryGraphStore,
  InMemoryLockProvider,
  InMemoryMetadataStore,
  InMemoryVectorStore,
  MemoryFileSystem,
  textToSparseVector,
} from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { OFFLINE_EMBEDDING_PROFILE, OfflineEmbeddingProvider } from "./offline-embedder.js";
import { runIndex, type RunIndexOptions } from "./pipeline.js";
import { collectProductInventory, measureProductFiles } from "./product-alignment/analysis.js";
import { analyzeProductAlignment } from "./product-alignment/report.js";
import type { AnalysisCacheKind, AnalysisCacheLike } from "./types.js";

const ROOT = "/vue-project";
const SCRIPT = [
  "export function feature(enabled: boolean): boolean {",
  "  if (enabled) return helper(enabled);",
  "  return false;",
  "}",
  "function helper(value: boolean): boolean {",
  "  if (value) return true;",
  "  return false;",
  "}",
].join("\n");
const TEMPLATE = '<button v-if="ready">Grüße 🌿 TemplateOnlyMarker</button>';
const STYLE = ".ready { color: green; }";
const SFC = `<template>${TEMPLATE}</template>\r\n<script setup lang="ts">\r\n${SCRIPT}\r\n</script>\r\n<style>${STYLE}</style>`;

function sources(files: Readonly<Record<string, string>>): MemoryFileSystem {
  const fs = new MemoryFileSystem(new FakeClock(100));
  fs.seedDirectory(ROOT);
  for (const [name, content] of Object.entries(files)) fs.seedFile(`${ROOT}/${name}`, content);
  return fs;
}

function featureManifest(): ProductFeatureManifestV1 {
  return {
    schemaVersion: 1,
    owners: [
      {
        id: "ui",
        label: "UI team",
        kind: "team",
        status: "declared",
        sources: [{ path: "vision.md", heading: "Ownership" }],
      },
    ],
    features: ["render", "save"].map((id) => ({
      id,
      title: id,
      stage: "implemented",
      review: "proposed",
      intent: [
        { role: "vision", path: "vision.md", heading: "Intent" },
        { role: "specification", path: "spec.md", heading: "Contract" },
      ],
      owners: ["ui"],
      code: { include: ["Widget.vue"] },
      tests: { include: ["Widget.test.ts"] },
      criteria: [{ id: "works", description: "Declared behavior", tests: ["Widget.test.ts"] }],
      dependsOn: [],
    })),
  };
}

class MemoryAnalysisCache implements AnalysisCacheLike {
  readonly entries = new Map<string, unknown>();
  async get(kind: AnalysisCacheKind, key: string): Promise<unknown | null> {
    return structuredClone(this.entries.get(`${kind}:${key}`) ?? null);
  }
  async set(kind: AnalysisCacheKind, key: string, value: unknown): Promise<void> {
    this.entries.set(`${kind}:${key}`, structuredClone(value));
  }
  async flush(): Promise<void> {
    /* All writes are already in memory. */
  }
}

function indexHarness(cache: AnalysisCacheLike): {
  options: RunIndexOptions;
  store: InMemoryVectorStore;
} {
  const clock = new FakeClock(100);
  const random = new DeterministicRandom(7);
  const fs = sources({ "Widget.vue": SFC });
  fs.seedDirectory("/state");
  const store = new InMemoryVectorStore();
  const embedder = new OfflineEmbeddingProvider(clock, {
    ...OFFLINE_EMBEDDING_PROFILE,
    dimensions: 32,
  });
  return {
    store,
    options: {
      ports: {
        fs,
        parsers: createParserRegistry(),
        embedder,
        vectorStore: store,
        metadataStore: new InMemoryMetadataStore(),
        graphStore: new InMemoryGraphStore(),
        clock,
        random,
        analysisCache: cache,
      },
      target: {
        workspaceId: "11111111-1111-5111-8111-111111111111",
        repoId: "vue",
        refId: buildRefId("vue", "main"),
        refName: "main",
        repoLabel: "Vue project",
        rootPath: ROOT,
      },
      profile: embedder.profile,
      embeddingProfileId: embedder.profileId,
      collection: "vue-code",
      provisionCollection: async () => {
        await store.ensureCollection({
          name: "vue-code",
          denseDimensions: 32,
          denseDistance: "Cosine",
          sparseBm25: true,
          onDiskPayload: true,
        });
      },
      sparseVectorizer: textToSparseVector,
      storeUrl: "memory://vue",
      configHash: "vue-config",
      checkpointStore: new FileCheckpointStore(fs, { directory: "/state/jobs" }),
      lockProvider: new InMemoryLockProvider(clock, random),
    },
  };
}

describe("Vue product and index consumers", () => {
  it("measures all inline functions including private helpers with native TS readings", async () => {
    const inventory = await collectProductInventory({
      root: ROOT,
      fs: sources({ "Widget.vue": SFC, "native.ts": SCRIPT }),
    });
    const measured = await measureProductFiles(inventory, ["Widget.vue", "native.ts"]);
    const vue = measured.get("Widget.vue");
    const native = measured.get("native.ts");
    expect(vue?.evidence.status).toBe("measured");
    expect(vue?.metrics).toMatchObject({
      scopes: 3,
      executionUnitRoots: 2,
      cognitive: { self: 2, execution_unit: 2, top_level: 4 },
      cyclomaticClassic: { self: 5, execution_unit: 5, top_level: 3 },
    });
    expect(vue?.metrics?.cognitive).toEqual(native?.metrics?.cognitive);
    expect(vue?.metrics?.cyclomaticClassic).toEqual(native?.metrics?.cyclomaticClassic);
    expect(vue?.metrics?.cyclomaticExtended).toEqual(native?.metrics?.cyclomaticExtended);
    expect(vue?.hotspots.map((entry) => entry.symbol)).toEqual(["feature", "helper"]);
    expect(vue?.hotspots.find((entry) => entry.symbol === "feature")?.startLine).toBe(3);
    expect(vue?.limitations?.filter((entry) => entry.includes("Vue analysis scope:")).length).toBe(
      2,
    );
  });

  it("keeps nested execution units visible without summing inclusive child values twice", async () => {
    const code =
      "export function outer(value: boolean) {\n  return () => { if (value) return 1; return 0; };\n}\n";
    const inventory = await collectProductInventory({
      root: ROOT,
      fs: sources({
        "Nested.vue": `<template>🌿</template><script setup lang="ts">${code}</script>`,
      }),
    });
    const vue = (await measureProductFiles(inventory, ["Nested.vue"])).get("Nested.vue");
    expect(vue?.evidence.status).toBe("measured");
    expect(vue?.metrics).toMatchObject({
      scopes: 3,
      executionUnitRoots: 1,
      cognitive: { self: 1, execution_unit: 2, top_level: 3 },
    });
    expect(vue?.hotspots).toHaveLength(2);
    expect(vue?.hotspots.reduce((sum, entry) => sum + entry.cognitive, 0)).toBeGreaterThan(
      vue?.metrics?.cognitive.execution_unit ?? Infinity,
    );
  });

  it("exposes full feature measurements and scope limits while deduplicating the shared file union", async () => {
    const fs = sources({
      "Widget.vue": SFC,
      "Widget.test.ts": "export function verifiesFeature() { return true; }",
      "vision.md": "# Intent\nDisplay and save.\n# Ownership\nUI team.\n",
      "spec.md": "# Contract\nPreserve behavior.\n",
      ".untangle/features.json": JSON.stringify(featureManifest()),
    });
    const report = await analyzeProductAlignment({ root: ROOT, fs });
    expect(report.manifest.status).toBe("loaded");
    expect(report.features).toHaveLength(2);
    expect(
      report.features.every(
        (feature) => feature.code.complete && feature.code.metrics?.cognitive.execution_unit === 2,
      ),
    ).toBe(true);
    expect(report.coverage.mappedCodeUnion).toMatchObject({
      files: 1,
      scopes: 3,
      cognitive: { execution_unit: 2 },
    });
    expect(report.coverage.sharedFiles).toEqual([
      { path: "Widget.vue", featureIds: ["render", "save"] },
    ]);
    expect(
      report.limitations.some((entry) => entry.includes("Widget.vue: Vue analysis scope:")),
    ).toBe(true);
    expect(report.semanticConformance).toBe("not_independently_proven");
    expect(report.features.every((feature) => feature.review === "proposed")).toBe(true);
  });

  it("preserves script payloads, original text and range limitations through the actual index cache", async () => {
    const cache = new MemoryAnalysisCache();
    const first = indexHarness(cache);
    const baseline = await runIndex(first.options);
    const second = indexHarness(cache);
    const cached = await runIndex(second.options);
    expect(baseline.outcome).toBe("completed");
    expect(cached.outcome).toBe("completed");
    expect(cached.counts.parseCacheHits).toBe(1);
    expect(cached.counts.metricsCacheHits).toBe(1);
    const limits = baseline.skipped.filter(
      (entry) => entry.reason === "no_metric_defined" && entry.subjectKind === "range",
    );
    expect(limits).toHaveLength(2);
    limits.sort((left, right) => left.range!.startByte - right.range!.startByte);
    expect(
      limits.map((entry) =>
        Buffer.from(SFC).subarray(entry.range!.startByte, entry.range!.endByte).toString("utf8"),
      ),
    ).toEqual([TEMPLATE, STYLE]);
    expect(cached.skipped).toEqual(baseline.skipped);
    const original = await first.store.scroll("vue-code", { limit: 100 });
    const replayed = await second.store.scroll("vue-code", { limit: 100 });
    expect(replayed.points).toEqual(original.points);
    const payloads = original.points.map((point) => point.payload as Record<string, unknown>);
    expect(
      payloads.some((payload) => String(payload["content"]).includes("TemplateOnlyMarker")),
    ).toBe(true);
    expect(payloads.some((payload) => String(payload["content"]).includes(STYLE))).toBe(true);
    expect(payloads.find((payload) => payload["symbol_fqn"] === "helper")).toMatchObject({
      cognitive: 1,
      parser_version: parserVersionForLanguage("vue"),
    });
    for (const payload of payloads) {
      expect(payload["content"]).toBe(
        Buffer.from(SFC)
          .subarray(Number(payload["start_byte"]), Number(payload["end_byte"]))
          .toString("utf8"),
      );
    }
  });
});
