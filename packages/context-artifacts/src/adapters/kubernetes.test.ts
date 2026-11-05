import { assertGoldenJson } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { artifactConfig, inputFile, projectChunk } from "../test-helpers.js";

import { createKubernetesAdapter } from "./kubernetes.js";

const MANIFEST_FIXTURE = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: web
          image: web:latest
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
    - port: 80
`;

// A tab character in the second document's indentation makes it unparsable.
const PARTIALLY_BROKEN_FIXTURE =
  "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ok\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n\tname: broken\n";

describe("createKubernetesAdapter", () => {
  const adapter = createKubernetesAdapter();

  it("supports() matches yaml files, except Compose filenames, for auto-detection", () => {
    expect(adapter.supports("kubernetes", "anything")).toBe(true);
    expect(adapter.supports("auto", "k8s/deployment.yaml")).toBe(true);
    expect(adapter.supports("auto", "docker-compose.yaml")).toBe(false);
    expect(adapter.supports("auto", "k8s/notes.txt")).toBe(false);
  });

  it("golden: one chunk per '---'-separated document, apiVersion/kind/name retained in the title", async () => {
    const config = artifactConfig({
      name: "web-manifests",
      path: "k8s/web.yaml",
      type: "kubernetes",
    });
    const [document] = await adapter.read({
      config,
      files: [inputFile("k8s/web.yaml", MANIFEST_FIXTURE)],
    });
    expect(document!.type).toBe("kubernetes");

    const chunks = adapter.chunk(document!);
    expect(chunks.map((c) => c.kind)).toEqual(["kubernetes_resource", "kubernetes_resource"]);
    expect(chunks.map((c) => c.title)).toEqual(["apps/v1/Deployment web", "v1/Service web"]);

    assertGoldenJson("web-manifests-resources", chunks.map(projectChunk), {
      metaUrl: import.meta.url,
    });
  });

  it("one malformed document degrades visibly without discarding the rest of the file", async () => {
    const config = artifactConfig({
      name: "partial",
      path: "k8s/partial.yaml",
      type: "kubernetes",
    });
    const [document] = await adapter.read({
      config,
      files: [inputFile("k8s/partial.yaml", PARTIALLY_BROKEN_FIXTURE)],
    });
    expect(() => adapter.chunk(document!)).not.toThrow();

    const chunks = adapter.chunk(document!);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.kind).toBe("kubernetes_resource");
    expect(chunks[0]!.title).toBe("v1/ConfigMap ok");
    expect(chunks[1]!.kind).toBe("kubernetes_resource_parse_error");
    expect(chunks[1]!.title).toContain("parse error");
    expect(chunks[1]!.content).toContain("broken");
  });
});
