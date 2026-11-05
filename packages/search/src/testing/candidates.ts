/**
 * Kleine Bauhelfer fuer Kandidaten in Unit-Tests.
 *
 * Test-Infrastruktur: wird nicht gebaut und nicht ausgeliefert.
 */
import type { CodeChunkPayloadV1 } from "@untangle-code/domain";

import type { SearchCandidate } from "../payload.js";

/** Ein vollstaendiger, plausibler Chunk-Payload mit ueberschreibbaren Feldern. */
export function payloadFixture(overrides: Partial<CodeChunkPayloadV1> = {}): CodeChunkPayloadV1 {
  return {
    schema_version: 1,
    point_type: "code_chunk",
    workspace_id: "ws-1",
    repo_id: "repo-a",
    repo_label: "repo-a",
    ref_id: "ref-main",
    ref_name: "main",
    file_id: "file-1",
    file_path: "src/a.ts",
    file_hash: "hash",
    language: "typescript",
    parse_quality: "complete",
    chunk_id: "chunk-1",
    chunk_kind: "function",
    chunk_ordinal: 0,
    start_line: 1,
    end_line: 5,
    start_byte: 0,
    end_byte: 42,
    content: "export function a() {}",
    content_hash: "content-hash",
    parser_version: "untangle-parser-v1",
    chunker_version: "untangle-chunker-v1",
    metrics_version: "untangle-metrics-v1",
    embedding_profile_id: "profile-1",
    generation_id: "gen-1",
    embedding_truncated: false,
    metrics_scope: "symbol",
    metrics_scope_id: "sym-1",
    ...overrides,
  };
}

/** Ein Kandidat um einen Payload herum. */
export function candidateFixture(
  overrides: Partial<CodeChunkPayloadV1> = {},
  extra: Partial<Omit<SearchCandidate, "payload" | "raw">> = {},
  raw: Record<string, unknown> = {},
): SearchCandidate {
  const payload = payloadFixture(overrides);
  return {
    pointId: payload.chunk_id,
    payload,
    raw: { ...(payload as unknown as Record<string, unknown>), ...raw },
    substitutedFields: [],
    ...extra,
  };
}
