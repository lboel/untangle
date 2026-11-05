import type { ProductFeatureManifestV1 } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import {
  missingProductPaths,
  parseProductManifest,
  selectProductPaths,
  validProductPath,
} from "./manifest.js";

const manifest: ProductFeatureManifestV1 = {
  schemaVersion: 1,
  owners: [],
  features: [
    {
      id: "feature.search",
      title: "Search",
      stage: "implemented",
      review: "proposed",
      intent: [{ role: "vision", path: "vision.md", heading: "Search" }],
      owners: [],
      code: { include: ["src/**/*.ts"], exclude: ["src/**/*.test.ts"] },
      tests: { include: ["src/**/*.test.ts"] },
      criteria: [
        {
          id: "search-cases",
          description: "All search regression cases",
          tests: ["src/search.test.ts"],
        },
      ],
      dependsOn: [],
    },
  ],
};

describe("product manifest boundaries", () => {
  it("reports malformed and excessively branching glob patterns as an invalid manifest", () => {
    for (const pattern of ["src/[z-a].ts", "src/a*b*c*d*e*f.ts"]) {
      const changed = structuredClone(manifest);
      changed.features[0]!.code.include = [pattern];
      expect(parseProductManifest(JSON.stringify(changed)).manifest).toBeNull();
    }
  });
  it("preserves caller-declared keys and accepts a proposed mapping without inventing owners", () => {
    expect(parseProductManifest(JSON.stringify(manifest))).toEqual({ manifest, issues: [] });
  });
  it.each([
    "../secret.ts",
    "/secret.ts",
    "C:/secret.ts",
    "src/../secret.ts",
    "src\\secret.ts",
    "./src.ts",
    "src//file.ts",
    "src/\u0000file.ts",
  ])("rejects unsafe source selection %s", (candidate) => {
    expect(validProductPath(candidate)).toBe(false);
    const changed = structuredClone(manifest);
    changed.features[0]!.code.include = [candidate];
    expect(parseProductManifest(JSON.stringify(changed)).manifest).toBeNull();
  });
  it("rejects extra fields, duplicate feature keys and unrecorded confirmation", () => {
    expect(
      parseProductManifest(JSON.stringify({ ...manifest, semanticProof: true })).manifest,
    ).toBeNull();
    expect(
      parseProductManifest(
        JSON.stringify({ ...manifest, features: [...manifest.features, ...manifest.features] }),
      ).manifest,
    ).toBeNull();
    const changed = structuredClone(manifest);
    changed.features[0]!.review = "confirmed";
    expect(parseProductManifest(JSON.stringify(changed)).manifest).toBeNull();
  });
  it("anchors selectors at the chosen root and retains explicit missing declarations", () => {
    const paths = [
      "src/search.ts",
      "src/search.test.ts",
      "nested/src/search.ts",
      "src/private/helper.ts",
    ];
    expect(selectProductPaths(paths, manifest.features[0]!.code)).toEqual([
      "src/private/helper.ts",
      "src/search.ts",
    ]);
    expect(
      missingProductPaths(paths, {
        include: ["src/missing.ts", "src/search.test.ts"],
        exclude: ["**/*.test.ts"],
      }),
    ).toEqual(["src/missing.ts"]);
  });
});
