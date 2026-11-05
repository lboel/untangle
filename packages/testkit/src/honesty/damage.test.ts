import { describe, expect, it } from "vitest";

import {
  breakStructureDamage,
  DAMAGE_KINDS,
  damageNotApplicable,
  exceedLimitDamage,
  isDamageNotApplicable,
  STRUCTURE_BREAKING_MARKER,
  truncateContentDamage,
  type TextLens,
} from "./damage.js";
import {
  findingFromThrown,
  findingsFromDiagnostics,
  findingsFromSkipLedger,
  makeFinding,
  newFindings,
} from "./finding.js";

const lens: TextLens<{ text: string }> = {
  read: (input) => input.text,
  write: (input, text) => ({ ...input, text }),
};

describe("damage kinds", () => {
  it("names exactly the six kinds the E4 safeguard requires", () => {
    expect([...DAMAGE_KINDS]).toEqual([
      "truncate_content",
      "break_structure",
      "remove_required_field",
      "exceed_limit",
      "force_concurrency",
      "abort_signal",
    ]);
  });
});

describe("truncateContentDamage", () => {
  it("keeps the leading half and never splits a surrogate pair", () => {
    const damaged = truncateContentDamage(lens).damage({ text: "ab\u{1F600}cd" });
    expect(isDamageNotApplicable(damaged)).toBe(false);
    // 5 Codepoints, Haelfte abgerundet = 2.
    expect((damaged as { text: string }).text).toBe("ab");
    // Kein halbes Surrogat: der String bleibt gueltig kodierbar.
    expect(Buffer.from((damaged as { text: string }).text, "utf8").toString("utf8")).toBe("ab");
  });

  it("always removes at least one code point", () => {
    const damaged = truncateContentDamage(lens, { keepFraction: 1 }).damage({ text: "abc" });
    expect((damaged as { text: string }).text).toBe("ab");
  });

  it("reports non-applicability with a reason instead of silently doing nothing (E4)", () => {
    const damaged = truncateContentDamage(lens).damage({ text: "" });
    expect(isDamageNotApplicable(damaged)).toBe(true);
    expect((damaged as { reason: string }).reason).toContain("empty");
  });
});

describe("breakStructureDamage / exceedLimitDamage", () => {
  it("inserts unbalanced delimiters in the middle", () => {
    const damaged = breakStructureDamage(lens).damage({ text: "abcd" });
    expect((damaged as { text: string }).text).toBe(`ab${STRUCTURE_BREAKING_MARKER}cd`);
  });

  it("multiplies the text past any size budget", () => {
    const damaged = exceedLimitDamage(lens, { repeat: 3 }).damage({ text: "x" });
    expect((damaged as { text: string }).text).toBe("x\nx\nx");
  });

  it("declines to inflate an empty text, with a reason", () => {
    expect(isDamageNotApplicable(exceedLimitDamage(lens).damage({ text: "" }))).toBe(true);
  });
});

describe("damageNotApplicable", () => {
  it("refuses an empty reason (E4)", () => {
    expect(() => damageNotApplicable("  ")).toThrow(/non-empty reason/);
  });
});

describe("findings", () => {
  it("refuses a finding without a detail (E4)", () => {
    expect(() => makeFinding("warning", "")).toThrow(/non-empty detail/);
  });

  it("turns skip-ledger entries and diagnostics into comparable findings", () => {
    expect(
      findingsFromSkipLedger([
        {
          schemaVersion: 1,
          stage: "parse",
          subjectKind: "file",
          path: "src/a.ts",
          reason: "parse_failed",
          detail: "unbalanced brace",
          recoverable: false,
        },
      ]),
    ).toEqual([
      { channel: "skip_ledger", detail: "parse/file/parse_failed src/a.ts: unbalanced brace" },
    ]);

    expect(
      findingsFromDiagnostics([
        {
          severity: "error",
          kind: "error_node",
          message: "unexpected token",
          range: { startLine: 1, endLine: 1, startByte: 3, endByte: 7 },
        },
      ]),
    ).toEqual([{ channel: "diagnostic", detail: "error/error_node @3..7: unexpected token" }]);
  });

  it("carries an error code into the finding detail when there is one", () => {
    const error = Object.assign(new Error("no chunks"), { code: "ANALYSIS_INCOMPLETE" });
    expect(findingFromThrown(error).detail).toBe("ANALYSIS_INCOMPLETE: Error: no chunks");
  });

  it("computes the multiset difference, not the set difference", () => {
    const a = makeFinding("warning", "same");
    expect(newFindings([a], [a, a])).toEqual([a]);
    expect(newFindings([a, a], [a])).toEqual([]);
    expect(newFindings([a], [makeFinding("warning", "other")])).toEqual([
      { channel: "warning", detail: "other" },
    ]);
  });
});
