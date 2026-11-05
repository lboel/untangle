/**
 * Kleine Abrufmessung gegen den STEHENDEN Index (docs/BENCHMARK.md, WP-231..233).
 *
 * Sie verdrahtet genau das, was `untangle query` verdrahtet — Qdrant-Adapter,
 * Ollama-Einbetter, `HybridSearchEngine` — und laeuft den Fragenkatalog aus
 * `questions.mjs` durch. Ausgegeben werden MRR, Platz 1 und Recall@5, je Kategorie
 * und insgesamt, klare Abwesenheitsproben, getrennte kompositionelle
 * Diagnosen sowie die deutsche Korroborationsprobe.
 *
 * Aufruf:
 *   node packages/search/benchmark/run.mjs [--out datei.json] [--label name]
 *
 * Voraussetzung: Qdrant auf 127.0.0.1:16333 mit der Sammlung
 * `untangle_untangle_code_0dc5c26f_v1`, Ollama auf 127.0.0.1:11434 mit
 * `qwen3-embedding:0.6b`. Fehlt eines von beidem, bricht der Lauf mit einer
 * Meldung ab — er meldet NIE ein Ergebnis, das er nicht gemessen hat (E4).
 */
import { writeFileSync } from "node:fs";

// Relative dist-Pfade statt Paketnamen: dieses Skript liegt in
// `packages/search`, dessen `node_modules` die Nachbarpakete
// `embeddings-ollama` und `storage-qdrant` nicht kennt (sie sind keine
// Abhaengigkeit des Abrufkerns und duerfen es auch nicht werden).
import { DEFAULT_SEARCH_CONFIG } from "../../config/dist/index.js";
import { OllamaEmbeddingProvider } from "../../embeddings-ollama/dist/index.js";
import {
  FetchQdrantTransport,
  createQdrantStorage,
  resolveQdrantStorageConfig,
  textToBm25SparseVector,
} from "../../storage-qdrant/dist/index.js";
import {
  QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
  assertBenchmarkRetrievalCompleted,
  createHybridSearchEngine,
} from "../dist/index.js";

import { QUESTIONS, groundTruthKindOf } from "./questions.mjs";

const COLLECTION = "untangle_untangle_code_0dc5c26f_v1";
const WORKSPACE_ID = "85706254-8995-585b-bcb0-50fba3624f17";
const REPO_ID = "untangle";
const PROFILE_ID = "0dc5c26f80e48129a4a4dc29cf946f280dbff05273afcefad2e9c840ed0e163e";
const TOP_K = 10;

const PROFILE = {
  provider: "ollama",
  model: "qwen3-embedding:0.6b",
  dimensions: 1024,
  queryPrefix: "search_query: ",
  documentPrefix: "search_document: ",
  includePath: true,
  normalization: "none",
  preparedTextVersion: "untangle-prepared-text-v1",
};

const clock = {
  nowIso: () => "1970-01-01T00:00:00.000Z",
  nowEpochMs: () => 0,
};
const random = { nextFloat: () => 0.5, uuidV4: () => "00000000-0000-4000-8000-000000000000" };

function parseArgs(argv) {
  const args = {
    out: undefined,
    label: "lauf",
    candidateLimit: DEFAULT_SEARCH_CONFIG.defaultCandidateLimit,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") args.out = argv[(i += 1)];
    else if (argv[i] === "--label") args.label = argv[(i += 1)];
    else if (argv[i] === "--candidate-limit") {
      args.candidateLimit = Number(argv[(i += 1)]);
    }
  }
  if (
    !Number.isInteger(args.candidateLimit) ||
    args.candidateLimit < 1 ||
    args.candidateLimit > DEFAULT_SEARCH_CONFIG.maxCandidateLimit
  ) {
    throw new Error(
      `--candidate-limit must be an integer in [1, ${DEFAULT_SEARCH_CONFIG.maxCandidateLimit}]`,
    );
  }
  return args;
}

function buildEngine() {
  const qdrantConfig = resolveQdrantStorageConfig(
    { mode: "external", url: "http://127.0.0.1:16333", collectionPrefix: "untangle_" },
    process.env,
  );
  const transport = new FetchQdrantTransport({
    url: qdrantConfig.url,
    requestTimeoutMs: qdrantConfig.requestTimeoutMs,
  });
  const storage = createQdrantStorage({ config: qdrantConfig, clock, transport });
  const embedder = new OllamaEmbeddingProvider(
    {
      profile: PROFILE,
      mode: "external",
      url: "http://127.0.0.1:11434",
      contextLength: 32768,
      batchSize: 32,
      maxConnections: 4,
      requestTimeoutMs: 120000,
    },
    { clock, random },
  );
  return createHybridSearchEngine({
    vectorStore: storage.vectorStore,
    targets: [
      {
        embeddingProfileId: PROFILE_ID,
        collection: COLLECTION,
        repoIds: [REPO_ID],
        embedder,
      },
    ],
    defaults: {
      workspaceId: WORKSPACE_ID,
      limit: DEFAULT_SEARCH_CONFIG.defaultLimit,
      candidateLimit: DEFAULT_SEARCH_CONFIG.defaultCandidateLimit,
    },
    searchConfig: DEFAULT_SEARCH_CONFIG,
    clock,
    sparseVectorizer: textToBm25SparseVector,
    relevancePolicies: {
      [PROFILE_ID]: {
        workspaceId: WORKSPACE_ID,
        collection: COLLECTION,
        policy: QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
      },
    },
  });
}

/** Rang (1-basiert) des ersten Treffers auf einem erwarteten Pfad; 0 = keiner. */
function rankOfFirstExpected(hits, expect) {
  for (const [index, hit] of hits.entries()) {
    if (expect.includes(hit.filePath)) return index + 1;
  }
  return 0;
}

function aggregate(rows) {
  const answerable = rows.filter((row) => row.expect.length > 0);
  const mrr =
    answerable.length === 0
      ? 0
      : answerable.reduce((sum, row) => sum + (row.rank === 0 ? 0 : 1 / row.rank), 0) /
        answerable.length;
  return {
    questions: answerable.length,
    mrr,
    top1: answerable.filter((row) => row.rank === 1).length,
    recall5: answerable.filter((row) => row.rank > 0 && row.rank <= 5).length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const engine = buildEngine();
  const rows = [];
  for (const question of QUESTIONS) {
    const started = process.hrtime.bigint();
    const result = await engine.search({
      query: question.text,
      workspaceId: WORKSPACE_ID,
      limit: TOP_K,
      candidateLimit: args.candidateLimit,
      // Ausdruecklich gepinnt: eine veroeffentlichte Kennzahl darf nicht von
      // einer ungepinnten Vorgabe abhaengen.
      abstention: "strict",
    });
    // Der Search-Port degradiert Provider-/Retrieval-Ausfaelle sichtbar zu
    // Warnungen. Fuer einen Benchmark ist das kein Messwert: sofort hart
    // abbrechen, bevor daraus eine scheinbar akzeptierte/abstinierende Row
    // oder ein standingIndexMeasurement-Artefakt werden kann.
    assertBenchmarkRetrievalCompleted(question.id, result);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const hits = result.groups.flatMap((group) => group.hits);
    const abstained = result.warnings.some((warning) => warning.code === "NO_SUFFICIENT_MATCH");
    const notEvaluated = result.warnings.some(
      (warning) => warning.code === "RELEVANCE_POLICY_NOT_EVALUATED",
    );
    const relevanceWarning = result.warnings.find((warning) =>
      ["NO_SUFFICIENT_MATCH", "RELEVANCE_POLICY_NOT_EVALUATED"].includes(warning.code),
    );
    rows.push({
      id: question.id,
      category: question.category,
      text: question.text,
      expect: question.expect,
      groundTruthKind: groundTruthKindOf(question),
      evaluationSet: question.evaluationSet ?? "main",
      rationale: question.rationale ?? null,
      absentAnchors: question.absentAnchors ?? [],
      selfMentionPaths: question.selfMentionPaths ?? [],
      rank: rankOfFirstExpected(hits, question.expect),
      hitCount: hits.length,
      abstained,
      notEvaluated,
      policyApplied: true,
      relevanceStatus: relevanceWarning?.details?.status ?? "accepted",
      relevanceBasis: relevanceWarning?.details?.basis ?? null,
      lexicalBranchOmitted: result.groups.some((group) =>
        group.caveats.some((caveat) =>
          caveat.includes("lexical ranking branch did not participate"),
        ),
      ),
      lexicalBranchContributed: hits.some((hit) =>
        hit.score.components.some(
          (component) =>
            component.kind === "base_hybrid" && component.evidence.includes("lexical#"),
        ),
      ),
      topScore: hits[0]?.score.final ?? 0,
      secondScore: hits[1]?.score.final ?? 0,
      topPaths: hits.slice(0, 3).map((hit) => hit.filePath),
      indexGenerations: [...new Set(hits.map((hit) => hit.indexGeneration))].sort(),
      elapsedMs,
    });
  }

  const mainRows = rows.filter((row) => row.evaluationSet === "main");
  const byCategory = {};
  for (const row of mainRows) {
    (byCategory[row.category] ??= []).push(row);
  }
  const clearAbsence = mainRows
    .filter((row) => row.groundTruthKind === "clear_absent")
    .map((row) => ({
      id: row.id,
      hitCount: row.hitCount,
      abstained: row.abstained,
      notEvaluated: row.notEvaluated,
      relevanceBasis: row.relevanceBasis,
      topPaths: row.topPaths,
      selfMentionPaths: row.selfMentionPaths,
    }));
  const compositionalDiagnostics = mainRows
    .filter((row) => row.groundTruthKind === "compositional_diagnostic")
    .map((row) => ({
      id: row.id,
      hitCount: row.hitCount,
      abstained: row.abstained,
      notEvaluated: row.notEvaluated,
      relevanceBasis: row.relevanceBasis,
      topScore: row.topScore,
      topPaths: row.topPaths,
      rationale: row.rationale,
      selfMentionPaths: row.selfMentionPaths,
    }));
  const mainAnswerable = mainRows.filter((row) => row.groundTruthKind === "answerable");
  const corroboration = rows.filter((row) => row.evaluationSet === "german-corroboration");
  const germanPolicyHoldouts = rows.filter((row) => row.evaluationSet === "german-policy-holdout");
  const report = {
    label: args.label,
    collection: COLLECTION,
    standingIndexMeasurement: true,
    corpusRevisionsObserved: [...new Set(rows.flatMap((row) => row.indexGenerations))].sort(),
    selfContaminationCaveat:
      "the standing index may contain docs/BENCHMARK.md and an older packages/search/benchmark catalog; every known self-mention path is reported per negative row, and future dogfood indexes exclude those paths",
    relevancePolicy: QWEN3_EMBEDDING_06B_RELEVANCE_POLICY,
    topK: TOP_K,
    candidateLimit: args.candidateLimit,
    overall: aggregate(mainAnswerable),
    categories: Object.fromEntries(
      Object.entries(byCategory)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, list]) => [name, aggregate(list)]),
    ),
    truthRetention: {
      accepted: mainAnswerable.filter((row) => !row.abstained && !row.notEvaluated).length,
      total: mainAnswerable.length,
      abstainedIds: mainAnswerable.filter((row) => row.abstained).map((row) => row.id),
      notEvaluatedIds: mainAnswerable.filter((row) => row.notEvaluated).map((row) => row.id),
    },
    clearAbsence,
    compositionalDiagnostics,
    germanCorroboration: corroboration,
    germanPolicyHoldouts,
    rows,
  };

  const table = rows
    .map(
      (row) =>
        `${row.id.padEnd(3)} ${row.category.padEnd(12)} ${
          row.groundTruthKind !== "answerable"
            ? row.abstained
              ? "SCHWEIGT".padEnd(9)
              : `${row.hitCount} Treffer`.padEnd(9)
            : (row.rank === 0 ? "—" : `#${row.rank}`).padEnd(9)
        } ${row.hitCount.toString().padStart(2)} Tr.  ${row.elapsedMs.toFixed(0).padStart(5)} ms  ${row.topPaths[0] ?? ""}`,
    )
    .join("\n");

  const o = report.overall;
  console.log(`\n=== ${args.label} — ${COLLECTION} ===\n`);
  console.log(table);
  console.log(
    `\nGESAMT (${o.questions} beantwortbare Fragen): MRR ${o.mrr.toFixed(3)}  Platz1 ${o.top1}/${o.questions}  Recall@5 ${o.recall5}/${o.questions}`,
  );
  for (const [name, agg] of Object.entries(report.categories)) {
    if (agg.questions === 0) continue;
    console.log(
      `  ${name.padEnd(12)} MRR ${agg.mrr.toFixed(3)}  Platz1 ${agg.top1}/${agg.questions}  Recall@5 ${agg.recall5}/${agg.questions}`,
    );
  }
  for (const entry of report.clearAbsence) {
    console.log(
      `  Klare Negativprobe ${entry.id}: ${entry.abstained ? "schweigt (NO_SUFFICIENT_MATCH)" : entry.notEvaluated ? `nicht bewertet (${entry.hitCount} Treffer)` : `${entry.hitCount} Treffer, KEINE Abwesenheitsaussage`}  Selbsterwaehnung: ${entry.selfMentionPaths.join(", ") || "keine"}`,
    );
  }
  for (const entry of report.compositionalDiagnostics) {
    console.log(
      `  Kompositionelle Diagnose ${entry.id} (kein Pass/Fail): ${entry.abstained ? "schweigt" : `${entry.hitCount} Treffer`}  Basis ${entry.relevanceBasis ?? "accepted"}  Top ${entry.topPaths[0] ?? "—"}`,
    );
  }
  for (const entry of report.germanCorroboration) {
    console.log(
      `  Deutsche Korroborationsprobe ${entry.id}: ${entry.rank === 0 ? "—" : `#${entry.rank}`}  Lexik ${entry.lexicalBranchContributed ? "beteiligt" : entry.lexicalBranchOmitted ? "weggelassen" : "ohne Rang"}  Top ${entry.topPaths[0] ?? "—"}`,
    );
  }
  for (const entry of report.germanPolicyHoldouts) {
    console.log(
      `  Deutsche Policy-Holdout ${entry.id}: ${entry.abstained ? "SCHWEIGT" : entry.notEvaluated ? "NICHT BEWERTET" : entry.rank === 0 ? "Goldpfad ausserhalb Top K" : `#${entry.rank}`}  Top ${entry.topPaths[0] ?? "—"}`,
    );
  }

  const acceptanceFailures = [
    ...report.truthRetention.abstainedIds.map((id) => `answerable ${id} abstained`),
    ...report.truthRetention.notEvaluatedIds.map((id) => `answerable ${id} was not evaluated`),
    ...report.clearAbsence
      .filter((entry) => !entry.abstained)
      .map((entry) => `clear negative ${entry.id} did not abstain`),
    ...report.germanCorroboration
      .filter((entry) => entry.abstained || entry.notEvaluated || entry.rank !== 1)
      .map(
        (entry) =>
          `German corroboration ${entry.id} was ${entry.abstained ? "rejected" : entry.notEvaluated ? "not evaluated" : `ranked ${entry.rank || "outside top K"}`}`,
      ),
    ...report.germanPolicyHoldouts
      .filter((entry) => entry.abstained || entry.notEvaluated || entry.rank === 0)
      .map(
        (entry) =>
          `German policy holdout ${entry.id} was ${entry.abstained ? "rejected" : entry.notEvaluated ? "not evaluated" : "outside top K"}`,
      ),
  ];
  if (acceptanceFailures.length > 0) {
    throw new Error(`benchmark acceptance failed: ${acceptanceFailures.join("; ")}`);
  }

  // Erst NACH Retrieval- und Akzeptanzpruefung schreiben. Ein fehlgeschlagener
  // Lauf darf kein Artefakt hinterlassen, das wie eine gueltige Standing-
  // Index-Messung aussieht.
  if (args.out !== undefined) {
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\ngeschrieben: ${args.out}`);
  }
}

await main();
