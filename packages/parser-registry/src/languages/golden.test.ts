import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  ExtractedSymbol,
  LanguageAdapter,
  RawImport,
  SourceFile,
} from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { createJavaScriptAdapter } from "./javascript/index.js";
import { createTsxAdapter } from "./tsx/index.js";
import { createTypeScriptAdapter } from "./typescript/index.js";

interface GoldenExpectedSymbol {
  name: string;
  kind: string;
  qualifiedName: string;
  normalizedSignature?: string;
  exportedNames?: string[];
  visibility?: string;
  hasDocRange?: boolean;
}

interface GoldenExpectedImport {
  specifier: string;
  importKind: RawImport["importKind"];
  importedNames?: string[];
}

interface GoldenExpectedCall {
  calleeName: string;
  qualifier?: string;
}

interface GoldenFixture {
  languageId: string;
  path: string;
  source: string;
  expectedSymbols: GoldenExpectedSymbol[];
  expectedImports: GoldenExpectedImport[];
  expectedCallCount?: number;
  expectedCalls?: GoldenExpectedCall[];
  expectedDecisionKinds: string[];
}

function loadGolden(name: string): GoldenFixture {
  const path = fileURLToPath(new URL(`./__golden__/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as GoldenFixture;
}

function toSourceFile(fixture: GoldenFixture): SourceFile {
  return {
    fileId: `golden-${fixture.path}`,
    repoId: "golden-repo",
    refId: "golden-repo:main",
    path: fixture.path,
    languageId: fixture.languageId,
    content: fixture.source,
    contentHash: "golden",
    sizeBytes: Buffer.byteLength(fixture.source, "utf8"),
  };
}

function findSymbol(
  symbols: ExtractedSymbol[],
  qualifiedName: string,
): ExtractedSymbol | undefined {
  return symbols.find((s) => s.qualifiedName === qualifiedName);
}

function runGolden(adapter: LanguageAdapter, fixture: GoldenFixture): void {
  const parseResult = adapter.parse(toSourceFile(fixture));
  expect(parseResult.parseQuality).toBe("complete");
  expect(parseResult.ast).not.toBeNull();
  const ast = parseResult.ast!;

  const symbols = adapter.extractSymbols(ast);
  for (const expected of fixture.expectedSymbols) {
    const actual = findSymbol(symbols, expected.qualifiedName);
    expect(actual, `expected a symbol named "${expected.qualifiedName}"`).toBeDefined();
    expect(actual?.name).toBe(expected.name);
    expect(actual?.kind).toBe(expected.kind);
    if (expected.normalizedSignature !== undefined) {
      expect(actual?.normalizedSignature).toBe(expected.normalizedSignature);
    }
    if (expected.exportedNames !== undefined) {
      expect(actual?.exportedNames).toEqual(expected.exportedNames);
    }
    if (expected.visibility !== undefined) {
      expect(actual?.visibility).toBe(expected.visibility);
    }
    if (expected.hasDocRange === true) {
      expect(actual?.docRange).toBeDefined();
    }
    // Every symbol must carry non-empty structural/lexical fingerprints (spec.md §17.3).
    expect(actual?.astHash.length).toBeGreaterThan(0);
    expect(actual?.tokenFingerprint.length).toBeGreaterThan(0);
  }

  const imports = adapter.extractImports(ast);
  for (const expected of fixture.expectedImports) {
    const actual = imports.find(
      (i) => i.specifier === expected.specifier && i.importKind === expected.importKind,
    );
    expect(
      actual,
      `expected an import of "${expected.specifier}" (${expected.importKind})`,
    ).toBeDefined();
    if (expected.importedNames !== undefined) {
      expect(actual?.importedNames).toEqual(expected.importedNames);
    }
  }

  const calls = adapter.extractCalls(ast);
  if (fixture.expectedCallCount !== undefined) {
    expect(calls.length).toBe(fixture.expectedCallCount);
  }
  for (const expected of fixture.expectedCalls ?? []) {
    const actual = calls.find(
      (c) =>
        c.calleeName === expected.calleeName &&
        (expected.qualifier === undefined || c.qualifier === expected.qualifier),
    );
    expect(actual, `expected a call to "${expected.calleeName}"`).toBeDefined();
  }

  const facts = adapter.computeComplexity(ast);
  expect(facts.decisions.map((d) => d.kind).sort()).toEqual(
    [...fixture.expectedDecisionKinds].sort(),
  );

  // Every symbolScopeId referenced by a decision/call must resolve to a real scope
  // (this is the cross-method consistency the single-walk design guarantees).
  const scopeIds = new Set(facts.symbolScopes.map((s) => s.symbolScopeId));
  for (const decision of facts.decisions) {
    expect(scopeIds.has(decision.symbolScopeId)).toBe(true);
  }
  for (const call of calls) {
    expect(scopeIds.has(call.callerScopeId)).toBe(true);
  }

  // AST depth sanity: the file has real nesting, so some node sits deeper than the root's direct children.
  const maxDepth = Math.max(...facts.nodeKinds.map((n) => n.depth));
  expect(maxDepth).toBeGreaterThan(2);
}

describe("golden fixtures", () => {
  it("typescript-basic.json", () => {
    runGolden(createTypeScriptAdapter(), loadGolden("typescript-basic.json"));
  });

  it("javascript-basic.json", () => {
    runGolden(createJavaScriptAdapter(), loadGolden("javascript-basic.json"));
  });

  it("tsx-basic.json", () => {
    runGolden(createTsxAdapter(), loadGolden("tsx-basic.json"));
  });
});
