/**
 * Runs the shared port-contract suites of `@untangle-code/testkit` against
 * the Qdrant adapters, backed by the fake Qdrant REST server — the SAME
 * suites that run against the in-memory implementations (E5: no report
 * replaces a test run; the contract is the test).
 */
import {
  FakeClock,
  runGraphStoreContract,
  runMetadataStoreContract,
  runVectorStoreContract,
} from "@untangle-code/testkit";

import { QdrantGraphStore } from "./graph-store.js";
import { QdrantMetadataStore } from "./metadata-store.js";
import { FakeQdrantServer } from "./testing/fake-qdrant-server.js";
import { QdrantVectorStore } from "./vector-store.js";

function vectorStore(transport: FakeQdrantServer): QdrantVectorStore {
  return new QdrantVectorStore({ transport, maxRetries: 0, retryDelayMs: 0 });
}

runVectorStoreContract(() => vectorStore(new FakeQdrantServer()));

runMetadataStoreContract(
  () =>
    new QdrantMetadataStore({
      vectorStore: vectorStore(new FakeQdrantServer()),
      collectionPrefix: "untangle_",
    }),
);

runGraphStoreContract(
  () =>
    new QdrantGraphStore({
      vectorStore: vectorStore(new FakeQdrantServer()),
      clock: new FakeClock(1_700_000_000_000),
      collectionPrefix: "untangle_",
    }),
);
