import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  RANKER_VERSION,
  type SearchJourneyV1,
  type SearchResultSetV1,
} from "@untangle-code/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EnvironmentError } from "../cli/exit.js";
import { doctorCommand } from "../commands/doctor.js";
import { queryCommand } from "../commands/query.js";

import { DefaultUntangleMcpRuntime } from "./default-runtime.js";
import { UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS } from "./output-schemas.js";
import type { McpInvocationContext } from "./types.js";

function partialResult(workspaceId = "workspace"): SearchResultSetV1 {
  return {
    schemaVersion: 1,
    queryFingerprint: "a".repeat(64),
    rankingContextFingerprint: "b".repeat(64),
    query: {
      schemaVersion: 1,
      text: "charge",
      workspaceId,
      filters: {
        repoIds: [],
        refIds: [],
        languages: [],
        pathGlobs: [],
        symbolNames: [],
        symbolKinds: [],
        chunkKinds: [],
      },
      limit: 10,
      candidateLimit: 20,
      diversify: false,
      includeGraphContext: false,
      includeLinked: false,
      includeContent: false,
      rankerVersion: RANKER_VERSION,
    },
    groups: [
      {
        embeddingProfileId: "profile",
        repoIds: ["repo"],
        rankNormalized: false,
        caveats: ["dense branch unavailable"],
        hits: [
          {
            schemaVersion: 1,
            rank: 1,
            repoId: "repo",
            repoLabel: "Repository",
            refId: "ref",
            refName: "main",
            fileId: "file",
            filePath: "src/charge.ts",
            range: { startLine: 1, endLine: 1, startByte: 0, endByte: 8 },
            language: "typescript",
            parseQuality: "complete",
            chunkId: "charge",
            chunkKind: "symbol",
            symbolName: "charge",
            dedupeKey: "charge",
            relatedFragments: [],
            embeddingProfileId: "profile",
            indexGeneration: "generation",
            score: {
              schemaVersion: 1,
              final: 1 / 61,
              components: [
                { kind: "base_hybrid", rawValue: 1 / 61, weight: 1, contribution: 1 / 61 },
              ],
              inputs: { lexicalRank: 1, rrf: 1 / 61 },
              rankerVersion: RANKER_VERSION,
              clamped: false,
            },
          },
        ],
      },
    ],
    profileSeparation: false,
    totalHits: 1,
    warnings: [
      {
        code: "SEARCH_BRANCH_UNAVAILABLE",
        message: "dense retrieval failed because Ollama is offline",
        details: { branch: "dense", causeCode: "EMBEDDING_UNAVAILABLE" },
      },
    ],
    skipped: [
      {
        schemaVersion: 1,
        stage: "search",
        subjectKind: "search_candidate",
        subjectId: "profile:dense",
        reason: "provider_unavailable",
        detail: "dense retrieval failed because Ollama is offline",
        recoverable: true,
      },
    ],
  };
}

function context(cwd = process.cwd(), signal = new AbortController().signal): McpInvocationContext {
  return { cwd, env: {}, signal };
}

function emitPartial(output: unknown): void {
  vi.spyOn(queryCommand, "run").mockImplementation(async (ctx) => {
    ctx.io.out(`${JSON.stringify(output)}\n`);
    ctx.io.err("dense retrieval was unavailable\n");
    throw new EnvironmentError("Search retrieval is incomplete.", "Run untangle doctor.");
  });
}

afterEach(() => vi.restoreAllMocks());

describe("MCP partial search preservation", () => {
  it("preserves schema-validated fallback hits, branch warnings and the provider ledger in a failure", async () => {
    const output = partialResult();
    expect(UNTANGLE_MCP_SUCCESS_DATA_SCHEMAS.untangle_search.safeParse(output).success).toBe(true);
    emitPartial(output);
    const result = await new DefaultUntangleMcpRuntime().invoke(
      "untangle_search",
      { query: "charge" },
      context(),
    );
    expect(result).toMatchObject({
      ok: false,
      workspaceId: "workspace",
      error: {
        code: "ENVIRONMENT_UNAVAILABLE",
        retryable: true,
        details: { nextStep: "Run untangle doctor.", exitCode: 4, data: output },
      },
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: "SEARCH_BRANCH_UNAVAILABLE" }),
        expect.objectContaining({ code: "CLI_DIAGNOSTIC" }),
      ]),
    });
    expect(result.data).toBeUndefined();
  });

  it.each(["missing branch warning", "missing provider ledger", "invalid payload"])(
    "does not preserve %s",
    async (variant) => {
      const output = partialResult();
      if (variant === "missing branch warning") output.warnings = [];
      if (variant === "missing provider ledger") output.skipped = [];
      emitPartial(variant === "invalid payload" ? { ...output, totalHits: -1 } : output);
      const result = await new DefaultUntangleMcpRuntime().invoke(
        "untangle_search",
        { query: "charge" },
        context(),
      );
      expect(result.ok).toBe(false);
      expect(result.error?.details?.["data"]).toBeUndefined();
    },
  );

  it("does not replace a total failure without emitted JSON with an empty partial result", async () => {
    vi.spyOn(queryCommand, "run").mockRejectedValue(
      new EnvironmentError("No branch answered.", "Run untangle doctor."),
    );
    const result = await new DefaultUntangleMcpRuntime().invoke(
      "untangle_search",
      { query: "charge" },
      context(),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.details?.["data"]).toBeUndefined();
  });

  it("does not preserve emitted partial JSON after caller cancellation", async () => {
    const controller = new AbortController();
    vi.spyOn(queryCommand, "run").mockImplementation(async (ctx) => {
      ctx.io.out(JSON.stringify(partialResult()));
      controller.abort(new Error("caller cancelled"));
      throw new EnvironmentError("Search retrieval is incomplete.", "Run untangle doctor.");
    });
    const result = await new DefaultUntangleMcpRuntime().invoke(
      "untangle_search",
      { query: "charge" },
      context(process.cwd(), controller.signal),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(result.error?.details?.["data"]).toBeUndefined();
  });

  it("does not apply search preservation to another operation", async () => {
    vi.spyOn(doctorCommand, "run").mockImplementation(async (ctx) => {
      ctx.io.out(JSON.stringify(partialResult()));
      throw new EnvironmentError("Health unavailable.", "Try again.");
    });
    const result = await new DefaultUntangleMcpRuntime().invoke("untangle_health", {}, context());
    expect(result.ok).toBe(false);
    expect(result.error?.details?.["data"]).toBeUndefined();
  });

  it("records returned partial candidates as unhealthy search journey evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "untangle-mcp-partial-"));
    try {
      const runtime = new DefaultUntangleMcpRuntime();
      const started = await runtime.invoke(
        "untangle_search_session",
        { action: "start", root, goal: "Find charge" },
        context(root),
      );
      const session = (started.data as { session: SearchJourneyV1 }).session;
      emitPartial(partialResult(session.workspaceId));
      const result = await runtime.invoke(
        "untangle_search",
        { query: "charge", root, session: { id: session.sessionId } },
        context(root),
      );
      expect(result).toMatchObject({
        ok: false,
        error: { details: { data: { searchObservation: { status: "recorded" } } } },
      });
      const loaded = await runtime.invoke(
        "untangle_search_session",
        { action: "get", root, sessionId: session.sessionId },
        context(root),
      );
      const recorded = (loaded.data as { session: SearchJourneyV1 }).session;
      expect(recorded.attempts).toHaveLength(1);
      expect(recorded.attempts[0]).toMatchObject({ retrievalHealthy: false });
      expect(recorded.attempts[0]?.failureCode).toBeUndefined();
      expect(recorded.attempts[0]?.profiles[0]?.candidates[0]?.chunkId).toBe("charge");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
