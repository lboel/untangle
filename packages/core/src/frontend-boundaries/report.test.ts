import type { HttpServiceBindingV1, ParserRegistry, SourceFile } from "@untangle-code/domain";
import { sha256Hex } from "@untangle-code/domain";
import { createParserRegistry, LazyParserRegistry } from "@untangle-code/parser-registry";
import { FakeClock, MemoryFileSystem } from "@untangle-code/testkit";
import { describe, expect, it, vi } from "vitest";

import { analyzeFrontendBoundaries } from "./report.js";

const ROOT = "/project";
const CLIENT = "export function load() { return fetch('/api/v1/tasks', {method:'POST'}); }\n";
const MAIN = `from fastapi import FastAPI
from app.routes import tasks
app = FastAPI()
app.include_router(tasks.router, prefix="/api/v1")
`;
const ROUTES = `from fastapi import APIRouter
router = APIRouter()
@router.post("/tasks")
def create_task():
    return {"ok": True}
`;
const UI = `<script setup lang="ts">
import { load } from './api';
const submit = () => load();
</script>
<template><button @click="submit">Send</button></template>
`;
const SERVICES: HttpServiceBindingV1[] = [
  { id: "api", frontendRoots: ["apps/web/src"], backendRoots: ["backend/app"], sameOrigin: true },
];

function fixture(extra: Record<string, string> = {}): MemoryFileSystem {
  const fs = new MemoryFileSystem(new FakeClock(100));
  fs.seedDirectory(ROOT);
  const contents = {
    "apps/web/src/Panel.vue": UI,
    "apps/web/src/api.ts": CLIENT,
    "backend/app/main.py": MAIN,
    "backend/app/routes/tasks.py": ROUTES,
    ...extra,
  };
  for (const [filePath, content] of Object.entries(contents))
    fs.seedFile(`${ROOT}/${filePath}`, content);
  return fs;
}

function manifest(): string {
  return JSON.stringify({
    schemaVersion: 1,
    owners: [
      { id: "runtime", label: "Runtime role", kind: "role", status: "declared", sources: [] },
    ],
    features: [
      {
        id: "ui",
        title: "Task UI",
        stage: "implemented",
        review: "proposed",
        intent: [],
        owners: ["runtime"],
        code: { include: ["apps/web/src/**"] },
        tests: { include: [] },
        criteria: [],
        dependsOn: ["server"],
      },
      {
        id: "server",
        title: "Task backend",
        stage: "implemented",
        review: "proposed",
        intent: [],
        owners: ["runtime"],
        code: { include: ["backend/app/**"] },
        tests: { include: [] },
        criteria: [],
        dependsOn: [],
      },
    ],
  });
}

function mutatingRegistry(change: (source: SourceFile) => void): ParserRegistry {
  const registry = createParserRegistry();
  const get = registry.getAdapterForPath.bind(registry);
  vi.spyOn(registry, "getAdapterForPath").mockImplementation((filePath, sample) => {
    const adapter = get(filePath, sample);
    if (adapter === null) return null;
    return {
      ...adapter,
      parse: (source) => {
        const parsed = adapter.parse(source);
        change(source);
        return parsed;
      },
    };
  });
  return registry;
}

describe("fresh frontend-boundary coordinator", () => {
  it("connects a real Vue import to a TS request and mounted Python handler without inventing a function call", async () => {
    const fs = fixture();
    const report = await analyzeFrontendBoundaries({ root: ROOT, fs, services: SERVICES });
    expect(report.freshness.status).toBe("fresh");
    expect(report.sourceTreeDigest).toBe(report.freshness.sourceTreeAfter);
    expect(
      report.http.requests.find((request) => request.status === "resolved")?.targets[0],
    ).toMatchObject({ method: "POST", path: "/api/v1/tasks", handler: "create_task" });
    expect(report.http.requests[0]?.source.contentHash).toBe(sha256Hex(CLIENT));
    expect(report.importContext.kind).toBe("file-imports-not-function-calls");
    expect(report.importContext.requestImporters).toContainEqual(
      expect.objectContaining({
        path: "apps/web/src/Panel.vue",
        requestPath: "apps/web/src/api.ts",
        distance: 1,
        contentHash: sha256Hex(UI),
      }),
    );
    expect(report.importContext.edges[0]?.sourceHash).toBe(sha256Hex(UI));
    expect(
      report.limitations.some((text) =>
        text.includes("Template-to-function invocation is not proven"),
      ),
    ).toBe(true);
  });

  it("filters output only after scanning all backend sources and import context", async () => {
    const report = await analyzeFrontendBoundaries({
      root: ROOT,
      fs: fixture(),
      services: SERVICES,
      path: "apps/web/src/Panel.vue",
    });
    expect(report.selection).toEqual({
      path: "apps/web/src/Panel.vue",
      inInventory: true,
      matchingRequests: 1,
    });
    expect(report.http.requests[0]?.status).toBe("resolved");
    expect(report.http.endpoints[0]?.handler).toBe("create_task");
    expect(report.inventory.analyzed).toBe(4);
  });

  it("keeps an unknown file selection explicit without pretending it was scanned", async () => {
    const report = await analyzeFrontendBoundaries({
      root: ROOT,
      fs: fixture(),
      services: SERVICES,
      path: "missing.vue",
    });
    expect(report.selection).toEqual({
      path: "missing.vue",
      inInventory: false,
      matchingRequests: 0,
    });
    expect(report.http.requests).toEqual([]);
    expect(report.http.summary.requests).toBe(1);
  });

  it("honors actual ignores and caller exclusions in both freshness scans", async () => {
    const fs = fixture({
      ".gitignore": "ignored.ts\n.untangle/\n",
      "ignored.ts": CLIENT,
      "excluded.ts": CLIENT,
      ".untangle/index.ts": CLIENT,
    });
    const report = await analyzeFrontendBoundaries({
      root: ROOT,
      fs,
      services: SERVICES,
      inventoryScope: { additionalDefaultExcludes: ["excluded.ts"] },
    });
    expect(report.http.summary.requests).toBe(1);
    expect(report.freshness.status).toBe("fresh");
    expect(report.inventory.files).toBe(5);
    expect(report.inventory.excluded).toBeGreaterThan(0);
  });

  it("associates declared frontend/backend features and preserves dependency and ownership declarations", async () => {
    const fs = fixture({ ".untangle/features.json": manifest() });
    const report = await analyzeFrontendBoundaries({ root: ROOT, fs, services: SERVICES });
    expect(report.features.manifest).toMatchObject({
      path: ".untangle/features.json",
      status: "loaded",
      contentHash: sha256Hex(manifest()),
    });
    expect(
      report.features.associations.find((item) => item.path === "apps/web/src/Panel.vue")?.matches,
    ).toEqual([
      expect.objectContaining({
        featureId: "ui",
        role: "code",
        declaredDependsOn: ["server"],
        ownership: [{ id: "runtime", label: "Runtime role", status: "declared" }],
      }),
    ]);
    expect(
      report.features.associations.find((item) => item.path === "backend/app/routes/tasks.py")
        ?.matches[0]?.featureId,
    ).toBe("server");
    expect(report.features.dependencySemantics).toBe("declared_dependencies_unchanged");
  });

  it("does not mask an invalid legacy manifest with valid metadata", async () => {
    const fs = fixture({
      "untangle.features.json": "broken",
      ".untangle/features.json": manifest(),
    });
    const report = await analyzeFrontendBoundaries({ root: ROOT, fs, services: SERVICES });
    expect(report.features.manifest).toMatchObject({
      path: "untangle.features.json",
      status: "invalid",
    });
    expect(report.status).toBe("incomplete");
    expect(report.features.associations.every((item) => item.matches.length === 0)).toBe(true);
  });

  it("honors an explicit metadata feature map without reading another map", async () => {
    const fs = fixture({ "untangle.features.json": "broken", ".untangle/custom.json": manifest() });
    const report = await analyzeFrontendBoundaries({
      root: ROOT,
      fs,
      services: SERVICES,
      featureManifestPath: ".untangle/custom.json",
    });
    expect(report.features.manifest).toMatchObject({
      path: ".untangle/custom.json",
      status: "loaded",
    });
  });

  it("rejects a manifest outside the source root", async () => {
    const fs = fixture();
    fs.seedFile("/outside.json", manifest());
    const report = await analyzeFrontendBoundaries({
      root: ROOT,
      fs,
      services: SERVICES,
      featureManifestPath: "/outside.json",
    });
    expect(report.features.manifest.status).toBe("not_in_scan");
    expect(report.features.associations.every((item) => item.matches.length === 0)).toBe(true);
  });

  it("detects a source edit made during parsing", async () => {
    const fs = fixture();
    const registry = mutatingRegistry((source) => {
      if (source.path === "apps/web/src/api.ts")
        fs.seedFile(`${ROOT}/${source.path}`, `${CLIENT}// changed\n`);
    });
    const report = await analyzeFrontendBoundaries({
      root: ROOT,
      fs,
      services: SERVICES,
      parserRegistry: registry,
    });
    expect(report.status).toBe("stale");
    expect(report.freshness.changedPaths).toContain("apps/web/src/api.ts");
    expect(report.freshness.sourceTreeBefore).not.toBe(report.freshness.sourceTreeAfter);
  });

  it("detects a new source outside parsed HTTP paths", async () => {
    const fs = fixture();
    const registry = mutatingRegistry(() => fs.seedFile(`${ROOT}/docs/new.txt`, "new source"));
    const report = await analyzeFrontendBoundaries({
      root: ROOT,
      fs,
      services: SERVICES,
      parserRegistry: registry,
    });
    expect(report.status).toBe("stale");
    expect(report.freshness.changedPaths).toContain("docs/new.txt");
  });

  it("detects a metadata manifest change invisible to the production source digest", async () => {
    const fs = fixture({ ".untangle/features.json": manifest() });
    const registry = mutatingRegistry(() =>
      fs.seedFile(`${ROOT}/.untangle/features.json`, manifest().replace("Task UI", "Changed UI")),
    );
    const report = await analyzeFrontendBoundaries({
      root: ROOT,
      fs,
      services: SERVICES,
      parserRegistry: registry,
    });
    expect(report.freshness.sourceTreeBefore).toBe(report.freshness.sourceTreeAfter);
    expect(report.status).toBe("stale");
    expect(report.features.manifest.status).toBe("changed");
    expect(report.freshness.changedPaths).toContain(".untangle/features.json");
  });

  it("reports unavailable parsers instead of silently treating an empty report as success", async () => {
    const report = await analyzeFrontendBoundaries({
      root: ROOT,
      fs: fixture(),
      services: SERVICES,
      parserRegistry: new LazyParserRegistry(),
    });
    expect(report.status).toBe("incomplete");
    expect(report.inventory.analyzed).toBe(0);
    expect(report.issues.some((item) => item.reason === "boundary_parser_unavailable")).toBe(true);
  });

  it("retains full HTTP totals and marks capped output explicitly", async () => {
    const fs = fixture({
      "apps/web/src/api.ts": `${CLIENT}fetch('/api/v1/tasks', {method:'POST'});`,
    });
    const report = await analyzeFrontendBoundaries({
      root: ROOT,
      fs,
      services: SERVICES,
      maxRelations: 1,
    });
    expect(report.http.summary.requests).toBe(2);
    expect(report.http.requests).toHaveLength(1);
    expect(report.truncation.omittedRequests).toBe(1);
    expect(report.truncation.truncated).toBe(true);
    expect(report.status).toBe("incomplete");
  });

  it("propagates a pre-aborted signal before touching the filesystem", async () => {
    const fs = fixture();
    const read = vi.spyOn(fs, "realPath");
    const reason = new Error("stop boundaries");
    await expect(
      analyzeFrontendBoundaries({ root: ROOT, fs, signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(read).not.toHaveBeenCalled();
  });

  it("propagates cancellation during extraction without partial success", async () => {
    const fs = fixture();
    const controller = new AbortController();
    const reason = new Error("cancel while parsing");
    const registry = mutatingRegistry(() => controller.abort(reason));
    await expect(
      analyzeFrontendBoundaries({
        root: ROOT,
        fs,
        services: SERVICES,
        parserRegistry: registry,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it.each([
    "../escape.vue",
    "/absolute.vue",
    "apps/**",
    "./api.ts",
    "apps\\api.ts",
    "apps/:name.vue",
  ])("rejects invalid file selection %s", async (selected) => {
    await expect(
      analyzeFrontendBoundaries({ root: ROOT, fs: fixture(), path: selected }),
    ).rejects.toThrow("literal repository-relative");
  });

  it.each([0, -1, 1001, 1.5, Number.NaN])(
    "rejects invalid output budget %s",
    async (maxRelations) => {
      await expect(
        analyzeFrontendBoundaries({ root: ROOT, fs: fixture(), maxRelations }),
      ).rejects.toThrow("maxRelations");
    },
  );
});
