import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FakeClock,
  runGraphStoreContract,
  runMetadataStoreContract,
  runVectorStoreContract,
} from "@untangle-code/testkit";
import { afterEach } from "vitest";

import { createLanceDbStorage, type LanceDbStorage } from "./factory.js";

const instances: { root: string; storage: LanceDbStorage }[] = [];

async function storage(): Promise<LanceDbStorage> {
  const root = await mkdtemp(path.join(os.tmpdir(), "untangle-lance-contract-"));
  const instance = createLanceDbStorage({
    path: path.join(root, "db"),
    clock: new FakeClock(1_700_000_000_000),
  });
  instances.push({ root, storage: instance });
  return instance;
}

afterEach(async () => {
  for (const instance of instances.splice(0)) {
    await instance.storage.close();
    await rm(instance.root, { recursive: true, force: true });
  }
});

// Exactly the same public contracts used by Qdrant and the testkit adapters,
// here backed by actual native Lance tables, without a fake transport.
runVectorStoreContract(async () => (await storage()).vectorStore);
runMetadataStoreContract(async () => (await storage()).metadataStore);
runGraphStoreContract(async () => (await storage()).graphStore);
