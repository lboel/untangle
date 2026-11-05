import { describe, expect, it } from "vitest";

import type { ProductFeatureManifestV1 } from "../packages/domain/src/types/product-alignment.js";

const { featureWorkflowManifest } = (await import(
  new URL("./feature-workflow-smoke.mjs", import.meta.url).href
)) as { featureWorkflowManifest(language: string): ProductFeatureManifestV1 };

describe("independent feature workflow fixtures", () => {
  it("declares shared responsibilities and file-level acceptance without inferred owners", () => {
    const manifest = featureWorkflowManifest("typescript");
    expect(manifest.features[0]?.code.include).toEqual(["src/lookup.ts", "src/shared.ts"]);
    expect(manifest.features[1]?.code.include).toEqual(["src/shared.ts"]);
    expect(manifest.features[0]?.criteria[0]?.tests).toEqual(["src/lookup.test.ts"]);
    expect(manifest.owners[0]?.status).toBe("declared");
    expect(
      manifest.features.every((feature: { review: string }) => feature.review === "proposed"),
    ).toBe(true);
  });

  it("keeps the Python fixture independent of the Vitest execution adapter", () => {
    const manifest = featureWorkflowManifest("python");
    expect(manifest.features[0]?.code.include).toEqual(["src/lookup.py", "src/shared.py"]);
    expect(manifest.features[0]?.tests.include).toEqual(["src/lookup.test.py"]);
  });
});
