import path from "node:path";

import type { ProductFeatureManifestV1 } from "@untangle-code/domain";
import { NodeFileSystem } from "@untangle-code/scanner/node-fs";

import { parseProductManifest } from "../product-alignment/manifest.js";

import {
  documentHeading,
  extractFileReferences,
  featureDraft,
  parseRequirements,
  parseTasks,
} from "./parse.js";
import { SDD_LIMITS, SddReader } from "./reader.js";
import type {
  SddConnectionOptionsV1,
  SddConnectionReportV1,
  SddFeatureV1,
  SddFrameworkV1,
} from "./types.js";

export type * from "./types.js";
export { SDD_LIMITS } from "./reader.js";

const UPSTREAM: SddConnectionReportV1["upstream"] = [
  {
    framework: "spec-kit",
    revision: "ba8363f8ab56b2da456a81299cfdbfee1ef7b871",
    documents: [
      "https://github.com/github/spec-kit/blob/ba8363f8ab56b2da456a81299cfdbfee1ef7b871/templates/spec-template.md",
      "https://github.com/github/spec-kit/blob/ba8363f8ab56b2da456a81299cfdbfee1ef7b871/templates/tasks-template.md",
      "https://github.com/github/spec-kit/blob/ba8363f8ab56b2da456a81299cfdbfee1ef7b871/scripts/bash/common.sh",
    ],
  },
  {
    framework: "openspec",
    revision: "2bd5bc3be964404657439f538857fcdf550f7398",
    documents: [
      "https://github.com/Fission-AI/OpenSpec/blob/2bd5bc3be964404657439f538857fcdf550f7398/docs/concepts.md",
      "https://github.com/Fission-AI/OpenSpec/blob/2bd5bc3be964404657439f538857fcdf550f7398/schemas/spec-driven/schema.yaml",
    ],
  },
];
interface Group {
  framework: SddFrameworkV1;
  directory: string;
  kind: SddFeatureV1["kind"];
  documents: string[];
}

async function specKitGroups(reader: SddReader): Promise<Group[]> {
  const groups = new Map<string, string[]>();
  const files = await reader.walk("specs");
  for (const file of files) {
    if (/^specs\/[^/]+\/spec\.md$/u.test(file)) groups.set(path.posix.dirname(file), []);
  }
  const state = await reader.read(".specify/feature.json");
  if (state !== null) {
    try {
      const value: unknown = JSON.parse(state);
      const directory =
        typeof value === "object" && value !== null && "feature_directory" in value
          ? value.feature_directory
          : undefined;
      const relative =
        typeof directory === "string" && path.isAbsolute(directory)
          ? path.relative(reader.root, directory).split(path.sep).join("/")
          : directory;
      if (typeof relative !== "string" || !reader.absolute(relative))
        reader.issue(
          "invalid_feature_directory",
          ".specify/feature.json",
          "feature_directory must identify a literal directory inside the selected project.",
        );
      else if ((await reader.safe(`${relative}/spec.md`)) === "file") groups.set(relative, []);
      else
        reader.issue(
          "missing_feature_spec",
          `${relative}/spec.md`,
          "The configured Spec Kit feature has no readable spec.md.",
        );
    } catch {
      reader.signal?.throwIfAborted();
      reader.issue(
        "invalid_feature_state",
        ".specify/feature.json",
        "Spec Kit feature state is not valid JSON.",
      );
    }
  }
  const result: Group[] = [];
  for (const directory of groups.keys()) {
    const documents: string[] = [];
    for (const name of [
      "spec.md",
      "plan.md",
      "tasks.md",
      "research.md",
      "data-model.md",
      "quickstart.md",
    ]) {
      const file = `${directory}/${name}`;
      if ((await reader.read(file)) !== null) documents.push(file);
    }
    result.push({ framework: "spec-kit", directory, kind: "feature", documents });
  }
  return result;
}
async function openSpecGroups(reader: SddReader): Promise<Group[]> {
  const result: Group[] = [];
  for (const file of await reader.walk("openspec/specs")) {
    if (file.endsWith("/spec.md"))
      result.push({
        framework: "openspec",
        directory: path.posix.dirname(file),
        kind: "capability",
        documents: [file],
      });
  }
  const changes = new Map<string, string[]>();
  for (const file of await reader.walk("openspec/changes")) {
    const match = /^openspec\/changes\/([^/]+)\/(.+)$/u.exec(file);
    if (!match || !/^(?:proposal|design|tasks)\.md$|^specs\/.+\/spec\.md$/u.test(match[2]!))
      continue;
    const directory = `openspec/changes/${match[1]!}`;
    const documents = changes.get(directory) ?? [];
    documents.push(file);
    changes.set(directory, documents);
  }
  for (const [directory, documents] of changes)
    result.push({ framework: "openspec", directory, kind: "change", documents: documents.sort() });
  await reader.read("openspec/config.yaml");
  await reader.read("openspec/project.md");
  return result;
}

/** Read-only framework adapters; checked tasks remain declarations, never execution proof. */
export async function discoverSddArtifacts(
  options: SddConnectionOptionsV1,
): Promise<SddConnectionReportV1> {
  options.signal?.throwIfAborted();
  const fs = options.fs ?? new NodeFileSystem();
  const requestedFramework = options.framework ?? "auto";
  if (!["auto", "spec-kit", "openspec"].includes(requestedFramework))
    throw new TypeError("Unknown SDD framework.");
  const root = await fs.realPath(
    path.resolve(options.root),
    options.signal ? { signal: options.signal } : undefined,
  );
  if ((await fs.stat(root))?.kind !== "directory")
    throw new Error("SDD connector root must be a directory.");
  const reader = new SddReader(root, fs, options.signal);
  const frameworks: SddFrameworkV1[] = [];
  for (const [framework, marker] of [
    ["spec-kit", ".specify"],
    ["openspec", "openspec"],
  ] as const) {
    if (requestedFramework !== "auto" && requestedFramework !== framework) continue;
    const state = await reader.safe(marker);
    if (state === "directory") frameworks.push(framework);
    else if (state === "unsafe")
      reader.issue(
        "unsafe_framework_root",
        marker,
        "Framework markers must be physical in-project directories.",
      );
    else if (requestedFramework === framework)
      reader.issue("missing_framework_root", marker, "The selected framework marker is absent.");
  }
  const groups: Group[] = [];
  if (frameworks.includes("spec-kit")) {
    await reader.read(".specify/memory/constitution.md");
    groups.push(...(await specKitGroups(reader)));
  }
  if (frameworks.includes("openspec")) groups.push(...(await openSpecGroups(reader)));
  if (groups.length > SDD_LIMITS.features)
    reader.issue(
      "feature_limit",
      ".",
      "Only the first 128 feature groups can enter the connector draft.",
    );
  const features: SddFeatureV1[] = [];
  for (const group of groups.slice(0, SDD_LIMITS.features)) {
    const documents: string[] = [],
      requirements: SddFeatureV1["requirements"] = [],
      tasks: SddFeatureV1["tasks"] = [],
      references: SddFeatureV1["references"] = [];
    let title: string | null = null;
    for (const file of group.documents) {
      const text = await reader.read(file);
      if (text === null) continue;
      documents.push(file);
      if (/\[(?:NEEDS CLARIFICATION|FEATURE NAME|###-feature-name)\b/u.test(text))
        reader.issue(
          "unresolved_template",
          file,
          "The artifact retains framework template or clarification markers.",
        );
      if (file.endsWith("/spec.md") || file.endsWith("/proposal.md")) {
        title ??= documentHeading(text);
        requirements.push(...parseRequirements(text, file, group.framework));
      }
      if (file.endsWith("/tasks.md")) tasks.push(...parseTasks(text, file, group.framework));
      references.push(...(await extractFileReferences(text, file, reader)));
    }
    if (documents.length === 0) continue;
    const id =
      group.framework === "spec-kit"
        ? `spec-kit:${group.directory}`
        : `openspec:${group.kind}:${group.directory.replace(/^openspec\/(?:specs|changes)\//u, "")}`;
    features.push({
      id,
      title: title ?? path.posix.basename(group.directory),
      ...group,
      documents,
      requirements,
      tasks,
      references,
    });
    if (requirements.length === 0)
      reader.issue(
        "missing_requirements",
        group.directory,
        "No supported requirement declarations were found; review this feature before adoption.",
      );
    if (
      requirements.filter((requirement) => requirement.kind !== "scenario").length > 128 ||
      documents.length > 32
    )
      reader.issue(
        "draft_limit",
        group.directory,
        "The complete connector evidence exceeds the feature manifest's bounded draft; review truncated draft selections.",
      );
  }
  let selectionsRemaining = 8192;
  let draftBytesRemaining = 4 * 1024 * 1024;
  const draftFeatures = features.flatMap((feature) => {
    const draft = featureDraft(
      feature,
      reader.text,
      reader.issue.bind(reader),
      feature.framework === "spec-kit" ? ".specify/memory/constitution.md" : undefined,
    );
    if (!draft) return [];
    const validatedFeature = parseProductManifest(
      JSON.stringify({ schemaVersion: 1, owners: [], features: [draft] }),
    );
    if (!validatedFeature.manifest) {
      reader.issue(
        "invalid_draft_feature",
        feature.directory,
        `The generated feature was omitted because it failed manifest validation: ${validatedFeature.issues.join(" ")}`,
      );
      return [];
    }
    const requested = draft.code.include.length + draft.tests.include.length;
    if (requested > selectionsRemaining) {
      reader.issue(
        "selection_limit",
        feature.directory,
        "The manifest selection budget was reached; the complete evidence remains in the connector report.",
      );
      draft.code.include = draft.code.include.slice(0, selectionsRemaining);
      draft.tests.include = draft.tests.include.slice(
        0,
        Math.max(0, selectionsRemaining - draft.code.include.length),
      );
    }
    selectionsRemaining -= draft.code.include.length + draft.tests.include.length;
    const bytes = Buffer.byteLength(JSON.stringify(draft, null, 2));
    if (bytes > draftBytesRemaining) {
      reader.issue(
        "manifest_byte_limit",
        feature.directory,
        "The review manifest reached its byte budget; the full feature evidence remains in the report.",
      );
      return [];
    }
    draftBytesRemaining -= bytes;
    return [draft];
  });
  let draft: ProductFeatureManifestV1 = { schemaVersion: 1, owners: [], features: draftFeatures };
  const validation = parseProductManifest(JSON.stringify(draft));
  if (validation.manifest) draft = validation.manifest;
  else {
    reader.issue(
      "invalid_draft_manifest",
      ".",
      `The final draft failed manifest validation and its features were omitted: ${validation.issues.join(" ")}`,
    );
    const empty = parseProductManifest(
      JSON.stringify({ schemaVersion: 1, owners: [], features: [] }),
    );
    if (!empty.manifest)
      throw new Error("The empty SDD draft violates the product manifest contract.");
    draft = empty.manifest;
  }
  const fresh = await reader.fresh();
  const sources = [...reader.sources.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return {
    schemaVersion: 1,
    kind: "sdd_connection",
    root,
    requestedFramework,
    frameworks,
    status: !fresh
      ? "stale"
      : frameworks.length === 0 && reader.issues.length === 0
        ? "not_detected"
        : features.length === 0 || reader.issues.length > 0
          ? "incomplete"
          : "connected",
    sourceDigest: reader.digest(),
    sources,
    features,
    draft,
    issues: reader.issues,
    limitations: [
      "This connector reads local framework declarations and literal file references. It never runs framework commands, installs tools, executes tests or changes upstream artifacts.",
      "All imported features remain planned/proposed with no declared owners. Checked tasks, capability specs and acceptance scenarios are not implementation, ownership or passing-test evidence.",
      "Code/test selections contain only resolved literal references from the inspected documents; review boundaries, ignored files, absent references and all proposed associations before adoption.",
      "Source hashes bind the inspected files only, not an atomic repository snapshot. Rescan after source or framework changes. Product analysis independently applies its own scanner coverage and freshness checks.",
      "Default in-repository Spec Kit and OpenSpec layouts are supported, including Spec Kit feature.json directories. OpenSpec archives, standalone stores and arbitrary custom schema generators are outside this connector's scope.",
      "Requirement removals are retained as delta evidence and excluded from proposed acceptance criteria. No feature dependency or per-requirement test association is inferred.",
    ],
    upstream: UPSTREAM.filter((entry) => frameworks.includes(entry.framework)),
  };
}
