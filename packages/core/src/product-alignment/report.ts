import type {
  FileSystemPort,
  ParserRegistry,
  ProductAgentHintV1,
  ProductAlignmentReportV1,
  ProductFeatureAlignmentV1,
  ProductFeatureManifestV1,
  ProductFeatureV1,
  ProductTestEvidenceV1,
} from "@untangle-code/domain";
import type { ScannedFileV1 } from "@untangle-code/scanner";

import {
  aggregateProductMeasurements,
  collectProductInventory,
  createProductInventory,
  isProductCodeFile,
  measureProductFiles,
  readFreshProductFile,
  readFreshProductManifestFile,
} from "./analysis.js";
import type {
  ProductFileMeasurement,
  ProductInventory,
  ProductInventoryScopeV1,
} from "./analysis.js";
import {
  loadProductTests,
  bindProductTests,
  productFeatureTests,
  productInputPath,
  resolveProductSource,
} from "./evidence.js";
import type { LoadedProductTests } from "./evidence.js";
import {
  missingProductPaths,
  parseProductManifest,
  selectProductPaths,
  validProductPath,
} from "./manifest.js";

export interface ProductAlignmentOptionsV1 {
  root: string;
  fs?: FileSystemPort;
  parserRegistry?: ParserRegistry;
  signal?: AbortSignal;
  manifestPath?: string;
  testEvidencePath?: string;
  /** In-memory report from an explicitly invoked runner; never combined with a report path. */
  testEvidence?: ProductTestEvidenceV1;
  featureId?: string;
  /** One repository-relative literal path, such as a search hit. */
  path?: string;
  maxCognitive?: number;
  /** Reuse the accepted Init census, preserving its explicit scope. */
  files?: readonly ScannedFileV1[];
  inventoryTruncated?: boolean;
  inventoryExcluded?: number;
  inventoryScope?: ProductInventoryScopeV1;
}

const LIMITATIONS = [
  "Feature boundaries, acceptance links and owners are caller declarations; semantic conformance and identity are not independently proven.",
  "Execution evidence is a supplied source-bound report, not an authenticated test runner. Selected test-file contracts require all reported cases to pass without skips.",
  "Metrics include complete declared files and private helpers. Shared files appear in each feature; the mapped union counts each file once.",
  "File identity and union deduplication use accepted repository-relative paths; safe in-root symlink aliases remain distinct logical source paths.",
  "Coverage is limited to the accepted scanner inventory and registered deep-parser candidates. Excluded files and unsupported languages are not evidence of zero complexity.",
  "Dependency cycles describe declared feature dependencies, not independently resolved import or call edges. Search hints require a fresh independent index.",
];

function emptyReport(inventory: ProductInventory, manifestPath: string): ProductAlignmentReportV1 {
  return {
    schemaVersion: 1,
    root: inventory.root,
    status: "needs_manifest",
    manifest: { path: manifestPath, status: "missing" },
    sourceTreeDigest: inventory.sourceTreeDigest,
    inventory: {
      files: inventory.files.length,
      truncated: inventory.truncated,
      excluded: inventory.excluded,
    },
    semanticConformance: "not_independently_proven",
    ownershipAuthority: "manifest_declarations",
    features: [],
    coverage: {
      measuredCodeFiles: 0,
      mappedCodeFiles: 0,
      unmappedCodeFiles: [],
      unmappedCodeFileCount: 0,
      sharedFiles: [],
      mappedCodeUnion: null,
    },
    dependencyCycles: [],
    issues: [],
    limitations: [...LIMITATIONS],
    draft: { schemaVersion: 1, owners: [], features: [] },
  };
}

/** Preserve paths addressed through the chosen root alias; readers still enforce physical containment. */
function requestedProductInputPath(
  canonicalRoot: string,
  requestedRoot: string,
  candidate: string,
): string | null {
  return productInputPath(canonicalRoot, candidate) ?? productInputPath(requestedRoot, candidate);
}

/** One SCC per cycle; bounded by the manifest size, not by the number of paths. */
function dependencyCycles(manifest: ProductFeatureManifestV1): string[][] {
  const ids = manifest.features.map((feature) => feature.id).sort();
  const edges = new Map(
    manifest.features.map((feature) => [
      feature.id,
      feature.dependsOn.filter((id) => ids.includes(id)),
    ]),
  );
  const reach = (start: string): Set<string> => {
    const visited = new Set<string>();
    const queue = [...(edges.get(start) ?? [])];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      if (visited.has(id)) continue;
      visited.add(id);
      queue.push(...(edges.get(id) ?? []));
    }
    return visited;
  };
  const reachable = new Map(ids.map((id) => [id, reach(id)]));
  const assigned = new Set<string>();
  const cycles: string[][] = [];
  for (const id of ids) {
    if (assigned.has(id) || !reachable.get(id)!.has(id)) continue;
    const component = ids.filter(
      (other) => reachable.get(id)!.has(other) && reachable.get(other)!.has(id),
    );
    component.forEach((other) => assigned.add(other));
    cycles.push(component);
  }
  return cycles;
}

interface FeatureContext {
  inventory: ProductInventory;
  manifest: ProductFeatureManifestV1;
  measurements: Map<string, ProductFileMeasurement>;
  selections: Map<string, { code: string[]; tests: string[] }>;
  loadedTests: LoadedProductTests;
  shared: Set<string>;
  maxCognitive: number;
  signal?: AbortSignal;
}

function featureFiles(
  paths: string[],
  missing: string[],
  context: FeatureContext,
): ProductFeatureAlignmentV1["tests"] {
  const files = paths.map((item) => context.measurements.get(item)!.evidence);
  files.push(...missing.map((item) => ({ path: item, status: "not_in_scan" as const })));
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const complete = missing.length === 0 && files.every((file) => file.status === "measured");
  return {
    complete,
    files,
    metrics: complete ? aggregateProductMeasurements(paths, context.measurements) : null,
  };
}

function budgetHints(
  feature: ProductFeatureV1,
  alignment: ProductFeatureAlignmentV1,
  context: FeatureContext,
): ProductAgentHintV1[] {
  const hints: ProductAgentHintV1[] = [];
  const limit = feature.budgets?.maxCognitivePerUnit ?? context.maxCognitive;
  for (const hotspot of alignment.code.hotspots) {
    if (hotspot.cognitive <= limit) continue;
    hints.push({
      code: "cognitive_unit_budget",
      severity: "warning",
      message: `${hotspot.symbol} has cognitive complexity ${hotspot.cognitive}, above ${limit}.`,
      paths: [hotspot.path],
      suggestedAction:
        "Inspect the complete function, callers and failure/cancellation contracts before extracting one responsibility.",
      search: { symbol: hotspot.symbol, path: hotspot.path, requireFresh: true },
    });
  }
  const checks = [
    [
      "maxCognitiveTotal",
      alignment.code.metrics?.cognitive.execution_unit,
      "cognitive_total_budget",
    ],
    ["maxCodeFiles", alignment.dimensions.codeFiles, "code_surface_budget"],
    ["maxOwners", alignment.dimensions.owners, "ownership_surface_budget"],
  ] as const;
  for (const [budget, measured, code] of checks) {
    const threshold = feature.budgets?.[budget];
    if (threshold !== undefined && measured !== undefined && measured > threshold) {
      hints.push({
        code,
        severity: "warning",
        message: `${budget}: ${measured} exceeds ${threshold}.`,
        paths: alignment.code.files.map((file) => file.path),
        suggestedAction:
          "Review the declared feature boundary and preserve every acceptance criterion while reducing its responsibility surface.",
      });
    }
  }
  return hints;
}

async function alignFeature(
  feature: ProductFeatureV1,
  context: FeatureContext,
): Promise<ProductFeatureAlignmentV1> {
  const { inventory, manifest } = context;
  const selection = context.selections.get(feature.id)!;
  const paths = inventory.files.map((file) => file.relativePath);
  const code = featureFiles(selection.code, missingProductPaths(paths, feature.code), context);
  const tests = featureFiles(selection.tests, missingProductPaths(paths, feature.tests), context);
  const matchesAll = (patterns: string[], selected: string[]): boolean =>
    patterns.every((pattern) => selectProductPaths(selected, { include: [pattern] }).length > 0);
  if (
    !matchesAll(feature.code.include, selection.code) ||
    (selection.code.length === 0 && feature.stage === "implemented")
  ) {
    code.complete = false;
    code.metrics = null;
  }
  if (
    !matchesAll(feature.tests.include, selection.tests) ||
    (selection.tests.length === 0 && feature.stage === "implemented")
  ) {
    tests.complete = false;
    tests.metrics = null;
  }
  const intent: ProductFeatureAlignmentV1["intent"] = [];
  for (const reference of feature.intent)
    intent.push({
      ...(await resolveProductSource(inventory, reference, context.signal)),
      role: reference.role,
    });
  const ownership: ProductFeatureAlignmentV1["ownership"] = [];
  for (const id of feature.owners) {
    const owner = manifest.owners.find((item) => item.id === id);
    if (owner === undefined) {
      ownership.push({ id, status: "missing", sources: [] });
      continue;
    }
    const sources = [];
    for (const source of owner.sources)
      sources.push(await resolveProductSource(inventory, source, context.signal));
    ownership.push({ id, label: owner.label, status: owner.status, sources });
  }
  const execution = productFeatureTests(feature, selection.tests, context.loadedTests);
  const issues: string[] = [];
  if (
    !intent.some((source) => source.role === "vision") ||
    !intent.some((source) => source.role === "specification")
  )
    issues.push("Both vision and specification references are required.");
  if (intent.some((source) => source.status !== "resolved"))
    issues.push("A declared intent source or heading is unresolved.");
  if (
    ownership.length === 0 ||
    ownership.some(
      (owner) =>
        owner.status === "missing" ||
        owner.sources.length === 0 ||
        owner.sources.some((source) => source.status !== "resolved"),
    )
  )
    issues.push("Ownership evidence is missing or unresolved.");
  if (!code.complete || !tests.complete)
    issues.push("Declared code or test files lack complete fresh metrics.");
  if (selection.code.some((file) => selection.tests.includes(file)))
    issues.push("Code and test selections overlap; declare their responsibilities separately.");
  if (feature.dependsOn.some((id) => !manifest.features.some((item) => item.id === id)))
    issues.push("A declared feature dependency is unknown.");
  if (
    feature.stage === "implemented" &&
    (selection.code.length === 0 || selection.tests.length === 0 || feature.criteria.length === 0)
  )
    issues.push("An implemented feature requires code, tests and acceptance criteria.");
  if (execution.criteria.some((criterion) => criterion.status === "missing_tests"))
    issues.push("Acceptance criteria have no selected test files.");
  const hotspots = selection.code
    .flatMap((file) => context.measurements.get(file)!.hotspots)
    .sort(
      (left, right) =>
        right.cognitive - left.cognitive ||
        (left.path < right.path
          ? -1
          : left.path > right.path
            ? 1
            : left.startLine - right.startLine),
    );
  const alignment: ProductFeatureAlignmentV1 = {
    id: feature.id,
    title: feature.title,
    stage: feature.stage,
    review: feature.review,
    status: "needs_review",
    intent,
    ownership,
    code: {
      ...code,
      metrics: feature.stage === "planned" && selection.code.length === 0 ? null : code.metrics,
      hotspots,
    },
    tests: {
      ...tests,
      metrics: feature.stage === "planned" && selection.tests.length === 0 ? null : tests.metrics,
    },
    ...execution,
    dimensions: {
      requirements: feature.criteria.length,
      owners: ownership.length,
      codeFiles: code.files.length,
      testFiles: tests.files.length,
      sharedCodeFiles: selection.code.filter((file) => context.shared.has(file)).length,
      declaredDependencies: feature.dependsOn.length,
      dependentFeatures: manifest.features.filter((item) => item.dependsOn.includes(feature.id))
        .length,
    },
    dependsOn: [...feature.dependsOn].sort(),
    agentHints: [],
    issues,
  };
  alignment.agentHints = budgetHints(feature, alignment, context);
  if (alignment.dimensions.sharedCodeFiles > 0)
    alignment.agentHints.push({
      code: "shared_code",
      severity: "info",
      message: `${alignment.dimensions.sharedCodeFiles} code files are shared with other features.`,
      paths: selection.code.filter((file) => context.shared.has(file)),
      suggestedAction: "Check the other feature contracts and callers before changing shared code.",
    });
  for (const issue of issues)
    alignment.agentHints.push({
      code: "missing_evidence",
      severity: "error",
      message: issue,
      paths: [],
      suggestedAction:
        "Resolve the declared evidence gap before claiming complete feature coverage.",
    });
  if (feature.review !== "confirmed" || ownership.some((owner) => owner.status !== "confirmed"))
    alignment.agentHints.push({
      code: "ownership_review",
      severity: "warning",
      message: "Feature boundaries or ownership remain proposed/declared.",
      paths: intent.map((source) => source.path),
      suggestedAction:
        "Have the product owner review the declared requirements, boundaries and responsibility; record the confirmation explicitly.",
    });
  if (execution.testEvidence.status !== "bound_passed")
    alignment.agentHints.push({
      code: "test_execution_evidence",
      severity: "warning",
      message: `Test execution evidence: ${execution.testEvidence.status}.`,
      paths: selection.tests,
      suggestedAction:
        "Run the declared tests and supply before/after inventory hashes with the actual case identities and exit code.",
    });
  const violated =
    alignment.agentHints.some((hint) => hint.code.endsWith("_budget")) ||
    execution.testEvidence.status === "bound_failed";
  alignment.status = violated
    ? "violated"
    : issues.length > 0 || ["stale", "invalid"].includes(execution.testEvidence.status)
      ? "incomplete"
      : feature.stage === "planned" ||
          feature.review !== "confirmed" ||
          ownership.some((owner) => owner.status !== "confirmed") ||
          execution.testEvidence.status !== "bound_passed" ||
          execution.criteria.some((criterion) => criterion.status !== "passed")
        ? "needs_review"
        : "evidence_consistent";
  return alignment;
}

export async function analyzeProductAlignment(
  options: ProductAlignmentOptionsV1,
): Promise<ProductAlignmentReportV1> {
  options.signal?.throwIfAborted();
  if (
    options.path !== undefined &&
    (!validProductPath(options.path) || /[*?[\]{}]/u.test(options.path))
  )
    throw new TypeError(
      "path must be one repository-relative literal file path without glob syntax.",
    );
  if (options.testEvidence !== undefined && options.testEvidencePath !== undefined)
    throw new TypeError("testEvidence and testEvidencePath cannot be combined.");
  const maxCognitive = options.maxCognitive ?? 15;
  if (!Number.isFinite(maxCognitive) || maxCognitive < 0)
    throw new TypeError("maxCognitive must be a finite nonnegative number.");
  const inventory =
    options.files === undefined || options.fs === undefined
      ? await collectProductInventory({
          root: options.root,
          ...(options.fs === undefined ? {} : { fs: options.fs }),
          ...(options.inventoryScope === undefined ? {} : { scope: options.inventoryScope }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
      : createProductInventory({
          root: options.root,
          fs: options.fs,
          files: options.files,
          truncated: options.inventoryTruncated ?? false,
          excluded: options.inventoryExcluded ?? 0,
        });
  options.signal?.throwIfAborted();
  let manifestPath = requestedProductInputPath(
    inventory.root,
    options.root,
    options.manifestPath ?? "untangle.features.json",
  );
  const report = emptyReport(inventory, manifestPath ?? options.manifestPath!);
  if (options.path !== undefined) {
    const selected = await readFreshProductFile(inventory, options.path, options.signal);
    report.selection = {
      path: options.path,
      status: selected.status === "resolved" ? "unmapped" : selected.status,
      matches: [],
    };
  }
  if (manifestPath === null) {
    report.status = "invalid_manifest";
    report.manifest.status = "invalid";
    report.issues.push("Manifest must be inside the chosen root.");
    return report;
  }
  let read = await readFreshProductManifestFile(inventory, manifestPath, options.signal);
  if (read.status === "missing" && options.manifestPath === undefined) {
    const metadataPath = ".untangle/features.json";
    const metadata = await readFreshProductManifestFile(inventory, metadataPath, options.signal);
    if (metadata.status !== "missing") {
      manifestPath = metadataPath;
      report.manifest.path = metadataPath;
      read = metadata;
    }
  }
  if (read.status !== "resolved" || read.text === undefined) {
    report.manifest.status = read.status === "resolved" ? "unreadable" : read.status;
    report.status = read.status === "missing" ? "needs_manifest" : "incomplete";
    report.issues.push(`Manifest evidence: ${report.manifest.status}.`);
    return report;
  }
  report.manifest = {
    path: manifestPath,
    status: "loaded",
    ...(read.contentHash === undefined ? {} : { contentHash: read.contentHash }),
  };
  const parsed = parseProductManifest(read.text);
  if (parsed.manifest === null) {
    report.status = "invalid_manifest";
    report.manifest.status = "invalid";
    report.issues.push(...parsed.issues);
    return report;
  }
  const manifest = parsed.manifest;
  report.draft = null;
  const paths = inventory.files.map((file) => file.relativePath);
  const selections = new Map(
    manifest.features.map((feature) => [
      feature.id,
      {
        code: selectProductPaths(paths, feature.code),
        tests: selectProductPaths(paths, feature.tests),
      },
    ]),
  );
  const codePaths = [
    ...new Set([...selections.values()].flatMap((selection) => selection.code)),
  ].sort();
  const testPaths = new Set([...selections.values()].flatMap((selection) => selection.tests));
  const candidates = inventory.files
    .filter(
      (file) =>
        isProductCodeFile(file, options.parserRegistry) && !testPaths.has(file.relativePath),
    )
    .map((file) => file.relativePath);
  const measuredPaths = [...new Set([...candidates, ...codePaths, ...testPaths])].sort();
  const measurements = await measureProductFiles(inventory, measuredPaths, {
    ...(options.parserRegistry === undefined ? {} : { parserRegistry: options.parserRegistry }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  report.limitations.push(
    ...new Set([...measurements.values()].flatMap((measurement) => measurement.limitations ?? [])),
  );
  const sharedFiles = codePaths
    .map((file) => ({
      path: file,
      featureIds: [...selections]
        .filter(([, selection]) => selection.code.includes(file))
        .map(([id]) => id)
        .sort(),
    }))
    .filter((file) => file.featureIds.length > 1);
  const loadedTests =
    options.testEvidence === undefined
      ? await loadProductTests(
          inventory,
          options.testEvidencePath === undefined
            ? undefined
            : (requestedProductInputPath(inventory.root, options.root, options.testEvidencePath) ??
                options.testEvidencePath),
          options.signal,
        )
      : bindProductTests(inventory, options.testEvidence);
  if (loadedTests.issue !== undefined) report.issues.push(loadedTests.issue);
  const context: FeatureContext = {
    inventory,
    manifest,
    measurements,
    selections,
    loadedTests,
    shared: new Set(sharedFiles.map((file) => file.path)),
    maxCognitive,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  for (const feature of manifest.features)
    report.features.push(await alignFeature(feature, context));
  report.features.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const unmappedCodeFiles = candidates.filter((file) => !codePaths.includes(file)).sort();
  report.coverage = {
    measuredCodeFiles: candidates.filter(
      (file) => measurements.get(file)?.evidence.status === "measured",
    ).length,
    mappedCodeFiles: codePaths.length,
    unmappedCodeFiles,
    unmappedCodeFileCount: unmappedCodeFiles.length,
    sharedFiles,
    mappedCodeUnion: report.features.every((feature) => feature.code.complete)
      ? aggregateProductMeasurements(codePaths, measurements)
      : null,
  };
  report.dependencyCycles = dependencyCycles(manifest);
  for (const cycle of report.dependencyCycles) {
    for (const feature of report.features.filter((item) => cycle.includes(item.id))) {
      feature.agentHints.push({
        code: "feature_dependency_cycle",
        severity: "warning",
        message: `Declared feature dependency cycle: ${cycle.join(" → ")}.`,
        paths: [],
        suggestedAction:
          "Inspect the declared boundaries and resolve actual import/call edges before changing coupled responsibilities.",
      });
    }
  }
  if (inventory.truncated) report.issues.push("Accepted inventory is truncated.");
  if (unmappedCodeFiles.length > 0)
    report.issues.push(
      `${unmappedCodeFiles.length} accepted deep-parser candidate files have no declared feature boundary.`,
    );
  if (report.dependencyCycles.length > 0)
    report.issues.push("Declared feature dependencies contain cycles.");
  // Re-read accepted evidence after parsing, so edits during analysis cannot retain a complete verdict.
  let sourceChanged = false;
  let manifestChanged = false;
  for (const file of inventory.files) {
    const current = await readFreshProductFile(inventory, file.relativePath, options.signal);
    if (current.status !== "resolved" && current.sourceUnchanged !== true) {
      sourceChanged = true;
      report.issues.push(
        `Accepted source changed or became unavailable during analysis: ${file.relativePath}.`,
      );
    }
  }
  {
    const finalInventory = await collectProductInventory({
      root: inventory.root,
      fs: inventory.fs,
      ...(options.inventoryScope === undefined ? {} : { scope: options.inventoryScope }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (
      finalInventory.sourceTreeDigest !== inventory.sourceTreeDigest ||
      finalInventory.truncated
    ) {
      sourceChanged = true;
      report.issues.push(
        "Accepted source inventory changed during analysis, including additions/removals.",
      );
    }
  }
  if (read.physicalPath !== undefined) {
    const current = await readFreshProductManifestFile(
      inventory,
      manifestPath,
      options.signal,
      read,
    );
    if (current.status !== "resolved") {
      manifestChanged = true;
      report.manifest.status = current.status;
      report.issues.push(
        `Manifest changed or became unavailable during analysis: ${manifestPath}.`,
      );
    }
  }
  if (sourceChanged || manifestChanged) {
    if (report.selection !== undefined) report.selection.status = "changed";
    report.coverage.mappedCodeUnion = null;
    for (const feature of report.features) {
      feature.testEvidence.status = "stale";
      feature.testEvidence.proof = "none";
      feature.code.complete = false;
      feature.code.metrics = null;
      feature.code.hotspots = [];
      feature.tests.complete = false;
      feature.tests.metrics = null;
      for (const criterion of feature.criteria) criterion.status = "unverified";
      feature.status = "incomplete";
      feature.agentHints = feature.agentHints.filter(
        (hint) => !hint.code.endsWith("_budget") && hint.search === undefined,
      );
      feature.issues.push(
        manifestChanged
          ? "Feature manifest changed during analysis; repeat before using these measurements or test bindings."
          : "Accepted source inventory changed during analysis; repeat before using these measurements or test bindings.",
      );
      feature.agentHints.push({
        code: manifestChanged ? "manifest_changed" : "source_changed",
        severity: "error",
        message: manifestChanged
          ? "Feature manifest changed during analysis."
          : "Accepted inventory changed during analysis.",
        paths: [],
        suggestedAction:
          "Repeat the source scan, complete feature measurement and source-bound tests on a stable working tree.",
      });
    }
  }
  if (
    options.featureId !== undefined &&
    !report.features.some((feature) => feature.id === options.featureId)
  )
    report.issues.push(`Unknown feature: ${options.featureId}.`);
  report.status = productReportStatus(report);
  if (report.selection !== undefined) {
    const selected = report.selection;
    if (selected.status === "unmapped") {
      for (const feature of report.features) {
        const roles: ("code" | "test" | "intent" | "ownership")[] = [];
        if (
          feature.code.files.some(
            (file) => file.path === selected.path && file.status !== "not_in_scan",
          )
        )
          roles.push("code");
        if (
          feature.tests.files.some(
            (file) => file.path === selected.path && file.status !== "not_in_scan",
          )
        )
          roles.push("test");
        if (feature.intent.some((source) => source.path === selected.path)) roles.push("intent");
        if (
          feature.ownership.some((owner) =>
            owner.sources.some((source) => source.path === selected.path),
          )
        )
          roles.push("ownership");
        if (roles.length > 0) selected.matches.push({ featureId: feature.id, roles });
      }
      if (selected.matches.length > 0) selected.status = "matched";
    }
    if (selected.status !== "matched") {
      report.issues.push(
        `Selected path ${selected.path}: ${selected.status}; no fresh declared feature association is available.`,
      );
      if (report.status === "evidence_consistent" || report.status === "needs_review")
        report.status = "incomplete";
    }
    if (
      selected.status === "matched" &&
      options.featureId !== undefined &&
      report.features.some((feature) => feature.id === options.featureId) &&
      !selected.matches.some((match) => match.featureId === options.featureId)
    ) {
      report.issues.push(
        `Selected path ${selected.path} is not associated with requested feature ${options.featureId}.`,
      );
      if (report.status !== "violated") report.status = "incomplete";
    }
    report.features = report.features.filter((feature) =>
      selected.matches.some((match) => match.featureId === feature.id),
    );
  }
  if (options.featureId !== undefined)
    report.features = report.features.filter((feature) => feature.id === options.featureId);
  options.signal?.throwIfAborted();
  return report;
}

function productReportStatus(report: ProductAlignmentReportV1): ProductAlignmentReportV1["status"] {
  if (report.features.some((feature) => feature.status === "violated")) return "violated";
  if (
    report.issues.length > 0 ||
    report.features.length === 0 ||
    report.features.some((feature) => feature.status === "incomplete")
  )
    return "incomplete";
  if (report.features.every((feature) => feature.status === "evidence_consistent"))
    return "evidence_consistent";
  return "needs_review";
}
