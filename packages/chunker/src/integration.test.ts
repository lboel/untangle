/**
 * REAL integration tests across the parser-registry -> chunker seam
 * (spec.md §8.2-§8.5; architecture.md §14.2): the regions and symbols come
 * from the actual TypeScript language adapter parsing real source text —
 * no hand-built region trees. This is the test that reproduces (and now
 * guards against) the wave-0 seam defects:
 *
 * 1. the adapter's single root "module" region must be unpacked kind-aware,
 *    so function/method/constructor/class_overview chunks with symbolId
 *    exist — below AND above the token budget;
 * 2. the synthesized class_overview must never mask coverage gaps: bytes in
 *    the class body no member chunk carries (comments between methods,
 *    static initialization blocks) must surface in real chunk content or as
 *    documented exclusions.
 */
import { sha256Hex, UntangleError, validateCoverage } from "@untangle-code/domain";
import type { SourceFile, SourceRange } from "@untangle-code/domain";
import { createTypeScriptAdapter } from "@untangle-code/parser-registry";
import { describe, expect, it } from "vitest";

import { buildLineIndex } from "./byte-text.js";
import { chunkFile } from "./chunker.js";
import { assertTruthfulLedger, chunkedEntry } from "./coverage.js";
import type { ChunkFileIdentity, ChunkerConfigInput } from "./types.js";

const identity: ChunkFileIdentity = {
  workspaceId: "ws-int",
  repoId: "repo-int",
  refId: "repo-int:main",
  fileId: "file-int",
  filePath: "src/fixture.ts",
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

  // Real adapter contract (domain `AstRegion` doc): exactly ONE root region
  // of kind "module" spanning the whole file.
  expect(regions).toHaveLength(1);
  expect(regions[0]!.chunkKind).toBe("module");

  return chunkFile({
    identity,
    content,
    parseResult,
    regions,
    symbols,
    config: { preparedText, maxTokensPerChunk },
  });
}

function fileRangeOf(content: string): SourceRange {
  return {
    startLine: 1,
    endLine: content.split("\n").length,
    startByte: 0,
    endByte: Buffer.byteLength(content, "utf8"),
  };
}

const FIXTURE = `/** Adds two numbers. */
export function first(a: number, b: number): number {
  return a + b;
}

export function second(text: string): string {
  return text.toUpperCase();
}

const REGISTRY_LIMIT = 42;

export class Widget {
  count: number = 0;

  constructor(count: number) {
    this.count = count;
  }

  increment(step: number): number {
    this.count += step;
    return this.count;
  }
}
`;

describe("parser-registry -> chunker integration (real TypeScript adapter)", () => {
  it("preserves a private method's searchable identity despite one long diagnostic line", () => {
    const content = [
      "export class HybridSearchEngine {",
      "  private enrichFinalHits(value: number): number {",
      `    const diagnostic = "${"diagnostic ".repeat(90)}";`,
      "    let result = value;",
      ...Array.from({ length: 120 }, (_, i) => `    result += value + ${i};`),
      "    return result + diagnostic.length;",
      "  }",
      "  run(value: number): number { return this.enrichFinalHits(value); }",
      "}",
    ].join("\n");
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(2000);
    expect(Math.max(...content.split("\n").map((line) => line.length))).toBeGreaterThan(500);

    const result = chunkRealSource(content, 256);
    expect(result.strategy).toBe("ast");
    expect(result.degradations).toEqual([]);
    const fragments = result.drafts.filter(
      (draft) => draft.symbolFqn === "HybridSearchEngine.enrichFinalHits",
    );
    expect(fragments.length).toBeGreaterThan(1);
    expect(new Set(fragments.map((draft) => draft.symbolId)).size).toBe(1);
    for (const fragment of fragments) {
      expect(fragment.chunkKind).toBe("symbol_fragment");
      expect(fragment.symbolName).toBe("enrichFinalHits");
      expect(fragment.symbolKind).toBe("method");
      expect(fragment.symbolId).toBeTruthy();
      expect(fragment.metricsScope).toBe("symbol");
      expect(fragment.metricsScopeId).toBe(fragment.symbolId);
      expect(fragment.tokenEstimate).toBeLessThanOrEqual(256);
    }
    expect(result.drafts.some((draft) => draft.chunkKind === "minified_fragment")).toBe(false);
    expect(
      result.drafts.find((draft) => draft.symbolFqn === "HybridSearchEngine")?.symbolId,
    ).not.toBe(fragments[0]!.symbolId);
  });

  it("emits function, method, constructor and class_overview chunks with symbolId below the token budget", () => {
    const result = chunkRealSource(FIXTURE, 2000);
    expect(result.strategy).toBe("ast");

    const byKind = (kind: string) => result.drafts.filter((d) => d.chunkKind === kind);

    const functions = byKind("function");
    expect(functions.map((d) => d.symbolFqn).sort()).toEqual(["first", "second"]);
    for (const draft of functions) {
      expect(draft.symbolId).toBeTruthy();
    }
    // Doc comment is bound to its symbol (spec.md §8.3 step 2).
    expect(functions.find((d) => d.symbolFqn === "first")!.content).toContain(
      "/** Adds two numbers. */",
    );

    const overview = byKind("class_overview");
    expect(overview).toHaveLength(1);
    expect(overview[0]!.symbolFqn).toBe("Widget");
    expect(overview[0]!.symbolId).toBeTruthy();
    expect(overview[0]!.synthesized).toBe(true);
    expect(overview[0]!.content).toContain("increment");
    expect(overview[0]!.content).not.toContain("this.count += step");

    const ctor = byKind("constructor");
    expect(ctor).toHaveLength(1);
    expect(ctor[0]!.symbolFqn).toBe("Widget.constructor");
    expect(ctor[0]!.symbolId).toBeTruthy();
    expect(ctor[0]!.content).toContain("this.count = count;");

    const methods = byKind("method");
    expect(methods).toHaveLength(1);
    expect(methods[0]!.symbolFqn).toBe("Widget.increment");
    expect(methods[0]!.symbolId).toBeTruthy();
    expect(methods[0]!.content).toContain("this.count += step;");

    // Top-level statement between symbols is real module content, not lost.
    const moduleChunks = byKind("module");
    expect(moduleChunks.some((d) => d.content.includes("const REGISTRY_LIMIT = 42;"))).toBe(true);

    // Lossless (spec.md §8.4).
    const validation = validateCoverage(result.coverage, fileRangeOf(FIXTURE));
    expect(validation.issues).toEqual([]);
    expect(validation.complete).toBe(true);
  });

  it("keeps symbolId and symbolFqn on EVERY fragment above the token budget", () => {
    const result = chunkRealSource(FIXTURE, 70);
    expect(result.strategy).toBe("ast");

    // The class overview survives even under a tight budget (capped member list).
    const overview = result.drafts.filter((d) => d.chunkKind === "class_overview");
    expect(overview).toHaveLength(1);
    expect(overview[0]!.symbolId).toBeTruthy();

    // The wave-0 defect: ONLY anonymous symbol_fragment chunks without
    // symbolId/symbolFqn. Now: every symbol_fragment carries both, plus
    // fragment bookkeeping and a header signature (spec.md §8.5).
    const fragments = result.drafts.filter((d) => d.chunkKind === "symbol_fragment");
    expect(fragments.length).toBeGreaterThan(1);
    for (const fragment of fragments) {
      expect(fragment.symbolId).toBeTruthy();
      expect(fragment.symbolFqn).toBeTruthy();
      expect(fragment.signature).toBeTruthy();
      expect(fragment.fragmentIndex).toBeTypeOf("number");
      expect(fragment.fragmentCount).toBeTypeOf("number");
    }

    // Every symbol is represented by at least one chunk that names it —
    // whole (function/method/constructor) or fragment, never anonymous.
    for (const fqn of ["first", "second", "Widget.constructor", "Widget.increment"]) {
      const carriers = result.drafts.filter((d) => d.symbolFqn === fqn);
      expect(carriers.length).toBeGreaterThan(0);
      for (const carrier of carriers) {
        expect(carrier.symbolId).toBeTruthy();
      }
    }

    // Budget respected, header included (spec.md §8.1, architecture.md §14.4)
    // — the synthesized class_overview caps its member list instead of
    // overshooting.
    for (const draft of result.drafts) {
      expect(draft.tokenEstimate).toBeLessThanOrEqual(70);
    }

    const validation = validateCoverage(result.coverage, fileRangeOf(FIXTURE));
    expect(validation.issues).toEqual([]);
    expect(validation.complete).toBe(true);
  });
});

const REGRESSION_FIXTURE = `export class Registry {
  private items: string[] = [];

  add(item: string): void {
    this.items.push(item);
  }

  static {
    console.log("MARKER_STATIC_BLOCK boot");
  }

  remove(item: string): void {
    this.items = this.items.filter((x) => x !== item);
  }

  // MARKER_TRAILING_COMMENT nothing binds me to a following symbol
}
`;

describe("regression: synthesized class_overview must not mask class-body gaps (spec.md §8.4)", () => {
  it("surfaces a comment between members and a static block in real chunk content (or as documented exclusions)", () => {
    const result = chunkRealSource(REGRESSION_FIXTURE, 800);
    expect(result.strategy).toBe("ast");

    const contentCarriers = (marker: string) =>
      result.drafts.filter((d) => d.synthesized !== true && d.content.includes(marker));
    const excludedCarriers = (marker: string, content: string) =>
      result.coverage.filter((entry) => {
        if (entry.status !== "excluded") return false;
        const bytes = Buffer.from(content, "utf8")
          .subarray(entry.range.startByte, entry.range.endByte)
          .toString("utf8");
        return bytes.includes(marker);
      });

    for (const marker of ["MARKER_STATIC_BLOCK", "MARKER_TRAILING_COMMENT"]) {
      const inContent = contentCarriers(marker);
      const inExclusions = excludedCarriers(marker, REGRESSION_FIXTURE);
      // Either a REAL content chunk carries the bytes, or the ledger names
      // the range excluded with a reason — never silently dropped.
      expect(inContent.length + inExclusions.length).toBeGreaterThan(0);
      for (const entry of inExclusions) {
        expect(entry.exclusionReason).toBeTruthy();
      }
    }

    // The markers actually surface as content (stronger than the exclusion arm).
    expect(contentCarriers("MARKER_STATIC_BLOCK").length).toBeGreaterThan(0);
    expect(contentCarriers("MARKER_TRAILING_COMMENT").length).toBeGreaterThan(0);

    // The synthesized overview claims at most the class header span, so
    // completeness below is proven by real chunks and documented exclusions,
    // not by the overview's range.
    const overview = result.drafts.find((d) => d.chunkKind === "class_overview");
    expect(overview).toBeDefined();
    expect(overview!.synthesized).toBe(true);
    const memberStarts = result.drafts
      .filter((d) => d.symbolFqn?.startsWith("Registry.") || d.chunkKind === "property_group")
      .map((d) => d.range.startByte);
    const firstMemberStart = Math.min(...memberStarts);
    for (const entry of result.coverage) {
      if (entry.chunkIds?.includes(overview!.chunkId)) {
        expect(entry.range.endByte).toBeLessThanOrEqual(firstMemberStart);
      }
    }

    // validateCoverage reports completeness truthfully: complete WITH the
    // interstitial chunks/exclusions ...
    const fileRange = fileRangeOf(REGRESSION_FIXTURE);
    const full = validateCoverage(result.coverage, fileRange);
    expect(full.issues).toEqual([]);
    expect(full.complete).toBe(true);

    // ... and NOT complete once the interstitial evidence is removed — i.e.
    // the overview alone can no longer fake complete=true (the wave-0 bug).
    const markerChunkIds = new Set(
      [
        ...contentCarriers("MARKER_STATIC_BLOCK"),
        ...contentCarriers("MARKER_TRAILING_COMMENT"),
      ].map((d) => d.chunkId),
    );
    const withoutInterstitials = result.coverage.filter(
      (entry) =>
        entry.status !== "excluded" &&
        !(entry.chunkIds ?? []).some((chunkId) => markerChunkIds.has(chunkId)),
    );
    expect(validateCoverage(withoutInterstitials, fileRange).complete).toBe(false);
  });
});

// Wave-2 regression (adversarial prover, spec.md §8.4 / docs/BUILD_PLAN.md
// E4): a plain comment between the class opening brace and the FIRST member
// is not bound to the class symbol's docRange, so the synthesized overview
// content never carries it — yet wave 1 still attributed the whole header
// span (class start .. first member start) to the overview as "chunked",
// silently masking the comment. The fixture is the prover's, verbatim.
const HEADER_NEEDLE_FIXTURE = `export class Foo {
  // NEEDLE_INSIDE_HEADER a note nobody re-typed into the overview

  bar(): void {
    return;
  }
}
`;

describe("regression: class header span bytes the overview does not carry (spec.md §8.4)", () => {
  const marker = "NEEDLE_INSIDE_HEADER";

  it("surfaces an in-header comment in a REAL chunk's content or as a documented exclusion — never masked by the synthesized overview", () => {
    const result = chunkRealSource(HEADER_NEEDLE_FIXTURE, 800);
    expect(result.strategy).toBe("ast");

    const overview = result.drafts.find((d) => d.chunkKind === "class_overview");
    expect(overview).toBeDefined();
    expect(overview!.synthesized).toBe(true);
    // The overview content genuinely does NOT carry the comment...
    expect(overview!.content).not.toContain(marker);

    // ...so the bytes must surface in a real chunk's content or in an
    // excluded entry with a reason (spec.md §8.4) — never neither.
    const inContent = result.drafts.filter(
      (d) => d.synthesized !== true && d.content.includes(marker),
    );
    const inExclusions = result.coverage.filter((entry) => {
      if (entry.status !== "excluded") return false;
      const bytes = Buffer.from(HEADER_NEEDLE_FIXTURE, "utf8")
        .subarray(entry.range.startByte, entry.range.endByte)
        .toString("utf8");
      return bytes.includes(marker);
    });
    expect(inContent.length + inExclusions.length).toBeGreaterThan(0);
    for (const entry of inExclusions) {
      expect(entry.exclusionReason).toBeTruthy();
    }
    // Stronger arm: readable text is real content, not an exclusion.
    expect(inContent.length).toBeGreaterThan(0);

    // General rule (not a special case for this one comment): EVERY ledger
    // claim of the synthesized overview covers only bytes whose text the
    // overview content literally carries.
    for (const entry of result.coverage) {
      if (entry.status !== "chunked" || !entry.chunkIds?.includes(overview!.chunkId)) continue;
      const claimed = Buffer.from(HEADER_NEEDLE_FIXTURE, "utf8")
        .subarray(entry.range.startByte, entry.range.endByte)
        .toString("utf8")
        .trim();
      expect(overview!.content).toContain(claimed);
    }

    const fileRange = fileRangeOf(HEADER_NEEDLE_FIXTURE);
    const validation = validateCoverage(result.coverage, fileRange);
    expect(validation.issues).toEqual([]);
    expect(validation.complete).toBe(true);
  });

  it("anti-masking proof: without the real evidence the ledger is INCOMPLETE (complete=false), and the wave-1 masked ledger is rejected as an error", () => {
    const result = chunkRealSource(HEADER_NEEDLE_FIXTURE, 800);
    const overview = result.drafts.find((d) => d.chunkKind === "class_overview")!;
    const fileRange = fileRangeOf(HEADER_NEEDLE_FIXTURE);
    const lineIndex = buildLineIndex(HEADER_NEEDLE_FIXTURE);
    const needleByte = HEADER_NEEDLE_FIXTURE.indexOf(marker);

    // Masked state, part 1: drop every entry that legitimately carries the
    // needle byte (real-chunk claims and documented exclusions). If the
    // synthesized overview still covered those bytes, validateCoverage would
    // keep reporting complete=true — the wave-1 masking. It must not.
    const realCarrierIds = new Set(
      result.drafts
        .filter((d) => d.synthesized !== true && d.content.includes(marker))
        .map((d) => d.chunkId),
    );
    const withoutEvidence = result.coverage.filter((entry) => {
      const coversNeedle = entry.range.startByte <= needleByte && needleByte < entry.range.endByte;
      if (entry.status === "excluded") return !coversNeedle;
      return !(entry.chunkIds ?? []).some((chunkId) => realCarrierIds.has(chunkId));
    });
    expect(validateCoverage(withoutEvidence, fileRange).complete).toBe(false);

    // Masked state, part 2: re-create the wave-1 ledger shape — the
    // synthesized overview claims the whole class range as "chunked". That
    // ledger is byte-complete (validateCoverage cannot see the lie), but
    // assertTruthfulLedger must reject it as an ERROR, not a warning.
    const maskedLedger = [...withoutEvidence, chunkedEntry(overview.range, overview.chunkId)];
    expect(validateCoverage(maskedLedger, fileRange).complete).toBe(true);
    try {
      assertTruthfulLedger(lineIndex, result.drafts, maskedLedger, identity.filePath);
      throw new Error("expected assertTruthfulLedger to reject the masked ledger");
    } catch (error) {
      expect(error).toBeInstanceOf(UntangleError);
      expect((error as UntangleError).code).toBe("ANALYSIS_INCOMPLETE");
    }
  });

  it("claims the class doc comment for the overview (literally carried) while un-carried header bytes stay real chunks", () => {
    const DOC_FIXTURE = `/**
 * NEEDLE_DOC documented widget.
 */
export class Doc {
  m(): void {
    return;
  }
}
`;
    const result = chunkRealSource(DOC_FIXTURE, 800);
    const overview = result.drafts.find((d) => d.chunkKind === "class_overview")!;
    // The doc comment IS carried verbatim by the synthesized overview...
    expect(overview.content).toContain("NEEDLE_DOC");
    const overviewClaims = result.coverage.filter(
      (entry) => entry.status === "chunked" && entry.chunkIds?.includes(overview.chunkId),
    );
    expect(overviewClaims.length).toBeGreaterThan(0);
    for (const entry of overviewClaims) {
      const claimed = Buffer.from(DOC_FIXTURE, "utf8")
        .subarray(entry.range.startByte, entry.range.endByte)
        .toString("utf8")
        .trim();
      expect(overview.content).toContain(claimed);
    }
    // ...while the declaration line (whose "export" the normalized signature
    // drops) surfaces as REAL chunk content.
    expect(
      result.drafts.some((d) => d.synthesized !== true && d.content.includes("export class Doc")),
    ).toBe(true);

    const validation = validateCoverage(result.coverage, fileRangeOf(DOC_FIXTURE));
    expect(validation.issues).toEqual([]);
    expect(validation.complete).toBe(true);
  });
});
