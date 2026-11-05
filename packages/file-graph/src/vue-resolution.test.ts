import { describe, expect, it } from "vitest";

import { buildMiniWorkspace } from "./test-support/workspace.js";

describe("Vue file dependency resolution", () => {
  it("connects a script component import without an extension to its actual Vue source", async () => {
    const { graph } = await buildMiniWorkspace({
      "src/main.ts": 'import Orders from "./Orders"; export const component = Orders;\n',
      "src/Orders.vue":
        '<template><p>Orders</p></template><script setup lang="ts">const ready = true;</script>\n',
    });
    expect(graph.edges().find((edge) => edge.fromPath === "src/main.ts")?.resolution).toMatchObject(
      { status: "resolved", targetPath: "src/Orders.vue" },
    );
  });

  it("preserves existing TypeScript precedence when both source candidates exist", async () => {
    const { graph } = await buildMiniWorkspace({
      "src/main.ts": 'import Orders from "./Orders"; export const component = Orders;\n',
      "src/Orders.ts": "export default function Orders() { return true; }\n",
      "src/Orders.vue": "<script setup>const ready = true;</script>\n",
    });
    expect(graph.edges().find((edge) => edge.fromPath === "src/main.ts")?.resolution).toMatchObject(
      { status: "resolved", targetPath: "src/Orders.ts" },
    );
  });
});
