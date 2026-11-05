/**
 * Signalerhebung fuer WP-231: welche messbare Groesse trennt „es gibt eine
 * Antwort" von „es gibt keine"?
 *
 * Sie erhebt fuer jede Frage des Katalogs die ROHEN Groessen, aus denen eine
 * Schwelle begruendet werden kann — die Kosinus-Aehnlichkeit der besten
 * dichten Treffer, ihren Abstand untereinander und die lexikalische Abdeckung
 * der Anfrage. Ohne diese Erhebung waere jede Schwelle eine erfundene Zahl.
 *
 * Aufruf: node packages/search/benchmark/signals.mjs [--out datei.json]
 */
import { writeFileSync } from "node:fs";

import { OllamaEmbeddingProvider } from "../../embeddings-ollama/dist/index.js";
import {
  FetchQdrantTransport,
  createQdrantStorage,
  resolveQdrantStorageConfig,
  textToBm25SparseVector,
} from "../../storage-qdrant/dist/index.js";
import {
  Bm25Ranker,
  QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
  decideResultRelevance,
  lexicalDocumentText,
  matchSymbolName,
} from "../dist/index.js";
import { termFrequencies, tokenizeIdentifiers } from "../dist/tokenize.js";

import { QUESTIONS, groundTruthKindOf } from "./questions.mjs";

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

const rows = [];
for (const question of QUESTIONS) {
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
    [...pool.entries()].map(([id, payload]) => ({ id, text: lexicalDocumentText(payload) })),
  );
  const lexical = ranker.rank(question.text);
  const denseScoreById = new Map(
    densePoints.map((point) => [point.id, point.denseScore ?? point.score]),
  );
  const relevance = decideResultRelevance(
    question.text,
    [...pool.entries()].map(([id, payload]) => ({
      denseScore: denseScoreById.get(id),
      lexicalText: lexicalDocumentText(payload),
      exactSymbolMatch: matchSymbolName(payload, question.text)?.strength === 1,
    })),
    QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
  );
  // Abdeckung der Anfrage durch ein Dokument, gewichtet mit der Pool-IDF.
  const docTokens = [...pool.entries()].map(([id, payload]) => ({
    id,
    frequencies: termFrequencies(tokenizeIdentifiers(lexicalDocumentText(payload))),
  }));
  const queryTerms = [...termFrequencies(tokenizeIdentifiers(question.text)).keys()];
  const poolSize = docTokens.length;
  const dfOf = (term) => docTokens.filter((doc) => doc.frequencies.has(term)).length;
  const idfOf = (df) => Math.log(1 + (poolSize - df + 0.5) / (df + 0.5));
  const termInfo = queryTerms.map((term) => {
    const df = dfOf(term);
    return { term, df, idf: idfOf(df), discriminative: df > 0 && df <= poolSize / 2 };
  });
  const totalIdf = termInfo.reduce((sum, entry) => sum + entry.idf, 0);
  let maxCoverage = 0;
  for (const doc of docTokens) {
    const matched = termInfo
      .filter((entry) => doc.frequencies.has(entry.term))
      .reduce((sum, entry) => sum + entry.idf, 0);
    maxCoverage = Math.max(maxCoverage, totalIdf === 0 ? 0 : matched / totalIdf);
  }
  const rareUnmatched = termInfo.filter((entry) => entry.df === 0).map((entry) => entry.term);
  const discriminativeTerms = termInfo
    .filter((entry) => entry.discriminative)
    .map((entry) => entry.term);
  const scores = densePoints.map((point) => point.denseScore ?? point.score);
  const goldDenseScore = (() => {
    const found = densePoints.find((point) => question.expect.includes(point.payload.file_path));
    return found === undefined ? null : (found.denseScore ?? found.score);
  })();
  rows.push({
    id: question.id,
    category: question.category,
    text: question.text,
    expectedPaths: question.expect,
    evaluationSet: question.evaluationSet ?? "main",
    groundTruthKind: groundTruthKindOf(question),
    answerable: groundTruthKindOf(question) === "answerable",
    dense1: scores[0] ?? 0,
    dense2: scores[1] ?? 0,
    dense5: scores[4] ?? 0,
    dense10: scores[9] ?? 0,
    dense50: scores.at(-1) ?? 0,
    goldDenseScore,
    poolSize: pool.size,
    lexicalRanked: lexical.length,
    lexicalRankedShare: pool.size === 0 ? 0 : lexical.length / pool.size,
    lexicalTop: lexical[0]?.score ?? 0,
    maxCoverage,
    policyDenseSpread: relevance.denseSpread ?? null,
    policyCoverage: relevance.candidateIdfCoverage,
    relevanceStatus: relevance.status,
    relevanceSufficient: relevance.status === "accepted",
    relevanceBasis: relevance.basis,
    rareUnmatched,
    discriminativeTerms,
  });
}

const header = [
  "id",
  "kat",
  "antw",
  "dense1",
  "dense2",
  "dense5",
  "dense10",
  "dense50",
  "d1-d10",
  "pool",
  "lexRanked",
  "lexAnteil",
  "maxCov",
  "polSpread",
  "polCov",
  "relevant",
  "unbelegt",
].join("\t");
console.log(header);
for (const row of rows) {
  console.log(
    [
      row.id,
      row.category.slice(0, 8),
      row.answerable ? "ja" : "NEIN",
      row.dense1.toFixed(4),
      row.dense2.toFixed(4),
      row.dense5.toFixed(4),
      row.dense10.toFixed(4),
      row.dense50.toFixed(4),
      (row.dense1 - row.dense10).toFixed(4),
      row.poolSize,
      row.lexicalRanked,
      row.lexicalRankedShare.toFixed(2),
      row.maxCoverage.toFixed(3),
      row.policyDenseSpread === null ? "-" : row.policyDenseSpread.toFixed(4),
      row.policyCoverage.toFixed(3),
      row.relevanceStatus === "accepted"
        ? row.relevanceBasis
        : row.relevanceStatus === "rejected"
          ? "NEIN"
          : "NICHT_BEWERTET",
      row.rareUnmatched.join(","),
    ].join("\t"),
  );
}

const outIndex = process.argv.indexOf("--out");
if (outIndex >= 0) {
  writeFileSync(process.argv[outIndex + 1], `${JSON.stringify(rows, null, 2)}\n`);
}
