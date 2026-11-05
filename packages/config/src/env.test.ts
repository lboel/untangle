import { describe, expect, it } from "vitest";

import { buildEnvConfigLayer } from "./env.js";

describe("buildEnvConfigLayer", () => {
  it("maps known UNTANGLE_* variables onto their config paths", () => {
    const { layer, parseErrors } = buildEnvConfigLayer({
      UNTANGLE_QDRANT_URL: "http://127.0.0.1:6333",
      UNTANGLE_QDRANT_MODE: "external",
      UNTANGLE_EMBEDDINGS_DIMENSIONS: "1024",
      UNTANGLE_INDEX_WATCH: "false",
      UNTANGLE_TELEMETRY_ENABLED: "true",
    });
    expect(parseErrors).toEqual([]);
    expect(layer).toEqual({
      qdrant: { url: "http://127.0.0.1:6333", mode: "external" },
      embeddings: { dimensions: 1024 },
      index: { watch: false },
      telemetry: { enabled: true },
    });
  });

  it("ignores unset variables entirely", () => {
    const { layer } = buildEnvConfigLayer({});
    expect(layer).toEqual({});
  });

  it("ignores unrelated environment variables", () => {
    const { layer } = buildEnvConfigLayer({ PATH: "/usr/bin", HOME: "/home/x" });
    expect(layer).toEqual({});
  });

  it("reports a parse error for a non-numeric value without throwing", () => {
    const { layer, parseErrors } = buildEnvConfigLayer({
      UNTANGLE_EMBEDDINGS_DIMENSIONS: "not-a-number",
    });
    expect(layer).toEqual({});
    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]?.env).toBe("UNTANGLE_EMBEDDINGS_DIMENSIONS");
  });

  it("parses a CSV list variable into an array", () => {
    const { layer } = buildEnvConfigLayer({ UNTANGLE_INDEX_EXTRA_EXTENSIONS: ".proto, .thrift" });
    expect(layer).toEqual({ index: { extraExtensions: [".proto", ".thrift"] } });
  });

  it("accepts '1'/'0' as boolean values", () => {
    const { layer } = buildEnvConfigLayer({ UNTANGLE_TELEMETRY_ENABLED: "1" });
    expect(layer).toEqual({ telemetry: { enabled: true } });
  });
});
