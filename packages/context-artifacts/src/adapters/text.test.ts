import { describe, expect, it } from "vitest";

import { buildArtifactSkipLedger } from "../coverage.js";
import { artifactConfig, inputFile } from "../test-helpers.js";

import { createTextFallbackAdapter, TEXT_WINDOW_LINES } from "./text.js";

describe("createTextFallbackAdapter", () => {
  const adapter = createTextFallbackAdapter();

  it("supports() is a catch-all", () => {
    expect(adapter.supports("auto", "whatever.unknown-extension")).toBe(true);
    expect(adapter.supports("text", "notes.txt")).toBe(true);
  });

  it("splits a small file into a single window covering the whole content", async () => {
    const content = "line1\nline2\nline3\n";
    const config = artifactConfig({ name: "readme-notes", path: "notes.txt", type: "text" });
    const [document] = await adapter.read({ config, files: [inputFile("notes.txt", content)] });
    expect(document!.type).toBe("text");

    const chunks = adapter.chunk(document!);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.kind).toBe("text_window");
    expect(chunks[0]!.content).toBe(content);

    // Full coverage, by construction — zero skip-ledger entries.
    expect(buildArtifactSkipLedger(document!, chunks)).toEqual([]);
  });

  it("splits a large file into multiple contiguous, non-overlapping windows with full coverage", async () => {
    const lines = Array.from({ length: TEXT_WINDOW_LINES * 2 + 5 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n") + "\n";
    const config = artifactConfig({ name: "big-log", path: "big.log", type: "text" });
    const [document] = await adapter.read({ config, files: [inputFile("big.log", content)] });

    const chunks = adapter.chunk(document!);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.range.startLine).toBe(1);
    expect(chunks[0]!.range.endLine).toBe(TEXT_WINDOW_LINES);
    expect(chunks[1]!.range.startLine).toBe(TEXT_WINDOW_LINES + 1);
    // Windows are byte-adjacent: one window's end byte is the next window's start byte.
    expect(chunks[0]!.range.endByte).toBe(chunks[1]!.range.startByte);
    expect(chunks[1]!.range.endByte).toBe(chunks[2]!.range.startByte);
    expect(buildArtifactSkipLedger(document!, chunks)).toEqual([]);

    // Reassembling every chunk's content reproduces the original file exactly (lossless).
    expect(chunks.map((c) => c.content).join("")).toBe(content);
  });
});
