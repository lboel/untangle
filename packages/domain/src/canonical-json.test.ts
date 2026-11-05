import { describe, expect, it } from "vitest";

import { CanonicalJsonError, canonicalJson } from "./canonical-json.js";

describe("canonicalJson", () => {
  it("sorts object keys ascending", () => {
    expect(canonicalJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
  });

  it("is deterministic regardless of property insertion order", () => {
    const first = canonicalJson({ model: "nomic", provider: "ollama", dimensions: 768 });
    const second = canonicalJson({ dimensions: 768, provider: "ollama", model: "nomic" });
    expect(first).toBe(second);
  });

  it("sorts keys recursively in nested objects", () => {
    expect(canonicalJson({ z: { b: 1, a: [{ y: 1, x: 2 }] } })).toBe(
      '{"z":{"a":[{"x":2,"y":1}],"b":1}}',
    );
  });

  it("omits object properties whose value is undefined", () => {
    expect(canonicalJson({ a: 1, b: undefined, c: "x" })).toBe('{"a":1,"c":"x"}');
  });

  it("keeps array order and serializes primitives verbatim", () => {
    expect(canonicalJson([3, 1, 2, "a", true, null])).toBe('[3,1,2,"a",true,null]');
  });

  it("normalizes -0 to 0", () => {
    expect(canonicalJson({ a: -0 })).toBe('{"a":0}');
    expect(canonicalJson({ a: -0 })).toBe(canonicalJson({ a: 0 }));
  });

  it("rejects undefined array elements", () => {
    expect(() => canonicalJson([1, undefined, 3])).toThrow(CanonicalJsonError);
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(CanonicalJsonError);
  });

  it("rejects bigint, functions and symbols", () => {
    expect(() => canonicalJson({ a: 1n })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: Symbol("s") })).toThrow(CanonicalJsonError);
  });

  it("rejects non-plain objects such as Date", () => {
    expect(() => canonicalJson({ a: new Date(0) })).toThrow(CanonicalJsonError);
  });

  it("rejects cyclic structures", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(CanonicalJsonError);
  });

  it("allows the same object to appear twice without a cycle", () => {
    const shared = { a: 1 };
    expect(canonicalJson({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
  });

  it("reports the failing path in the error message", () => {
    try {
      canonicalJson({ outer: { inner: Number.NaN } });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalJsonError);
      expect((error as CanonicalJsonError).message).toContain("$.outer.inner");
    }
  });
});
