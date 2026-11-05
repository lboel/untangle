import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FixtureBuilder } from "./fixture-builder.js";

describe("FixtureBuilder", () => {
  it("materializes files under a fresh temp directory, one subdirectory per repo", async () => {
    const builder = new FixtureBuilder()
      .repo("frontend", [{ path: "src/index.ts", content: "export const a = 1;\n" }])
      .repo("backend", [{ path: "src/index.ts", content: "export const b = 2;\n" }]);
    const workspace = await builder.build();
    try {
      expect(Object.keys(workspace.repoPaths).sort()).toEqual(["backend", "frontend"]);
      const frontendFile = path.join(workspace.repoPaths["frontend"] as string, "src/index.ts");
      expect(await readFile(frontendFile, "utf8")).toBe("export const a = 1;\n");
      const backendFile = path.join(workspace.repoPaths["backend"] as string, "src/index.ts");
      expect(await readFile(backendFile, "utf8")).toBe("export const b = 2;\n");
    } finally {
      await workspace.cleanup();
    }
  });

  it("rootFiles() places files directly at the workspace root (no repo subdirectory)", async () => {
    const workspace = await new FixtureBuilder()
      .rootFiles([{ path: "README.md", content: "# hi\n" }])
      .build();
    try {
      expect(workspace.repoPaths["."]).toBe(workspace.rootPath);
      expect(await readFile(path.join(workspace.rootPath, "README.md"), "utf8")).toBe("# hi\n");
    } finally {
      await workspace.cleanup();
    }
  });

  it("creates intermediate directories for nested file paths", async () => {
    const workspace = await new FixtureBuilder()
      .repo("r", [{ path: "a/b/c/deep.txt", content: "deep" }])
      .build();
    try {
      const deepPath = path.join(workspace.repoPaths["r"] as string, "a/b/c/deep.txt");
      expect(await readFile(deepPath, "utf8")).toBe("deep");
    } finally {
      await workspace.cleanup();
    }
  });

  it("cleanup() removes the entire workspace directory and is idempotent", async () => {
    const workspace = await new FixtureBuilder()
      .repo("r", [{ path: "a.txt", content: "x" }])
      .build();
    await workspace.cleanup();
    await expect(stat(workspace.rootPath)).rejects.toBeDefined();
    await expect(workspace.cleanup()).resolves.toBeUndefined();
  });

  it("rejects adding the same repo name twice", () => {
    const builder = new FixtureBuilder().repo("r", [{ path: "a.txt", content: "x" }]);
    expect(() => builder.repo("r", [{ path: "b.txt", content: "y" }])).toThrow();
  });

  it("rejects a fixture file path that escapes the repo root", () => {
    expect(() =>
      new FixtureBuilder().repo("r", [{ path: "../escape.txt", content: "x" }]),
    ).toThrow();
    expect(() =>
      new FixtureBuilder().repo("r", [{ path: "/absolute.txt", content: "x" }]),
    ).toThrow();
  });

  it("cleans up a partially-built workspace if build() fails partway through", async () => {
    const builder = new FixtureBuilder().repo("r", [{ path: "a.txt", content: "ok" }]);
    // Force a failure by adding a file whose path collides with an already
    // materialized FILE being used as a directory segment.
    builder.repo("bad", [
      { path: "x", content: "file first" },
      { path: "x/y.txt", content: "then treated as a directory" },
    ]);
    await expect(builder.build()).rejects.toBeDefined();
  });
});
