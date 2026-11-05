import type { ArtifactDocument } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { computeArtifactStalenessSnapshot, isArtifactStale } from "./staleness.js";
import { artifactConfig } from "./test-helpers.js";

function doc(path: string, content: string): ArtifactDocument {
  return { artifactName: "a", type: "text", path, contentHash: `hash(${content})`, content };
}

describe("staleness", () => {
  it("is not stale when neither config nor content changed", () => {
    const config = artifactConfig({ name: "a", path: "a.txt", description: "d" });
    const before = computeArtifactStalenessSnapshot(config, [doc("a.txt", "v1")]);
    const after = computeArtifactStalenessSnapshot(config, [doc("a.txt", "v1")]);
    expect(isArtifactStale(before, after)).toBe(false);
  });

  it("goes stale when content changes but config does not", () => {
    const config = artifactConfig({ name: "a", path: "a.txt", description: "d" });
    const before = computeArtifactStalenessSnapshot(config, [doc("a.txt", "v1")]);
    const after = computeArtifactStalenessSnapshot(config, [doc("a.txt", "v2")]);
    expect(isArtifactStale(before, after)).toBe(true);
    expect(before.configHash).toBe(after.configHash);
    expect(before.contentHash).not.toBe(after.contentHash);
  });

  it("goes stale when config changes but content does not", () => {
    const before = computeArtifactStalenessSnapshot(
      artifactConfig({ name: "a", path: "a.txt", description: "d1" }),
      [doc("a.txt", "v1")],
    );
    const after = computeArtifactStalenessSnapshot(
      artifactConfig({ name: "a", path: "a.txt", description: "d2" }),
      [doc("a.txt", "v1")],
    );
    expect(isArtifactStale(before, after)).toBe(true);
    expect(before.contentHash).toBe(after.contentHash);
    expect(before.configHash).not.toBe(after.configHash);
  });

  it("goes stale when a file is added or removed, independent of file-discovery order", () => {
    const config = artifactConfig({ name: "a", path: "dir/" });
    const twoFiles = computeArtifactStalenessSnapshot(config, [
      doc("dir/a.txt", "1"),
      doc("dir/b.txt", "2"),
    ]);
    const reordered = computeArtifactStalenessSnapshot(config, [
      doc("dir/b.txt", "2"),
      doc("dir/a.txt", "1"),
    ]);
    const oneFile = computeArtifactStalenessSnapshot(config, [doc("dir/a.txt", "1")]);
    expect(isArtifactStale(twoFiles, reordered)).toBe(false);
    expect(isArtifactStale(twoFiles, oneFile)).toBe(true);
  });
});
