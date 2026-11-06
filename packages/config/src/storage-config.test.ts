import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildWorkspaceId, canonicalJson, sha256Hex } from "@untangle-code/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_STORAGE_CONFIG } from "./defaults.js";
import { buildEnvConfigLayer } from "./env.js";
import { loadConfig } from "./load.js";
import { parseConfigText } from "./parse.js";
import { CONFIG_SCHEMA } from "./schema.js";
import type { RawConfigLayer } from "./types.js";
import { validateEffectiveConfig } from "./validate.js";

describe("storage backend configuration", () => {
  let root: string;
  let repoRoot: string;
  let userConfigPath: string;
  let baseEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "untangle-storage-config-"));
    repoRoot = join(root, "repo");
    const configHome = join(root, "config");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(join(configHome, "untangle"), { recursive: true });
    userConfigPath = join(configHome, "untangle", "config.json");
    baseEnv = { XDG_CONFIG_HOME: configHome };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function load(explicit?: RawConfigLayer, env: NodeJS.ProcessEnv = {}) {
    return loadConfig({
      cwd: repoRoot,
      env: { ...baseEnv, ...env },
      platform: "linux",
      ...(explicit === undefined ? {} : { explicit }),
    });
  }

  function writeJson(path: string, layer: RawConfigLayer): void {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, ...layer }));
  }

  it("uses embedded storage for an unconfigured project without selecting the default Qdrant section", () => {
    const result = load();
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.effectiveConfig.storage).toEqual({
      backend: "lancedb",
      path: ".untangle/index/lancedb",
    });
    expect(result.effectiveConfig.qdrant.mode).toBe("managed");
  });

  it.each(["user", "toml", "project", "folder", "local", "explicit"] as const)(
    "preserves explicit legacy Qdrant configuration from the %s layer",
    (source) => {
      const legacy: RawConfigLayer = { qdrant: { collectionPrefix: "legacy_" } };
      if (source === "user") writeJson(userConfigPath, legacy);
      if (source === "toml") {
        writeFileSync(join(repoRoot, "untangle.toml"), '[qdrant]\ncollectionPrefix = "legacy_"\n');
      }
      if (source === "project") writeJson(join(repoRoot, ".untangle.json"), legacy);
      if (source === "folder") {
        mkdirSync(join(repoRoot, ".untangle"));
        writeJson(join(repoRoot, ".untangle", "config.json"), legacy);
      }
      if (source === "local") writeJson(join(repoRoot, ".untangle.local.json"), legacy);
      const result = load(source === "explicit" ? legacy : undefined);
      expect(result.errors).toEqual([]);
      expect(result.effectiveConfig.storage.backend).toBe("qdrant");
      expect(result.effectiveConfig.qdrant.collectionPrefix).toBe("legacy_");
    },
  );

  it("retains even an explicitly empty legacy Qdrant section", () => {
    expect(load({ qdrant: {} }).effectiveConfig.storage.backend).toBe("qdrant");
  });

  it.each([
    ["UNTANGLE_QDRANT_MODE", "managed"],
    ["UNTANGLE_QDRANT_URL", "http://127.0.0.1:16333"],
    ["UNTANGLE_QDRANT_API_KEY_ENV", "QDRANT_CREDENTIAL"],
    ["UNTANGLE_QDRANT_COLLECTION_PREFIX", "legacy_"],
    ["UNTANGLE_QDRANT_REQUEST_TIMEOUT_MS", "500"],
    ["UNTANGLE_QDRANT_MAX_RETRIES", "2"],
  ])("retains Qdrant when %s supplies the legacy environment layer", (name, value) => {
    const result = load(undefined, { [name]: value });
    expect(result.errors).toEqual([]);
    expect(result.effectiveConfig.storage.backend).toBe("qdrant");
  });

  it("does not interpret unrelated Qdrant-prefixed credentials as backend configuration", () => {
    expect(
      load(undefined, { UNTANGLE_QDRANT_PASSWORD: "not-config" }).effectiveConfig.storage.backend,
    ).toBe("lancedb");
  });

  it("does not migrate a legacy project when only the local directory is overridden", () => {
    writeJson(join(repoRoot, ".untangle.json"), { qdrant: { mode: "managed" } });
    const result = load(undefined, { UNTANGLE_LANCEDB_PATH: ".untangle/alternate" });
    expect(result.errors).toEqual([]);
    expect(result.effectiveConfig.storage).toEqual({
      backend: "qdrant",
      path: ".untangle/alternate",
    });
  });

  it("lets explicit backend selection override legacy sections at higher layer priorities", () => {
    writeJson(userConfigPath, { storage: { backend: "lancedb" } });
    writeJson(join(repoRoot, ".untangle.local.json"), { qdrant: { collectionPrefix: "local_" } });
    const result = load(
      { qdrant: { maxRetries: 7 } },
      { UNTANGLE_QDRANT_URL: "http://localhost:16333" },
    );
    expect(result.errors).toEqual([]);
    expect(result.effectiveConfig.storage.backend).toBe("lancedb");
    expect(result.effectiveConfig.qdrant).toMatchObject({
      url: "http://localhost:16333",
      collectionPrefix: "local_",
      maxRetries: 7,
    });
  });

  it.each([1, 2, 3, 4, 5, 6])("uses normal field precedence through storage layer %i", (count) => {
    const layers = [
      { backend: "qdrant", path: "user-index" },
      { backend: "lancedb", path: "toml-index" },
      { backend: "qdrant", path: "project-index" },
      { backend: "lancedb", path: "local-index" },
      { backend: "qdrant", path: "environment-index" },
      { backend: "lancedb", path: "explicit-index" },
    ] as const;
    writeJson(userConfigPath, { storage: layers[0] });
    if (count >= 2) {
      writeFileSync(
        join(repoRoot, "untangle.toml"),
        '[storage]\nbackend = "lancedb"\npath = "toml-index"\n',
      );
    }
    if (count >= 3) writeJson(join(repoRoot, ".untangle.json"), { storage: layers[2] });
    if (count >= 4) writeJson(join(repoRoot, ".untangle.local.json"), { storage: layers[3] });
    const result = load(
      count >= 6 ? { storage: layers[5] } : undefined,
      count >= 5
        ? {
            UNTANGLE_STORAGE_BACKEND: layers[4].backend,
            UNTANGLE_LANCEDB_PATH: layers[4].path,
          }
        : {},
    );
    expect(result.errors).toEqual([]);
    expect(result.effectiveConfig.storage).toEqual(layers[count - 1]);
  });

  it("merges backend and path overrides independently", () => {
    writeJson(join(repoRoot, ".untangle.json"), {
      storage: { backend: "qdrant", path: "project-index" },
    });
    const result = load(
      { storage: { backend: "lancedb" } },
      { UNTANGLE_LANCEDB_PATH: "env-index" },
    );
    expect(result.effectiveConfig.storage).toEqual({ backend: "lancedb", path: "env-index" });
  });

  it("keeps a root-relative path unchanged when config lives inside .untangle", () => {
    mkdirSync(join(repoRoot, ".untangle"));
    writeJson(join(repoRoot, ".untangle", "config.json"), {
      storage: { path: ".untangle/index/custom" },
    });
    expect(load().effectiveConfig.storage.path).toBe(".untangle/index/custom");
  });

  it("does not fall back when an explicit backend is invalid", () => {
    const result = load(undefined, {
      UNTANGLE_STORAGE_BACKEND: "remote",
      UNTANGLE_QDRANT_MODE: "managed",
    });
    expect(result.errors.map((error) => error.path)).toEqual(["storage.backend"]);
    expect(result.effectiveConfig.storage.backend).toBe("remote");
  });

  it("leaves product defaults unchanged after resolving a legacy project", () => {
    load({ qdrant: {} });
    expect(load().effectiveConfig.storage).toEqual(DEFAULT_STORAGE_CONFIG);
    expect(DEFAULT_STORAGE_CONFIG.backend).toBe("lancedb");
  });

  it("maps the new environment fields without manufacturing a Qdrant section", () => {
    expect(
      buildEnvConfigLayer({
        UNTANGLE_STORAGE_BACKEND: "lancedb",
        UNTANGLE_LANCEDB_PATH: "custom-index",
      }),
    ).toEqual({
      layer: { storage: { backend: "lancedb", path: "custom-index" } },
      parseErrors: [],
    });
  });

  it("preserves the pre-storage Qdrant configuration hash and derived workspace identity", () => {
    const qdrant = { mode: "external", url: "http://127.0.0.1:16333" } as const;
    const implicit = load({ qdrant });
    const oldEffectiveConfig = { ...implicit.effectiveConfig } as Record<string, unknown>;
    delete oldEffectiveConfig["storage"];
    const oldHash = sha256Hex(canonicalJson(oldEffectiveConfig));
    expect(implicit.configHash).toBe(oldHash);
    expect(implicit.workspaceId).toBe(buildWorkspaceId({ configHash: oldHash }));
    const explicit = load({ qdrant, storage: { backend: "qdrant", path: "unused-local-path" } });
    expect(explicit.configHash).toBe(oldHash);
    expect(explicit.workspaceId).toBe(implicit.workspaceId);
    expect(load({ qdrant: { ...qdrant, url: "http://127.0.0.1:26333" } }).configHash).not.toBe(
      oldHash,
    );
  });

  it("includes the embedded backend and directory in the configuration identity", () => {
    const first = load({ storage: { backend: "lancedb", path: ".untangle/first" } });
    const second = load({ storage: { backend: "lancedb", path: ".untangle/second" } });
    const external = load({ storage: { backend: "qdrant", path: ".untangle/first" } });
    expect(first.configHash).toBe(sha256Hex(canonicalJson(first.effectiveConfig)));
    expect(first.configHash).not.toBe(second.configHash);
    expect(first.workspaceId).not.toBe(second.workspaceId);
    expect(first.configHash).not.toBe(external.configHash);
  });
});

describe("parseConfigText", () => {
  it.each([
    ["json", '{"storage":{"backend":"lancedb"},"qdrant":{}}'],
    ["toml", '[storage]\nbackend = "lancedb"\n[qdrant]\n'],
  ] as const)(
    "preserves explicit backend selection in %s without adding defaults",
    (format, text) => {
      expect(parseConfigText(text, format)).toEqual({
        storage: { backend: "lancedb" },
        qdrant: {},
      });
    },
  );

  it.each(["null", "[]", "42", '"lancedb"'])(
    "rejects JSON that is not a config object: %s",
    (text) => {
      expect(() => parseConfigText(text, "json")).toThrow("JSON object");
    },
  );

  it("reports syntax failures without turning them into an empty config", () => {
    expect(() => parseConfigText("{", "json")).toThrow();
    expect(() => parseConfigText("[storage", "toml")).toThrow();
  });
});

describe("embedded storage validation", () => {
  const localPaths = [
    ".untangle/index/lancedb",
    "index with spaces",
    "/var/tmp/untangle",
    ".",
    "C:\\untangle\\index",
    "D:/index",
  ];
  const invalidPaths: unknown[] = [
    "",
    "  \n\t",
    "s3://bucket/index",
    "gs://bucket/index",
    "db://remote",
    "https://host/index",
    "file:///tmp/index",
    "//host/share",
    "\\\\host\\share",
    "C:relative",
    "index\0file",
    null,
    42,
    [],
  ];

  it.each(localPaths)("accepts local path %s", (path) => {
    expect(validateEffectiveConfig({ storage: { backend: "lancedb", path } })).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it.each(invalidPaths)("rejects non-local or invalid path %j", (path) => {
    const result = validateEffectiveConfig({ storage: { backend: "lancedb", path } });
    expect(result.errors.map((error) => error.path)).toEqual(["storage.path"]);
  });

  it.each([null, [], "lancedb", true])("rejects an invalid storage section %j", (storage) => {
    expect(validateEffectiveConfig({ storage }).errors.map((error) => error.path)).toEqual([
      "storage",
    ]);
  });

  it.each(["sqlite", "", "LanceDB", null, 42])("rejects an invalid backend %j", (backend) => {
    expect(
      validateEffectiveConfig({ storage: { backend } }).errors.map((error) => error.path),
    ).toEqual(["storage.backend"]);
  });

  it("retains invalid Qdrant option errors even when LanceDB is selected", () => {
    expect(
      validateEffectiveConfig({
        storage: { backend: "lancedb" },
        qdrant: { mode: "external" },
      }).errors.map((error) => error.path),
    ).toEqual(["qdrant.url"]);
  });

  it("publishes the backend enum and matching local-path constraints in the editor schema", () => {
    const definitions = CONFIG_SCHEMA["$defs"] as Record<
      string,
      { properties: Record<string, unknown> }
    >;
    const storage = definitions["storageConfig"]?.properties;
    expect(storage?.["backend"]).toEqual({ enum: ["lancedb", "qdrant"], default: "lancedb" });
    const path = storage?.["path"] as { anyOf: { pattern: string }[] };
    const patterns = path.anyOf.map((entry) => new RegExp(entry.pattern, "u"));
    for (const value of localPaths)
      expect(patterns.some((pattern) => pattern.test(value))).toBe(true);
    for (const value of invalidPaths.filter(
      (entry): entry is string => typeof entry === "string",
    )) {
      expect(patterns.some((pattern) => pattern.test(value))).toBe(false);
    }
  });
});
