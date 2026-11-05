/**
 * Typed error helpers on top of `@untangle-code/domain`'s `UntangleError`
 * (architecture.md §22.1, spec.md §25.1, portfolio.md §15).
 *
 * `UntangleError`, `ErrorCode`, `ERROR_CODES` and `isUntangleError` are
 * already fully defined in domain (BUILD_PLAN §3 contract register) — this
 * module does not redefine them, only adds:
 *
 * - one factory function per error class (`ERROR_FACTORIES`, plus a named
 *   export per code for ergonomic call sites), and
 * - `toErrorEnvelope()`, which turns *any* thrown value into the `error`
 *   field shape of `ToolResponseEnvelopeV1` (spec.md §21.2), including
 *   values that are not `UntangleError` at all (adapter throws, programmer
 *   errors) so that MCP/CLI response building never has to branch on the
 *   error's runtime type itself.
 */
import {
  ERROR_CODES,
  UntangleError,
  isUntangleError,
  type ErrorCode,
  type ToolResponseEnvelopeV1,
  type UntangleErrorOptions,
} from "@untangle-code/domain";

export {
  ERROR_CODES,
  CORE_ERROR_CODES,
  PORTFOLIO_ERROR_CODES,
  isErrorCode,
  isUntangleError,
  UntangleError,
} from "@untangle-code/domain";
export type { ErrorCode, UntangleErrorOptions } from "@untangle-code/domain";

/** Envelope `error` field shape (spec.md §21.2), derived from domain's envelope type. */
export type EnvelopeErrorV1 = NonNullable<ToolResponseEnvelopeV1<unknown>["error"]>;

/** Code used for `toErrorEnvelope()` when the input is not an `UntangleError`. */
export const UNKNOWN_ERROR_CODE = "UNKNOWN_ERROR";

export type ErrorFactory = (message: string, options?: UntangleErrorOptions) => UntangleError;

function factory(code: ErrorCode): ErrorFactory {
  return (message: string, options?: UntangleErrorOptions): UntangleError =>
    new UntangleError(code, message, options);
}

/**
 * One factory per {@link ErrorCode} (spec.md §25.1 ∪ portfolio.md §15).
 *
 * Built from `ERROR_CODES` itself so this map can never drift out of sync
 * with domain's code list — see `errors.test.ts` for the completeness check.
 */
export const ERROR_FACTORIES: Readonly<Record<ErrorCode, ErrorFactory>> = Object.freeze(
  Object.fromEntries(ERROR_CODES.map((code) => [code, factory(code)])) as Record<
    ErrorCode,
    ErrorFactory
  >,
);

// Named convenience exports — one per error class (spec.md §25.1).
export const configInvalidError = ERROR_FACTORIES.CONFIG_INVALID;
export const workspaceNotFoundError = ERROR_FACTORIES.WORKSPACE_NOT_FOUND;
export const pathOutsideWorkspaceError = ERROR_FACTORIES.PATH_OUTSIDE_WORKSPACE;
export const parserUnavailableError = ERROR_FACTORIES.PARSER_UNAVAILABLE;
export const embeddingUnavailableError = ERROR_FACTORIES.EMBEDDING_UNAVAILABLE;
export const embeddingDimensionMismatchError = ERROR_FACTORIES.EMBEDDING_DIMENSION_MISMATCH;
export const qdrantUnavailableError = ERROR_FACTORIES.QDRANT_UNAVAILABLE;
export const qdrantSchemaIncompatibleError = ERROR_FACTORIES.QDRANT_SCHEMA_INCOMPATIBLE;
export const indexIncompleteError = ERROR_FACTORIES.INDEX_INCOMPLETE;
export const indexProfileMismatchError = ERROR_FACTORIES.INDEX_PROFILE_MISMATCH;
export const lockHeldError = ERROR_FACTORIES.LOCK_HELD;
export const jobCancelledError = ERROR_FACTORIES.JOB_CANCELLED;
export const graphIncompleteError = ERROR_FACTORIES.GRAPH_INCOMPLETE;
export const analysisIncompleteError = ERROR_FACTORIES.ANALYSIS_INCOMPLETE;
export const pointTooLargeError = ERROR_FACTORIES.POINT_TOO_LARGE;
export const pluginEngineIncompatibleError = ERROR_FACTORIES.PLUGIN_ENGINE_INCOMPATIBLE;

// Named convenience exports — one per error class (portfolio.md §15).
export const portfolioIncompleteError = ERROR_FACTORIES.PORTFOLIO_INCOMPLETE;
export const portfolioGenerationMissingError = ERROR_FACTORIES.PORTFOLIO_GENERATION_MISSING;
export const portfolioStaleError = ERROR_FACTORIES.PORTFOLIO_STALE;
export const manifestParseFailedError = ERROR_FACTORIES.MANIFEST_PARSE_FAILED;
export const technologyUnknownError = ERROR_FACTORIES.TECHNOLOGY_UNKNOWN;
export const blueprintKindUnknownError = ERROR_FACTORIES.BLUEPRINT_KIND_UNKNOWN;
export const blueprintEvidenceInsufficientError = ERROR_FACTORIES.BLUEPRINT_EVIDENCE_INSUFFICIENT;
export const blueprintTargetNotEmptyError = ERROR_FACTORIES.BLUEPRINT_TARGET_NOT_EMPTY;
export const blueprintTargetOutsideAllowedError = ERROR_FACTORIES.BLUEPRINT_TARGET_OUTSIDE_ALLOWED;
export const blueprintWriteFailedError = ERROR_FACTORIES.BLUEPRINT_WRITE_FAILED;
export const enrichmentDisabledError = ERROR_FACTORIES.ENRICHMENT_DISABLED;
export const enrichmentUnavailableError = ERROR_FACTORIES.ENRICHMENT_UNAVAILABLE;

/**
 * Turns any thrown value into the `error` field of `ToolResponseEnvelopeV1`
 * (spec.md §21.2).
 *
 * - An `UntangleError` round-trips through its own `toEnvelopeError()`.
 * - A plain `Error` (adapter throw, programmer error) is mapped to
 *   {@link UNKNOWN_ERROR_CODE} with `retryable: false` — never silently
 *   promoted to a known {@link ErrorCode}, since "not found" and
 *   "infrastructure failure" must never be conflated (spec.md §25.2).
 * - Any other thrown value is stringified the same way.
 */
export function toErrorEnvelope(error: unknown): EnvelopeErrorV1 {
  if (isUntangleError(error)) {
    return error.toEnvelopeError();
  }
  if (error instanceof Error) {
    return {
      code: UNKNOWN_ERROR_CODE,
      message: error.message,
      retryable: false,
      details: { name: error.name },
    };
  }
  return {
    code: UNKNOWN_ERROR_CODE,
    message: typeof error === "string" ? error : safeStringify(error),
    retryable: false,
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
