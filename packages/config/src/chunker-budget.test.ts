import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveChunkerBudget } from "./chunker-budget.js";
import { DEFAULT_INDEX_CONFIG } from "./defaults.js";
import { loadConfig } from "./load.js";

describe("deriveChunkerBudget", () => {
  it("maps IndexConfig.maxChunkTokens to ChunkerConfigInput.maxTokensPerChunk", () => {
    expect(deriveChunkerBudget({ maxChunkTokens: 1500 })).toEqual({ maxTokensPerChunk: 1500 });
  });

  it("does NOT use targetChunkTokens — the chunker's only knob is a hard ceiling, not a soft aim", () => {
    const result = deriveChunkerBudget({ maxChunkTokens: 1500 });
    expect(result.maxTokensPerChunk).not.toBe(DEFAULT_INDEX_CONFIG.targetChunkTokens);
    expect(result.maxTokensPerChunk).toBe(DEFAULT_INDEX_CONFIG.maxChunkTokens);
  });

  it("reflects the product default budget from the single source of truth (spec.md §4.6: 1500)", () => {
    expect(deriveChunkerBudget(DEFAULT_INDEX_CONFIG)).toEqual({ maxTokensPerChunk: 1500 });
  });
});

describe("deriveChunkerBudget — a changed config value actually reaches the chunker-shaped budget", () => {
  let root: string;
  let repoRoot: string;
  let xdgConfigHome: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "untangle-config-chunker-budget-"));
    repoRoot = join(root, "repo");
    xdgConfigHome = join(root, "xdg-config");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(join(repoRoot, ".git"));
    mkdirSync(xdgConfigHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("propagates a project-config override of index.maxChunkTokens through loadConfig into the chunker budget", () => {
    writeFileSync(
      join(repoRoot, ".untangle.json"),
      JSON.stringify({ schemaVersion: 1, index: { maxChunkTokens: 2200 } }),
    );
    const { effectiveConfig } = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });

    // Sanity: the merge itself picked up the override (not this fix's concern).
    expect(effectiveConfig.index.maxChunkTokens).toBe(2200);

    // The actual fix under test: the exact value that would be handed to
    // @untangle-code/chunker's `resolveChunkerConfig({ ...here, preparedText })`
    // carries the CONFIGURED value, not the chunker's own independent
    // default (800, packages/chunker/src/config.ts) and not the unrelated
    // `targetChunkTokens` (900 by default) sitting right next to it.
    expect(deriveChunkerBudget(effectiveConfig.index)).toEqual({ maxTokensPerChunk: 2200 });
  });

  it("keeps the product default (1500) flowing through end to end when no layer overrides it", () => {
    const { effectiveConfig } = loadConfig({
      cwd: repoRoot,
      env: { XDG_CONFIG_HOME: xdgConfigHome },
      platform: "linux",
    });
    expect(deriveChunkerBudget(effectiveConfig.index)).toEqual({ maxTokensPerChunk: 1500 });
  });
});
