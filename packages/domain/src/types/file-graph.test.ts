import { describe, expect, it } from "vitest";

import { canonicalJson } from "../canonical-json.js";
import { buildFileEdgeId } from "../identity.js";
import { FILE_GRAPH_VERSION } from "../versions.js";

import type { FileEdgeV1, FileNodeV1 } from "./file-graph.js";
import { validateFileEdge } from "./file-graph.js";

const WORKSPACE = "11111111-1111-5111-9111-111111111111";
const REPO_A = "aaaaaaaa-aaaa-5aaa-9aaa-aaaaaaaaaaaa";
const REPO_B = "bbbbbbbb-bbbb-5bbb-9bbb-bbbbbbbbbbbb";

function baseEdge(): FileEdgeV1 {
  return {
    schemaVersion: 1,
    edgeId: buildFileEdgeId({
      workspaceId: WORKSPACE,
      fromFileId: "file-1",
      edgeKind: "import",
      rawSpecifier: "./util.js",
      occurrenceOrdinal: 0,
    }),
    workspaceId: WORKSPACE,
    repoId: REPO_A,
    refId: `${REPO_A}:main`,
    fromFileId: "file-1",
    fromPath: "src/index.ts",
    kind: "import",
    rawSpecifier: "./util.js",
    resolution: {
      status: "resolved",
      mechanism: "relative-path",
      targetFileId: "file-2",
      targetRepoId: REPO_A,
      targetRefId: `${REPO_A}:main`,
      targetPath: "src/util.ts",
    },
    boundary: { crossRepo: false, crossPackage: false, crossContainer: false },
    sites: [{ range: { startLine: 1, endLine: 1, startByte: 0, endByte: 24 } }],
    occurrenceOrdinal: 0,
    graphGeneration: "gen-1",
    graphVersion: FILE_GRAPH_VERSION,
  };
}

describe("FileEdgeV1 round-trip", () => {
  it("survives canonical JSON without loss", () => {
    const edge = baseEdge();
    expect(JSON.parse(canonicalJson(edge))).toEqual(edge);
  });

  it("serializes key-order independently", () => {
    const edge = baseEdge();
    const reordered = Object.fromEntries(Object.entries(edge).reverse()) as unknown as FileEdgeV1;
    expect(canonicalJson(reordered)).toBe(canonicalJson(edge));
  });
});

describe("buildFileEdgeId", () => {
  it("is stable for identical inputs and independent of the resolution", () => {
    const first = buildFileEdgeId({
      workspaceId: WORKSPACE,
      fromFileId: "file-1",
      edgeKind: "import",
      rawSpecifier: "./util.js",
      occurrenceOrdinal: 0,
    });
    const second = buildFileEdgeId({
      workspaceId: WORKSPACE,
      fromFileId: "file-1",
      edgeKind: "import",
      rawSpecifier: "./util.js",
      occurrenceOrdinal: 0,
    });
    expect(first).toBe(second);
    // Ein besserer Resolver darf die Identitaet der Kante nicht aendern: die
    // ID wird ausschliesslich aus der Quellseite gebildet, das Ziel geht nicht
    // ein. Belegt an zwei Kanten mit gleicher Quelle und verschiedener
    // Aufloesung.
    const unresolved: FileEdgeV1 = {
      ...baseEdge(),
      kind: "import",
      resolution: {
        status: "unresolved",
        reason: "target_file_not_found",
        detail: "no file at src/util.ts",
      },
    };
    const idOfUnresolved = buildFileEdgeId({
      workspaceId: unresolved.workspaceId,
      fromFileId: unresolved.fromFileId,
      edgeKind: unresolved.kind,
      rawSpecifier: unresolved.rawSpecifier,
      occurrenceOrdinal: unresolved.occurrenceOrdinal,
    });
    expect(idOfUnresolved).toBe(first);
    expect(unresolved.resolution.status).not.toBe(baseEdge().resolution.status);
  });

  it("separates repeated imports of the same specifier by ordinal", () => {
    const zero = buildFileEdgeId({
      workspaceId: WORKSPACE,
      fromFileId: "file-1",
      edgeKind: "import",
      rawSpecifier: "./util.js",
      occurrenceOrdinal: 0,
    });
    const one = buildFileEdgeId({
      workspaceId: WORKSPACE,
      fromFileId: "file-1",
      edgeKind: "import",
      rawSpecifier: "./util.js",
      occurrenceOrdinal: 1,
    });
    expect(zero).not.toBe(one);
  });

  it("rejects invalid inputs instead of producing a plausible id", () => {
    expect(() =>
      buildFileEdgeId({
        workspaceId: WORKSPACE,
        fromFileId: "file-1",
        edgeKind: "import",
        rawSpecifier: "",
        occurrenceOrdinal: 0,
      }),
    ).toThrowError(/rawSpecifier/);
    expect(() =>
      buildFileEdgeId({
        workspaceId: WORKSPACE,
        fromFileId: "file-1",
        edgeKind: "import",
        rawSpecifier: "./a",
        occurrenceOrdinal: -1,
      }),
    ).toThrowError(/occurrenceOrdinal/);
  });
});

describe("validateFileEdge", () => {
  it("accepts a well-formed resolved edge", () => {
    expect(validateFileEdge(baseEdge())).toEqual([]);
  });

  it("keeps the raw specifier of an unresolved import and demands a reason", () => {
    const edge: FileEdgeV1 = {
      ...baseEdge(),
      kind: "import",
      resolution: { status: "unresolved", reason: "package_not_installed", detail: "" },
    };
    expect(validateFileEdge(edge).map((issue) => issue.kind)).toContain("missing_detail");

    const withDetail: FileEdgeV1 = {
      ...edge,
      resolution: {
        status: "unresolved",
        reason: "package_not_installed",
        detail: "package is neither in the workspace catalog nor installed",
      },
    };
    expect(validateFileEdge(withDetail)).toEqual([]);
    expect(withDetail.rawSpecifier).toBe("./util.js");
  });

  it("rejects an empty raw specifier", () => {
    const edge: FileEdgeV1 = { ...baseEdge(), rawSpecifier: "  " };
    expect(validateFileEdge(edge).map((issue) => issue.kind)).toContain("empty_specifier");
  });

  it('rejects kind "unresolved" with a successful resolution', () => {
    const edge: FileEdgeV1 = { ...baseEdge(), kind: "unresolved" };
    expect(validateFileEdge(edge).map((issue) => issue.kind)).toContain("kind_resolution_mismatch");
  });

  it("accepts a cross-repo edge across a workspace package boundary", () => {
    const edge: FileEdgeV1 = {
      ...baseEdge(),
      rawSpecifier: "@example/shared",
      resolution: {
        status: "resolved",
        mechanism: "workspace-package",
        targetFileId: "file-9",
        targetRepoId: REPO_B,
        targetRefId: `${REPO_B}:main`,
        targetPath: "src/index.ts",
        viaPackageName: "@example/shared",
      },
      boundary: {
        crossRepo: true,
        crossPackage: true,
        crossContainer: false,
        fromPackageName: "@example/app",
        toPackageName: "@example/shared",
      },
    };
    expect(validateFileEdge(edge)).toEqual([]);
  });

  it("rejects a boundary flag that contradicts the resolved target", () => {
    const edge: FileEdgeV1 = {
      ...baseEdge(),
      resolution: {
        status: "resolved",
        mechanism: "workspace-package",
        targetFileId: "file-9",
        targetRepoId: REPO_B,
        targetRefId: `${REPO_B}:main`,
        targetPath: "src/index.ts",
      },
      boundary: { crossRepo: false, crossPackage: true, crossContainer: false },
    };
    expect(validateFileEdge(edge).map((issue) => issue.kind)).toContain("boundary_mismatch");
  });

  it("rejects an external target marked as cross-repo", () => {
    const edge: FileEdgeV1 = {
      ...baseEdge(),
      rawSpecifier: "some-external-package",
      resolution: {
        status: "external",
        mechanism: "installed-package",
        packageName: "some-external-package",
      },
      boundary: { crossRepo: true, crossPackage: true, crossContainer: false },
    };
    expect(validateFileEdge(edge).map((issue) => issue.kind)).toContain("boundary_mismatch");
  });

  it("demands two named services for a container boundary", () => {
    const edge: FileEdgeV1 = {
      ...baseEdge(),
      boundary: {
        crossRepo: false,
        crossPackage: false,
        crossContainer: true,
        fromContainerService: "api",
      },
    };
    expect(validateFileEdge(edge).map((issue) => issue.kind)).toContain("boundary_mismatch");
  });

  it("demands a reason when the parser delivered no source sites", () => {
    const edge: FileEdgeV1 = { ...baseEdge(), sites: [] };
    expect(validateFileEdge(edge).map((issue) => issue.kind)).toContain("missing_sites");

    const documented: FileEdgeV1 = {
      ...edge,
      sitesMissingReason: "text fallback adapter reports no ranges",
    };
    expect(validateFileEdge(documented)).toEqual([]);
  });
});

describe("FileNodeV1", () => {
  it("keeps unresolved imports visible in the node counters", () => {
    const node: FileNodeV1 = {
      schemaVersion: 1,
      workspaceId: WORKSPACE,
      repoId: REPO_A,
      refId: `${REPO_A}:main`,
      fileId: "file-1",
      filePath: "src/index.ts",
      language: "typescript",
      contentHash: "0".repeat(64),
      imports: ["./util.js", "some-external-package"],
      dependencies: ["file-2"],
      dependents: [],
      graphGeneration: "gen-1",
      unresolvedImportCount: 1,
    };
    // Die Differenz zwischen Rohimporten und aufgeloesten Abhaengigkeiten ist
    // sichtbar und nicht wegdefiniert (E4).
    expect(node.imports.length - node.dependencies.length).toBe(1);
    expect(JSON.parse(canonicalJson(node))).toEqual(node);
  });
});
