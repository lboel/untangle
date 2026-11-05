import type { ParsedAst, SourceFile, SourceRange } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { createParserRegistry } from "../../index.js";
import { MAX_PARSE_SOURCE_BYTES } from "../shared/parse-limits.js";
import { createTypeScriptAdapter } from "../typescript/index.js";

import { createVueAdapter, type VueAstRoot } from "./index.js";

function source(content: string, path = "Widget.vue"): SourceFile {
  return {
    fileId: "file-widget",
    repoId: "repo",
    refId: "ref",
    path,
    languageId: "vue",
    content,
    contentHash: "test",
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

function parse(content: string) {
  const adapter = createVueAdapter();
  const result = adapter.parse(source(content));
  expect(result.ast).not.toBeNull();
  return { adapter, result, ast: result.ast as ParsedAst };
}

function slice(content: string, range: SourceRange): string {
  return Buffer.from(content, "utf8").subarray(range.startByte, range.endByte).toString("utf8");
}

describe("Vue SFC script adapter", () => {
  it("routes Vue extensions to a structural adapter", () => {
    const registry = createParserRegistry();
    expect(registry.getAdapterForPath("src/Widget.VUE")?.languageId).toBe("vue");
    expect(registry.supportLevelOf("vue")).toBe("structural");
  });

  it.each([
    ["", "function submit(value) { if (value) return save(value); }"],
    [' lang="js"', "function submit(value) { if (value) return save(value); }"],
    [
      ' lang="ts"',
      "function submit(value: number): number { if (value) return save(value); return 0; }",
    ],
    [' lang="tsx"', "function submit() { return <button onClick={save}>Save</button>; }"],
    [' lang="jsx"', "function submit() { return <button onClick={save}>Save</button>; }"],
  ])("analyzes original inline script setup%s", (attributes, code) => {
    const content = `<template><button @click="submit">Save</button></template>\n<script setup${attributes}>\n${code}\n</script>\n<style>.button { display: block }</style>`;
    const { adapter, result, ast } = parse(content);
    expect(result.parseQuality).toBe("complete");
    expect(result.errorNodeCount).toBe(0);
    expect(adapter.extractSymbols(ast).map((symbol) => symbol.qualifiedName)).toContain("submit");
    expect(
      result.diagnostics.some(
        (item) => item.kind === "other" && item.message.includes("inline script code only"),
      ),
    ).toBe(true);
    expect(adapter.computeComplexity(ast).parseDiagnostics).toEqual(result.diagnostics);
    expect(adapter.computeComplexity(ast).operands.some((fact) => fact.text === "display")).toBe(
      false,
    );
  });

  it("retains byte and line offsets after astral characters, non-ASCII text and CRLF", () => {
    const code =
      'import { save as persist } from "./api";\r\n// grün 🌿\r\nfunction submit(value: number) { const label = "für 🌿"; if (value) return persist(label); return 0; }';
    const content = `<template>Grüße 🌿</template>\r\n<script setup lang="ts">${code}</script>`;
    const { adapter, ast } = parse(content);
    const [symbol] = adapter.extractSymbols(ast);
    expect(symbol).toBeDefined();
    expect(slice(content, symbol!.range)).toBe(code.slice(code.indexOf("function submit")));
    expect(symbol?.range.startLine).toBe(4);
    const [imported] = adapter.extractImports(ast);
    expect(slice(content, imported!.range)).toBe('import { save as persist } from "./api";');
    expect(imported?.bindings).toEqual([
      { localName: "persist", importedName: "save", kind: "named" },
    ]);
    const [call] = adapter.extractCalls(ast);
    expect(slice(content, call!.range)).toBe("persist(label)");
    const facts = adapter.computeComplexity(ast);
    expect(facts.comments.map((range) => slice(content, range))).toEqual(["// grün 🌿"]);
    expect(facts.literals.map((fact) => slice(content, fact.range))).toContain('"für 🌿"');
    const caller = facts.symbolScopes.find((scope) => scope.name === "submit");
    expect(call?.callerScopeId).toBe(caller?.symbolScopeId);
    for (const fact of [
      ...facts.decisions,
      ...facts.nestingEvents,
      ...facts.operators,
      ...facts.operands,
      ...facts.identifiers,
      ...facts.literals,
    ]) {
      expect(fact.range.startByte).toBeGreaterThanOrEqual(
        Buffer.byteLength(content.slice(0, content.indexOf(code)), "utf8"),
      );
      expect(fact.range.endByte).toBeLessThanOrEqual(
        Buffer.byteLength(content.slice(0, content.indexOf("</script>")), "utf8"),
      );
    }
  });

  it("keeps native TS decision and token facts rather than analyzing generated component code", () => {
    const code =
      "export function classify(value: number) { if (value < 0) return false; for (let i = 0; i < value; i++) save(i); return true; }";
    const { adapter, ast } = parse(`<script lang="ts">${code}</script>`);
    const ts = createTypeScriptAdapter();
    const native = ts.parse({ ...source(code, "Widget.ts"), languageId: "typescript" });
    const expected = ts.computeComplexity(native.ast!);
    const facts = adapter.computeComplexity(ast);
    expect(facts.decisions.map((fact) => fact.kind)).toEqual(
      expected.decisions.map((fact) => fact.kind),
    );
    expect(facts.nestingEvents.map((fact) => fact.construct)).toEqual(
      expected.nestingEvents.map((fact) => fact.construct),
    );
    expect(facts.operators.map((fact) => fact.text)).toEqual(
      expected.operators.map((fact) => fact.text),
    );
    expect(facts.operands.map((fact) => fact.text)).toEqual(
      expected.operands.map((fact) => fact.text),
    );
    expect(adapter.tokenizeForHalstead(ast)).toEqual({
      operators: facts.operators,
      operands: facts.operands,
    });
  });

  it("keeps both script contexts distinct without duplicate symbol or caller identities", () => {
    const content =
      '<script lang="ts">export function same() { return moduleCall(); }</script>\n<template>{{ label }}</template>\n<script setup lang="ts">function same() { return setupCall(); }</script>';
    const { adapter, result, ast } = parse(content);
    expect(result.parseQuality).toBe("complete");
    expect(adapter.extractSymbols(ast).map((symbol) => symbol.qualifiedName)).toEqual([
      "script.same",
      "setup.same",
    ]);
    const facts = adapter.computeComplexity(ast);
    const scopes = facts.symbolScopes.filter((scope) => scope.name === "same");
    expect(new Set(scopes.map((scope) => scope.symbolScopeId)).size).toBe(2);
    expect(facts.symbolScopes.filter((scope) => scope.kind === "file")).toHaveLength(1);
    expect(adapter.extractCalls(ast).map((call) => call.callerScopeId)).toEqual(
      scopes.map((scope) => scope.symbolScopeId),
    );
    const [root] = adapter.extractChunks(ast);
    expect(root?.children?.map((region) => region.symbolFqn)).toEqual([
      "script.same",
      "setup.same",
    ]);
    expect(root?.range).toEqual({
      startLine: 1,
      endLine: 3,
      startByte: 0,
      endByte: Buffer.byteLength(content),
    });
  });

  it("keeps independent logical groups in separate inline blocks distinct", () => {
    const { adapter, ast } = parse(
      "<script>const result = left && right;</script><script setup>const result = left && right;</script>",
    );
    const decisions = adapter.computeComplexity(ast).decisions;
    expect(decisions).toHaveLength(2);
    expect(new Set(decisions.map((fact) => fact.logicalGroupId)).size).toBe(2);
    expect(decisions.map((fact) => fact.symbolScopeId)).toEqual(["file-widget", "file-widget"]);
  });

  it("preserves physical source ordering when script setup appears first", () => {
    const { adapter, ast } = parse(
      '<script setup>import { first } from "./first"; function run() { return first(); }</script><script>import { last } from "./last"; export function run() { return last(); }</script>',
    );
    expect(adapter.extractImports(ast).map((item) => item.specifier)).toEqual([
      "./first",
      "./last",
    ]);
    expect(adapter.extractSymbols(ast).map((item) => item.qualifiedName)).toEqual([
      "setup.run",
      "script.run",
    ]);
    expect(adapter.extractCalls(ast).map((item) => item.calleeName)).toEqual(["first", "last"]);
  });

  it("reports original unmeasured block ranges without inventing syntax damage", () => {
    const content =
      "<template><span>{{ ready }}</span></template>\n<script setup>const ready = true;</script>\n<style scoped>.ready { color: green }</style>\n<docs>🌿 usage</docs>";
    const { result } = parse(content);
    expect(result.parseQuality).toBe("complete");
    expect(result.errorNodeCount + result.missingNodeCount).toBe(0);
    const limits = result.diagnostics.filter((item) => item.kind === "other");
    expect(limits).toHaveLength(3);
    expect(limits.every((item) => item.message.startsWith("Vue analysis scope:"))).toBe(true);
    expect(limits.every((item) => item.code === "analysis_scope_limited")).toBe(true);
    expect(limits.map((item) => slice(content, item.range))).toEqual([
      "<span>{{ ready }}</span>",
      ".ready { color: green }",
      "🌿 usage",
    ]);
  });

  it("enforces the byte limit before parsing an oversized SFC", () => {
    const content = "ä".repeat(MAX_PARSE_SOURCE_BYTES / 2 + 1);
    expect(() => createVueAdapter().parse(source(content))).toThrowError(
      "Vue SFC exceeds the parser source-byte limit.",
    );
  });

  it("preserves Options API methods and nested class chunk regions", () => {
    const content =
      "<script>export default { methods: { submit(value) { if (value) save(value); } } }; class State { run() { return save(); } }</script>";
    const { adapter, result, ast } = parse(content);
    expect(result.parseQuality).toBe("complete");
    expect(adapter.extractSymbols(ast).some((symbol) => symbol.name === "submit")).toBe(true);
    expect(
      adapter.extractChunks(ast)[0]?.children?.find((region) => region.symbolFqn === "State")
        ?.children?.[0]?.symbolFqn,
    ).toBe("State.run");
  });

  it("returns a full-file region but no fabricated code facts for template-only SFCs", () => {
    const content =
      '<template><div v-if="ready">{{ callBackend() }}</div></template><style>.x { color: red }</style>';
    const { adapter, result, ast } = parse(content);
    expect(result.parseQuality).toBe("partial");
    expect(result.diagnostics.some((item) => item.message.includes("no inline script"))).toBe(true);
    expect(adapter.extractSymbols(ast)).toEqual([]);
    expect(adapter.extractCalls(ast)).toEqual([]);
    expect(adapter.computeComplexity(ast).symbolScopes).toEqual([]);
    expect(adapter.extractChunks(ast)[0]?.range.endByte).toBe(Buffer.byteLength(content));
  });

  it.each([
    ['<script src="./logic.ts"></script>', "external script src"],
    ['<script setup src="./logic.ts"></script>', 'cannot use the "src" attribute'],
    ['<script lang="coffee">ready = yes</script>', "unsupported script language"],
    [
      '<script lang="ts">const value = 1;</script><script setup>const other = 2;</script>',
      "same language",
    ],
  ])("marks unsupported or external script coverage as partial: %s", (content, message) => {
    const { result } = parse(content);
    expect(result.parseQuality).toBe("partial");
    expect(result.diagnostics.some((item) => item.message.includes(message))).toBe(true);
  });

  it("reports malformed block boundaries as syntax errors", () => {
    const { result } = parse("<template><div></template><script setup>const n = 1;</script>");
    expect(result.parseQuality).toBe("partial");
    expect(result.errorNodeCount).toBeGreaterThan(0);
    expect(result.diagnostics.some((item) => item.severity === "error")).toBe(true);
  });

  it("reports script syntax damage at original SFC locations", () => {
    const content =
      '<template>🌿</template>\n<script setup lang="ts">\nfunction good() { return 1; }\nconst broken = ;\n</script>';
    const { adapter, result, ast } = parse(content);
    expect(result.parseQuality).toBe("partial");
    expect(result.errorNodeCount + result.missingNodeCount).toBeGreaterThan(0);
    expect(
      result.diagnostics
        .filter((item) => item.severity === "error")
        .every((item) => item.range.startLine >= 3),
    ).toBe(true);
    expect(adapter.computeComplexity(ast).parseDiagnostics).toEqual(result.diagnostics);
  });

  it("exposes original embedded sources for independent AST consumers", () => {
    const code = 'const response = await fetch("/api/orders");';
    const { ast } = parse(`<script setup lang="ts">${code}</script>`);
    const root = ast.root as VueAstRoot;
    expect(root.kind).toBe("vue-sfc");
    expect(root.scripts[0]?.source.content).toBe(code);
    expect(root.scripts[0]?.source.languageId).toBe("typescript");
    expect(root.scripts[0]?.ast.languageId).toBe("typescript");
  });
});
