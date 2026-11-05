/**
 * HTTP transport boundary of the Qdrant adapter.
 *
 * Every store in this package talks to Qdrant exclusively through
 * {@link QdrantTransport}, so unit tests can substitute a fake REST server
 * (`src/testing/fake-qdrant-server.ts`) without any network, while
 * {@link FetchQdrantTransport} is the production implementation over
 * `fetch`.
 *
 * Error discipline (architecture.md §22.2, spec.md §25.2):
 * - a NETWORK failure or TIMEOUT is thrown as `UntangleError` with code
 *   `QDRANT_UNAVAILABLE` and `retryable: true` — it is structurally
 *   impossible to confuse it with a "collection missing" HTTP 404, because
 *   404 arrives as a RESPONSE (`status: 404`), never as a throw;
 * - an abort of the CALLER's signal is thrown as `JOB_CANCELLED`, never as
 *   `QDRANT_UNAVAILABLE`.
 */
import type { PortCallOptions } from "@untangle-code/domain";
import { jobCancelledError, qdrantUnavailableError } from "@untangle-code/observability";

/** One Qdrant REST request. `path` starts with "/" and may carry a query string. */
export interface QdrantHttpRequest {
  method: "GET" | "PUT" | "POST" | "DELETE";
  path: string;
  body?: unknown;
}

/** A Qdrant REST response: HTTP status plus the parsed JSON body (if any). */
export interface QdrantHttpResponse {
  status: number;
  body: unknown;
}

/**
 * Transport port of this adapter. Implementations RETURN every HTTP response
 * (including 4xx/5xx) and THROW only for network failures, timeouts
 * (`QDRANT_UNAVAILABLE`, retryable) and caller aborts (`JOB_CANCELLED`).
 */
export interface QdrantTransport {
  request(request: QdrantHttpRequest, options?: PortCallOptions): Promise<QdrantHttpResponse>;
}

export interface FetchQdrantTransportOptions {
  /** Base URL of the Qdrant instance, e.g. "http://127.0.0.1:6333". */
  url: string;
  /** Resolved API key value (config carries only the env var NAME). */
  apiKey?: string;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
}

/** Production transport over global `fetch`. */
export class FetchQdrantTransport implements QdrantTransport {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly requestTimeoutMs: number;

  public constructor(options: FetchQdrantTransportOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  public async request(
    request: QdrantHttpRequest,
    options?: PortCallOptions,
  ): Promise<QdrantHttpResponse> {
    const callerSignal = options?.signal;
    if (callerSignal?.aborted) {
      throw jobCancelledError(`Qdrant request "${request.method} ${request.path}" was aborted`, {
        operation: "qdrant_request",
      });
    }
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey !== undefined) {
      headers["api-key"] = this.apiKey;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${request.path}`, {
        method: request.method,
        headers,
        signal,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
    } catch (cause) {
      // Caller cancellation always wins over the timeout classification.
      if (callerSignal?.aborted) {
        throw jobCancelledError(`Qdrant request "${request.method} ${request.path}" was aborted`, {
          operation: "qdrant_request",
          cause,
        });
      }
      if (timeoutSignal.aborted) {
        // A timeout is a TIMEOUT — never "collection missing"
        // (architecture.md §22.2).
        throw qdrantUnavailableError(
          `Qdrant request "${request.method} ${request.path}" timed out after ` +
            `${this.requestTimeoutMs}ms`,
          {
            retryable: true,
            operation: "qdrant_request",
            context: { path: request.path, timeoutMs: this.requestTimeoutMs },
            cause,
          },
        );
      }
      throw qdrantUnavailableError(
        `Qdrant request "${request.method} ${request.path}" failed: ${describeCause(cause)}`,
        {
          retryable: true,
          operation: "qdrant_request",
          context: { path: request.path },
          cause,
        },
      );
    }

    let body: unknown;
    try {
      const text = await response.text();
      body = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const nested = cause.cause;
    if (nested instanceof Error && nested.message.length > 0) {
      return `${cause.message} (${nested.message})`;
    }
    return cause.message;
  }
  return String(cause);
}
