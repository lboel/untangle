import { describe, expect, it } from "vitest";

import { BufferIo } from "../cli/io.js";
import { run } from "../index.js";

describe("mcp command", () => {
  it("requires the explicit stdio transport", async () => {
    const io = new BufferIo();
    const code = await run(["mcp"], { io });
    expect(code).toBe(2);
    expect(io.outText).toBe("");
    expect(io.errText).toContain("requires --stdio");
  });

  it("rejects positional arguments before starting a transport", async () => {
    const io = new BufferIo();
    const code = await run(["mcp", "--stdio", "extra"], { io });
    expect(code).toBe(2);
    expect(io.outText).toBe("");
    expect(io.errText).toContain("does not accept positional arguments");
  });

  it("documents stdout isolation and honest unavailable tools", async () => {
    const io = new BufferIo();
    const code = await run(["mcp", "--help"], { io });
    expect(code).toBe(0);
    expect(io.outText).toContain("FEATURE_UNAVAILABLE");
    expect(io.outText).toContain("stdout is reserved exclusively");
    expect(io.errText).toBe("");
  });
});
