/**
 * Regressionstest zu Welle-3-Befund 4: eine mehrdeutige Kante, deren
 * Kandidaten allesamt in fremden Repositories liegen, hat `crossRepo: false`
 * gemeldet — und `metrics.crossRepoEdgeCount` damit 0. Der Grund war, dass
 * sowohl der Aufbau als auch `validateSymbolEdge` die Repo-Zugehoerigkeit nur
 * am `target` geprueft haben, das mehrdeutige Kanten gar nicht besitzen.
 */
import { validateSymbolEdge } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { buildSymbolGraph } from "./build.js";
import { makeFile } from "./test-support/fixtures.js";
import type { SymbolGraphBuildInput } from "./types.js";

const CALLER = "export function caller() {\n  shared();\n}\n";
const SHARED = "export function shared() {}\n";

function crossRepoInput(secondRepoId: string): SymbolGraphBuildInput {
  return {
    workspaceId: "ws-1",
    graphGeneration: "gen-1",
    files: [
      makeFile({
        fileId: "file-a",
        repoId: "repo-alpha",
        path: "a/caller.ts",
        content: CALLER,
        symbols: [{ name: "caller", snippet: "export function caller() {\n  shared();\n}" }],
        calls: [{ calleeName: "shared", snippet: "shared();" }],
      }),
      makeFile({
        fileId: "file-b",
        repoId: "repo-beta",
        path: "b/x.ts",
        content: SHARED,
        symbols: [{ name: "shared", snippet: "export function shared() {}" }],
      }),
      makeFile({
        fileId: "file-c",
        repoId: secondRepoId,
        path: "c/y.ts",
        content: SHARED,
        symbols: [{ name: "shared", snippet: "export function shared() {}" }],
      }),
    ],
  };
}

describe("crossRepo bei mehrdeutigen Kanten", () => {
  it("meldet crossRepo, wenn alle Kandidaten in fremden Repositories liegen", () => {
    const graph = buildSymbolGraph(crossRepoInput("repo-gamma"));
    const edge = graph.edges.find((candidate) => candidate.toName === "shared");
    expect(edge?.resolution).toBe("ambiguous");
    expect(edge?.crossRepo).toBe(true);
    expect(graph.metrics.crossRepoEdgeCount).toBe(1);
  });

  it("meldet crossRepo auch, wenn nur EIN Kandidat die Grenze ueberschreitet", () => {
    const graph = buildSymbolGraph(crossRepoInput("repo-alpha"));
    const edge = graph.edges.find((candidate) => candidate.toName === "shared");
    expect(edge?.resolution).toBe("ambiguous");
    expect(edge?.crossRepo).toBe(true);
    expect(graph.metrics.crossRepoEdgeCount).toBe(1);
  });

  it("meldet keine Repo-Grenze, wenn alle Kandidaten im Quellrepo liegen", () => {
    const graph = buildSymbolGraph({
      ...crossRepoInput("repo-alpha"),
      files: crossRepoInput("repo-alpha").files.map((file) => ({
        ...file,
        repoId: "repo-alpha",
      })),
    });
    const edge = graph.edges.find((candidate) => candidate.toName === "shared");
    expect(edge?.crossRepo).toBe(false);
    expect(graph.metrics.crossRepoEdgeCount).toBe(0);
  });

  it("laesst den Domainvertrag die Kopplung pruefen, nicht nur den Aufbau", () => {
    const graph = buildSymbolGraph(crossRepoInput("repo-gamma"));
    const edge = graph.edges[0];
    expect(edge).toBeDefined();
    if (edge === undefined) return;
    expect(validateSymbolEdge(edge)).toEqual([]);
    // Dieselbe Kante mit zurueckgedrehtem Flag MUSS der Vertrag ablehnen.
    expect(validateSymbolEdge({ ...edge, crossRepo: false }).map((issue) => issue.kind)).toContain(
      "cross_repo_mismatch",
    );
  });
});
