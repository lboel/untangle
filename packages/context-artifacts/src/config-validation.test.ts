import { describe, expect, it } from "vitest";

import { validateArtifactConfigs } from "./config-validation.js";
import { artifactConfig } from "./test-helpers.js";

describe("validateArtifactConfigs", () => {
  it("accepts a list of uniquely-named configs", () => {
    expect(() =>
      validateArtifactConfigs([
        artifactConfig({ name: "orders-schema", path: "db/orders.sql" }),
        artifactConfig({ name: "users-api", path: "api/openapi.yaml" }),
      ]),
    ).not.toThrow();
  });

  it("rejects a duplicate name with CONFIG_INVALID, naming every offender", () => {
    try {
      validateArtifactConfigs([
        artifactConfig({ name: "dup", path: "a.sql" }),
        artifactConfig({ name: "dup", path: "b.sql" }),
        artifactConfig({ name: "unique", path: "c.sql" }),
      ]);
      expect.unreachable("expected validateArtifactConfigs to throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "CONFIG_INVALID" });
      expect((error as { context: { duplicateNames: string[] } }).context.duplicateNames).toEqual([
        "dup",
      ]);
    }
  });

  it("rejects an empty name with CONFIG_INVALID", () => {
    expect(() => validateArtifactConfigs([artifactConfig({ name: "  ", path: "a.sql" })])).toThrow(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });

  it("case-sensitive: differently-cased names are NOT treated as duplicates", () => {
    expect(() =>
      validateArtifactConfigs([
        artifactConfig({ name: "Orders", path: "a.sql" }),
        artifactConfig({ name: "orders", path: "b.sql" }),
      ]),
    ).not.toThrow();
  });
});
