import { ERROR_CODES, UntangleError, isUntangleError } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import {
  ERROR_FACTORIES,
  UNKNOWN_ERROR_CODE,
  configInvalidError,
  lockHeldError,
  toErrorEnvelope,
} from "./errors.js";

describe("ERROR_FACTORIES", () => {
  it("has exactly one factory per ErrorCode, each producing the right code", () => {
    expect(Object.keys(ERROR_FACTORIES).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      const error = ERROR_FACTORIES[code]("boom");
      expect(error).toBeInstanceOf(UntangleError);
      expect(error.code).toBe(code);
    }
  });

  it("named convenience exports match the map entry for the same code", () => {
    expect(configInvalidError).toBe(ERROR_FACTORIES.CONFIG_INVALID);
    expect(lockHeldError).toBe(ERROR_FACTORIES.LOCK_HELD);
  });

  it("passes through retryable/operation/context/cause", () => {
    const cause = new Error("ECONNREFUSED");
    const error = lockHeldError("index lock busy", {
      retryable: true,
      operation: "index",
      context: { key: "repo:r:main:index" },
      cause,
    });
    expect(error.retryable).toBe(true);
    expect(error.operation).toBe("index");
    expect(error.context["key"]).toBe("repo:r:main:index");
    expect(error.cause).toBe(cause);
  });
});

describe("toErrorEnvelope", () => {
  it("round-trips an UntangleError through its own toEnvelopeError()", () => {
    const error = new UntangleError("QDRANT_UNAVAILABLE", "connection refused", {
      retryable: true,
      context: { endpoint: "http://127.0.0.1:6334" },
    });
    expect(toErrorEnvelope(error)).toEqual(error.toEnvelopeError());
    expect(toErrorEnvelope(error)).toEqual({
      code: "QDRANT_UNAVAILABLE",
      message: "connection refused",
      retryable: true,
      details: { endpoint: "http://127.0.0.1:6334" },
    });
  });

  it("maps a plain Error to UNKNOWN_ERROR_CODE, never a known ErrorCode", () => {
    const envelope = toErrorEnvelope(new TypeError("cannot read property 'x' of undefined"));
    expect(envelope.code).toBe(UNKNOWN_ERROR_CODE);
    expect(envelope.retryable).toBe(false);
    expect(envelope.message).toBe("cannot read property 'x' of undefined");
    expect(envelope.details).toEqual({ name: "TypeError" });
    expect(isUntangleError(new TypeError("x"))).toBe(false);
  });

  it("maps a thrown string and other non-Error values without throwing", () => {
    expect(toErrorEnvelope("plain string throw")).toEqual({
      code: UNKNOWN_ERROR_CODE,
      message: "plain string throw",
      retryable: false,
    });
    expect(toErrorEnvelope({ weird: true }).code).toBe(UNKNOWN_ERROR_CODE);
    expect(toErrorEnvelope(undefined).code).toBe(UNKNOWN_ERROR_CODE);
  });
});
