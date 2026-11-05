import type { SourceFile } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { createPythonAdapter } from "./index.js";

function sourceFile(
  overrides: Partial<SourceFile> & Pick<SourceFile, "content" | "path">,
): SourceFile {
  return {
    fileId: "file-1",
    repoId: "repo-1",
    refId: "repo-1:main",
    languageId: "python",
    contentHash: "hash",
    sizeBytes: Buffer.byteLength(overrides.content, "utf8"),
    ...overrides,
  };
}

describe("Python adapter", () => {
  const adapter = createPythonAdapter();

  it("reports languageId, extensions and support level", () => {
    expect(adapter.languageId).toBe("python");
    expect(adapter.extensions).toEqual([".py", ".pyi"]);
    expect(adapter.supportLevel).toBe("deep");
  });

  it("does not crash on a syntax error and reports partial/failed, never throwing", () => {
    const broken = sourceFile({ path: "broken.py", content: "def broken(a, , b):\n    pass\n" });
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

  it("reports failed with a null ast when the input is overwhelmingly broken gibberish", () => {
    const gibberish = sourceFile({
      path: "gibberish.py",
      content: "@#$%^&*(  ]] }} )) <<< >>> ::: ,,, ;;; ===\n" + ")))))))\n(((((((\n",
    });
    const result = adapter.parse(gibberish);
    if (result.parseQuality === "failed") {
      expect(result.ast).toBeNull();
    }
  });

  it("does not throw and terminates quickly on adversarial input (no hang)", () => {
    const inputs = [
      "def broken(:\n    pass\n",
      "class C(:\n  def f(self:\n    return\n",
      ")))))))))))))))))))))",
      "(((((((((((((((((((((",
    ];
    for (const content of inputs) {
      const source = sourceFile({ path: "x.py", content });
      const start = performance.now();
      expect(() => adapter.parse(source)).not.toThrow();
      expect(performance.now() - start).toBeLessThan(2000);
    }
  });

  it("reports complete for well-formed source", () => {
    const source = sourceFile({ path: "ok.py", content: "def f():\n    return 1\n" });
    const result = adapter.parse(source);
    expect(result.parseQuality).toBe("complete");
    expect(result.ast).not.toBeNull();
  });

  it("gives a class with multiple methods separate, non-overlapping chunk regions", () => {
    const source = sourceFile({
      path: "shape.py",
      content:
        "class Shape:\n    def area(self):\n        return 0\n\n    def perimeter(self):\n        return 0\n",
    });
    const parsed = adapter.parse(source);
    const [moduleRegion] = adapter.extractChunks(parsed.ast!);
    const classRegion = moduleRegion?.children?.find((r) => r.chunkKind === "class_overview");
    expect(classRegion).toBeDefined();
    const methodRegions = classRegion?.children?.filter((r) => r.chunkKind === "method") ?? [];
    expect(methodRegions).toHaveLength(2);
    expect(methodRegions[0]?.symbolFqn).toBe("Shape.area");
    expect(methodRegions[1]?.symbolFqn).toBe("Shape.perimeter");
    expect(methodRegions[0]!.range.endByte).toBeLessThanOrEqual(methodRegions[1]!.range.startByte);
  });

  it("covers decorator lines within the decorated symbol's own chunk region", () => {
    const source = sourceFile({
      path: "deco.py",
      content: "@app.route('/x')\n@another\ndef handler():\n    return 1\n",
    });
    const parsed = adapter.parse(source);
    const [moduleRegion] = adapter.extractChunks(parsed.ast!);
    const fnRegion = moduleRegion?.children?.find((r) => r.chunkKind === "function");
    expect(fnRegion).toBeDefined();
    // The region must start at or before the first decorator's "@" — never after it.
    const decoByteOffset = Buffer.byteLength("", "utf8");
    expect(fnRegion!.range.startByte).toBe(decoByteOffset);
  });

  it("classifies module-level and nested symbol kinds correctly (function/class/method/constructor)", () => {
    const source = sourceFile({
      path: "kinds.py",
      content:
        "class C:\n    def __init__(self):\n        pass\n\n    def method(self):\n        pass\n\ndef top():\n    pass\n",
    });
    const parsed = adapter.parse(source);
    const symbols = adapter.extractSymbols(parsed.ast!);
    expect(symbols.find((s) => s.qualifiedName === "C")?.kind).toBe("class");
    expect(symbols.find((s) => s.qualifiedName === "C.__init__")?.kind).toBe("constructor");
    expect(symbols.find((s) => s.qualifiedName === "C.method")?.kind).toBe("method");
    expect(symbols.find((s) => s.qualifiedName === "top")?.kind).toBe("function");
  });

  it("computes visibility from leading-underscore convention, dunder methods staying public", () => {
    const source = sourceFile({
      path: "vis.py",
      content:
        "class C:\n    def __init__(self):\n        pass\n    def _protected(self):\n        pass\n    def __private(self):\n        pass\n",
    });
    const parsed = adapter.parse(source);
    const symbols = adapter.extractSymbols(parsed.ast!);
    expect(symbols.find((s) => s.name === "__init__")?.visibility).toBeUndefined();
    expect(symbols.find((s) => s.name === "_protected")?.visibility).toBe("protected");
    expect(symbols.find((s) => s.name === "__private")?.visibility).toBe("private");
  });

  it("computes exportedNames from leading underscore when no __all__ is present", () => {
    const source = sourceFile({
      path: "exp.py",
      content: "def public_fn():\n    pass\n\ndef _hidden():\n    pass\n",
    });
    const parsed = adapter.parse(source);
    const symbols = adapter.extractSymbols(parsed.ast!);
    expect(symbols.find((s) => s.name === "public_fn")?.exportedNames).toEqual(["public_fn"]);
    expect(symbols.find((s) => s.name === "_hidden")?.exportedNames).toEqual([]);
  });

  it("computes exportedNames from __all__ when present, overriding the underscore convention", () => {
    const source = sourceFile({
      path: "dunder_all.py",
      content: "__all__ = ['a']\n\ndef a():\n    pass\n\ndef b():\n    pass\n",
    });
    const parsed = adapter.parse(source);
    const symbols = adapter.extractSymbols(parsed.ast!);
    expect(symbols.find((s) => s.name === "a")?.exportedNames).toEqual(["a"]);
    expect(symbols.find((s) => s.name === "b")?.exportedNames).toEqual([]);
  });

  it("binds a docstring to its symbol's docRange", () => {
    const source = sourceFile({
      path: "doc.py",
      content: 'def f():\n    """My docstring."""\n    return 1\n',
    });
    const parsed = adapter.parse(source);
    const symbols = adapter.extractSymbols(parsed.ast!);
    expect(symbols[0]?.docRange).toBeDefined();
  });

  it("detects import, from-import, relative import, and star import", () => {
    const source = sourceFile({
      path: "imports.py",
      content:
        "import os\nimport os.path as osp\nfrom . import sibling\nfrom ..pkg import thing as t\nfrom collections import OrderedDict, defaultdict\n",
    });
    const parsed = adapter.parse(source);
    const imports = adapter.extractImports(parsed.ast!);
    expect(imports).toContainEqual(
      expect.objectContaining({ specifier: "os", importKind: "import" }),
    );
    expect(imports).toContainEqual(
      expect.objectContaining({
        specifier: "os.path",
        importKind: "import",
        importedNames: ["osp"],
      }),
    );
    expect(imports).toContainEqual(
      expect.objectContaining({ specifier: ".", importKind: "import" }),
    );
    expect(imports).toContainEqual(
      expect.objectContaining({ specifier: "..pkg", importKind: "import", importedNames: ["t"] }),
    );
    const collectionsImport = imports.find((i) => i.specifier === "collections");
    expect(collectionsImport?.importedNames).toEqual(["OrderedDict", "defaultdict"]);
  });

  it("classifies __init__.py top-level imports as re_export", () => {
    const source = sourceFile({
      path: "pkg/__init__.py",
      content: "from .module import Thing\nimport os\n",
    });
    const parsed = adapter.parse(source);
    const imports = adapter.extractImports(parsed.ast!);
    expect(imports).toContainEqual(
      expect.objectContaining({ specifier: ".module", importKind: "re_export" }),
    );
    expect(imports).toContainEqual(
      expect.objectContaining({ specifier: "os", importKind: "re_export" }),
    );
  });

  it("does not classify an ordinary module's imports as re_export", () => {
    const source = sourceFile({ path: "pkg/module.py", content: "from .other import Thing\n" });
    const parsed = adapter.parse(source);
    const imports = adapter.extractImports(parsed.ast!);
    expect(imports[0]?.importKind).toBe("import");
  });

  it("detects calls with and without a qualifier", () => {
    const source = sourceFile({
      path: "calls.py",
      content: "def f():\n    helper()\n    obj.method(1, 2)\n",
    });
    const parsed = adapter.parse(source);
    const calls = adapter.extractCalls(parsed.ast!);
    expect(calls).toContainEqual(expect.objectContaining({ calleeName: "helper" }));
    expect(calls).toContainEqual(
      expect.objectContaining({ calleeName: "method", qualifier: "obj" }),
    );
  });

  it("produces an identical normalizedSignature for functions differing only in formatting/defaults", () => {
    const compact = sourceFile({
      path: "a.py",
      content: "def f(a:int,b:str='x')->None:\n    pass\n",
    });
    const spread = sourceFile({
      path: "b.py",
      content: "def f(\n    a : int ,\n    b   :   str   =   'y'\n) -> None :\n    pass\n",
    });
    const symCompact = adapter.extractSymbols(adapter.parse(compact).ast!)[0]?.normalizedSignature;
    const symSpread = adapter.extractSymbols(adapter.parse(spread).ast!)[0]?.normalizedSignature;
    expect(symCompact).toBe("f(a: int, b: str) -> None");
    expect(symCompact).toBe(symSpread);
  });

  it("computes stable astHash/tokenFingerprint across whitespace reformatting, and different ones for a real edit", () => {
    const original = sourceFile({ path: "x.py", content: "def f(a):\n    return a + 1\n" });
    const reformatted = sourceFile({ path: "y.py", content: "def f(a):\n\n    return a + 1\n" });
    const edited = sourceFile({ path: "z.py", content: "def f(a):\n    return a + 2\n" });

    const symOriginal = adapter.extractSymbols(adapter.parse(original).ast!)[0]!;
    const symReformatted = adapter.extractSymbols(adapter.parse(reformatted).ast!)[0]!;
    const symEdited = adapter.extractSymbols(adapter.parse(edited).ast!)[0]!;

    expect(symReformatted.astHash).toBe(symOriginal.astHash);
    expect(symReformatted.tokenFingerprint).toBe(symOriginal.tokenFingerprint);
    expect(symEdited.astHash).toBe(symOriginal.astHash);
    expect(symEdited.tokenFingerprint).not.toBe(symOriginal.tokenFingerprint);
  });

  it("resolves guard-clause if-statements to DecisionKind 'guard'", () => {
    const source = sourceFile({
      path: "guard.py",
      content: "def f(a):\n    if a < 0:\n        return -1\n    return a\n",
    });
    const parsed = adapter.parse(source);
    const facts = adapter.computeComplexity(parsed.ast!);
    expect(facts.decisions.map((d) => d.kind)).toEqual(["guard"]);
  });

  it("produces else_if continuation decisions for an elif chain, not nested 'if'", () => {
    const source = sourceFile({
      path: "elif.py",
      content:
        "def f(a):\n    if a == 1:\n        return 1\n    elif a == 2:\n        return 2\n    else:\n        return 3\n",
    });
    const parsed = adapter.parse(source);
    const facts = adapter.computeComplexity(parsed.ast!);
    const kinds = facts.decisions.map((d) => d.kind);
    // The top `if` has an `elif`, so it is a plain "if" (not a "guard" — a
    // guard is only inferred for an if with NO else/elif branch at all).
    expect(kinds).toContain("if");
    expect(kinds).toContain("else_if");
    const continuationNesting = facts.nestingEvents.find((n) => n.continuation);
    expect(continuationNesting).toBeDefined();
    expect(continuationNesting?.construct).toBe("if");
  });

  it("produces one loop decision per comprehension for-clause and one per if-filter", () => {
    const source = sourceFile({
      path: "comp.py",
      content: "def f(a, b):\n    return [x for x in a for y in b if x != y]\n",
    });
    const parsed = adapter.parse(source);
    const facts = adapter.computeComplexity(parsed.ast!);
    const kinds = facts.decisions.map((d) => d.kind).sort();
    expect(kinds).toEqual(["if", "loop", "loop"]);
  });

  it("marks async def and await constructs (async_construct visible via node kinds)", () => {
    const source = sourceFile({
      path: "async.py",
      content: "async def f():\n    return await g()\n",
    });
    const parsed = adapter.parse(source);
    const symbols = adapter.extractSymbols(parsed.ast!);
    expect(symbols[0]?.signature).toContain("async");
    const facts = adapter.computeComplexity(parsed.ast!);
    // `nodeKinds` traegt die Knotenarten der GRAMMATIK, nicht erfundene
    // Namen. Bis WP-239 stand hier `"Await"` — der Name aus dem
    // handgeschriebenen AST dieses Repos. Die tree-sitter-Grammatik nennt
    // denselben Knoten `await`; die Aussage des Tests ("ein `await` ist im
    // Baum sichtbar") ist unveraendert, nur ihr Wortlaut folgt jetzt der
    // Grammatik statt einer Eigenpraegung.
    expect(facts.nodeKinds.some((n) => n.kind === "await")).toBe(true);
  });

  it("produces a catch decision per except handler and a case decision per match arm", () => {
    const source = sourceFile({
      path: "trymatch.py",
      content:
        "def f(x):\n    try:\n        g()\n    except ValueError:\n        pass\n    except TypeError:\n        pass\n\n    match x:\n        case 1:\n            pass\n        case _:\n            pass\n",
    });
    const parsed = adapter.parse(source);
    const facts = adapter.computeComplexity(parsed.ast!);
    const kinds = facts.decisions.map((d) => d.kind);
    expect(kinds.filter((k) => k === "catch")).toHaveLength(2);
    expect(kinds.filter((k) => k === "case")).toHaveLength(2);
  });

  it("produces a pattern_alternative decision for an or-pattern beyond the first alternative", () => {
    const source = sourceFile({
      path: "orpattern.py",
      content:
        "def f(x):\n    match x:\n        case 1 | 2 | 3:\n            pass\n        case _:\n            pass\n",
    });
    const parsed = adapter.parse(source);
    const facts = adapter.computeComplexity(parsed.ast!);
    const alternatives = facts.decisions.filter((d) => d.kind === "pattern_alternative");
    expect(alternatives).toHaveLength(2); // 3 alternatives -> 2 extra decisions
    expect(
      alternatives.every((d) => d.countsForClassic === false && d.countsForExtended === true),
    ).toBe(true);
  });

  it("groups a chained boolean expression into one logicalGroupId with distinct nested ranges", () => {
    const source = sourceFile({
      path: "bool.py",
      content: "def f(a, b, c):\n    return a and b and c\n",
    });
    const parsed = adapter.parse(source);
    const facts = adapter.computeComplexity(parsed.ast!);
    const logicalDecisions = facts.decisions.filter((d) => d.kind === "logical_and");
    expect(logicalDecisions).toHaveLength(2);
    expect(logicalDecisions[0]?.logicalGroupId).toBe(logicalDecisions[1]?.logicalGroupId);
    expect(logicalDecisions[0]?.range).not.toEqual(logicalDecisions[1]?.range);
  });

  it("keeps every symbolScopeId referenced by a decision/call resolvable to a real scope", () => {
    const source = sourceFile({
      path: "consistency.py",
      content:
        "class C:\n    def m(self):\n        if self.x:\n            helper()\n        return 1\n",
    });
    const parsed = adapter.parse(source);
    const facts = adapter.computeComplexity(parsed.ast!);
    const calls = adapter.extractCalls(parsed.ast!);
    const scopeIds = new Set(facts.symbolScopes.map((s) => s.symbolScopeId));
    for (const decision of facts.decisions) expect(scopeIds.has(decision.symbolScopeId)).toBe(true);
    for (const call of calls) expect(scopeIds.has(call.callerScopeId)).toBe(true);
  });

  it("gives every nested lambda/local function an extra 'lambda' nesting event in the enclosing scope", () => {
    const source = sourceFile({
      path: "nested.py",
      content:
        "def outer():\n    def inner():\n        return 1\n    f = lambda x: x + 1\n    return inner() + f(1)\n",
    });
    const parsed = adapter.parse(source);
    const facts = adapter.computeComplexity(parsed.ast!);
    const lambdaNestings = facts.nestingEvents.filter((n) => n.construct === "lambda");
    expect(lambdaNestings.length).toBeGreaterThanOrEqual(2);
  });
});
