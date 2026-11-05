/**
 * WP-100: Beweis, dass die inhaltsadressierten Caches fuer Parse, Chunk und
 * Komplexitaet EXAKT dasselbe Ergebnis liefern wie das Rechnen.
 *
 * WARUM DIESE VIER FAELLE UND KEINE ANDEREN:
 *
 * 1. GLEICHES ERGEBNIS. Ein Cache, der ein anderes Ergebnis liefert als die
 *    Rechnung, ist schlimmer als kein Cache, weil ihn niemand sieht. Geprueft
 *    wird deshalb Punkt fuer Punkt: Chunk-ID, Inhalts-Hash, Metrikfelder,
 *    Zeilen — und zusaetzlich das Skip-Ledger, denn ein Cache, der Gruende
 *    verschluckt, macht Gemeldetes stillschweigend (E4).
 * 2. DIE VERSIONEN STEHEN IM SCHLUESSEL. Ohne das liefert eine neue
 *    Algorithmusfassung alte Werte weiter — die schlimmste Form von E4.
 * 3. EIN BESCHAEDIGTER EINTRAG WIRD NEU GERECHNET, nicht geraten.
 * 4. EINE UM EIN ZEICHEN GEAENDERTE DATEI VERFAELLT GENAU IHREN EINTRAG —
 *    nicht mehr (sonst waere der Cache wertlos) und nicht weniger (sonst waere
 *    er falsch).
 */
import {
  buildRefId,
  CHUNKER_VERSION,
  COGNITIVE_ALGORITHM_ID,
  METRICS_VERSION,
  PARSER_VERSION,
  type EmbeddingProfile,
} from "@untangle-code/domain";
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
import type { AnalysisCacheKind, AnalysisCacheLike, IndexPortsV1, IndexTargetV1 } from "./types.js";

const ROOT = "/repo";
const WORKSPACE_ID = "11111111-1111-5111-8111-111111111111";
const REPO_ID = "repo-under-test";
const REF_NAME = "main";
const REF_ID = buildRefId(REPO_ID, REF_NAME);
const PROFILE: EmbeddingProfile = { ...OFFLINE_EMBEDDING_PROFILE, dimensions: 32 };

const ALPHA = `export function alpha(value: number): number {
  if (value > 0) {
    return value * 2;
  }
  return 0;
}
`;

const BETA = `import { alpha } from "./alpha.js";

export class Beta {
  run(input: number): number {
    return alpha(input) + 1;
  }
}
`;

/** Ein Cache im Speicher, der jeden Zugriff protokolliert. */
class RecordingCache implements AnalysisCacheLike {
  public readonly store = new Map<string, unknown>();
  public readonly lookups: { kind: AnalysisCacheKind; key: string }[] = [];
  public flushed = 0;

  public get(kind: AnalysisCacheKind, key: string): Promise<unknown | null> {
    this.lookups.push({ kind, key });
    const value = this.store.get(`${kind}|${key}`);
    return Promise.resolve(value === undefined ? null : structuredClone(value));
  }

  public set(kind: AnalysisCacheKind, key: string, value: unknown): Promise<void> {
    this.store.set(`${kind}|${key}`, structuredClone(value));
    return Promise.resolve();
  }

  public flush(): Promise<void> {
    this.flushed++;
    return Promise.resolve();
  }

  /** Ersetzt jeden abgelegten Wert durch Unsinn. */
  public poison(): void {
    for (const key of this.store.keys()) {
      this.store.set(key, { v: 1, kaputt: true });
    }
  }
}

interface Harness {
  fs: MemoryFileSystem;
  vectorStore: InMemoryVectorStore;
  options: RunIndexOptions;
}

/**
 * Jeder Aufruf baut FRISCHE Speicher (Metadaten, Vektoren, Checkpoints) — nur
 * der Cache wird hereingereicht. Damit ist jeder Lauf ein echter Erstlauf, und
 * ein Treffer stammt garantiert aus dem Cache und nicht aus einem Checkpoint.
 */
function makeHarness(cache?: AnalysisCacheLike, alphaSource: string = ALPHA): Harness {
  const clock = new FakeClock(1_700_000_000_000);
  const random = new DeterministicRandom(7);
  const fs = new MemoryFileSystem(clock);
  fs.seedDirectory(ROOT);
  fs.seedDirectory(`${ROOT}/src`);
  fs.seedFile(`${ROOT}/src/alpha.ts`, alphaSource);
  fs.seedFile(`${ROOT}/src/beta.ts`, BETA);
  fs.seedFile(`${ROOT}/README.md`, "# Titel\n\nEin Satz ueber alpha.\n");
  fs.seedFile(`${ROOT}/daten.xyz`, "abschnitt: schluessel wert alpha\n");
  fs.seedDirectory("/state");

  const vectorStore = new InMemoryVectorStore();
  const embedder = new OfflineEmbeddingProvider(clock, PROFILE);
  const target: IndexTargetV1 = {
    workspaceId: WORKSPACE_ID,
    repoId: REPO_ID,
    refId: REF_ID,
    refName: REF_NAME,
    repoLabel: "repo",
    rootPath: ROOT,
  };
  const ports: IndexPortsV1 = {
    fs,
    parsers: createParserRegistry(),
    embedder,
    vectorStore,
    metadataStore: new InMemoryMetadataStore(),
    graphStore: new InMemoryGraphStore(),
    clock,
    random,
    ...(cache === undefined ? {} : { analysisCache: cache }),
  };

  return {
    fs,
    vectorStore,
    options: {
      ports,
      target,
      profile: embedder.profile,
      embeddingProfileId: embedder.profileId,
      collection: "code",
      provisionCollection: async () => {
        await vectorStore.ensureCollection({
          name: "code",
          denseDimensions: embedder.profile.dimensions,
          denseDistance: "Cosine",
          sparseBm25: true,
          onDiskPayload: true,
        });
      },
      sparseVectorizer: textToSparseVector,
      storeUrl: "memory://vector-store",
      configHash: "hash-of-config",
      checkpointStore: new FileCheckpointStore(fs, { directory: "/state/jobs" }),
      lockProvider: new InMemoryLockProvider(clock, random),
    },
  };
}

/** Die Ergebnisdaten eines Laufs, kanonisch geordnet und vergleichbar. */
async function snapshot(store: InMemoryVectorStore): Promise<string[]> {
  const page = await store.scroll("code", { limit: 1000 });
  return page.points
    .map((point) => {
      const payload = point.payload as Record<string, unknown>;
      return [
        String(payload["chunk_id"]),
        String(payload["file_path"]),
        String(payload["start_line"]),
        String(payload["end_line"]),
        String(payload["content_hash"]),
        String(payload["symbol_fqn"] ?? "-"),
        String(payload["cyclomatic_classic"] ?? "-"),
        String(payload["cyclomatic_extended"] ?? "-"),
        String(payload["cognitive"] ?? "-"),
        String(payload["sloc"] ?? "-"),
        String(payload["parse_quality"]),
        String(payload["chunk_kind"]),
      ].join("\t");
    })
    .sort();
}

describe("WP-100 — inhaltsadressierte Caches fuer Parse, Chunk und Komplexitaet", () => {
  it("der Lauf aus dem Cache liefert Punkt fuer Punkt dasselbe wie der gerechnete", async () => {
    const cache = new RecordingCache();

    const erster = makeHarness(cache);
    const berichtEins = await runIndex(erster.options);
    const punkteEins = await snapshot(erster.vectorStore);

    const zweiter = makeHarness(cache);
    const berichtZwei = await runIndex(zweiter.options);
    const punkteZwei = await snapshot(zweiter.vectorStore);

    expect(berichtEins.outcome).toBe("completed");
    expect(berichtZwei.outcome).toBe("completed");

    // Der zweite Lauf hat NICHTS gerechnet ...
    expect(berichtEins.counts.parseCacheHits).toBe(0);
    expect(berichtZwei.counts.parseCacheMisses).toBe(0);
    expect(berichtZwei.counts.parseCacheHits).toBe(berichtZwei.counts.filesAnalyzed);
    expect(berichtZwei.counts.chunkCacheHits).toBe(berichtZwei.counts.filesAnalyzed);
    expect(berichtZwei.counts.metricsCacheHits).toBe(berichtZwei.counts.filesAnalyzed);

    // ... und trotzdem exakt dasselbe geliefert.
    expect(punkteZwei).toEqual(punkteEins);
    expect(berichtZwei.counts.chunks).toBe(berichtEins.counts.chunks);
    expect(berichtZwei.counts.symbols).toBe(berichtEins.counts.symbols);
    expect(berichtZwei.counts.points).toBe(berichtEins.counts.points);

    // Auch das Ledger: ein Cache, der Gruende verschluckt, macht aus einer
    // gemeldeten Abstufung ein stillschweigendes Ueberspringen (E4).
    expect(berichtZwei.skipped).toEqual(berichtEins.skipped);
    expect(berichtZwei.skippedByReason).toEqual(berichtEins.skippedByReason);
    expect(berichtZwei.skippedByStage).toEqual(berichtEins.skippedByStage);
  });

  it("jeder Schluessel traegt die Versionskonstante seiner Rechnung", async () => {
    const cache = new RecordingCache();
    await runIndex(makeHarness(cache).options);

    const parse = cache.lookups.filter((entry) => entry.kind === "parse");
    const chunk = cache.lookups.filter((entry) => entry.kind === "chunk");
    const metrics = cache.lookups.filter((entry) => entry.kind === "metrics");
    expect(parse.length).toBeGreaterThan(0);
    expect(chunk.length).toBeGreaterThan(0);
    expect(metrics.length).toBeGreaterThan(0);

    for (const entry of parse) {
      expect(entry.key.startsWith(`parse ${PARSER_VERSION} `)).toBe(true);
    }
    for (const entry of chunk) {
      // Chunker-Version UND Parser-Version: die Chunks entstehen aus den
      // Regionen des Parsers.
      expect(entry.key.startsWith(`chunk ${CHUNKER_VERSION} ${PARSER_VERSION} `)).toBe(true);
    }
    for (const entry of metrics) {
      expect(
        entry.key.startsWith(
          `metrics ${METRICS_VERSION} ${PARSER_VERSION} ${COGNITIVE_ALGORITHM_ID} `,
        ),
      ).toBe(true);
    }
  });

  it("ein beschaedigter Eintrag wird neu gerechnet, nicht geraten", async () => {
    const cache = new RecordingCache();
    const erster = makeHarness(cache);
    await runIndex(erster.options);
    const punkteEins = await snapshot(erster.vectorStore);

    cache.poison();

    const zweiter = makeHarness(cache);
    const bericht = await runIndex(zweiter.options);
    const punkteZwei = await snapshot(zweiter.vectorStore);

    expect(bericht.outcome).toBe("completed");
    expect(bericht.counts.parseCacheHits).toBe(0);
    expect(bericht.counts.chunkCacheHits).toBe(0);
    expect(bericht.counts.metricsCacheHits).toBe(0);
    expect(punkteZwei).toEqual(punkteEins);
  });

  it("eine um ein Zeichen geaenderte Datei verfaellt GENAU ihren Eintrag", async () => {
    const cache = new RecordingCache();
    const erster = makeHarness(cache);
    const berichtEins = await runIndex(erster.options);
    const punkteEins = await snapshot(erster.vectorStore);
    const dateien = berichtEins.counts.filesAnalyzed;

    // Ein Zeichen: `value * 2` wird zu `value * 3`.
    const geaendert = ALPHA.replace("value * 2", "value * 3");
    expect(geaendert).not.toBe(ALPHA);

    const zweiter = makeHarness(cache, geaendert);
    const berichtZwei = await runIndex(zweiter.options);
    const punkteZwei = await snapshot(zweiter.vectorStore);

    expect(berichtZwei.counts.parseCacheHits).toBe(dateien - 1);
    expect(berichtZwei.counts.parseCacheMisses).toBe(1);
    expect(berichtZwei.counts.chunkCacheHits).toBe(dateien - 1);
    expect(berichtZwei.counts.chunkCacheMisses).toBe(1);
    expect(berichtZwei.counts.metricsCacheHits).toBe(dateien - 1);
    expect(berichtZwei.counts.metricsCacheMisses).toBe(1);

    // Genau die Punkte von alpha.ts unterscheiden sich, kein einziger anderer.
    const nurAlphaEins = punkteEins.filter((row) => row.includes("src/alpha.ts"));
    const nurAlphaZwei = punkteZwei.filter((row) => row.includes("src/alpha.ts"));
    expect(nurAlphaZwei).not.toEqual(nurAlphaEins);
    expect(punkteZwei.filter((row) => !row.includes("src/alpha.ts"))).toEqual(
      punkteEins.filter((row) => !row.includes("src/alpha.ts")),
    );
  });

  it("ohne Cache laeuft alles wie zuvor — der Zwischenspeicher ist optional", async () => {
    const ohne = makeHarness();
    const bericht = await runIndex(ohne.options);
    expect(bericht.outcome).toBe("completed");
    expect(bericht.counts.parseCacheHits).toBe(0);
    expect(bericht.counts.parseCacheMisses).toBe(0);
    expect(bericht.counts.chunkCacheMisses).toBe(0);
    expect(bericht.counts.metricsCacheMisses).toBe(0);
  });
});
