import { describe, expect, it } from "vitest";

import type { CoverageEntry } from "./analysis.js";
import { UntangleError } from "./errors.js";
import {
  assertGenerationComplete,
  assertWithinWorkspace,
  buildDedupeKey,
  validateCoverage,
  validateGenerationCompleteness,
} from "./invariants.js";
import type { SourceRange } from "./types/common.js";

function range(startByte: number, endByte: number): SourceRange {
  return { startLine: -1, endLine: -1, startByte, endByte };
}

describe("assertWithinWorkspace", () => {
  const roots = ["/home/dev/workspace"];

  it("accepts a path inside a root and returns the resolved path", () => {
    expect(assertWithinWorkspace("/home/dev/workspace/src/a.ts", roots)).toBe(
      "/home/dev/workspace/src/a.ts",
    );
  });

  it("accepts the root itself", () => {
    expect(assertWithinWorkspace("/home/dev/workspace", roots)).toBe("/home/dev/workspace");
  });

  it("resolves relative candidates against the roots", () => {
    expect(assertWithinWorkspace("src/a.ts", roots)).toBe("/home/dev/workspace/src/a.ts");
  });

  it("rejects paths outside every root", () => {
    expect(() => assertWithinWorkspace("/etc/passwd", roots)).toThrowError(UntangleError);
    try {
      assertWithinWorkspace("/etc/passwd", roots);
    } catch (error) {
      expect((error as UntangleError).code).toBe("PATH_OUTSIDE_WORKSPACE");
    }
  });

  it("rejects lexical traversal escapes", () => {
    expect(() => assertWithinWorkspace("/home/dev/workspace/../secrets", roots)).toThrowError(
      UntangleError,
    );
    expect(() => assertWithinWorkspace("src/../../outside.ts", roots)).toThrowError(UntangleError);
  });

  it("rejects sibling directories sharing the root as a string prefix", () => {
    expect(() => assertWithinWorkspace("/home/dev/workspace-evil/a.ts", roots)).toThrowError(
      UntangleError,
    );
  });

  it("accepts a path inside any of several roots", () => {
    const multi = ["/repo/a", "/repo/b"];
    expect(assertWithinWorkspace("/repo/b/x.ts", multi)).toBe("/repo/b/x.ts");
  });

  it("handles Windows-style roots case-insensitively", () => {
    const winRoots = ["C:\\repos\\workspace"];
    expect(assertWithinWorkspace("C:\\repos\\Workspace\\src\\a.ts", winRoots)).toBe(
      "C:\\repos\\Workspace\\src\\a.ts",
    );
    expect(() => assertWithinWorkspace("C:\\repos\\other\\a.ts", winRoots)).toThrowError(
      UntangleError,
    );
    expect(() =>
      assertWithinWorkspace("C:\\repos\\workspace\\..\\other\\a.ts", winRoots),
    ).toThrowError(UntangleError);
  });

  it("fails closed with no configured roots", () => {
    expect(() => assertWithinWorkspace("/any/path", [])).toThrowError(UntangleError);
  });
});

describe("validateCoverage", () => {
  const fileRange = range(0, 100);

  it("accepts complete coverage from chunked and excluded entries", () => {
    const entries: CoverageEntry[] = [
      { range: range(0, 40), status: "chunked", chunkIds: ["c1"] },
      { range: range(40, 70), status: "excluded", exclusionReason: "generated code" },
      { range: range(70, 100), status: "chunked", chunkIds: ["c2", "c3"] },
    ];
    const result = validateCoverage(entries, fileRange);
    expect(result.complete).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("allows overlapping entries (architecture.md §14.1)", () => {
    const entries: CoverageEntry[] = [
      { range: range(0, 60), status: "chunked", chunkIds: ["c1"] },
      { range: range(50, 100), status: "chunked", chunkIds: ["c2"] },
    ];
    expect(validateCoverage(entries, fileRange).complete).toBe(true);
  });

  it("detects gaps and reports their byte ranges", () => {
    const entries: CoverageEntry[] = [
      { range: range(0, 30), status: "chunked", chunkIds: ["c1"] },
      { range: range(50, 100), status: "chunked", chunkIds: ["c2"] },
    ];
    const result = validateCoverage(entries, fileRange);
    expect(result.complete).toBe(false);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ startByte: 30, endByte: 50 });
    expect(result.issues.some((issue) => issue.kind === "gap")).toBe(true);
  });

  it("detects a trailing gap at the end of the file", () => {
    const entries: CoverageEntry[] = [{ range: range(0, 90), status: "chunked", chunkIds: ["c1"] }];
    const result = validateCoverage(entries, fileRange);
    expect(result.complete).toBe(false);
    expect(result.gaps[0]).toMatchObject({ startByte: 90, endByte: 100 });
  });

  it("flags excluded entries without a documented reason", () => {
    const entries: CoverageEntry[] = [{ range: range(0, 100), status: "excluded" }];
    const result = validateCoverage(entries, fileRange);
    expect(result.complete).toBe(false);
    expect(result.issues.some((issue) => issue.kind === "missing_exclusion_reason")).toBe(true);
  });

  it("flags chunked entries without chunk ids", () => {
    const entries: CoverageEntry[] = [{ range: range(0, 100), status: "chunked" }];
    const result = validateCoverage(entries, fileRange);
    expect(result.complete).toBe(false);
    expect(result.issues.some((issue) => issue.kind === "missing_chunk_ids")).toBe(true);
  });

  it("flags entries outside the file range", () => {
    const entries: CoverageEntry[] = [
      { range: range(0, 120), status: "chunked", chunkIds: ["c1"] },
    ];
    const result = validateCoverage(entries, fileRange);
    expect(result.complete).toBe(false);
    expect(result.issues.some((issue) => issue.kind === "out_of_range")).toBe(true);
  });

  it("treats an empty file range as trivially covered", () => {
    expect(validateCoverage([], range(0, 0)).complete).toBe(true);
  });
});

describe("generation completeness", () => {
  const completeInput = {
    generationId: "gen-1",
    plannedFileIds: ["f1", "f2"],
    confirmedFileIds: ["f2", "f1"],
    checkpointsSaved: true,
    requiredGraphs: ["file", "symbol"],
    storedGraphs: ["file", "symbol"],
    metadataStatus: "completed",
  };

  it("accepts a fully confirmed generation", () => {
    const result = validateGenerationCompleteness(completeInput);
    expect(result.complete).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(() => assertGenerationComplete(completeInput)).not.toThrow();
  });

  it("reports missing file confirmations", () => {
    const result = validateGenerationCompleteness({
      ...completeInput,
      confirmedFileIds: ["f1"],
    });
    expect(result.complete).toBe(false);
    expect(result.missingFileIds).toEqual(["f2"]);
  });

  it("reports missing graphs and checkpoints and wrong metadata status", () => {
    const result = validateGenerationCompleteness({
      ...completeInput,
      checkpointsSaved: false,
      storedGraphs: ["file"],
      metadataStatus: "in_progress",
    });
    expect(result.complete).toBe(false);
    expect(result.missingGraphs).toEqual(["symbol"]);
    expect(result.reasons).toHaveLength(3);
  });

  it("throws INDEX_INCOMPLETE from the asserting variant", () => {
    try {
      assertGenerationComplete({ ...completeInput, confirmedFileIds: [] });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UntangleError);
      expect((error as UntangleError).code).toBe("INDEX_INCOMPLETE");
      expect((error as UntangleError).context["missingFileIds"]).toEqual(["f1", "f2"]);
    }
  });
});

describe("buildDedupeKey", () => {
  const input = {
    workspaceId: "ws-1",
    repoId: "repo-1",
    refId: "repo-1:main",
    metricsScopeId: "symbol-123",
  };

  it("is deterministic", () => {
    expect(buildDedupeKey(input)).toBe(buildDedupeKey({ ...input }));
  });

  it("differs when any component differs", () => {
    expect(buildDedupeKey(input)).not.toBe(buildDedupeKey({ ...input, refId: "repo-1:dev" }));
    expect(buildDedupeKey(input)).not.toBe(
      buildDedupeKey({ ...input, metricsScopeId: "symbol-456" }),
    );
  });

  it("is immune to concatenation ambiguity across components", () => {
    const a = buildDedupeKey({ ...input, repoId: "ab", refId: "c:main" });
    const b = buildDedupeKey({ ...input, repoId: "a", refId: "bc:main" });
    expect(a).not.toBe(b);
  });

  it("rejects empty components", () => {
    expect(() => buildDedupeKey({ ...input, repoId: "" })).toThrow(/must not be empty/);
  });
});
