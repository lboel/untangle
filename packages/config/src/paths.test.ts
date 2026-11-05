import { sep } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveConfigPath, resolveRepositoryPaths } from "./paths.js";

const isWindows = sep === "\\";

describe("resolveConfigPath", () => {
  it("resolves a relative path against the config file directory", () => {
    const result = resolveConfigPath("../identity", "/workspace/backend");
    expect(result).toBe("/workspace/identity");
  });

  it("resolves '.' to the config file directory itself", () => {
    expect(resolveConfigPath(".", "/workspace/backend")).toBe("/workspace/backend");
  });

  it("returns an already-absolute path canonicalized, ignoring the config dir", () => {
    expect(resolveConfigPath("/elsewhere/repo", "/workspace/backend")).toBe("/elsewhere/repo");
  });

  it("produces forward-slash output without a trailing slash", () => {
    const result = resolveConfigPath("nested/dir/", "/workspace");
    expect(result.endsWith("/")).toBe(false);
    expect(result).not.toContain("\\");
  });

  it.skipIf(!isWindows)("resolves a relative path on Windows-style separators", () => {
    expect(resolveConfigPath("..\\identity", "C:\\workspace\\backend")).toBe(
      "C:/workspace/identity",
    );
  });
});

describe("resolveRepositoryPaths", () => {
  it("resolves every repository's path without mutating the input", () => {
    const repos = [
      { id: "backend", path: "." },
      { id: "identity", path: "../identity" },
    ];
    const resolved = resolveRepositoryPaths(repos, "/workspace/backend");
    expect(resolved).toEqual([
      { id: "backend", path: "/workspace/backend" },
      { id: "identity", path: "/workspace/identity" },
    ]);
    expect(repos[0]?.path).toBe(".");
  });
});
