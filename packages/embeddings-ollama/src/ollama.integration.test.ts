/**
 * Real-Ollama integration suite (rule 6, WP-10 task). Talks to an actual
 * Ollama instance at `127.0.0.1:11434` with `qwen3-embedding:0.6b`
 * (1024 dimensions). Self-skips — via `describe.skipIf`, decided by a
 * top-level `await` before any test is registered — when the service is not
 * reachable, or when the specific model has not been pulled, so this file
 * never fails a run in an environment without Ollama. It is NOT part of the
 * default `vitest run` for this package (see `vitest.config.ts`'s exclude
 * and `vitest.integration.config.ts`) and must be invoked explicitly via
 * `pnpm --filter @untangle-code/embeddings-ollama run test:integration`.
 */
import { DeterministicRandom, SystemClock } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { OllamaEmbeddingProvider } from "./provider.js";

const OLLAMA_URL = process.env["UNTANGLE_TEST_OLLAMA_URL"] ?? "http://127.0.0.1:11434";
const MODEL = "qwen3-embedding:0.6b";
const DIMENSIONS = 1024;

interface OllamaProbe {
  reachable: boolean;
  modelAvailable: boolean;
}

async function probeOllama(): Promise<OllamaProbe> {
  try {
    const response = await fetch(new URL("api/tags", OLLAMA_URL), {
      method: "GET",
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      return { reachable: false, modelAvailable: false };
    }
    const body = (await response.json()) as { models?: { name: string }[] };
    const modelAvailable = (body.models ?? []).some(
      (tag) => tag.name === MODEL || tag.name.split(":")[0] === MODEL.split(":")[0],
    );
    return { reachable: true, modelAvailable };
  } catch {
    return { reachable: false, modelAvailable: false };
  }
}

const probe = await probeOllama();
if (!probe.reachable) {
  console.info(`[ollama.integration.test] skipping: no Ollama reachable at ${OLLAMA_URL}`);
} else if (!probe.modelAvailable) {
  console.info(
    `[ollama.integration.test] skipping: model "${MODEL}" is not pulled on ${OLLAMA_URL}`,
  );
}

describe.skipIf(!probe.reachable || !probe.modelAvailable)(
  "Ollama integration (real service)",
  () => {
    function makeProvider(): OllamaEmbeddingProvider {
      return new OllamaEmbeddingProvider(
        {
          profile: {
            provider: "ollama",
            model: MODEL,
            dimensions: DIMENSIONS,
            queryPrefix: "search_query: ",
            documentPrefix: "search_document: ",
            includePath: true,
            normalization: "none",
            preparedTextVersion: "v1",
          },
          mode: "external",
          url: OLLAMA_URL,
          contextLength: 2048,
          batchSize: 4,
          maxConnections: 2,
          requestTimeoutMs: 30000,
        },
        { clock: new SystemClock(), random: new DeterministicRandom(1) },
      );
    }

    it("completes the readiness sequence against the real service", async () => {
      const provider = makeProvider();
      const readiness = await provider.ensureReady();
      expect(readiness.model).toBe(MODEL);
      expect(readiness.dimensions).toBe(DIMENSIONS);
      expect(readiness.endpoint).toContain("127.0.0.1");
    });

    it("embeds a real document batch at the expected dimensionality", async () => {
      const provider = makeProvider();
      const result = await provider.embedDocuments([
        "repository: demo\npath: src/index.ts\n\nexport function add(a: number, b: number): number { return a + b; }",
        "repository: demo\npath: src/util.ts\n\nexport function noop(): void {}",
      ]);
      expect(result.vectors).toHaveLength(2);
      for (const vector of result.vectors) {
        expect(vector).toHaveLength(DIMENSIONS);
      }
      expect(result.truncated).toEqual([false, false]);
    });

    it("embeds a real query at the expected dimensionality", async () => {
      const provider = makeProvider();
      const vector = await provider.embedQuery("search_query: add two numbers");
      expect(vector).toHaveLength(DIMENSIONS);
    });
  },
);
