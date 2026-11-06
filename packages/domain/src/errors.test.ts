import { describe, expect, it } from "vitest";

import {
  CORE_ERROR_CODES,
  ERROR_CODES,
  EXTENSION_ERROR_CODES,
  PORTFOLIO_ERROR_CODES,
  STORAGE_ERROR_CODES,
  UntangleError,
  isErrorCode,
  isUntangleError,
} from "./errors.js";

describe("error codes", () => {
  it("contains all 19 spec.md §25.1, 12 portfolio.md §15 and 5 extensions.md §6.8 codes", () => {
    expect(CORE_ERROR_CODES).toHaveLength(19);
    expect(PORTFOLIO_ERROR_CODES).toHaveLength(12);
    expect(EXTENSION_ERROR_CODES).toHaveLength(5);
    expect(STORAGE_ERROR_CODES).toEqual(["LANCEDB_UNAVAILABLE", "LANCEDB_SCHEMA_INCOMPATIBLE"]);
    expect(ERROR_CODES).toHaveLength(38);
    expect(new Set(ERROR_CODES).size).toBe(38);
  });

  it("recognizes known codes and rejects unknown values", () => {
    expect(isErrorCode("PATH_OUTSIDE_WORKSPACE")).toBe(true);
    expect(isErrorCode("BLUEPRINT_TARGET_NOT_EMPTY")).toBe(true);
    expect(isErrorCode("EXTENSION_LICENSE_UNACKNOWLEDGED")).toBe(true);
    expect(isErrorCode("SEARCH_SESSION_CONFLICT")).toBe(true);
    expect(isErrorCode("NOT_A_CODE")).toBe(false);
    expect(isErrorCode(42)).toBe(false);
  });
});

describe("UntangleError", () => {
  it("carries code, retryable, operation and context", () => {
    const error = new UntangleError("QDRANT_UNAVAILABLE", "connection refused", {
      retryable: true,
      operation: "search",
      context: { endpoint: "http://127.0.0.1:16333" },
    });
    expect(error.code).toBe("QDRANT_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(error.operation).toBe("search");
    expect(error.context["endpoint"]).toBe("http://127.0.0.1:16333");
    expect(isUntangleError(error)).toBe(true);
    expect(isUntangleError(new Error("plain"))).toBe(false);
  });

  it("defaults to retryable=false and empty context", () => {
    const error = new UntangleError("CONFIG_INVALID", "bad enum value");
    expect(error.retryable).toBe(false);
    expect(error.context).toEqual({});
    expect(error.operation).toBeUndefined();
  });

  it("preserves the cause chain", () => {
    const cause = new Error("ECONNREFUSED");
    const error = new UntangleError("EMBEDDING_UNAVAILABLE", "ollama down", { cause });
    expect(error.cause).toBe(cause);
  });

  it("serializes into the tool envelope error shape", () => {
    const withDetails = new UntangleError("LOCK_HELD", "index lock busy", {
      context: { key: "repo:r:main:index" },
    });
    expect(withDetails.toEnvelopeError()).toEqual({
      code: "LOCK_HELD",
      message: "index lock busy",
      retryable: false,
      details: { key: "repo:r:main:index" },
    });

    const withoutDetails = new UntangleError("JOB_CANCELLED", "cancelled", { retryable: false });
    expect(withoutDetails.toEnvelopeError()).toEqual({
      code: "JOB_CANCELLED",
      message: "cancelled",
      retryable: false,
    });
  });
});
