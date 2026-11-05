/**
 * Diagnose einer einzelnen Frage: WO verliert der erwartete Treffer?
 *
 * Sie fragt dieselben drei Zweige wie der Abrufkern einzeln ab und zeigt fuer
 * jeden Zweig, auf welchem Rang der erwartete Pfad steht (oder dass er gar
 * nicht im Kandidatenpool liegt). Damit laesst sich „schlechter Abruf" von
 * „schlechter Rangfolge" unterscheiden — genau die Trennung, ohne die WP-232
 * nur geraten waere.
 *
 * Aufruf: node packages/search/benchmark/diagnose.mjs <frage-id> [...]
 */
import { OllamaEmbeddingProvider } from "../../embeddings-ollama/dist/index.js";
import {
  FetchQdrantTransport,
  createQdrantStorage,
  resolveQdrantStorageConfig,
  textToBm25SparseVector,
} from "../../storage-qdrant/dist/index.js";
import { Bm25Ranker } from "../dist/bm25.js";
import { lexicalDocumentText } from "../dist/payload.js";

import { QUESTIONS } from "./questions.mjs";

const COLLECTION = "untangle_untangle_code_0dc5c26f_v1";
const WORKSPACE_ID = "85706254-8995-585b-bcb0-50fba3624f17";
const CANDIDATE_LIMIT = 50;

const clock = { nowIso: () => "1970-01-01T00:00:00.000Z", nowEpochMs: () => 0 };
const random = { nextFloat: () => 0.5, uuidV4: () => "00000000-0000-4000-8000-000000000000" };

const qdrantConfig = resolveQdrantStorageConfig(
  { mode: "external", url: "http://127.0.0.1:16333", collectionPrefix: "untangle_" },
  process.env,
);
const storage = createQdrantStorage({
  config: qdrantConfig,
  clock,
  transport: new FetchQdrantTransport({ url: qdrantConfig.url, requestTimeoutMs: 30000 }),
});
const embedder = new OllamaEmbeddingProvider(
  {
    profile: {
      provider: "ollama",
      model: "qwen3-embedding:0.6b",
      dimensions: 1024,
      queryPrefix: "search_query: ",
      documentPrefix: "search_document: ",
      includePath: true,
      normalization: "none",
      preparedTextVersion: "untangle-prepared-text-v1",
    },
    mode: "external",
    url: "http://127.0.0.1:11434",
    contextLength: 32768,
    batchSize: 32,
    maxConnections: 4,
    requestTimeoutMs: 120000,
  },
  { clock, random },
);

const filter = {
  must: [
    { field: "workspace_id", match: { eq: WORKSPACE_ID } },
    { field: "point_type", match: { eq: "code_chunk" } },
  ],
};

for (const id of process.argv.slice(2)) {
  const question = QUESTIONS.find((entry) => entry.id === id);
  if (question === undefined) {
    console.log(`unbekannte Frage-ID "${id}"`);
    continue;
  }
  const dense = await embedder.embedQuery(`search_query: ${question.text}`);
  const densePoints = await storage.vectorStore.hybridQuery(COLLECTION, {
    dense,
    filter,
    limit: CANDIDATE_LIMIT,
    candidateLimit: CANDIDATE_LIMIT,
    withPayload: true,
  });
  const sparsePoints = await storage.vectorStore.hybridQuery(COLLECTION, {
    sparse: textToBm25SparseVector(question.text),
    filter,
    limit: CANDIDATE_LIMIT,
    candidateLimit: CANDIDATE_LIMIT,
    withPayload: true,
  });

  const pool = new Map();
  for (const point of [...densePoints, ...sparsePoints]) {
    if (!pool.has(point.id)) pool.set(point.id, point.payload);
  }
  const ranker = new Bm25Ranker(
    [...pool.entries()].map(([pointId, payload]) => ({
      id: pointId,
      text: lexicalDocumentText(payload),
    })),
  );
  const lexical = ranker.rank(question.text);
  const lexicalRankById = new Map(lexical.map((entry) => [entry.id, entry.rank]));

  const denseRankOfGold = densePoints.findIndex((point) =>
    question.expect.includes(point.payload.file_path),
  );
  const sparseRankOfGold = sparsePoints.findIndex((point) =>
    question.expect.includes(point.payload.file_path),
  );
  const goldInPool = [...pool.entries()].filter(([, payload]) =>
    question.expect.includes(payload.file_path),
  );

  console.log(`\n### ${question.id} — "${question.text}"`);
  console.log(`erwartet: ${question.expect.join(", ") || "(nichts)"}`);
  console.log(
    `dichter Abruf:      ${denseRankOfGold < 0 ? "NICHT im Pool" : `Rang ${denseRankOfGold + 1}`} (von ${densePoints.length})`,
  );
  console.log(
    `spaerlicher Abruf:  ${sparseRankOfGold < 0 ? "NICHT im Pool" : `Rang ${sparseRankOfGold + 1}`} (von ${sparsePoints.length})`,
  );
  console.log(`Pool insgesamt: ${pool.size} Kandidaten`);
  for (const [pointId, payload] of goldInPool) {
    console.log(
      `  Gold im Pool: ${payload.file_path} :: ${payload.symbol_name ?? "-"} — BM25-Rang ${lexicalRankById.get(pointId) ?? "kein Term getroffen"}`,
    );
  }
  console.log(`BM25 Top 5:`);
  for (const entry of lexical.slice(0, 5)) {
    const payload = pool.get(entry.id);
    console.log(`  #${entry.rank} ${entry.score.toFixed(3)} ${payload.file_path}`);
  }
  console.log(`dicht Top 5:`);
  for (const [index, point] of densePoints.slice(0, 5).entries()) {
    console.log(
      `  #${index + 1} ${(point.denseScore ?? point.score).toFixed(4)} ${point.payload.file_path}`,
    );
  }
}
