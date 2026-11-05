import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  discoverConfigFile,
  discoverConfigFiles,
  LOCAL_CONFIG_FILE_NAME,
  PROJECT_CONFIG_FILE_NAME,
  PROJECT_FOLDER_CONFIG_FILE_NAME,
  PROJECT_TOML_CONFIG_FILE_NAME,
} from "./discovery.js";

describe("discoverConfigFile", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "untangle-config-discovery-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds the config file in the start directory itself", () => {
    writeFileSync(join(root, PROJECT_CONFIG_FILE_NAME), "{}");
    expect(discoverConfigFile(root, PROJECT_CONFIG_FILE_NAME)).toBe(
      join(root, PROJECT_CONFIG_FILE_NAME),
    );
  });

  it("finds the config file several directories up (nested start path)", () => {
    const nested = join(root, "packages", "app", "src", "deep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, PROJECT_CONFIG_FILE_NAME), "{}");
    expect(discoverConfigFile(nested, PROJECT_CONFIG_FILE_NAME)).toBe(
      join(root, PROJECT_CONFIG_FILE_NAME),
    );
  });

  it("stops at a repository root (.git) and does not search above it", () => {
    const repoRoot = join(root, "repo");
    const nested = join(repoRoot, "src");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repoRoot, ".git"));
    // Config file lives ABOVE the repo root — must not be found.
    writeFileSync(join(root, PROJECT_CONFIG_FILE_NAME), "{}");
    expect(discoverConfigFile(nested, PROJECT_CONFIG_FILE_NAME)).toBeUndefined();
  });

  it("still finds a config file that sits exactly at the repository root", () => {
    const repoRoot = join(root, "repo");
    const nested = join(repoRoot, "src");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repoRoot, ".git"));
    writeFileSync(join(repoRoot, PROJECT_CONFIG_FILE_NAME), "{}");
    expect(discoverConfigFile(nested, PROJECT_CONFIG_FILE_NAME)).toBe(
      join(repoRoot, PROJECT_CONFIG_FILE_NAME),
    );
  });

  it("returns undefined when nothing is found up to the filesystem root", () => {
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(discoverConfigFile(nested, PROJECT_CONFIG_FILE_NAME)).toBeUndefined();
  });
});

describe("discoverConfigFiles", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "untangle-config-discovery-both-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("discovers project and local config files independently", () => {
    writeFileSync(join(root, PROJECT_CONFIG_FILE_NAME), "{}");
    writeFileSync(join(root, LOCAL_CONFIG_FILE_NAME), "{}");
    const result = discoverConfigFiles(root);
    expect(result.projectConfigPath).toBe(join(root, PROJECT_CONFIG_FILE_NAME));
    expect(result.localConfigPath).toBe(join(root, LOCAL_CONFIG_FILE_NAME));
  });

  it.each([".", "packages/app/src", ".untangle"])(
    "finds the folder layout from %s without treating metadata as the project root",
    (start) => {
      mkdirSync(join(root, ".untangle"));
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, start), { recursive: true });
      writeFileSync(join(root, PROJECT_FOLDER_CONFIG_FILE_NAME), "{}");
      expect(discoverConfigFiles(join(root, start))).toMatchObject({
        projectConfigPath: join(root, PROJECT_FOLDER_CONFIG_FILE_NAME),
        projectRoot: root,
      });
    },
  );

  it("keeps legacy project JSON ahead of the folder layout", () => {
    mkdirSync(join(root, ".untangle"));
    writeFileSync(join(root, PROJECT_FOLDER_CONFIG_FILE_NAME), "{}");
    writeFileSync(join(root, PROJECT_CONFIG_FILE_NAME), "{}");
    const result = discoverConfigFiles(root);
    expect(result.projectConfigPath).toBe(join(root, PROJECT_CONFIG_FILE_NAME));
    expect(result.projectRoot).toBeUndefined();
  });

  it("keeps legacy TOML ahead of the folder layout", () => {
    mkdirSync(join(root, ".untangle"));
    writeFileSync(join(root, PROJECT_FOLDER_CONFIG_FILE_NAME), "{}");
    writeFileSync(join(root, PROJECT_TOML_CONFIG_FILE_NAME), "schemaVersion = 1\n");
    const result = discoverConfigFiles(root);
    expect(result.projectConfigPath).toBeUndefined();
    expect(result.tomlConfigPath).toBe(join(root, PROJECT_TOML_CONFIG_FILE_NAME));
    expect(result.projectRoot).toBeUndefined();
  });

  it("keeps local overrides discoverable with the folder layout", () => {
    mkdirSync(join(root, ".untangle"));
    writeFileSync(join(root, PROJECT_FOLDER_CONFIG_FILE_NAME), "{}");
    writeFileSync(join(root, LOCAL_CONFIG_FILE_NAME), "{}");
    expect(discoverConfigFiles(root)).toMatchObject({
      projectConfigPath: join(root, PROJECT_FOLDER_CONFIG_FILE_NAME),
      localConfigPath: join(root, LOCAL_CONFIG_FILE_NAME),
      projectRoot: root,
    });
  });

  it.each(["directory", "file"])(
    "does not discover a parent folder config across a Git %s boundary",
    (kind) => {
      mkdirSync(join(root, ".untangle"));
      writeFileSync(join(root, PROJECT_FOLDER_CONFIG_FILE_NAME), "{}");
      const repository = join(root, "child");
      const start = join(repository, "src");
      mkdirSync(start, { recursive: true });
      if (kind === "directory") mkdirSync(join(repository, ".git"));
      else writeFileSync(join(repository, ".git"), "gitdir: /external/worktree\n");
      const result = discoverConfigFiles(start);
      expect(result.projectConfigPath).toBeUndefined();
      expect(result.projectRoot).toBeUndefined();
    },
  );

  it("ignores a directory named config.json", () => {
    mkdirSync(join(root, PROJECT_FOLDER_CONFIG_FILE_NAME), { recursive: true });
    expect(discoverConfigFiles(root).projectConfigPath).toBeUndefined();
  });
});
