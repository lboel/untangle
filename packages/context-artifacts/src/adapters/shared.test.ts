import { describe, expect, it, vi } from "vitest";

import type { ArtifactSkipLedgerEntry } from "../coverage.js";
import { artifactConfig, inputFile } from "../test-helpers.js";
import { buildLineIndex } from "../text/line-index.js";

import { createProtobufAdapter } from "./protobuf.js";
import { buildChunksReportingSkips } from "./shared.js";

describe("buildChunksReportingSkips (BUILD_PLAN §12 E4: not a caller's Bringschuld)", () => {
  it("does not invoke the reporter when there is nothing actionable to report", () => {
    const report = vi.fn();
    const document = {
      artifactName: "a",
      type: "text" as const,
      path: "a.txt",
      contentHash: "h",
      content: "hello\nworld\n",
    };
    const index = buildLineIndex(document.content);
    buildChunksReportingSkips(
      document,
      index,
      [{ kind: "text_window", startLine: 1, endLine: 2 }],
      report,
    );
    expect(report).not.toHaveBeenCalled();
  });

  it("invokes the reporter with the actionable (non-whitespace) entries when a real gap exists", () => {
    const report = vi.fn();
    const document = {
      artifactName: "a",
      type: "text" as const,
      path: "a.txt",
      contentHash: "h",
      content: "kept\nreal content, never chunked\n",
    };
    const index = buildLineIndex(document.content);
    // A draft that only covers the first line — the second line's real
    // content is a genuine, non-benign gap.
    buildChunksReportingSkips(
      document,
      index,
      [{ kind: "text_window", startLine: 1, endLine: 1 }],
      report,
    );
    expect(report).toHaveBeenCalledTimes(1);
    const [entries] = report.mock.calls[0]!;
    expect(
      (entries as ArtifactSkipLedgerEntry[]).every((e) => e.reason !== "whitespace_or_comment"),
    ).toBe(true);
    expect((entries as ArtifactSkipLedgerEntry[])[0]!.contentPreview).toContain("real content");
  });

  it("a real adapter's chunk() surfaces a loss on its own, with zero separate buildArtifactSkipLedger call from the caller", async () => {
    // Task (c): "buildArtifactSkipLedger() darf keine Bringschuld des
    // Aufrufers sein" — a caller who does nothing but call chunk() must
    // still be told about a real loss. The Protobuf adapter only chunks
    // `message`/`service` blocks, so a file-level preamble (`syntax`/
    // `package`) is real, un-chunked content — exactly the kind of finding
    // that used to require a caller to separately call
    // `buildArtifactSkipLedger`.
    const onSkipLedgerGap = vi.fn();
    const adapter = createProtobufAdapter({ onSkipLedgerGap });
    const config = artifactConfig({
      name: "preamble-demo",
      path: "proto/x.proto",
      type: "protobuf",
    });
    const content = 'syntax = "proto3";\npackage demo.v1;\n\nmessage Foo {\n  string id = 1;\n}\n';
    const [document] = await adapter.read({ config, files: [inputFile("proto/x.proto", content)] });

    adapter.chunk(document!); // the caller never touches coverage.ts at all

    expect(onSkipLedgerGap).toHaveBeenCalledTimes(1);
    const [entries] = onSkipLedgerGap.mock.calls[0]!;
    expect((entries as ArtifactSkipLedgerEntry[])[0]!.reason).toBe("unclassified_content");
    expect((entries as ArtifactSkipLedgerEntry[])[0]!.contentPreview).toContain("syntax");
  });
});
