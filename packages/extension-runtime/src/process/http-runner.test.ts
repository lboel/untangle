import { describe, expect, it } from "vitest";

import { fixedClock } from "../test-support/fixtures.js";

import type { FetchLike } from "./http-runner.js";
import { createFetchHttpRunner } from "./http-runner.js";
import { defaultProcessLimits } from "./types.js";

/** Erzeugt einen Antwortkoerper als Stream — wie `fetch` ihn liefert. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 8) {
        controller.enqueue(bytes.subarray(offset, offset + 8));
      }
      controller.close();
    },
  });
}

const limits = { ...defaultProcessLimits(), timeoutMs: 1_000 };

describe("createFetchHttpRunner", () => {
  it("liest eine Antwort vollstaendig", async () => {
    const fetchImpl: FetchLike = (input) => {
      expect(input).toBe("http://127.0.0.1:19000/api/findings");
      return Promise.resolve({
        status: 200,
        body: streamOf('{"findings":[]}'),
        text: () => Promise.resolve(""),
      });
    };
    const runner = createFetchHttpRunner(fetchImpl, fixedClock(0, 3));
    const result = await runner.request({ url: "http://127.0.0.1:19000/api/findings" }, limits);
    expect(result.outcome).toBe("completed");
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"findings":[]}');
    expect(result.bodyTruncated).toBe(false);
  });

  it("begrenzt den Antwortkoerper und meldet die Kuerzung (E4)", async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve({
        status: 200,
        body: streamOf("y".repeat(500)),
        text: () => Promise.resolve(""),
      });
    const runner = createFetchHttpRunner(fetchImpl, fixedClock(0, 3));
    const result = await runner.request(
      { url: "http://127.0.0.1:1/x" },
      {
        ...limits,
        maxOutputBytes: 64,
      },
    );
    expect(result.outcome).toBe("output_limit_exceeded");
    expect(result.bodyTruncated).toBe(true);
    expect(result.body).toHaveLength(64);
    expect(result.failureDetail).toContain("exceeded the limit");
  });

  it("meldet einen Netzfehler, ohne zu werfen (X2)", async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"));
    const runner = createFetchHttpRunner(fetchImpl, fixedClock(0, 3));
    const result = await runner.request({ url: "http://127.0.0.1:1/x" }, limits);
    expect(result.outcome).toBe("spawn_failed");
    expect(result.failureDetail).toContain("ECONNREFUSED");
  });

  it("bricht bei Ueberschreiten des Zeitbudgets ab", async () => {
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    const runner = createFetchHttpRunner(fetchImpl, fixedClock(0, 3));
    const result = await runner.request(
      { url: "http://127.0.0.1:1/x" },
      {
        ...limits,
        timeoutMs: 20,
      },
    );
    expect(result.outcome).toBe("timeout");
    expect(result.failureDetail).toContain("time budget");
  });
});
