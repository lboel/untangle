import path from "node:path";

import type {
  ProductFeatureAlignmentV1,
  ProductFeatureV1,
  ProductSourceEvidenceV1,
  ProductSourceReferenceV1,
  ProductTestEvidenceV1,
} from "@untangle-code/domain";
import { findMarkdownHeadings } from "@untangle-code/domain";

import { readFreshProductFile } from "./analysis.js";
import type { ProductInventory } from "./analysis.js";
import { selectProductPaths, validProductPath } from "./manifest.js";

export function productInputPath(root: string, candidate: string): string | null {
  const relative = path.isAbsolute(candidate)
    ? path.relative(root, candidate).split(path.sep).join("/")
    : candidate;
  return validProductPath(relative) ? relative : null;
}

const normalizeHeading = (heading: string): string =>
  heading.replace(/[`*]/gu, "").replace(/\s+/gu, " ").trim();

export async function resolveProductSource(
  inventory: ProductInventory,
  reference: ProductSourceReferenceV1,
  signal?: AbortSignal,
): Promise<ProductSourceEvidenceV1> {
  const read = await readFreshProductFile(inventory, reference.path, signal);
  const base = {
    ...reference,
    ...(read.contentHash === undefined ? {} : { contentHash: read.contentHash }),
  };
  if (read.status !== "resolved" || read.text === undefined)
    return { ...base, status: read.status };
  const lines = read.text.replace(/^\uFEFF/u, "").split(/\r\n|\r|\n/u);
  if (
    lines.some((line) => line.length > 16_384) ||
    lines.filter((line) => /^#{1,6}\s/u.test(line)).length > 2048
  ) {
    return { ...base, status: "unreadable" };
  }
  const headings = findMarkdownHeadings(lines);
  const matches = headings.filter(
    (heading) => normalizeHeading(heading.title) === normalizeHeading(reference.heading),
  );
  if (matches.length !== 1)
    return { ...base, status: matches.length === 0 ? "missing" : "ambiguous" };
  const selected = matches[0]!;
  const next = headings.find(
    (heading) => heading.line > selected.line && heading.level <= selected.level,
  );
  return {
    ...base,
    status: "resolved",
    startLine: selected.line,
    endLine: next === undefined ? lines.length : next.line - 1,
  };
}

export interface LoadedProductTests {
  status: "bound" | "not_run" | "stale" | "invalid";
  evidence: ProductTestEvidenceV1 | null;
  issue?: string;
}

function parseTestEvidence(text: string): ProductTestEvidenceV1 | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  if (
    item["schemaVersion"] !== 1 ||
    !Array.isArray(item["tests"]) ||
    item["tests"].length > 100_000 ||
    typeof item["sourceTreeBefore"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(item["sourceTreeBefore"]) ||
    typeof item["sourceTreeAfter"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(item["sourceTreeAfter"]) ||
    !Array.isArray(item["command"]) ||
    item["command"].length === 0 ||
    item["command"].length > 128 ||
    !item["command"].every(
      (arg) => typeof arg === "string" && arg.length > 0 && arg.length <= 4096,
    ) ||
    !Number.isInteger(item["exitCode"])
  )
    return null;
  const identities = new Set<string>();
  for (const test of item["tests"]) {
    if (typeof test !== "object" || test === null) return null;
    const entry = test as Record<string, unknown>;
    if (
      !validProductPath(entry["path"]) ||
      typeof entry["name"] !== "string" ||
      entry["name"].length === 0 ||
      entry["name"].length > 4096 ||
      !["passed", "failed", "skipped"].includes(String(entry["status"]))
    )
      return null;
    const identity = `${entry["path"]}\0${entry["name"]}`;
    if (identities.has(identity)) return null;
    identities.add(identity);
  }
  return item as unknown as ProductTestEvidenceV1;
}

/** Apply identical validation and complete-inventory binding to direct runner evidence. */
export function bindProductTests(
  inventory: ProductInventory,
  candidate: unknown,
): LoadedProductTests {
  let evidence: ProductTestEvidenceV1 | null;
  try {
    const text = JSON.stringify(candidate);
    evidence = Buffer.byteLength(text, "utf8") > 16 * 1024 * 1024 ? null : parseTestEvidence(text);
  } catch {
    evidence = null;
  }
  const accepted = new Set(inventory.files.map((file) => file.relativePath));
  if (evidence === null || evidence.tests.some((test) => !accepted.has(test.path)))
    return {
      status: "invalid",
      evidence: null,
      issue: "Invalid or out-of-inventory test execution evidence.",
    };
  if (
    inventory.truncated ||
    evidence.sourceTreeBefore !== inventory.sourceTreeDigest ||
    evidence.sourceTreeAfter !== inventory.sourceTreeDigest
  )
    return {
      status: "stale",
      evidence: null,
      issue:
        "Test evidence does not bind the complete current accepted source inventory before and after execution.",
    };
  return { status: "bound", evidence };
}

/** Evidence may live in ignored local metadata; it is never executed by this reader. */
export async function loadProductTests(
  inventory: ProductInventory,
  candidate?: string,
  signal?: AbortSignal,
): Promise<LoadedProductTests> {
  if (candidate === undefined) return { status: "not_run", evidence: null };
  const relative = productInputPath(inventory.root, candidate);
  if (relative === null)
    return {
      status: "invalid",
      evidence: null,
      issue: "Test evidence must be inside the chosen root.",
    };
  const absolute = path.join(inventory.root, relative);
  try {
    signal?.throwIfAborted();
    const real = await inventory.fs.realPath(
      absolute,
      signal === undefined ? undefined : { signal },
    );
    signal?.throwIfAborted();
    if (productInputPath(inventory.root, real) === null) throw new Error("Evidence escaped root");
    const stat = await inventory.fs.stat(absolute, signal === undefined ? undefined : { signal });
    signal?.throwIfAborted();
    if (stat?.kind !== "file" || stat.sizeBytes > 16 * 1024 * 1024)
      throw new Error("Evidence unavailable or too large");
    const bytes = await inventory.fs.readFile(
      absolute,
      signal === undefined ? undefined : { signal },
    );
    signal?.throwIfAborted();
    if (bytes.byteLength > 16 * 1024 * 1024)
      throw new Error("Evidence grew beyond the parse budget");
    const afterReal = await inventory.fs.realPath(
      absolute,
      signal === undefined ? undefined : { signal },
    );
    signal?.throwIfAborted();
    if (real !== afterReal) throw new Error("Evidence path changed");
    const evidence = parseTestEvidence(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const accepted = new Set(inventory.files.map((file) => file.relativePath));
    if (evidence === null || evidence.tests.some((test) => !accepted.has(test.path))) {
      return {
        status: "invalid",
        evidence: null,
        issue: "Invalid or out-of-inventory test execution evidence.",
      };
    }
    if (
      inventory.truncated ||
      evidence.sourceTreeBefore !== inventory.sourceTreeDigest ||
      evidence.sourceTreeAfter !== inventory.sourceTreeDigest
    ) {
      return {
        status: "stale",
        evidence: null,
        issue:
          "Test evidence does not bind the complete current accepted source inventory before and after execution.",
      };
    }
    return { status: "bound", evidence };
  } catch (error) {
    signal?.throwIfAborted();
    if (
      error instanceof Error &&
      (error.name === "AbortError" || ("code" in error && error.code === "JOB_CANCELLED"))
    )
      throw error;
    return {
      status: "invalid",
      evidence: null,
      issue: "Test evidence is unreadable or outside the chosen root.",
    };
  }
}

export function productFeatureTests(
  feature: ProductFeatureV1,
  paths: string[],
  loaded: LoadedProductTests,
): Pick<ProductFeatureAlignmentV1, "testEvidence" | "criteria"> {
  const cases = loaded.evidence?.tests.filter((test) => paths.includes(test.path)) ?? [];
  const failed = cases.filter((test) => test.status === "failed").length;
  const passed = cases.filter((test) => test.status === "passed").length;
  const skipped = cases.filter((test) => test.status === "skipped").length;
  const everyFile =
    paths.length > 0 && paths.every((file) => cases.some((test) => test.path === file));
  const status =
    loaded.status === "bound"
      ? failed > 0 || loaded.evidence!.exitCode !== 0
        ? "bound_failed"
        : everyFile && skipped === 0
          ? "bound_passed"
          : "not_run"
      : loaded.status;
  return {
    testEvidence: {
      status,
      passed,
      failed,
      skipped,
      proof: loaded.status === "bound" ? "supplied_source_bound_report" : "none",
    },
    criteria: feature.criteria.map((criterion) => {
      const matchedFiles = selectProductPaths(paths, { include: criterion.tests });
      const allSelectionsMatch =
        criterion.tests.length > 0 &&
        criterion.tests.every(
          (pattern) => selectProductPaths(paths, { include: [pattern] }).length > 0,
        );
      const selected = cases.filter(
        (test) =>
          matchedFiles.includes(test.path) &&
          (criterion.testNames === undefined || criterion.testNames.includes(test.name)),
      );
      const complete =
        matchedFiles.length > 0 &&
        matchedFiles.every((file) => selected.some((test) => test.path === file)) &&
        (criterion.testNames === undefined ||
          criterion.testNames.every((name) => selected.some((test) => test.name === name)));
      const criterionStatus = productCriterionStatus(
        allSelectionsMatch,
        matchedFiles,
        loaded,
        selected,
        complete,
      );
      return {
        id: criterion.id,
        description: criterion.description,
        matchedFiles,
        status: criterionStatus,
      };
    }),
  };
}

function productCriterionStatus(
  allSelectionsMatch: boolean,
  matchedFiles: string[],
  loaded: LoadedProductTests,
  selected: ProductTestEvidenceV1["tests"],
  complete: boolean,
): ProductFeatureAlignmentV1["criteria"][number]["status"] {
  if (!allSelectionsMatch || matchedFiles.length === 0) return "missing_tests";
  if (loaded.status !== "bound") return "not_run";
  if (selected.some((test) => test.status === "failed") || loaded.evidence!.exitCode !== 0)
    return "failed";
  if (complete && selected.every((test) => test.status === "passed")) return "passed";
  return "unverified";
}
