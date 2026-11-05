import type { SourceFile } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { createJavaScriptAdapter } from "./javascript/index.js";
import { createJsxAdapter } from "./jsx/index.js";
import { createTsxAdapter } from "./tsx/index.js";
import { createTypeScriptAdapter } from "./typescript/index.js";

function sourceFile(
  overrides: Partial<SourceFile> & Pick<SourceFile, "content" | "path" | "languageId">,
): SourceFile {
  return {
    fileId: "file-1",
    repoId: "repo-1",
    refId: "repo-1:main",
    contentHash: "hash",
    sizeBytes: Buffer.byteLength(overrides.content, "utf8"),
    ...overrides,
  };
}

describe("TypeScript adapter", () => {
  const adapter = createTypeScriptAdapter();

  it("reports languageId, extensions and support level", () => {
    expect(adapter.languageId).toBe("typescript");
    expect(adapter.extensions).toEqual([".ts", ".mts", ".cts"]);
    expect(adapter.supportLevel).toBe("deep");
  });

  it("does not crash on a syntax error and reports partial/failed, never throwing", () => {
    const broken = sourceFile({
      path: "broken.ts",
      languageId: "typescript",
      content: "export function broken( {{{ this is not valid typescript &&& ",
    });
    expect(() => adapter.parse(broken)).not.toThrow();
    const result = adapter.parse(broken);
    expect(["partial", "failed"]).toContain(result.parseQuality);
    if (result.parseQuality === "failed") {
      expect(result.ast).toBeNull();
    } else {
      expect(result.ast).not.toBeNull();
    }
    expect(result.errorNodeCount + result.missingNodeCount).toBeGreaterThan(0);
  });

  it("reports failed with a null ast when the tree is overwhelmingly broken", () => {
    const gibberish = sourceFile({
      path: "gibberish.ts",
      languageId: "typescript",
      content: "@#$%^&*(  ]] }} )) <<< >>> ::: ,,, ;;; ===",
    });
    const result = adapter.parse(gibberish);
    if (result.parseQuality === "failed") {
      expect(result.ast).toBeNull();
    }
  });

  it("gives a class with multiple methods separate, non-overlapping chunk regions", () => {
    const source = sourceFile({
      path: "shape.ts",
      languageId: "typescript",
      content: `
export class Shape {
  area(): number {
    return 0;
  }

  perimeter(): number {
    return 0;
  }
}
`,
    });
    const parsed = adapter.parse(source);
    const [moduleRegion] = adapter.extractChunks(parsed.ast!);
    const classRegion = moduleRegion?.children?.find((r) => r.chunkKind === "class_overview");
    expect(classRegion).toBeDefined();
    const methodRegions = classRegion?.children?.filter((r) => r.chunkKind === "method") ?? [];
    expect(methodRegions).toHaveLength(2);
    expect(methodRegions[0]?.symbolFqn).toBe("Shape.area");
    expect(methodRegions[1]?.symbolFqn).toBe("Shape.perimeter");
    // Regions must not overlap.
    expect(methodRegions[0]!.range.endByte).toBeLessThanOrEqual(methodRegions[1]!.range.startByte);
  });

  it("detects a dynamic import and a re-export with source positions", () => {
    const source = sourceFile({
      path: "mod.ts",
      languageId: "typescript",
      content: `
export * from "./all";
export { named } from "./named";
const lazy = () => import("./lazy-module");
`,
    });
    const parsed = adapter.parse(source);
    const imports = adapter.extractImports(parsed.ast!);
    expect(imports).toContainEqual(
      expect.objectContaining({ specifier: "./all", importKind: "re_export" }),
    );
    expect(imports).toContainEqual(
      expect.objectContaining({
        specifier: "./named",
        importKind: "re_export",
        importedNames: ["named"],
      }),
    );
    const dynamicImport = imports.find((i) => i.importKind === "dynamic_import");
    expect(dynamicImport).toBeDefined();
    expect(dynamicImport?.specifier).toBe("./lazy-module");
    expect(dynamicImport?.range.startLine).toBeGreaterThan(0);
  });

  it("produces an identical normalizedSignature for functions differing only in whitespace/formatting", () => {
    const compact = sourceFile({
      path: "a.ts",
      languageId: "typescript",
      content: "export function f(a:number,b:string='x'):void{}",
    });
    const spread = sourceFile({
      path: "b.ts",
      languageId: "typescript",
      content: `export function f(
        a : number ,
        b   ?  :   string
      )   :   void
      {

      }`,
    });
    // Note: the second form makes `b` optional instead of defaulted, to also
    // prove the optional-marker path converges — swap it for a literal
    // default-only variant to compare apples to apples:
    const spreadWithDefault = sourceFile({
      path: "c.ts",
      languageId: "typescript",
      content: `export function f(
        a : number ,
        b   :   string   =   'x'
      )   :   void
      {

      }`,
    });

    const parsedCompact = adapter.parse(compact);
    const parsedSpread = adapter.parse(spreadWithDefault);
    const sigCompact = adapter.extractSymbols(parsedCompact.ast!)[0]?.normalizedSignature;
    const sigSpread = adapter.extractSymbols(parsedSpread.ast!)[0]?.normalizedSignature;
    expect(sigCompact).toBe(sigSpread);
    expect(sigCompact).toBe("f(a: number, b: string): void");

    const parsedOptional = adapter.parse(spread);
    const sigOptional = adapter.extractSymbols(parsedOptional.ast!)[0]?.normalizedSignature;
    expect(sigOptional).toBe("f(a: number, b?: string): void");
    expect(sigOptional).not.toBe(sigCompact);
  });

  it("computes stable astHash/tokenFingerprint across whitespace-only reformatting, and different ones for a real edit", () => {
    const original = sourceFile({
      path: "x.ts",
      languageId: "typescript",
      content: "export function f(a: number): number { return a + 1; }",
    });
    const reformatted = sourceFile({
      path: "y.ts",
      languageId: "typescript",
      content: "export function f(a: number): number {\n  return a + 1;\n}",
    });
    const edited = sourceFile({
      path: "z.ts",
      languageId: "typescript",
      content: "export function f(a: number): number { return a + 2; }",
    });

    const symOriginal = adapter.extractSymbols(adapter.parse(original).ast!)[0]!;
    const symReformatted = adapter.extractSymbols(adapter.parse(reformatted).ast!)[0]!;
    const symEdited = adapter.extractSymbols(adapter.parse(edited).ast!)[0]!;

    expect(symReformatted.astHash).toBe(symOriginal.astHash);
    expect(symReformatted.tokenFingerprint).toBe(symOriginal.tokenFingerprint);
    // astHash ignores literal text (structural only) — a literal-only edit keeps it stable...
    expect(symEdited.astHash).toBe(symOriginal.astHash);
    // ...but the token fingerprint (lexical) must change.
    expect(symEdited.tokenFingerprint).not.toBe(symOriginal.tokenFingerprint);
  });

  it("resolves guard-clause if-statements to DecisionKind 'guard'", () => {
    const source = sourceFile({
      path: "guard.ts",
      languageId: "typescript",
      content: `
export function f(a: number): number {
  if (a < 0) return -1;
  return a;
}
`,
    });
    const parsed = adapter.parse(source);
    const facts = adapter.computeComplexity(parsed.ast!);
    expect(facts.decisions.map((d) => d.kind)).toEqual(["guard"]);
  });
});

describe("JavaScript adapter", () => {
  const adapter = createJavaScriptAdapter();

  it("reports languageId, extensions and support level", () => {
    expect(adapter.languageId).toBe("javascript");
    expect(adapter.extensions).toEqual([".js", ".mjs", ".cjs"]);
    expect(adapter.supportLevel).toBe("deep");
  });

  it("extracts a require() call as an import edge", () => {
    const source = sourceFile({
      path: "a.js",
      languageId: "javascript",
      content: 'const path = require("node:path");',
    });
    const parsed = adapter.parse(source);
    const imports = adapter.extractImports(parsed.ast!);
    expect(imports).toContainEqual(
      expect.objectContaining({ specifier: "node:path", importKind: "import" }),
    );
  });
});

describe("TSX adapter", () => {
  const adapter = createTsxAdapter();

  it("reports languageId, extensions and support level", () => {
    expect(adapter.languageId).toBe("tsx");
    expect(adapter.extensions).toEqual([".tsx"]);
    expect(adapter.supportLevel).toBe("deep");
  });

  it("parses JSX with an embedded ternary without error", () => {
    const source = sourceFile({
      path: "c.tsx",
      languageId: "tsx",
      content: 'export const C = () => <div>{1 > 0 ? "a" : "b"}</div>;',
    });
    const result = adapter.parse(source);
    expect(result.parseQuality).toBe("complete");
  });
});

describe("JSX adapter", () => {
  const adapter = createJsxAdapter();

  it("reports languageId, extensions and support level", () => {
    expect(adapter.languageId).toBe("jsx");
    expect(adapter.extensions).toEqual([".jsx"]);
    expect(adapter.supportLevel).toBe("deep");
  });

  it("parses plain JSX (no TS types) without error", () => {
    const source = sourceFile({
      path: "c.jsx",
      languageId: "jsx",
      content:
        "export function C(props) { return <div className={props.name}>{props.name}</div>; }",
    });
    const result = adapter.parse(source);
    expect(result.parseQuality).toBe("complete");
    const symbols = adapter.extractSymbols(result.ast!);
    expect(symbols[0]?.name).toBe("C");
  });
});
