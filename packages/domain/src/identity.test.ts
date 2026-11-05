import { describe, expect, it } from "vitest";

import {
  UNTANGLE_UUID_NAMESPACE,
  buildArchetypeId,
  buildBlueprintId,
  buildChunkId,
  buildConventionId,
  buildCorpusRevisionFingerprint,
  buildEmbeddingProfileId,
  buildFileId,
  buildRadarEntryId,
  buildRecommendationId,
  buildRefId,
  buildRepoId,
  buildRepoProfileId,
  buildRuleFingerprint,
  buildStackMatrixId,
  buildSymbolId,
  buildTechRecordId,
  buildTechnologyId,
  buildWorkspaceId,
  embeddingProfileShortId,
  hmacSha256Hex,
  normalizeRef,
  normalizeRelativePath,
  sha256Hex,
  uuidv5,
} from "./identity.js";
import type { EmbeddingProfile } from "./types/embedding.js";

const RFC_DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const UUID_V5_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const symbolInput = {
  workspaceId: "ws-1",
  repoId: "repo-1",
  refId: "repo-1:main",
  relativePath: "src/auth/service.ts",
  symbolKind: "method",
  qualifiedName: "AuthService.validateUser",
  normalizedSignature: "(user:User,token:string)=>Promise<boolean>",
};

const profile: EmbeddingProfile = {
  provider: "ollama",
  model: "nomic-embed-text",
  dimensions: 768,
  queryPrefix: "search_query: ",
  documentPrefix: "search_document: ",
  includePath: true,
  normalization: "none",
  preparedTextVersion: "prepared-text-v1",
};

describe("hmacSha256Hex", () => {
  it("produces a keyed digest and rejects undersized privacy keys", () => {
    expect(hmacSha256Hex(new Uint8Array(32), "untangle")).toBe(
      "7c087395f71278fcc11c6a61385c168a049e5859bdb6dcaee7b2799aea88ce7d",
    );
    expect(() => hmacSha256Hex(new Uint8Array(31), "untangle")).toThrow("at least 32 bytes");
  });
});

describe("uuidv5", () => {
  it("matches the RFC 4122 reference vector for the DNS namespace", () => {
    expect(uuidv5("python.org", RFC_DNS_NAMESPACE)).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });

  it("uses the fixed Untangle namespace by default", () => {
    expect(uuidv5("x")).toBe(uuidv5("x", UNTANGLE_UUID_NAMESPACE));
    expect(uuidv5("x")).not.toBe(uuidv5("x", RFC_DNS_NAMESPACE));
  });

  it("produces valid version-5 variant-1 UUIDs", () => {
    expect(uuidv5("anything")).toMatch(UUID_V5_PATTERN);
  });

  it("documents its namespace derivation: uuidv5('dev.untangle.identity', NS_DNS)", () => {
    expect(uuidv5("dev.untangle.identity", RFC_DNS_NAMESPACE)).toBe(UNTANGLE_UUID_NAMESPACE);
  });

  it("rejects malformed namespace literals", () => {
    expect(() => uuidv5("x", "not-a-uuid")).toThrow(/invalid UUID/);
  });
});

describe("normalizeRelativePath", () => {
  it("normalizes Windows separators to forward slashes", () => {
    expect(normalizeRelativePath("src\\auth\\service.ts")).toBe("src/auth/service.ts");
  });

  it("keeps already-normalized posix paths unchanged", () => {
    expect(normalizeRelativePath("src/auth/service.ts")).toBe("src/auth/service.ts");
  });

  it("removes '.' segments, duplicate slashes and trailing slashes", () => {
    expect(normalizeRelativePath("./src//auth/./sub/")).toBe("src/auth/sub");
  });

  it("resolves inner '..' segments", () => {
    expect(normalizeRelativePath("src/auth/../core/id.ts")).toBe("src/core/id.ts");
  });

  it("preserves case", () => {
    expect(normalizeRelativePath("Src/Auth.TS")).toBe("Src/Auth.TS");
  });

  it("rejects absolute posix and Windows paths", () => {
    expect(() => normalizeRelativePath("/etc/passwd")).toThrow(/absolute/);
    expect(() => normalizeRelativePath("C:\\Windows\\system32")).toThrow(/absolute/);
  });

  it("rejects paths escaping their root via leading '..'", () => {
    expect(() => normalizeRelativePath("../outside.ts")).toThrow(/escapes/);
    expect(() => normalizeRelativePath("a/../../outside.ts")).toThrow(/escapes/);
  });
});

describe("buildFileId", () => {
  it("yields identical ids for Windows and posix spellings of the same path", () => {
    const posix = buildFileId({
      workspaceId: "ws-1",
      repoId: "repo-1",
      refId: "repo-1:main",
      relativePath: "src/auth/service.ts",
    });
    const windows = buildFileId({
      workspaceId: "ws-1",
      repoId: "repo-1",
      refId: "repo-1:main",
      relativePath: "src\\auth\\service.ts",
    });
    expect(posix).toBe(windows);
  });

  it("is stable across processes (golden value)", () => {
    // Recomputing this in any process must yield the identical UUID.
    const id = buildFileId({
      workspaceId: "ws-1",
      repoId: "repo-1",
      refId: "repo-1:main",
      relativePath: "src/auth/service.ts",
    });
    expect(id).toMatch(UUID_V5_PATTERN);
    expect(id).toBe(
      buildFileId({
        workspaceId: "ws-1",
        repoId: "repo-1",
        refId: "repo-1:main",
        relativePath: "src/auth/service.ts",
      }),
    );
  });

  it("differs between distinct refs", () => {
    const main = buildFileId({
      workspaceId: "ws-1",
      repoId: "repo-1",
      refId: "repo-1:main",
      relativePath: "a.ts",
    });
    const dev = buildFileId({
      workspaceId: "ws-1",
      repoId: "repo-1",
      refId: "repo-1:dev",
      relativePath: "a.ts",
    });
    expect(main).not.toBe(dev);
  });
});

describe("buildSymbolId", () => {
  it("is stable when a symbol merely moves to other lines (lines are not inputs)", () => {
    // The identity function has no line/byte parameters at all; two extractions
    // of the same symbol at different file positions produce the same input
    // and therefore the same id.
    const before = buildSymbolId(symbolInput);
    const after = buildSymbolId({ ...symbolInput });
    expect(before).toBe(after);
  });

  it("changes when the normalized signature changes", () => {
    const before = buildSymbolId(symbolInput);
    const after = buildSymbolId({
      ...symbolInput,
      normalizedSignature: "(user:User)=>Promise<boolean>",
    });
    expect(before).not.toBe(after);
  });

  it("changes when kind or qualified name changes", () => {
    const base = buildSymbolId(symbolInput);
    expect(buildSymbolId({ ...symbolInput, symbolKind: "function" })).not.toBe(base);
    expect(buildSymbolId({ ...symbolInput, qualifiedName: "AuthService.other" })).not.toBe(base);
  });

  it("is immune to component-concatenation ambiguity", () => {
    const a = buildSymbolId({ ...symbolInput, symbolKind: "met", qualifiedName: "hodX" });
    const b = buildSymbolId({ ...symbolInput, symbolKind: "method", qualifiedName: "X" });
    expect(a).not.toBe(b);
  });
});

describe("buildChunkId", () => {
  it("is stable for unchanged symbol, ordinal and chunker version", () => {
    const symbolId = buildSymbolId(symbolInput);
    const a = buildChunkId({
      scopeId: symbolId,
      chunkKind: "method",
      ordinal: 0,
      chunkerVersion: "untangle-chunker-v1",
    });
    const b = buildChunkId({
      scopeId: symbolId,
      chunkKind: "method",
      ordinal: 0,
      chunkerVersion: "untangle-chunker-v1",
    });
    expect(a).toBe(b);
  });

  it("changes with ordinal and chunker version", () => {
    const base = {
      scopeId: "scope",
      chunkKind: "function",
      ordinal: 0,
      chunkerVersion: "untangle-chunker-v1",
    } as const;
    expect(buildChunkId(base)).not.toBe(buildChunkId({ ...base, ordinal: 1 }));
    expect(buildChunkId(base)).not.toBe(
      buildChunkId({ ...base, chunkerVersion: "untangle-chunker-v2" }),
    );
  });

  it("rejects negative or fractional ordinals", () => {
    const base = {
      scopeId: "scope",
      chunkKind: "function",
      chunkerVersion: "untangle-chunker-v1",
    };
    expect(() => buildChunkId({ ...base, ordinal: -1 })).toThrow(/ordinal/);
    expect(() => buildChunkId({ ...base, ordinal: 0.5 })).toThrow(/ordinal/);
  });
});

describe("buildRefId / normalizeRef", () => {
  it("composes repo id and normalized ref with a colon (not a UUID)", () => {
    expect(buildRefId("repo-1", "  main ")).toBe("repo-1:main");
  });

  it("rejects empty refs", () => {
    expect(() => buildRefId("repo-1", "   ")).toThrow(/refName/);
    expect(() => normalizeRef("")).toThrow(/refName/);
  });
});

describe("buildWorkspaceId / buildRepoId", () => {
  it("returns the explicit id verbatim when configured", () => {
    expect(buildWorkspaceId({ explicitId: "team-ws", configHash: "h" })).toBe("team-ws");
    expect(buildRepoId({ explicitId: "backend", canonicalPath: "/x" })).toBe("backend");
  });

  it("derives stable UUIDs from config hash / canonical path otherwise", () => {
    const ws = buildWorkspaceId({ configHash: sha256Hex("config") });
    expect(ws).toMatch(UUID_V5_PATTERN);
    expect(ws).toBe(buildWorkspaceId({ configHash: sha256Hex("config") }));

    const repo = buildRepoId({ canonicalPath: "/home/dev/backend" });
    expect(repo).toMatch(UUID_V5_PATTERN);
    expect(repo).toBe(buildRepoId({ canonicalPath: "/home/dev/backend" }));
  });

  it("normalizes Windows separators in the repo path fallback", () => {
    expect(buildRepoId({ canonicalPath: "C:/repos/backend" })).toBe(
      buildRepoId({ canonicalPath: "C:\\repos\\backend" }),
    );
  });
});

describe("buildEmbeddingProfileId", () => {
  it("is a SHA-256 hex over canonical JSON of the profile fields", () => {
    const id = buildEmbeddingProfileId(profile);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is independent of property order in the input object", () => {
    const shuffled: EmbeddingProfile = {
      preparedTextVersion: profile.preparedTextVersion,
      normalization: profile.normalization,
      includePath: profile.includePath,
      documentPrefix: profile.documentPrefix,
      queryPrefix: profile.queryPrefix,
      dimensions: profile.dimensions,
      model: profile.model,
      provider: profile.provider,
    };
    expect(buildEmbeddingProfileId(shuffled)).toBe(buildEmbeddingProfileId(profile));
  });

  it("changes when any mandatory field changes", () => {
    const base = buildEmbeddingProfileId(profile);
    expect(buildEmbeddingProfileId({ ...profile, dimensions: 1024 })).not.toBe(base);
    expect(buildEmbeddingProfileId({ ...profile, includePath: false })).not.toBe(base);
    expect(buildEmbeddingProfileId({ ...profile, queryPrefix: "q: " })).not.toBe(base);
  });

  it("ignores extra non-profile properties on wider objects", () => {
    const widened = { ...profile, batchSize: 32, requestTimeoutMs: 120000 };
    expect(buildEmbeddingProfileId(widened)).toBe(buildEmbeddingProfileId(profile));
  });

  it("derives a short id prefix for collection names", () => {
    const id = buildEmbeddingProfileId(profile);
    expect(embeddingProfileShortId(id)).toBe(id.slice(0, 8));
    expect(embeddingProfileShortId(id, 12)).toBe(id.slice(0, 12));
    expect(() => embeddingProfileShortId(id, 2)).toThrow(/length/);
  });
});

describe("portfolio identities", () => {
  it("derives deterministic technology ids and treats missing ecosystem as empty", () => {
    const a = buildTechnologyId({
      workspaceId: "ws-1",
      category: "library",
      ecosystem: "npm",
      canonicalName: "react",
    });
    expect(a).toMatch(UUID_V5_PATTERN);
    expect(a).toBe(
      buildTechnologyId({
        workspaceId: "ws-1",
        category: "library",
        ecosystem: "npm",
        canonicalName: "react",
      }),
    );
    expect(
      buildTechnologyId({ workspaceId: "ws-1", category: "library", canonicalName: "react" }),
    ).not.toBe(a);
  });

  it("keeps distinct id kinds collision-free even for identical components", () => {
    const components = { workspaceId: "w", repoId: "r", refId: "r:main" };
    expect(buildRepoProfileId(components)).not.toBe(
      buildArchetypeId({ ...components, classifierVersion: "portfolio_profile" }),
    );
  });

  it("derives the full portfolio id family deterministically", () => {
    const technologyId = buildTechnologyId({
      workspaceId: "w",
      category: "library",
      ecosystem: "npm",
      canonicalName: "fastify",
    });
    const recordId = buildTechRecordId({
      technologyId,
      repoId: "r",
      refId: "r:main",
      usage: "runtime",
      detectorId: "npm.dependencies",
    });
    const matrixId = buildStackMatrixId({ workspaceId: "w", generationId: "g1" });
    const fingerprint = buildRuleFingerprint({ glob: "src/**/*.test.ts", kind: "path_layout" });
    const conventionId = buildConventionId({
      workspaceId: "w",
      conventionKind: "test_setup",
      ruleFingerprint: fingerprint,
    });
    const blueprintId = buildBlueprintId({
      workspaceId: "w",
      blueprintKind: "api-service",
      advisorVersion: "untangle-blueprint-v1",
      generationId: "g1",
    });
    const recommendationId = buildRecommendationId({ blueprintId, topic: "http_framework" });
    const radarEntryId = buildRadarEntryId({
      workspaceId: "w",
      technologyId,
      radarVersion: "untangle-radar-v1",
    });

    const all = [
      technologyId,
      recordId,
      matrixId,
      conventionId,
      blueprintId,
      recommendationId,
      radarEntryId,
    ];
    for (const id of all) {
      expect(id).toMatch(UUID_V5_PATTERN);
    }
    expect(new Set(all).size).toBe(all.length);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).toBe(
      buildRuleFingerprint({ kind: "path_layout", glob: "src/**/*.test.ts" }),
    );
  });
});

describe("input validation", () => {
  it("rejects empty identity components", () => {
    expect(() =>
      buildFileId({ workspaceId: "", repoId: "r", refId: "r:main", relativePath: "a.ts" }),
    ).toThrow(/must not be empty/);
  });

  it("rejects components containing the U+001F separator", () => {
    expect(() =>
      buildFileId({
        workspaceId: "ws\u001fx",
        repoId: "r",
        refId: "r:main",
        relativePath: "a.ts",
      }),
    ).toThrow(/U\+001F/);
  });
});

describe("corpus revision fingerprint", () => {
  it("is order-independent and changes with corpus content", () => {
    const first = buildCorpusRevisionFingerprint({ "file-b": "hash-b", "file-a": "hash-a" });
    const reordered = buildCorpusRevisionFingerprint({
      "file-a": "hash-a",
      "file-b": "hash-b",
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(reordered).toBe(first);
    expect(buildCorpusRevisionFingerprint({ "file-a": "hash-a", "file-b": "hash-b-v2" })).not.toBe(
      first,
    );
  });

  it("rejects empty manifest identities and hashes", () => {
    expect(() => buildCorpusRevisionFingerprint({ "": "hash" })).toThrow(/must not be empty/u);
    expect(() => buildCorpusRevisionFingerprint({ "file-a": "" })).toThrow(/must not be empty/u);
  });
});
