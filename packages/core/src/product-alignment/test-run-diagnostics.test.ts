import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseVitestProductReport } from "./test-run.js";

const root = path.resolve("/private/untangle-diagnostic-project");
const file = "tests/feature.test.ts";
const statuses = ["passed", "failed", "pending", "todo", "skipped", "disabled"] as const;
type Status = (typeof statuses)[number];
interface Case {
  fullName: string;
  status: Status;
}

function report(suites: { file: string; cases: Case[] }[]): string {
  const cases = suites.flatMap((suite) => suite.cases);
  const failedSuites = suites.filter((suite) =>
    suite.cases.some((item) => item.status === "failed"),
  ).length;
  return JSON.stringify({
    success: failedSuites === 0,
    numTotalTestSuites: suites.length,
    numPassedTestSuites: suites.length - failedSuites,
    numFailedTestSuites: failedSuites,
    numPendingTestSuites: 0,
    numTotalTests: cases.length,
    numPassedTests: cases.filter((item) => item.status === "passed").length,
    numFailedTests: cases.filter((item) => item.status === "failed").length,
    numPendingTests: cases.filter((item) => !["passed", "failed", "todo"].includes(item.status))
      .length,
    numTodoTests: cases.filter((item) => item.status === "todo").length,
    numRuntimeErrorTestSuites: 0,
    testResults: suites.map((suite) => ({
      name: path.join(root, suite.file),
      status: suite.cases.some((item) => item.status === "failed") ? "failed" : "passed",
      message: "",
      assertionResults: suite.cases,
    })),
  });
}

describe("Vitest product-report identity diagnostics", () => {
  it.each(statuses)("still rejects a same-file duplicate with second status %s", (status) => {
    const fullName = "Calendar dates accepts a value";
    const input = report([
      {
        file,
        cases: [
          { fullName, status: "passed" },
          { fullName, status },
        ],
      },
    ]);
    expect(() => parseVitestProductReport(input, root, new Set([file]))).toThrowError(
      new Error(
        `Duplicate Vitest test identity in ${JSON.stringify(file)}: ${JSON.stringify(fullName)}. Use a unique test title; for it.each, include the row index or distinguishing parameters in the title.`,
      ),
    );
  });

  it("accepts the same full name in different accepted files without rewriting identities", () => {
    const otherFile = "tests/another-feature.test.ts";
    const fullName = "Shared behavior returns the expected result";
    const input = report([
      { file, cases: [{ fullName, status: "passed" }] },
      { file: otherFile, cases: [{ fullName, status: "failed" }] },
    ]);
    expect(parseVitestProductReport(input, root, new Set([file, otherFile]))).toEqual([
      { path: file, name: fullName, status: "passed" },
      { path: otherFile, name: fullName, status: "failed" },
    ]);
  });

  it("quotes the duplicate identity, escapes control characters and omits the absolute project root", () => {
    const fullName = 'Calendar "quoted"\nrow\twith\u0000control';
    const input = report([
      {
        file,
        cases: [
          { fullName, status: "passed" },
          { fullName, status: "passed" },
        ],
      },
    ]);
    let message = "";
    try {
      parseVitestProductReport(input, root, new Set([file]));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message = error.message;
    }
    expect(message).toContain(JSON.stringify(file));
    expect(message).toContain(JSON.stringify(fullName));
    expect(message).not.toContain(root);
    expect(Array.from(message).every((character) => character.charCodeAt(0) >= 32)).toBe(true);
  });

  it("keeps the 100000-case boundary and gives overflow its own diagnostic", () => {
    const cases: Case[] = Array.from({ length: 100_000 }, (_, index) => ({
      fullName: `Unique parameter row ${index}`,
      status: "passed",
    }));
    expect(parseVitestProductReport(report([{ file, cases }]), root, new Set([file]))).toHaveLength(
      100_000,
    );
    cases.push({ fullName: "Unique parameter row 100000", status: "passed" });
    expect(() =>
      parseVitestProductReport(report([{ file, cases }]), root, new Set([file])),
    ).toThrowError(new Error("Vitest case limit exceeded (100000)."));
  });
});
