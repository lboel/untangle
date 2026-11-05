import path from "node:path";

import type { ProductFeatureManifestV1, ProductFileSelectionV1 } from "@untangle-code/domain";
import { compileGlobList, evaluateLayer } from "@untangle-code/scanner";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4096;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 512 && value.every(string);
const keys = (value: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

/** Strict root-relative paths, shared by declarations and evidence. */
export function validProductPath(value: unknown): value is string {
  return (
    string(value) &&
    !path.posix.isAbsolute(value) &&
    !/[:\\]/u.test(value) &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
    value.split("/").every((part) => part !== ".." && part !== "." && part !== "")
  );
}

function patterns(value: unknown): value is string[] {
  return (
    strings(value) &&
    value.every((item) => validProductPath(item) && !item.startsWith("!") && item.length <= 512)
  );
}

function selection(value: unknown): value is ProductFileSelectionV1 {
  return (
    record(value) &&
    keys(value, ["include", "exclude"]) &&
    patterns(value["include"]) &&
    (value["exclude"] === undefined || patterns(value["exclude"]))
  );
}

function source(value: unknown): boolean {
  return record(value) && validProductPath(value["path"]) && string(value["heading"]);
}

function owner(value: unknown): boolean {
  return (
    record(value) &&
    keys(value, ["id", "label", "kind", "status", "confirmedBy", "sources"]) &&
    string(value["id"]) &&
    string(value["label"]) &&
    ["person", "team", "role"].includes(String(value["kind"])) &&
    ["declared", "confirmed"].includes(String(value["status"])) &&
    (value["status"] !== "confirmed" || string(value["confirmedBy"])) &&
    (value["confirmedBy"] === undefined || string(value["confirmedBy"])) &&
    Array.isArray(value["sources"]) &&
    value["sources"].length <= 32 &&
    value["sources"].every(
      (item) => source(item) && record(item) && keys(item, ["path", "heading"]),
    )
  );
}

function criterion(value: unknown): boolean {
  return (
    record(value) &&
    keys(value, ["id", "description", "tests", "testNames"]) &&
    string(value["id"]) &&
    string(value["description"]) &&
    patterns(value["tests"]) &&
    (value["testNames"] === undefined ||
      (strings(value["testNames"]) && value["testNames"].length > 0))
  );
}

function budgets(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    record(value) &&
    keys(value, ["maxCognitivePerUnit", "maxCognitiveTotal", "maxCodeFiles", "maxOwners"]) &&
    Object.values(value).every(
      (item) => typeof item === "number" && Number.isFinite(item) && item >= 0,
    )
  );
}

function feature(value: unknown): boolean {
  return (
    record(value) &&
    keys(value, [
      "id",
      "title",
      "stage",
      "review",
      "confirmedBy",
      "intent",
      "owners",
      "code",
      "tests",
      "criteria",
      "dependsOn",
      "budgets",
    ]) &&
    string(value["id"]) &&
    string(value["title"]) &&
    ["implemented", "planned"].includes(String(value["stage"])) &&
    ["proposed", "confirmed"].includes(String(value["review"])) &&
    (value["review"] !== "confirmed" || string(value["confirmedBy"])) &&
    (value["confirmedBy"] === undefined || string(value["confirmedBy"])) &&
    Array.isArray(value["intent"]) &&
    value["intent"].length <= 32 &&
    value["intent"].every(
      (item) =>
        source(item) &&
        record(item) &&
        keys(item, ["path", "heading", "role"]) &&
        ["vision", "specification"].includes(String(item["role"])),
    ) &&
    strings(value["owners"]) &&
    selection(value["code"]) &&
    selection(value["tests"]) &&
    Array.isArray(value["criteria"]) &&
    value["criteria"].length <= 128 &&
    value["criteria"].every(criterion) &&
    strings(value["dependsOn"]) &&
    budgets(value["budgets"])
  );
}

export function parseProductManifest(text: string): {
  manifest: ProductFeatureManifestV1 | null;
  issues: string[];
} {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { manifest: null, issues: ["Manifest is not valid JSON."] };
  }
  if (
    !record(value) ||
    !keys(value, ["schemaVersion", "owners", "features"]) ||
    value["schemaVersion"] !== 1 ||
    !Array.isArray(value["owners"]) ||
    value["owners"].length > 128 ||
    !value["owners"].every(owner) ||
    !Array.isArray(value["features"]) ||
    value["features"].length > 128 ||
    !value["features"].every(feature)
  ) {
    return {
      manifest: null,
      issues: ["Manifest does not satisfy the bounded ProductFeatureManifestV1 contract."],
    };
  }
  const manifest = value as unknown as ProductFeatureManifestV1;
  const selectors = manifest.features.flatMap((item) => [
    ...item.code.include,
    ...(item.code.exclude ?? []),
    ...item.tests.include,
    ...(item.tests.exclude ?? []),
    ...item.criteria.flatMap((criterion) => criterion.tests),
  ]);
  if (
    selectors.length > 8192 ||
    selectors.some(
      (pattern) =>
        pattern.split("/").some((segment) => (segment.match(/\*+/gu)?.length ?? 0) > 4) ||
        (pattern.match(/\*+/gu)?.length ?? 0) > 16,
    )
  ) {
    return { manifest: null, issues: ["Manifest selections exceed the bounded glob budget."] };
  }
  try {
    compileGlobList(selectors.map((pattern) => `/${pattern}`));
  } catch {
    return { manifest: null, issues: ["Manifest contains an invalid glob pattern."] };
  }
  const groups = [
    manifest.owners.map((item) => item.id),
    manifest.features.map((item) => item.id),
    ...manifest.features.map((item) => item.criteria.map((criterion) => criterion.id)),
    ...manifest.features.flatMap((item) => [
      item.owners,
      item.dependsOn,
      ...item.criteria.map((criterion) => criterion.testNames ?? []),
    ]),
  ];
  if (groups.some((group) => new Set(group).size !== group.length)) {
    return {
      manifest: null,
      issues: ["Owner, feature and per-feature criterion identifiers must be unique."],
    };
  }
  return { manifest, issues: [] };
}

/** Globs are anchored to the chosen project root, never inferred from basenames. */
export function selectProductPaths(
  paths: readonly string[],
  selection: ProductFileSelectionV1,
): string[] {
  const include = compileGlobList(selection.include.map((pattern) => `/${pattern}`));
  const exclude = compileGlobList((selection.exclude ?? []).map((pattern) => `/${pattern}`));
  return paths
    .filter(
      (item) =>
        evaluateLayer(include, item, false) === true &&
        evaluateLayer(exclude, item, false) !== true,
    )
    .sort();
}

/** Exact declarations which were absent from the accepted scan stay visible. */
export function missingProductPaths(
  paths: readonly string[],
  selection: ProductFileSelectionV1,
): string[] {
  const present = new Set(paths);
  return selection.include
    .filter(
      (item) =>
        !/[*?[\]]/u.test(item) &&
        !present.has(item) &&
        selectProductPaths([item], selection).length > 0,
    )
    .sort();
}
