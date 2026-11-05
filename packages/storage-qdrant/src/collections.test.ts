/**
 * Collection naming (spec.md §10.1) and payload-index catalog (spec.md §10.4).
 */
import type { EmbeddingProfile } from "@untangle-code/domain";
import { isUntangleError } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import {
  CODE_KEYWORD_INDEX_FIELDS,
  CODE_NUMERIC_INDEXES,
  CODE_PAYLOAD_INDEXES,
  changesCollectionName,
  codeCollectionName,
  complexityHistoryCollectionName,
  contextCollectionName,
  graphCollectionName,
  metadataCollectionName,
  provisionCodeCollection,
} from "./collections.js";
import { FakeQdrantServer } from "./testing/fake-qdrant-server.js";
import { QdrantVectorStore } from "./vector-store.js";

const PROFILE: EmbeddingProfile = {
  provider: "ollama",
  model: "nomic-embed-text",
  dimensions: 768,
  queryPrefix: "search_query: ",
  documentPrefix: "search_document: ",
  includePath: true,
  normalization: "none",
  preparedTextVersion: "v1",
};

describe("collection names (spec.md §10.1, architecture.md §11.1)", () => {
  it("follows the {prefix}<kind>_v1 scheme with a configurable prefix", () => {
    expect(codeCollectionName("untangle_", "a1b2c3d4")).toBe("untangle_code_a1b2c3d4_v1");
    expect(contextCollectionName("untangle_", "a1b2c3d4")).toBe("untangle_context_a1b2c3d4_v1");
    expect(changesCollectionName("untangle_", "a1b2c3d4")).toBe("untangle_changes_a1b2c3d4_v1");
    expect(metadataCollectionName("untangle_")).toBe("untangle_metadata_v1");
    expect(graphCollectionName("untangle_", "graph_files")).toBe("untangle_graph_files_v1");
    expect(graphCollectionName("untangle_", "graph_indices")).toBe("untangle_graph_indices_v1");
    expect(graphCollectionName("untangle_", "graph_meta")).toBe("untangle_graph_meta_v1");
    expect(complexityHistoryCollectionName("untangle_")).toBe("untangle_complexity_history_v1");
    expect(metadataCollectionName("acme_")).toBe("acme_metadata_v1");
  });

  it("rejects an empty or malformed prefix with CONFIG_INVALID", () => {
    for (const prefix of ["", "UPPER_", "bad prefix_", "_leading"]) {
      try {
        metadataCollectionName(prefix);
        expect.unreachable(`prefix "${prefix}" must be rejected`);
      } catch (error) {
        expect(isUntangleError(error) && error.code).toBe("CONFIG_INVALID");
      }
    }
  });
});

describe("payload-index catalog (spec.md §10.4)", () => {
  it("contains exactly the fifteen mandatory keyword fields", () => {
    expect([...CODE_KEYWORD_INDEX_FIELDS].sort()).toEqual(
      [
        "point_type",
        "workspace_id",
        "repo_id",
        "ref_id",
        "file_id",
        "file_path",
        "language",
        "parse_quality",
        "symbol_id",
        "symbol_name",
        "symbol_fqn",
        "symbol_kind",
        "chunk_kind",
        "content_hash",
        "embedding_profile_id",
      ].sort(),
    );
  });

  it("contains all nine numeric fields", () => {
    expect(CODE_NUMERIC_INDEXES.map((index) => index.field).sort()).toEqual(
      [
        "cyclomatic_classic",
        "cyclomatic_extended",
        "cognitive",
        "max_nesting",
        "sloc",
        "halstead_volume",
        "maintainability_index",
        "risk_score",
        "changed_at_epoch_ms",
      ].sort(),
    );
    expect(CODE_PAYLOAD_INDEXES).toHaveLength(
      CODE_KEYWORD_INDEX_FIELDS.length + CODE_NUMERIC_INDEXES.length,
    );
  });
});

describe("provisionCodeCollection", () => {
  it("creates the collection from the profile and provisions every payload index", async () => {
    const fake = new FakeQdrantServer();
    const store = new QdrantVectorStore({ transport: fake, maxRetries: 0, retryDelayMs: 0 });
    const { collection, profileId } = await provisionCodeCollection(store, {
      prefix: "untangle_",
      profile: PROFILE,
    });
    expect(collection).toBe(`untangle_code_${profileId.slice(0, 8)}_v1`);
    const create = fake.requestLog.find(
      (request) => request.method === "PUT" && request.path === `/collections/${collection}`,
    );
    expect(create?.body).toEqual({
      vectors: { dense: { size: 768, distance: "Cosine" } },
      sparse_vectors: { bm25: { modifier: "idf" } },
      on_disk_payload: true,
    });
    expect(Object.keys(fake.payloadSchema(collection))).toHaveLength(CODE_PAYLOAD_INDEXES.length);
  });
});
