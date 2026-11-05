/**
 * Convenience wiring: one call from resolved configuration to the three
 * stores of this adapter, sharing a single transport.
 */
import type { Clock } from "@untangle-code/domain";

import type { QdrantStorageConfig } from "./config.js";
import { QdrantGraphStore } from "./graph-store.js";
import { QdrantMetadataStore } from "./metadata-store.js";
import type { QdrantTransport } from "./transport.js";
import { FetchQdrantTransport } from "./transport.js";
import { QdrantVectorStore } from "./vector-store.js";

export interface CreateQdrantStorageOptions {
  config: QdrantStorageConfig;
  /** Time source for graph shard write stamps (never `Date.now()`). */
  clock: Clock;
  /** Override the transport (tests inject the fake REST server here). */
  transport?: QdrantTransport;
}

export interface QdrantStorage {
  vectorStore: QdrantVectorStore;
  metadataStore: QdrantMetadataStore;
  graphStore: QdrantGraphStore;
  transport: QdrantTransport;
}

/** Builds vector, metadata and graph stores over one shared transport. */
export function createQdrantStorage(options: CreateQdrantStorageOptions): QdrantStorage {
  const { config } = options;
  const transport =
    options.transport ??
    new FetchQdrantTransport({
      url: config.url,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      requestTimeoutMs: config.requestTimeoutMs,
    });
  const vectorStore = new QdrantVectorStore({
    transport,
    maxRetries: config.maxRetries,
    retryDelayMs: config.retryDelayMs,
    upsertMaxPoints: config.upsertMaxPoints,
    upsertBudgetBytes: config.upsertBudgetBytes,
  });
  const metadataStore = new QdrantMetadataStore({
    vectorStore,
    collectionPrefix: config.collectionPrefix,
  });
  const graphStore = new QdrantGraphStore({
    vectorStore,
    clock: options.clock,
    collectionPrefix: config.collectionPrefix,
    partBudgetBytes: config.graphPartBudgetBytes,
  });
  return { vectorStore, metadataStore, graphStore, transport };
}
