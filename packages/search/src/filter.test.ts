import type { SearchFiltersV1 } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { buildPayloadFilter, buildSymbolNameFilter } from "./filter.js";

const SCOPE = { workspaceId: "ws-1" };

function filters(overrides: Partial<SearchFiltersV1> = {}): SearchFiltersV1 {
  return {
    repoIds: [],
    refIds: [],
    languages: [],
    pathGlobs: [],
    symbolNames: [],
    symbolKinds: [],
    chunkKinds: [],
    ...overrides,
  };
}

describe("buildPayloadFilter", () => {
  it("always restricts to code chunks", () => {
    expect(buildPayloadFilter(filters(), SCOPE).filter.must).toEqual([
      { field: "point_type", match: { eq: "code_chunk" } },
      { field: "workspace_id", match: { eq: "ws-1" } },
    ]);
  });

  it("uses eq for one value and in for several", () => {
    const single = buildPayloadFilter(filters({ repoIds: ["r1"] }), SCOPE).filter.must ?? [];
    expect(single).toContainEqual({ field: "repo_id", match: { eq: "r1" } });
    const many = buildPayloadFilter(filters({ repoIds: ["r1", "r2"] }), SCOPE).filter.must ?? [];
    expect(many).toContainEqual({ field: "repo_id", match: { in: ["r1", "r2"] } });
  });

  it("pushes complexity ranges down as numeric range conditions", () => {
    const must =
      buildPayloadFilter(filters({ complexity: { cognitiveMin: 10, cognitiveMax: 20 } }), SCOPE)
        .filter.must ?? [];
    expect(must).toContainEqual({ field: "cognitive", range: { gte: 10, lte: 20 } });
  });

  it("maps the changed range onto changed_at_epoch_ms", () => {
    const must =
      buildPayloadFilter(
        filters({
          changed: { since: "2026-01-01T00:00:00.000Z", until: "2026-02-01T00:00:00.000Z" },
        }),
        SCOPE,
      ).filter.must ?? [];
    expect(must).toContainEqual({
      field: "changed_at_epoch_ms",
      range: {
        gte: Date.parse("2026-01-01T00:00:00.000Z"),
        lt: Date.parse("2026-02-01T00:00:00.000Z"),
      },
    });
  });

  it("declares path globs as residual instead of pretending to push them down", () => {
    const built = buildPayloadFilter(filters({ pathGlobs: ["src/**"] }), SCOPE);
    expect(built.residual.map((entry) => entry.name)).toEqual(["pathGlobs"]);
    expect(built.residual[0]?.reason).not.toBe("");
  });

  it("declares the findability filter as residual", () => {
    const built = buildPayloadFilter(filters({ findability: { maxScore: 0.3 } }), SCOPE);
    expect(built.residual.map((entry) => entry.name)).toContain("findability");
  });

  it("has no residual filters when everything is pushable", () => {
    expect(buildPayloadFilter(filters({ languages: ["typescript"] }), SCOPE).residual).toEqual([]);
  });
});

describe("buildSymbolNameFilter", () => {
  it("adds the symbol name condition on top of the base filter", () => {
    const base = buildPayloadFilter(filters({ repoIds: ["r1"] }), SCOPE).filter;
    const combined = buildSymbolNameFilter(base, ["charge"]);
    expect(combined?.must).toHaveLength((base.must ?? []).length + 1);
    expect(combined?.must).toContainEqual({ field: "symbol_name", match: { eq: "charge" } });
  });

  it("returns undefined without candidates, so no pointless query is issued", () => {
    expect(buildSymbolNameFilter(buildPayloadFilter(filters(), SCOPE).filter, [])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Regressionen aus der adversarialen Pruefung (Welle 3)
// ---------------------------------------------------------------------------

describe("buildPayloadFilter: Geltungsbereich", () => {
  it("schiebt den Workspace immer in den Speicherfilter", () => {
    const must = buildPayloadFilter(filters(), { workspaceId: "ws-1" }).filter.must ?? [];
    expect(must).toContainEqual({ field: "workspace_id", match: { eq: "ws-1" } });
  });

  it("verweigert einen leeren Workspace, statt ueber alle zu suchen", () => {
    expect(() => buildPayloadFilter(filters(), { workspaceId: "  " })).toThrow(/workspaceId/u);
  });

  it("schraenkt auf die Repositories des Ziels ein, auch ohne Anfragefilter", () => {
    const built = buildPayloadFilter(filters(), {
      workspaceId: "ws-1",
      targetRepoIds: ["r2", "r1"],
    });
    expect(built.filter.must).toContainEqual({ field: "repo_id", match: { in: ["r1", "r2"] } });
    expect(built.scopeRepoIds).toEqual(["r1", "r2"]);
  });

  it("bildet den Durchschnitt aus Anfrage und Ziel", () => {
    const built = buildPayloadFilter(filters({ repoIds: ["r1", "r3"] }), {
      workspaceId: "ws-1",
      targetRepoIds: ["r1", "r2"],
    });
    expect(built.filter.must).toContainEqual({ field: "repo_id", match: { eq: "r1" } });
    expect(built.scopeRepoIds).toEqual(["r1"]);
  });

  it("meldet einen leeren Durchschnitt, statt ihn als 'kein Filter' auszugeben", () => {
    const built = buildPayloadFilter(filters({ repoIds: ["r9"] }), {
      workspaceId: "ws-1",
      targetRepoIds: ["r1"],
    });
    expect(built.emptyScopeReason).toBeDefined();
    expect(built.scopeRepoIds).toEqual([]);
    expect(built.filter.must).not.toContainEqual(
      expect.objectContaining({ field: "repo_id" }) as never,
    );
  });

  it("lehnt einen unlesbaren Aenderungszeitstempel ab, statt NaN in den Bereich zu schieben", () => {
    expect(() =>
      buildPayloadFilter(filters({ changed: { since: "gestern" } }), { workspaceId: "ws-1" }),
    ).toThrow(/changed.since/u);
  });
});
