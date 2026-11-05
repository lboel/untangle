/**
 * Die Verdrahtung, die fast jeder Befehl braucht: von der Konfiguration im
 * Projekt zu den fertigen Adaptern.
 *
 * Diese Datei ist bewusst die EINZIGE Stelle, an der die Oberflaeche
 * Adapterklassen anfasst. Jeder Befehl bekommt danach nur noch Ports zu
 * sehen. Das ist keine Kosmetik: es ist der Grund, warum sich `query` gegen
 * den In-Memory-Speicher des testkits genauso testen laesst wie gegen ein
 * echtes Qdrant.
 */

import {
  assertConfigValid,
  deriveEmbeddingProfile,
  loadConfig,
  type ConfigIssue,
  type EffectiveUntangleConfigV1,
  type LoadConfigResult,
} from "@untangle-code/config";
import {
  buildEmbeddingProfileId,
  compareCodepoints,
  embeddingProfileShortId,
  type EmbeddingProfile,
  type EmbeddingProvider,
  type VectorStore,
} from "@untangle-code/domain";
import { OllamaEmbeddingProvider } from "@untangle-code/embeddings-ollama";
import {
  createHybridSearchEngine,
  type HybridSearchEngine,
  type ProfileTargetV1,
  type SearchGraphEnrichmentPort,
} from "@untangle-code/search";
import {
  FetchQdrantTransport,
  codeCollectionName,
  createQdrantStorage,
  resolveQdrantStorageConfig,
  textToBm25SparseVector,
  type QdrantStorage,
  type QdrantStorageConfig,
} from "@untangle-code/storage-qdrant";

import { OperationalError } from "./exit.js";
import { systemClock, systemRandom } from "./system.js";
import { assertVectorStoreAllowed, decideVectorStore } from "./vector-store-policy.js";

/** Die aufgeloeste Sicht des Projekts, wie sie jeder Befehl sieht. */
export interface WorkspaceView {
  readonly root: string;
  readonly config: EffectiveUntangleConfigV1;
  readonly load: LoadConfigResult;
  readonly workspaceId: string;
  readonly profile: EmbeddingProfile;
  readonly profileId: string;
  readonly profileShortId: string;
  /** Repository-IDs aus der Konfiguration, codepoint-sortiert. */
  readonly repoIds: readonly string[];
}

/**
 * Laedt die Konfiguration und leitet Identitaeten ab.
 *
 * `strict` entscheidet ueber spec.md §4.8: mit `strict` bricht ein
 * Konfigurationsfehler ab (was jeder Befehl tut, der wirklich etwas tut),
 * ohne `strict` kommen die Befunde als Daten zurueck (was `doctor` braucht,
 * denn `doctor` soll den Fehler ja BERICHTEN statt an ihm zu sterben).
 */
export function loadWorkspace(options: {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  workspaceIdOverride?: string | undefined;
  strict: boolean;
}): WorkspaceView {
  const load = loadConfig({
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
  });
  if (options.strict) assertConfigValid(load.errors);

  const profile = deriveEmbeddingProfile(load.effectiveConfig);
  const profileId = buildEmbeddingProfileId(profile);
  const repoIds = (load.effectiveConfig.repositories ?? [])
    .map((repo) => repo.id)
    .sort(compareCodepoints);

  return {
    root: load.sources.projectRoot ?? load.sources.configBaseDir,
    config: load.effectiveConfig,
    load,
    workspaceId: options.workspaceIdOverride ?? load.workspaceId,
    profile,
    profileId,
    profileShortId: embeddingProfileShortId(profileId),
    repoIds,
  };
}

/** Konfigurationsbefunde als Textzeilen — Warnungen wie Fehler, nie stumm. */
export function describeConfigIssues(issues: readonly ConfigIssue[]): string[] {
  return issues
    .map((issue) => `${issue.path || "(root)"}: ${issue.message} [${issue.code}]`)
    .sort(compareCodepoints);
}

export interface StorageWiring {
  readonly qdrantConfig: QdrantStorageConfig;
  readonly storage: QdrantStorage;
  readonly vectorStore: VectorStore;
  readonly codeCollection: string;
  /** Woher die benutzte Adresse kommt — `doctor` zeigt das dem Nutzer. */
  readonly decision: ReturnType<typeof decideVectorStore>;
}

/**
 * Baut die Qdrant-Adapter aus der aufgeloesten Konfiguration.
 *
 * WP-222: das ist der Engpass, durch den JEDER Befehl geht, der einen
 * Vektorspeicher anfasst — und deshalb die Stelle, an der die Regel aus
 * `vector-store-policy.ts` durchgesetzt wird. Sie wird VOR dem Aufloesen
 * gefragt und danach noch einmal gegen das Ergebnis geprueft: die
 * Entscheidung bestimmt die Adresse, statt eine Adapter-Vorgabe hinterher zu
 * segnen. Vorher fiel `mode: "managed"` ohne `url` im Adapter auf den
 * Standardport einer fremden Instanz zurueck, und `doctor` meldete diese
 * Instanz als in Ordnung.
 */
export function wireStorage(
  view: WorkspaceView,
  env: Readonly<Record<string, string | undefined>>,
): StorageWiring {
  const decision = decideVectorStore({ qdrant: view.config.qdrant, env });
  if (!decision.allowed) {
    throw new OperationalError(decision.reason, decision.nextStep ?? "See `untangle init --help`.");
  }

  let qdrantConfig: QdrantStorageConfig;
  try {
    qdrantConfig = resolveQdrantStorageConfig({ ...view.config.qdrant, url: decision.url }, env);
  } catch (error) {
    throw new OperationalError(
      `Cannot resolve Qdrant configuration: ${errorMessage(error)}`,
      'Check your configuration\'s `qdrant` section; mode "external" requires `url`.',
      { cause: error },
    );
  }
  assertVectorStoreAllowed(decision, qdrantConfig.url);

  const transport = new FetchQdrantTransport({
    url: qdrantConfig.url,
    ...(qdrantConfig.apiKey === undefined ? {} : { apiKey: qdrantConfig.apiKey }),
    requestTimeoutMs: qdrantConfig.requestTimeoutMs,
  });
  const storage = createQdrantStorage({ config: qdrantConfig, clock: systemClock, transport });

  return {
    qdrantConfig,
    storage,
    vectorStore: storage.vectorStore,
    codeCollection: codeCollectionName(qdrantConfig.collectionPrefix, view.profileShortId),
    decision,
  };
}

/** Baut den Ollama-Embedder aus der aufgeloesten Konfiguration. */
export function wireEmbedder(view: WorkspaceView): EmbeddingProvider {
  const embeddings = view.config.embeddings;
  return new OllamaEmbeddingProvider(
    {
      profile: view.profile,
      mode: embeddings.mode,
      url: embeddings.url,
      apiKeyEnv: embeddings.apiKeyEnv,
      contextLength: embeddings.contextLength,
      batchSize: embeddings.batchSize,
      maxConnections: embeddings.maxConnections,
      requestTimeoutMs: embeddings.requestTimeoutMs,
    },
    { clock: systemClock, random: systemRandom },
  );
}

/**
 * Baut den Abrufkern.
 *
 * Ein Ziel je Embedding-Profil (spec.md §13.4). Diese Fassung kennt genau ein
 * Profil — das der Konfiguration. Mehrere Profile in einem Workspace sind im
 * Abrufkern vorgesehen, hier aber noch nicht konfigurierbar; das steht so in
 * der README unter „Bekannte Grenzen".
 */
export function wireSearchEngine(input: {
  view: WorkspaceView;
  vectorStore: VectorStore;
  collection: string;
  embedder: EmbeddingProvider;
  indexContexts?: readonly {
    repoId: string;
    refId: string;
    generationId: string;
    corpusRevisionFingerprint?: string;
    outcome: "running" | "completed" | "cancelled" | "failed";
  }[];
  graphEnrichment?: SearchGraphEnrichmentPort;
}): HybridSearchEngine {
  const target: ProfileTargetV1 = {
    embeddingProfileId: input.view.profileId,
    collection: input.collection,
    repoIds: [...input.view.repoIds],
    embedder: input.embedder,
    ...(input.indexContexts === undefined ? {} : { indexContexts: input.indexContexts }),
  };
  return createHybridSearchEngine({
    vectorStore: input.vectorStore,
    targets: [target],
    defaults: {
      workspaceId: input.view.workspaceId,
      limit: input.view.config.search.defaultLimit,
      candidateLimit: input.view.config.search.defaultCandidateLimit,
    },
    searchConfig: input.view.config.search,
    clock: systemClock,
    sparseVectorizer: textToBm25SparseVector,
    ...(input.graphEnrichment === undefined ? {} : { graphEnrichment: input.graphEnrichment }),
  });
}

/** Die Botschaft eines unbekannten Wurfs, ohne je `[object Object]` zu zeigen. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
