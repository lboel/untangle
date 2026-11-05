import { describe, expect, it } from "vitest";

import { BufferIo } from "../../cli/io.js";
import { run } from "../../index.js";

import { MAX_FLOW_DEPTH, MAX_FLOW_EDGES, MAX_FLOW_NODES, MAX_FLOW_RESULT_LIMIT } from "./limits.js";

async function invoke(argv: readonly string[]): Promise<{ code: number; io: BufferIo }> {
  const io = new BufferIo();
  const code = await run(argv, {
    io,
    cwd: process.cwd(),
    env: {},
    signal: new AbortController().signal,
  });
  return { code, io };
}

describe("untangle flow resource limits", () => {
  it.each([
    ["depth", MAX_FLOW_DEPTH + 1],
    ["limit", MAX_FLOW_RESULT_LIMIT + 1],
    ["max-nodes", MAX_FLOW_NODES + 1],
    ["max-edges", MAX_FLOW_EDGES + 1],
  ])("rejects --%s above its hard cap before reading storage", async (flag, value) => {
    const { code, io } = await invoke(["flow", "main", `--${flag}=${String(value)}`]);

    expect(code).toBe(2);
    expect(io.outText).toBe("");
    expect(io.errText).toContain(`--${flag}`);
    expect(io.errText).toContain("requires 1 to");
  });
});
