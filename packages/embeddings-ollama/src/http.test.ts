import { describe, expect, it } from "vitest";

import { OllamaHttpClient, OllamaHttpError, OllamaRequestCancelledError } from "./http.js";

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

describe("OllamaHttpClient", () => {
  it("parses a successful JSON response", async () => {
    const client = new OllamaHttpClient({
      requestTimeoutMs: 1000,
      maxConnections: 2,
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    });
    const result = await client.requestJson<{ ok: boolean }>("http://x.test", "api/tags", {
      method: "GET",
    });
    expect(result).toEqual({ ok: true });
  });

  it("sends the JSON body and content-type for a POST", async () => {
    let seenInit: RequestInit | undefined;
    const client = new OllamaHttpClient({
      requestTimeoutMs: 1000,
      maxConnections: 2,
      fetchImpl: fakeFetch((_url, init) => {
        seenInit = init;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    });
    await client.requestJson("http://x.test", "api/embed", {
      method: "POST",
      body: { model: "m", input: ["a"] },
    });
    expect(seenInit?.body).toBe(JSON.stringify({ model: "m", input: ["a"] }));
    expect((seenInit?.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("adds an Authorization header from the configured env var", async () => {
    process.env["FAKE_OLLAMA_TOKEN"] = "secret-token";
    let seenAuth: string | undefined;
    try {
      const client = new OllamaHttpClient({
        requestTimeoutMs: 1000,
        maxConnections: 2,
        apiKeyEnv: "FAKE_OLLAMA_TOKEN",
        fetchImpl: fakeFetch((_url, init) => {
          seenAuth = (init?.headers as Record<string, string>)["authorization"];
          return new Response(JSON.stringify({}), { status: 200 });
        }),
      });
      await client.requestJson("http://x.test", "api/tags", { method: "GET" });
      expect(seenAuth).toBe("Bearer secret-token");
    } finally {
      delete process.env["FAKE_OLLAMA_TOKEN"];
    }
  });

  it("classifies a 5xx response as a retryable OllamaHttpError", async () => {
    const client = new OllamaHttpClient({
      requestTimeoutMs: 1000,
      maxConnections: 2,
      fetchImpl: fakeFetch(() => new Response("boom", { status: 503 })),
    });
    await expect(
      client.requestJson("http://x.test", "api/tags", { method: "GET" }),
    ).rejects.toMatchObject({
      retryable: true,
      status: 503,
    });
  });

  it("classifies a 429 response as retryable", async () => {
    const client = new OllamaHttpClient({
      requestTimeoutMs: 1000,
      maxConnections: 2,
      fetchImpl: fakeFetch(() => new Response("slow down", { status: 429 })),
    });
    await expect(
      client.requestJson("http://x.test", "api/tags", { method: "GET" }),
    ).rejects.toBeInstanceOf(OllamaHttpError);
  });

  it("classifies a 4xx response other than 429 as permanent (not retryable)", async () => {
    const client = new OllamaHttpClient({
      requestTimeoutMs: 1000,
      maxConnections: 2,
      fetchImpl: fakeFetch(() => new Response("nope", { status: 400 })),
    });
    await expect(
      client.requestJson("http://x.test", "api/tags", { method: "GET" }),
    ).rejects.toMatchObject({
      retryable: false,
      status: 400,
    });
  });

  it("classifies a network failure as a retryable OllamaHttpError", async () => {
    const client = new OllamaHttpClient({
      requestTimeoutMs: 1000,
      maxConnections: 2,
      fetchImpl: fakeFetch(() => {
        throw new TypeError("fetch failed");
      }),
    });
    await expect(
      client.requestJson("http://x.test", "api/tags", { method: "GET" }),
    ).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("throws OllamaRequestCancelledError when the caller's own signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new OllamaHttpClient({
      requestTimeoutMs: 1000,
      maxConnections: 2,
      fetchImpl: fakeFetch(() => new Response("{}", { status: 200 })),
    });
    await expect(
      client.requestJson("http://x.test", "api/tags", { method: "GET" }, controller.signal),
    ).rejects.toBeInstanceOf(OllamaRequestCancelledError);
  });

  it("throws OllamaRequestCancelledError, not a retryable error, when the caller aborts mid-request", async () => {
    const controller = new AbortController();
    const client = new OllamaHttpClient({
      requestTimeoutMs: 1000,
      maxConnections: 2,
      fetchImpl: fakeFetch(async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }),
    });
    await expect(
      client.requestJson("http://x.test", "api/tags", { method: "GET" }, controller.signal),
    ).rejects.toBeInstanceOf(OllamaRequestCancelledError);
  });

  it("limits concurrently in-flight requests to maxConnections", async () => {
    let active = 0;
    let maxActive = 0;
    const client = new OllamaHttpClient({
      requestTimeoutMs: 1000,
      maxConnections: 2,
      fetchImpl: fakeFetch(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return new Response("{}", { status: 200 });
      }),
    });
    await Promise.all(
      Array.from({ length: 6 }, () =>
        client.requestJson("http://x.test", "api/tags", { method: "GET" }),
      ),
    );
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
