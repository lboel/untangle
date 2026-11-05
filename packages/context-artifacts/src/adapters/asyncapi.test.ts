import { assertGoldenJson } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { artifactConfig, inputFile, projectChunk } from "../test-helpers.js";

import { createAsyncApiAdapter } from "./asyncapi.js";

const ASYNCAPI_FIXTURE = `asyncapi: 2.6.0
info:
  title: Orders Events
  version: "1.0.0"
channels:
  order.created:
    subscribe:
      operationId: onOrderCreated
      summary: Emitted when a new order is placed
  order.cancelled:
    publish:
      operationId: publishOrderCancelled
`;

describe("createAsyncApiAdapter", () => {
  const adapter = createAsyncApiAdapter();

  it("supports() matches by explicit type and filename hint", () => {
    expect(adapter.supports("asyncapi", "anything.yaml")).toBe(true);
    expect(adapter.supports("auto", "events/asyncapi.yaml")).toBe(true);
    expect(adapter.supports("auto", "events/random.yaml")).toBe(false);
  });

  it("golden: one section per channel operation, operationId retained", async () => {
    const config = artifactConfig({
      name: "orders-events",
      path: "events/asyncapi.yaml",
      type: "asyncapi",
    });
    const [document] = await adapter.read({
      config,
      files: [inputFile("events/asyncapi.yaml", ASYNCAPI_FIXTURE)],
    });
    expect(document!.type).toBe("asyncapi");

    const chunks = adapter.chunk(document!);
    expect(chunks.map((c) => c.kind)).toEqual(["asyncapi_operation", "asyncapi_operation"]);
    expect(chunks.map((c) => c.title)).toEqual([
      "order.created subscribe (onOrderCreated)",
      "order.cancelled publish (publishOrderCancelled)",
    ]);

    assertGoldenJson("orders-events-operations", chunks.map(projectChunk), {
      metaUrl: import.meta.url,
    });
  });

  it("links(): operationId produces a heuristic guess", async () => {
    const config = artifactConfig({
      name: "orders-events",
      path: "events/asyncapi.yaml",
      type: "asyncapi",
    });
    const [document] = await adapter.read({
      config,
      files: [inputFile("events/asyncapi.yaml", ASYNCAPI_FIXTURE)],
    });
    const links = adapter.links!(document!);
    expect(links.map((l) => l.targetName)).toEqual(["onOrderCreated", "publishOrderCancelled"]);
    expect(links.every((l) => l.heuristic)).toBe(true);
  });
});
