/**
 * Shared test-only helpers: a fake Ollama HTTP transport (`typeof fetch`
 * compatible) and a recording `SleepFn`. Not part of the public API — only
 * imported by this package's own co-located tests, same convention as
 * `@untangle-code/chunker`'s `test-helpers.ts`.
 */
import { embedTextDeterministically } from "@untangle-code/testkit";

import type {
  EmbeddingCacheEntry,
  EmbeddingCacheKey,
  EmbeddingCachePort,
  OllamaEmbeddingProviderConfig,
} from "./types.js";

export interface FakeOllamaCall {
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

type FailablePath = "api/tags" | "api/pull" | "api/embed";

export interface FakeOllamaOptions {
  dimensions: number;
  /** Already-installed model tags, e.g. `["nomic-embed-text:latest"]`. */
  models?: string[];
  /** When `false`, every request rejects like a refused connection. */
  reachable?: boolean;
  /** Whether `/api/pull` actually installs the model into `models` (default `true`). */
  pullInstallsModel?: boolean;
  /** Number of times each path should answer with a transient failure before succeeding. */
  transientFailures?: Partial<Record<FailablePath, number>>;
  /** HTTP status used for injected transient failures (default 503). */
  transientStatus?: number;
  /** Override the vectors returned for one `/api/embed` call by its 0-based call index. */
  embedOverride?: (texts: string[], callIndex: number) => number[][] | undefined;
}

export interface FakeOllama {
  fetchImpl: typeof fetch;
  calls: FakeOllamaCall[];
  models: Set<string>;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installedTagFor(modelName: string): string {
  return modelName.includes(":") ? modelName : `${modelName}:latest`;
}

/** Builds a fake Ollama server implementing just enough of `/api/tags`, `/api/pull` and `/api/embed`. */
export function createFakeOllamaFetch(options: FakeOllamaOptions): FakeOllama {
  const calls: FakeOllamaCall[] = [];
  const models = new Set(options.models ?? []);
  const remaining: Partial<Record<FailablePath, number>> = { ...options.transientFailures };
  let embedCallIndex = 0;

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/^\//, "");
    const method = (init?.method ?? "GET") as string;
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ path, method, body });

    if (options.reachable === false) {
      throw new TypeError("fetch failed: connection refused");
    }

    const remainingForPath = remaining[path as FailablePath];
    if (remainingForPath !== undefined && remainingForPath > 0) {
      remaining[path as FailablePath] = remainingForPath - 1;
      return new Response("injected transient failure", { status: options.transientStatus ?? 503 });
    }

    if (path === "api/tags" && method === "GET") {
      return jsonResponse({ models: Array.from(models, (name) => ({ name })) });
    }

    if (path === "api/pull" && method === "POST") {
      const modelName = String(body?.["model"]);
      if (options.pullInstallsModel !== false) {
        models.add(installedTagFor(modelName));
      }
      return jsonResponse({ status: "success" });
    }

    if (path === "api/embed" && method === "POST") {
      const texts = (body?.["input"] as string[] | undefined) ?? [];
      const callIndex = embedCallIndex;
      embedCallIndex += 1;
      const vectors =
        options.embedOverride?.(texts, callIndex) ??
        texts.map((text) => embedTextDeterministically(text, options.dimensions));
      return jsonResponse({ model: String(body?.["model"]), embeddings: vectors });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return { fetchImpl, calls, models };
}

/** Recording `SleepFn`: resolves immediately (no real wait) but remembers every requested delay. */
export function createRecordingSleep(): {
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number, signal?: AbortSignal): Promise<void> => {
      signal?.throwIfAborted();
      delays.push(ms);
    },
  };
}

/**
 * A small, fast default profile/config for unit tests.
 *
 * Overrides are spread on top of the defaults (not merged field-by-field
 * with `??`), so `{ url: undefined }` genuinely clears the default url —
 * needed by the "auto" mode tests, which must distinguish "not overridden"
 * from "deliberately absent" to exercise the native/managed fallback.
 */
export function createTestProviderConfig(
  overrides: Partial<OllamaEmbeddingProviderConfig> = {},
): OllamaEmbeddingProviderConfig {
  const { profile: profileOverrides, ...restOverrides } = overrides;
  const base: OllamaEmbeddingProviderConfig = {
    profile: {
      provider: "ollama",
      model: "test-embed-model",
      dimensions: 8,
      queryPrefix: "search_query: ",
      documentPrefix: "search_document: ",
      includePath: true,
      normalization: "none",
      preparedTextVersion: "v1",
    },
    mode: "external",
    url: "http://fake-ollama.test",
    contextLength: 2048,
    batchSize: 2,
    maxConnections: 2,
    requestTimeoutMs: 5000,
    maxRetries: 3,
    baseBackoffMs: 10,
    maxBackoffMs: 100,
  };
  return {
    ...base,
    ...restOverrides,
    profile: { ...base.profile, ...profileOverrides },
  };
}

/**
 * Cache-Fake für WP-117: `get()` liest den Zustand zum AUFRUFZEITPUNKT,
 * löst aber erst auf, wenn der Test die Lesung freigibt.
 *
 * Genau dieses Verhalten hat jeder netzgebundene oder auf die Platte
 * gehende Cache — also der vorgesehene Erweiterungspunkt für einen
 * persistenten Adapter. Anders als eine Zeitverzögerung ist die Freigabe
 * hier deterministisch steuerbar: der Test kann eine Lesung gezielt über
 * das Ende eines anderen Aufrufs hinaus festhalten.
 */
export class GatedLateEmbeddingCache implements EmbeddingCachePort {
  /** Freigabefunktionen der aktuell festgehaltenen `get()`-Aufrufe, in Aufrufreihenfolge. */
  public readonly pending: (() => void)[] = [];
  /** Wenn `true`, löst jede neue Lesung sofort auf (aber weiterhin asynchron). */
  public autoRelease = false;
  /** Wird gesetzt, scheitert die Lesung mit dieser 1-basierten Nummer. */
  public failGetAtCall: number | undefined = undefined;
  /** Fehler, mit dem {@link failGetAtCall} scheitert. */
  public getFailure: Error = new Error("cache backend unreachable");
  public gets = 0;
  public sets = 0;

  private readonly entries = new Map<string, EmbeddingCacheEntry>();

  public async get(key: EmbeddingCacheKey): Promise<EmbeddingCacheEntry | null> {
    this.gets += 1;
    if (this.failGetAtCall === this.gets) {
      throw this.getFailure;
    }
    // Zustand JETZT lesen ...
    const snapshot = this.entries.get(this.keyString(key)) ?? null;
    if (this.autoRelease) {
      await Promise.resolve();
      return snapshot;
    }
    await new Promise<void>((resolve) => {
      this.pending.push(resolve);
    });
    // ... und SPÄTER ausliefern.
    return snapshot;
  }

  public async set(key: EmbeddingCacheKey, entry: EmbeddingCacheEntry): Promise<void> {
    this.sets += 1;
    this.entries.set(this.keyString(key), entry);
  }

  /** Gibt die älteste festgehaltene Lesung frei. */
  public releaseNext(): void {
    const release = this.pending.shift();
    if (!release) {
      throw new Error("GatedLateEmbeddingCache: no held read available");
    }
    release();
  }

  /**
   * Nimmt die Lesung an Position `index` aus der Warteschlange heraus und
   * gibt ihre Freigabefunktion zurück — so bleibt sie festgehalten, während
   * alle anderen Lesungen normal weiterlaufen.
   */
  public detachAt(index: number): () => void {
    const [release] = this.pending.splice(index, 1);
    if (!release) {
      throw new Error(`GatedLateEmbeddingCache: no held read at position ${index}`);
    }
    return release;
  }

  private keyString(key: EmbeddingCacheKey): string {
    return `${key.embeddingProfileId}:${key.preparedTextHash}`;
  }
}
