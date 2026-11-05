import { describe, expect, it } from "vitest";

import { buildArtifactChunkId } from "./ids.js";

describe("buildArtifactChunkId", () => {
  const base = { artifactName: "a", documentPath: "x.md", kind: "markdown_section", ordinal: 0 };

  it("is deterministic for identical input", () => {
    expect(buildArtifactChunkId(base)).toBe(buildArtifactChunkId({ ...base }));
  });

  it("differs when any single component differs", () => {
    const id = buildArtifactChunkId(base);
    expect(buildArtifactChunkId({ ...base, artifactName: "b" })).not.toBe(id);
    expect(buildArtifactChunkId({ ...base, documentPath: "y.md" })).not.toBe(id);
    expect(buildArtifactChunkId({ ...base, kind: "sql_table" })).not.toBe(id);
    expect(buildArtifactChunkId({ ...base, ordinal: 1 })).not.toBe(id);
  });

  it("rejects a negative or non-integer ordinal", () => {
    expect(() => buildArtifactChunkId({ ...base, ordinal: -1 })).toThrow();
    expect(() => buildArtifactChunkId({ ...base, ordinal: 1.5 })).toThrow();
  });

  it("rejects an empty component", () => {
    expect(() => buildArtifactChunkId({ ...base, artifactName: "" })).toThrow();
  });
});
