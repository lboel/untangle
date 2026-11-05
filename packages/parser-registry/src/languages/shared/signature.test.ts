import { describe, expect, it } from "vitest";

import {
  normalizeParameterList,
  normalizeReturnType,
  normalizeSpacing,
  normalizeTypeParameterList,
  splitTopLevel,
  stripDefaultValue,
} from "./signature.js";

describe("normalizeSpacing", () => {
  it("collapses arbitrary whitespace runs to single spaces", () => {
    expect(normalizeSpacing("a,\n\n  b :   string")).toBe("a, b: string");
  });

  it("is stable whether given already-normalized input or messy input", () => {
    const messy = "a: number,\tb:  string ,\n c?:boolean";
    const clean = "a: number, b: string, c?: boolean";
    expect(normalizeSpacing(messy)).toBe(normalizeSpacing(clean));
  });
});

describe("splitTopLevel", () => {
  it("splits on top-level commas only, respecting nested brackets", () => {
    expect(splitTopLevel("a, b: Map<string, number>, c", ",")).toEqual([
      "a",
      " b: Map<string, number>",
      " c",
    ]);
  });

  it("handles nested object type defaults without splitting inside them", () => {
    expect(splitTopLevel("a = { x: 1, y: 2 }, b", ",")).toEqual(["a = { x: 1, y: 2 }", " b"]);
  });
});

describe("stripDefaultValue", () => {
  it("removes a simple default value", () => {
    expect(stripDefaultValue("a: number = 1")).toBe("a: number");
  });

  it("keeps the optional marker when there is no default", () => {
    expect(stripDefaultValue("b?: string")).toBe("b?: string");
  });

  it("does not confuse => with a default-value equals", () => {
    expect(stripDefaultValue("cb: () => void")).toBe("cb: () => void");
  });

  it("does not confuse comparison operators (==, ===, <=, >=, !=) with defaults", () => {
    expect(stripDefaultValue("a: boolean")).toBe("a: boolean");
  });

  it("removes an object-literal default value", () => {
    expect(stripDefaultValue("opts: Options = { retries: 3 }")).toBe("opts: Options");
  });

  it("leaves a parameter without a default untouched", () => {
    expect(stripDefaultValue("a: number")).toBe("a: number");
  });
});

describe("normalizeParameterList", () => {
  it("normalizes whitespace, drops defaults, keeps optional markers and types", () => {
    const input = "(a: number = 1,\n  b ?:  string,\tc: Options = { retries: 3 })";
    expect(normalizeParameterList(input)).toBe("(a: number, b?: string, c: Options)");
  });

  it("is identical for equivalent inputs differing only in whitespace", () => {
    const a = normalizeParameterList("(x: number,y:string)");
    const b = normalizeParameterList("(  x : number ,\n y : string  )");
    expect(a).toBe(b);
    expect(a).toBe("(x: number, y: string)");
  });

  it("handles an empty parameter list", () => {
    expect(normalizeParameterList("(  )")).toBe("()");
    expect(normalizeParameterList("()")).toBe("()");
  });

  it("keeps generic type arguments inside a parameter type intact", () => {
    expect(normalizeParameterList("(m: Map<string, number>)")).toBe("(m: Map<string, number>)");
  });
});

describe("normalizeTypeParameterList", () => {
  it("strips generic default types but keeps constraints", () => {
    expect(normalizeTypeParameterList("<T extends object = {}, U = string>")).toBe(
      "<T extends object, U>",
    );
  });

  it("returns empty string for undefined/empty input", () => {
    expect(normalizeTypeParameterList(undefined)).toBe("");
    expect(normalizeTypeParameterList("")).toBe("");
  });
});

describe("normalizeReturnType", () => {
  it("normalizes spacing after the leading colon", () => {
    expect(normalizeReturnType(":   Promise<void>")).toBe(": Promise<void>");
  });

  it("adds a leading colon if missing", () => {
    expect(normalizeReturnType("void")).toBe(": void");
  });
});
