import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BufferIo } from "../cli/io.js";
import { run } from "../index.js";

import { DefaultUntangleMcpRuntime } from "./default-runtime.js";
import { UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS } from "./output-schemas.js";
import { executeMcpToolInvocation } from "./server.js";
import { UNTANGLE_MCP_TOOLS } from "./tools.js";

describe("fresh frontend/backend dependency CLI and MCP", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "untangle-frontend-cli-")));
    for (const directory of ["src", "backend", ".untangle"]) mkdirSync(path.join(root, directory));
    writeFileSync(
      path.join(root, "src/App.vue"),
      '<template><button @click="load">Laden</button></template>\n<script setup lang="ts">\nimport { load } from "./api";\n</script>\n',
    );
    writeFileSync(
      path.join(root, "src/api.ts"),
      'export function load(id: string) { return fetch(`/api/orders/${encodeURIComponent(id)}`, { method: "GET" }); }\n',
    );
    writeFileSync(
      path.join(root, "backend/app.py"),
      'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/api/orders/{id}")\ndef load_order(id: str):\n    return {"id": id}\n',
    );
    writeFileSync(
      path.join(root, ".untangle/services.json"),
      JSON.stringify({
        schemaVersion: 1,
        services: [
          { id: "local-api", frontendRoots: ["src"], backendRoots: ["backend"], sameOrigin: true },
        ],
      }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function cli(args: string[]) {
    const io = new BufferIo();
    const code = await run(["graph", "boundaries", ...args], {
      cwd: root,
      env: {},
      signal: new AbortController().signal,
      io,
    });
    return { code, io };
  }

  it("reads Vue import context through a TS HTTP client to a Python handler without an index", async () => {
    const before = readFileSync(path.join(root, "src/App.vue"));
    const { code, io } = await cli(["--path=src/App.vue", "--format=json"]);
    expect(code).toBe(0);
    const report = JSON.parse(io.outText);
    expect(report.freshness.status).toBe("fresh");
    expect(report.servicesManifest).toMatchObject({
      path: ".untangle/services.json",
      status: "loaded",
    });
    expect(report.http.requests).toContainEqual(
      expect.objectContaining({
        status: "resolved",
        method: "GET",
        targets: expect.arrayContaining([
          expect.objectContaining({ handler: "load_order", serviceId: "local-api" }),
        ]),
      }),
    );
    expect(report.importContext.requestImporters).toContainEqual(
      expect.objectContaining({ path: "src/App.vue", requestPath: "src/api.ts", distance: 1 }),
    );
    expect(report.importContext.kind).toBe("file-imports-not-function-calls");
    expect(report.features.dependencySemantics).toBe("declared_dependencies_unchanged");
    expect(readFileSync(path.join(root, "src/App.vue"))).toEqual(before);
    expect(UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_boundaries.safeParse(report).success).toBe(
      true,
    );
  });

  it("exposes the real read-only implementation through the typed MCP boundary", async () => {
    const definition = UNTANGLE_MCP_TOOLS.find((tool) => tool.name === "untangle_boundaries");
    expect(definition).toBeDefined();
    const result = await executeMcpToolInvocation(
      definition!,
      { root, path: "src/App.vue", maxRelations: 10 },
      {
        cwd: root,
        workspaceRoots: [root],
        env: {},
        signal: new AbortController().signal,
        runtime: new DefaultUntangleMcpRuntime(),
      },
    );
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      operation: "untangle_boundaries",
      data: {
        freshness: { status: "fresh" },
        http: { summary: { resolved: 1 } },
        servicesManifest: { status: "loaded" },
      },
    });
  });

  it.each(["../private.vue", "/private.vue", "src/*.vue"])(
    "rejects unsafe/nonliteral file selector %s",
    async (selector) => {
      const { code } = await cli(["--path=" + selector]);
      expect(code).toBe(2);
    },
  );

  it.each(["--max-relations=0", "--max-relations=1001", "--depth=2"])(
    "rejects unsupported or invalid limits %s",
    async (flag) => {
      expect((await cli([flag])).code).toBe(2);
    },
  );

  it("rejects an outside-root service control alias", async () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "untangle-outside-control-")));
    try {
      writeFileSync(
        path.join(outside, "services.json"),
        readFileSync(path.join(root, ".untangle/services.json")),
      );
      symlinkSync(path.join(outside, "services.json"), path.join(root, ".untangle/outside.json"));
      expect((await cli(["--services=.untangle/outside.json"])).code).toBe(2);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not accept duplicate service ids or credential-bearing origins", async () => {
    const config = {
      schemaVersion: 1,
      services: [
        {
          id: "one",
          frontendRoots: ["src"],
          backendRoots: ["backend"],
          origins: ["https://secret:password@example.invalid"],
        },
      ],
    };
    writeFileSync(path.join(root, ".untangle/services.json"), JSON.stringify(config));
    const { code, io } = await cli([]);
    expect(code).toBe(2);
    expect(io.errText).not.toContain("secret:password");
    config.services = [config.services[0]!, config.services[0]!].map((service) => ({
      ...service,
      origins: ["https://example.invalid"],
    }));
    writeFileSync(path.join(root, ".untangle/services.json"), JSON.stringify(config));
    expect((await cli([])).code).toBe(2);
  });

  it("preserves cancellation before traversal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await new DefaultUntangleMcpRuntime().invoke(
      "untangle_boundaries",
      { root },
      { cwd: root, env: {}, signal: controller.signal },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
  });
});
