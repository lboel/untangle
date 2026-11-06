import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";

import { createLanceDbStorage } from "../../dist/index.js";

const root = process.argv[2];
const storage = createLanceDbStorage({
  path: path.join(root, "absent"),
  clock: { nowEpochMs: () => 0, nowIso: () => "1970-01-01T00:00:00.000Z" },
});
assert.equal(await storage.vectorStore.collectionExists("missing"), false);
assert.equal(await storage.metadataStore.getWorkspace("missing"), null);
assert.equal(await storage.graphStore.readShard("graph_files", "missing"), null);
assert.deepEqual(await readdir(root), []);
await assert.rejects(
  storage.vectorStore.ensureCollection({
    name: "points",
    denseDimensions: 3,
    denseDistance: "Cosine",
    sparseBm25: true,
    onDiskPayload: true,
  }),
  (error) => {
    assert.equal(error.code, "LANCEDB_UNAVAILABLE");
    assert.equal(error.retryable, false);
    assert.equal(error.context.alternativeBackend, "qdrant");
    assert.match(error.cause.message, /native Lance binding is unavailable/u);
    return true;
  },
);
await storage.close();
