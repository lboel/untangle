/**
 * Minimal Ollama HTTP client on Node 22's built-in `fetch` (no HTTP client
 * dependency, per the WP-10 task). Every request carries a timeout and
 * respects an external `AbortSignal`; a bounded semaphore caps concurrently
 * in-flight requests (spec.md §9.2 "Verbindungslimit").
 */
import { joinUrl } from "./endpoint.js";

/** Thrown by {@link OllamaHttpClient.requestJson} for any failed request. */
export class OllamaHttpError extends Error {
  public readonly status: number | undefined;
  public readonly retryable: boolean;

  public constructor(
    message: string,
    options: { status?: number; retryable: boolean; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OllamaHttpError";
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

/** Thrown when a request is aborted by the CALLER's own signal (never retried). */
export class OllamaRequestCancelledError extends Error {
  public constructor(cause?: unknown) {
    super("Ollama request cancelled", cause === undefined ? undefined : { cause });
    this.name = "OllamaRequestCancelledError";
  }
}

/**
 * True for anything that represents the CALLER's own cancellation rather
 * than a transport failure: an {@link OllamaRequestCancelledError}, a raw
 * `AbortError` (e.g. from `backoff.ts`'s own `signal.throwIfAborted()`
 * pre-check, which runs before this client gets a chance to wrap it), or
 * simply `signal.aborted` already being true by the time the error is
 * observed. Used everywhere this adapter must tell "the caller cancelled"
 * apart from "the endpoint is unreachable" (rule 9: cancellation surfaces as
 * `JOB_CANCELLED`, never as a swallowed/misclassified failure).
 */
export function isRequestCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    error instanceof OllamaRequestCancelledError ||
    (error instanceof DOMException && error.name === "AbortError") ||
    signal?.aborted === true
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Counting semaphore bounding concurrent HTTP requests to one Ollama endpoint. */
class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  public constructor(limit: number) {
    this.available = Math.max(1, limit);
  }

  public async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.available -= 1;
    return () => this.release();
  }

  private release(): void {
    this.available += 1;
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }
}

export interface OllamaHttpClientOptions {
  requestTimeoutMs: number;
  maxConnections: number;
  // `| undefined` spelled out because callers (provider.ts) forward an
  // already-optional config/deps field here under exactOptionalPropertyTypes.
  apiKeyEnv?: string | undefined;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch | undefined;
}

export class OllamaHttpClient {
  private readonly semaphore: Semaphore;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly apiKeyEnv: string | undefined;

  public constructor(options: OllamaHttpClientOptions) {
    this.semaphore = new Semaphore(options.maxConnections);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.apiKeyEnv = options.apiKeyEnv;
  }

  /**
   * Sends one JSON request and parses a JSON response. Never retries by
   * itself — callers wrap this in `backoff.ts`'s `withRetry`.
   *
   * Throws {@link OllamaRequestCancelledError} when `signal` (the caller's
   * own signal, not the internal timeout) is the reason for the abort, and
   * {@link OllamaHttpError} for every other failure (network error, timeout,
   * non-2xx status), with `retryable` set per spec.md §9.2's transient/
   * permanent split.
   */
  public async requestJson<T>(
    baseUrl: string,
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      throw new OllamaRequestCancelledError(signal.reason);
    }
    const release = await this.semaphore.acquire();
    try {
      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const headers: Record<string, string> = { "content-type": "application/json" };
      const token = this.apiKeyEnv ? process.env[this.apiKeyEnv] : undefined;
      if (token) {
        headers["authorization"] = `Bearer ${token}`;
      }
      let response: Response;
      try {
        response = await this.fetchImpl(joinUrl(baseUrl, path), {
          method: init.method,
          headers,
          signal: combinedSignal,
          // Conditionally spread rather than `body: undefined` — RequestInit's
          // `body` has no `| undefined` arm, so exactOptionalPropertyTypes
          // forbids assigning it explicitly (a GET request has no body).
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        });
      } catch (error) {
        if (signal?.aborted) {
          throw new OllamaRequestCancelledError(error);
        }
        // Network failure (connection refused, DNS, our own timeout) — transient.
        throw new OllamaHttpError(`Ollama request to ${path} failed: ${String(error)}`, {
          retryable: true,
          cause: error,
        });
      }
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new OllamaHttpError(
          `Ollama request to ${path} returned HTTP ${response.status}: ${bodyText.slice(0, 500)}`,
          { status: response.status, retryable: isRetryableStatus(response.status) },
        );
      }
      const text = await response.text();
      return text.length === 0 ? (undefined as T) : (JSON.parse(text) as T);
    } finally {
      release();
    }
  }
}
