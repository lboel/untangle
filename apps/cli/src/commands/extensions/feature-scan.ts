/** Declared feature context for a scan; external evidence never becomes a feature metric. */
import { analyzeProductAlignment } from "@untangle-code/core";
import type { ProductAlignmentReportV1 } from "@untangle-code/domain";

import type { Io } from "../../cli/io.js";
import { line } from "../../cli/io.js";
import { formatProductReport } from "../product.js";

import type { ExtensionRanV1 } from "./invoke.js";

export type ScanProductAnalyzer = typeof analyzeProductAlignment;
export type ScanFeatureOptions = Parameters<ScanProductAnalyzer>[0] & { featureId: string };

export interface ScanFeatureContext {
  requestedFeatureId: string;
  nextSteps: string[];
  /** Full-file own metrics, declared ownership, acceptance and test evidence. */
  report: ProductAlignmentReportV1;
  sourceBinding: {
    status: "unchanged" | "changed" | "unverified";
    beforeDigest: string;
    afterDigest?: string;
    beforeManifestHash?: string;
    afterManifestHash?: string;
    afterStatus?: ProductAlignmentReportV1["status"];
    afterIssues?: string[];
    beforeInventory: ProductAlignmentReportV1["inventory"];
    afterInventory?: ProductAlignmentReportV1["inventory"];
    detail: string;
    nextStep: string;
  };
  externalEvidence: {
    extensionId: string;
    runId: string;
    status:
      "available" | "not_measured" | "source_changed" | "source_unverified" | "no_feature_boundary";
    /** Request time is not proof of the analyzer's underlying source snapshot. */
    analyzerSourceIdentity: "not_independently_proven";
    bindings: {
      kind: "measurement" | "finding";
      index: number;
      relation: "declared_feature_file" | "other_file" | "repository_context" | "unscoped";
      filePath?: string;
      sharedWithFeatures?: string[];
    }[];
    nextStep: string;
  }[];
  limitations: string[];
}

/** Re-analyze after the external calls, preserving both source identities and missing evidence. */
export async function finishScanFeature(
  options: ScanFeatureOptions,
  before: ProductAlignmentReportV1,
  outcomes: readonly ExtensionRanV1[],
  analyze: ScanProductAnalyzer = analyzeProductAlignment,
): Promise<ScanFeatureContext> {
  let after: ProductAlignmentReportV1 | undefined;
  let failure: string | undefined;
  try {
    after = await analyze(options);
  } catch (error) {
    options.signal?.throwIfAborted();
    failure = error instanceof Error ? error.message : String(error);
  }
  options.signal?.throwIfAborted();
  const changed =
    after !== undefined &&
    (before.sourceTreeDigest !== after.sourceTreeDigest ||
      before.manifest.contentHash !== after.manifest.contentHash);
  const verified = after !== undefined && !unstableInventory(before) && !unstableInventory(after);
  const status = changed ? "changed" : verified ? "unchanged" : "unverified";
  const feature = before.features.find((entry) => entry.id === options.featureId);
  const selected = new Set(
    [...(feature?.code.files ?? []), ...(feature?.tests.files ?? [])].map((file) => file.path),
  );
  const shared = new Map(before.coverage.sharedFiles.map((file) => [file.path, file.featureIds]));
  const sharedContext = (filePath: string | undefined): { sharedWithFeatures?: string[] } => {
    const featureIds = filePath === undefined ? undefined : shared.get(filePath);
    return featureIds === undefined ? {} : { sharedWithFeatures: featureIds };
  };
  const nextStep =
    "Repeat scan on a stable working tree; inspect product evidence and analyzer source provenance separately.";
  return {
    requestedFeatureId: options.featureId,
    nextSteps: [
      ...(feature === undefined
        ? [
            "Review the manifest path and declared feature ID with untangle product; a missing boundary has no feature metrics.",
          ]
        : []),
      ...(feature?.code.complete === false
        ? [
            "Resolve missing, unsupported or partial declared files before treating feature complexity as complete.",
          ]
        : []),
      ...(outcomes.length === 0
        ? [
            "External feature evidence is not measured. Inspect untangle extensions list/status; add and enable an analyzer explicitly if needed.",
          ]
        : []),
      ...(status === "unchanged" ? [] : [nextStep]),
    ],
    report: before,
    sourceBinding: {
      status,
      beforeDigest: before.sourceTreeDigest,
      beforeInventory: before.inventory,
      ...(after === undefined
        ? {}
        : {
            afterDigest: after.sourceTreeDigest,
            afterStatus: after.status,
            afterIssues: after.issues,
            afterInventory: after.inventory,
          }),
      ...(before.manifest.contentHash === undefined
        ? {}
        : { beforeManifestHash: before.manifest.contentHash }),
      ...(after?.manifest.contentHash === undefined
        ? {}
        : { afterManifestHash: after.manifest.contentHash }),
      detail:
        failure === undefined
          ? "Compared accepted local inventories and feature-manifest hashes before own analysis and after external calls. This is not an atomic snapshot or proof of a remote analysis revision."
          : `The final local source check failed: ${failure}`,
      nextStep,
    },
    externalEvidence: outcomes.map(({ extensionId, result }) => {
      const bindings: ScanFeatureContext["externalEvidence"][number]["bindings"] = [
        ...result.measurements.map((measurement, index) => ({
          kind: "measurement" as const,
          index,
          relation:
            measurement.signal?.scope === "repository"
              ? ("repository_context" as const)
              : measurement.signal === undefined || measurement.filePath === undefined
                ? ("unscoped" as const)
                : selected.has(measurement.filePath)
                  ? ("declared_feature_file" as const)
                  : ("other_file" as const),
          ...(measurement.filePath === undefined ? {} : { filePath: measurement.filePath }),
          ...sharedContext(measurement.filePath),
        })),
        ...result.findings.map((finding, index) => ({
          kind: "finding" as const,
          index,
          relation: selected.has(finding.filePath)
            ? ("declared_feature_file" as const)
            : ("other_file" as const),
          filePath: finding.filePath,
          ...sharedContext(finding.filePath),
        })),
      ];
      return {
        extensionId,
        runId: result.run.runId,
        status:
          feature === undefined
            ? "no_feature_boundary"
            : status === "changed"
              ? "source_changed"
              : status === "unverified"
                ? "source_unverified"
                : result.run.exitStatus !== "completed" || bindings.length === 0
                  ? "not_measured"
                  : "available",
        analyzerSourceIdentity: "not_independently_proven",
        bindings,
        nextStep:
          bindings.length === 0
            ? "Inspect run errors, skips, output mapping and configured analyzer target; empty output is not a passed feature check."
            : "Use file bindings as declared context only; verify the analyzer project/revision, corpus and metric definition before drawing conclusions.",
      };
    }),
    limitations: [
      "No external measurement is added, compared or attributed as a feature total. Repository measurements remain repository context.",
      "A file binding follows the declared feature map and can belong to several features; it does not prove feature ownership or semantic conformance.",
      "The local digest covers the accepted product inventory, not excluded files or an external server's source revision. Equal request-time inventories do not prove fresh remote measures.",
      "No enabled analyzer or no evidence means not measured, never zero complexity or a passed quality gate.",
    ],
  };
}

function unstableInventory(report: ProductAlignmentReportV1): boolean {
  return (
    report.inventory.truncated ||
    report.issues.some(
      (issue) => issue.startsWith("Accepted source") || issue.startsWith("Accepted inventory"),
    )
  );
}

export function renderScanFeature(io: Io, context: ScanFeatureContext): void {
  line(io, "\n# Declared feature — own analysis, responsibility and evidence");
  line(io, formatProductReport(context.report));
  if (context.report.features.length === 0) {
    line(
      io,
      `Feature ${context.requestedFeatureId} was not resolved. Review untangle.features.json and run untangle product.`,
    );
  }
  line(io, `Local source binding: ${context.sourceBinding.status}`);
  line(io, `  ${context.sourceBinding.detail}`);
  if (context.sourceBinding.status !== "unchanged")
    line(io, `  Action: ${context.sourceBinding.nextStep}`);
  if (context.externalEvidence.length === 0)
    line(
      io,
      "External feature evidence: not measured; inspect untangle extensions list/status and explicitly configure the desired analyzer.",
    );
  for (const evidence of context.externalEvidence) {
    line(
      io,
      `  ${evidence.extensionId}: ${evidence.status}; analyzer source identity: ${evidence.analyzerSourceIdentity}`,
    );
    for (const binding of evidence.bindings)
      line(
        io,
        `    ${binding.kind}[${binding.index}]: ${binding.relation}${binding.filePath === undefined ? "" : ` — ${binding.filePath}`}`,
      );
    for (const binding of evidence.bindings)
      if (binding.sharedWithFeatures !== undefined)
        line(
          io,
          `    Shared file: ${binding.filePath}; features ${binding.sharedWithFeatures.join(", ")}`,
        );
    line(io, `    Action: ${evidence.nextStep}`);
  }
  for (const limitation of context.limitations) line(io, `Limit: ${limitation}`);
  for (const nextStep of context.nextSteps) line(io, `Action: ${nextStep}`);
}
