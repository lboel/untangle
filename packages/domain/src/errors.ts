/**
 * Typed error model (spec.md §25.1, portfolio.md §15; architecture.md §22.1).
 *
 * Adapters wrap their infrastructure-specific failures at the boundary into
 * `UntangleError` with one of the shared error codes. Domain and application
 * layers only ever branch on `code`, never on Qdrant-/undici-specific shapes.
 */

/** Error codes from spec.md §25.1. */
export const CORE_ERROR_CODES = [
  "CONFIG_INVALID",
  "WORKSPACE_NOT_FOUND",
  "PATH_OUTSIDE_WORKSPACE",
  "PARSER_UNAVAILABLE",
  "EMBEDDING_UNAVAILABLE",
  "EMBEDDING_DIMENSION_MISMATCH",
  "QDRANT_UNAVAILABLE",
  "QDRANT_SCHEMA_INCOMPATIBLE",
  "INDEX_INCOMPLETE",
  "INDEX_PROFILE_MISMATCH",
  "LOCK_HELD",
  "JOB_CANCELLED",
  "GRAPH_INCOMPLETE",
  "ANALYSIS_INCOMPLETE",
  "POINT_TOO_LARGE",
  "PLUGIN_ENGINE_INCOMPATIBLE",
  "SEARCH_SESSION_NOT_FOUND",
  "SEARCH_SESSION_CONFLICT",
  "SEARCH_SESSION_INVALID_STATE",
] as const;

/** Error codes from portfolio.md §15 (additive to spec.md §25.1). */
export const PORTFOLIO_ERROR_CODES = [
  "PORTFOLIO_INCOMPLETE",
  "PORTFOLIO_GENERATION_MISSING",
  "PORTFOLIO_STALE",
  "MANIFEST_PARSE_FAILED",
  "TECHNOLOGY_UNKNOWN",
  "BLUEPRINT_KIND_UNKNOWN",
  "BLUEPRINT_EVIDENCE_INSUFFICIENT",
  "BLUEPRINT_TARGET_NOT_EMPTY",
  "BLUEPRINT_TARGET_OUTSIDE_ALLOWED",
  "BLUEPRINT_WRITE_FAILED",
  "ENRICHMENT_DISABLED",
  "ENRICHMENT_UNAVAILABLE",
] as const;

/**
 * Error codes from extensions.md §6.8 (additive to spec.md §25.1). Extensions
 * are strictly opt-in (X1) and never required (X2): every code here describes a
 * VISIBLE degradation, never a silent one — a failed extension is reported, the
 * read operation continues (spec.md §25.2).
 */
export const EXTENSION_ERROR_CODES = [
  "EXTENSION_UNAVAILABLE",
  "EXTENSION_FAILED",
  "EXTENSION_LICENSE_UNACKNOWLEDGED",
  "EXTENSION_TIMEOUT",
  "EXTENSION_IMAGE_MISMATCH",
] as const;

/** All error codes as one shared enum (docs/BUILD_PLAN.md §3.3). */
export const ERROR_CODES = [
  ...CORE_ERROR_CODES,
  ...PORTFOLIO_ERROR_CODES,
  ...EXTENSION_ERROR_CODES,
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Type guard: is `value` a known {@link ErrorCode}? */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

export interface UntangleErrorOptions {
  /** Whether a retry of the same operation may reasonably succeed (spec.md §25.2). */
  retryable?: boolean;
  /** Logical operation during which the error occurred, e.g. "index", "search". */
  operation?: string;
  /** Structured, redaction-safe context. Never put secrets or full source text here. */
  context?: Record<string, unknown>;
  /** Underlying cause (adapter-specific error object). */
  cause?: unknown;
}

/**
 * The single typed error class of the Untangle engine (architecture.md §22.1).
 *
 * "Not found" and "infrastructure failure" must never share a code; error
 * responses derived from this class must always expose `retryable`.
 */
export class UntangleError extends Error {
  public readonly code: ErrorCode;
  public readonly retryable: boolean;
  public readonly operation: string | undefined;
  public readonly context: Record<string, unknown>;

  public constructor(code: ErrorCode, message: string, options: UntangleErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "UntangleError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.operation = options.operation;
    this.context = options.context ?? {};
  }

  /** Serializes into the error shape of `ToolResponseEnvelopeV1` (spec.md §21.2). */
  public toEnvelopeError(): {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  } {
    if (Object.keys(this.context).length === 0) {
      return { code: this.code, message: this.message, retryable: this.retryable };
    }
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.context,
    };
  }
}

/** Type guard for {@link UntangleError}. */
export function isUntangleError(value: unknown): value is UntangleError {
  return value instanceof UntangleError;
}
