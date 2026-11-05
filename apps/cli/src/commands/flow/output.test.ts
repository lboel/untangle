import { describe, expect, it } from "vitest";

import { limitItems } from "./output.js";

describe("flow JSON result limits", () => {
  it("returns one item for limit=1 and exposes the exact omission", () => {
    expect(limitItems(["left", "middle", "right"], 1)).toEqual({
      items: ["left"],
      truncated: true,
      omittedCount: 2,
    });
  });

  it("does not report truncation when every item is visible", () => {
    expect(limitItems(["only"], 1)).toEqual({
      items: ["only"],
      truncated: false,
      omittedCount: 0,
    });
  });
});
