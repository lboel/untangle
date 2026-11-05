import { describe, expect, it } from "vitest";

import {
  candidateFromPoint,
  lexicalDocumentText,
  readCodeChunkPayload,
  readRawNumber,
  readRawString,
} from "./payload.js";
import { payloadFixture } from "./testing/candidates.js";

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(payloadFixture() as unknown as Record<string, unknown>), ...overrides };
}

describe("readCodeChunkPayload", () => {
  it("reads a complete payload", () => {
    const result = readCodeChunkPayload(raw());
    expect(result.ok).toBe(true);
  });

  it("names the missing fields instead of returning a half-built object", () => {
    const incomplete = raw();
    delete incomplete["file_path"];
    delete incomplete["chunk_id"];
    const result = readCodeChunkPayload(incomplete);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("file_path");
      expect(result.reason).toContain("chunk_id");
    }
  });

  it("rejects a point of another kind", () => {
    const result = readCodeChunkPayload(raw({ point_type: "graph_shard_part" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("point_type");
    }
  });

  it("says so when there is no payload at all", () => {
    const result = readCodeChunkPayload(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("no payload");
    }
  });

  it("falls back to 'failed' — never to 'complete' — for an unknown parse quality", () => {
    const result = readCodeChunkPayload(raw({ parse_quality: "who-knows" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.parse_quality).toBe("failed");
    }
  });

  it("falls back repo_label to repo_id and ref_name to ref_id", () => {
    const withoutLabels = raw();
    delete withoutLabels["repo_label"];
    delete withoutLabels["ref_name"];
    const result = readCodeChunkPayload(withoutLabels);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.repo_label).toBe("repo-a");
      expect(result.payload.ref_name).toBe("ref-main");
    }
  });

  it("keeps optional fields absent rather than setting them to undefined", () => {
    const result = readCodeChunkPayload(raw());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("symbol_id" in result.payload).toBe(false);
    }
  });

  it("ignores non-numeric values in numeric fields", () => {
    const result = readCodeChunkPayload(raw({ cognitive: "many" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.cognitive).toBeUndefined();
    }
  });
});

describe("candidateFromPoint", () => {
  it("keeps the raw payload so extra indexed fields survive", () => {
    const result = candidateFromPoint({
      id: "p1",
      score: 0.5,
      payload: raw({ changed_at_epoch_ms: 1234, generation_id: "gen-9" }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(readRawNumber(result.candidate.raw, "changed_at_epoch_ms")).toBe(1234);
      expect(readRawString(result.candidate.raw, "generation_id")).toBe("gen-9");
    }
  });

  it("reports a reason for an unusable point", () => {
    const result = candidateFromPoint({ id: "p1", score: 0.5 });
    expect(result.ok).toBe(false);
  });
});

describe("lexicalDocumentText", () => {
  it("includes path, symbol names, signature and content", () => {
    const text = lexicalDocumentText(
      payloadFixture({
        symbol_name: "charge",
        symbol_fqn: "PaymentService.charge",
        signature: "charge(amount: number)",
      }),
    );
    expect(text).toContain("src/a.ts");
    expect(text).toContain("charge");
    expect(text).toContain("PaymentService.charge");
    expect(text).toContain("export function a() {}");
  });

  it("omits absent parts instead of leaving blank lines", () => {
    expect(lexicalDocumentText(payloadFixture()).split("\n")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Regressionen aus der adversarialen Pruefung (Welle 3)
// ---------------------------------------------------------------------------

describe("readCodeChunkPayload: Ersatzwerte werden benannt (E4)", () => {
  function thin(): Record<string, unknown> {
    return {
      point_type: "code_chunk",
      workspace_id: "ws-1",
      repo_id: "repo-a",
      ref_id: "ref-main",
      file_id: "file-1",
      file_path: "src/a.ts",
      chunk_id: "chunk-1",
      metrics_scope_id: "sym-1",
      start_line: 42,
      start_byte: 1000,
    };
  }

  it("nennt jedes ersetzte Feld statt einen vollstaendigen Treffer vorzutaeuschen", () => {
    const result = readCodeChunkPayload(thin());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    for (const field of [
      "end_line",
      "end_byte",
      "file_hash",
      "parser_version",
      "chunker_version",
      "metrics_version",
      "embedding_profile_id",
      "generation_id",
      "content_hash",
      "parse_quality",
      "language",
    ]) {
      expect(result.substitutedFields).toContain(field);
    }
  });

  it("haelt einen Altindex ohne Generation lesbar, ohne den Ersatz als rohe Provenienz auszugeben", () => {
    const legacy = raw();
    delete legacy["generation_id"];
    const result = candidateFromPoint({ id: "legacy", score: 0.5, payload: legacy });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.payload.generation_id).toBe("unknown");
      expect(result.candidate.substitutedFields).toContain("generation_id");
      expect(readRawString(result.candidate.raw, "generation_id")).toBeUndefined();
    }
  });

  it("marks a legacy metrics version as unknown instead of emitting an empty contract field", () => {
    const legacy = raw();
    delete legacy["metrics_version"];
    const result = readCodeChunkPayload(legacy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.metrics_version).toBe("unknown");
      expect(result.substitutedFields).toContain("metrics_version");
    }
  });

  it("liefert nie einen ungueltigen Bereich: end_byte faellt auf start_byte, nicht auf 0", () => {
    const result = readCodeChunkPayload(thin());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.end_byte).toBe(1000);
      expect(result.payload.end_line).toBe(42);
    }
  });

  it("lehnt einen gespeicherten Bereich ab, dessen Ende vor dem Anfang liegt", () => {
    const before = readCodeChunkPayload({ ...thin(), end_byte: 0 });
    expect(before.ok).toBe(false);
    if (!before.ok) {
      expect(before.reason).toContain("end_byte");
    }
    const lines = readCodeChunkPayload({ ...thin(), end_line: 7 });
    expect(lines.ok).toBe(false);
    if (!lines.ok) {
      expect(lines.reason).toContain("end_line");
    }
  });

  it("meldet einen vollstaendigen Payload als vollstaendig", () => {
    const result = readCodeChunkPayload(raw());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.substitutedFields).toEqual([]);
    }
  });

  it("verlangt point_type, statt einen fremden Punkt als Chunk zu lesen", () => {
    const without = raw();
    delete without["point_type"];
    const result = readCodeChunkPayload(without);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("point_type");
    }
  });
});
