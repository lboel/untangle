import { DEFAULT_TRAVERSAL_LIMITS } from "@untangle-code/file-graph";
import { describe, expect, it } from "vitest";

import { BufferIo } from "../../cli/io.js";
import { run } from "../../index.js";
import { MAX_GRAPH_QUERY_EDGES } from "../flow/limits.js";

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

describe("untangle graph visualize", () => {
  it("requires an explicit output target before touching storage", async () => {
    const { code, io } = await invoke(["graph", "visualize"]);

    expect(code).toBe(2);
    expect(io.outText).toBe("");
    expect(io.errText).toContain("explicit --out target");
  });

  it("validates explorer options before touching storage", async () => {
    const invalidLayout = await invoke([
      "graph",
      "visualize",
      "--out=graph.html",
      "--layout=random",
    ]);
    const invalidBudget = await invoke(["graph", "visualize", "--out=graph.html", "--max-edges=0"]);

    expect(invalidLayout.code).toBe(2);
    expect(invalidLayout.io.errText).toContain('value "random"');
    expect(invalidBudget.code).toBe(2);
    expect(invalidBudget.io.errText).toContain("requires 1 to");
  });

  it("rejects mode-specific flags instead of silently ignoring them", async () => {
    const visualization = await invoke(["graph", "visualize", "--out=graph.html", "--depth=2"]);
    const query = await invoke(["graph", "src/index.ts", "--out=graph.html"]);

    expect(visualization.code).toBe(2);
    expect(visualization.io.errText).toContain("--depth");
    expect(query.code).toBe(2);
    expect(query.io.errText).toContain("--out");
  });

  it("keeps file-query edge budgets separate from explorer budgets", async () => {
    expect(MAX_GRAPH_QUERY_EDGES).toBe(DEFAULT_TRAVERSAL_LIMITS.maxEdges);

    const zero = await invoke(["graph", "src/index.ts", "--max-edges=0"]);
    const aboveQueryCeiling = await invoke([
      "graph",
      "src/index.ts",
      `--max-edges=${String(MAX_GRAPH_QUERY_EDGES + 1)}`,
    ]);
    const overview = await invoke(["graph", "--max-edges=1"]);

    expect(zero.code).toBe(2);
    expect(zero.io.errText).toContain(`1 to ${String(MAX_GRAPH_QUERY_EDGES)}`);
    expect(aboveQueryCeiling.code).toBe(2);
    expect(aboveQueryCeiling.io.errText).toContain(`1 to ${String(MAX_GRAPH_QUERY_EDGES)}`);
    expect(overview.code).toBe(2);
    expect(overview.io.errText).toContain("graph <file>");
  });

  it("documents the offline, source-free artifact and explicit target", async () => {
    const { code, io } = await invoke(["graph", "--help"]);

    expect(code).toBe(0);
    expect(io.outText).toContain("graph visualize --out=<FILE>");
    expect(io.outText).toMatch(/no\s+source\s+text/u);
    expect(io.outText).toMatch(/no\s+source\s+text\s+or\s+network\s+requests/u);
    expect(io.errText).toBe("");
  });
});
