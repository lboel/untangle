import { describe, expect, it } from "vitest";

import { redact } from "./redact.js";

describe("redact", () => {
  it("masks known secret keys regardless of casing or nesting depth", () => {
    const input = {
      apiKey: "sk-abcdefghijklmnopqrstuvwx",
      Authorization: "Bearer abc123",
      nested: { password: "hunter2", cookie: "session=abc" },
    };
    expect(redact(input)).toEqual({
      apiKey: "[REDACTED]",
      Authorization: "[REDACTED]",
      nested: { password: "[REDACTED]", cookie: "[REDACTED]" },
    });
  });

  it("masks secret-looking values even under an innocuous key name", () => {
    const input = { note: "Bearer eyJhbGciOiJIUzI1NiJ9" };
    expect(redact(input)).toEqual({ note: "[REDACTED]" });
  });

  it("redacts inside arrays and arrays of objects", () => {
    const input = {
      users: [
        { name: "a", token: "ghp_abcdefghijklmnopqrstuvwx" },
        { name: "b", token: "plainlookingvalue" },
      ],
    };
    const result = redact(input) as { users: Array<{ name: string; token: string }> };
    expect(result.users[0]?.token).toBe("[REDACTED]");
    // "plainlookingvalue" is under a secret-key name, so still masked by key.
    expect(result.users[1]?.token).toBe("[REDACTED]");
    expect(result.users[0]?.name).toBe("a");
  });

  it("suppresses source-text fields by default and reveals them on opt-in", () => {
    const input = { content: "function f() { return 1; }", other: "kept" };
    expect(redact(input)).toEqual({ content: "[SOURCE_TEXT_SUPPRESSED]", other: "kept" });
    expect(redact(input, { includeSourceText: true })).toEqual(input);
  });

  it("leaves ordinary values untouched", () => {
    const input = { count: 3, ok: true, name: "search", tags: ["a", "b"] };
    expect(redact(input)).toEqual(input);
  });

  it("handles circular references without throwing", () => {
    const input: Record<string, unknown> = { name: "cycle" };
    input["self"] = input;
    const result = redact(input) as Record<string, unknown>;
    expect(result["name"]).toBe("cycle");
    expect(result["self"]).toBe("[CIRCULAR]");
  });

  it("passes through primitives and null/undefined", () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(42)).toBe(42);
    expect(redact("hello")).toBe("hello");
  });
});
