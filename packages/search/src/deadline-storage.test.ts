import { describe, expect, it } from "vitest";

import { withSearchBranchDeadline } from "./deadline.js";

const hangingRead = (): Promise<never> => new Promise(() => {});

describe("backend-specific search deadlines", () => {
  it("reports LanceDB on sparse timeout and aborts the native branch", async () => {
    let received: AbortSignal | undefined;
    await expect(
      withSearchBranchDeadline(
        "sparse",
        5,
        ({ signal }) => {
          received = signal;
          return hangingRead();
        },
        undefined,
        "LANCEDB_UNAVAILABLE",
      ),
    ).rejects.toMatchObject({ code: "LANCEDB_UNAVAILABLE", context: { timedOut: true } });
    expect(received?.aborted).toBe(true);
  });

  it("preserves Qdrant as the default timeout code for existing adapters", async () => {
    await expect(withSearchBranchDeadline("symbol", 5, hangingRead)).rejects.toMatchObject({
      code: "QDRANT_UNAVAILABLE",
    });
  });

  it("keeps dense provider timeouts distinct from storage failure", async () => {
    await expect(
      withSearchBranchDeadline("dense", 5, hangingRead, undefined, "LANCEDB_UNAVAILABLE"),
    ).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE" });
  });

  it("propagates caller cancellation unchanged before a storage deadline", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const pending = withSearchBranchDeadline(
      "sparse",
      10_000,
      hangingRead,
      { signal: controller.signal },
      "LANCEDB_UNAVAILABLE",
    );
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
