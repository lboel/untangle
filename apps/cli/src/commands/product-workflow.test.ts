import type { ProductAlignmentReportV1 } from "@untangle-code/domain";
import { describe, expect, it, vi } from "vitest";

import { parseArgs } from "../cli/args.js";
import { EXIT } from "../cli/exit.js";
import { BufferIo } from "../cli/io.js";

import { createProductCommand, productOptionsFrom } from "./product.js";

function report(): ProductAlignmentReportV1 {
  return {
    schemaVersion: 1,
    root: "/foreign",
    status: "needs_manifest",
    manifest: { path: "untangle.features.json", status: "missing" },
    sourceTreeDigest: "a".repeat(64),
    inventory: { files: 1, truncated: false, excluded: 0 },
    semanticConformance: "not_independently_proven",
    ownershipAuthority: "manifest_declarations",
    selection: { path: "src/lookup.ts", status: "unmapped", matches: [] },
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
    limitations: [],
    draft: { schemaVersion: 1, owners: [], features: [] },
  };
}
function context(signal = new AbortController().signal) {
  return { cwd: "/foreign", env: {}, signal, io: new BufferIo() };
}
const run = {
  status: "completed" as const,
  directory: "/tmp/capture",
  receiptPath: "/tmp/capture/receipt.json",
  exitCode: 0,
};

describe("fast declared feature workflow", () => {
  it("forwards a literal path and never starts tests implicitly", async () => {
    const analyze = vi.fn().mockResolvedValue(report());
    const runTests = vi.fn();
    const command = createProductCommand({ analyze, runTests });
    const ctx = context();
    await command.run(
      ctx,
      parseArgs(["--path=src/lookup.ts", "--format=json"], command.spec.flags),
    );
    expect(analyze.mock.calls[0]![0]).toMatchObject({ path: "src/lookup.ts" });
    expect(runTests).not.toHaveBeenCalled();
    expect(JSON.parse(ctx.io.outText).selection.status).toBe("unmapped");
  });

  it.each([
    "../outside.ts",
    "/foreign/src/lookup.ts",
    "src/**/*.ts",
    "src/./lookup.ts",
    "src\\lookup.ts",
    "",
  ])("rejects invalid literal path %j before analysis", (path) => {
    const command = createProductCommand();
    expect(() =>
      productOptionsFrom(
        parseArgs([`--path=${path}`], command.spec.flags),
        "/foreign",
        new AbortController().signal,
      ),
    ).toThrow();
  });

  it("explicitly captures tests once and immediately supplies their unchanged evidence", async () => {
    const evidence = {
      schemaVersion: 1 as const,
      sourceTreeBefore: "a".repeat(64),
      sourceTreeAfter: "a".repeat(64),
      command: ["pnpm", "exec", "vitest", "run"],
      exitCode: 0,
      tests: [{ path: "src/lookup.test.ts", name: "exact", status: "passed" as const }],
    };
    const runTests = vi.fn().mockResolvedValue({ run, evidence });
    const analyze = vi.fn().mockResolvedValue(report());
    const command = createProductCommand({ analyze, runTests });
    const ctx = context();
    expect(
      await command.run(
        ctx,
        parseArgs(
          [
            "--run-tests",
            "--test-timeout=3000",
            "--format=json",
            "--",
            "pnpm",
            "exec",
            "vitest",
            "run",
            "--passWithNoTests=false",
          ],
          command.spec.flags,
        ),
      ),
    ).toBe(EXIT.ok);
    expect(runTests).toHaveBeenCalledOnce();
    expect(runTests.mock.calls[0]![0]).toMatchObject({
      root: "/foreign",
      command: ["pnpm", "exec", "vitest", "run", "--passWithNoTests=false"],
      timeoutMs: 3000,
      signal: ctx.signal,
    });
    expect(analyze.mock.calls[0]![0].testEvidence).toBe(evidence);
    expect(JSON.parse(ctx.io.outText).testRun).toEqual(run);
  });

  it.each(["timed_out", "invalid_report", "stale", "output_limit", "spawn_failed"] as const)(
    "prints an honest incomplete report and operational exit for %s",
    async (status) => {
      const command = createProductCommand({
        analyze: vi.fn().mockResolvedValue(report()),
        runTests: vi
          .fn()
          .mockResolvedValue({ run: { ...run, status, exitCode: null }, evidence: null }),
      });
      const ctx = context();
      expect(
        await command.run(
          ctx,
          parseArgs(["--run-tests", "--format=json", "--", "vitest", "run"], command.spec.flags),
        ),
      ).toBe(EXIT.operational);
      expect(JSON.parse(ctx.io.outText)).toMatchObject({
        status: "incomplete",
        testRun: { status },
      });
    },
  );

  it("returns a failing gate for an actually completed failing test command", async () => {
    const command = createProductCommand({
      analyze: vi.fn().mockResolvedValue(report()),
      runTests: vi.fn().mockResolvedValue({ run: { ...run, exitCode: 1 }, evidence: null }),
    });
    const ctx = context();
    expect(
      await command.run(ctx, parseArgs(["--run-tests", "--", "vitest", "run"], command.spec.flags)),
    ).toBe(EXIT.gate);
  });

  it.each(
    [
      ["--run-tests"],
      ["--run-tests", "--test-evidence=existing.json", "--", "vitest", "run"],
      ["--test-timeout=1"],
      ["--run-tests", "--test-timeout=0", "--", "vitest"],
      ["--draft"],
      ["--draft", "--feature=lookup"],
      ["--draft", "--feature=lookup", "--path=src/lookup.ts", "--run-tests", "--", "vitest"],
    ].map((argv) => ({ argv })),
  )("rejects invalid or conflicting opt-ins $argv before any execution", async ({ argv }) => {
    const analyze = vi.fn();
    const runTests = vi.fn();
    const command = createProductCommand({ analyze, runTests });
    await expect(command.run(context(), parseArgs(argv, command.spec.flags))).rejects.toMatchObject(
      { exitCode: EXIT.usage },
    );
    expect(analyze).not.toHaveBeenCalled();
    expect(runTests).not.toHaveBeenCalled();
  });

  it("returns a review draft with exactly the caller's ID and path, without invented owners, intent or tests", async () => {
    const command = createProductCommand({ analyze: vi.fn().mockResolvedValue(report()) });
    const ctx = context();
    await command.run(
      ctx,
      parseArgs(
        ["--draft", "--feature=accounts.lookup", "--path=src/lookup.ts", "--format=json"],
        command.spec.flags,
      ),
    );
    expect(JSON.parse(ctx.io.outText).draft).toEqual({
      schemaVersion: 1,
      owners: [],
      features: [
        {
          id: "accounts.lookup",
          title: "accounts.lookup",
          stage: "planned",
          review: "proposed",
          intent: [],
          owners: [],
          code: { include: ["src/lookup.ts"] },
          tests: { include: [] },
          criteria: [],
          dependsOn: [],
        },
      ],
    });
    expect(ctx.io.outText).toContain("No manifest was written");
  });

  it.each(["loaded", "invalid"] as const)(
    "does not offer to replace an existing %s manifest",
    async (status) => {
      const value = report();
      value.manifest.status = status;
      const command = createProductCommand({ analyze: vi.fn().mockResolvedValue(value) });
      const ctx = context();
      await expect(
        command.run(
          ctx,
          parseArgs(
            ["--draft", "--feature=accounts.lookup", "--path=src/lookup.ts"],
            command.spec.flags,
          ),
        ),
      ).rejects.toMatchObject({ exitCode: EXIT.usage });
      expect(ctx.io.outText).toBe("");
    },
  );

  it("does not print a partial product report on cancellation, and preserves the receipt diagnostic", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel execution");
    const ctx = context(controller.signal);
    const analyze = vi.fn();
    const command = createProductCommand({
      analyze,
      runTests: async () => {
        controller.abort(reason);
        return { run: { ...run, status: "cancelled", exitCode: null }, evidence: null };
      },
    });
    await expect(
      command.run(ctx, parseArgs(["--run-tests", "--", "vitest"], command.spec.flags)),
    ).rejects.toBe(reason);
    expect(analyze).not.toHaveBeenCalled();
    expect(ctx.io.outText).toBe("");
    expect(ctx.io.errText).toContain(run.receiptPath);
  });
});
