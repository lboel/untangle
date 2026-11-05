import { describe, expect, it } from "vitest";

import { parseComposeFile } from "./compose.js";
import { parseJsonc, stripJsonComments } from "./jsonc.js";
import { declaredRangeOf, isWorkspaceProtocol, parseManifest } from "./manifest.js";
import { resolveProjectConfig } from "./project-config.js";
import {
  globToRegExp,
  matchesGlobSelection,
  parsePnpmWorkspace,
  splitGlobs,
} from "./workspace-definition.js";

describe("stripJsonComments", () => {
  it("entfernt Zeilen- und Blockkommentare sowie abschliessende Kommata", () => {
    const text = `{
      // a line comment
      "a": 1, /* block */
      "b": [1, 2,],
    }`;
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 1, b: [1, 2] });
  });

  it("laesst kommentaraehnliche Zeichen INNERHALB eines Strings unangetastet", () => {
    const text = '{"url": "http://example.org/a", "glob": "a/*/b"}';
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      url: "http://example.org/a",
      glob: "a/*/b",
    });
  });

  it("meldet einen Lesefehler als Wert statt zu werfen (E4)", () => {
    const result = parseJsonc("{ not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });
});

describe("parseManifest", () => {
  it("liest Name, Version, exports und alle Abhaengigkeitsbloecke", () => {
    const result = parseManifest(
      JSON.stringify({
        name: "@x/y",
        version: "1.2.3",
        exports: { ".": "./dist/index.js" },
        dependencies: { a: "workspace:*" },
        devDependencies: { b: "^1.0.0" },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.name).toBe("@x/y");
    expect(result.manifest.dependencies.dependencies["a"]).toBe("workspace:*");
    expect(declaredRangeOf(result.manifest, "b")).toEqual({
      field: "devDependencies",
      range: "^1.0.0",
    });
    expect(isWorkspaceProtocol("workspace:*")).toBe(true);
    expect(isWorkspaceProtocol("^1.0.0")).toBe(false);
  });

  it("liest beide Schreibweisen des workspaces-Feldes", () => {
    const asList = parseManifest(JSON.stringify({ name: "r", workspaces: ["packages/*"] }));
    const asObject = parseManifest(
      JSON.stringify({ name: "r", workspaces: { packages: ["apps/*"] } }),
    );
    expect(asList.ok && asList.manifest.workspaceGlobs).toEqual(["packages/*"]);
    expect(asObject.ok && asObject.manifest.workspaceGlobs).toEqual(["apps/*"]);
  });

  it("wirft bei einem kaputten Manifest nicht, sondern liefert einen Grund", () => {
    const result = parseManifest("{{{");
    expect(result.ok).toBe(false);
  });
});

describe("Workspace-Definition und Globabgleich", () => {
  it("liest die packages-Liste einer pnpm-Definition", () => {
    const result = parsePnpmWorkspace('packages:\n  - "packages/*"\n  - "!packages/legacy"\n');
    expect(result.ok && result.globs).toEqual(["packages/*", "!packages/legacy"]);
  });

  it("meldet eine fehlende packages-Liste als Grund statt als leere Menge", () => {
    const result = parsePnpmWorkspace("other: 1\n");
    expect(result.ok).toBe(false);
  });

  it("uebersetzt * , ** und ? in Segmentregeln", () => {
    expect(globToRegExp("packages/*").test("packages/a")).toBe(true);
    expect(globToRegExp("packages/*").test("packages/a/b")).toBe(false);
    expect(globToRegExp("packages/**").test("packages/a/b")).toBe(true);
    expect(globToRegExp("packages/**/src").test("packages/a/b/src")).toBe(true);
    expect(globToRegExp("packages/**/src").test("packages/src")).toBe(true);
    expect(globToRegExp("app?").test("apps")).toBe(true);
  });

  it("beruecksichtigt Ausschlussmuster", () => {
    const selection = splitGlobs(["packages/*", "!packages/legacy"]);
    expect(matchesGlobSelection(selection, "packages/core")).toBe(true);
    expect(matchesGlobSelection(selection, "packages/legacy")).toBe(false);
  });
});

describe("resolveProjectConfig", () => {
  const files: Record<string, string> = {
    "tsconfig.base.json": `{
      // Kommentar in der Basis
      "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["packages/app/src/*"] } },
    }`,
    "packages/a/tsconfig.json": JSON.stringify({
      extends: "../../tsconfig.base.json",
      compilerOptions: { rootDir: "src", outDir: "dist" },
    }),
  };

  it("verfolgt extends und loest Pfade repo-relativ auf", () => {
    const result = resolveProjectConfig("packages/a/tsconfig.json", (path) => files[path] ?? null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.rootDir).toBe("packages/a/src");
    expect(result.config.outDir).toBe("packages/a/dist");
    expect(result.config.paths["@app/*"]).toEqual(["packages/app/src/*"]);
    expect(result.config.extendsChain).toEqual(["tsconfig.base.json"]);
    expect(result.warnings).toEqual([]);
  });

  it("meldet ein fehlendes extends-Ziel als Warnung, statt die Aliase zu verlieren", () => {
    const result = resolveProjectConfig("packages/a/tsconfig.json", (path) =>
      path === "packages/a/tsconfig.json" ? (files[path] as string) : null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(" ")).toContain("extends target not found");
    expect(result.config.rootDir).toBe("packages/a/src");
  });

  it("bricht eine zirkulaere extends-Kette mit benanntem Fehler ab", () => {
    const circular: Record<string, string> = {
      "a.json": JSON.stringify({ extends: "./b.json" }),
      "b.json": JSON.stringify({ extends: "./a.json" }),
    };
    const result = resolveProjectConfig("a.json", (path) => circular[path] ?? null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("circular");
  });
});

describe("parseComposeFile", () => {
  const compose = `
services:
  frontend:
    build: ./apps/web
    depends_on:
      backend:
        condition: service_healthy
    networks: [edge]
  backend:
    build:
      context: ./services/api
    networks: [edge, internal]
    depends_on:
      - worker
  worker:
    image: busybox
    networks: [internal]
`;

  it("liest Dienste, Build-Kontexte und Netzwerke", () => {
    const result = parseComposeFile("r", "docker-compose.yml", compose);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.services.map((service) => service.name)).toEqual([
      "backend",
      "frontend",
      "worker",
    ]);
    const backend = result.result.services.find((service) => service.name === "backend");
    expect(backend?.buildContext).toBe("services/api");
    expect(backend?.networks).toEqual(["edge", "internal"]);
  });

  it("fuehrt depends_on gerichtet und mit Bedingung", () => {
    const result = parseComposeFile("r", "docker-compose.yml", compose);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.edges).toContainEqual({
      fromService: "frontend",
      toService: "backend",
      kind: "depends_on",
      condition: "service_healthy",
    });
    expect(result.result.edges).toContainEqual({
      fromService: "backend",
      toService: "worker",
      kind: "depends_on",
    });
  });

  it("macht die Erreichbarkeit ueber gemeinsame Netzwerke sichtbar", () => {
    const result = parseComposeFile("r", "docker-compose.yml", compose);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const shared = result.result.edges.filter((edge) => edge.kind === "shared-network");
    expect(shared).toContainEqual({
      fromService: "backend",
      toService: "frontend",
      kind: "shared-network",
      network: "edge",
    });
    expect(shared).toContainEqual({
      fromService: "backend",
      toService: "worker",
      kind: "shared-network",
      network: "internal",
    });
    // frontend und worker teilen KEIN Netzwerk und duerfen deshalb auch keine
    // Erreichbarkeitskante bekommen.
    expect(
      shared.some((edge) => edge.fromService === "frontend" && edge.toService === "worker"),
    ).toBe(false);
  });

  it("setzt Dienste ohne networks-Angabe in das implizite default-Netzwerk", () => {
    const result = parseComposeFile(
      "r",
      "compose.yml",
      "services:\n  a:\n    image: x\n  b:\n    image: y\n",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.edges).toContainEqual({
      fromService: "a",
      toService: "b",
      kind: "shared-network",
      network: "default",
    });
  });

  it("meldet ein depends_on auf einen unbekannten Dienst, statt es zu verschlucken", () => {
    const result = parseComposeFile(
      "r",
      "compose.yml",
      "services:\n  a:\n    image: x\n    depends_on:\n      - ghost\n",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.warnings.join(" ")).toContain('depends_on unknown service "ghost"');
    expect(result.result.edges.filter((edge) => edge.kind === "depends_on")).toEqual([]);
  });

  it("meldet eine Datei ohne services-Abschnitt als Fehler", () => {
    const result = parseComposeFile("r", "compose.yml", "volumes:\n  a: {}\n");
    expect(result.ok).toBe(false);
  });
});
