import { assertGoldenJson } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { artifactConfig, inputFile, projectChunk } from "../test-helpers.js";

import { createDockerAdapter } from "./docker.js";

const DOCKERFILE_FIXTURE = `FROM node:22-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]
`;

const COMPOSE_FIXTURE = `services:
  api:
    build: .
    ports:
      - "3000:3000"
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: secret
`;

describe("createDockerAdapter", () => {
  const adapter = createDockerAdapter();

  it("supports() matches Dockerfile and Compose filenames for auto-detection only", () => {
    expect(adapter.supports("auto", "Dockerfile")).toBe(true);
    expect(adapter.supports("auto", "docker/Dockerfile.prod")).toBe(true);
    expect(adapter.supports("auto", "docker-compose.yaml")).toBe(true);
    expect(adapter.supports("auto", "compose.yml")).toBe(true);
    expect(adapter.supports("markdown", "Dockerfile")).toBe(false);
    expect(adapter.supports("auto", "src/index.ts")).toBe(false);
  });

  it("golden: Dockerfile build stages as separate sections", async () => {
    const config = artifactConfig({ name: "app-image", path: "Dockerfile" });
    const [document] = await adapter.read({
      config,
      files: [inputFile("Dockerfile", DOCKERFILE_FIXTURE)],
    });
    expect(document!.type).toBe("text");
    expect(document!.language).toBe("dockerfile");

    const chunks = adapter.chunk(document!);
    expect(chunks.map((c) => c.kind)).toEqual(["docker_stage", "docker_stage"]);
    expect(chunks.map((c) => c.title)).toEqual(["build", "stage 1 (node:22-slim)"]);

    assertGoldenJson("app-image-stages", chunks.map(projectChunk), { metaUrl: import.meta.url });
  });

  // --- FEHLERKLASSE finding (same defect class as WP-81's SQL/Protobuf
  // cases: a separator-looking token inside a "quoted" region must not be
  // mistaken for a real one): a heredoc body can contain a line that reads
  // exactly like a new build stage. ---
  it("a 'FROM' line inside a RUN heredoc body is not mistaken for a new build stage", async () => {
    const content = `FROM node:22-slim AS build
WORKDIR /app
RUN <<EOF
echo "generating a throwaway Dockerfile fragment"
FROM scratch
EOF
COPY . .

FROM node:22-slim
CMD ["node", "dist/index.js"]
`;
    const config = artifactConfig({ name: "app-heredoc", path: "Dockerfile" });
    const [document] = await adapter.read({ config, files: [inputFile("Dockerfile", content)] });
    const chunks = adapter.chunk(document!);
    // Before the fix: the "FROM scratch" line inside the heredoc body was
    // read as a real stage boundary, splitting the "build" stage in two and
    // producing three stages instead of two.
    expect(chunks.map((c) => c.kind)).toEqual(["docker_stage", "docker_stage"]);
    expect(chunks.map((c) => c.title)).toEqual(["build", "stage 1 (node:22-slim)"]);
    expect(chunks[0]!.content).toContain("FROM scratch");
    expect(chunks[0]!.content).toContain("COPY . .");
  });

  it("golden: Compose services as separate sections", async () => {
    const config = artifactConfig({ name: "app-compose", path: "docker-compose.yaml" });
    const [document] = await adapter.read({
      config,
      files: [inputFile("docker-compose.yaml", COMPOSE_FIXTURE)],
    });
    expect(document!.type).toBe("text");
    expect(document!.language).toBe("docker-compose");

    const chunks = adapter.chunk(document!);
    expect(chunks.map((c) => c.kind)).toEqual(["compose_service", "compose_service"]);
    expect(chunks.map((c) => c.title)).toEqual(["api", "db"]);

    assertGoldenJson("app-compose-services", chunks.map(projectChunk), {
      metaUrl: import.meta.url,
    });
  });
});
