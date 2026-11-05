/**
 * Regression tests for WP-78: the embedding cache (spec.md §9.4) must
 * prevent double-embedding not just across sequential calls (already
 * covered by `provider.test.ts`'s cache describe block) but also:
 *
 *  - across two CONCURRENT calls racing for the same not-yet-cached text
 *    ("Nebenläufigkeit" — both used to read the cache before either had
 *    written to it, so both fired their own `/api/embed` request);
 *  - within a SINGLE batch containing the same prepared text more than once
 *    ("Batch-interne Deduplizierung" — every occurrence used to be sent
 *    over the wire even though only one is needed).
 *
 * Plus the failure-isolation properties the fix must uphold: a failed
 * in-flight fetch frees its cache key for a fresh retry, and one waiter's
 * own `AbortSignal` firing must not cancel the shared fetch for another
 * waiter joined on the same key.
 */
import { isUntangleError } from "@untangle-code/domain";
import { DeterministicRandom, FakeClock } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { OllamaEmbeddingProvider } from "./provider.js";
import {
  createFakeOllamaFetch,
  createTestProviderConfig,
  GatedLateEmbeddingCache,
} from "./test-helpers.js";
import type { FakeOllamaCall } from "./test-helpers.js";
import type { EmbeddingCachePort } from "./types.js";

function makeProvider(
  fetchImpl: typeof fetch,
  configOverrides: Parameters<typeof createTestProviderConfig>[0] = {},
  cache?: EmbeddingCachePort,
): OllamaEmbeddingProvider {
  return new OllamaEmbeddingProvider(createTestProviderConfig(configOverrides), {
    clock: new FakeClock(1_700_000_000_000),
    random: new DeterministicRandom(1),
    fetchImpl,
    ...(cache ? { cache } : {}),
  });
}

function embedCallsOf(calls: FakeOllamaCall[]): FakeOllamaCall[] {
  return calls.filter((call) => call.path === "api/embed");
}

/**
 * Polls a real 1ms timer until `predicate()` is true, or fails the test
 * after `maxAttempts` polls. Attempt-counted rather than wall-clock-timed
 * (no `Date.now()`, per this repo's `no-restricted-syntax` rule 5).
 */
async function waitUntil(predicate: () => boolean, maxAttempts = 2000): Promise<void> {
  for (let attempt = 0; !predicate(); attempt += 1) {
    if (attempt >= maxAttempts) {
      throw new Error("waitUntil: timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("OllamaEmbeddingProvider — in-flight de-duplication (spec.md §9.4, WP-78)", () => {
  it("two concurrent embedDocuments calls for the same uncached text share a single /api/embed request", async () => {
    const { fetchImpl: baseFetch, calls } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    // 20ms of simulated backend latency on the real embed call — long enough
    // that, on the buggy implementation, both concurrent calls finish
    // reading the (empty) cache before either one writes to it.
    const delayedFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api/embed") && !url.includes("readiness-probe-marker")) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    const provider = makeProvider(delayedFetch);
    const text = "search_document: shared text raced by two callers";

    // Warm up readiness first so its own probe embed call doesn't get
    // counted alongside the two calls under test.
    await provider.ensureReady();
    calls.length = 0;

    const [a, b] = await Promise.all([
      provider.embedDocuments([text]),
      provider.embedDocuments([text]),
    ]);

    const embedCalls = embedCallsOf(calls);
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]?.body?.["input"]).toEqual([text]);
    expect(a.vectors[0]).toEqual(b.vectors[0]);
    expect(a.truncated).toEqual([false]);
    expect(b.truncated).toEqual([false]);
  });

  it("dedupes identical prepared texts within one batch and returns vectors in the exact input order", async () => {
    const { fetchImpl, calls } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    const provider = makeProvider(fetchImpl, { batchSize: 10 });
    await provider.ensureReady();
    calls.length = 0;

    const result = await provider.embedDocuments([
      "dup text",
      "dup text",
      "dup text",
      "unique text",
    ]);

    const embedCalls = embedCallsOf(calls);
    expect(embedCalls).toHaveLength(1);
    // Only ONE occurrence of "dup text" must reach the wire, alongside "unique text".
    expect(embedCalls[0]?.body?.["input"]).toEqual(["dup text", "unique text"]);

    // Output must line up exactly with input order/length, duplicates included.
    expect(result.vectors).toHaveLength(4);
    expect(result.vectors[0]).toEqual(result.vectors[1]);
    expect(result.vectors[1]).toEqual(result.vectors[2]);
    expect(result.vectors[2]).not.toEqual(result.vectors[3]);
  });

  it("releases the in-flight slot on failure so the next call retries fresh instead of reusing a broken promise", async () => {
    const { fetchImpl: baseFetch, calls } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    let failNextEmbed = false;
    let embedAttempts = 0;
    // Fails BEFORE reaching `baseFetch` (like a real transport error would),
    // so this counts attempts independently of `calls`, which only records
    // requests `baseFetch` actually served.
    const flakyFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api/embed")) {
        embedAttempts += 1;
        if (failNextEmbed) {
          return new Response("boom", { status: 500 });
        }
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    // maxRetries: 0 so the first (failing) attempt surfaces immediately.
    const provider = makeProvider(flakyFetch, { maxRetries: 0 });
    await provider.ensureReady();
    calls.length = 0;
    embedAttempts = 0;

    failNextEmbed = true;
    const error = await provider.embedDocuments(["hello"]).catch((e: unknown) => e);
    expect(isUntangleError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("EMBEDDING_UNAVAILABLE");
    expect(embedAttempts).toBe(1);
    expect(embedCallsOf(calls)).toHaveLength(0); // the failing attempt never reached the real fake

    // The key must have been freed by the failed attempt: a follow-up call
    // for the SAME text must try again over the wire, not hang forever on
    // (or silently resolve to) the earlier broken attempt.
    failNextEmbed = false;
    const result = await provider.embedDocuments(["hello"]);
    expect(result.vectors[0]).toHaveLength(8);
    expect(embedAttempts).toBe(2);
    expect(embedCallsOf(calls)).toHaveLength(1);
  });

  it("one waiter's AbortSignal firing rejects only that call, not the shared fetch other waiters are joined on", async () => {
    const { fetchImpl: baseFetch, calls } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    let gateActive = false;
    let releaseEmbed: (() => void) | undefined;
    const gatedFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api/embed") && gateActive) {
        await new Promise<void>((resolve) => {
          releaseEmbed = resolve;
        });
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    const provider = makeProvider(gatedFetch, { batchSize: 10, maxConnections: 4 });
    await provider.ensureReady();
    calls.length = 0;
    gateActive = true;

    const text = "search_document: text two waiters race for, one of them cancels";
    const controllerA = new AbortController();

    const callA = provider.embedDocuments([text], { signal: controllerA.signal });
    // Let callA's request actually reach the gate (i.e. claim the in-flight
    // slot and start the real HTTP call) before callB joins it.
    await waitUntil(() => releaseEmbed !== undefined);

    const callB = provider.embedDocuments([text]);

    // Cancel the FIRST waiter while the shared request is still gated.
    controllerA.abort();
    const errorA = await callA.catch((e: unknown) => e);
    expect(isUntangleError(errorA)).toBe(true);
    expect((errorA as { code: string }).code).toBe("JOB_CANCELLED");

    // The shared fetch must still be running for callB — release the gate now.
    releaseEmbed?.();
    const resultB = await callB;
    expect(resultB.vectors[0]).toHaveLength(8);

    // Exactly one /api/embed request total: callB joined callA's fetch
    // rather than starting a second one after callA's own signal fired.
    expect(embedCallsOf(calls)).toHaveLength(1);
  });
});

/**
 * Regressionstests für WP-117: das Doppel-Embedding-Fenster bei einem spät
 * auflösenden Cache.
 *
 * `embedSlice` trifft die Miss-/Join-Entscheidung EINMAL, aus einem einzigen
 * `Promise.all` über `cache.get()`. Löst dieses `get()` erst auf, nachdem ein
 * anderer Aufrufer denselben Text fertig eingebettet, geschrieben und seinen
 * In-flight-Platz wieder freigegeben hat, findet der zweite Aufrufer weder
 * Cache-Treffer noch In-flight-Eintrag — und bettet ein zweites Mal ein. Das
 * ist kein exotischer Fall: jeder netzgebundene oder plattengebundene Cache
 * verhält sich so, und genau das ist der vorgesehene Erweiterungspunkt für
 * einen persistenten Adapter.
 */
describe("OllamaEmbeddingProvider — spät auflösender Cache (WP-117)", () => {
  it("zwei nebenläufige Aufrufer erzeugen genau EINEN /api/embed-Aufruf, auch wenn cache.get() erst nach dem Ende des ersten Aufrufs auflöst", async () => {
    const { fetchImpl, calls } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    const cache = new GatedLateEmbeddingCache();
    const provider = makeProvider(fetchImpl, {}, cache);
    await provider.ensureReady();
    calls.length = 0;

    const text = "search_document: derselbe Text, zwei nebenläufige Aufrufer";

    // Beide Aufrufer stellen ihre Cache-Lesung, solange der Cache leer ist:
    // beide Momentaufnahmen sind ein Miss.
    const callA = provider.embedDocuments([text]);
    await waitUntil(() => cache.pending.length === 1);
    const callB = provider.embedDocuments([text]);
    await waitUntil(() => cache.pending.length === 2);

    // B's Lesung wird festgehalten; alle weiteren Lesungen laufen normal.
    const releaseB = cache.detachAt(1);
    cache.autoRelease = true;

    // A läuft vollständig durch: Fetch, cache.set, Auflösen des Deferreds und
    // damit Freigabe des In-flight-Platzes.
    cache.releaseNext();
    const resultA = await callA;

    // Erst JETZT liefert B's Lesung ihren veralteten Miss aus.
    releaseB();
    const resultB = await callB;

    expect(embedCallsOf(calls)).toHaveLength(1);
    expect(resultB.vectors[0]).toEqual(resultA.vectors[0]);
    expect(resultB.truncated).toEqual([false]);
    // Auch geschrieben wird nur einmal — B übernimmt A's Eintrag.
    expect(cache.sets).toBe(1);
  });

  it("bettet weiterhin ein, wenn auch die zweite Prüfung einen Miss liefert — kein Deadlock, keine Wiederholungsschleife", async () => {
    const { fetchImpl, calls } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    // Cache, der nie etwas behält: die zweite Prüfung sieht denselben Miss.
    // Ein Fix, der auf einen Treffer WARTET statt ihn nur zu prüfen, würde
    // hier hängen bleiben; einer, der erneut prüft, bis er trifft, würde
    // endlos drehen.
    const nullCache: EmbeddingCachePort = {
      get: async () => null,
      set: async () => undefined,
    };
    const provider = makeProvider(fetchImpl, {}, nullCache);
    await provider.ensureReady();
    calls.length = 0;

    const first = await provider.embedDocuments(["kein Cache behält mich"]);
    expect(first.vectors[0]).toHaveLength(8);
    expect(embedCallsOf(calls)).toHaveLength(1);

    // Und ein zweiter Aufruf muss ebenfalls durchkommen (nicht auf einem
    // toten In-flight-Eintrag hängen bleiben).
    const second = await provider.embedDocuments(["kein Cache behält mich"]);
    expect(second.vectors[0]).toEqual(first.vectors[0]);
    expect(embedCallsOf(calls)).toHaveLength(2);
  });

  it("reicht einen Fehlschlag der zweiten Cache-Prüfung sichtbar nach oben und gibt den In-flight-Platz frei (E4)", async () => {
    const { fetchImpl, calls } = createFakeOllamaFetch({
      dimensions: 8,
      models: ["test-embed-model:latest"],
    });
    const cache = new GatedLateEmbeddingCache();
    cache.autoRelease = true;
    const provider = makeProvider(fetchImpl, {}, cache);
    await provider.ensureReady();
    calls.length = 0;

    // Lesung 1 ist die Entscheidungslesung, Lesung 2 die Revalidierung.
    cache.failGetAtCall = 2;
    const error = await provider
      .embedDocuments(["cache fällt bei der Revalidierung aus"])
      .catch((e: unknown) => e);
    expect(isUntangleError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("EMBEDDING_UNAVAILABLE");
    // Der Fehlschlag wird nicht verschluckt: es wurde nichts eingebettet.
    expect(embedCallsOf(calls)).toHaveLength(0);

    // Der Platz ist frei — der nächste Aufruf versucht es neu.
    const retry = await provider.embedDocuments(["cache fällt bei der Revalidierung aus"]);
    expect(retry.vectors[0]).toHaveLength(8);
    expect(embedCallsOf(calls)).toHaveLength(1);
  });
});
