import { assertGoldenJson } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { artifactConfig, inputFile, projectChunk } from "../test-helpers.js";

import { createOpenApiAdapter } from "./openapi.js";

const OPENAPI_FIXTURE = `openapi: 3.0.3
info:
  title: Users API
  version: "1.0.0"
paths:
  /users:
    get:
      operationId: listUsers
      summary: List users
      responses:
        "200":
          description: OK
    post:
      operationId: createUser
      summary: Create a user
      responses:
        "201":
          description: Created
  /users/{id}:
    get:
      operationId: getUserById
      summary: Get a single user
      responses:
        "200":
          description: OK
`;

// A tab character in indentation is invalid YAML and this parser rejects it explicitly.
const BROKEN_FIXTURE = "openapi: 3.0.3\npaths:\n  /users:\n\tget:\n      operationId: listUsers\n";

describe("createOpenApiAdapter", () => {
  const adapter = createOpenApiAdapter();

  it("supports() matches by explicit type and filename hint", () => {
    expect(adapter.supports("openapi", "anything.yaml")).toBe(true);
    expect(adapter.supports("auto", "api/openapi.yaml")).toBe(true);
    expect(adapter.supports("auto", "api/random.yaml")).toBe(false);
  });

  it("golden: one section per operation, operationId retained in the title", async () => {
    const config = artifactConfig({ name: "users-api", path: "api/openapi.yaml", type: "openapi" });
    const [document] = await adapter.read({
      config,
      files: [inputFile("api/openapi.yaml", OPENAPI_FIXTURE)],
    });
    expect(document!.type).toBe("openapi");

    const chunks = adapter.chunk(document!);
    expect(chunks.map((c) => c.kind)).toEqual([
      "openapi_info",
      "openapi_operation",
      "openapi_operation",
      "openapi_operation",
    ]);
    expect(chunks.map((c) => c.title)).toEqual([
      "info: Users API",
      "GET /users (listUsers)",
      "POST /users (createUser)",
      "GET /users/{id} (getUserById)",
    ]);
    // operationId is preserved verbatim in the raw content too (spec.md §19.2), not just the title.
    expect(chunks[1]!.content).toContain("operationId: listUsers");

    assertGoldenJson("users-api-operations", chunks.map(projectChunk), {
      metaUrl: import.meta.url,
    });
  });

  it("links(): operationId produces a heuristic guess at a same-named controller symbol", async () => {
    const config = artifactConfig({ name: "users-api", path: "api/openapi.yaml", type: "openapi" });
    const [document] = await adapter.read({
      config,
      files: [inputFile("api/openapi.yaml", OPENAPI_FIXTURE)],
    });
    const links = adapter.links!(document!);
    const link = links.find((l) => l.targetName === "getUserById");
    expect(link).toBeDefined();
    expect(link!.heuristic).toBe(true);
    expect(link!.confidence).toBeCloseTo(0.5);
    expect(link!.targetId).toBeUndefined();
  });

  it("degrades visibly on malformed YAML instead of throwing", async () => {
    const config = artifactConfig({
      name: "broken-api",
      path: "api/openapi.yaml",
      type: "openapi",
    });
    const [document] = await adapter.read({
      config,
      files: [inputFile("api/openapi.yaml", BROKEN_FIXTURE)],
    });
    expect(() => adapter.chunk(document!)).not.toThrow();
    const chunks = adapter.chunk(document!);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.kind).toBe("openapi_parse_error");
    expect(chunks[0]!.title).toContain("parse error");
    // Full raw content is preserved even in the degraded case (spec.md §19.2 / rule 4).
    expect(chunks[0]!.content).toBe(BROKEN_FIXTURE);
  });
});
