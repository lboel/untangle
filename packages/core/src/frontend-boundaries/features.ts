import path from "node:path";

import type { ProductFeatureManifestV1 } from "@untangle-code/domain";

import {
  readFreshProductManifestFile,
  type FreshProductManifestFile,
  type ProductInventory,
} from "../product-alignment/analysis.js";
import { parseProductManifest, selectProductPaths } from "../product-alignment/manifest.js";

import type { FrontendBoundaryReportV1, FrontendFeatureAssociationV1 } from "./types.js";

export interface LoadedFrontendFeatures {
  path: string;
  before: FreshProductManifestFile;
  manifest: ProductFeatureManifestV1 | null;
  issues: string[];
}

export async function loadFrontendFeatures(
  inventory: ProductInventory,
  explicit: string | undefined,
  signal?: AbortSignal,
): Promise<LoadedFrontendFeatures> {
  let selected = explicit === undefined ? "untangle.features.json" : explicit;
  let before = await readFreshProductManifestFile(inventory, selected, signal);
  if (explicit === undefined && before.status === "missing") {
    selected = ".untangle/features.json";
    before = await readFreshProductManifestFile(inventory, selected, signal);
  }
  const selectedPath = path
    .relative(inventory.root, path.resolve(inventory.root, selected))
    .split(path.sep)
    .join("/");
  if (before.status !== "resolved" || before.text === undefined)
    return { path: selectedPath, before, manifest: null, issues: [] };
  return { path: selectedPath, before, ...parseProductManifest(before.text) };
}

export function frontendFeatureAssociations(
  loaded: LoadedFrontendFeatures,
  paths: readonly string[],
): FrontendFeatureAssociationV1[] {
  const manifest = loaded.manifest;
  const associations = paths.map((filePath) => ({
    path: filePath,
    matches: [] as FrontendFeatureAssociationV1["matches"],
  }));
  if (manifest === null) return associations;
  for (const feature of manifest.features) {
    for (const role of ["code", "test"] as const) {
      const matched = new Set(
        selectProductPaths(paths, feature[role === "code" ? "code" : "tests"]),
      );
      for (const association of associations) {
        if (!matched.has(association.path)) continue;
        association.matches.push({
          featureId: feature.id,
          title: feature.title,
          role,
          review: feature.review,
          ownership: feature.owners.map((id) => {
            const owner = manifest.owners.find((item) => item.id === id);
            return owner === undefined
              ? { id, status: "missing" }
              : { id, label: owner.label, status: owner.status };
          }),
          declaredDependsOn: [...feature.dependsOn],
        });
      }
    }
  }
  return associations;
}

export async function frontendFeatureFreshness(
  inventory: ProductInventory,
  loaded: LoadedFrontendFeatures,
  signal?: AbortSignal,
): Promise<{ manifest: FrontendBoundaryReportV1["features"]["manifest"]; changed: boolean }> {
  const after = await readFreshProductManifestFile(inventory, loaded.path, signal, loaded.before);
  const changed =
    after.status !== loaded.before.status ||
    after.contentHash !== loaded.before.contentHash ||
    after.physicalPath !== loaded.before.physicalPath ||
    after.status === "changed";
  let status: FrontendBoundaryReportV1["features"]["manifest"]["status"];
  if (changed) status = "changed";
  else if (after.status === "resolved") status = loaded.manifest === null ? "invalid" : "loaded";
  else status = after.status;
  return {
    manifest: {
      path: loaded.path,
      status,
      ...(after.contentHash === undefined ? {} : { contentHash: after.contentHash }),
    },
    changed,
  };
}
