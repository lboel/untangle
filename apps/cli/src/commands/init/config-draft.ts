/**
 * Turning findings into a configuration.
 *
 * The shape written to disk is `UntangleConfigV1` from
 * `@untangle-code/config` — not a private CLI dialect — and it is checked with
 * that package's own validator before a byte reaches the file system. A first
 * command that writes a configuration the rest of the product then rejects is
 * a first command that has failed.
 *
 * WHICH SECTIONS GET WRITTEN: only the ones `init` actually DECIDED something
 * about. Everything else is left to the product defaults, because a file that
 * restates two hundred defaults verbatim tells the reader nothing about what
 * was chosen. `defaultsFor` records the values that stay defaulted so the
 * renderer can name them in prose instead.
 */

import {
  DEFAULT_EMBEDDING_CONFIG,
  DEFAULT_INDEX_CONFIG,
  PRODUCT_DEFAULT_CONFIG,
  mergeConfigLayers,
  validateEffectiveConfig,
} from "@untangle-code/config";
import type { RawConfigLayer } from "@untangle-code/config";
import { sha256Hex, sortByCodepoints } from "@untangle-code/domain";

import type { ProjectFindingsV1 } from "./types.js";

/** The sub-sections `init` fills in, without the `| undefined` of the optional slot. */
type QdrantSection = NonNullable<RawConfigLayer["qdrant"]>;
type EmbeddingSection = NonNullable<RawConfigLayer["embeddings"]>;

export interface ConfigDraftV1 {
  /** Exactly what `init` decided — the layer that ends up in the file. */
  layer: RawConfigLayer;
  /** Validator warnings over the layer merged onto the product defaults. */
  warnings: string[];
  /** Validator errors. Non-empty means the file is NOT written. */
  errors: string[];
}

/**
 * Derives a project id from a directory name.
 *
 * Lowercase, non-alphanumerics collapsed to `-`, trimmed. A name that reduces
 * to nothing (a directory called `...`) falls back to `project`, because an
 * empty id would fail validation and an id derived from something random
 * would not be reproducible.
 */
export function deriveProjectId(directoryName: string): string {
  const slug = directoryName
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length === 0 ? "project" : slug;
}

export function buildConfigDraft(findings: ProjectFindingsV1): ConfigDraftV1 {
  const contextArtifacts = productContextArtifacts(findings);
  const layer: RawConfigLayer = {
    schemaVersion: 1,
    projectId: findings.projectId,
    repositories: [
      {
        id: findings.projectId,
        // Relative to this configuration file — spec.md §4.3 allows exactly
        // that, and a relative path keeps the file portable between checkouts.
        path: ".",
        label: findings.projectId,
        exclude: sortByCodepoints([
          ...findings.ignore.defaultExcludes,
          ...findings.ignore.additionalExcludes,
        ]),
      },
    ],
    ...(findings.storage?.backend === "lancedb"
      ? {
          storage: {
            backend: "lancedb" as const,
            ...(findings.storage.path === undefined ? {} : { path: findings.storage.path }),
          },
        }
      : { storage: { backend: "qdrant" as const }, qdrant: buildQdrantSection(findings) }),
    embeddings: buildEmbeddingSection(findings),
    index: {
      // The only index knob `init` moves: a project whose sources are wider
      // than the default ceiling would otherwise lose them silently.
      maxFileSizeMb: DEFAULT_INDEX_CONFIG.maxFileSizeMb,
      watch: DEFAULT_INDEX_CONFIG.watch,
    },
    graph: {
      // Both levels of the topology feed the graph; a single-package project
      // gets the same setting, it simply has less to draw.
      enabled: true,
    },
    telemetry: { enabled: false },
    ...(contextArtifacts.length === 0 ? {} : { contextArtifacts }),
  };

  const merged = mergeConfigLayers<Record<string, unknown>>([PRODUCT_DEFAULT_CONFIG, layer]);
  const validation = validateEffectiveConfig(merged);
  return {
    layer,
    warnings: [
      ...validation.warnings.map((issue) => `${issue.path}: ${issue.message}`),
      ...(findings.storage?.configurationWarnings ?? []),
      ...(findings.storage?.directoryStatus === "not-directory" ||
      findings.storage?.directoryStatus === "unreadable"
        ? [
            `Local storage ${findings.storage.directory}: ${findings.storage.directoryStatus}${findings.storage.detail === undefined ? "" : ` (${findings.storage.detail})`}. Indexing cannot use this path.`,
          ]
        : []),
    ],
    errors: validation.errors.map((issue) => `${issue.path}: ${issue.message} [${issue.code}]`),
  };
}

function productContextArtifacts(
  findings: ProjectFindingsV1,
): NonNullable<RawConfigLayer["contextArtifacts"]> {
  const descriptions = {
    vision: "Provisional vision",
    specification: "Provisional specification",
    product: "Provisional product description",
  };
  return (findings.productContext?.sources ?? [])
    .filter((source) => source.selected && source.status === "readable")
    .map((source) => ({
      name: `product-${source.role}-${sha256Hex(source.path).slice(0, 12)}`,
      path: `./${source.path}`,
      description: `${descriptions[source.role]}; local document inspection, features and ownership remain unconfirmed.`,
      type: "markdown",
    }));
}

/**
 * Qdrant: `external` only when an endpoint actually answered. Otherwise
 * `managed` with no URL — the mode that says "start your own instance", which
 * is the correct answer both when nothing is running and when the only thing
 * running is somebody else's (spec.md §3.2).
 */
function buildQdrantSection(findings: ProjectFindingsV1): QdrantSection {
  if (findings.storage?.qdrantMode !== undefined) {
    return {
      mode: findings.storage.qdrantMode,
      ...(findings.storage.qdrantUrl === undefined ? {} : { url: findings.storage.qdrantUrl }),
      collectionPrefix: collectionPrefixFor(findings),
    };
  }
  if (findings.qdrant.outcome === "reachable" && findings.qdrant.url !== undefined) {
    return {
      mode: "external",
      url: findings.qdrant.url,
      collectionPrefix: collectionPrefixFor(findings),
    };
  }
  return { mode: "managed", collectionPrefix: collectionPrefixFor(findings) };
}

/** `untangle_<projectId>_` — keeps two projects on one instance from colliding. */
export function collectionPrefixFor(findings: ProjectFindingsV1): string {
  return `untangle_${findings.projectId.replace(/-/gu, "_")}_`;
}

/**
 * Embeddings: when a provider answered, the model AND its vector width and
 * context window are taken from what the provider reported about itself. When
 * none answered, the product default profile stands and `mode` stays `auto`,
 * so the next run can still discover a provider without the user editing
 * anything.
 */
function buildEmbeddingSection(findings: ProjectFindingsV1): EmbeddingSection {
  const chosen = findings.ollama.chosenModel;
  if (findings.ollama.outcome !== "reachable" || chosen === undefined) {
    return {
      provider: "ollama",
      mode: "auto",
      model: DEFAULT_EMBEDDING_CONFIG.model,
      dimensions: DEFAULT_EMBEDDING_CONFIG.dimensions,
      contextLength: DEFAULT_EMBEDDING_CONFIG.contextLength,
    };
  }
  const probe = findings.ollama.embedProbe;
  const measuredWidth = probe.outcome === "ok" ? probe.dimensions : undefined;
  return {
    provider: "ollama",
    mode: "external",
    url: findings.ollama.url,
    model: chosen.name,
    dimensions: measuredWidth ?? chosen.dimensions ?? DEFAULT_EMBEDDING_CONFIG.dimensions,
    contextLength: chosen.contextLength ?? DEFAULT_EMBEDDING_CONFIG.contextLength,
  };
}

/**
 * The single next step.
 *
 * EXACTLY ONE, in a fixed priority order, because a first command that ends
 * in a list of five things is a first command the user closes. The order is
 * "what blocks the next command first": no embedding provider blocks
 * indexing; no model blocks it too; no vector store blocks it; otherwise
 * nothing blocks it and the step is to index.
 */
export function nextStepFor(findings: ProjectFindingsV1): string {
  if (findings.storage?.backend === "lancedb") {
    if (
      findings.storage.directoryStatus === "not-directory" ||
      findings.storage.directoryStatus === "unreadable"
    )
      return `Local storage path ${JSON.stringify(findings.storage.directory)} is ${findings.storage.directoryStatus}. Next step: choose an accessible directory with UNTANGLE_LANCEDB_PATH and rerun \`untangle init\`.`;
    if (findings.ollama.outcome !== "reachable" || findings.ollama.chosenModel === undefined)
      return "Local LanceDB storage needs no service. Next step: `untangle index --embedder=offline` (local vectors without semantic embeddings).";
  }
  if (findings.ollama.outcome !== "reachable") {
    return `No embedding provider at ${findings.ollama.url}. Next step: start \`ollama serve\` and rerun \`untangle init\`.`;
  }
  if (findings.ollama.chosenModel === undefined) {
    return `${findings.ollama.url} is running but reports no embedding model. Next step: \`ollama pull ${DEFAULT_EMBEDDING_CONFIG.model}\`.`;
  }
  if (findings.storage?.backend !== "lancedb" && findings.qdrant.outcome !== "reachable") {
    if (findings.storage?.qdrantMode === "external")
      return `The selected Qdrant server ${JSON.stringify(findings.storage.qdrantUrl)} is unreachable. Next step: check that server's URL and availability, then rerun \`untangle doctor\`.`;
    return "No vector store is reachable. Next step: start an owned instance with `docker run -d --name untangle-qdrant -p 16333:6333 -v untangle-qdrant-data:/qdrant/storage qdrant/qdrant`, then run `untangle index`.";
  }
  // WP-228: Der Anbieter laeuft, das Modell ist da, der Speicher steht — und
  // trotzdem kann nicht indiziert werden, weil der Endpunkt, den der
  // Indexlauf benutzt, nicht antwortet. Das ist ein eigener Fall und
  // verdient einen eigenen naechsten Schritt; „alles vorhanden" waere hier
  // schlicht falsch.
  if (findings.ollama.embedProbe.outcome === "timeout") {
    return `${findings.ollama.url} responds on /api/tags, but /api/embed did not respond within ${String(findings.ollama.embedProbe.timeoutMs)} ms, so embeddings are unavailable. Next step: \`untangle index --embedder=offline\` (local vectors without semantics).`;
  }
  if (findings.ollama.embedProbe.outcome === "failed") {
    return `${findings.ollama.url} is running, but /api/embed failed (${findings.ollama.embedProbe.detail ?? "no details"}). Next step: \`untangle index --embedder=offline\` (local vectors without semantics).`;
  }
  return "Everything is available. Next step: `untangle index`.";
}
