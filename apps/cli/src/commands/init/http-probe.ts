/**
 * The Node implementation of `HttpProbePort`.
 *
 * Kept in its own module so every other file of the command stays testable
 * without a network. It is GET-only and it swallows nothing: a failure
 * becomes `null`, which the callers treat as the ANSWER "not there" — and
 * every such answer ends up visible in the written file (Befund 3), never as
 * a silently missing section.
 */

import type { EmbedProbeResult, HttpProbePort } from "./types.js";

/** Ceiling on a probe response, so an endpoint that is not what we think it is cannot flood memory. */
const MAX_PROBE_BYTES = 1024 * 1024;

/**
 * The text sent to `/api/embed`. Fixed and tiny on purpose: the probe is a
 * question about the ENDPOINT, not about the model's quality, and a short
 * input keeps it cheap on somebody else's machine.
 */
export const EMBED_PROBE_TEXT = "untangle probe";

export function nodeHttpProbe(): HttpProbePort {
  return {
    /**
     * The one POST (WP-228). It embeds {@link EMBED_PROBE_TEXT} and reports
     * the vector width — or that the endpoint did not answer within the
     * deadline. It never throws: not answering is the answer.
     */
    async probeEmbedding(
      baseUrl: string,
      model: string,
      timeoutMs: number,
    ): Promise<EmbedProbeResult> {
      const url = `${baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl}/api/embed`;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ model, input: [EMBED_PROBE_TEXT] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          return {
            ok: false,
            timedOut: false,
            detail: `HTTP ${String(response.status)} from /api/embed`,
          };
        }
        const text = await readCapped(response, MAX_PROBE_BYTES);
        if (text === null) {
          return { ok: false, timedOut: false, detail: "Unreadable /api/embed response" };
        }
        const dimensions = readProbeDimensions(text);
        return dimensions === undefined
          ? { ok: false, timedOut: false, detail: "/api/embed returned no vector" }
          : { ok: true, dimensions };
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        return {
          ok: false,
          timedOut,
          detail: timedOut
            ? "/api/embed did not respond within the deadline"
            : `/api/embed is unreachable: ${error instanceof Error ? error.name : "unknown"}`,
        };
      }
    },

    async getJson(url: string, timeoutMs: number): Promise<unknown | null> {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          return null;
        }
        const text = await readCapped(response, MAX_PROBE_BYTES);
        if (text === null) {
          return null;
        }
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    },
  };
}

async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  const body = response.body;
  if (body === null) {
    return null;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * The vector width from an `/api/embed` response, or `undefined` when the
 * body is not one. Parsed here rather than in `services.ts` so the network
 * shape stays in the module that speaks to the network.
 */
export function readProbeDimensions(bodyText: string): number | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;
  const embeddings = (payload as { embeddings?: unknown }).embeddings;
  if (!Array.isArray(embeddings)) return undefined;
  const first = embeddings[0];
  if (!Array.isArray(first) || first.length === 0) return undefined;
  return first.length;
}

/** A probe that answers nothing — for `--offline` and for tests. */
export function offlineProbe(): HttpProbePort {
  return {
    getJson(): Promise<unknown | null> {
      return Promise.resolve(null);
    },
    probeEmbedding(): Promise<EmbedProbeResult> {
      return Promise.resolve({
        ok: false,
        timedOut: false,
        detail: "not checked (--offline)",
      });
    },
  };
}
