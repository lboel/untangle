import { describe, expect, it } from "vitest";

import { resolveApiKey, toRedactedJson } from "./secrets.js";

describe("redactSecrets / toRedactedJson", () => {
  it("never lets a resolved secret value appear in the JSON dump", () => {
    // Simulates a caller mistakenly attaching a resolved secret onto a config-shaped
    // object (e.g. for convenience before logging it) — the redaction pass must
    // still catch it even though the *designed* config shape never stores one.
    const configWithLeakedSecret = {
      qdrant: {
        mode: "external",
        url: "http://127.0.0.1:6333",
        apiKeyEnv: "UNTANGLE_QDRANT_API_KEY",
        apiKey: "sk-live-super-secret-value-12345",
      },
    };
    const dump = toRedactedJson(configWithLeakedSecret);
    expect(dump).not.toContain("sk-live-super-secret-value-12345");
    expect(dump).toContain("UNTANGLE_QDRANT_API_KEY");
    expect(dump).toContain("[REDACTED]");
  });

  it("keeps the apiKeyEnv reference (an env var NAME) visible for transparency", () => {
    const config = { embeddings: { apiKeyEnv: "UNTANGLE_EMBEDDINGS_API_KEY" } };
    const dump = toRedactedJson(config);
    expect(dump).toContain("UNTANGLE_EMBEDDINGS_API_KEY");
  });

  it("redacts nested and array-nested secret-shaped fields", () => {
    const config = {
      repos: [
        { id: "a", token: "ghp_leaked" },
        { id: "b", secret: "also-leaked" },
      ],
    };
    const dump = toRedactedJson(config);
    expect(dump).not.toContain("ghp_leaked");
    expect(dump).not.toContain("also-leaked");
  });

  it("does not touch unrelated fields", () => {
    const config = { workspaceId: "commerce-platform", index: { watch: true } };
    const dump = toRedactedJson(config);
    expect(JSON.parse(dump)).toEqual(config);
  });
});

describe("resolveApiKey", () => {
  it("resolves the referenced environment variable's value", () => {
    expect(resolveApiKey("MY_SECRET_ENV", { MY_SECRET_ENV: "s3cr3t" })).toBe("s3cr3t");
  });

  it("returns undefined when no env var name is configured", () => {
    expect(resolveApiKey(undefined, { MY_SECRET_ENV: "s3cr3t" })).toBeUndefined();
  });

  it("returns undefined when the referenced variable is not set", () => {
    expect(resolveApiKey("MISSING_ENV", {})).toBeUndefined();
  });
});
