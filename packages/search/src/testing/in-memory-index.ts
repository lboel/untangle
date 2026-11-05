/**
 * In-Memory-Referenz des Abrufkerns — Suche OHNE laufendes Qdrant.
 *
 * spec.md §3.2 verbietet ausdruecklich, fremde Prozesse anzufassen; auf
 * 127.0.0.1:6333 laeuft in dieser Umgebung eine FREMDE Qdrant-Instanz. Kein
 * Test dieses Pakets darf sie beruehren. Diese Datei ist die Antwort darauf:
 * sie baut aus einfachen Fixture-Chunks einen vollstaendigen, echten
 * `VectorStore` (den `InMemoryVectorStore` des testkits), embedded sie mit dem
 * deterministischen Embedder und liefert eine fertig verdrahtete
 * {@link HybridSearchEngine}.
 *
 * Damit laeuft dieselbe Engine, die spaeter gegen Qdrant laeuft — nur der
 * Speicher dahinter ist ausgetauscht. Genau das ist der Sinn eines Ports.
 *
 * Diese Datei ist Test-Infrastruktur: sie wird NICHT gebaut und NICHT
 * ausgeliefert (siehe `tsconfig.json`, `exclude`).
 */
import type { CodeChunkPayloadV1, EmbeddingProfile, VectorPointV1 } from "@untangle-code/domain";
import { buildEmbeddingProfileId } from "@untangle-code/domain";
import {
  DeterministicEmbedder,
  FakeClock,
  InMemoryVectorStore,
  textToSparseVector,
} from "@untangle-code/testkit";

import type { HybridSearchEngineDeps } from "../engine.js";
import { HybridSearchEngine } from "../engine.js";

/** Eine Fixture-Zeile: das Minimum, um einen indizierten Chunk zu beschreiben. */
export interface ChunkFixture {
  chunkId: string;
  /** Workspace des Chunks; Default {@link TEST_WORKSPACE_ID}. */
  workspaceId?: string;
  repoId?: string;
  repoLabel?: string;
  refId?: string;
  refName?: string;
  commitSha?: string;
  fileId?: string;
  filePath: string;
  language?: string;
  symbolId?: string;
  symbolName?: string;
  symbolFqn?: string;
  symbolKind?: string;
  signature?: string;
  chunkKind?: string;
  fragmentIndex?: number;
  fragmentCount?: number;
  startLine?: number;
  endLine?: number;
  content: string;
  /** Ueberschreibt den Dedupe-Scope; Default ist `symbolId ?? chunkId`. */
  metricsScopeId?: string;
  cognitive?: number;
  cyclomaticExtended?: number;
  riskScore?: number;
  changedAtEpochMs?: number;
  generationId?: string;
}

export const TEST_WORKSPACE_ID = "ws-test";
export const TEST_COLLECTION = "untangle_code_test_v1";

/** Profil des deterministischen Embedders; klein, damit Tests schnell bleiben. */
export const TEST_EMBEDDING_PROFILE: EmbeddingProfile = {
  provider: "testkit-deterministic",
  model: "hashed-token-bag-v1",
  dimensions: 64,
  queryPrefix: "search_query: ",
  documentPrefix: "search_document: ",
  includePath: true,
  normalization: "l2",
  preparedTextVersion: "v1",
};

export const TEST_EMBEDDING_PROFILE_ID = buildEmbeddingProfileId(TEST_EMBEDDING_PROFILE);

/** Baut den gespeicherten Payload einer Fixture (spec.md §10.3). */
export function fixtureToPayload(fixture: ChunkFixture): Record<string, unknown> {
  const repoId = fixture.repoId ?? "repo-a";
  const refId = fixture.refId ?? "ref-main";
  const startLine = fixture.startLine ?? 1;
  const payload: CodeChunkPayloadV1 & Record<string, unknown> = {
    schema_version: 1,
    point_type: "code_chunk",
    workspace_id: fixture.workspaceId ?? TEST_WORKSPACE_ID,
    repo_id: repoId,
    repo_label: fixture.repoLabel ?? repoId,
    ref_id: refId,
    ref_name: fixture.refName ?? refId,
    ...(fixture.commitSha === undefined ? {} : { commit_sha: fixture.commitSha }),
    file_id: fixture.fileId ?? `${repoId}:${fixture.filePath}`,
    file_path: fixture.filePath,
    file_hash: "hash",
    language: fixture.language ?? "typescript",
    parse_quality: "complete",
    ...(fixture.symbolId === undefined ? {} : { symbol_id: fixture.symbolId }),
    ...(fixture.symbolName === undefined ? {} : { symbol_name: fixture.symbolName }),
    ...(fixture.symbolFqn === undefined ? {} : { symbol_fqn: fixture.symbolFqn }),
    ...(fixture.symbolKind === undefined ? {} : { symbol_kind: fixture.symbolKind }),
    ...(fixture.signature === undefined ? {} : { signature: fixture.signature }),
    chunk_id: fixture.chunkId,
    chunk_kind: fixture.chunkKind ?? "function",
    chunk_ordinal: 0,
    ...(fixture.fragmentIndex === undefined ? {} : { fragment_index: fixture.fragmentIndex }),
    ...(fixture.fragmentCount === undefined ? {} : { fragment_count: fixture.fragmentCount }),
    start_line: startLine,
    end_line: fixture.endLine ?? startLine + fixture.content.split("\n").length - 1,
    start_byte: 0,
    end_byte: Buffer.byteLength(fixture.content, "utf8"),
    content: fixture.content,
    content_hash: "content-hash",
    parser_version: "untangle-parser-v1",
    chunker_version: "untangle-chunker-v1",
    metrics_version: "untangle-metrics-v1",
    embedding_profile_id: "test-profile",
    generation_id: fixture.generationId ?? "gen-1",
    embedding_truncated: false,
    metrics_scope: fixture.symbolId === undefined ? "chunk" : "symbol",
    metrics_scope_id: fixture.metricsScopeId ?? fixture.symbolId ?? fixture.chunkId,
    ...(fixture.cognitive === undefined ? {} : { cognitive: fixture.cognitive }),
    ...(fixture.cyclomaticExtended === undefined
      ? {}
      : { cyclomatic_extended: fixture.cyclomaticExtended }),
    ...(fixture.riskScore === undefined ? {} : { risk_score: fixture.riskScore }),
  };
  if (fixture.changedAtEpochMs !== undefined) {
    payload["changed_at_epoch_ms"] = fixture.changedAtEpochMs;
  }
  return payload;
}

/** Der Dokumenttext, den der Indexlauf embedden wuerde (spec.md §8.6). */
export function preparedDocumentText(fixture: ChunkFixture): string {
  const header = [
    TEST_EMBEDDING_PROFILE.documentPrefix,
    TEST_EMBEDDING_PROFILE.includePath ? `${fixture.filePath}\n` : "",
    fixture.symbolName === undefined ? "" : `${fixture.symbolName}\n`,
    fixture.signature === undefined ? "" : `${fixture.signature}\n`,
  ].join("");
  return `${header}${fixture.content}`;
}

/** Ergebnis von {@link buildInMemorySearchEngine}. */
export interface InMemorySearchHarness {
  engine: HybridSearchEngine;
  store: InMemoryVectorStore;
  clock: FakeClock;
  embedder: DeterministicEmbedder;
  collection: string;
}

/**
 * Baut Speicher, Embedder und Engine und indiziert die Fixtures.
 *
 * `overrides` erlaubt es, einzelne Abhaengigkeiten zu ersetzen (etwa
 * `findability` oder `repoPriorities`), ohne die Verdrahtung zu wiederholen.
 */
export async function buildInMemorySearchEngine(
  fixtures: readonly ChunkFixture[],
  overrides: Partial<HybridSearchEngineDeps> = {},
): Promise<InMemorySearchHarness> {
  const clock = new FakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
  const embedder = new DeterministicEmbedder(clock, TEST_EMBEDDING_PROFILE);
  const store = new InMemoryVectorStore();
  await store.ensureCollection({
    name: TEST_COLLECTION,
    denseDimensions: TEST_EMBEDDING_PROFILE.dimensions,
    denseDistance: "Cosine",
    sparseBm25: true,
    onDiskPayload: false,
  });

  const preparedTexts = fixtures.map((fixture) => preparedDocumentText(fixture));
  const embedded = await embedder.embedDocuments(preparedTexts);
  const points: VectorPointV1[] = fixtures.map((fixture, index) => ({
    id: fixture.chunkId,
    dense: embedded.vectors[index] as number[],
    sparse: textToSparseVector(preparedTexts[index] as string),
    payload: fixtureToPayload(fixture),
  }));
  if (points.length > 0) {
    await store.upsert(TEST_COLLECTION, points);
  }

  const engine = new HybridSearchEngine({
    vectorStore: store,
    targets: [
      {
        embeddingProfileId: embedder.profileId,
        collection: TEST_COLLECTION,
        repoIds: [...new Set(fixtures.map((fixture) => fixture.repoId ?? "repo-a"))].sort(),
        embedder,
      },
    ],
    defaults: { workspaceId: TEST_WORKSPACE_ID, limit: 10, candidateLimit: 50 },
    clock,
    sparseVectorizer: textToSparseVector,
    ...overrides,
  });

  return { engine, store, clock, embedder, collection: TEST_COLLECTION };
}
