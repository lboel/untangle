import { describe, expect, it } from "vitest";

import { boundDirectEdges } from "./bounds.js";

describe("boundDirectEdges", () => {
  it("retains only the direct-edge budget while reporting the exact high-degree remainder", () => {
    function* highDegreeEdges(): Generator<{ fromFileId: string; edgeId: string }> {
      yield { fromFileId: "other", edgeId: "before" };
      for (let index = 0; index < 50_000; index += 1) {
        yield { fromFileId: "source", edgeId: `edge-${String(index).padStart(5, "0")}` };
      }
      yield { fromFileId: "other", edgeId: "after" };
    }

    const result = boundDirectEdges(highDegreeEdges(), "source", 7);

    expect(result.edges).toHaveLength(7);
    expect(result.edges.map((edge) => edge.edgeId)).toEqual([
      "edge-00000",
      "edge-00001",
      "edge-00002",
      "edge-00003",
      "edge-00004",
      "edge-00005",
      "edge-00006",
    ]);
    expect(result).toMatchObject({ truncated: true, omittedCount: 49_993 });
    expect(JSON.stringify(result)).not.toContain("edge-49999");
  });

  it("keeps a complete result visibly complete", () => {
    expect(
      boundDirectEdges(
        [
          { fromFileId: "source", edgeId: "a" },
          { fromFileId: "source", edgeId: "b" },
        ],
        "source",
        2,
      ),
    ).toEqual({
      edges: [
        { fromFileId: "source", edgeId: "a" },
        { fromFileId: "source", edgeId: "b" },
      ],
      truncated: false,
      omittedCount: 0,
    });
  });
});
