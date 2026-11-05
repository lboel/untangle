import type { ArtifactChunk, ArtifactDocument } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { buildArtifactSkipLedger } from "./coverage.js";

function doc(content: string): ArtifactDocument {
  return { artifactName: "a", type: "text", path: "a.txt", contentHash: "h", content };
}

function chunk(kind: string, startByte: number, endByte: number): ArtifactChunk {
  return {
    chunkId: `${kind}-${startByte}`,
    artifactName: "a",
    kind,
    range: { startLine: 1, endLine: 1, startByte, endByte },
    content: "x".repeat(endByte - startByte),
    contentHash: "h",
  };
}

describe("buildArtifactSkipLedger", () => {
  it("returns no entries when chunks fully cover the content", () => {
    const content = "abcdefghij";
    const chunks = [chunk("a", 0, 5), chunk("b", 5, 10)];
    expect(buildArtifactSkipLedger(doc(content), chunks)).toEqual([]);
  });

  it("reports a gap between chunks, classified by its content", () => {
    const content = "AAAA   BBBB"; // bytes 4..7 ("   ") are a gap
    const chunks = [chunk("a", 0, 4), chunk("b", 7, 11)];
    const ledger = buildArtifactSkipLedger(doc(content), chunks);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.range).toEqual({ startLine: 1, endLine: 1, startByte: 4, endByte: 7 });
    expect(ledger[0]!.reason).toBe("whitespace_or_comment");
  });

  it("classifies a gap that is a multi-line block comment as whitespace_or_comment", () => {
    const content = "AAAA/* a\nmulti-line\ncomment */BBBB";
    const chunks = [chunk("a", 0, 4), chunk("b", content.length - 4, content.length)];
    const ledger = buildArtifactSkipLedger(doc(content), chunks);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.reason).toBe("whitespace_or_comment");
  });

  it("classifies a gap with real content as unclassified_content", () => {
    const content = "AAAAXYZBBBB";
    const chunks = [chunk("a", 0, 4), chunk("b", 7, 11)];
    const ledger = buildArtifactSkipLedger(doc(content), chunks);
    expect(ledger[0]!.reason).toBe("unclassified_content");
    expect(ledger[0]!.contentPreview).toBe("XYZ");
  });

  it("handles overlapping chunk ranges (e.g. protobuf service + nested rpc) without spurious gaps", () => {
    const content = "0123456789";
    const chunks = [chunk("service", 0, 10), chunk("rpc", 2, 6)]; // rpc nested fully inside service
    expect(buildArtifactSkipLedger(doc(content), chunks)).toEqual([]);
  });

  it("reports leading and trailing gaps too", () => {
    const content = "  middle  ";
    const chunks = [chunk("a", 2, 8)];
    const ledger = buildArtifactSkipLedger(doc(content), chunks);
    expect(ledger).toHaveLength(2);
    expect(ledger[0]!.range).toEqual({ startLine: 1, endLine: 1, startByte: 0, endByte: 2 });
    expect(ledger[1]!.range).toEqual({ startLine: 1, endLine: 1, startByte: 8, endByte: 10 });
  });

  // --- WP-81 review requirement: byte coverage alone must not be the only
  // check — a chunk can exist, and its bytes can be formally "covered", while
  // the section it was meant to represent was still lost. These tests are
  // adapter-independent (synthetic chunks only), proving the LEDGER itself —
  // not any one adapter's fix — now catches this defect class. ---

  it("semantic_loss: a chunk with an empty/inverted range is reported even though it adds no byte gap", () => {
    const content = "CREATE TABLE foo (id int); CREATE TABLE bar (id int);\n";
    // Mirrors the exact shape of the pre-fix SQL defect: chunk "a" (wrongly)
    // covers the WHOLE line — including "bar"'s bytes — and a phantom chunk
    // "b" for the lost second statement has an inverted range (start > end).
    const degenerate: ArtifactChunk = {
      chunkId: "sql_statement-2",
      artifactName: "a",
      kind: "sql_statement",
      title: "STATEMENT",
      range: { startLine: 1, endLine: 1, startByte: 2, endByte: 1 }, // startByte > endByte: degenerate
      content: "",
      contentHash: "h",
    };
    const chunks: ArtifactChunk[] = [chunk("sql_table", 0, content.length), degenerate];
    const ledger = buildArtifactSkipLedger(doc(content), chunks);
    // No byte gap exists (chunk "a" alone covers every byte) — old behavior
    // reported nothing at all here, the exact "E4 is blind" finding.
    expect(
      ledger.some(
        (entry) =>
          entry.reason === "unclassified_content" || entry.reason === "whitespace_or_comment",
      ),
    ).toBe(false);
    const semanticLoss = ledger.filter((entry) => entry.reason === "semantic_loss");
    expect(semanticLoss).toHaveLength(1);
    expect(semanticLoss[0]!.contentPreview).toContain('kind="sql_statement"');
    expect(semanticLoss[0]!.contentPreview).toContain("empty/inverted range");
  });

  it("semantic_loss: two chunks claiming the exact same byte range with conflicting identities are reported", () => {
    const content = "0123456789";
    const chunks: ArtifactChunk[] = [
      chunk("kind_a", 0, 10),
      { ...chunk("kind_b", 0, 10), title: "other" },
    ];
    const ledger = buildArtifactSkipLedger(doc(content), chunks);
    const semanticLoss = ledger.filter((entry) => entry.reason === "semantic_loss");
    expect(semanticLoss).toHaveLength(1);
    expect(semanticLoss[0]!.contentPreview).toContain("conflicting classification");
  });

  it("semantic_loss: does NOT fire on Protobuf-style nested overlap (different, non-identical ranges)", () => {
    const content = "0123456789";
    const chunks = [chunk("service", 0, 10), chunk("rpc", 2, 6)];
    expect(
      buildArtifactSkipLedger(doc(content), chunks).some(
        (entry) => entry.reason === "semantic_loss",
      ),
    ).toBe(false);
  });

  it("semantic_loss: does NOT fire on two identical-range chunks that agree on kind and title", () => {
    const content = "0123456789";
    const chunks = [chunk("a", 0, 10), chunk("a", 0, 10)];
    expect(
      buildArtifactSkipLedger(doc(content), chunks).some(
        (entry) => entry.reason === "semantic_loss",
      ),
    ).toBe(false);
  });
  // --- WP-118: die dritte Blindstelle (falsch geschnitten statt fehlend) ---

  it("meldet ohne Plausibilitaetspruefung nichts, obwohl ein Chunk offensichtlich falsch geschnitten ist", () => {
    const content = "SELECT 'a; SELECT b';";
    const chunks = [chunk("sql_statement", 0, 10), chunk("sql_statement", 10, content.length)];
    // Lueckenlose Abdeckung, keine leeren/ueberlappenden Ranges: das ist
    // exakt der Zustand, in dem der Ledger vor WP-118 blind war.
    expect(buildArtifactSkipLedger(doc(content), chunks)).toEqual([]);
  });

  it("meldet jedes von der Pruefung beanstandete Fragment als implausible_fragment, mit dessen Begruendung", () => {
    const content = "SELECT 'a; SELECT b';";
    const chunks = [chunk("sql_statement", 0, 10), chunk("sql_statement", 10, content.length)];
    const ledger = buildArtifactSkipLedger(doc(content), chunks, {
      checkPlausibility: (candidate) =>
        candidate.range.startByte === 0 ? "unterminated string literal" : undefined,
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.reason).toBe("implausible_fragment");
    expect(ledger[0]!.range).toEqual(chunks[0]!.range);
    expect(ledger[0]!.contentPreview).toContain("unterminated string literal");
    expect(ledger[0]!.contentPreview).toContain('kind="sql_statement"');
  });

  it("laesst eine Pruefung, die nichts beanstandet, das Ergebnis unveraendert", () => {
    const content = "abcdefghij";
    const chunks = [chunk("a", 0, 5), chunk("b", 5, 10)];
    expect(
      buildArtifactSkipLedger(doc(content), chunks, { checkPlausibility: () => undefined }),
    ).toEqual([]);
  });
});
