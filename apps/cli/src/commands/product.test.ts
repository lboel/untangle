import type { ProductAlignmentReportV1 } from "@untangle-code/domain";
import { describe, expect, it, vi } from "vitest";

import { parseArgs } from "../cli/args.js";
import { renderCommandHelp, type CommandContext } from "../cli/command.js";
import { EXIT } from "../cli/exit.js";
import { BufferIo } from "../cli/io.js";

import { createProductCommand, formatProductReport, productOptionsFrom } from "./product.js";

function report(
  status: ProductAlignmentReportV1["status"] = "needs_review",
): ProductAlignmentReportV1 {
  return {
    schemaVersion: 1,
    root: "/workspace/product",
    status,
    manifest: { path: "untangle.features.json", status: "loaded", contentHash: "a".repeat(64) },
    sourceTreeDigest: "b".repeat(64),
    inventory: { files: 4, truncated: false, excluded: 1 },
    semanticConformance: "not_independently_proven",
    ownershipAuthority: "manifest_declarations",
    features: [
      {
        id: "search.local",
        title: "Local search",
        stage: "implemented",
        review: "proposed",
        status: "needs_review",
        intent: [{ role: "vision", path: "vision.md", heading: "Search", status: "resolved" }],
        ownership: [{ id: "search-team", status: "declared", sources: [] }],
        code: {
          complete: true,
          files: [{ path: "src/search.ts", status: "measured", contentHash: "c".repeat(64) }],
          metrics: {
            metricsVersion: "untangle-metrics-v1",
            cognitiveAlgorithm: "sonar-cognitive-v1",
            cognitive: { execution_unit: 6, self: 4, top_level: 2 },
            cyclomaticClassic: { execution_unit: 3, self: 2, top_level: 1 },
            cyclomaticExtended: { execution_unit: 3, self: 2, top_level: 1 },
            files: 1,
            scopes: 2,
            executionUnitRoots: 1,
            sloc: 12,
            cyclomaticPerScopeBase: 1,
          },
          hotspots: [],
        },
        tests: { complete: true, files: [], metrics: null },
        testEvidence: { status: "not_run", passed: 0, failed: 0, skipped: 0, proof: "none" },
        criteria: [
          {
            id: "find",
            description: "Find the declared target",
            matchedFiles: [],
            status: "not_run",
          },
        ],
        dimensions: {
          requirements: 1,
          owners: 1,
          codeFiles: 1,
          testFiles: 0,
          sharedCodeFiles: 0,
          declaredDependencies: 0,
          dependentFeatures: 0,
        },
        dependsOn: [],
        agentHints: [
          {
            code: "TEST_EVIDENCE_MISSING",
            severity: "warning",
            message: "Tests were located but not run.",
            paths: ["src/search.test.ts"],
            suggestedAction: "Supply a source-bound test report.",
            search: { symbol: "localSearch", path: "src/search.ts", requireFresh: true },
          },
        ],
        issues: ["Feature review is proposed."],
      },
    ],
    coverage: {
      measuredCodeFiles: 1,
      mappedCodeFiles: 1,
      unmappedCodeFiles: [],
      unmappedCodeFileCount: 0,
      sharedFiles: [],
      mappedCodeUnion: null,
    },
    dependencyCycles: [],
    issues: [],
    limitations: ["Manifest declarations do not independently prove semantic conformance."],
    draft: null,
  };
}

function context(signal = new AbortController().signal): CommandContext & { io: BufferIo } {
  return { cwd: "/caller", env: {}, signal, io: new BufferIo() };
}

describe("product CLI adapter", () => {
  it("resolves manifest and evidence against the selected project and preserves the caller feature key", () => {
    const command = createProductCommand();
    const signal = new AbortController().signal;
    const parsed = parseArgs(
      [
        "--root=/workspace/product",
        "--manifest=plans/map.json",
        "--test-evidence=checks/run.json",
        "--feature=search.local",
      ],
      command.spec.flags,
    );
    expect(productOptionsFrom(parsed, "/caller", signal)).toEqual({
      root: "/workspace/product",
      manifestPath: "/workspace/product/plans/map.json",
      testEvidencePath: "/workspace/product/checks/run.json",
      featureId: "search.local",
      maxCognitive: 15,
      signal,
    });
    expect(renderCommandHelp(command.spec)).toContain("--require-complete");
    expect(renderCommandHelp(command.spec)).toContain("not independently proven");
  });

  it.each([
    "needs_manifest",
    "invalid_manifest",
    "needs_review",
    "incomplete",
    "violated",
    "evidence_consistent",
  ] as const)(
    "returns the complete %s report as JSON without converting evidence status into a command error",
    async (status) => {
      const expected = report(status);
      const analyze = vi.fn().mockResolvedValue(expected);
      const command = createProductCommand({ analyze });
      const ctx = context();
      expect(await command.run(ctx, parseArgs(["--format=json"], command.spec.flags))).toBe(
        EXIT.ok,
      );
      expect(JSON.parse(ctx.io.outText)).toEqual(expected);
      expect(ctx.io.errText).toBe("");
      expect(analyze).toHaveBeenCalledOnce();
      expect(analyze).toHaveBeenCalledWith({ root: ctx.cwd, maxCognitive: 15, signal: ctx.signal });
    },
  );

  it.each([
    "needs_manifest",
    "invalid_manifest",
    "needs_review",
    "incomplete",
    "violated",
  ] as const)(
    "gates %s under require-complete while preserving its evidence payload",
    async (status) => {
      const expected = report(status);
      const command = createProductCommand({ analyze: vi.fn().mockResolvedValue(expected) });
      const ctx = context();
      expect(
        await command.run(
          ctx,
          parseArgs(["--require-complete", "--format=json"], command.spec.flags),
        ),
      ).toBe(EXIT.gate);
      expect(JSON.parse(ctx.io.outText)).toEqual(expected);
    },
  );

  it("accepts evidence_consistent under require-complete and forwards an explicit zero threshold", async () => {
    const analyze = vi.fn().mockResolvedValue(report("evidence_consistent"));
    const command = createProductCommand({ analyze });
    const ctx = context();
    expect(
      await command.run(
        ctx,
        parseArgs(["--require-complete", "--max-cognitive=0"], command.spec.flags),
      ),
    ).toBe(EXIT.ok);
    expect(analyze.mock.calls[0]?.[0]).toMatchObject({ maxCognitive: 0 });
  });

  it("keeps review, ownership, independent metric readings, test status and actionable hints visible in text", async () => {
    const command = createProductCommand({ analyze: vi.fn().mockResolvedValue(report()) });
    const ctx = context();
    await command.run(ctx, parseArgs([], command.spec.flags));
    for (const evidence of [
      "needs_review",
      "manifest_declarations",
      "not_independently_proven",
      "search-team:declared",
      "execution_unit=6, self=4, top_level=2",
      "Test evidence: not_run",
      "Criterion find: not_run",
      "TEST_EVIDENCE_MISSING",
      "Supply a source-bound test report.",
      '"requireFresh":true',
    ])
      expect(ctx.io.outText).toContain(evidence);
    expect(ctx.io.errText).toBe("");
  });

  it("exposes incomplete inventory and an unwritten draft without introducing a semantic success claim", () => {
    const value = report("incomplete");
    value.inventory.truncated = true;
    value.draft = { schemaVersion: 1, owners: [], features: [] };
    expect(formatProductReport(value)).toContain("(truncated)");
    expect(formatProductReport(value)).toContain("Review draft (not written)");
  });

  it.each([
    { argv: ["extra"] },
    { argv: ["--max-cognitive=-1"] },
    { argv: ["--format=csv"] },
    { argv: ["--feature="] },
    { argv: ["--manifest="] },
    { argv: ["--test-evidence="] },
  ])("rejects invalid CLI arguments %j before analysis", async ({ argv }) => {
    const analyze = vi.fn().mockResolvedValue(report());
    const command = createProductCommand({ analyze });
    const ctx = context();
    await expect(command.run(ctx, parseArgs(argv, command.spec.flags))).rejects.toMatchObject({
      exitCode: EXIT.usage,
    });
    expect(analyze).not.toHaveBeenCalled();
    expect(ctx.io.outText).toBe("");
  });

  it("propagates pre-aborted and post-analysis cancellation without printing a partial report", async () => {
    const before = new AbortController();
    const reason = new Error("cancel product analysis");
    before.abort(reason);
    const never = vi.fn().mockResolvedValue(report());
    const first = createProductCommand({ analyze: never });
    const firstCtx = context(before.signal);
    await expect(first.run(firstCtx, parseArgs([], first.spec.flags))).rejects.toBe(reason);
    expect(never).not.toHaveBeenCalled();
    expect(firstCtx.io.outText).toBe("");

    const after = new AbortController();
    const second = createProductCommand({
      analyze: () => {
        after.abort(reason);
        return Promise.resolve(report());
      },
    });
    const secondCtx = context(after.signal);
    await expect(second.run(secondCtx, parseArgs([], second.spec.flags))).rejects.toBe(reason);
    expect(secondCtx.io.outText).toBe("");
  });
});
