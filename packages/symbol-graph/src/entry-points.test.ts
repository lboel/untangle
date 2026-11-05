/**
 * Einstiegspunkt-Erkennung (WP-88). Alles hier ist Heuristik — und das muss
 * am Ergebnis ablesbar sein, nicht nur im Kommentar stehen.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import { buildSymbolGraph } from "./build.js";
import {
  DEFAULT_CONVENTIONAL_ENTRY_NAMES,
  combineEntryPointWeights,
  detectEntryPoints,
  MAX_ENTRY_POINT_CONFIDENCE,
} from "./entry-points.js";
import { createSymbolGraphIndex } from "./graph-index.js";
import { functionFile } from "./test-support/fixtures.js";
import type { EntryPointV1, SymbolGraphV1 } from "./types.js";

function graphWithEntryShapes(): SymbolGraphV1 {
  return buildSymbolGraph({
    workspaceId: "ws-1",
    graphGeneration: "gen-1",
    files: [
      functionFile({
        fileId: "file-app",
        path: "src/app.ts",
        functions: [{ name: "main", calls: [{ name: "worker" }] }, { name: "worker" }],
      }),
      functionFile({
        fileId: "file-routes",
        path: "src/routes/users.ts",
        functions: [{ name: "listUsers" }],
      }),
      functionFile({
        fileId: "file-test",
        path: "src/app.test.ts",
        functions: [{ name: "checksWorker" }],
      }),
    ],
  });
}

describe("detectEntryPoints", () => {
  it("marks the whole result as heuristic, structurally", () => {
    const set = detectEntryPoints(createSymbolGraphIndex(graphWithEntryShapes()));
    expect(set.isHeuristic).toBe(true);
    expectTypeOf(set.isHeuristic).toEqualTypeOf<true>();
    for (const entry of set.entryPoints) {
      expect(entry.isHeuristic).toBe(true);
      expect(entry.confidence.basis).toBe("heuristic");
      expectTypeOf(entry.confidence.basis).toEqualTypeOf<"heuristic">();
    }
  });

  it("recognizes an orphan and says why", () => {
    const set = detectEntryPoints(createSymbolGraphIndex(graphWithEntryShapes()));
    const main = set.entryPoints.find((entry) => entry.qualifiedName === "main");
    expect(main?.kinds).toContain("orphan");
    const signal = main?.signals.find((candidate) => candidate.kind === "orphan");
    expect(signal?.reason).toContain("no resolved call edge");
  });

  it("does NOT call a symbol with callers an orphan", () => {
    const set = detectEntryPoints(createSymbolGraphIndex(graphWithEntryShapes()));
    const worker = set.entryPoints.find((entry) => entry.qualifiedName === "worker");
    expect(worker).toBeUndefined();
  });

  it("recognizes a conventional entry name", () => {
    const set = detectEntryPoints(createSymbolGraphIndex(graphWithEntryShapes()));
    const main = set.entryPoints.find((entry) => entry.qualifiedName === "main");
    expect(main?.kinds).toContain("conventional_name");
    expect(DEFAULT_CONVENTIONAL_ENTRY_NAMES).toContain("main");
  });

  it("recognizes a test symbol by its file path", () => {
    const set = detectEntryPoints(createSymbolGraphIndex(graphWithEntryShapes()));
    const test = set.entryPoints.find((entry) => entry.qualifiedName === "checksWorker");
    expect(test?.kinds).toContain("test_symbol");
    expect(test?.signals.find((signal) => signal.kind === "test_symbol")?.reason).toContain(
      ".test.",
    );
  });

  it("recognizes a route directory as a layout convention, not a framework", () => {
    const set = detectEntryPoints(createSymbolGraphIndex(graphWithEntryShapes()));
    const route = set.entryPoints.find((entry) => entry.qualifiedName === "listUsers");
    expect(route?.kinds).toContain("framework_route");
    const reason = route?.signals.find((signal) => signal.kind === "framework_route")?.reason ?? "";
    expect(reason).toContain("routes");
    expect(reason).toContain("not a specific framework");
  });

  it("combines several weak signals without ever reaching certainty", () => {
    const set = detectEntryPoints(createSymbolGraphIndex(graphWithEntryShapes()));
    const main = set.entryPoints.find((entry) => entry.qualifiedName === "main");
    expect(main?.kinds.length).toBeGreaterThan(1);
    expect(main?.confidence.value).toBeGreaterThan(0.6);
    for (const entry of set.entryPoints) {
      expect(entry.confidence.value).toBeLessThanOrEqual(MAX_ENTRY_POINT_CONFIDENCE);
      expect(entry.confidence.value).toBeGreaterThan(0);
    }
  });

  it("gives every entry point at least one signal with a reason", () => {
    const set = detectEntryPoints(createSymbolGraphIndex(graphWithEntryShapes()));
    expect(set.entryPoints.length).toBeGreaterThan(0);
    for (const entry of set.entryPoints) {
      expect(entry.signals.length).toBeGreaterThan(0);
      expect(entry.kinds.length).toBe(entry.signals.length);
      for (const signal of entry.signals) {
        expect(signal.reason.trim()).not.toBe("");
      }
    }
  });

  it("counts the detected kinds", () => {
    const set = detectEntryPoints(createSymbolGraphIndex(graphWithEntryShapes()));
    expect(set.countsByKind.conventional_name).toBe(1);
    expect(set.countsByKind.test_symbol).toBe(1);
    expect(set.countsByKind.framework_route).toBe(1);
    expect(set.countsByKind.orphan).toBe(3);
  });

  it("honours a caller-supplied convention list", () => {
    const set = detectEntryPoints(createSymbolGraphIndex(graphWithEntryShapes()), {
      conventionalNames: ["worker"],
      testPathMarkers: [],
      routeDirectorySegments: [],
    });
    expect(set.countsByKind.conventional_name).toBe(1);
    expect(set.countsByKind.test_symbol).toBe(0);
    expect(set.countsByKind.framework_route).toBe(0);
    expect(set.entryPoints.find((entry) => entry.qualifiedName === "worker")?.kinds).toEqual([
      "conventional_name",
    ]);
  });

  it("can be narrowed to specific symbol kinds", () => {
    const set = detectEntryPoints(createSymbolGraphIndex(graphWithEntryShapes()), {
      eligibleSymbolKinds: ["class"],
    });
    expect(set.entryPoints).toEqual([]);
  });

  it("returns nothing for a graph without symbols", () => {
    const empty = buildSymbolGraph({ workspaceId: "ws-1", graphGeneration: "gen-1", files: [] });
    const set = detectEntryPoints(createSymbolGraphIndex(empty));
    expect(set.entryPoints).toEqual([]);
    expect(set.isHeuristic).toBe(true);
  });

  it("combines weights with the documented formula", () => {
    expect(combineEntryPointWeights([])).toBe(0);
    expect(combineEntryPointWeights([0.5])).toBeCloseTo(0.5, 10);
    expect(combineEntryPointWeights([0.5, 0.5])).toBeCloseTo(0.75, 10);
    expect(combineEntryPointWeights([0.9, 0.9, 0.9])).toBe(MAX_ENTRY_POINT_CONFIDENCE);
  });

  it("cannot be typed as a deterministic measurement", () => {
    const set = detectEntryPoints(createSymbolGraphIndex(graphWithEntryShapes()));
    const entry = set.entryPoints[0] as EntryPointV1;
    expect(entry.isHeuristic).toBe(true);
    // @ts-expect-error — `isHeuristic` ist auf `true` festgenagelt.
    entry.isHeuristic = false;
    // @ts-expect-error — die Basis ist auf "heuristic" festgenagelt.
    entry.confidence.basis = "deterministic";
  });
});
