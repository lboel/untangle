/**
 * Configuration resolution (spec.md §4.4): defaults, external-mode URL
 * requirement, apiKeyEnv resolution (name-only, architecture.md §23.2) and
 * prefix validation.
 */
import { isUntangleError } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { QDRANT_STORAGE_DEFAULTS, resolveQdrantStorageConfig } from "./config.js";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isUntangleError(error) ? error.code : "NOT_UNTANGLE_ERROR";
  }
}

describe("resolveQdrantStorageConfig (spec.md §4.4)", () => {
  it("applies the documented defaults in managed mode", () => {
    const resolved = resolveQdrantStorageConfig({ mode: "managed" });
    expect(resolved.url).toBe(QDRANT_STORAGE_DEFAULTS.url);
    // WP-222: pinned to the literal, not just to the constant. "managed"
    // means Untangle's OWN container on spec.md §3.1's host port — never
    // upstream's 6333, where a foreign instance usually lives.
    expect(resolved.url).toBe("http://127.0.0.1:16333");
    expect(resolved.url).not.toContain(":6333");
    expect(resolved.collectionPrefix).toBe("untangle_");
    expect(resolved.requestTimeoutMs).toBe(30000);
    expect(resolved.maxRetries).toBe(3);
    expect(resolved.upsertMaxPoints).toBe(256);
    expect(resolved.upsertBudgetBytes).toBe(4 * 1024 * 1024);
    expect(resolved.graphPartBudgetBytes).toBeLessThanOrEqual(resolved.upsertBudgetBytes);
    expect(resolved.apiKey).toBeUndefined();
  });

  it("requires a URL in external mode", () => {
    expect(codeOf(() => resolveQdrantStorageConfig({ mode: "external" }))).toBe("CONFIG_INVALID");
  });

  it("resolves apiKeyEnv against the passed environment and rejects an unset variable", () => {
    const resolved = resolveQdrantStorageConfig(
      { mode: "external", url: "http://qdrant.internal:6333", apiKeyEnv: "QDRANT_KEY" },
      { QDRANT_KEY: "secret-value" },
    );
    expect(resolved.apiKey).toBe("secret-value");
    expect(
      codeOf(() =>
        resolveQdrantStorageConfig(
          { mode: "external", url: "http://qdrant.internal:6333", apiKeyEnv: "QDRANT_KEY" },
          {},
        ),
      ),
    ).toBe("CONFIG_INVALID");
  });

  it("rejects an invalid collection prefix and non-positive limits", () => {
    expect(
      codeOf(() => resolveQdrantStorageConfig({ mode: "managed", collectionPrefix: "Bad Prefix" })),
    ).toBe("CONFIG_INVALID");
    expect(codeOf(() => resolveQdrantStorageConfig({ mode: "managed", upsertMaxPoints: 0 }))).toBe(
      "CONFIG_INVALID",
    );
    expect(
      codeOf(() => resolveQdrantStorageConfig({ mode: "managed", upsertBudgetBytes: -1 })),
    ).toBe("CONFIG_INVALID");
  });
});
