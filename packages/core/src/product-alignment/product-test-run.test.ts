import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectProductInventory } from "./analysis.js";
import { bindProductTests } from "./evidence.js";
import { parseVitestProductReport, runProductTests } from "./test-run.js";
import type { ProductTestProcessRequestV1, ProductTestProcessResultV1 } from "./test-run.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function vitest(root: string, status = "passed"): string {
  return JSON.stringify({
    success: status !== "failed",
    numTotalTestSuites: 1,
    numPassedTestSuites: status === "failed" ? 0 : 1,
    numFailedTestSuites: status === "failed" ? 1 : 0,
    numPendingTestSuites: 0,
    numTotalTests: 1,
    numPassedTests: status === "passed" ? 1 : 0,
    numFailedTests: status === "failed" ? 1 : 0,
    numPendingTests: status === "pending" ? 1 : 0,
    numTodoTests: status === "todo" ? 1 : 0,
    numRuntimeErrorTestSuites: 0,
    testResults: [
      {
        name: path.join(root, "lookup.test.ts"),
        status: status === "failed" ? "failed" : "passed",
        message: "",
        assertionResults: [{ fullName: "Accounts returns the exact user", status }],
      },
    ],
  });
}
async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "untangle-runner-fixture-"));
  cleanup.push(root);
  await writeFile(path.join(root, "lookup.test.ts"), "export const test = 1;");
  await writeFile(path.join(root, "lookup.ts"), "export const lookup = 1;");
  return root;
}
function executor(
  root: string,
  status = "passed",
  mutate = false,
): (request: ProductTestProcessRequestV1) => Promise<ProductTestProcessResultV1> {
  return async (request) => {
    expect(request.command.slice(0, 4)).toEqual(["pnpm", "exec", "vitest", "run"]);
    expect(request.command).toContain("--reporter=json");
    const output = request.command
      .find((arg) => arg.startsWith("--outputFile="))!
      .slice("--outputFile=".length);
    await writeFile(output, vitest(request.root, status));
    if (mutate) await writeFile(path.join(root, "new-source.ts"), "export const changed = 1;");
    return {
      status: "completed",
      exitCode: status === "failed" ? 1 : 0,
      stdout: Buffer.from("actual stdout\n"),
      stderr: Buffer.from("actual stderr\n"),
    };
  };
}

describe("explicit Vitest capture and complete source binding", () => {
  it("captures original output and hash-bound complete inventories without polluting the source census", async () => {
    const root = await project();
    const before = await collectProductInventory({ root });
    const result = await runProductTests({
      root,
      command: ["pnpm", "exec", "vitest", "run"],
      execute: executor(root),
    });
    cleanup.push(result.run.directory);
    expect(result.run.status).toBe("completed");
    expect(result.evidence).toMatchObject({
      sourceTreeBefore: before.sourceTreeDigest,
      sourceTreeAfter: before.sourceTreeDigest,
      exitCode: 0,
      tests: [
        { path: "lookup.test.ts", name: "Accounts returns the exact user", status: "passed" },
      ],
    });
    const after = await collectProductInventory({ root });
    expect(bindProductTests(after, result.evidence).status).toBe("bound");
    expect(await readFile(path.join(result.run.directory, "stdout.log"), "utf8")).toBe(
      "actual stdout\n",
    );
    const receipt = JSON.parse(await readFile(result.run.receiptPath, "utf8"));
    expect(receipt).toMatchObject({
      shell: false,
      proof: "local_runner_capture_not_authenticated",
      requestedCommand: ["pnpm", "exec", "vitest", "run"],
    });
    expect(
      JSON.parse(await readFile(path.join(result.run.directory, "before.json"), "utf8")).files,
    ).toHaveLength(2);
    for (const artifact of receipt.artifacts) {
      expect(
        createHash("sha256")
          .update(await readFile(path.join(result.run.directory, artifact.path)))
          .digest("hex"),
      ).toBe(artifact.sha256);
    }
  });

  it.each(["failed", "pending", "todo"])(
    "preserves %s results instead of manufacturing passed cases",
    async (status) => {
      const root = await project();
      const result = await runProductTests({
        root,
        command: ["pnpm", "exec", "vitest", "run"],
        execute: executor(root, status),
      });
      cleanup.push(result.run.directory);
      expect(result.run.status).toBe("completed");
      expect(result.evidence!.tests[0]!.status).toBe(status === "failed" ? "failed" : "skipped");
      expect(result.evidence!.exitCode).toBe(status === "failed" ? 1 : 0);
    },
  );

  it("marks accepted additions as stale and keeps both original inventories", async () => {
    const root = await project();
    const result = await runProductTests({
      root,
      command: ["pnpm", "exec", "vitest", "run"],
      execute: executor(root, "passed", true),
    });
    cleanup.push(result.run.directory);
    expect(result.run.status).toBe("stale");
    expect(result.evidence!.sourceTreeBefore).not.toBe(result.evidence!.sourceTreeAfter);
    expect(bindProductTests(await collectProductInventory({ root }), result.evidence).status).toBe(
      "stale",
    );
  });

  it.each(["timed_out", "output_limit", "cancelled", "spawn_failed"] as const)(
    "retains an immutable receipt for %s and accepts no evidence",
    async (status) => {
      const root = await project();
      const result = await runProductTests({
        root,
        command: ["vitest", "run"],
        execute: async () => ({
          status,
          exitCode: null,
          stdout: Buffer.from("partial"),
          stderr: new Uint8Array(),
        }),
      });
      cleanup.push(result.run.directory);
      expect(result.run.status).toBe(status);
      expect(result.evidence).toBeNull();
      expect(JSON.parse(await readFile(result.run.receiptPath, "utf8")).status).toBe(status);
    },
  );

  it("rejects a missing runner report and catches output beyond the declared port limit", async () => {
    const root = await project();
    const missing = await runProductTests({
      root,
      command: ["vitest", "run"],
      execute: async () => ({
        status: "completed",
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      }),
    });
    cleanup.push(missing.run.directory);
    expect(missing.run.status).toBe("invalid_report");
    const excessive = await runProductTests({
      root,
      command: ["vitest", "run"],
      outputLimitBytes: 8,
      execute: async () => ({
        status: "completed",
        exitCode: 0,
        stdout: new Uint8Array(9),
        stderr: new Uint8Array(),
      }),
    });
    cleanup.push(excessive.run.directory);
    expect(excessive.run.status).toBe("output_limit");
    expect((await readFile(path.join(excessive.run.directory, "stdout.log"))).byteLength).toBe(8);
  });

  it.each(
    [[], ["vitest", "run", "--outputFile=existing.json"], ["vitest", "--reporter", "json"]].map(
      (command) => ({ command }),
    ),
  )("rejects conflicting command argv $command before execution", async ({ command }) => {
    const root = await project();
    let called = false;
    await expect(
      runProductTests({
        root,
        command,
        execute: async () => {
          called = true;
          throw new Error("unexpected");
        },
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("does not invoke the executor when already cancelled", async () => {
    const controller = new AbortController();
    const reason = new Error("cancel");
    controller.abort(reason);
    await expect(
      runProductTests({
        root: await project(),
        command: ["vitest", "run"],
        signal: controller.signal,
        execute: async () => {
          throw new Error("unexpected");
        },
      }),
    ).rejects.toBe(reason);
  });

  it("rejects duplicate, outside-root, missing and inconsistent case identities", () => {
    const original = JSON.parse(vitest("/foreign"));
    const accepted = new Set(["lookup.test.ts"]);
    for (const mutate of [
      (value: typeof original) => {
        value.testResults[0].name = "/outside/lookup.test.ts";
      },
      (value: typeof original) => {
        value.testResults[0].assertionResults.push(value.testResults[0].assertionResults[0]);
      },
      (value: typeof original) => {
        value.testResults[0].assertionResults[0].fullName = "";
      },
      (value: typeof original) => {
        value.numTotalTests = 2;
      },
      (value: typeof original) => {
        value.numRuntimeErrorTestSuites = 1;
      },
      (value: typeof original) => {
        value.success = false;
      },
      (value: typeof original) => {
        value.testResults[0].status = "failed";
        value.testResults[0].message = "afterAll hook failed";
        value.success = false;
        value.numFailedTestSuites = 1;
        value.numPassedTestSuites = 0;
      },
      (value: typeof original) => {
        value.numFailedTestSuites = 1;
      },
      (value: typeof original) => {
        value.numTodoTests = 1;
      },
    ]) {
      const value = structuredClone(original);
      mutate(value);
      expect(() => parseVitestProductReport(JSON.stringify(value), "/foreign", accepted)).toThrow();
    }
  });
});
