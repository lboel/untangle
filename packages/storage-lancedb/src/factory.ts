import type { Clock } from "@untangle-code/domain";
import {
  assertValidCollectionPrefix,
  QdrantGraphStore,
  QdrantMetadataStore,
} from "@untangle-code/storage-qdrant";

import { invalid } from "./operation.js";
import { LanceDbVectorStore, type LanceDbVectorStoreOptions } from "./vector-store.js";

export interface CreateLanceDbStorageOptions extends LanceDbVectorStoreOptions {
  clock: Clock;
  collectionPrefix?: string;
  graphPartBudgetBytes?: number;
}

export interface LanceDbStorage {
  vectorStore: LanceDbVectorStore;
  metadataStore: QdrantMetadataStore;
  graphStore: QdrantGraphStore;
  close(): Promise<void>;
}

/** Wiring only: no filesystem effects, native imports or connections until access. */
export function createLanceDbStorage(options: CreateLanceDbStorageOptions): LanceDbStorage {
  const collectionPrefix = options.collectionPrefix ?? "untangle_";
  assertValidCollectionPrefix(collectionPrefix);
  const vectorStore = new LanceDbVectorStore(options);
  const partBudgetBytes =
    options.graphPartBudgetBytes ?? Math.min(1024 * 1024, vectorStore.options.upsertBudgetBytes);
  if (
    !Number.isSafeInteger(partBudgetBytes) ||
    partBudgetBytes < 1 ||
    partBudgetBytes > vectorStore.options.upsertBudgetBytes
  )
    throw invalid("graphPartBudgetBytes must fit inside the point byte budget.");
  return {
    vectorStore,
    metadataStore: new QdrantMetadataStore({ vectorStore, collectionPrefix }),
    graphStore: new QdrantGraphStore({
      vectorStore,
      clock: options.clock,
      collectionPrefix,
      partBudgetBytes,
    }),
    close: () => vectorStore.close(),
  };
}
