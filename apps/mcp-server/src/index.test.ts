import { createUntangleMcpServer as createFromCli } from "@untangle-code/cli/mcp";
import { describe, expect, it } from "vitest";

import { createUntangleMcpServer as createFromWrapper } from "./index.js";

describe("private MCP compatibility wrapper", () => {
  it("re-exports the public CLI runtime instead of owning a second implementation", () => {
    expect(createFromWrapper).toBe(createFromCli);
  });
});
