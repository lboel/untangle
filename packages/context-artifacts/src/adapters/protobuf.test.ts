import { assertGoldenJson } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import type { ArtifactSkipLedgerEntry } from "../coverage.js";
import { buildArtifactSkipLedger } from "../coverage.js";
import { artifactConfig, inputFile, projectChunk } from "../test-helpers.js";

import { createProtobufAdapter } from "./protobuf.js";

const PROTO_FIXTURE = `syntax = "proto3";

package orders.v1;

message Order {
  string id = 1;
  string customer_id = 2;
  int64 total_cents = 3;
}

message OrderItem {
  string sku = 1;
  int32 qty = 2;
}

service OrderService {
  rpc GetOrder(GetOrderRequest) returns (Order);
  rpc CreateOrder(CreateOrderRequest)
      returns (Order);
}
`;

describe("createProtobufAdapter", () => {
  const adapter = createProtobufAdapter();

  it("supports() matches by extension and explicit type", () => {
    expect(adapter.supports("protobuf", "anything")).toBe(true);
    expect(adapter.supports("auto", "proto/orders.proto")).toBe(true);
    expect(adapter.supports("auto", "proto/orders.txt")).toBe(false);
  });

  it("golden: messages, services and RPCs as separate sections (RPC ranges nest inside their service)", async () => {
    const config = artifactConfig({
      name: "orders-proto",
      path: "proto/orders.proto",
      type: "protobuf",
    });
    const [document] = await adapter.read({
      config,
      files: [inputFile("proto/orders.proto", PROTO_FIXTURE)],
    });
    expect(document!.type).toBe("protobuf");

    const chunks = adapter.chunk(document!);
    expect(chunks.map((c) => c.kind)).toEqual([
      "protobuf_message",
      "protobuf_message",
      "protobuf_service",
      "protobuf_rpc",
      "protobuf_rpc",
    ]);
    expect(chunks.map((c) => c.title)).toEqual([
      "Order",
      "OrderItem",
      "OrderService",
      "OrderService.GetOrder",
      "OrderService.CreateOrder",
    ]);
    // The multi-line "CreateOrder" RPC signature must be captured fully, not truncated at its first line.
    const createOrderRpc = chunks.find((c) => c.title === "OrderService.CreateOrder")!;
    expect(createOrderRpc.content).toContain("returns (Order);");
    // RPC ranges are intentionally nested inside (not after) their service's range.
    const service = chunks.find((c) => c.kind === "protobuf_service")!;
    expect(createOrderRpc.range.startLine).toBeGreaterThan(service.range.startLine);
    expect(createOrderRpc.range.endLine).toBeLessThanOrEqual(service.range.endLine);

    assertGoldenJson("orders-proto-sections", chunks.map(projectChunk), {
      metaUrl: import.meta.url,
    });
  });

  // --- WP-81 review regression (reproduced verbatim against the built dist/ code) ---

  it("WP-81 case 3: a brace inside a string default value does not desync the depth counter", async () => {
    const content = [
      'syntax = "proto3";',
      "",
      "message Foo {",
      '  string bar = 1 [default = "{"];',
      "}",
      "",
      "service Svc {",
      "  rpc Do(Foo) returns (Foo);",
      "}",
      "",
    ].join("\n");
    const config = artifactConfig({
      name: "brace-in-string",
      path: "proto/x.proto",
      type: "protobuf",
    });
    const [document] = await adapter.read({ config, files: [inputFile("proto/x.proto", content)] });

    const chunks = adapter.chunk(document!);
    // Before the fix, the unbalanced `{` inside the string default value
    // desynced the naive brace counter permanently: `message Foo` never
    // saw depth return to 0 and degraded to "runs to EOF", swallowing the
    // entire `service Svc` block (and its `rpc`) as unclassified content
    // inside the message's own chunk instead of getting its own section.
    expect(chunks.map((c) => c.kind)).toEqual([
      "protobuf_message",
      "protobuf_service",
      "protobuf_rpc",
    ]);
    expect(chunks.map((c) => c.title)).toEqual(["Foo", "Svc", "Svc.Do"]);
    const message = chunks.find((c) => c.kind === "protobuf_message")!;
    expect(message.content).not.toContain("service Svc");
  });

  it("links(): a service produces heuristic guesses at generated server symbols", async () => {
    const config = artifactConfig({
      name: "orders-proto",
      path: "proto/orders.proto",
      type: "protobuf",
    });
    const [document] = await adapter.read({
      config,
      files: [inputFile("proto/orders.proto", PROTO_FIXTURE)],
    });
    const links = adapter.links!(document!);
    expect(links.map((l) => l.targetName).sort()).toEqual([
      "OrderServiceImpl",
      "OrderServiceServer",
    ]);
    expect(links.every((l) => l.heuristic && l.confidence > 0 && l.confidence < 1)).toBe(true);
  });
  // --- WP-118: dieselbe Blindstelle wie im SQL-Adapter ---

  it("WP-118: ein rpc mit Optionsrumpf endet an seiner schliessenden Klammer, nicht am ersten `;` darin", async () => {
    const content = [
      "service S {",
      "  rpc A(X) returns (Y) {",
      "    option deadline = 1;",
      "  }",
      "}",
      "",
    ].join("\n");
    const findings: ArtifactSkipLedgerEntry[] = [];
    const scoped = createProtobufAdapter({
      onSkipLedgerGap: (entries) => findings.push(...entries),
    });
    const config = artifactConfig({ name: "svc", path: "proto/s.proto", type: "protobuf" });
    const [document] = await scoped.read({ config, files: [inputFile("proto/s.proto", content)] });

    const chunks = scoped.chunk(document!);
    const rpc = chunks.find((c) => c.kind === "protobuf_rpc")!;
    expect(rpc.content).toContain("}");
    expect(findings).toEqual([]);
  });

  it("WP-118: ein unabgeschlossener Service wird als unplausibles Fragment gemeldet, nicht still bis EOF gedehnt", async () => {
    const content = "service S {\n  rpc A(X) returns (Y);\n";
    const findings: ArtifactSkipLedgerEntry[] = [];
    const scoped = createProtobufAdapter({
      onSkipLedgerGap: (entries) => findings.push(...entries),
    });
    const config = artifactConfig({ name: "svc", path: "proto/s.proto", type: "protobuf" });
    const [document] = await scoped.read({ config, files: [inputFile("proto/s.proto", content)] });

    const chunks = scoped.chunk(document!);
    // Byte-Abdeckung lueckenlos (der Service-Chunk deckt alles ab), kein
    // leerer/ueberlappender Chunk: die alte Mechanik sieht nichts.
    expect(
      buildArtifactSkipLedger(document!, chunks).filter(
        (e) => e.reason !== "whitespace_or_comment",
      ),
    ).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.reason).toBe("implausible_fragment");
    expect(findings[0]!.contentPreview).toContain('unclosed bracket "{"');
  });
});
