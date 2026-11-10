import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { connect } from "@lancedb/lancedb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StorageCall } from "./operation.js";
import { collectionTableName } from "./schema.js";
import { LanceDbVectorStore } from "./vector-store.js";
import { MUTATION_GUARD_FILE, withMutationLock } from "./write-lock.js";

interface Worker {
  child: ChildProcess;
  messages: Record<string, unknown>[];
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
  wait(predicate: (message: Record<string, unknown>) => boolean): Promise<void>;
}
const workers: Worker[] = [];
let root: string;
let current: LanceDbVectorStore;
const points = {
  name: "points",
  denseDimensions: 3,
  denseDistance: "Cosine",
  sparseBm25: true,
  onDiskPayload: true,
} as const;

function worker(mode: string, name = "worker"): Worker {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./testing/process-worker.mjs", import.meta.url)), mode, root, name],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const messages: Record<string, unknown>[] = [];
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("message", (message: Record<string, unknown>) => messages.push(message));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stderr }));
    },
  );
  const result: Worker = {
    child,
    messages,
    done,
    wait: async (predicate) => {
      if (messages.some(predicate)) return;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Worker event timed out: ${stderr}`));
        }, 15_000);
        const onMessage = (message: Record<string, unknown>) => {
          if (predicate(message)) {
            cleanup();
            resolve();
          }
        };
        const onExit = () => {
          cleanup();
          reject(new Error(`Worker exited before expected event: ${stderr}`));
        };
        function cleanup() {
          clearTimeout(timeout);
          child.off("message", onMessage);
          child.off("exit", onExit);
        }
        child.on("message", onMessage);
        child.once("exit", onExit);
      });
    },
  };
  workers.push(result);
  return result;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "untangle-lance-process-"));
  current = new LanceDbVectorStore({ path: root });
  await current.ensureCollection(points);
});
afterEach(async () => {
  for (const item of workers.splice(0)) {
    if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill("SIGKILL");
    await item.done;
  }
  await current.close();
  await rm(root, { recursive: true, force: true });
});

describe("real independent processes", () => {
  it("imports and reads absent storage without a native binding, then reports an actionable access error", async () => {
    const empty = await mkdtemp(path.join(root, "lazy-"));
    await promisify(execFile)(process.execPath, [
      "--experimental-loader",
      fileURLToPath(new URL("./testing/block-lance-loader.mjs", import.meta.url)),
      fileURLToPath(new URL("./testing/lazy-worker.mjs", import.meta.url)),
      empty,
    ]);
  });
  it("serializes simultaneous overlapping native upserts without losing or duplicating IDs", async () => {
    // Both processes must also create the initial catalog/guard safely.
    await rm(root, { recursive: true, force: true });
    const a = worker("write", "a"),
      b = worker("write", "b");
    await Promise.all([
      a.wait((message) => message["ready"] === true),
      b.wait((message) => message["ready"] === true),
    ]);
    a.child.send("start");
    b.child.send("start");
    const exits = await Promise.all([a.done, b.done]);
    // Node 22.13 prints its own experimental node:sqlite warning. Captured
    // stderr stays available as diagnostics; successful exit is the contract.
    expect(exits, JSON.stringify(exits)).toMatchObject([
      { code: 0, signal: null },
      { code: 0, signal: null },
    ]);
    expect(await current.countByFilter("points", {})).toBe(17);
    const native = await connect(root, { readConsistencyInterval: 0 });
    const table = await native.openTable(collectionTableName("points"));
    try {
      expect(await table.countRows()).toBe(17);
    } finally {
      table.close();
      native.close();
    }
    expect(
      (await current.retrieve("points", ["a-7", "b-7", "shared"])).map((point) => point.id),
    ).toEqual(["a-7", "b-7", "shared"]);
  });

  it("initializes native storage while a second process holds a read lock on the empty guard", async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(root);
    await writeFile(path.join(root, MUTATION_GUARD_FILE), "", { flag: "wx", mode: 0o600 });
    const reader = worker("read-guard");
    await reader.wait((message) => message["ready"] === true);
    reader.child.send("start");
    await reader.wait((message) => message["locked"] === true);

    await current.ensureCollection(points);
    await current.upsert("points", [{ id: "first", payload: {} }]);
    expect((await current.retrieve("points", ["first"])).map((point) => point.id)).toEqual([
      "first",
    ]);

    reader.child.send("release");
    expect(await reader.done).toMatchObject({ code: 0, signal: null });
  });

  it("aborts and times out while another real process holds the mutex, then recovers after SIGKILL", async () => {
    const held = worker("hold");
    await held.wait((message) => message["ready"] === true);
    held.child.send("start");
    await held.wait((message) => message["locked"] === true);
    const controller = new AbortController();
    const pending = current.upsert("points", [{ id: "cancelled", payload: {} }], {
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "JOB_CANCELLED",
      context: { mayHaveCommitted: false },
    });
    await delay(40);
    controller.abort();
    await assertion;
    const short = new LanceDbVectorStore({ path: root, lockTimeoutMs: 50 });
    try {
      await expect(
        short.upsert("points", [{ id: "timed-out", payload: {} }]),
      ).rejects.toMatchObject({ code: "LOCK_HELD", retryable: true });
    } finally {
      await short.close();
    }
    held.child.kill("SIGKILL");
    expect((await held.done).signal).toBe("SIGKILL");
    await current.upsert("points", [{ id: "recovered", payload: {} }]);
    expect((await current.scroll("points", { limit: 10 })).points.map((point) => point.id)).toEqual(
      ["recovered"],
    );
  });

  it("retains acknowledged commits after a native writer is killed mid-work and permits idempotent recovery", async () => {
    const writing = worker("crash", "crash");
    await writing.wait((message) => message["ready"] === true);
    writing.child.send("start");
    await writing.wait((message) => message["committed"] === "crash-2");
    writing.child.kill("SIGKILL");
    expect((await writing.done).signal).toBe("SIGKILL");
    const acknowledged = writing.messages.flatMap((message) =>
      typeof message["committed"] === "string" ? [message["committed"]] : [],
    );
    expect(acknowledged.length).toBeGreaterThanOrEqual(3);
    expect((await current.retrieve("points", acknowledged)).map((point) => point.id)).toEqual(
      acknowledged,
    );
    await current.upsert(
      "points",
      acknowledged.map((id) => ({ id, payload: { recovered: true } })),
    );
    expect(
      (await current.retrieve("points", acknowledged)).every(
        (point) => point.payload["recovered"] === true,
      ),
    ).toBe(true);
    const ids = (await current.scroll("points", { limit: 200 })).points.map((point) => point.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the lock until canceled work actually settles, and releases it after failure", async () => {
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = withMutationLock(
      root,
      new StorageCall("held", controller.signal, 10_000),
      1000,
      async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    );
    const heldAssertion = expect(held).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    await enteredPromise;
    controller.abort();
    const blocked = withMutationLock(
      root,
      new StorageCall("blocked", undefined, 1000),
      50,
      async () => true,
    );
    await expect(blocked).rejects.toMatchObject({ code: "LOCK_HELD" });
    release();
    await heldAssertion;
    await expect(
      withMutationLock(root, new StorageCall("fail", undefined, 1000), 1000, async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    await expect(
      withMutationLock(root, new StorageCall("recovered", undefined, 1000), 1000, async () => "ok"),
    ).resolves.toBe("ok");
  });
});
