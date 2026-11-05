import { buildSymbolId, validateCoverage } from "@untangle-code/domain";
import type { AstRegion, ExtractedSymbol } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { resolveChunkerConfig } from "../config.js";
import { createBuildContext } from "../context.js";
import { rangeOf, spanOf } from "../test-helpers.js";

import { runAstChunkStrategy } from "./ast-chunk-strategy.js";

const CLASS_FIXTURE = `export class Widget extends Base {
  count: number = 0;
  label: string = "widget";

  constructor(label: string) {
    super();
    this.label = label;
  }

  increment(step: number): number {
    this.count += step;
    return this.count;
  }
}`;

const identity = {
  workspaceId: "ws-1",
  repoId: "repo-1",
  refId: "repo-1:main",
  fileId: "file-1",
  filePath: "src/widget.ts",
  languageId: "typescript",
};

const config = resolveChunkerConfig({
  maxTokensPerChunk: 1000,
  preparedText: { documentPrefix: "search_document:", repoLabel: "untangle", refName: "main" },
});

function buildFixture() {
  const classRange = spanOf(CLASS_FIXTURE, "export class Widget", "\n}");
  const countRange = rangeOf(CLASS_FIXTURE, "count: number = 0;");
  const labelRange = rangeOf(CLASS_FIXTURE, 'label: string = "widget";');
  const ctorRange = spanOf(CLASS_FIXTURE, "constructor(label: string) {", "\n  }");
  const methodRange = spanOf(CLASS_FIXTURE, "increment(step: number): number {", "\n  }");

  const countRegion: AstRegion = {
    chunkKind: "property_group",
    range: countRange,
    scopeId: "unused",
    symbolFqn: "Widget.count",
    splittable: false,
  };
  const labelRegion: AstRegion = {
    chunkKind: "property_group",
    range: labelRange,
    scopeId: "unused",
    symbolFqn: "Widget.label",
    splittable: false,
  };
  const ctorRegion: AstRegion = {
    chunkKind: "constructor",
    range: ctorRange,
    scopeId: "unused",
    symbolFqn: "Widget.constructor",
    splittable: true,
  };
  const methodRegion: AstRegion = {
    chunkKind: "method",
    range: methodRange,
    scopeId: "unused",
    symbolFqn: "Widget.increment",
    splittable: true,
  };
  const classRegion: AstRegion = {
    chunkKind: "class_overview",
    range: classRange,
    scopeId: "unused",
    symbolFqn: "Widget",
    splittable: true,
    children: [countRegion, labelRegion, ctorRegion, methodRegion],
  };

  const symbols: ExtractedSymbol[] = [
    {
      name: "Widget",
      qualifiedName: "Widget",
      kind: "class",
      signature: "export class Widget extends Base",
      normalizedSignature: "class Widget extends Base",
      range: classRange,
      exportedNames: ["Widget"],
      astHash: "h-widget",
      tokenFingerprint: "tf-widget",
    },
    {
      name: "count",
      qualifiedName: "Widget.count",
      kind: "property",
      signature: "count: number = 0",
      normalizedSignature: "count:number",
      range: countRange,
      parentQualifiedName: "Widget",
      exportedNames: [],
      astHash: "h-count",
      tokenFingerprint: "tf-count",
    },
    {
      name: "label",
      qualifiedName: "Widget.label",
      kind: "property",
      signature: 'label: string = "widget"',
      normalizedSignature: "label:string",
      range: labelRange,
      parentQualifiedName: "Widget",
      exportedNames: [],
      astHash: "h-label",
      tokenFingerprint: "tf-label",
    },
    {
      name: "constructor",
      qualifiedName: "Widget.constructor",
      kind: "constructor",
      signature: "constructor(label: string)",
      normalizedSignature: "constructor(string)",
      range: ctorRange,
      parentQualifiedName: "Widget",
      exportedNames: [],
      astHash: "h-ctor",
      tokenFingerprint: "tf-ctor",
    },
    {
      name: "increment",
      qualifiedName: "Widget.increment",
      kind: "method",
      signature: "increment(step: number): number",
      normalizedSignature: "increment(number):number",
      range: methodRange,
      parentQualifiedName: "Widget",
      exportedNames: [],
      astHash: "h-inc",
      tokenFingerprint: "tf-inc",
    },
  ];

  return { classRegion, symbols, ctorRange, methodRange, countRange, labelRange };
}

describe("runAstChunkStrategy — class handling", () => {
  it("emits a class_overview chunk containing member names but not method bodies", () => {
    const { classRegion, symbols } = buildFixture();
    const ctx = createBuildContext(identity, CLASS_FIXTURE, config, "complete");
    const result = runAstChunkStrategy(ctx, [classRegion], symbols);

    const overview = result.drafts.find((d) => d.chunkKind === "class_overview");
    expect(overview).toBeDefined();
    expect(overview!.content).toContain("count");
    expect(overview!.content).toContain("increment");
    expect(overview!.content).toContain("constructor");
    // Member NAMES/signatures only — never the method/constructor body text.
    expect(overview!.content).not.toContain("this.count += step");
    expect(overview!.content).not.toContain("super();");
    expect(overview!.content).not.toContain("return this.count;");
  });

  it("emits one own chunk per method and constructor, byte-identical to their source range", () => {
    const { classRegion, symbols, ctorRange, methodRange } = buildFixture();
    const ctx = createBuildContext(identity, CLASS_FIXTURE, config, "complete");
    const result = runAstChunkStrategy(ctx, [classRegion], symbols);

    const ctorChunk = result.drafts.find((d) => d.chunkKind === "constructor");
    const methodChunk = result.drafts.find((d) => d.chunkKind === "method");
    expect(ctorChunk).toBeDefined();
    expect(methodChunk).toBeDefined();
    expect(ctorChunk!.range).toEqual(ctorRange);
    expect(methodChunk!.range).toEqual(methodRange);
    expect(ctorChunk!.content).toContain("super();");
    expect(methodChunk!.content).toContain("this.count += step;");

    const expectedCtorSymbolId = buildSymbolId({
      workspaceId: identity.workspaceId,
      repoId: identity.repoId,
      refId: identity.refId,
      relativePath: identity.filePath,
      symbolKind: "constructor",
      qualifiedName: "Widget.constructor",
      normalizedSignature: "constructor(string)",
    });
    expect(ctorChunk!.symbolId).toBe(expectedCtorSymbolId);
  });

  it("groups small consecutive properties into one property_group chunk", () => {
    const { classRegion, symbols, countRange, labelRange } = buildFixture();
    const ctx = createBuildContext(identity, CLASS_FIXTURE, config, "complete");
    const result = runAstChunkStrategy(ctx, [classRegion], symbols);

    const propertyGroups = result.drafts.filter((d) => d.chunkKind === "property_group");
    expect(propertyGroups).toHaveLength(1);
    expect(propertyGroups[0]!.content).toContain("count: number = 0;");
    expect(propertyGroups[0]!.content).toContain('label: string = "widget";');
    expect(propertyGroups[0]!.range.startByte).toBe(countRange.startByte);
    expect(propertyGroups[0]!.range.endByte).toBe(labelRange.endByte);
  });

  // Corrected against spec.md §8.4 (Befund "lossless invariant silently
  // violated"): this test previously asserted that the SYNTHESIZED
  // class_overview's coverage entry spans the whole class range — which let
  // it mask real gaps (bytes in the class body no member chunk carries).
  // The overview is synthesized content; its entry may claim only the class
  // header span, and the union of ALL entries must still cover the class.
  it("covers the whole class via members/interstitials; the synthesized overview claims only the header span", () => {
    const { classRegion, symbols } = buildFixture();
    const ctx = createBuildContext(identity, CLASS_FIXTURE, config, "complete");
    const result = runAstChunkStrategy(ctx, [classRegion], symbols);

    const overview = result.drafts.find((d) => d.chunkKind === "class_overview");
    expect(overview).toBeDefined();
    expect(overview!.synthesized).toBe(true);

    const firstMemberStart = Math.min(
      ...classRegion.children!.map((child) => child.range.startByte),
    );
    const overviewCoverage = result.coverage.filter((entry) =>
      entry.chunkIds?.includes(overview!.chunkId),
    );
    for (const entry of overviewCoverage) {
      expect(entry.range.startByte).toBe(classRegion.range.startByte);
      expect(entry.range.endByte).toBeLessThanOrEqual(firstMemberStart);
    }

    // The union of ALL coverage entries (chunked + documented exclusions)
    // still covers the class range without gaps.
    const validation = validateCoverage(result.coverage, classRegion.range);
    expect(validation.gaps).toEqual([]);
    for (const entry of result.coverage) {
      if (entry.status === "excluded") {
        expect(entry.exclusionReason).toBeTruthy();
      }
    }
  });
});

describe("runAstChunkStrategy — synthesized overview ledger claims (spec.md §8.4)", () => {
  it("claims only byte spans whose text the overview content literally carries; the rest of the header span is excluded or real content", () => {
    const { classRegion, symbols } = buildFixture();
    const ctx = createBuildContext(identity, CLASS_FIXTURE, config, "complete");
    const result = runAstChunkStrategy(ctx, [classRegion], symbols);

    const overview = result.drafts.find((d) => d.chunkKind === "class_overview")!;
    const overviewClaims = result.coverage.filter(
      (entry) => entry.status === "chunked" && entry.chunkIds?.includes(overview.chunkId),
    );
    // The fixture's signature ("export class Widget extends Base") occurs
    // verbatim in the source, so the overview may — and does — claim it.
    expect(overviewClaims.length).toBeGreaterThan(0);
    for (const entry of overviewClaims) {
      const claimed = Buffer.from(CLASS_FIXTURE, "utf8")
        .subarray(entry.range.startByte, entry.range.endByte)
        .toString("utf8")
        .trim();
      expect(claimed.length).toBeGreaterThan(0);
      expect(overview.content).toContain(claimed);
    }

    // Header-span bytes the overview does not carry (" {" plus indentation)
    // are documented exclusions — not silently attributed to the overview.
    const firstMemberStart = Math.min(
      ...classRegion.children!.map((child) => child.range.startByte),
    );
    const claimedEnd = Math.max(...overviewClaims.map((entry) => entry.range.endByte));
    if (claimedEnd < firstMemberStart) {
      const tail = result.coverage.find(
        (entry) => entry.status === "excluded" && entry.range.startByte === claimedEnd,
      );
      expect(tail).toBeDefined();
      expect(tail!.exclusionReason).toBeTruthy();
    }
  });
});
