/**
 * `assertHonestUnderDamage` -- die E4-Absicherung gegen falsch behauptete
 * Vollstaendigkeit (E4-Absicherung, Teil 2).
 *
 * WAS DIESE HILFE PRUEFT. Fuer jede Beschaedigung des Eingangs gilt genau eine
 * von zwei Moeglichkeiten, und nur diese zwei:
 *
 *   (a) das Ergebnis meldet einen sichtbaren Befund -- Skip-Ledger-Eintrag,
 *       Diagnostic, Warnung, Qualitaetsabstufung oder ein geworfener Fehler;
 *   (b) das Ergebnis ist NACHWEISLICH unveraendert.
 *
 * Nicht erlaubt ist der dritte Fall: ein veraendertes Ergebnis ohne Befund.
 * Das ist die Fehlerklasse, die drei Wellen in Folge dominiert hat -- ein
 * Parser, der `"complete"` meldet, nachdem er einen Teilbaum verworfen hat;
 * ein Graph, der Aufloesungsrate 1 meldet, obwohl ein Ziel fehlt; ein Lauf,
 * der Erfolg meldet, nachdem das Werkzeug abgestuerzt ist. In allen drei
 * Faellen fehlt SICHTBAR nichts. Nur der Vergleich gegen den unbeschaedigten
 * Referenzlauf macht den Verlust sichtbar.
 *
 * DIE WICHTIGSTE ENTSCHEIDUNG: WAS "UNVERAENDERT" HEISST. Verglichen wird
 * nicht das rohe Ergebnis, sondern die {@link HonestyProbe.claim}-Projektion:
 * das, was das Ergebnis UEBER SEINEN EINGANG behauptet. Der Unterschied ist
 * entscheidend und war beim Bau dieser Hilfe der einzige echte Konstruktions-
 * konflikt:
 *
 *   Ein Chunker, der bei halbiertem Token-Budget dieselbe Datei in doppelt so
 *   viele Fragmente schneidet, liefert ein voellig anderes rohes Ergebnis --
 *   und hat trotzdem nichts verloren und nichts zu melden. Wer das rohe
 *   Ergebnis vergleicht, bekommt hier einen Fehlalarm und schaltet die Pruefung
 *   binnen einer Woche ab.
 *
 *   Ein Parser, der eine halbierte Datei sauber parst, liefert weniger
 *   Symbole -- ebenfalls ehrlich, denn der Eingang war kuerzer.
 *
 * Beide Faelle loesen sich, wenn `claim` das Ergebnis RELATIV ZUM EINGANG
 * projiziert: "welche Bytes dieses Eingangs sind nicht erfasst", "behauptet
 * das Ergebnis Vollstaendigkeit, und traegt es dafuer den Beleg". Diese
 * Projektion bleibt bei feinerer Aufteilung und bei kuerzerem Eingang gleich
 * und aendert sich genau dann, wenn wirklich etwas verloren ging. Der
 * natuerliche Rueckgabewert ist ein {@link CompletenessClaimV1} aus
 * `completeness.ts` -- siehe {@link completenessClaimProjection}.
 *
 * ZWEITE REGEL FUER `claim`, beim Anwenden auf context-artifacts gelernt und
 * teuer bezahlt: projiziere auf den UNGEMELDETEN Verlust, nicht auf den
 * Verlust. Ein Adapter, der eine Luecke ordnungsgemaess ins Skip-Ledger
 * schreibt, erfuellt E4 -- und die GROESSE dieser gemeldeten Luecke schrumpft
 * voellig zu Recht, wenn der Eingang kuerzer wird. Wer sie in die Projektion
 * nimmt, bekommt bei jeder Groessenbeschaedigung ein "veraendertes Ergebnis"
 * gemeldet, obwohl der Pruefling exakt das Richtige getan hat. Die
 * Projektion lautet also: "wie viel dieses Eingangs ist WEDER erfasst NOCH mit
 * Grund benannt" -- diese Zahl ist im gesunden Fall null und bleibt es unter
 * jeder ehrlichen Beschaedigung.
 *
 * E4 GILT AUCH FUER DIESE HILFE SELBST. Eine Ehrlichkeitspruefung, die
 * unbemerkt nur die Haelfte der Beschaedigungsarten ausfuehrt, waere selbst ein
 * Fall der Fehlerklasse, die sie sucht. Deshalb: jede Art aus
 * {@link DAMAGE_KINDS} muss entweder tatsaechlich ausgefuehrt werden oder in
 * {@link HonestyProbe.waivedDamageKinds} MIT Grund abbedungen sein. Fehlt
 * beides, schlaegt die Pruefung fehl -- auch wenn keine einzige Beschaedigung
 * eine Unehrlichkeit gefunden hat. Nicht anwendbare Faelle landen mit ihrem
 * Grund im {@link HonestyReport.skipLedger}.
 */
import { compareCodepoints, uniqueSortedByCodepoints } from "@untangle-code/domain";

import { stableStringify } from "../golden.js";

import type { CompletenessClaimV1 } from "./completeness.js";
import { assertCompletenessClaim } from "./completeness.js";
import type { DamageCase, DamageKind } from "./damage.js";
import { DAMAGE_KINDS, isDamageNotApplicable } from "./damage.js";
import type { VisibleFinding } from "./finding.js";
import { findingFromThrown, newFindings } from "./finding.js";

/** Eine abbedungene Beschaedigungsart mit Grund. */
export interface DamageWaiver {
  readonly kind: DamageKind;
  /** Warum diese Art hier nicht geprueft wird; MUSS nicht leer sein (E4). */
  readonly reason: string;
}

/** Ein Pruefling samt allem, was zum Urteil noetig ist. */
export interface HonestyProbe<TInput, TOutput> {
  /** Name des Prueflings; erscheint im Bericht. */
  readonly name: string;
  /** Die gesunde Referenzeingabe. */
  readonly input: TInput;
  /** Die Funktion unter Test. Darf synchron oder asynchron sein. */
  readonly run: (input: TInput) => TOutput | Promise<TOutput>;
  /**
   * Die Projektion des Ergebnisses AUF SEINEN EINGANG -- siehe der ausfuehrliche
   * Modulkommentar oben. Muss deterministisch und JSON-serialisierbar sein.
   */
  readonly claim: (result: TOutput, input: TInput) => unknown;
  /** Alles, was das Ergebnis sichtbar gemeldet hat. */
  readonly findings: (result: TOutput, input: TInput) => readonly VisibleFinding[];
  readonly damages: readonly DamageCase<TInput, TOutput>[];
  /** Beschaedigungsarten, die hier bewusst nicht geprueft werden -- mit Grund. */
  readonly waivedDamageKinds?: readonly DamageWaiver[];
}

/** Urteil ueber einen einzelnen Beschaedigungsfall. */
export const HONESTY_VERDICTS = [
  /** Ergebnis nachweislich unveraendert -- erlaubt. */
  "unchanged",
  /** Ergebnis veraendert, aber mit neuem sichtbaren Befund -- erlaubt. */
  "reported",
  /** Aufruf hat geworfen oder abgelehnt -- die lauteste Meldung, erlaubt. */
  "reported_by_throwing",
  /** Beschaedigung auf diesen Pruefling nicht anwendbar -- mit Grund im Ledger. */
  "not_applicable",
  /** Ergebnis veraendert, nichts gemeldet -- DIE Fehlerklasse. */
  "dishonest",
] as const;

export type HonestyVerdict = (typeof HONESTY_VERDICTS)[number];

/** Ergebnis eines einzelnen Beschaedigungsfalls. */
export interface HonestyCaseResult {
  readonly damageId: string;
  readonly kind: DamageKind;
  readonly detail: string;
  readonly verdict: HonestyVerdict;
  /** Begruendung des Urteils, menschenlesbar. */
  readonly message: string;
  /** Befunde, die der beschaedigte Lauf zusaetzlich gemeldet hat. */
  readonly newFindings: readonly VisibleFinding[];
  /** Projektion vor der Beschaedigung; nur gesetzt, wenn sie sich geaendert hat. */
  readonly claimBefore?: string;
  /** Projektion nach der Beschaedigung; nur gesetzt, wenn sie sich geaendert hat. */
  readonly claimAfter?: string;
}

/** Ein bewusst ausgelassener Pruefpunkt -- das E4-Ledger dieser Hilfe. */
export interface HonestySkipEntry {
  readonly kind: DamageKind;
  /** Kennung des Falls, oder `"(no case)"`, wenn die Art gar nicht gebaut wurde. */
  readonly damageId: string;
  readonly reason: string;
}

/** Gesamtbericht eines Prueflings. */
export interface HonestyReport {
  readonly probe: string;
  readonly cases: readonly HonestyCaseResult[];
  readonly skipLedger: readonly HonestySkipEntry[];
  /** Faelle mit Urteil `"dishonest"`. */
  readonly violations: readonly HonestyCaseResult[];
  /** Beschaedigungsarten, die weder ausgefuehrt noch abbedungen wurden (E4). */
  readonly uncoveredKinds: readonly DamageKind[];
  /** Weitere Maengel am Pruefling selbst (doppelte Kennungen, leere Gruende). */
  readonly probeIssues: readonly string[];
}

/** Fehler, den {@link assertHonestUnderDamage} bei einem Verstoss wirft. */
export class HonestyViolationError extends Error {
  override readonly name = "HonestyViolationError";
  readonly report: HonestyReport;

  constructor(report: HonestyReport) {
    super(formatHonestyReport(report));
    this.report = report;
  }
}

/**
 * Fertige {@link HonestyProbe.claim}-Projektion fuer Prueflinge, die ohnehin
 * einen {@link CompletenessClaimV1} liefern: sie prueft den Beleg (ein
 * gefaelschtes `"complete"` faellt hier auf) und projiziert auf Stufe, Einheit
 * und die GRUENDE der Auslassungen.
 *
 * ABSOLUTE MENGEN GEHEN BEWUSST NICHT EIN, und das war der einzige Punkt, an
 * dem die erste Fassung dieser Hilfe reihenweise Fehlalarme produzierte: eine
 * halbierte Datei hat halb so viele Bytes, eine 200-fach wiederholte Datei
 * 200-mal so viele. Wer `expected`/`accountedFor` in den Vergleich nimmt,
 * bekommt bei JEDER Groessenbeschaedigung ein "veraendertes Ergebnis" gemeldet,
 * obwohl der Pruefling voellig ehrlich war -- und schaltet die Pruefung
 * daraufhin ab. Die Ehrlichkeitsfrage lautet nicht "wie viele Bytes", sondern
 * "wurde alles erfasst, und wenn nicht, mit welcher Begruendung". Genau das
 * und nur das steht hier drin.
 *
 * Die Befundliste bleibt ebenfalls draussen: Befunde werden getrennt und als
 * Multimenge verglichen (siehe `finding.ts`).
 */
export function completenessClaimProjection(claim: CompletenessClaimV1, label: string): unknown {
  const verified = assertCompletenessClaim(claim, label);
  return {
    level: verified.level,
    unit: verified.evidence.unit,
    fullyAccountedFor: verified.evidence.accountedFor === verified.evidence.expected,
    omissionReasons: uniqueSortedByCodepoints(
      verified.evidence.omissions.map((omission) => omission.reason),
    ),
  };
}

function validateProbe<TInput, TOutput>(probe: HonestyProbe<TInput, TOutput>): string[] {
  const issues: string[] = [];
  if (probe.name.trim() === "") {
    issues.push("probe has an empty name");
  }
  const seen = new Set<string>();
  for (const damage of probe.damages) {
    if (damage.id.trim() === "") {
      issues.push(`damage case of kind "${damage.kind}" has an empty id`);
      continue;
    }
    if (seen.has(damage.id)) {
      issues.push(`duplicate damage id "${damage.id}" -- ids must be unique per probe`);
    }
    seen.add(damage.id);
    if (damage.detail.trim() === "") {
      issues.push(`damage case "${damage.id}" has an empty detail (E4)`);
    }
  }
  const waivedKinds = new Set<DamageKind>();
  for (const waiver of probe.waivedDamageKinds ?? []) {
    if (waiver.reason.trim() === "") {
      issues.push(`waiver for damage kind "${waiver.kind}" has an empty reason (E4)`);
    }
    if (waivedKinds.has(waiver.kind)) {
      issues.push(`damage kind "${waiver.kind}" is waived more than once`);
    }
    waivedKinds.add(waiver.kind);
  }
  return issues;
}

async function projectionOf<TInput, TOutput>(
  probe: HonestyProbe<TInput, TOutput>,
  result: TOutput,
  input: TInput,
): Promise<string> {
  return await Promise.resolve(stableStringify(probe.claim(result, input)));
}

/**
 * Fuehrt jede Beschaedigung aus und faellt je Fall ein Urteil, ohne zu werfen.
 * Fuer Aufrufer, die den Bericht selbst auswerten wollen; der uebliche
 * Einstieg ist {@link assertHonestUnderDamage}.
 */
export async function runHonestyProbe<TInput, TOutput>(
  probe: HonestyProbe<TInput, TOutput>,
): Promise<HonestyReport> {
  const probeIssues = validateProbe(probe);
  const run = async (input: TInput): Promise<TOutput> => await Promise.resolve(probe.run(input));

  // Referenzlauf. Er MUSS gelingen -- eine Ehrlichkeitspruefung gegen einen
  // bereits fehlschlagenden Referenzlauf hat keine Aussagekraft.
  let baseline: TOutput;
  try {
    baseline = await run(probe.input);
  } catch (error) {
    throw new Error(
      `honesty probe "${probe.name}": the undamaged baseline run must succeed, but it threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const baselineClaim = await projectionOf(probe, baseline, probe.input);
  const baselineFindings = probe.findings(baseline, probe.input);

  // Determinismuspruefung: ohne einen stabilen Referenzlauf waere jedes
  // "veraendert"-Urteil unten wertlos (Repo-Regel: Determinismus ist Pflicht).
  const baselineAgain = await run(probe.input);
  const baselineClaimAgain = await projectionOf(probe, baselineAgain, probe.input);
  if (baselineClaimAgain !== baselineClaim) {
    probeIssues.push(
      `the undamaged run is not deterministic: two identical invocations produced different claims\n--- first\n${baselineClaim}\n--- second\n${baselineClaimAgain}`,
    );
  }

  const cases: HonestyCaseResult[] = [];
  const skipLedger: HonestySkipEntry[] = [];
  const exercised = new Set<DamageKind>();

  for (const damage of probe.damages) {
    let damagedInput = probe.input;
    let result: TOutput;
    let thrown: unknown;
    let threw = false;

    if (damage.mode === "input") {
      const produced = damage.damage(probe.input);
      if (isDamageNotApplicable(produced)) {
        cases.push({
          damageId: damage.id,
          kind: damage.kind,
          detail: damage.detail,
          verdict: "not_applicable",
          message: produced.reason,
          newFindings: [],
        });
        skipLedger.push({ kind: damage.kind, damageId: damage.id, reason: produced.reason });
        continue;
      }
      damagedInput = produced;
      try {
        result = await run(damagedInput);
      } catch (error) {
        threw = true;
        thrown = error;
        result = baseline;
      }
    } else {
      let produced: TOutput | { readonly notApplicable: true; readonly reason: string };
      try {
        produced = await damage.invoke(run, probe.input);
      } catch (error) {
        threw = true;
        thrown = error;
        produced = baseline;
      }
      if (!threw && isDamageNotApplicable(produced)) {
        cases.push({
          damageId: damage.id,
          kind: damage.kind,
          detail: damage.detail,
          verdict: "not_applicable",
          message: produced.reason,
          newFindings: [],
        });
        skipLedger.push({ kind: damage.kind, damageId: damage.id, reason: produced.reason });
        continue;
      }
      result = produced as TOutput;
    }

    exercised.add(damage.kind);

    if (threw) {
      const finding = findingFromThrown(thrown);
      cases.push({
        damageId: damage.id,
        kind: damage.kind,
        detail: damage.detail,
        verdict: "reported_by_throwing",
        message: `the damaged run failed loudly instead of claiming success -- ${finding.detail}`,
        newFindings: [finding],
      });
      continue;
    }

    let damagedClaim: string;
    let damagedFindings: readonly VisibleFinding[];
    try {
      damagedClaim = await projectionOf(probe, result, damagedInput);
      damagedFindings = probe.findings(result, damagedInput);
    } catch (error) {
      // Die Projektion selbst hat den Verstoss entdeckt (z. B. ein
      // `CompletenessClaimV1`, dessen Beleg seine Stufe nicht traegt). Das ist
      // ein Befund, kein Werkzeugfehler -- aber ein NICHT vom Pruefling
      // gemeldeter, also ein Verstoss.
      cases.push({
        damageId: damage.id,
        kind: damage.kind,
        detail: damage.detail,
        verdict: "dishonest",
        message: `the result could not even be projected onto its own claim: ${
          error instanceof Error ? error.message : String(error)
        }`,
        newFindings: [],
      });
      continue;
    }

    const added = newFindings(baselineFindings, damagedFindings);
    if (damagedClaim === baselineClaim) {
      cases.push({
        damageId: damage.id,
        kind: damage.kind,
        detail: damage.detail,
        verdict: "unchanged",
        message: "the result's claim about its input is byte-identical to the undamaged run",
        newFindings: added,
      });
      continue;
    }
    if (added.length > 0) {
      cases.push({
        damageId: damage.id,
        kind: damage.kind,
        detail: damage.detail,
        verdict: "reported",
        message: `the claim changed and ${String(added.length)} new finding(s) say why`,
        newFindings: added,
        claimBefore: baselineClaim,
        claimAfter: damagedClaim,
      });
      continue;
    }
    cases.push({
      damageId: damage.id,
      kind: damage.kind,
      detail: damage.detail,
      verdict: "dishonest",
      message:
        "the result changed but nothing was reported -- silently changed output is exactly the E4 failure class",
      newFindings: [],
      claimBefore: baselineClaim,
      claimAfter: damagedClaim,
    });
  }

  // E4 fuer die Pruefung selbst: jede Art ausgefuehrt oder mit Grund abbedungen.
  const waivers = new Map<DamageKind, string>();
  for (const waiver of probe.waivedDamageKinds ?? []) {
    waivers.set(waiver.kind, waiver.reason);
  }
  const uncoveredKinds: DamageKind[] = [];
  for (const kind of DAMAGE_KINDS) {
    const waiver = waivers.get(kind);
    if (exercised.has(kind)) {
      if (waiver !== undefined) {
        probeIssues.push(
          `damage kind "${kind}" is waived ("${waiver}") but was also exercised -- the waiver is a false ledger entry`,
        );
      }
      continue;
    }
    if (waiver !== undefined) {
      skipLedger.push({ kind, damageId: "(no case)", reason: waiver });
      continue;
    }
    uncoveredKinds.push(kind);
  }

  skipLedger.sort(
    (a, b) => compareCodepoints(a.kind, b.kind) || compareCodepoints(a.damageId, b.damageId),
  );

  return {
    probe: probe.name,
    cases,
    skipLedger,
    violations: cases.filter((entry) => entry.verdict === "dishonest"),
    uncoveredKinds,
    probeIssues,
  };
}

/** Menschenlesbarer Bericht; auch die Fehlermeldung von {@link HonestyViolationError}. */
export function formatHonestyReport(report: HonestyReport): string {
  const lines: string[] = [`honesty probe "${report.probe}"`];
  for (const entry of report.cases) {
    lines.push(`  [${entry.verdict}] ${entry.kind}/${entry.damageId}: ${entry.message}`);
    if (entry.claimBefore !== undefined && entry.claimAfter !== undefined) {
      lines.push(`      claim before damage:\n${indent(entry.claimBefore, 8)}`);
      lines.push(`      claim after damage:\n${indent(entry.claimAfter, 8)}`);
    }
  }
  if (report.skipLedger.length > 0) {
    lines.push("  skip ledger (E4 -- nothing skipped without a reason):");
    for (const entry of report.skipLedger) {
      lines.push(`    ${entry.kind}/${entry.damageId}: ${entry.reason}`);
    }
  }
  for (const kind of report.uncoveredKinds) {
    lines.push(
      `  [E4] damage kind "${kind}" was neither exercised nor waived with a reason -- an honesty probe that quietly checks less than it claims is itself the failure class it hunts`,
    );
  }
  for (const issue of report.probeIssues) {
    lines.push(`  [probe] ${issue}`);
  }
  return lines.join("\n");
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line === "" ? line : `${pad}${line}`))
    .join("\n");
}

/**
 * Fuehrt die Ehrlichkeitspruefung aus und wirft, wenn irgendein Fall
 * unehrlich war, eine Beschaedigungsart unbegruendet fehlt oder der Pruefling
 * selbst mangelhaft ist. Der geworfene Fehler enthaelt den vollstaendigen
 * Bericht.
 */
export async function assertHonestUnderDamage<TInput, TOutput>(
  probe: HonestyProbe<TInput, TOutput>,
): Promise<HonestyReport> {
  const report = await runHonestyProbe(probe);
  if (
    report.violations.length > 0 ||
    report.uncoveredKinds.length > 0 ||
    report.probeIssues.length > 0
  ) {
    throw new HonestyViolationError(report);
  }
  return report;
}
