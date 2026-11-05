import { UntangleError } from "@untangle-code/domain";
import type { SourceRange } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { buildLineIndex } from "./byte-text.js";
import {
  assertLosslessCoverage,
  assertTruthfulLedger,
  chunkedEntry,
  excludedEntry,
  type LedgerChunkView,
} from "./coverage.js";

const fileRange: SourceRange = { startLine: 1, endLine: 3, startByte: 0, endByte: 30 };

describe("chunkedEntry / excludedEntry", () => {
  it("builds a well-formed chunked entry", () => {
    const range: SourceRange = { startLine: 1, endLine: 1, startByte: 0, endByte: 10 };
    expect(chunkedEntry(range, "chunk-1")).toEqual({
      range,
      status: "chunked",
      chunkIds: ["chunk-1"],
    });
  });

  it("builds a well-formed excluded entry with a reason", () => {
    const range: SourceRange = { startLine: 1, endLine: 1, startByte: 0, endByte: 10 };
    expect(excludedEntry(range, "binary blob")).toEqual({
      range,
      status: "excluded",
      exclusionReason: "binary blob",
    });
  });
});

describe("assertLosslessCoverage", () => {
  it("passes silently when chunked + excluded entries fully cover the file range", () => {
    const entries = [
      chunkedEntry({ startLine: 1, endLine: 2, startByte: 0, endByte: 20 }, "chunk-1"),
      excludedEntry({ startLine: 3, endLine: 3, startByte: 20, endByte: 30 }, "generated section"),
    ];
    expect(() => assertLosslessCoverage(entries, fileRange, "src/foo.ts")).not.toThrow();
  });

  it("throws UntangleError ANALYSIS_INCOMPLETE naming the exact byte gap when coverage is short", () => {
    const entries = [
      chunkedEntry({ startLine: 1, endLine: 1, startByte: 0, endByte: 10 }, "chunk-1"),
    ];
    try {
      assertLosslessCoverage(entries, fileRange, "src/foo.ts");
      throw new Error("expected assertLosslessCoverage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UntangleError);
      const untangleError = error as UntangleError;
      expect(untangleError.code).toBe("ANALYSIS_INCOMPLETE");
      expect(untangleError.context["gaps"]).toEqual([
        { startLine: -1, endLine: -1, startByte: 10, endByte: 30 },
      ]);
    }
  });

  it("treats overlapping chunked entries as fully valid (overlaps are allowed)", () => {
    const entries = [
      chunkedEntry({ startLine: 1, endLine: 3, startByte: 0, endByte: 30 }, "overview"),
      chunkedEntry({ startLine: 1, endLine: 1, startByte: 0, endByte: 10 }, "member-1"),
    ];
    expect(() => assertLosslessCoverage(entries, fileRange, "src/foo.ts")).not.toThrow();
  });
});

describe("assertTruthfulLedger (spec.md §8.4: no claim without literally carried content)", () => {
  // "0123456789...": every byte of the fixture is addressable by offset.
  const SOURCE = "export class Foo {\n  // hidden note\n}\n";
  const lineIndex = buildLineIndex(SOURCE);
  const bytesOf = (startByte: number, endByte: number): SourceRange => ({
    startLine: -1,
    endLine: -1,
    startByte,
    endByte,
  });
  const realChunk = (chunkId: string, startByte: number, endByte: number): LedgerChunkView => ({
    chunkId,
    chunkKind: "module",
    range: bytesOf(startByte, endByte),
    content: SOURCE.slice(startByte, endByte),
  });

  it("passes when every non-synthesized chunk is byte-exact and every claim is carried", () => {
    const drafts: LedgerChunkView[] = [
      realChunk("real-1", 0, 38),
      {
        chunkId: "synth-1",
        chunkKind: "class_overview",
        range: bytesOf(0, 38),
        content: "class Foo\n\nmembers:",
        synthesized: true,
      },
    ];
    const entries = [
      chunkedEntry(bytesOf(0, 38), "real-1"),
      // "class Foo" (bytes 7..16) IS literally carried by the synthesized content.
      chunkedEntry(bytesOf(7, 16), "synth-1"),
    ];
    expect(() => assertTruthfulLedger(lineIndex, drafts, entries, "src/foo.ts")).not.toThrow();
  });

  it("throws when a non-synthesized chunk's content is not byte-exact for its range", () => {
    const drafts: LedgerChunkView[] = [
      { ...realChunk("real-1", 0, 38), content: "rewritten content" },
    ];
    const entries = [chunkedEntry(bytesOf(0, 38), "real-1")];
    try {
      assertTruthfulLedger(lineIndex, drafts, entries, "src/foo.ts");
      throw new Error("expected assertTruthfulLedger to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UntangleError);
      expect((error as UntangleError).code).toBe("ANALYSIS_INCOMPLETE");
      expect(JSON.stringify((error as UntangleError).context["violations"])).toContain(
        "not byte-exact",
      );
    }
  });

  it("throws (error, not warning) when a synthesized chunk claims bytes its content does not carry — the masked state", () => {
    const drafts: LedgerChunkView[] = [
      {
        chunkId: "synth-1",
        chunkKind: "class_overview",
        range: bytesOf(0, 38),
        content: "class Foo\n\nmembers:",
        synthesized: true,
      },
    ];
    // The wave-1 defect verbatim: the synthesized overview claims the whole
    // header span although "// hidden note" appears nowhere in its content.
    const entries = [chunkedEntry(bytesOf(0, 38), "synth-1")];
    try {
      assertTruthfulLedger(lineIndex, drafts, entries, "src/foo.ts");
      throw new Error("expected assertTruthfulLedger to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UntangleError);
      expect((error as UntangleError).code).toBe("ANALYSIS_INCOMPLETE");
      expect(JSON.stringify((error as UntangleError).context["violations"])).toContain(
        "literally carries",
      );
    }
  });

  it("throws when a chunked entry references an unknown chunk id", () => {
    const entries = [chunkedEntry(bytesOf(0, 38), "no-such-chunk")];
    expect(() => assertTruthfulLedger(lineIndex, [], entries, "src/foo.ts")).toThrow(UntangleError);
  });

  it("ignores excluded entries (their proof is the documented reason, not chunk content)", () => {
    const entries = [excludedEntry(bytesOf(0, 38), "generated lockfile section")];
    expect(() => assertTruthfulLedger(lineIndex, [], entries, "src/foo.ts")).not.toThrow();
  });
});
