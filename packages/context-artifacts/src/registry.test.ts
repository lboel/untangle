import { UntangleError } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { createArtifactAdapterRegistry } from "./registry.js";
import { artifactConfig, inputFile } from "./test-helpers.js";

describe("createArtifactAdapterRegistry", () => {
  it("an unknown/unrecognized format falls back to the safe text adapter, never throws", async () => {
    const registry = createArtifactAdapterRegistry();
    const config = artifactConfig({ name: "weird-format", path: "notes.xyz-unknown" });
    const [document] = await registry.read({
      config,
      files: [inputFile("notes.xyz-unknown", "hello\nworld\n")],
    });
    expect(document!.type).toBe("text");
    const chunks = registry.chunk(document!);
    expect(chunks[0]!.kind).toBe("text_window");
  });

  it("dispatches by explicit config.type regardless of the file's extension", async () => {
    const registry = createArtifactAdapterRegistry();
    const config = artifactConfig({ name: "renamed-sql", path: "schema.txt", type: "sql" });
    const [document] = await registry.read({
      config,
      files: [inputFile("schema.txt", "CREATE TABLE t (id INT);\n")],
    });
    expect(document!.type).toBe("sql");
    expect(registry.chunk(document!)[0]!.kind).toBe("sql_table");
  });

  it("auto-detection priority: openapi/asyncapi name-hint beats the generic Kubernetes yaml catch-all", async () => {
    const registry = createArtifactAdapterRegistry();
    const config = artifactConfig({ name: "spec", path: "api/openapi.yaml" });
    const [document] = await registry.read({
      config,
      files: [
        inputFile(
          "api/openapi.yaml",
          'openapi: 3.0.0\ninfo:\n  title: X\n  version: "1"\npaths: {}\n',
        ),
      ],
    });
    expect(document!.type).toBe("openapi");
  });

  it("auto-detection priority: Compose filenames beat the generic Kubernetes yaml catch-all", async () => {
    const registry = createArtifactAdapterRegistry();
    const config = artifactConfig({ name: "compose", path: "docker-compose.yaml" });
    const [document] = await registry.read({
      config,
      files: [inputFile("docker-compose.yaml", "services:\n  api:\n    image: x\n")],
    });
    expect(document!.type).toBe("text");
    expect(document!.language).toBe("docker-compose");
    expect(registry.chunk(document!)[0]!.kind).toBe("compose_service");
  });

  it("a plain .yaml file with no other hint auto-detects as Kubernetes", async () => {
    const registry = createArtifactAdapterRegistry();
    const config = artifactConfig({ name: "manifest", path: "k8s/pod.yaml" });
    const [document] = await registry.read({
      config,
      files: [inputFile("k8s/pod.yaml", "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n")],
    });
    expect(document!.type).toBe("kubernetes");
  });

  it("a heterogeneous directory routes each file to its own adapter under one artifact", async () => {
    const registry = createArtifactAdapterRegistry();
    const config = artifactConfig({ name: "mixed-docs", path: "docs/" });
    const documents = await registry.read({
      config,
      files: [
        inputFile("docs/readme.md", "# Title\n\nBody.\n"),
        inputFile("docs/schema.sql", "CREATE TABLE t (id INT);\n"),
      ],
    });
    const types = documents.map((d) => d.type).sort();
    expect(types).toEqual(["markdown", "sql"]);
  });

  it("links() falls back to an empty array for an adapter that declares none", async () => {
    const registry = createArtifactAdapterRegistry();
    const config = artifactConfig({ name: "readme", path: "README.md" });
    const [document] = await registry.read({
      config,
      files: [inputFile("README.md", "# Title\n")],
    });
    expect(registry.links!(document!)).toEqual([]);
  });

  it("read() aborts with JOB_CANCELLED when the signal is already aborted", async () => {
    const registry = createArtifactAdapterRegistry();
    const controller = new AbortController();
    controller.abort();
    const config = artifactConfig({ name: "aborted", path: "a.txt" });
    await expect(
      registry.read(
        { config, files: [inputFile("a.txt", "x"), inputFile("b.txt", "y")] },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "JOB_CANCELLED" });
    await expect(
      registry.read({ config, files: [inputFile("a.txt", "x")] }, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(UntangleError);
  });

  it("register() adds a custom adapter with priority just above the text fallback", async () => {
    const registry = createArtifactAdapterRegistry();
    registry.register({
      // Same convention `docker.ts` documents: since every non-"auto"
      // `ContextArtifactType` literal is already claimed by a built-in
      // adapter, a custom adapter's documents are typed "text" too, and
      // must recognize "text" (not just "auto") in `supports()` so the
      // registry's document→adapter `chunk()`/`links()` dispatch (which
      // calls `supports(document.type, document.path)`) can find it again.
      supports: (type, path) => (type === "auto" || type === "text") && path.endsWith(".custom"),
      read: async (input) =>
        input.files.map((file) => ({
          artifactName: input.config.name,
          type: "text" as const,
          path: file.path,
          contentHash: file.contentHash,
          content: file.content,
          language: "custom-format",
        })),
      chunk: (document) => [
        {
          chunkId: "custom-chunk",
          artifactName: document.artifactName,
          kind: "custom_section",
          range: {
            startLine: 1,
            endLine: 1,
            startByte: 0,
            endByte: Buffer.byteLength(document.content, "utf8"),
          },
          content: document.content,
          contentHash: document.contentHash,
        },
      ],
    });
    const config = artifactConfig({ name: "custom", path: "thing.custom" });
    const [document] = await registry.read({ config, files: [inputFile("thing.custom", "hi")] });
    expect(document!.language).toBe("custom-format");
    expect(registry.chunk(document!)[0]!.kind).toBe("custom_section");
  });
});
