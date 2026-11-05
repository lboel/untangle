/**
 * WP-73 regression test: `propertyGroupRegion` (`chunks.ts`) used to fold
 * `ranges.reduce((acc, r) => unionRange(acc, r))` with NO initial value.
 * SonarQube flagged that `Array.prototype.reduce` over an empty array with
 * no initial value throws a bare, unhelpful `TypeError` — a defect none of
 * the package's 1200+ other tests exercised because the only real caller
 * (`buildChildRegions`'s `flushProperties`) already guards on
 * `pendingProperties.length === 0` and never reaches this function with an
 * empty list end-to-end.
 *
 * Chosen fix (per the WP-73 mandate: "definiertes Verhalten ODER ein
 * UntangleError mit aussagekraeftiger Meldung statt TypeError"): there is
 * no meaningful `SourceRange` for zero properties, so an empty list is
 * treated as an honest internal-defect report (E4, no silent skip) — a
 * clearly-worded `UntangleError("ANALYSIS_INCOMPLETE", ...)` — rather than
 * inventing a defined-but-meaningless empty range that would mask a future
 * caller bug.
 */
import { UntangleError } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { buildByteOffsetTable } from "../../text/byte-offset-table.js";

import { propertyGroupRegion } from "./chunks.js";
import { TYPESCRIPT_DIALECT } from "./dialect.js";
import { createJsFamilyProfile } from "./js-family-profile.js";
import type { FileTextContext } from "./node-utils.js";
import type { ScopeNode } from "./scope-model.js";
import type { TsSyntaxNode } from "./tree-sitter-types.js";

/** Das Regionenbauen ist seit WP-220 profilgetrieben; hier reicht das TS-Profil. */
const profile = createJsFamilyProfile(TYPESCRIPT_DIALECT);

function makeCtx(source: string): FileTextContext {
  return { sourceText: source, byteTable: buildByteOffsetTable(source) };
}

describe("WP-73: propertyGroupRegion with an empty properties list", () => {
  it("throws a descriptive UntangleError instead of a bare reduce() TypeError", () => {
    const ctx = makeCtx("class C {}\n");

    let thrown: unknown;
    try {
      propertyGroupRegion([], "scope#C", 0, ctx, profile);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UntangleError);
    const error = thrown as UntangleError;
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error.code).toBe("ANALYSIS_INCOMPLETE");
    expect(error.retryable).toBe(false);
    expect(error.operation).toBe("chunk");
    expect(error.message).toMatch(/empty properties list/i);
    expect(error.context).toMatchObject({ parentScopeId: "scope#C", ordinal: 0 });
  });

  it("still unions ranges correctly for one or more real properties (unchanged behavior)", () => {
    const source = "class C {\n  a: number;\n  b: string;\n}\n";
    const ctx = makeCtx(source);
    const propA: ScopeNode = {
      scopeId: "scope#C.a",
      kind: "property",
      name: "a",
      qualifiedName: "C.a",
      range: { startLine: 2, endLine: 2, startByte: 10, endByte: 21 },
      normalizedSignature: "",
      exportedNames: [],
      executable: false,
      astHash: "a",
      tokenFingerprint: "a",
      node: { parent: null } as unknown as TsSyntaxNode,
      children: [],
    };
    const propB: ScopeNode = {
      scopeId: "scope#C.b",
      kind: "property",
      name: "b",
      qualifiedName: "C.b",
      range: { startLine: 3, endLine: 3, startByte: 24, endByte: 35 },
      normalizedSignature: "",
      exportedNames: [],
      executable: false,
      astHash: "b",
      tokenFingerprint: "b",
      node: { parent: null } as unknown as TsSyntaxNode,
      children: [],
    };

    const region = propertyGroupRegion([propA, propB], "scope#C", 0, ctx, profile);

    expect(region.chunkKind).toBe("property_group");
    expect(region.scopeId).toBe("scope#C#properties#0");
    expect(region.range).toEqual({ startLine: 2, endLine: 3, startByte: 10, endByte: 35 });
    expect(region.splittable).toBe(false);
  });
});
