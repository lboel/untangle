/**
 * Regression tests for the wave-1 defect "property_group fragments without
 * symbolId" (spec.md §8.5 MUSS: every fragment of a symbol carries
 * `symbol_id`), reproduced by the adversarial prover against the built
 * dist code: a real TypeScript class whose grouped properties exceed the
 * token budget was split by `emitPropertyGroups` into `symbol_fragment`
 * chunks that inherited a header WITHOUT `symbolId` (only `symbolFqn` and
 * the "<Class> properties" signature).
 *
 * The fixtures below are the prover's reproductions, run through the REAL
 * TypeScript adapter (no hand-built region trees) exactly like the repro
 * scripts, plus unit tests for the two defense layers that close the whole
 * error class:
 *
 * - degrade: without a resolvable class symbol, over-budget pieces become
 *   file-scoped `fallback_lines`, never a `symbol_fragment` without id;
 * - invariant: `emitChunk` refuses (UntangleError, ANALYSIS_INCOMPLETE) to
 *   emit any `symbol_fragment` draft missing symbolId / fragmentIndex /
 *   fragmentCount / signature.
 */
import { buildSymbolId, isUntangleError, sha256Hex } from "@untangle-code/domain";
import type { AstRegion, CodeChunkDraft, ExtractedSymbol, SourceFile } from "@untangle-code/domain";
import { createTypeScriptAdapter } from "@untangle-code/parser-registry";
import { describe, expect, it } from "vitest";

import { chunkFile } from "../chunker.js";
import { resolveChunkerConfig } from "../config.js";
import { createBuildContext, emitChunk } from "../context.js";
import { rangeOf, spanOf } from "../test-helpers.js";
import type { ChunkFileIdentity, ChunkerConfigInput } from "../types.js";

import { runAstChunkStrategy } from "./ast-chunk-strategy.js";

const identity: ChunkFileIdentity = {
  workspaceId: "ws-prop",
  repoId: "repo-prop",
  refId: "repo-prop:main",
  fileId: "file-prop",
  filePath: "src/user-profile.ts",
  languageId: "typescript",
};

const preparedText: ChunkerConfigInput["preparedText"] = {
  documentPrefix: "search_document:",
  repoLabel: "untangle",
  refName: "main",
};

function chunkRealSource(content: string, maxTokensPerChunk: number) {
  const adapter = createTypeScriptAdapter();
  const source: SourceFile = {
    fileId: identity.fileId,
    repoId: identity.repoId,
    refId: identity.refId,
    path: identity.filePath,
    languageId: identity.languageId,
    content,
    contentHash: sha256Hex(content),
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
  const parseResult = adapter.parse(source);
  expect(parseResult.parseQuality).toBe("complete");
  const regions = parseResult.ast === null ? [] : adapter.extractChunks(parseResult.ast);
  const symbols = parseResult.ast === null ? [] : adapter.extractSymbols(parseResult.ast);
  const result = chunkFile({
    identity,
    content,
    parseResult,
    regions,
    symbols,
    config: { preparedText, maxTokensPerChunk },
  });
  return { result, symbols };
}

/** Expected spec.md §5.5 symbol id for one extracted symbol of the fixture. */
function expectedSymbolId(symbols: readonly ExtractedSymbol[], qualifiedName: string): string {
  const symbol = symbols.find((s) => s.qualifiedName === qualifiedName);
  expect(symbol).toBeDefined();
  return buildSymbolId({
    workspaceId: identity.workspaceId,
    repoId: identity.repoId,
    refId: identity.refId,
    relativePath: identity.filePath,
    symbolKind: symbol!.kind,
    qualifiedName: symbol!.qualifiedName,
    normalizedSignature: symbol!.normalizedSignature,
  });
}

function assertFragmentInvariants(drafts: readonly CodeChunkDraft[]): CodeChunkDraft[] {
  const fragments = drafts.filter((d) => d.chunkKind === "symbol_fragment");
  for (const fragment of fragments) {
    // spec.md §8.5: symbol_id, fragment_index/count and a signature are
    // mandatory on EVERY fragment of a symbol.
    expect(fragment.symbolId).toBeTruthy();
    expect(fragment.fragmentIndex).toBeDefined();
    expect(fragment.fragmentCount).toBeDefined();
    expect(fragment.signature).toBeTruthy();
  }
  return fragments;
}

// The prover's first fixture: a real TS class with 6 typed properties plus
// a constructor, chunked with maxTokensPerChunk=25 so the summarized
// property block MUST fragment.
const USER_PROFILE_FIXTURE = `class UserProfile {
  id: string = "";
  firstName: string = "";
  lastName: string = "";
  emailAddress: string = "";
  createdAtTimestamp: number = 0;
  updatedAtTimestamp: number = 0;

  constructor(id: string, firstName: string, lastName: string) {
    this.id = id;
    this.firstName = firstName;
    this.lastName = lastName;
  }
}
`;

// The prover's second, independent fixture: two classes with private fields.
const WIDGET_FIXTURE = `class BaseWidget {
  private widgetIdentifier: string = "";
  private widgetDisplayLabel: string = "";
  private widgetSortPosition: number = 0;

  render(): string {
    return this.widgetDisplayLabel;
  }
}

class ConcreteWidget {
  private concreteThemeColor: string = "blue";
  private concreteBorderWidth: number = 1;
  private concreteCornerRadius: number = 4;

  paint(): string {
    return this.concreteThemeColor;
  }
}
`;

describe("property_group fragmentation carries the class symbolId (spec.md §8.5)", () => {
  it("prover repro 1: UserProfile with 6 properties, maxTokensPerChunk=25 — no symbol_fragment without symbolId", () => {
    const { result, symbols } = chunkRealSource(USER_PROFILE_FIXTURE, 25);
    expect(result.strategy).toBe("ast");

    const fragments = assertFragmentInvariants(result.drafts);
    // Guard against a silent no-op: the tiny budget MUST actually fragment.
    expect(fragments.length).toBeGreaterThan(1);

    // The property fragments belong to the CLASS symbol (identity decision
    // documented on emitPropertyGroups / domain CodeChunkDraft.symbolId).
    const classSymbolId = expectedSymbolId(symbols, "UserProfile");
    const propertyFragments = fragments.filter((f) => f.signature === "UserProfile properties");
    expect(propertyFragments.length).toBeGreaterThan(1);
    for (const fragment of propertyFragments) {
      expect(fragment.symbolId).toBe(classSymbolId);
      // Dedupe (architecture.md §18.4) groups fragments of one symbol over
      // metrics_scope_id — property fragments must reference the class.
      expect(fragment.metricsScopeId).toBe(classSymbolId);
      expect(fragment.metricsScope).toBe("symbol");
    }

    // Whole property_group chunks (if any fit the budget) carry it too.
    for (const group of result.drafts.filter((d) => d.chunkKind === "property_group")) {
      expect(group.symbolId).toBe(classSymbolId);
    }
  });

  it("prover repro 2: BaseWidget/ConcreteWidget with private fields, maxTokensPerChunk=40 — same guarantee per class", () => {
    const { result, symbols } = chunkRealSource(WIDGET_FIXTURE, 40);
    expect(result.strategy).toBe("ast");

    const fragments = assertFragmentInvariants(result.drafts);
    expect(fragments.length).toBeGreaterThan(1);

    for (const className of ["BaseWidget", "ConcreteWidget"]) {
      const classSymbolId = expectedSymbolId(symbols, className);
      const propertyChunks = result.drafts.filter(
        (d) =>
          d.signature === `${className} properties` &&
          (d.chunkKind === "symbol_fragment" || d.chunkKind === "property_group"),
      );
      expect(propertyChunks.length).toBeGreaterThan(0);
      for (const chunk of propertyChunks) {
        expect(chunk.symbolId).toBe(classSymbolId);
      }
    }
  });
});

describe("degrade path: no resolvable symbol never yields a symbol_fragment", () => {
  it("splits over-budget property runs of a symbol-less class into fallback_lines, not id-less symbol_fragments", () => {
    const content = `class Mystery {
  alpha: string = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  beta: string = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  gamma: string = "cccccccccccccccccccccccccccccccc";
}`;
    const classRange = spanOf(content, "class Mystery", "\n}");
    const alphaRange = rangeOf(content, 'alpha: string = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";');
    const betaRange = rangeOf(content, 'beta: string = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";');
    const gammaRange = rangeOf(content, 'gamma: string = "cccccccccccccccccccccccccccccccc";');
    const classRegion: AstRegion = {
      chunkKind: "class_overview",
      range: classRange,
      scopeId: "unused",
      // fqn present, but NO matching ExtractedSymbol below -> unresolvable.
      symbolFqn: "Mystery",
      splittable: true,
      children: [alphaRange, betaRange, gammaRange].map((range) => ({
        chunkKind: "property_group" as const,
        range,
        scopeId: "unused",
        splittable: false,
      })),
    };
    const config = resolveChunkerConfig({ maxTokensPerChunk: 20, preparedText });
    const ctx = createBuildContext(identity, content, config, "complete");
    const result = runAstChunkStrategy(ctx, [classRegion], []);

    const fragments = result.drafts.filter((d) => d.chunkKind === "symbol_fragment");
    expect(fragments).toHaveLength(0);
    const fallback = result.drafts.filter((d) => d.chunkKind === "fallback_lines");
    expect(fallback.length).toBeGreaterThan(1);
    for (const draft of fallback) {
      expect(draft.fragmentIndex).toBeUndefined();
      expect(draft.fragmentCount).toBeUndefined();
    }
  });

  it("splits an oversized symbol-less region (comment) into fallback_lines, not id-less symbol_fragments", () => {
    const content = `// ${"long comment line about invariants ".repeat(30)}\n`;
    const commentRegion: AstRegion = {
      chunkKind: "comment",
      range: spanOf(content, "//", "\n"),
      scopeId: "unused",
      splittable: true,
    };
    const config = resolveChunkerConfig({ maxTokensPerChunk: 20, preparedText });
    const ctx = createBuildContext(identity, content, config, "complete");
    const result = runAstChunkStrategy(ctx, [commentRegion], []);

    expect(result.drafts.filter((d) => d.chunkKind === "symbol_fragment")).toHaveLength(0);
    expect(result.drafts.filter((d) => d.chunkKind === "fallback_lines").length).toBeGreaterThan(1);
  });
});

describe("emitChunk invariant (spec.md §8.5)", () => {
  it("throws UntangleError(ANALYSIS_INCOMPLETE) for a symbol_fragment draft without symbolId", () => {
    const content = "const x = 1;\n";
    const config = resolveChunkerConfig({ maxTokensPerChunk: 100, preparedText });
    const ctx = createBuildContext(identity, content, config, "complete");
    const range = rangeOf(content, "const x = 1;");
    let thrown: unknown;
    try {
      emitChunk(ctx, {
        range,
        content: "const x = 1;",
        scopeId: identity.fileId,
        chunkKind: "symbol_fragment",
        header: {
          symbolFqn: "x",
          signature: "x",
          metricsScope: "file",
          metricsScopeId: identity.fileId,
        },
        fragmentIndex: 0,
        fragmentCount: 2,
      });
    } catch (error) {
      thrown = error;
    }
    expect(isUntangleError(thrown)).toBe(true);
    if (isUntangleError(thrown)) {
      expect(thrown.code).toBe("ANALYSIS_INCOMPLETE");
      expect(thrown.message).toContain("symbolId");
    }
  });

  it("throws for a symbol_fragment draft without fragmentIndex/fragmentCount", () => {
    const content = "const y = 2;\n";
    const config = resolveChunkerConfig({ maxTokensPerChunk: 100, preparedText });
    const ctx = createBuildContext(identity, content, config, "complete");
    const range = rangeOf(content, "const y = 2;");
    expect(() =>
      emitChunk(ctx, {
        range,
        content: "const y = 2;",
        scopeId: "symbol-1",
        chunkKind: "symbol_fragment",
        header: {
          symbolId: "symbol-1",
          symbolFqn: "y",
          signature: "y",
          metricsScope: "symbol",
          metricsScopeId: "symbol-1",
        },
      }),
    ).toThrowError(/fragmentIndex/);
  });
});
