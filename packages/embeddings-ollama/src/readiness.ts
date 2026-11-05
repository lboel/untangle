/**
 * Readiness sequence (spec.md §9.1), run exactly in the spec's order:
 *
 * 1. determine the effective endpoint;
 * 2. check reachability;
 * 3. check model availability;
 * 4. pull the model in managed mode if needed;
 * 5. produce a probe embedding;
 * 6. validate the vector dimension;
 * 7. cache profile and probe timestamp (done by the caller, `provider.ts`,
 *    which owns the cached `EmbeddingReadinessV1`).
 */
import type { Clock, EmbeddingReadinessV1, Random } from "@untangle-code/domain";
import { configInvalidError, embeddingUnavailableError } from "@untangle-code/observability";

import type { BackoffConfig } from "./backoff.js";
import { withRetry } from "./backoff.js";
import { redactEndpointUrl } from "./endpoint.js";
import { isRequestCancellation, OllamaHttpError, type OllamaHttpClient } from "./http.js";
import {
  embed,
  listTags,
  pullModel,
  tagsContainModel,
  type OllamaTagsResponseV1,
} from "./ollama-api.js";
import type { SleepFn, OllamaEmbeddingProviderConfig } from "./types.js";
import { DEFAULT_MANAGED_URL, DEFAULT_NATIVE_PROBE_URL } from "./types.js";
import { assertVectorDimension } from "./validation.js";

export const READINESS_PROBE_TEXT = "untangle embedding readiness probe";

export interface ReadinessDeps {
  httpClient: OllamaHttpClient;
  clock: Clock;
  random: Random;
  sleep: SleepFn;
  backoffConfig: BackoffConfig;
}

export interface ReadinessOutcome {
  readiness: EmbeddingReadinessV1;
  /** The resolved, non-redacted endpoint — used internally for subsequent embed calls. */
  endpointUrl: string;
}

function isRetryableOllamaError(error: unknown): boolean {
  return error instanceof OllamaHttpError && error.retryable;
}

async function requestWithRetry<T>(
  fn: () => Promise<T>,
  deps: ReadinessDeps,
  signal?: AbortSignal,
): Promise<T> {
  return withRetry(
    fn,
    deps.backoffConfig,
    { random: deps.random, sleep: deps.sleep },
    {
      signal,
      isRetryable: isRetryableOllamaError,
    },
  );
}

/** `GET /api/tags`, treating any failure as "not reachable" — EXCEPT cancellation, which propagates. */
async function tryListTags(
  url: string,
  deps: ReadinessDeps,
  signal?: AbortSignal,
): Promise<OllamaTagsResponseV1 | null> {
  try {
    return await requestWithRetry(() => listTags(deps.httpClient, url, signal), deps, signal);
  } catch (error) {
    if (isRequestCancellation(error, signal)) {
      throw error;
    }
    return null;
  }
}

async function checkReachable(
  url: string,
  deps: ReadinessDeps,
  signal?: AbortSignal,
): Promise<OllamaTagsResponseV1> {
  const tags = await tryListTags(url, deps, signal);
  if (!tags) {
    throw embeddingUnavailableError(`Ollama endpoint ${redactEndpointUrl(url)} is not reachable.`, {
      retryable: true,
      context: { endpoint: redactEndpointUrl(url) },
    });
  }
  return tags;
}

interface ResolvedEndpoint {
  url: string;
  /** Whether this endpoint is one Untangle manages (spec.md §3.1) — safe to auto-pull models on it. */
  managed: boolean;
  tags: OllamaTagsResponseV1;
}

/** spec.md §9.1 steps 1-2: determine the effective endpoint and confirm it is reachable. */
async function resolveEndpoint(
  config: OllamaEmbeddingProviderConfig,
  deps: ReadinessDeps,
  signal?: AbortSignal,
): Promise<ResolvedEndpoint> {
  if (config.mode === "external") {
    if (!config.url) {
      throw configInvalidError(
        'EmbeddingConfig.url is required when embeddings.mode is "external" (spec.md §4.5).',
        { retryable: false },
      );
    }
    return {
      url: config.url,
      managed: false,
      tags: await checkReachable(config.url, deps, signal),
    };
  }
  if (config.mode === "managed") {
    const url = config.url ?? config.managedUrl ?? DEFAULT_MANAGED_URL;
    return { url, managed: true, tags: await checkReachable(url, deps, signal) };
  }
  // "auto" (spec.md §3.1): native probe first, managed endpoint as fallback.
  const nativeUrl = config.nativeProbeUrl ?? DEFAULT_NATIVE_PROBE_URL;
  const nativeTags = await tryListTags(nativeUrl, deps, signal);
  if (nativeTags) {
    return { url: nativeUrl, managed: false, tags: nativeTags };
  }
  const managedUrl = config.url ?? config.managedUrl ?? DEFAULT_MANAGED_URL;
  return { url: managedUrl, managed: true, tags: await checkReachable(managedUrl, deps, signal) };
}

export async function runReadinessSequence(
  config: OllamaEmbeddingProviderConfig,
  deps: ReadinessDeps,
  signal?: AbortSignal,
): Promise<ReadinessOutcome> {
  const { url, managed, tags } = await resolveEndpoint(config, deps, signal);
  const modelName = config.profile.model;

  // Step 3: model availability.
  let available = tagsContainModel(tags.models, modelName);

  // Step 4: pull in managed mode if needed (spec.md §3.2 forbids touching an external endpoint).
  if (!available) {
    if (!managed) {
      throw embeddingUnavailableError(
        `Ollama model "${modelName}" is not available at ${redactEndpointUrl(url)}, and this endpoint is not managed by Untangle — pull it manually (spec.md §3.2).`,
        { retryable: false, context: { endpoint: redactEndpointUrl(url), model: modelName } },
      );
    }
    await requestWithRetry(() => pullModel(deps.httpClient, url, modelName, signal), deps, signal);
    const refreshed = await requestWithRetry(
      () => listTags(deps.httpClient, url, signal),
      deps,
      signal,
    );
    available = tagsContainModel(refreshed.models, modelName);
    if (!available) {
      throw embeddingUnavailableError(
        `Ollama model "${modelName}" was still not available after pulling it from ${redactEndpointUrl(url)}.`,
        { retryable: false, context: { endpoint: redactEndpointUrl(url), model: modelName } },
      );
    }
  }

  // Step 5: probe embedding.
  const probeResponse = await requestWithRetry(
    () => embed(deps.httpClient, url, modelName, [READINESS_PROBE_TEXT], signal),
    deps,
    signal,
  );
  const probeVector = probeResponse.embeddings[0];
  if (!probeVector) {
    throw embeddingUnavailableError(
      `Ollama probe embedding returned no vector for model "${modelName}".`,
      { retryable: false, context: { endpoint: redactEndpointUrl(url), model: modelName } },
    );
  }

  // Step 6: dimension validation (must fail BEFORE the first upsert, spec.md §4.8).
  assertVectorDimension(probeVector, config.profile.dimensions, {
    endpoint: redactEndpointUrl(url),
    model: modelName,
    stage: "readiness_probe",
  });

  // Step 7: profile + probe timestamp are cached by the caller from this result.
  return {
    readiness: {
      endpoint: redactEndpointUrl(url),
      model: modelName,
      dimensions: probeVector.length,
      probedAt: deps.clock.nowIso(),
    },
    endpointUrl: url,
  };
}
