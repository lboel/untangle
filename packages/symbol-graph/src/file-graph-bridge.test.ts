/**
 * Bruecke vom Dateigraphen: gebaut gegen den Domaintyp `FileEdgeV1`, nicht
 * gegen ein Paket.
 */
import type { FileEdgeV1 } from "@untangle-code/domain";
import { FILE_GRAPH_VERSION } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { resolvedImportsFromFileEdges } from "./file-graph-bridge.js";

function edge(overrides: Partial<FileEdgeV1> & Pick<FileEdgeV1, "resolution">): FileEdgeV1 {
  return {
    schemaVersion: 1,
    edgeId: "edge-1",
    workspaceId: "ws-1",
    repoId: "repo-1",
    refId: "ref-1",
    fromFileId: "file-a",
    fromPath: "src/a.ts",
    kind: "import",
    rawSpecifier: "./b",
    boundary: { crossRepo: false, crossPackage: false, crossContainer: false },
    sites: [],
    sitesMissingReason: "fixture",
    occurrenceOrdinal: 0,
    graphGeneration: "gen-1",
    graphVersion: FILE_GRAPH_VERSION,
    ...overrides,
  };
}

describe("resolvedImportsFromFileEdges", () => {
  it("maps a resolved edge to a target file", () => {
    const targets = resolvedImportsFromFileEdges([
      edge({
        resolution: {
          status: "resolved",
          mechanism: "relative-path",
          targetFileId: "file-b",
          targetRepoId: "repo-1",
          targetRefId: "ref-1",
          targetPath: "src/b.ts",
        },
      }),
    ]);
    expect(targets).toEqual([{ fromFileId: "file-a", specifier: "./b", toFileId: "file-b" }]);
  });

  it("marks an external edge as external and keeps the package name in the detail", () => {
    const targets = resolvedImportsFromFileEdges([
      edge({
        rawSpecifier: "some-package",
        resolution: {
          status: "external",
          mechanism: "installed-package",
          packageName: "some-package",
        },
      }),
    ]);
    expect(targets[0]?.external).toBe(true);
    expect(targets[0]?.toFileId).toBeNull();
    expect(targets[0]?.unresolvedDetail).toContain("some-package");
  });

  it("carries the unresolved reason and detail across", () => {
    const targets = resolvedImportsFromFileEdges([
      edge({
        resolution: {
          status: "unresolved",
          reason: "alias_configured_but_target_missing",
          detail: "no alias table entry for the configured prefix",
        },
      }),
    ]);
    expect(targets[0]?.unresolvedDetail).toContain("alias_configured_but_target_missing");
    expect(targets[0]?.unresolvedDetail).toContain("no alias table entry");
  });

  it("prefers the resolved edge when the same specifier appears twice", () => {
    const unresolvedFirst = edge({
      resolution: { status: "unresolved", reason: "target_file_not_found", detail: "missing" },
    });
    const resolvedSecond = edge({
      edgeId: "edge-2",
      occurrenceOrdinal: 1,
      resolution: {
        status: "resolved",
        mechanism: "relative-path",
        targetFileId: "file-b",
        targetRepoId: "repo-1",
        targetRefId: "ref-1",
        targetPath: "src/b.ts",
      },
    });
    expect(resolvedImportsFromFileEdges([unresolvedFirst, resolvedSecond])).toEqual(
      resolvedImportsFromFileEdges([resolvedSecond, unresolvedFirst]),
    );
    expect(resolvedImportsFromFileEdges([unresolvedFirst, resolvedSecond])[0]?.toFileId).toBe(
      "file-b",
    );
  });
});
