/**
 * Der HTTP-Weg der Prozessgrenze (extensions.md X4, §5.2 `http`).
 *
 * Manche Werkzeuge laufen als Dienst und werden nicht je Lauf gestartet. Auch
 * dann laeuft KEIN fremder Code bei uns: ausgetauscht werden serialisierte
 * Daten ueber eine Netzgrenze. Die Lizenzargumentation aus `types.ts` gilt
 * unveraendert.
 *
 * Dieselben Budgets wie beim Unterprozess: Zeit ueber `AbortSignal`, Groesse
 * ueber eine harte Byte-Obergrenze beim Lesen des Koerpers. Ein Dienst, der
 * unbegrenzt sendet, darf uns nicht den Speicher fuellen.
 */
import type { Clock } from "@untangle-code/domain";

import type { HttpInvocationV1, HttpResultV1, HttpRunnerPort, ProcessLimitsV1 } from "./types.js";

/** Die Teilmenge von `fetch`, die dieser Runner benutzt. */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{
  status: number;
  body: ReadableStream<Uint8Array> | null;
  text: () => Promise<string>;
}>;

/** Liest einen Antwortkoerper bis zur Byte-Obergrenze. */
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let collected = 0;
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (collected < maxBytes) {
        const remaining = maxBytes - collected;
        const slice = value.length <= remaining ? value : value.subarray(0, remaining);
        chunks.push(slice);
        collected += slice.length;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(collected);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    text: new TextDecoder().decode(merged),
    bytes: total,
    truncated: total > collected,
  };
}

/**
 * HTTP-Runner ueber ein eingespritztes `fetch`.
 *
 * `fetch` wird bewusst hereingereicht statt global benutzt: Unit-Tests laufen
 * ohne Netz (extensions.md §13), und ein Fake ist so ein Einzeiler.
 */
export function createFetchHttpRunner(fetchImpl: FetchLike, clock: Clock): HttpRunnerPort {
  return {
    async request(
      invocation: HttpInvocationV1,
      limits: ProcessLimitsV1,
      options: { signal?: AbortSignal } = {},
    ): Promise<HttpResultV1> {
      const startedAt = clock.nowEpochMs();
      const controller = new AbortController();
      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, limits.timeoutMs);
      timeoutTimer.unref?.();
      const onAbort = (): void => {
        controller.abort();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const response = await fetchImpl(invocation.url, {
          method: invocation.method ?? "GET",
          headers: { ...invocation.headers },
          ...(invocation.body === undefined ? {} : { body: invocation.body }),
          signal: controller.signal,
        });
        let read: { text: string; bytes: number; truncated: boolean };
        if (response.body === null) {
          const text = await response.text();
          // BYTES, nicht Zeichen: `"ä".length` ist 1, seine UTF-8-Laenge 2.
          // Eine Groessenangabe, die die Ausgabegrenze unterschaetzt, ist
          // genau die stille Ungenauigkeit, die dieses Paket anderswo anprangert.
          const bytes = new TextEncoder().encode(text).length;
          read = { text, bytes, truncated: bytes > limits.maxOutputBytes };
        } else {
          read = await readBounded(response.body, limits.maxOutputBytes);
        }
        return {
          outcome: read.truncated ? "output_limit_exceeded" : "completed",
          status: response.status,
          body: read.text,
          bodyBytes: read.bytes,
          bodyTruncated: read.truncated,
          wallTimeMs: clock.nowEpochMs() - startedAt,
          ...(read.truncated
            ? {
                failureDetail: `response exceeded the limit of ${String(limits.maxOutputBytes)} bytes`,
              }
            : {}),
        };
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        const outcome = timedOut
          ? ("timeout" as const)
          : options.signal?.aborted === true
            ? ("cancelled" as const)
            : ("spawn_failed" as const);
        return {
          outcome,
          status: null,
          body: "",
          bodyBytes: 0,
          bodyTruncated: false,
          wallTimeMs: clock.nowEpochMs() - startedAt,
          failureDetail: timedOut
            ? `time budget of ${String(limits.timeoutMs)} ms exceeded; the request was aborted`
            : detail,
        };
      } finally {
        clearTimeout(timeoutTimer);
        options.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
