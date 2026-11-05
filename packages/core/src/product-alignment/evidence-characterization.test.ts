import type { ProductFeatureV1, ProductTestEvidenceV1 } from "@untangle-code/domain";
import { describe, expect, it, vi } from "vitest";

import { productFeatureTests } from "./evidence.js";
import type { LoadedProductTests } from "./evidence.js";

const FIRST = "src/search.test.ts";
const SECOND = "src/cancellation.test.ts";
const OUTSIDE = "src/unrelated.test.ts";
const PATHS = [FIRST, SECOND];

function feature(tests = [FIRST], testNames?: string[]): ProductFeatureV1 {
  return {
    id: "feature.search",
    title: "Search",
    stage: "implemented",
    review: "proposed",
    intent: [],
    owners: ["role.search"],
    code: { include: ["src/search.ts"] },
    tests: { include: ["src/*.test.ts"] },
    criteria: [
      {
        id: "search-contract",
        description: "Selected search regressions pass",
        tests,
        ...(testNames === undefined ? {} : { testNames }),
      },
    ],
    dependsOn: [],
  };
}

function bound(
  tests: ProductTestEvidenceV1["tests"],
  exitCode = 0,
): LoadedProductTests & { evidence: ProductTestEvidenceV1 } {
  return {
    status: "bound",
    evidence: {
      schemaVersion: 1,
      sourceTreeBefore: "a".repeat(64),
      sourceTreeAfter: "a".repeat(64),
      command: ["vitest", "run"],
      exitCode,
      tests,
    },
  };
}

describe("product feature test evidence characterization", () => {
  it.each(["not_run", "stale", "invalid"] as const)(
    "keeps matching criteria not_run when execution evidence is %s",
    (status) => {
      const result = productFeatureTests(feature(), [FIRST], {
        status,
        evidence: null,
        issue: "Execution is not bound to the current source tree.",
      });

      expect(result).toEqual({
        testEvidence: { status, passed: 0, failed: 0, skipped: 0, proof: "none" },
        criteria: [
          {
            id: "search-contract",
            description: "Selected search regressions pass",
            matchedFiles: [FIRST],
            status: "not_run",
          },
        ],
      });
    },
  );

  it.each(["not_run", "stale", "invalid"] as const)(
    "reports empty and unresolved selectors before unavailable %s evidence",
    (status) => {
      const declaration = feature([]);
      declaration.criteria.push({
        id: "unresolved-contract",
        description: "Every selector resolves",
        tests: [FIRST, "src/missing.test.ts"],
      });

      const result = productFeatureTests(declaration, [FIRST], { status, evidence: null });

      expect(result.testEvidence).toEqual({
        status,
        passed: 0,
        failed: 0,
        skipped: 0,
        proof: "none",
      });
      expect(result.criteria).toEqual([
        {
          id: "search-contract",
          description: "Selected search regressions pass",
          matchedFiles: [],
          status: "missing_tests",
        },
        {
          id: "unresolved-contract",
          description: "Every selector resolves",
          matchedFiles: [FIRST],
          status: "missing_tests",
        },
      ]);
    },
  );

  it("keeps missing selectors missing despite a failed runner and selected failures", () => {
    const declaration = feature([FIRST, "src/missing.test.ts"]);
    declaration.criteria.push({ id: "empty", description: "Empty selection", tests: [] });
    const result = productFeatureTests(
      declaration,
      [FIRST],
      bound([{ path: FIRST, name: "exact", status: "failed" }], 2),
    );

    expect(result.testEvidence).toEqual({
      status: "bound_failed",
      passed: 0,
      failed: 1,
      skipped: 0,
      proof: "supplied_source_bound_report",
    });
    expect(result.criteria.map((criterion) => criterion.status)).toEqual([
      "missing_tests",
      "missing_tests",
    ]);
  });

  it.each([
    {
      label: "passing selected tests",
      tests: [{ path: FIRST, name: "exact", status: "passed" as const }],
    },
    { label: "no selected execution", tests: [] },
  ])("does not green $label when the runner exits unsuccessfully", ({ tests }) => {
    const result = productFeatureTests(feature(), [FIRST], bound(tests, 2));

    expect(result.testEvidence.status).toBe("bound_failed");
    expect(result.criteria[0]!.status).toBe("failed");
  });

  it("reports a selected failure before missing required case names or files", () => {
    const result = productFeatureTests(
      feature(["src/*.test.ts"], ["exact", "cancellation"]),
      PATHS,
      bound([{ path: FIRST, name: "exact", status: "failed" }]),
    );

    expect(result.testEvidence.status).toBe("bound_failed");
    expect(result.criteria[0]).toEqual({
      id: "search-contract",
      description: "Selected search regressions pass",
      matchedFiles: [SECOND, FIRST],
      status: "failed",
    });
  });

  it("leaves skipped selected execution unverified even when all files have cases", () => {
    const result = productFeatureTests(
      feature(["src/*.test.ts"]),
      PATHS,
      bound([
        { path: FIRST, name: "exact", status: "passed" },
        { path: SECOND, name: "cancellation", status: "skipped" },
      ]),
    );

    expect(result.testEvidence).toEqual({
      status: "not_run",
      passed: 1,
      failed: 0,
      skipped: 1,
      proof: "supplied_source_bound_report",
    });
    expect(result.criteria[0]!.status).toBe("unverified");
  });

  it("does not infer execution for an existing selected file with no supplied cases", () => {
    const result = productFeatureTests(feature(), [FIRST], bound([]));

    expect(result.testEvidence).toEqual({
      status: "not_run",
      passed: 0,
      failed: 0,
      skipped: 0,
      proof: "supplied_source_bound_report",
    });
    expect(result.criteria[0]!.status).toBe("unverified");
  });

  it("requires execution in every selected file even when every requested name exists", () => {
    const result = productFeatureTests(
      feature(["src/*.test.ts"], ["exact", "cancellation"]),
      PATHS,
      bound([
        { path: FIRST, name: "exact", status: "passed" },
        { path: FIRST, name: "cancellation", status: "passed" },
      ]),
    );

    expect(result.testEvidence.status).toBe("not_run");
    expect(result.criteria[0]!.status).toBe("unverified");
  });

  it("requires every requested name even when every selected file has execution", () => {
    const result = productFeatureTests(
      feature(["src/*.test.ts"], ["exact", "cancellation"]),
      PATHS,
      bound([
        { path: FIRST, name: "exact", status: "passed" },
        { path: SECOND, name: "exact", status: "passed" },
      ]),
    );

    expect(result.testEvidence.status).toBe("bound_passed");
    expect(result.criteria[0]!.status).toBe("unverified");
  });

  it("accepts requested names spread across selected files without requiring their Cartesian product", () => {
    const result = productFeatureTests(
      feature(["src/*.test.ts"], ["exact", "cancellation"]),
      PATHS,
      bound([
        { path: FIRST, name: "exact", status: "passed" },
        { path: SECOND, name: "cancellation", status: "passed" },
      ]),
    );

    expect(result.testEvidence.status).toBe("bound_passed");
    expect(result.criteria[0]!.status).toBe("passed");
  });

  it("keeps exact criterion selection separate from the feature aggregate and unrelated files", () => {
    const result = productFeatureTests(
      feature([FIRST], ["exact"]),
      PATHS,
      bound([
        { path: FIRST, name: "exact", status: "passed" },
        { path: FIRST, name: "exact suffix", status: "failed" },
        { path: FIRST, name: "fallback", status: "skipped" },
        { path: SECOND, name: "cancellation", status: "passed" },
        { path: OUTSIDE, name: "exact", status: "failed" },
      ]),
    );

    expect(result).toEqual({
      testEvidence: {
        status: "bound_failed",
        passed: 2,
        failed: 1,
        skipped: 1,
        proof: "supplied_source_bound_report",
      },
      criteria: [
        {
          id: "search-contract",
          description: "Selected search regressions pass",
          matchedFiles: [FIRST],
          status: "passed",
        },
      ],
    });
  });

  it("leaves absent exact names unverified when only a near-matching name failed", () => {
    const result = productFeatureTests(
      feature([FIRST], ["exact"]),
      [FIRST],
      bound([{ path: FIRST, name: "exact suffix", status: "failed" }]),
    );

    expect(result.testEvidence.status).toBe("bound_failed");
    expect(result.criteria[0]!.status).toBe("unverified");
  });

  it("preserves declaration order, sorted matched path multiplicity and all input values", () => {
    const declaration = feature(["src/*.test.ts", FIRST], ["exact", "cancellation"]);
    declaration.criteria.push({
      id: "first-only",
      description: "Only exact search",
      tests: [FIRST],
      testNames: ["exact"],
    });
    const paths = [FIRST, SECOND, FIRST];
    const loaded = bound([
      { path: FIRST, name: "exact", status: "passed" },
      { path: SECOND, name: "cancellation", status: "passed" },
    ]);
    const original = structuredClone({ declaration, paths, loaded });
    Object.freeze(paths);
    Object.freeze(loaded.evidence.tests);
    for (const criterion of declaration.criteria) {
      Object.freeze(criterion.tests);
      Object.freeze(criterion.testNames);
      Object.freeze(criterion);
    }
    Object.freeze(declaration.criteria);

    const expected = {
      testEvidence: {
        status: "bound_passed",
        passed: 2,
        failed: 0,
        skipped: 0,
        proof: "supplied_source_bound_report",
      },
      criteria: [
        {
          id: "search-contract",
          description: "Selected search regressions pass",
          matchedFiles: [SECOND, FIRST, FIRST],
          status: "passed",
        },
        {
          id: "first-only",
          description: "Only exact search",
          matchedFiles: [FIRST, FIRST],
          status: "passed",
        },
      ],
    };
    expect(productFeatureTests(declaration, paths, loaded)).toEqual(expected);
    expect(productFeatureTests(declaration, paths, loaded)).toEqual(expected);
    expect({ declaration, paths, loaded }).toEqual(original);
  });

  it("short-circuits runner exit reads after aggregate and selected failures", () => {
    const loaded = bound([{ path: FIRST, name: "exact", status: "failed" }]);
    const readExit = vi.fn(() => {
      throw new Error("The failing case already determines the result.");
    });
    Object.defineProperty(loaded.evidence, "exitCode", { get: readExit });

    const result = productFeatureTests(feature(), [FIRST], loaded);

    expect(result.testEvidence.status).toBe("bound_failed");
    expect(result.criteria[0]!.status).toBe("failed");
    expect(readExit).not.toHaveBeenCalled();
  });

  it("does not read the runner exit for unbound evidence with otherwise passing cases", () => {
    const loaded: LoadedProductTests = {
      ...bound([{ path: FIRST, name: "exact", status: "passed" }]),
      status: "stale",
    };
    const readExit = vi.fn(() => {
      throw new Error("Stale evidence cannot determine runner success.");
    });
    Object.defineProperty(loaded.evidence!, "exitCode", { get: readExit });

    const result = productFeatureTests(feature(), [FIRST], loaded);

    expect(result.testEvidence).toEqual({
      status: "stale",
      passed: 1,
      failed: 0,
      skipped: 0,
      proof: "none",
    });
    expect(result.criteria[0]!.status).toBe("not_run");
    expect(readExit).not.toHaveBeenCalled();
  });

  it("does not read runner exit again for missing criterion selectors", () => {
    const loaded = bound([{ path: FIRST, name: "exact", status: "passed" }]);
    const readExit = vi.fn(() => 0);
    Object.defineProperty(loaded.evidence, "exitCode", { get: readExit });

    const result = productFeatureTests(feature(["src/missing.test.ts"]), [FIRST], loaded);

    expect(result.testEvidence.status).toBe("bound_passed");
    expect(result.criteria[0]!.status).toBe("missing_tests");
    expect(readExit).toHaveBeenCalledTimes(1);
  });

  it("propagates a runner exit read failure when successful cases need that evidence", () => {
    const loaded = bound([{ path: FIRST, name: "exact", status: "passed" }]);
    const failure = new Error("Runner evidence read failed");
    const readExit = vi.fn(() => {
      throw failure;
    });
    Object.defineProperty(loaded.evidence, "exitCode", { get: readExit });

    expect(() => productFeatureTests(feature(), [FIRST], loaded)).toThrow(failure);
    expect(readExit).toHaveBeenCalledTimes(1);
  });
});
