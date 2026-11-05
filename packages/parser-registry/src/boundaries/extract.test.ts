import type { HttpBoundaryFileFactsV1, LanguageAdapter, SourceFile } from "@untangle-code/domain";
import { sha256Hex } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { createPythonAdapter } from "../languages/python/index.js";
import { createTypeScriptAdapter } from "../languages/typescript/index.js";
import { createVueAdapter } from "../languages/vue/index.js";

import { extractHttpBoundaryFacts } from "./extract.js";

function parse(path: string, content: string, adapter: LanguageAdapter) {
  const source: SourceFile = {
    path,
    content,
    contentHash: sha256Hex(content),
    languageId: adapter.languageId,
    fileId: "file",
    repoId: "repo",
    refId: "ref",
    sizeBytes: Buffer.byteLength(content),
  };
  const parsed = adapter.parse(source);
  expect(parsed.ast).not.toBeNull();
  return { source, ast: parsed.ast!, adapter };
}

function project(input: ReturnType<typeof parse>): HttpBoundaryFileFactsV1 {
  return extractHttpBoundaryFacts(input.source, input.ast, input.adapter);
}

describe("HTTP syntax fact extraction", () => {
  it("binds Vue inline request ranges and hashes to the original Unicode SFC", () => {
    const content = `<template><p>Größe 🧶</p></template>\n<script setup lang="ts">\nconst response = await fetch('/api/v1/workflows');\n</script>`;
    const facts = project(parse("apps/web/src/App.vue", content, createVueAdapter()));
    expect(facts.languageId).toBe("vue");
    expect(facts.contentHash).toBe(sha256Hex(content));
    const call = facts.calls.find(
      (call) => call.callee.kind === "name" && call.callee.name === "fetch",
    );
    expect(call).toBeDefined();
    expect(call?.range.startLine).toBe(3);
    const bytes = Buffer.from(content);
    expect(bytes.subarray(call!.range.startByte, call!.range.endByte).toString("utf8")).toBe(
      "fetch('/api/v1/workflows')",
    );
    expect(call?.scope).toBe("setup:module");
  });

  it("separates declarations in dual Vue script contexts", () => {
    const facts = project(
      parse(
        "src/App.vue",
        `<script lang="ts">const url='/api/old';fetch(url)</script><script setup lang="ts">const url='/api/new';fetch(url)</script>`,
        createVueAdapter(),
      ),
    );
    expect(facts.bindings.map((binding) => [binding.scope, binding.name])).toEqual([
      ["script:module", "url"],
      ["setup:module", "url"],
    ]);
    expect(facts.calls.map((call) => call.scope)).toEqual(["script:module", "setup:module"]);
  });

  it("requires AST/source agreement and the actual content hash", () => {
    const input = parse("src/client.ts", "fetch('/api/v1/workflows')", createTypeScriptAdapter());
    expect(
      extractHttpBoundaryFacts({ ...input.source, contentHash: "wrong" }, input.ast).calls,
    ).toEqual([]);
    const otherContent = "fetch('/unrelated')";
    const mismatch = extractHttpBoundaryFacts(
      { ...input.source, content: otherContent, contentHash: sha256Hex(otherContent) },
      input.ast,
    );
    expect(mismatch.calls).toEqual([]);
    expect(mismatch.limitations).toContain("Unsupported parser AST payload");
  });

  it("does not project recoverable parse fragments as complete HTTP evidence", () => {
    const input = parse(
      "src/client.ts",
      "function f() { fetch('/api/v1/workflows')",
      createTypeScriptAdapter(),
    );
    expect(input.ast.parseQuality).toBe("partial");
    expect(project(input).calls).toEqual([]);
    expect(project(input).limitations).toContain(
      "HTTP boundary extraction requires a complete parse",
    );
  });

  it("does not prove constructors shadowed by a function or assignment", () => {
    const facts = project(
      parse(
        "backend/app/routes.py",
        `from fastapi import APIRouter\ndef APIRouter():\n    return Other()\nrouter = APIRouter()\n@router.get('/fake')\ndef fake():\n    return {}\n`,
        createPythonAdapter(),
      ),
    );
    expect(facts.routers).toEqual([]);
    expect(facts.limitations).toContain("FastAPI constructor APIRouter is shadowed");
  });

  it("ignores imports nested in unrelated functions as module constructor evidence", () => {
    const facts = project(
      parse(
        "backend/app/routes.py",
        `def unrelated():\n    from fastapi import APIRouter\nrouter=APIRouter()\n@router.get('/fake')\ndef fake():\n    return {}\n`,
        createPythonAdapter(),
      ),
    );
    expect(facts.routers).toEqual([]);
    expect(facts.pythonImports).toEqual([]);
  });

  it("keeps escaped URL literals and arbitrary expressions explicitly unknown", () => {
    const facts = project(
      parse(
        "src/client.ts",
        String.raw`fetch('/api/\u0076\u0031/workflows');fetch(new URL('/api/v1/workflows', origin));`,
        createTypeScriptAdapter(),
      ),
    );
    expect(facts.calls[0]?.arguments[0]).toMatchObject({ kind: "unknown" });
    expect(facts.calls[1]?.arguments[0]).toMatchObject({ kind: "unknown" });
  });
  it("does not prove a FastAPI constructor hidden by a function parameter or import alias", () => {
    const parameter = project(
      parse(
        "backend/app/routes.py",
        `from fastapi import FastAPI\ndef create_app(FastAPI):\n    app=FastAPI()\n    return app\n`,
        createPythonAdapter(),
      ),
    );
    expect(parameter.routers).toEqual([]);
    expect(parameter.limitations).toContain("FastAPI constructor FastAPI is shadowed");
    const imported = project(
      parse(
        "backend/app/routes.py",
        `from fastapi import FastAPI\nfrom other import Factory as FastAPI\napp=FastAPI()\n`,
        createPythonAdapter(),
      ),
    );
    expect(imported.routers).toEqual([]);
    expect(imported.limitations).toContain("FastAPI constructor FastAPI is shadowed");
  });
});
