import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "./load.js";

describe("loadConfig — six-level layering priority (spec.md §4.1)", () => {
  let root: string;
  let xdgConfigHome: string;
  let repoRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "untangle-config-load-"));
    xdgConfigHome = join(root, "xdg-config");
    repoRoot = join(root, "repo");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(join(repoRoot, ".git"));
    mkdirSync(join(xdgConfigHome, "untangle"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeUserConfig(collectionPrefix: string): void {
    mkdirSync(join(xdgConfigHome, "untangle"), { recursive: true });
    writeFileSync(
      join(xdgConfigHome, "untangle", "config.json"),
      JSON.stringify({ schemaVersion: 1, qdrant: { collectionPrefix } }),
    );
  }
  function writeProjectConfig(collectionPrefix: string): void {
    writeFileSync(
      join(repoRoot, ".untangle.json"),
      JSON.stringify({ schemaVersion: 1, qdrant: { collectionPrefix } }),
    );
  }
  function writeLocalConfig(collectionPrefix: string): void {
    writeFileSync(
      join(repoRoot, ".untangle.local.json"),
      JSON.stringify({ schemaVersion: 1, qdrant: { collectionPrefix } }),
    );
  }

  it("product defaults win when no other layer sets the field", () => {
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.effectiveConfig.qdrant.collectionPrefix).toBe("untangle_");
    expect(result.errors).toEqual([]);
  });

  it("user config (OS config dir) beats product defaults", () => {
    writeUserConfig("user_");
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.effectiveConfig.qdrant.collectionPrefix).toBe("user_");
  });

  it(".untangle.json beats user config", () => {
    writeUserConfig("user_");
    writeProjectConfig("project_");
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.effectiveConfig.qdrant.collectionPrefix).toBe("project_");
  });

  it(".untangle.local.json beats .untangle.json", () => {
    writeUserConfig("user_");
    writeProjectConfig("project_");
    writeLocalConfig("local_");
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.effectiveConfig.qdrant.collectionPrefix).toBe("local_");
  });

  it("an UNTANGLE_* environment variable beats .untangle.local.json", () => {
    writeUserConfig("user_");
    writeProjectConfig("project_");
    writeLocalConfig("local_");
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome, UNTANGLE_QDRANT_COLLECTION_PREFIX: "env_" },
      platform: "linux",
    });
    expect(result.effectiveConfig.qdrant.collectionPrefix).toBe("env_");
  });

  it("an explicit argument beats everything, including the environment", () => {
    writeUserConfig("user_");
    writeProjectConfig("project_");
    writeLocalConfig("local_");
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome, UNTANGLE_QDRANT_COLLECTION_PREFIX: "env_" },
      platform: "linux",
      explicit: { qdrant: { collectionPrefix: "explicit_" } },
    });
    expect(result.effectiveConfig.qdrant.collectionPrefix).toBe("explicit_");
  });

  it("discovers .untangle.json from a deeply nested working directory", () => {
    writeProjectConfig("project_");
    const nested = join(repoRoot, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });
    const result = loadConfig({
      cwd: nested,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.sources.projectConfigPath).toBe(join(repoRoot, ".untangle.json"));
    expect(result.effectiveConfig.qdrant.collectionPrefix).toBe("project_");
  });

  it.each([".", "packages/app/src", ".untangle"])(
    "loads folder config from %s with separate project and path-resolution roots",
    (start) => {
      mkdirSync(join(repoRoot, ".untangle"));
      mkdirSync(join(repoRoot, start), { recursive: true });
      writeFileSync(
        join(repoRoot, ".untangle", "config.json"),
        JSON.stringify({
          schemaVersion: 1,
          workspaceId: "toolkin-local",
          repositories: [{ id: "toolkin", path: ".." }],
          contextArtifacts: [{ name: "product", path: "../PRODUCT.md", kind: "document" }],
        }),
      );
      const result = loadConfig({
        cwd: join(repoRoot, start),
        env: { XDG_CONFIG_HOME: xdgConfigHome },
        platform: "linux",
      });
      expect(result.errors).toEqual([]);
      expect(result.sources.projectConfigPath).toBe(join(repoRoot, ".untangle", "config.json"));
      expect(result.sources.configBaseDir).toBe(join(repoRoot, ".untangle"));
      expect(result.sources.projectRoot).toBe(repoRoot);
      expect(result.effectiveConfig.repositories).toEqual([{ id: "toolkin", path: repoRoot }]);
      expect(result.effectiveConfig.contextArtifacts?.[0]?.path).toBe(join(repoRoot, "PRODUCT.md"));
    },
  );

  it("applies local overrides from their own directory above folder config", () => {
    mkdirSync(join(repoRoot, ".untangle"));
    writeFileSync(
      join(repoRoot, ".untangle", "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        repositories: [{ id: "toolkin", path: ".." }],
        qdrant: { collectionPrefix: "folder_" },
      }),
    );
    writeFileSync(
      join(repoRoot, ".untangle.local.json"),
      JSON.stringify({
        repositories: [{ id: "override", path: "packages/override" }],
        qdrant: { collectionPrefix: "local_" },
      }),
    );
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.sources.configBaseDir).toBe(join(repoRoot, ".untangle"));
    expect(result.sources.projectRoot).toBe(repoRoot);
    expect(result.effectiveConfig.repositories).toEqual([
      { id: "override", path: join(repoRoot, "packages", "override") },
    ]);
    expect(result.effectiveConfig.qdrant.collectionPrefix).toBe("local_");
  });

  it.each([".untangle.json", "untangle.toml"])(
    "preserves legacy %s precedence and workspace root semantics",
    (legacy) => {
      mkdirSync(join(repoRoot, ".untangle"));
      writeFileSync(
        join(repoRoot, ".untangle", "config.json"),
        JSON.stringify({ schemaVersion: 1, qdrant: { collectionPrefix: "folder_" } }),
      );
      writeFileSync(
        join(repoRoot, legacy),
        legacy.endsWith(".json")
          ? JSON.stringify({ schemaVersion: 1, qdrant: { collectionPrefix: "legacy_" } })
          : 'schemaVersion = 1\n[qdrant]\ncollectionPrefix = "legacy_"\n',
      );
      const result = loadConfig({
        cwd: repoRoot,
        env: { XDG_CONFIG_HOME: xdgConfigHome },
        platform: "linux",
      });
      expect(result.errors).toEqual([]);
      expect(result.sources.configBaseDir).toBe(repoRoot);
      expect(result.sources.projectRoot).toBeUndefined();
      expect(result.effectiveConfig.qdrant.collectionPrefix).toBe("legacy_");
    },
  );

  it("reports an invalid folder config against the actual metadata path", () => {
    mkdirSync(join(repoRoot, ".untangle"));
    const config = join(repoRoot, ".untangle", "config.json");
    writeFileSync(config, "{ invalid json");
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.errors).toContainEqual(expect.objectContaining({ path: config }));
    expect(result.sources.projectRoot).toBe(repoRoot);
  });
});

describe("loadConfig — validation, hashing and derived ids", () => {
  let root: string;
  let repoRoot: string;
  let xdgConfigHome: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "untangle-config-load-validate-"));
    repoRoot = join(root, "repo");
    xdgConfigHome = join(root, "xdg-config");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(join(repoRoot, ".git"));
    mkdirSync(xdgConfigHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("surfaces a warning for an unknown top-level field instead of dropping it silently", () => {
    writeFileSync(
      join(repoRoot, ".untangle.json"),
      JSON.stringify({ schemaVersion: 1, notARealField: 42 }),
    );
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.warnings.some((w) => w.path === "notARealField")).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("loads a TOML relevance policy under its exact quoted embedding profile id", () => {
    const profileId = "0dc5c26f";
    writeFileSync(
      join(repoRoot, "untangle.toml"),
      [
        "schemaVersion = 1",
        `[search.relevancePolicies.${JSON.stringify(profileId)}]`,
        'workspaceId = "workspace-fixture"',
        'collection = "untangle_fixture_code_profile_v1"',
        `[search.relevancePolicies.${JSON.stringify(profileId)}.policy]`,
        'calibrationId = "fixture/2026-09-05"',
        "minimumDenseScore = 0.45",
        "minimumDenseSpread = 0.075",
        "denseReferenceRank = 50",
        "minimumCandidateIdfCoverage = 0.3",
        "",
      ].join("\n"),
    );
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.errors).toEqual([]);
    expect(result.effectiveConfig.search.relevancePolicies?.[profileId]).toMatchObject({
      workspaceId: "workspace-fixture",
      collection: "untangle_fixture_code_profile_v1",
      policy: {
        calibrationId: "fixture/2026-09-05",
        denseReferenceRank: 50,
      },
    });
  });

  it("does not carry calibrated thresholds into a higher-layer corpus binding", () => {
    const profileId = "profile-a";
    writeFileSync(
      join(repoRoot, ".untangle.json"),
      JSON.stringify({
        schemaVersion: 1,
        search: {
          relevancePolicies: {
            [profileId]: {
              workspaceId: "workspace-a",
              collection: "collection-a",
              policy: {
                calibrationId: "corpus-a",
                minimumDenseScore: 0.45,
                minimumDenseSpread: 0.061,
                denseReferenceRank: 50,
                minimumCandidateIdfCoverage: 0.291,
              },
            },
          },
        },
      }),
    );
    writeFileSync(
      join(repoRoot, ".untangle.local.json"),
      JSON.stringify({
        schemaVersion: 1,
        search: {
          relevancePolicies: {
            [profileId]: {
              workspaceId: "workspace-b",
              collection: "collection-b",
            },
          },
        },
      }),
    );

    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });

    expect(result.errors.some((issue) => issue.path.endsWith(`${profileId}.policy`))).toBe(true);
    expect(
      (
        result.effectiveConfig.search.relevancePolicies?.[profileId] as unknown as Record<
          string,
          unknown
        >
      )["policy"],
    ).toBeUndefined();
  });

  it("collects an error for an invalid enum instead of throwing", () => {
    writeFileSync(
      join(repoRoot, ".untangle.json"),
      JSON.stringify({ schemaVersion: 1, qdrant: { mode: "bogus" } }),
    );
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.errors.some((e) => e.path === "qdrant.mode")).toBe(true);
  });

  it("collects an error for malformed JSON instead of throwing", () => {
    writeFileSync(join(repoRoot, ".untangle.json"), "{ not valid json");
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.errors.some((e) => e.message.includes("not valid JSON"))).toBe(true);
  });

  it("resolves repository paths relative to the config file directory", () => {
    mkdirSync(join(root, "identity"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".untangle.json"),
      JSON.stringify({
        schemaVersion: 1,
        repositories: [
          { id: "backend", path: "." },
          { id: "identity", path: "../identity" },
        ],
      }),
    );
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.effectiveConfig.repositories).toEqual([
      { id: "backend", path: repoRoot.split("\\").join("/") },
      { id: "identity", path: join(root, "identity").split("\\").join("/") },
    ]);
  });

  it("resolves an absolute repository path as-is", () => {
    const absolute = join(root, "somewhere-else");
    mkdirSync(absolute, { recursive: true });
    writeFileSync(
      join(repoRoot, ".untangle.json"),
      JSON.stringify({ schemaVersion: 1, repositories: [{ id: "x", path: absolute }] }),
    );
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.effectiveConfig.repositories?.[0]?.path).toBe(absolute.split("\\").join("/"));
  });

  it("resolves a repository path from the OS user config against the user config directory, not the project directory (regression)", () => {
    // The user config file lives under xdgConfigHome/untangle — a directory
    // unrelated to repoRoot. Before the fix, ALL repository paths were
    // resolved against a single post-merge `configBaseDir` (the project or
    // local config's directory, or cwd) regardless of which layer actually
    // declared the path — so a repository declared only in the OS user
    // config silently resolved against the wrong directory (or threw off
    // the user's expectation) whenever repoRoot differed from the user
    // config directory, which is the common case.
    mkdirSync(join(xdgConfigHome, "untangle"), { recursive: true });
    writeFileSync(
      join(xdgConfigHome, "untangle", "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        repositories: [{ id: "sibling", path: "../sibling-repo" }],
      }),
    );
    const expectedSibling = join(xdgConfigHome, "sibling-repo").split("\\").join("/");
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.effectiveConfig.repositories).toEqual([{ id: "sibling", path: expectedSibling }]);
    // Must NOT have resolved against repoRoot (the old, wrong base).
    expect(result.effectiveConfig.repositories?.[0]?.path).not.toBe(
      join(repoRoot, "sibling-repo").split("\\").join("/"),
    );
  });

  it("resolves a local-override repository path against .untangle.local.json's own directory, not .untangle.json's (regression)", () => {
    // .untangle.json lives in repoRoot; .untangle.local.json lives in a
    // nested subdirectory closer to cwd, so the two files — both real, both
    // discovered — sit in DIFFERENT directories. Layer 3 (local) fully
    // replaces layer 4's (project) `repositories` array (merge.ts: arrays
    // replace, they never concatenate), so the winning array's paths must
    // resolve against the local file's directory.
    writeFileSync(
      join(repoRoot, ".untangle.json"),
      JSON.stringify({
        schemaVersion: 1,
        repositories: [{ id: "project-repo", path: "." }],
      }),
    );
    const nested = join(repoRoot, "services", "api");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, ".untangle.local.json"),
      JSON.stringify({
        schemaVersion: 1,
        repositories: [{ id: "local-repo", path: "." }],
      }),
    );
    const result = loadConfig({
      cwd: nested,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.sources.projectConfigPath).toBe(join(repoRoot, ".untangle.json"));
    expect(result.sources.localConfigPath).toBe(join(nested, ".untangle.local.json"));
    expect(result.effectiveConfig.repositories).toEqual([
      { id: "local-repo", path: nested.split("\\").join("/") },
    ]);
  });

  it("resolves an explicit-argument repository path against cwd, since explicit args have no config file of their own", () => {
    writeFileSync(
      join(repoRoot, ".untangle.json"),
      JSON.stringify({
        schemaVersion: 1,
        repositories: [{ id: "project-repo", path: "should-be-overridden" }],
      }),
    );
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
      explicit: { repositories: [{ id: "explicit-repo", path: "." }] },
    });
    expect(result.effectiveConfig.repositories).toEqual([
      { id: "explicit-repo", path: repoRoot.split("\\").join("/") },
    ]);
  });

  it("resolves a contextArtifact path against the directory of the layer that declared it, same as repositories", () => {
    mkdirSync(join(xdgConfigHome, "untangle"), { recursive: true });
    writeFileSync(
      join(xdgConfigHome, "untangle", "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        contextArtifacts: [{ name: "api-spec", path: "./openapi.yaml", description: "API spec" }],
      }),
    );
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.effectiveConfig.contextArtifacts).toEqual([
      {
        name: "api-spec",
        path: join(xdgConfigHome, "untangle", "openapi.yaml").split("\\").join("/"),
        description: "API spec",
      },
    ]);
  });

  // Layer 2 (env, spec.md §4.1) and layer 6 (product defaults) are not
  // exercised above with a `repositories`/`contextArtifacts` array of their
  // own: `ENV_MAPPING` (env.ts) maps no env var to either field, and
  // `PRODUCT_DEFAULT_CONFIG` (defaults.ts) deliberately never sets them
  // ("keine universelle Default-Repository-Menge existiert", spec.md §4.3)
  // — so no real input can make either layer originate a repository path.
  // Both layers share the identical `baseDir: cwd` wiring the explicit-args
  // test above already exercises (load.ts's `namedLayers`), so their
  // fallback behavior is covered by construction, not by a separate test.

  it("produces a deterministic configHash for the same effective config", () => {
    const a = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    const b = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(a.configHash).toBe(b.configHash);
    expect(a.workspaceId).toBe(b.workspaceId);
  });

  it("derives a stable embeddingProfileId from the default embedding profile", () => {
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.embeddingProfileId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses an explicit workspaceId when configured instead of deriving one", () => {
    writeFileSync(
      join(repoRoot, ".untangle.json"),
      JSON.stringify({ schemaVersion: 1, workspaceId: "commerce-platform" }),
    );
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(result.workspaceId).toBe("commerce-platform");
  });

  it("never puts a resolved secret value into the effective config", () => {
    writeFileSync(
      join(repoRoot, ".untangle.json"),
      JSON.stringify({
        schemaVersion: 1,
        qdrant: { mode: "external", url: "http://q:6333", apiKeyEnv: "MY_QDRANT_KEY" },
      }),
    );
    const result = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome, MY_QDRANT_KEY: "top-secret-value" },
      platform: "linux",
    });
    expect(JSON.stringify(result.effectiveConfig)).not.toContain("top-secret-value");
    expect(result.effectiveConfig.qdrant.apiKeyEnv).toBe("MY_QDRANT_KEY");
  });
});
