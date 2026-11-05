/**
 * Der ganze Indexlauf gegen Ports im Speicher.
 *
 * WAS HIER BEWIESEN WIRD, und warum genau das:
 *
 * 1. EIN LAUF GEHT DURCH und legt Punkte ab, deren Nutzlast die Felder traegt,
 *    von denen die Suche lebt (Pfad, Symbol, Inhalt, Profil-ID).
 * 2. DER ZWEITE LAUF RECHNET NICHTS NEU. Das ist die Pflicht aus der Aufgabe,
 *    nicht die Kuer — und sie ist nur dann bewiesen, wenn der Einbetter beim
 *    zweiten Lauf NULL Aufrufe sieht.
 * 3. EINE GEAENDERTE DATEI WIRD ERKANNT — sonst waere Punkt 2 nur „tut nichts".
 * 4. EINE GELOESCHTE DATEI VERLIERT IHRE PUNKTE. Ein Index, der Geloeschtes
 *    weiter ausliefert, ist schlimmer als ein veralteter.
 * 5. EIN AUSGEFALLENER EINBETTER ERGIBT `failed`, NIE `completed`. Das ist der
 *    Fehler, den Welle 4 gefunden hat, an der Stelle, an der er entstuende.
 * 6. WAS NICHT INDIZIERT WERDEN KONNTE, STEHT MIT GRUND IM LEDGER.
 */
import {
  UntangleError,
  buildFileId,
  buildRefId,
  type EmbeddingBatchResultV1,
  type EmbeddingProfile,
  type EmbeddingProvider,
  type EmbeddingReadinessV1,
  type FileSystemPort,
  type PortCallOptions,
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
import { beforeEach, describe, expect, it } from "vitest";

import { OFFLINE_EMBEDDING_PROFILE, OfflineEmbeddingProvider } from "./offline-embedder.js";
import { runIndex, type RunIndexOptions } from "./pipeline.js";
import type { IndexPortsV1, IndexTargetV1 } from "./types.js";

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

/** Ein Einbetter, der zaehlt — und auf Wunsch ausfaellt. */
class CountingEmbedder implements EmbeddingProvider {
  readonly profile: EmbeddingProfile;
  readonly profileId: string;
  documentCalls = 0;
  embeddedTexts = 0;
  failOnDocuments = false;

  private readonly inner: OfflineEmbeddingProvider;

  constructor(clock: FakeClock, profile: EmbeddingProfile = PROFILE) {
    this.inner = new OfflineEmbeddingProvider(clock, profile);
    this.profile = this.inner.profile;
    this.profileId = this.inner.profileId;
  }

  ensureReady(): Promise<EmbeddingReadinessV1> {
    return this.inner.ensureReady();
  }

  async embedDocuments(preparedTexts: string[]): Promise<EmbeddingBatchResultV1> {
    this.documentCalls++;
    this.embeddedTexts += preparedTexts.length;
    if (this.failOnDocuments) {
      throw new Error("Der Einbettungsdienst antwortet nicht.");
    }
    return this.inner.embedDocuments(preparedTexts);
  }

  embedQuery(preparedText: string): Promise<number[]> {
    return this.inner.embedQuery(preparedText);
  }
}

interface Harness {
  fs: MemoryFileSystem;
  clock: FakeClock;
  vectorStore: InMemoryVectorStore;
  metadataStore: InMemoryMetadataStore;
  graphStore: InMemoryGraphStore;
  embedder: CountingEmbedder;
  checkpointStore: FileCheckpointStore;
  options: () => RunIndexOptions;
}

function makeHarness(): Harness {
  const clock = new FakeClock(1_700_000_000_000);
  const random = new DeterministicRandom(7);
  const fs = new MemoryFileSystem(clock);
  fs.seedDirectory(ROOT);
  fs.seedDirectory(`${ROOT}/src`);
  fs.seedFile(`${ROOT}/src/alpha.ts`, ALPHA);
  fs.seedFile(`${ROOT}/src/beta.ts`, BETA);
  fs.seedFile(`${ROOT}/README.md`, "# Titel\n\nEin Satz ueber alpha.\n");
  // Fuer diese Endung gibt es keinen Sprachadapter — genau der Fall, den der
  // Ledger sichtbar machen muss.
  fs.seedFile(`${ROOT}/daten.xyz`, "abschnitt: schluessel wert alpha\n");
  fs.seedDirectory("/state");

  const vectorStore = new InMemoryVectorStore();
  const metadataStore = new InMemoryMetadataStore();
  const graphStore = new InMemoryGraphStore();
  const embedder = new CountingEmbedder(clock);
  const checkpointStore = new FileCheckpointStore(fs, { directory: "/state/jobs" });

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
    metadataStore,
    graphStore,
    clock,
    random,
  };

  return {
    fs,
    clock,
    vectorStore,
    metadataStore,
    graphStore,
    embedder,
    checkpointStore,
    options: () => ({
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
      checkpointStore,
      lockProvider: new InMemoryLockProvider(clock, random),
    }),
  };
}

function interceptFileReads(
  inner: FileSystemPort,
  interceptedPath: string,
  intercept: (ordinal: number) => Uint8Array | Error | undefined,
): { fs: FileSystemPort; readCount: () => number } {
  let readCount = 0;
  const fs = new Proxy(inner, {
    get(target, property) {
      if (property === "readFile") {
        return async (path: string, options?: PortCallOptions): Promise<Uint8Array> => {
          if (path === interceptedPath) {
            readCount += 1;
            const injected = intercept(readCount);
            if (injected instanceof Error) throw injected;
            if (injected !== undefined) return injected;
          }
          return target.readFile(path, options);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { fs, readCount: () => readCount };
}

describe("runIndex", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("indexes a small repository end to end", async () => {
    const report = await runIndex({ ...harness.options(), generationId: "gen-test" });

    expect(report.outcome).toBe("completed");
    expect(report.generationId).toBe("gen-test");
    expect(report.failure).toBeUndefined();
    expect(report.counts.filesSeen).toBe(4);
    expect(report.counts.filesPlanned).toBe(4);
    expect(report.counts.filesAnalyzed).toBe(4);
    expect(report.counts.chunks).toBeGreaterThan(0);
    expect(report.counts.points).toBe(report.counts.chunks);
    expect(report.counts.symbols).toBeGreaterThan(0);
    expect(report.counts.fileGraphNodes).toBe(4);
    expect(report.counts.symbolGraphNodes).toBeGreaterThan(0);

    const page = await harness.vectorStore.scroll("code", { limit: 1000 });
    expect(page.points.length).toBe(report.counts.points);
    const payloads = page.points.map((point) => point.payload);
    expect(payloads.every((p) => p["workspace_id"] === WORKSPACE_ID)).toBe(true);
    expect(payloads.every((p) => p["embedding_profile_id"] === harness.embedder.profileId)).toBe(
      true,
    );
    expect(payloads.every((p) => p["generation_id"] === report.generationId)).toBe(true);
    expect(payloads.every((p) => p["metrics_version"] === "untangle-metrics-v1")).toBe(true);
    expect(payloads.some((p) => p["file_path"] === "src/alpha.ts")).toBe(true);
    expect(payloads.some((p) => p["symbol_fqn"] === "alpha")).toBe(true);
    expect(payloads.every((p) => typeof p["content"] === "string")).toBe(true);
    expect(payloads.every((p) => p["embedding_truncated"] === false)).toBe(true);

    const manifests = await harness.metadataStore.listFileManifests(REF_ID);
    expect(manifests).toHaveLength(4);
    const ref = await harness.metadataStore.getRefRecord(REF_ID);
    expect(ref?.indexStatus).toBe("completed");
    expect(ref?.generationId).toBe(report.generationId);
  });

  it("does not enter the mutation pipeline when the generation marker cannot be persisted", async () => {
    const observedGenerations: string[] = [];
    const terminalStates: string[] = [];
    const report = await runIndex({
      ...harness.options(),
      generationId: "generation-marker-required",
      onGenerationStarted: async (generationId) => {
        observedGenerations.push(generationId);
        throw new Error("state publication failed");
      },
      onGenerationFinished: async (generationId, outcome) => {
        terminalStates.push(`${generationId}:${outcome}`);
      },
    });

    expect(observedGenerations).toEqual(["generation-marker-required"]);
    expect(terminalStates).toEqual(["generation-marker-required:failed"]);
    expect(report).toMatchObject({
      outcome: "failed",
      generationId: "generation-marker-required",
      failure: { code: "INDEX_INCOMPLETE" },
    });
    expect(report.counts.filesAnalyzed).toBe(0);
    expect(report.counts.points).toBe(0);
    expect(harness.embedder.documentCalls).toBe(0);
    expect(await harness.metadataStore.getRefRecord(REF_ID)).toBeNull();
  });

  it("prunes orphaned legacy points on an unchanged resumed run while keeping current points", async () => {
    const first = await runIndex({ ...harness.options(), generationId: "current-generation" });
    expect(first.outcome).toBe("completed");
    const before = await harness.vectorStore.scroll("code", { limit: 1000 });
    const original = before.points[0];
    expect(original).toBeDefined();
    if (original === undefined) throw new Error("fixture must contain a code point");
    const legacyPayload: Record<string, unknown> = {
      ...original.payload,
      file_id: "orphan-without-manifest",
    };
    delete legacyPayload["generation_id"];
    await harness.vectorStore.upsert("code", [
      { ...original, id: "legacy-orphan", payload: legacyPayload },
    ]);
    harness.embedder.documentCalls = 0;

    const second = await runIndex(harness.options());

    expect(second.outcome, JSON.stringify(second.failure)).toBe("completed");
    expect(second.generationId).toBe(first.generationId);
    expect(harness.embedder.documentCalls).toBe(0);
    const after = await harness.vectorStore.scroll("code", { limit: 1000 });
    expect(after.points.map((point) => point.id)).toEqual(before.points.map((point) => point.id));
    expect(
      after.points.every((point) => point.payload["generation_id"] === first.generationId),
    ).toBe(true);
  });

  it("fails pruning before publishing completed metadata or terminal state", async () => {
    const originalDelete = harness.vectorStore.deleteByFilter.bind(harness.vectorStore);
    harness.vectorStore.deleteByFilter = async (collection, filter, options) => {
      if (filter.mustNot?.some((condition) => condition.field === "generation_id")) {
        throw new Error("obsolete-generation deletion failed");
      }
      return originalDelete(collection, filter, options);
    };
    const terminalStates: string[] = [];

    const report = await runIndex({
      ...harness.options(),
      onGenerationFinished: async (_generationId, outcome) => {
        terminalStates.push(outcome);
      },
    });

    expect(report.outcome).toBe("failed");
    expect(report.failure?.message).toContain("obsolete-generation deletion failed");
    expect(terminalStates).toEqual(["failed"]);
    expect((await harness.metadataStore.getRefRecord(REF_ID))?.indexStatus).not.toBe("completed");
    expect(await harness.metadataStore.getWorkspace(WORKSPACE_ID)).toBeNull();
  });

  it("cancels a pruning operation without publishing completed metadata or terminal state", async () => {
    const controller = new AbortController();
    const originalDelete = harness.vectorStore.deleteByFilter.bind(harness.vectorStore);
    harness.vectorStore.deleteByFilter = async (collection, filter, options) => {
      if (filter.mustNot?.some((condition) => condition.field === "generation_id")) {
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        controller.abort();
        return;
      }
      return originalDelete(collection, filter, options);
    };
    const terminalStates: string[] = [];

    const report = await runIndex({
      ...harness.options(),
      signal: controller.signal,
      onGenerationFinished: async (_generationId, outcome) => {
        terminalStates.push(outcome);
      },
    });

    expect(report.outcome).toBe("cancelled");
    expect(terminalStates).toEqual(["cancelled"]);
    expect((await harness.metadataStore.getRefRecord(REF_ID))?.indexStatus).not.toBe("completed");
    expect(await harness.metadataStore.getWorkspace(WORKSPACE_ID)).toBeNull();
  });

  it("computes nothing again on an unchanged second run", async () => {
    let firstCorpusRevision: string | undefined;
    const first = await runIndex({
      ...harness.options(),
      onGenerationFinished: async (_generationId, outcome, corpusRevisionFingerprint) => {
        if (outcome === "completed") firstCorpusRevision = corpusRevisionFingerprint;
      },
    });
    expect(first.outcome).toBe("completed");
    const callsAfterFirst = harness.embedder.documentCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    let secondCorpusRevision: string | undefined;
    const second = await runIndex({
      ...harness.options(),
      onGenerationFinished: async (_generationId, outcome, corpusRevisionFingerprint) => {
        if (outcome === "completed") secondCorpusRevision = corpusRevisionFingerprint;
      },
    });
    expect(second.outcome, JSON.stringify(second.failure)).toBe("completed");
    expect(second.counts.filesSeen).toBe(4);
    expect(second.counts.filesUnchanged).toBe(4);
    expect(second.counts.filesPlanned).toBe(0);
    expect(second.counts.filesAnalyzed).toBe(0);
    expect(second.counts.points).toBe(0);
    // Der Beweis: der Einbetter wurde beim zweiten Lauf KEIN einziges Mal
    // aufgerufen. Ohne diese Zusicherung waere "0 geplante Dateien" nur eine
    // Zahl im Bericht, kein gesparter Rechenaufwand.
    expect(harness.embedder.documentCalls).toBe(callsAfterFirst);

    // Der fortgesetzte inkrementelle Stand behaelt dieselbe Generation. So
    // bleiben unveraenderte Punkte und das bei jedem Lauf vollstaendig neu
    // publizierte Graphpaar generationsgleich, ohne Punkte bloss
    // umzuetikettieren.
    expect(second.generationId).toBe(first.generationId);
    expect(firstCorpusRevision).toMatch(/^[0-9a-f]{64}$/u);
    expect(secondCorpusRevision).toBe(firstCorpusRevision);
    const unchangedPoints = await harness.vectorStore.scroll("code", { limit: 1000 });
    expect(
      unchangedPoints.points.every(
        (point) => point.payload["generation_id"] === first.generationId,
      ),
    ).toBe(true);

    // Der Graph bleibt trotzdem VOLLSTAENDIG — die unveraenderten Dateien
    // werden fuer ihn nachgeparst, nicht weggelassen.
    expect(second.counts.fileGraphNodes).toBe(4);
  });

  it("re-indexes exactly the file whose content changed", async () => {
    let firstCorpusRevision: string | undefined;
    await runIndex({
      ...harness.options(),
      onGenerationFinished: async (_generationId, outcome, corpusRevisionFingerprint) => {
        if (outcome === "completed") firstCorpusRevision = corpusRevisionFingerprint;
      },
    });
    const callsAfterFirst = harness.embedder.documentCalls;

    harness.fs.seedFile(`${ROOT}/src/alpha.ts`, `${ALPHA}\nexport const zusatz = 42;\n`);

    let secondCorpusRevision: string | undefined;
    const second = await runIndex({
      ...harness.options(),
      onGenerationFinished: async (_generationId, outcome, corpusRevisionFingerprint) => {
        if (outcome === "completed") secondCorpusRevision = corpusRevisionFingerprint;
      },
    });
    expect(second.outcome, JSON.stringify(second.failure)).toBe("completed");
    expect(second.counts.filesPlanned).toBe(1);
    expect(second.counts.filesAnalyzed).toBe(1);
    expect(second.counts.filesUnchanged).toBe(3);
    expect(harness.embedder.documentCalls).toBeGreaterThan(callsAfterFirst);
    expect(firstCorpusRevision).toMatch(/^[0-9a-f]{64}$/u);
    expect(secondCorpusRevision).toMatch(/^[0-9a-f]{64}$/u);
    expect(secondCorpusRevision).not.toBe(firstCorpusRevision);
  });

  it("fails closed when source bytes change after their discovery hash was computed", async () => {
    const options = harness.options();
    const changedBytes = new TextEncoder().encode(`${ALPHA}\nexport const raced = true;\n`);
    // Discovery reads the source once for classification and once for its
    // authoritative hash. The third read is the analysis snapshot.
    const intercepted = interceptFileReads(options.ports.fs, `${ROOT}/src/alpha.ts`, (ordinal) =>
      ordinal === 3 ? changedBytes : undefined,
    );
    const terminal: Array<{
      outcome: "completed" | "cancelled" | "failed";
      corpusRevisionFingerprint: string | undefined;
    }> = [];

    const report = await runIndex({
      ...options,
      ports: { ...options.ports, fs: intercepted.fs },
      onGenerationFinished: async (_generationId, outcome, corpusRevisionFingerprint) => {
        terminal.push({ outcome, corpusRevisionFingerprint });
      },
    });

    expect(intercepted.readCount()).toBe(3);
    expect(report).toMatchObject({
      outcome: "failed",
      failure: { code: "ANALYSIS_INCOMPLETE", retryable: true },
    });
    expect(report.failure?.message).toMatch(/changed/u);
    expect(terminal).toEqual([{ outcome: "failed", corpusRevisionFingerprint: undefined }]);
    expect(await harness.metadataStore.listFileManifests(REF_ID)).toEqual([]);
    expect(await harness.metadataStore.getRefRecord(REF_ID)).toBeNull();
    const stored = await harness.vectorStore.scroll("code", { limit: 1000 });
    expect(stored.points.some((point) => point.payload["file_path"] === "src/alpha.ts")).toBe(
      false,
    );
  });

  it("fails closed when a planned source can no longer be read", async () => {
    const options = harness.options();
    const intercepted = interceptFileReads(options.ports.fs, `${ROOT}/src/alpha.ts`, (ordinal) =>
      ordinal === 3 ? new Error("injected analysis read failure") : undefined,
    );
    const terminal: Array<{
      outcome: "completed" | "cancelled" | "failed";
      corpusRevisionFingerprint: string | undefined;
    }> = [];

    const report = await runIndex({
      ...options,
      ports: { ...options.ports, fs: intercepted.fs },
      onGenerationFinished: async (_generationId, outcome, corpusRevisionFingerprint) => {
        terminal.push({ outcome, corpusRevisionFingerprint });
      },
    });

    expect(intercepted.readCount()).toBe(3);
    expect(report).toMatchObject({
      outcome: "failed",
      failure: { code: "ANALYSIS_INCOMPLETE", retryable: true },
    });
    expect(terminal).toEqual([{ outcome: "failed", corpusRevisionFingerprint: undefined }]);
    expect(
      report.skipped.some(
        (entry) =>
          entry.path === "src/alpha.ts" &&
          entry.stage === "parse" &&
          entry.reason === "provider_unavailable",
      ),
    ).toBe(true);
    expect(await harness.metadataStore.listFileManifests(REF_ID)).toEqual([]);
    expect(await harness.metadataStore.getRefRecord(REF_ID)).toBeNull();
    const stored = await harness.vectorStore.scroll("code", { limit: 1000 });
    expect(stored.points.some((point) => point.payload["file_path"] === "src/alpha.ts")).toBe(
      false,
    );
  });

  it("fails an incremental run when graph reparse bytes no longer match discovery", async () => {
    const first = await runIndex(harness.options());
    expect(first.outcome).toBe("completed");

    const options = harness.options();
    const changedBytes = new TextEncoder().encode(`${ALPHA}\nexport const graphRace = true;\n`);
    const intercepted = interceptFileReads(options.ports.fs, `${ROOT}/src/alpha.ts`, (ordinal) =>
      ordinal === 3 ? changedBytes : undefined,
    );
    const terminal: Array<{
      outcome: "completed" | "cancelled" | "failed";
      corpusRevisionFingerprint: string | undefined;
    }> = [];

    const second = await runIndex({
      ...options,
      ports: { ...options.ports, fs: intercepted.fs },
      onGenerationFinished: async (_generationId, outcome, corpusRevisionFingerprint) => {
        terminal.push({ outcome, corpusRevisionFingerprint });
      },
    });

    expect(intercepted.readCount()).toBe(3);
    expect(second.counts.filesPlanned).toBe(0);
    expect(second.counts.filesAnalyzed).toBe(0);
    expect(second).toMatchObject({
      outcome: "failed",
      failure: { code: "ANALYSIS_INCOMPLETE", retryable: true },
    });
    expect(second.failure?.message).toMatch(/changed/u);
    expect(terminal).toEqual([{ outcome: "failed", corpusRevisionFingerprint: undefined }]);
    const visibleRef = await harness.metadataStore.getRefRecord(REF_ID);
    expect(visibleRef?.generationId).toBe(first.generationId);
    expect(visibleRef?.indexStatus).toBe("completed");
  });

  it("removes retired chunks when an existing file is incrementally replaced", async () => {
    const first = await runIndex(harness.options());
    expect(first.outcome, JSON.stringify(first.failure)).toBe("completed");

    const alphaFileId = buildFileId({
      workspaceId: WORKSPACE_ID,
      repoId: REPO_ID,
      refId: REF_ID,
      relativePath: "src/alpha.ts",
    });
    const before = await harness.vectorStore.scroll("code", {
      filter: { must: [{ field: "file_id", match: { eq: alphaFileId } }] },
      limit: 100,
    });
    const beforeIds = before.points.map((point) => point.id);
    expect(beforeIds.length).toBeGreaterThan(0);

    harness.fs.seedFile(
      `${ROOT}/src/alpha.ts`,
      `export function replacement(): string {\n  return "current";\n}\n`,
    );

    const second = await runIndex(harness.options());
    expect(second.outcome, JSON.stringify(second.failure)).toBe("completed");
    expect(second.generationId).toBe(first.generationId);

    const manifest = (await harness.metadataStore.listFileManifests(REF_ID)).find(
      (candidate) => candidate.fileId === alphaFileId,
    );
    expect(manifest).toBeDefined();

    const after = await harness.vectorStore.scroll("code", {
      filter: { must: [{ field: "file_id", match: { eq: alphaFileId } }] },
      limit: 100,
    });
    const afterIds = after.points.map((point) => point.id).sort();
    expect(afterIds).toEqual([...(manifest?.chunkIds ?? [])].sort());

    const retiredIds = beforeIds.filter((pointId) => !afterIds.includes(pointId));
    expect(retiredIds.length).toBeGreaterThan(0);
    expect(await harness.vectorStore.retrieve("code", retiredIds)).toEqual([]);
    expect(
      after.points.every((point) => !String(point.payload["content"]).includes("value * 2")),
    ).toBe(true);
  });

  it.each([
    { scenario: "resume is disabled", removeCheckpoint: false },
    { scenario: "the previous checkpoint is missing", removeCheckpoint: true },
  ])(
    "rewrites unchanged payloads when a changed second run starts fresh because $scenario",
    async ({ removeCheckpoint }) => {
      const first = await runIndex({ ...harness.options(), generationId: "generation-one" });
      expect(first.outcome).toBe("completed");

      harness.fs.seedFile(`${ROOT}/src/alpha.ts`, `${ALPHA}\nexport const zusatz = 42;\n`);
      if (removeCheckpoint) {
        await harness.checkpointStore.delete(first.jobId);
      }

      const second = await runIndex({
        ...harness.options(),
        generationId: "generation-two",
        ...(removeCheckpoint ? {} : { resume: false }),
      });

      expect(second.outcome, JSON.stringify(second.failure)).toBe("completed");
      expect(second.generationId).toBe("generation-two");
      // Obwohl sich nur alpha geaendert hat, muss eine frische Generation
      // alle Dateien analysieren und ihre Payloads neu bestaetigen.
      expect(second.counts.filesSeen).toBe(4);
      expect(second.counts.filesPlanned).toBe(4);
      expect(second.counts.filesUnchanged).toBe(0);
      expect(second.counts.filesAnalyzed).toBe(4);

      const points = await harness.vectorStore.scroll("code", { limit: 1000 });
      const unchangedPaths = new Set(["README.md", "daten.xyz", "src/beta.ts"]);
      const unchangedPoints = points.points.filter((point) =>
        unchangedPaths.has(String(point.payload["file_path"])),
      );
      expect(unchangedPoints.length).toBeGreaterThan(0);
      expect(
        unchangedPoints.every((point) => point.payload["generation_id"] === second.generationId),
      ).toBe(true);
    },
  );

  it("removes the points and the manifest of a deleted file", async () => {
    const first = await runIndex(harness.options());
    const before = await harness.vectorStore.countByFilter("code", {
      must: [{ field: "file_path", match: { eq: "src/beta.ts" } }],
    });
    expect(before).toBeGreaterThan(0);
    expect(first.counts.filesRemoved).toBe(0);

    await harness.fs.remove(`${ROOT}/src/beta.ts`);

    const second = await runIndex({
      ...harness.options(),
      generationId: "generation-two",
      resume: false,
    });
    expect(second.outcome, JSON.stringify(second.failure)).toBe("completed");
    expect(second.counts.filesRemoved).toBe(1);
    const after = await harness.vectorStore.countByFilter("code", {
      must: [{ field: "file_path", match: { eq: "src/beta.ts" } }],
    });
    expect(after).toBe(0);
    const manifests = await harness.metadataStore.listFileManifests(REF_ID);
    expect(manifests.map((m) => m.relativePath)).not.toContain("src/beta.ts");
    // Der Grund steht im Ledger, nicht nur in der Zahl.
    expect(
      second.skipped.some(
        (entry) => entry.reason === "missing_index_entry" && entry.path === "src/beta.ts",
      ),
    ).toBe(true);
  });

  it("fails with EMBEDDING_UNAVAILABLE instead of reporting a finished empty index", async () => {
    harness.embedder.failOnDocuments = true;

    const report = await runIndex(harness.options());

    expect(report.outcome).toBe("failed");
    expect(report.failure?.code).toBe("EMBEDDING_UNAVAILABLE");
    expect(report.counts.points).toBe(0);
    const ref = await harness.metadataStore.getRefRecord(REF_ID);
    expect(ref?.indexStatus).not.toBe("completed");
  });

  it("keeps a file without a language adapter searchable and says what it lost", async () => {
    const report = await runIndex(harness.options());

    const entries = report.skipped.filter((entry) => entry.path === "daten.xyz");
    expect(entries.some((entry) => entry.reason === "unsupported_language")).toBe(true);
    expect(entries.every((entry) => entry.detail.length > 0)).toBe(true);
    // Der Grund benennt, WAS verloren geht — nicht nur, DASS etwas fehlt.
    expect(entries.find((entry) => entry.reason === "unsupported_language")?.detail).toMatch(
      /symbols/u,
    );

    const page = await harness.vectorStore.scroll("code", { limit: 1000 });
    const paths = page.points.map((point) => point.payload["file_path"]);
    // Trotzdem indiziert: als Zeilenfenster, also per Text auffindbar.
    expect(paths).toContain("daten.xyz");
    expect(paths).toContain("README.md");
  });

  it("stops on an abort signal without claiming completion", async () => {
    const controller = new AbortController();
    controller.abort();
    const report = await runIndex({ ...harness.options(), signal: controller.signal });
    expect(report.outcome).toBe("cancelled");
  });

  it("reports a mid-run abort as cancelled, not as a defect", async () => {
    // Ein Adapter, der beim Abbruch das wirft, was seine Laufzeit wirft — eine
    // `AbortError`-DOMException, KEIN `UntangleError`. Genau daran hat ein
    // STRG-C mitten im Lauf zuvor `INDEX_INCOMPLETE` und Exit-Code 1 gemeldet,
    // also einen Defekt statt eines Nutzerabbruchs.
    const controller = new AbortController();
    const options = harness.options();
    const inner = options.ports.vectorStore;
    const abortingStore = {
      ...inner,
      collectionExists: inner.collectionExists.bind(inner),
      ensureCollection: inner.ensureCollection.bind(inner),
      ensurePayloadIndexes: inner.ensurePayloadIndexes.bind(inner),
      deleteByFilter: inner.deleteByFilter.bind(inner),
      hybridQuery: inner.hybridQuery.bind(inner),
      retrieve: inner.retrieve.bind(inner),
      scroll: inner.scroll.bind(inner),
      countByFilter: inner.countByFilter.bind(inner),
      upsert: async (): Promise<{ upsertedCount: number }> => {
        controller.abort();
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      },
    };

    const report = await runIndex({
      ...options,
      ports: { ...options.ports, vectorStore: abortingStore },
      signal: controller.signal,
    });

    expect(report.outcome).toBe("cancelled");
    expect(report.failure).toBeUndefined();
  });

  it("reports a dimension mismatch instead of storing an unusable vector", async () => {
    const options = harness.options();
    const report = await runIndex({
      ...options,
      profile: { ...options.profile, dimensions: options.profile.dimensions + 1 },
    });
    expect(report.outcome).toBe("failed");
    expect(report.failure?.code).toBe("EMBEDDING_DIMENSION_MISMATCH");
  });

  it("never lets an UntangleError escape as an exception", async () => {
    harness.embedder.failOnDocuments = true;
    let thrown: unknown = null;
    try {
      await runIndex(harness.options());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeNull();
    expect(UntangleError).toBeDefined();
    expect(
      buildFileId({
        workspaceId: WORKSPACE_ID,
        repoId: REPO_ID,
        refId: REF_ID,
        relativePath: "src/alpha.ts",
      }),
    ).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
