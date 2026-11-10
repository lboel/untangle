import path from "node:path";

import { LanceDbVectorStore } from "../../dist/index.js";
import { StorageCall } from "../../dist/operation.js";
import { MUTATION_GUARD_FILE, withMutationLock } from "../../dist/write-lock.js";

const [mode, root, name = "worker"] = process.argv.slice(2);
const send = (value) =>
  new Promise((resolve, reject) =>
    process.send(value, (error) => (error ? reject(error) : resolve())),
  );
const start = () => new Promise((resolve) => process.once("message", resolve));

try {
  await send({ ready: true });
  await start();
  if (mode === "read-guard") {
    const { DatabaseSync } = await import("node:sqlite");
    const guard = new DatabaseSync(path.join(root, MUTATION_GUARD_FILE), { readOnly: true });
    try {
      guard.exec("BEGIN");
      guard.prepare("SELECT name FROM sqlite_master").all();
      await send({ locked: true });
      await start();
    } finally {
      guard.close();
    }
  } else if (mode === "hold") {
    await withMutationLock(
      root,
      new StorageCall("test_guard_holder", undefined, 120_000),
      10_000,
      async () => {
        await send({ locked: true });
        await start();
      },
    );
  } else {
    const store = new LanceDbVectorStore({ path: root, requestTimeoutMs: 60_000 });
    await store.ensureCollection({
      name: "points",
      denseDimensions: 3,
      denseDistance: "Cosine",
      sparseBm25: true,
      onDiskPayload: true,
    });
    const rounds = mode === "crash" ? 100 : 8;
    for (let i = 0; i < rounds; i += 1) {
      const id = `${name}-${i}`;
      await store.upsert("points", [
        {
          id,
          dense: [1, 0, 0],
          sparse: { indices: [1], values: [1] },
          payload: { owner: name, i },
        },
        { id: "shared", payload: { owner: name, i } },
      ]);
      await send({ committed: id });
    }
    await store.close();
  }
  process.disconnect();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  process.disconnect();
}
