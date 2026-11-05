import { describe, expect, it } from "vitest";

import {
  buildCompletenessEvidence,
  claimCompleteness,
  CompletenessClaimError,
  completenessLevelOf,
  deriveCompletenessLevel,
  formatCompletenessClaim,
  isCompletenessClaim,
  parseCompletenessClaim,
  requireComplete,
  verifyCompletenessClaim,
  type CompletenessClaimV1,
} from "./completeness.js";
import { makeFinding } from "./finding.js";

describe("claimCompleteness", () => {
  it('derives "complete" only from evidence that accounts for everything', () => {
    const claim = claimCompleteness({
      subject: "src/a.ts",
      evidence: { unit: "bytes", expected: 120, accountedFor: 120 },
    });
    expect(claim.level).toBe("complete");
    expect(completenessLevelOf(claim, "a.ts")).toBe("complete");
  });

  it('derives "partial" as soon as anything is omitted, however well-reasoned', () => {
    const claim = claimCompleteness({
      subject: "src/a.ts",
      evidence: {
        unit: "bytes",
        expected: 120,
        accountedFor: 100,
        omissions: [{ amount: 20, reason: "minified tail, excluded by configuration" }],
      },
    });
    expect(claim.level).toBe("partial");
  });

  it('derives "failed" when nothing at all was accounted for', () => {
    const claim = claimCompleteness({
      subject: "src/a.ts",
      evidence: {
        unit: "bytes",
        expected: 120,
        accountedFor: 0,
        omissions: [{ amount: 120, reason: "parse failed" }],
      },
    });
    expect(claim.level).toBe("failed");
  });

  it("treats an empty subject as complete (nothing to account for)", () => {
    const claim = claimCompleteness({
      subject: "src/empty.ts",
      evidence: { unit: "bytes", expected: 0, accountedFor: 0 },
    });
    expect(claim.level).toBe("complete");
  });

  it("refuses evidence whose arithmetic does not close", () => {
    expect(() =>
      claimCompleteness({
        subject: "src/a.ts",
        evidence: { unit: "bytes", expected: 120, accountedFor: 100 },
      }),
    ).toThrow(CompletenessClaimError);
  });

  it("refuses an omission without a reason (E4)", () => {
    expect(() =>
      buildCompletenessEvidence({
        unit: "bytes",
        expected: 10,
        accountedFor: 5,
        omissions: [{ amount: 5, reason: "   " }],
      }),
    ).toThrow(/non-empty reason/);
  });

  it("refuses a claim without a subject", () => {
    expect(() =>
      claimCompleteness({ subject: "", evidence: { unit: "bytes", expected: 0, accountedFor: 0 } }),
    ).toThrow(/non-empty subject/);
  });

  it('blocks "complete" when a blocking finding contradicts it', () => {
    const claim = claimCompleteness({
      subject: "src/a.ts",
      evidence: {
        unit: "bytes",
        expected: 10,
        accountedFor: 10,
        findings: [makeFinding("skip_ledger", "parse/file/parse_failed src/a.ts: broken")],
      },
    });
    expect(claim.level).toBe("partial");
  });

  it('does not block "complete" on a mere warning or diagnostic', () => {
    const claim = claimCompleteness({
      subject: "src/a.ts",
      evidence: {
        unit: "bytes",
        expected: 10,
        accountedFor: 10,
        findings: [makeFinding("warning", "used the fallback path but covered everything")],
      },
    });
    expect(claim.level).toBe("complete");
  });

  it("sorts omissions deterministically (no localeCompare, no input order)", () => {
    const forward = claimCompleteness({
      subject: "s",
      evidence: {
        unit: "bytes",
        expected: 6,
        accountedFor: 0,
        omissions: [
          { amount: 1, reason: "b" },
          { amount: 2, reason: "a" },
          { amount: 3, reason: "C" },
        ],
      },
    });
    const backward = claimCompleteness({
      subject: "s",
      evidence: {
        unit: "bytes",
        expected: 6,
        accountedFor: 0,
        omissions: [
          { amount: 3, reason: "C" },
          { amount: 2, reason: "a" },
          { amount: 1, reason: "b" },
        ],
      },
    });
    expect(forward.evidence.omissions).toEqual(backward.evidence.omissions);
    // Codepoint order: "C" (U+0043) before "a" (U+0061) -- a locale-aware
    // comparison would put "a" first.
    expect(forward.evidence.omissions.map((omission) => omission.reason)).toEqual(["C", "a", "b"]);
  });
});

describe("structural non-forgeability", () => {
  it("rejects an object literal that merely looks like a claim (compile-time)", () => {
    // Der eigentliche Beweis ist der Uebersetzungsfehler: der Pflichtschluessel
    // ist ein nicht exportiertes `unique symbol`, also kann ihn kein Literal
    // tragen. @ts-expect-error schlaegt fehl, sobald das aufhoert zu gelten.
    // @ts-expect-error -- "complete" darf nicht als blosses Literal setzbar sein
    // eslint-disable-next-line untangle/no-forged-completeness -- dieser Test IST der Faelschungsversuch, den die Regel sonst verbietet
    const forged: CompletenessClaimV1 = {
      schemaVersion: 1,
      completenessWitness: "untangle.completeness.v1",
      subject: "src/a.ts",
      level: "complete",
      evidence: {
        schemaVersion: 1,
        unit: "bytes",
        expected: 120,
        accountedFor: 0,
        omissions: [],
        findings: [],
      },
    };
    expect(forged.level).toBe("complete");
  });

  it("catches a cast-forged claim at runtime, because the evidence derives another level", () => {
    // eslint-disable-next-line untangle/no-forged-completeness -- dieser Test IST der Faelschungsversuch, den die Regel sonst verbietet
    const forged = {
      schemaVersion: 1,
      completenessWitness: "untangle.completeness.v1",
      subject: "src/a.ts",
      level: "complete",
      evidence: {
        schemaVersion: 1,
        unit: "bytes",
        expected: 120,
        accountedFor: 30,
        omissions: [{ amount: 90, reason: "discarded subtree" }],
        findings: [],
      },
    } as unknown as CompletenessClaimV1;

    expect(isCompletenessClaim(forged)).toBe(true); // der Marker allein reicht nicht
    expect(verifyCompletenessClaim(forged)).toHaveLength(1);
    expect(() => completenessLevelOf(forged, "forged")).toThrow(/derives "partial"/);
  });

  it("re-derives the level when a claim crosses a serialization boundary", () => {
    const genuine = claimCompleteness({
      subject: "src/a.ts",
      evidence: {
        unit: "bytes",
        expected: 10,
        accountedFor: 4,
        omissions: [{ amount: 6, reason: "token budget exceeded" }],
      },
    });
    const tampered = JSON.parse(JSON.stringify({ ...genuine, level: "complete" })) as unknown;
    expect(parseCompletenessClaim(tampered, "from json").level).toBe("partial");
  });

  it("requireComplete refuses anything below complete", () => {
    const claim = claimCompleteness({
      subject: "src/a.ts",
      evidence: {
        unit: "bytes",
        expected: 10,
        accountedFor: 4,
        omissions: [{ amount: 6, reason: "token budget exceeded" }],
      },
    });
    expect(() => requireComplete(claim, "index gate")).toThrow(/requires a complete result/);
  });

  it("rejects a non-claim outright", () => {
    expect(verifyCompletenessClaim({ level: "complete" })).toEqual([
      "value is not a completeness claim (missing or wrong runtime witness)",
    ]);
  });
});

describe("deriveCompletenessLevel", () => {
  it("is the only place a completeness level comes from", () => {
    const evidence = buildCompletenessEvidence({ unit: "edges", expected: 3, accountedFor: 3 });
    expect(deriveCompletenessLevel(evidence)).toBe("complete");
  });
});

describe("formatCompletenessClaim", () => {
  it("names subject, level, amounts and every omission", () => {
    const claim = claimCompleteness({
      subject: "src/a.ts",
      evidence: {
        unit: "bytes",
        expected: 10,
        accountedFor: 4,
        omissions: [{ amount: 6, reason: "token budget exceeded" }],
      },
    });
    expect(formatCompletenessClaim(claim)).toBe(
      "src/a.ts: partial -- 4/10 bytes accounted for; 6 bytes (token budget exceeded)",
    );
  });
});
