import { buildEmbeddingProfileId } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_EMBEDDING_CONFIG,
  DEFAULT_EMBEDDING_NORMALIZATION,
  PREPARED_TEXT_VERSION,
} from "./defaults.js";
import { computeConfigHash, deriveEmbeddingProfile, deriveEmbeddingProfileId } from "./hash.js";

describe("computeConfigHash", () => {
  it("is deterministic for structurally equal input", () => {
    const a = { schemaVersion: 1, workspaceId: "w", embeddings: { model: "nomic-embed-text" } };
    const b = { embeddings: { model: "nomic-embed-text" }, workspaceId: "w", schemaVersion: 1 };
    expect(computeConfigHash(a)).toBe(computeConfigHash(b));
  });

  it("changes when a value changes", () => {
    const a = computeConfigHash({ workspaceId: "w1" });
    const b = computeConfigHash({ workspaceId: "w2" });
    expect(a).not.toBe(b);
  });

  it("produces a 64-character lowercase hex SHA-256 digest", () => {
    const hash = computeConfigHash({ a: 1 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("deriveEmbeddingProfile / deriveEmbeddingProfileId", () => {
  it("assembles the domain EmbeddingProfile from EmbeddingConfig plus fixed constants", () => {
    const profile = deriveEmbeddingProfile({ embeddings: DEFAULT_EMBEDDING_CONFIG });
    expect(profile).toEqual({
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
      queryPrefix: "search_query: ",
      documentPrefix: "search_document: ",
      includePath: true,
      normalization: DEFAULT_EMBEDDING_NORMALIZATION,
      preparedTextVersion: PREPARED_TEXT_VERSION,
    });
  });

  it("matches buildEmbeddingProfileId from domain directly", () => {
    const profile = deriveEmbeddingProfile({ embeddings: DEFAULT_EMBEDDING_CONFIG });
    expect(deriveEmbeddingProfileId({ embeddings: DEFAULT_EMBEDDING_CONFIG })).toBe(
      buildEmbeddingProfileId(profile),
    );
  });

  it("changes when the model changes", () => {
    const a = deriveEmbeddingProfileId({ embeddings: DEFAULT_EMBEDDING_CONFIG });
    const b = deriveEmbeddingProfileId({
      embeddings: { ...DEFAULT_EMBEDDING_CONFIG, model: "other-model" },
    });
    expect(a).not.toBe(b);
  });
});
