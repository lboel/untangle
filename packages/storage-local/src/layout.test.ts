import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildStateDirLayout, ensureStateDirLayout, listStateDirLayoutPaths } from "./layout.js";
import { LocalFileSystem } from "./local-file-system.js";

describe("buildStateDirLayout", () => {
  it("matches the architecture.md §12 layout exactly", () => {
    const layout = buildStateDirLayout("/ws/.untangle");
    expect(layout.root).toBe("/ws/.untangle");
    expect(layout.cache.embeddings).toBe("/ws/.untangle/cache/embeddings");
    expect(layout.cache.parser).toBe("/ws/.untangle/cache/parser");
    expect(layout.cache.gitBlobs).toBe("/ws/.untangle/cache/git-blobs");
    expect(layout.jobs).toBe("/ws/.untangle/jobs");
    expect(layout.locks).toBe("/ws/.untangle/locks");
    expect(layout.productComplexity.sessions).toBe("/ws/.untangle/product-complexity/sessions");
    expect(layout.artifacts.diffs).toBe("/ws/.untangle/artifacts/diffs");
    expect(layout.artifacts.visualizations).toBe("/ws/.untangle/artifacts/visualizations");
    expect(layout.logs).toBe("/ws/.untangle/logs");
  });

  it("listStateDirLayoutPaths covers every declared directory exactly once", () => {
    const layout = buildStateDirLayout("/ws/.untangle");
    const paths = listStateDirLayoutPaths(layout);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain(layout.cache.embeddings);
    expect(paths).toContain(layout.artifacts.visualizations);
    expect(paths).toContain(layout.productComplexity.sessions);
    expect(paths).toContain(layout.logs);
  });
});

describe("ensureStateDirLayout", () => {
  let base: string;

  it("creates every layout directory on a fresh root", async () => {
    base = await mkdtemp(path.join(tmpdir(), "untangle-storage-local-layout-"));
    try {
      const root = path.join(base, "state", ".untangle");
      const layout = buildStateDirLayout(root);
      const fs = new LocalFileSystem([path.join(base, "state")]);
      await ensureStateDirLayout(fs, layout);

      for (const dir of listStateDirLayoutPaths(layout)) {
        const stats = await stat(dir);
        expect(stats.isDirectory()).toBe(true);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("is idempotent — calling it twice does not throw", async () => {
    base = await mkdtemp(path.join(tmpdir(), "untangle-storage-local-layout-idem-"));
    try {
      const root = path.join(base, ".untangle");
      const layout = buildStateDirLayout(root);
      const fs = new LocalFileSystem([base]);
      await ensureStateDirLayout(fs, layout);
      await expect(ensureStateDirLayout(fs, layout)).resolves.toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("respects an already-aborted signal", async () => {
    base = await mkdtemp(path.join(tmpdir(), "untangle-storage-local-layout-abort-"));
    try {
      const root = path.join(base, ".untangle");
      const layout = buildStateDirLayout(root);
      const fs = new LocalFileSystem([base]);
      const controller = new AbortController();
      controller.abort();
      await expect(
        ensureStateDirLayout(fs, layout, { signal: controller.signal }),
      ).rejects.toMatchObject({
        code: "JOB_CANCELLED",
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
