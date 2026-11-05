/**
 * Thin REST client over {@link QdrantTransport}: bounded retries for
 * retryable failures plus uniform response interpretation.
 *
 * Interpretation rules (architecture.md §22.2, spec.md §25.2):
 * - HTTP 404 is the ONLY signal for "collection missing" and is exposed via
 *   {@link isCollectionMissing}; transport-level timeouts/network failures
 *   arrive as THROWN `QDRANT_UNAVAILABLE` errors and therefore can never be
 *   mistaken for a missing collection;
 * - any other non-2xx response becomes `QDRANT_UNAVAILABLE` carrying the
 *   server's own reason (`status.error` of the Qdrant response body) —
 *   errors are wrapped, never swallowed;
 * - `JOB_CANCELLED` is never retried.
 */
import type { PortCallOptions } from "@untangle-code/domain";
import {
  isUntangleError,
  jobCancelledError,
  qdrantUnavailableError,
} from "@untangle-code/observability";

import type { QdrantHttpRequest, QdrantHttpResponse, QdrantTransport } from "./transport.js";

export interface QdrantRestClientOptions {
  /** Extra attempts after the first one for retryable failures. */
  maxRetries: number;
  /** Base delay between attempts; multiplied by the attempt number. */
  retryDelayMs: number;
}

/** True when the response is Qdrant's "collection does not exist" (HTTP 404). */
export function isCollectionMissing(response: QdrantHttpResponse): boolean {
  return response.status === 404;
}

/** Extracts the server-side reason from a Qdrant error response body, if any. */
export function serverReason(response: QdrantHttpResponse): string | undefined {
  if (typeof response.body !== "object" || response.body === null) {
    return undefined;
  }
  const status = (response.body as Record<string, unknown>)["status"];
  if (typeof status === "string") {
    return status === "ok" ? undefined : status;
  }
  if (typeof status === "object" && status !== null) {
    const error = (status as Record<string, unknown>)["error"];
    if (typeof error === "string") {
      return error;
    }
  }
  return undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class QdrantRestClient {
  public constructor(
    private readonly transport: QdrantTransport,
    private readonly options: QdrantRestClientOptions,
  ) {}

  /**
   * Sends `request`, retrying transport-level retryable failures and
   * HTTP 429/5xx responses up to `maxRetries` extra attempts. Returns the
   * final response (including non-2xx ones) for the caller to interpret.
   */
  public async call(
    request: QdrantHttpRequest,
    options?: PortCallOptions,
  ): Promise<QdrantHttpResponse> {
    const attempts = this.options.maxRetries + 1;
    let lastError: unknown;
    let lastResponse: QdrantHttpResponse | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) {
        await this.sleep(this.options.retryDelayMs * (attempt - 1), options?.signal);
      }
      try {
        const response = await this.transport.request(request, options);
        if (!isRetryableStatus(response.status) || attempt === attempts) {
          return response;
        }
        lastResponse = response;
      } catch (error) {
        if (isUntangleError(error) && (error.code === "JOB_CANCELLED" || !error.retryable)) {
          throw error;
        }
        if (attempt === attempts) {
          throw error;
        }
        lastError = error;
      }
    }
    // Exhausted attempts on retryable HTTP statuses.
    if (lastResponse !== undefined) {
      return lastResponse;
    }
    /* c8 ignore next 2 — loop invariant: either returned or threw above */
    throw lastError;
  }

  /**
   * Like {@link call}, but throws `QDRANT_UNAVAILABLE` (with the server's
   * reason) for every non-2xx response — including 404. Use it for calls
   * where "missing" is NOT an expected outcome.
   */
  public async callExpectingOk(
    request: QdrantHttpRequest,
    operation: string,
    options?: PortCallOptions,
  ): Promise<QdrantHttpResponse> {
    const response = await this.call(request, options);
    expectOk(response, operation, request);
    return response;
  }

  private sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(jobCancelledError("Qdrant retry wait was aborted", { operation: "qdrant_retry" }));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/**
 * Throws `QDRANT_UNAVAILABLE` (retryable for 429/5xx) with the server's own
 * reason when `response` is not a 2xx success.
 */
export function expectOk(
  response: QdrantHttpResponse,
  operation: string,
  request: QdrantHttpRequest,
): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }
  const reason = serverReason(response);
  throw qdrantUnavailableError(
    `Qdrant "${operation}" (${request.method} ${request.path}) failed with HTTP ` +
      `${response.status}${reason === undefined ? "" : `: ${reason}`}`,
    {
      retryable: isRetryableStatus(response.status),
      operation,
      context: {
        path: request.path,
        httpStatus: response.status,
        ...(reason === undefined ? {} : { serverReason: reason }),
      },
    },
  );
}

/** Extracts `body.result` of a successful Qdrant response. */
export function resultOf(response: QdrantHttpResponse): unknown {
  if (typeof response.body !== "object" || response.body === null) {
    return undefined;
  }
  return (response.body as Record<string, unknown>)["result"];
}
