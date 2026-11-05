/**
 * Typed slice of the Ollama HTTP API this adapter uses: `/api/tags` (model
 * listing / reachability probe), `/api/pull` (managed-mode model fetch) and
 * `/api/embed` (batch embedding). Shapes are the subset of each response
 * this adapter reads — Ollama's actual responses carry more fields.
 */
import type { OllamaHttpClient } from "./http.js";

export interface OllamaTagV1 {
  name: string;
  model?: string;
}

export interface OllamaTagsResponseV1 {
  models: OllamaTagV1[];
}

export interface OllamaPullResponseV1 {
  status: string;
}

export interface OllamaEmbedResponseV1 {
  model: string;
  embeddings: number[][];
}

/** `GET /api/tags` — used both as the reachability probe and the model-availability check. */
export async function listTags(
  client: OllamaHttpClient,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<OllamaTagsResponseV1> {
  return client.requestJson<OllamaTagsResponseV1>(baseUrl, "api/tags", { method: "GET" }, signal);
}

/**
 * True when `modelTags` (as returned by {@link listTags}) contains
 * `modelName`. Ollama tag names carry an implicit `:latest` suffix when the
 * configured model name has none, so `"nomic-embed-text"` must match a tag
 * named `"nomic-embed-text:latest"`.
 */
export function tagsContainModel(modelTags: OllamaTagV1[], modelName: string): boolean {
  const wantsTag = modelName.includes(":");
  return modelTags.some((tag) => {
    const tagName = tag.name;
    if (wantsTag) {
      return tagName === modelName;
    }
    const [tagBase] = tagName.split(":");
    return tagBase === modelName;
  });
}

/**
 * `POST /api/pull` with `stream: false` — Ollama blocks until the pull
 * completes (or fails) and returns a single JSON response, which keeps this
 * call symmetric with every other request this client makes (one request,
 * one JSON response, no NDJSON stream parsing).
 */
export async function pullModel(
  client: OllamaHttpClient,
  baseUrl: string,
  modelName: string,
  signal?: AbortSignal,
): Promise<OllamaPullResponseV1> {
  return client.requestJson<OllamaPullResponseV1>(
    baseUrl,
    "api/pull",
    { method: "POST", body: { model: modelName, stream: false } },
    signal,
  );
}

/**
 * `POST /api/embed`. `truncate: true` keeps Ollama's own truncation active
 * as the last-resort safety net spec.md §9.3 describes; this adapter's own
 * truncation guard (`truncation.ts`) decides the `embedding_truncated`
 * payload flag independently of whether the server actually had to use it.
 */
export async function embed(
  client: OllamaHttpClient,
  baseUrl: string,
  modelName: string,
  input: string[],
  signal?: AbortSignal,
): Promise<OllamaEmbedResponseV1> {
  return client.requestJson<OllamaEmbedResponseV1>(
    baseUrl,
    "api/embed",
    { method: "POST", body: { model: modelName, input, truncate: true } },
    signal,
  );
}
