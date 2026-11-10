import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DefaultUntangleMcpRuntime } from "./default-runtime.js";
import type { McpInvocationContext, UntangleMcpToolName } from "./types.js";

const UNREACHABLE_ENV = {
  UNTANGLE_STORAGE_BACKEND: "qdrant",
  UNTANGLE_QDRANT_MODE: "external",
  UNTANGLE_QDRANT_URL: "http://127.0.0.1:9",
};

function invocationContext(signal: AbortSignal): McpInvocationContext {
  return {
    cwd: process.cwd(),
    env: UNREACHABLE_ENV,
    signal,
  };
}

async function expectMidFlightCancellation(
  operation: UntangleMcpToolName,
  input: Readonly<Record<string, unknown>>,
): Promise<void> {
  const controller = new AbortController();
  const pending = new DefaultUntangleMcpRuntime().invoke(
    operation,
    input,
    invocationContext(controller.signal),
  );
  // `invoke` has already entered the real command and reached its first
  // asynchronous boundary. This is deliberately not the pre-aborted case
  // covered by the MCP server boundary tests.
  controller.abort("client supplied cancellation reason");
  await expect(pending).resolves.toMatchObject({
    schemaVersion: 1,
    ok: false,
    operation,
    error: { code: "CANCELLED", retryable: false },
  });
}

describe("DefaultUntangleMcpRuntime integration boundaries", () => {
  it("persists an explicitly started redacted search session across runtime instances", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "untangle-mcp-search-session-"));
    try {
      const context: McpInvocationContext = {
        cwd: root,
        env: {},
        signal: new AbortController().signal,
      };
      const goal = "Improve the private profile-card rendering";
      const featureId = "profile.cards.presentation";
      const started = await new DefaultUntangleMcpRuntime().invoke(
        "untangle_search_session",
        { action: "start", root, goal, featureId },
        context,
      );
      expect(started).toMatchObject({
        ok: true,
        operation: "untangle_search_session",
        data: {
          action: "start",
          session: {
            status: "active",
            retainText: false,
            feature: { fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u) },
            attempts: [],
          },
        },
      });
      const sessionId = (started.data as { session: { sessionId: string } } | undefined)?.session
        .sessionId;
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/u);
      const disk = await readFile(
        path.join(root, ".untangle", "product-complexity", "sessions", `${String(sessionId)}.json`),
        "utf8",
      );
      expect(disk).not.toContain(goal);
      expect(disk).not.toContain(featureId);

      const loaded = await new DefaultUntangleMcpRuntime().invoke(
        "untangle_search_session",
        { action: "get", root, sessionId },
        context,
      );
      expect(loaded).toMatchObject({
        ok: true,
        data: { action: "get", session: { sessionId, status: "active" } },
      });

      const report = await new DefaultUntangleMcpRuntime().invoke(
        "untangle_search_session",
        { action: "report", root },
        context,
      );
      expect(report).toMatchObject({
        ok: true,
        data: {
          action: "report",
          report: { sessionCounts: { total: 1, active: 1, completed: 0, abandoned: 0 } },
        },
      });

      const fingerprintKey = await readFile(
        path.join(root, ".untangle", "product-complexity", "fingerprint.key"),
        "utf8",
      );
      expect(fingerprintKey).toMatch(/^[0-9a-f]{64}$/u);
      expect(fingerprintKey).not.toContain(goal);

      const second = await new DefaultUntangleMcpRuntime().invoke(
        "untangle_search_session",
        { action: "start", root, goal, featureId },
        context,
      );
      expect(
        (second.data as { session?: { goal?: { fingerprint?: string } } } | undefined)?.session
          ?.goal?.fingerprint,
      ).toBe(
        (started.data as { session?: { goal?: { fingerprint?: string } } } | undefined)?.session
          ?.goal?.fingerprint,
      );

      const secondFeatureFingerprint = (
        second.data as { session?: { feature?: { fingerprint?: string } } } | undefined
      )?.session?.feature?.fingerprint;
      const firstFeatureFingerprint = (
        started.data as { session?: { feature?: { fingerprint?: string } } } | undefined
      )?.session?.feature?.fingerprint;
      expect(secondFeatureFingerprint).toBe(firstFeatureFingerprint);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps a mid-flight complexity abort to CANCELLED instead of a partial success", async () => {
    await expectMidFlightCancellation("untangle_complexity", { root: process.cwd() });
  });

  it("maps a mid-flight health abort to CANCELLED instead of failed checks in a success", async () => {
    await expectMidFlightCancellation("untangle_health", {
      root: process.cwd(),
      skipEmbeddings: true,
      timeoutMs: 10_000,
    });
  });

  it("maps a mid-flight search probe abort to CANCELLED instead of ENVIRONMENT_UNAVAILABLE", async () => {
    await expectMidFlightCancellation("untangle_search", {
      root: process.cwd(),
      query: "createUntangle",
    });
  });

  it("resolves an asynchronous graph-loading failure as a domain envelope", async () => {
    const result = await new DefaultUntangleMcpRuntime().invoke(
      "untangle_symbols",
      {},
      invocationContext(new AbortController().signal),
    );
    expect(result).toMatchObject({
      schemaVersion: 1,
      ok: false,
      operation: "untangle_symbols",
      error: { code: "ENVIRONMENT_UNAVAILABLE", retryable: true },
    });
  });
});
