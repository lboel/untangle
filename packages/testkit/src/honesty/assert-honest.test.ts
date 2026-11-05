import { describe, expect, it } from "vitest";

import {
  assertHonestUnderDamage,
  completenessClaimProjection,
  HonestyViolationError,
  runHonestyProbe,
  type HonestyProbe,
} from "./assert-honest.js";
import { claimCompleteness } from "./completeness.js";
import {
  abortSignalDamage,
  concurrencyDamage,
  damageNotApplicable,
  removeRequiredFieldDamage,
  standardTextDamages,
  type DamageCase,
} from "./damage.js";
import { makeFinding, type VisibleFinding } from "./finding.js";

/**
 * Spielzeugstufe: sie "erfasst" den Text einer Datei. Trifft sie den Marker,
 * verliert sie den Rest -- die ehrliche Fassung meldet das, die unehrliche
 * schweigt. Der Marker steckt in `STRUCTURE_BREAKING_MARKER`, also loest die
 * Struktur-Beschaedigung genau diesen Pfad aus.
 */
const MARKER = "UNTANGLE_DAMAGE";

interface ToyInput {
  readonly path: string;
  readonly text: string;
  readonly signal?: AbortSignal;
}

interface ToyOutput {
  readonly coveredBytes: number;
  readonly findings: readonly VisibleFinding[];
}

function toyStage(reportLoss: boolean): (input: ToyInput) => ToyOutput {
  return (input) => {
    if (input.signal?.aborted === true) {
      throw new Error("JOB_CANCELLED: aborted before any work was done");
    }
    const total = Buffer.byteLength(input.text, "utf8");
    const cut = input.text.indexOf(MARKER);
    if (cut < 0) {
      return { coveredBytes: total, findings: [] };
    }
    const covered = Buffer.byteLength(input.text.slice(0, cut), "utf8");
    return {
      coveredBytes: covered,
      findings: reportLoss
        ? [
            makeFinding(
              "skip_ledger",
              `chunk/file/parse_failed ${input.path}: dropped ${String(total - covered)} bytes after the marker`,
            ),
          ]
        : [],
    };
  };
}

const BASE_INPUT: ToyInput = {
  path: "src/a.ts",
  text: "export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n",
};

function toyDamages(): readonly DamageCase<ToyInput, ToyOutput>[] {
  const lens = {
    read: (input: ToyInput) => input.text,
    write: (input: ToyInput, text: string): ToyInput => ({ ...input, text }),
  };
  return [
    ...standardTextDamages(lens),
    removeRequiredFieldDamage<ToyInput>({
      id: "remove_path",
      detail: "blank out the mandatory file path",
      remove: (input) => ({ ...input, path: "" }),
    }),
    concurrencyDamage<ToyInput, ToyOutput>({
      decoy: { path: "src/other.ts", text: "const other = 1;\n" },
    }),
    abortSignalDamage<ToyInput>({
      attach: (input, signal) => ({ ...input, signal }),
    }),
  ];
}

function toyProbe(reportLoss: boolean): HonestyProbe<ToyInput, ToyOutput> {
  return {
    name: `toy stage (${reportLoss ? "honest" : "silent"})`,
    input: BASE_INPUT,
    run: toyStage(reportLoss),
    // Die Projektion ist relativ zum Eingang: "wie viele Bytes DIESES Eingangs
    // sind nicht erfasst". Sie bleibt bei kuerzerem oder laengerem Eingang
    // gleich und aendert sich genau dann, wenn wirklich etwas verloren geht.
    claim: (result, input) =>
      completenessClaimProjection(
        claimCompleteness({
          subject: input.path === "" ? "(no path)" : input.path,
          evidence: {
            unit: "bytes",
            expected: Buffer.byteLength(input.text, "utf8"),
            accountedFor: result.coveredBytes,
            omissions:
              Buffer.byteLength(input.text, "utf8") - result.coveredBytes > 0
                ? [
                    {
                      amount: Buffer.byteLength(input.text, "utf8") - result.coveredBytes,
                      reason: "not covered by the stage",
                    },
                  ]
                : [],
          },
        }),
        input.path,
      ),
    findings: (result) => result.findings,
    damages: toyDamages(),
  };
}

describe("assertHonestUnderDamage", () => {
  it("passes a stage that reports every loss it causes", async () => {
    const report = await assertHonestUnderDamage(toyProbe(true));
    const verdicts = Object.fromEntries(
      report.cases.map((entry) => [entry.damageId, entry.verdict]),
    );
    expect(verdicts).toEqual({
      truncate_content: "unchanged",
      break_structure: "reported",
      exceed_limit: "unchanged",
      remove_path: "unchanged",
      force_concurrency: "unchanged",
      abort_signal: "reported_by_throwing",
    });
    expect(report.uncoveredKinds).toEqual([]);
    expect(report.skipLedger).toEqual([]);
  });

  it("fails a stage that drops content silently -- the E4 failure class", async () => {
    const error = await assertHonestUnderDamage(toyProbe(false)).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HonestyViolationError);
    const violation = error as HonestyViolationError;
    expect(violation.report.violations.map((entry) => entry.damageId)).toEqual(["break_structure"]);
    expect(violation.message).toContain("the result changed but nothing was reported");
    expect(violation.message).toContain("fullyAccountedFor");
  });

  it("does not accept a probe that quietly checks fewer damage kinds than it claims", async () => {
    const probe = toyProbe(true);
    const thinned: HonestyProbe<ToyInput, ToyOutput> = {
      ...probe,
      damages: probe.damages.filter((damage) => damage.kind !== "abort_signal"),
    };
    const error = await assertHonestUnderDamage(thinned).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HonestyViolationError);
    expect((error as HonestyViolationError).report.uncoveredKinds).toEqual(["abort_signal"]);
    expect((error as HonestyViolationError).message).toContain("neither exercised nor waived");
  });

  it("accepts a waived damage kind and records the reason in its skip ledger", async () => {
    const probe = toyProbe(true);
    const report = await assertHonestUnderDamage({
      ...probe,
      damages: probe.damages.filter((damage) => damage.kind !== "abort_signal"),
      waivedDamageKinds: [
        { kind: "abort_signal", reason: "the toy stage is synchronous and takes no signal" },
      ],
    });
    expect(report.skipLedger).toEqual([
      {
        kind: "abort_signal",
        damageId: "(no case)",
        reason: "the toy stage is synchronous and takes no signal",
      },
    ]);
  });

  it("rejects a waiver for a kind that is exercised anyway (a false ledger entry)", async () => {
    const report = await runHonestyProbe({
      ...toyProbe(true),
      waivedDamageKinds: [{ kind: "abort_signal", reason: "not supported" }],
    });
    expect(report.probeIssues).toEqual([
      'damage kind "abort_signal" is waived ("not supported") but was also exercised -- the waiver is a false ledger entry',
    ]);
  });

  it("records a not-applicable damage with its reason, and still demands a waiver for the kind", async () => {
    const probe = toyProbe(true);
    const report = await runHonestyProbe<ToyInput, ToyOutput>({
      ...probe,
      damages: [
        ...probe.damages.filter((damage) => damage.kind !== "abort_signal"),
        abortSignalDamage<ToyInput>({
          attach: () => damageNotApplicable("this stage exposes no signal parameter"),
        }),
      ],
    });
    expect(report.skipLedger).toContainEqual({
      kind: "abort_signal",
      damageId: "abort_signal",
      reason: "this stage exposes no signal parameter",
    });
    expect(report.uncoveredKinds).toEqual(["abort_signal"]);
  });

  it("flags a non-deterministic stage instead of judging it", async () => {
    let counter = 0;
    const report = await runHonestyProbe<ToyInput, ToyOutput>({
      ...toyProbe(true),
      run: (input) => {
        counter += 1;
        // Abwechselnd alles und nichts erfasst: die Projektion kippt zwischen
        // "complete" und "failed", der Referenzlauf ist also nachweislich
        // instabil.
        return {
          coveredBytes: counter % 2 === 0 ? 0 : Buffer.byteLength(input.text, "utf8"),
          findings: [],
        };
      },
    });
    expect(report.probeIssues.join("\n")).toContain("is not deterministic");
  });

  it("flags duplicate damage ids", async () => {
    const probe = toyProbe(true);
    const first = probe.damages[0];
    if (first === undefined) throw new Error("fixture error: no damages");
    const report = await runHonestyProbe({ ...probe, damages: [...probe.damages, first] });
    expect(report.probeIssues.join("\n")).toContain('duplicate damage id "truncate_content"');
  });

  it("refuses to judge anything when the undamaged baseline already fails", async () => {
    await expect(
      runHonestyProbe<ToyInput, ToyOutput>({
        ...toyProbe(true),
        run: () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow(/undamaged baseline run must succeed/);
  });

  it("treats a loud failure under damage as an honest report, not a violation", async () => {
    const probe = toyProbe(true);
    const report = await runHonestyProbe<ToyInput, ToyOutput>({
      ...probe,
      run: (input) => {
        if (input.text.includes(MARKER)) {
          throw new Error("ANALYSIS_INCOMPLETE: refusing to guess past the marker");
        }
        return toyStage(true)(input);
      },
    });
    const structure = report.cases.find((entry) => entry.kind === "break_structure");
    expect(structure?.verdict).toBe("reported_by_throwing");
    expect(report.violations).toEqual([]);
  });

  it("catches a forged completeness claim through the projection alone", async () => {
    const report = await runHonestyProbe<ToyInput, ToyOutput>({
      ...toyProbe(false),
      // Ein Pruefling, der seinen Beleg faelscht: er behauptet volle Erfassung,
      // obwohl er nur die Haelfte erfasst hat.
      claim: (result, input) =>
        completenessClaimProjection(
          // eslint-disable-next-line untangle/no-forged-completeness -- dieser Test IST der Faelschungsversuch, den die Regel sonst verbietet
          {
            schemaVersion: 1,
            completenessWitness: "untangle.completeness.v1",
            subject: input.path === "" ? "(no path)" : input.path,
            level: "complete",
            evidence: {
              schemaVersion: 1,
              unit: "bytes",
              expected: Buffer.byteLength(input.text, "utf8"),
              accountedFor: result.coveredBytes,
              omissions: [],
              findings: [],
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          "forged",
        ),
    });
    // Solange nichts verloren geht, sieht der gefaelschte Beleg unauffaellig
    // aus. Sobald die Struktur-Beschaedigung den Pruefling Inhalt kosten
    // laesst, geht die Arithmetik des Belegs nicht mehr auf -- und weil der
    // Pruefling nichts gemeldet hat, ist das ein Verstoss, kein Werkzeugfehler.
    const structure = report.violations.find((entry) => entry.kind === "break_structure");
    expect(structure?.message).toContain("could not even be projected onto its own claim");
    expect(structure?.message).toContain("does not add up");
  });
});
