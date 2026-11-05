import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vitest";

import { serveUntangleMcpStdio } from "./stdio.js";
import { UNTANGLE_MCP_TOOL_NAMES } from "./types.js";

const APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BINARY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

describe("untangle mcp --stdio", () => {
  it("settles the lifecycle when the wire cannot start", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new StdioServerTransport(input, output);
    transport.start = async () => {
      throw new Error("injected start failure");
    };
    const handle = serveUntangleMcpStdio({ transport });
    await expect(handle.closed).resolves.toMatchObject({
      reason: "error",
      error: { message: "injected start failure" },
    });
    await handle.close();
    input.destroy();
    output.destroy();
  });

  it("settles the lifecycle as an error when a fatal wire overflow closes the transport", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errors: Error[] = [];
    const handle = serveUntangleMcpStdio({
      transport: new StdioServerTransport(input, output, { maxBufferSize: 16 }),
      onerror: (error) => errors.push(error),
    });
    input.write("x".repeat(64));

    const outcome = await Promise.race([
      handle.closed,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("stdio lifecycle did not settle")), 1_000),
      ),
    ]);
    expect(outcome.reason).toBe("error");
    expect(errors.length).toBeGreaterThan(0);
    await handle.close();
    input.destroy();
    output.destroy();
  });

  it("keeps the lifecycle open after a recoverable out-of-order JSON-RPC message", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errors: Error[] = [];
    const handle = serveUntangleMcpStdio({
      transport: new StdioServerTransport(input, output),
      onerror: (error) => errors.push(error),
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const closedEarly = await Promise.race([
      handle.closed.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(closedEarly).toBe(false);
    await handle.close();
    await expect(handle.closed).resolves.toEqual({ reason: "closed" });
    input.destroy();
    output.destroy();
  });

  it.each(["legacy", "modern"] as const)(
    "serves the real built binary to a %s protocol client",
    async (era) => {
      expect(existsSync(BINARY), "Build apps/cli before running the stdio contract test.").toBe(
        true,
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [BINARY, "mcp", "--stdio"],
        cwd: APP_ROOT,
        stderr: "pipe",
      });
      let stderr = "";
      transport.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const client = new Client(
        { name: `${era}-stdio-test`, version: "1.0.0" },
        era === "modern"
          ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
          : { versionNegotiation: { mode: "legacy" } },
      );

      try {
        await client.connect(transport);
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toEqual(UNTANGLE_MCP_TOOL_NAMES);
        const result = await client.callTool({ name: "untangle_about", arguments: {} });
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toMatchObject({
          schemaVersion: 1,
          ok: true,
          operation: "untangle_about",
        });
      } finally {
        await client.close();
      }
      expect(stderr).toBe("");
    },
    15_000,
  );
});
