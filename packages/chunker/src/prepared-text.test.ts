import { describe, expect, it } from "vitest";

import { buildBm25Text, buildPreparedDenseText } from "./prepared-text.js";
import { estimateTokens } from "./token-estimator.js";

const ctx = { documentPrefix: "search_document:", repoLabel: "untangle", refName: "main" };

describe("buildPreparedDenseText", () => {
  it("follows the exact header shape of spec.md §8.6", () => {
    const text = buildPreparedDenseText(
      ctx,
      {
        filePath: "src/foo.ts",
        language: "typescript",
        symbolFqn: "Foo.bar",
        signature: "bar(x: number): void",
      },
      "function body here",
    );
    expect(text).toBe(
      [
        "search_document:",
        "repository: untangle",
        "ref: main",
        "path: src/foo.ts",
        "language: typescript",
        "symbol: Foo.bar",
        "signature: bar(x: number): void",
        "",
        "function body here",
      ].join("\n"),
    );
  });

  it("tolerates missing symbol/signature with empty header fields", () => {
    const text = buildPreparedDenseText(
      ctx,
      { filePath: "src/foo.ts", language: "typescript" },
      "content",
    );
    expect(text).toContain("symbol: \n");
    expect(text).toContain("signature: \n");
  });

  it("counts the header toward the token estimate (architecture.md §14.4)", () => {
    const content = "x";
    const withHeader = buildPreparedDenseText(
      ctx,
      {
        filePath: "src/foo.ts",
        language: "typescript",
        symbolFqn: "Foo.bar",
        signature: "bar(): void",
      },
      content,
    );
    expect(estimateTokens(withHeader)).toBeGreaterThan(estimateTokens(content));
  });
});

describe("buildBm25Text", () => {
  it("includes path, symbol name/fqn, identifiers and raw content without prose", () => {
    const text = buildBm25Text(
      { filePath: "src/foo.ts", symbolName: "bar", symbolFqn: "Foo.bar" },
      "function bar(itemCount) { return itemCount * 2; }",
    );
    expect(text).toContain("src/foo.ts");
    expect(text).toContain("Foo.bar");
    expect(text).toContain("bar");
    expect(text).toContain("itemCount");
    expect(text).toContain("function bar(itemCount) { return itemCount * 2; }");
    expect(text).not.toMatch(/repository:|signature:/);
  });
});
