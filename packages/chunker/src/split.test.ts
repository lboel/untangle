import type { AstRegion } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { resolveChunkerConfig } from "./config.js";
import { contentOf, createBuildContext } from "./context.js";
import { flattenToAtoms, splitByTokenBoundary } from "./split.js";
import { rangeOf } from "./test-helpers.js";

const identity = {
  workspaceId: "ws-1",
  repoId: "repo-1",
  refId: "repo-1:main",
  fileId: "file-1",
  filePath: "src/foo.ts",
  languageId: "typescript",
};

const preparedText = { documentPrefix: "search_document:", repoLabel: "untangle", refName: "main" };

describe("splitByTokenBoundary", () => {
  it("produces a gap-free, ordered, budget-respecting partition of a large blob", () => {
    const content = "x".repeat(5000);
    const config = resolveChunkerConfig({ maxTokensPerChunk: 30, preparedText });
    const ctx = createBuildContext(identity, content, config, "complete");
    const pieces = splitByTokenBoundary(ctx, ctx.fileRange, { signature: "s" });

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces[0]!.startByte).toBe(0);
    expect(pieces[pieces.length - 1]!.endByte).toBe(ctx.fileRange.endByte);
    for (let i = 1; i < pieces.length; i += 1) {
      expect(pieces[i]!.startByte).toBe(pieces[i - 1]!.endByte);
    }
    const reconstructed = pieces.map((p) => contentOf(ctx, p)).join("");
    expect(reconstructed).toBe(content);
  });

  it("never splits a multi-byte UTF-8 character across two pieces", () => {
    // Repeated 2-byte characters so many split points would land mid-character
    // if byte-safety were not enforced.
    const content = "é".repeat(3000);
    const config = resolveChunkerConfig({ maxTokensPerChunk: 20, preparedText });
    const ctx = createBuildContext(identity, content, config, "complete");
    const pieces = splitByTokenBoundary(ctx, ctx.fileRange, { signature: "s" });
    for (const piece of pieces) {
      // A valid decode never contains the replacement character.
      expect(contentOf(ctx, piece)).not.toContain("�");
    }
    expect(pieces.map((p) => contentOf(ctx, p)).join("")).toBe(content);
  });
});

describe("flattenToAtoms", () => {
  it("returns the whole node when it already fits the budget", () => {
    const content = "const x = 1;";
    const config = resolveChunkerConfig({ maxTokensPerChunk: 500, preparedText });
    const ctx = createBuildContext(identity, content, config, "complete");
    const range = rangeOf(content, "const x = 1;");
    const node: AstRegion = { chunkKind: "function", range, scopeId: "unused", splittable: true };
    expect(flattenToAtoms(ctx, node, {})).toEqual([range]);
  });

  it("fills gaps between children so the atom list covers the parent range exactly", () => {
    const content = "{ AAAA; ---between--- BBBB; }";
    const config = resolveChunkerConfig({ maxTokensPerChunk: 1, preparedText });
    const ctx = createBuildContext(identity, content, config, "complete");
    const wholeRange = rangeOf(content, content);
    const childA = {
      chunkKind: "symbol_fragment" as const,
      range: rangeOf(content, "AAAA;"),
      scopeId: "unused",
      splittable: false,
    };
    const childB = {
      chunkKind: "symbol_fragment" as const,
      range: rangeOf(content, "BBBB;"),
      scopeId: "unused",
      splittable: false,
    };
    const node: AstRegion = {
      chunkKind: "function",
      range: wholeRange,
      scopeId: "unused",
      splittable: true,
      children: [childA, childB],
    };
    const atoms = flattenToAtoms(ctx, node, {});
    expect(atoms[0]!.startByte).toBe(wholeRange.startByte);
    expect(atoms[atoms.length - 1]!.endByte).toBe(wholeRange.endByte);
    for (let i = 1; i < atoms.length; i += 1) {
      expect(atoms[i]!.startByte).toBe(atoms[i - 1]!.endByte);
    }
  });
});
