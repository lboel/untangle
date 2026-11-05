/**
 * Vollstaendigkeitsaussagen, die ihren Beleg mitfuehren (E4, strukturell).
 *
 * DAS PROBLEM. Drei Wellen in Folge dominierte dieselbe Fehlerklasse: nicht
 * "es fehlen Bytes", sondern "es wird Vollstaendigkeit BEHAUPTET, die nicht
 * belegt ist" -- ein Parser meldet `"complete"`, nachdem er einen Teilbaum
 * verworfen hat; ein Graph meldet Aufloesungsrate 1, obwohl ein Ziel nicht
 * existiert; ein Lauf meldet Erfolg, nachdem das Werkzeug abgestuerzt ist. In
 * allen Faellen fehlt nichts SICHTBAR. Die Abdeckungspruefung
 * (`covered` vereinigt `excluded` gleich vollstaendiger Dateibereich) findet
 * das nicht, weil es eine Luecke gar nicht gibt -- die Luecke ist im Anspruch,
 * nicht in den Daten.
 *
 * DIE ANTWORT (Vorbild: `ExternalNumberV1` in `packages/domain`, X3). Dort ist
 * eine externe Zahl ein eigener Objekttyp, sodass sie strukturell nicht als
 * Untangle-Metrik durchgehen kann. Hier ist die Entsprechung:
 * `"complete"` ist KEIN Wert, den ein Erzeuger setzen kann. Es gibt genau eine
 * Tuer, {@link claimCompleteness}, und die nimmt ausschliesslich den BELEG
 * entgegen -- was war zu erfassen, was wurde erfasst, was wurde mit welchem
 * Grund ausgelassen, was wurde gemeldet. Die Stufe `"complete"` wird daraus
 * ABGELEITET, nie uebergeben. Ein Erzeuger, der luegen will, muss dafuer den
 * Beleg faelschen; ein Beleg, dessen Arithmetik nicht aufgeht
 * (`accountedFor + Summe(omissions) !== expected`), wird abgelehnt.
 *
 * WIE WEIT TRAEGT DAS TYPSYSTEM -- EHRLICH BEANTWORTET. TypeScript erzwingt
 * hiervon einen Teil sauber und einen Teil gar nicht:
 *
 *   ERZWUNGEN. {@link CompletenessClaimV1} traegt eine PFLICHT-Eigenschaft
 *   unter einem `unique symbol`, das dieses Modul nicht exportiert. Ein
 *   Objektliteral, ein Spread, ein `Object.assign`, ein Rueckgabewert aus
 *   fremdem Code kann diesen Schluessel nicht benennen -- jeder Versuch,
 *   `{ level: "complete", ... }` als `CompletenessClaimV1` zu uebergeben, ist
 *   ein Uebersetzungsfehler. Das ist echte strukturelle Nicht-Faelschbarkeit
 *   und geht ueber `ExternalNumberV1` hinaus, dessen Marke optional ist.
 *
 *   NICHT ERZWUNGEN. `as CompletenessClaimV1`, `as unknown as ...`, `any` und
 *   ein `JSON.parse`-Ergebnis, das jemand als Anspruch typisiert, umgehen jede
 *   Nominal-Marke. TypeScript hat keine Zusicherung, die eine Typumdeutung
 *   verbietet. Wer etwas anderes behauptet, hat es nicht versucht.
 *
 * Deshalb -- und nur deshalb -- hat dieses Modul zwei weitere Schichten:
 *
 *   LAUFZEIT. {@link verifyCompletenessClaim} rechnet die Stufe aus dem
 *   mitgefuehrten Beleg NEU aus und vergleicht sie mit der behaupteten. Ein
 *   per `as` gefaelschter oder aus JSON eingeschleuster Anspruch faellt beim
 *   ersten Lesen auf, weil {@link completenessLevelOf} -- die einzige
 *   vorgesehene Lesefunktion -- vorher prueft. Ein Anspruch aus fremder Quelle
 *   betritt das System nur ueber {@link parseCompletenessClaim}, das die Stufe
 *   ebenfalls neu ableitet und eine mitgelieferte verwirft.
 *
 *   LINT. Die Regel `packages/testkit/eslint/no-forged-completeness.js`
 *   verbietet genau die Umgehungen, die der Typ nicht abfangen kann:
 *   Typumdeutungen auf `CompletenessClaimV1` und das direkte Setzen von
 *   `level:` in einem Objektliteral.
 *
 * Die drei Schichten zusammen sind die staerkste ehrliche Antwort: der Typ
 * verhindert das Versehen, die Laufzeit verhindert die Wirkung, der Linter
 * macht den Vorsatz sichtbar.
 */
import { compareCodepoints } from "@untangle-code/domain";

import type { VisibleFinding } from "./finding.js";

// ---------------------------------------------------------------------------
// Marke
// ---------------------------------------------------------------------------

/**
 * Nur zur Uebersetzungszeit vorhanden und bewusst NICHT exportiert: ausserhalb
 * dieses Moduls laesst sich der Schluessel nicht benennen, also auch kein
 * Objektliteral bauen, das {@link CompletenessClaimV1} erfuellt.
 */
declare const COMPLETENESS_WITNESS: unique symbol;

/** Laufzeitmarker; ueberlebt `JSON.stringify` (das `unique symbol` nicht). */
export const COMPLETENESS_WITNESS_TAG = "untangle.completeness.v1";

// ---------------------------------------------------------------------------
// Beleg
// ---------------------------------------------------------------------------

/** Eine Auslassung mit Grund. Menge ohne Grund gibt es nicht (E4). */
export interface CompletenessOmissionV1 {
  /** Menge in der Einheit des Belegs, echt groesser als 0. */
  readonly amount: number;
  /** Warum diese Menge nicht erfasst wurde; MUSS nicht leer sein. */
  readonly reason: string;
}

/**
 * Der Beleg einer Vollstaendigkeitsaussage.
 *
 * `expected`, `accountedFor` und die `omissions` sind bewusst blosse Mengen in
 * einer frei benannten `unit` (z. B. `"bytes"`, `"regions"`, `"edges"`): der
 * Anspruch soll fuer Parser, Chunker, Graphen und Suche dieselbe Form haben.
 * Was die Einheit bedeutet, sagt der Erzeuger; dass die Arithmetik aufgeht,
 * prueft dieses Modul.
 */
export interface CompletenessEvidenceV1 {
  readonly schemaVersion: 1;
  readonly unit: string;
  /** Gesamtmenge, die zu erfassen war. */
  readonly expected: number;
  /** Davon tatsaechlich erfasst. */
  readonly accountedFor: number;
  /** Der Rest, aufgeschluesselt nach Gruenden; nach Grund/Menge sortiert. */
  readonly omissions: readonly CompletenessOmissionV1[];
  /** Was die Stufe sichtbar gemeldet hat. */
  readonly findings: readonly VisibleFinding[];
}

/** Eingabe fuer {@link buildCompletenessEvidence}. */
export interface CompletenessEvidenceInput {
  readonly unit: string;
  readonly expected: number;
  readonly accountedFor: number;
  readonly omissions?: readonly CompletenessOmissionV1[];
  readonly findings?: readonly VisibleFinding[];
}

// ---------------------------------------------------------------------------
// Anspruch
// ---------------------------------------------------------------------------

export const COMPLETENESS_LEVELS = ["complete", "partial", "failed"] as const;

export type CompletenessLevel = (typeof COMPLETENESS_LEVELS)[number];

/**
 * Eine Vollstaendigkeitsaussage samt Beleg.
 *
 * Ausserhalb dieses Moduls nicht konstruierbar: die Pflichteigenschaft unter
 * {@link COMPLETENESS_WITNESS} traegt einen nicht exportierten `unique symbol`
 * als Schluessel. `level` ist absichtlich lesbar, aber niemals setzbar.
 */
export interface CompletenessClaimV1 {
  readonly schemaVersion: 1;
  /** Laufzeitmarker (der Symbolschluessel ueberlebt keine Serialisierung). */
  readonly completenessWitness: typeof COMPLETENESS_WITNESS_TAG;
  /** Worauf sich der Anspruch bezieht, z. B. ein Dateipfad. */
  readonly subject: string;
  /** ABGELEITET aus `evidence` -- nie uebergeben. */
  readonly level: CompletenessLevel;
  readonly evidence: CompletenessEvidenceV1;
  /** Nur zur Uebersetzungszeit vorhanden; nie serialisiert. */
  readonly [COMPLETENESS_WITNESS]: true;
}

/** Fehler beim Bauen oder Pruefen einer Vollstaendigkeitsaussage. */
export class CompletenessClaimError extends Error {
  override readonly name = "CompletenessClaimError";
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(issues.length === 0 ? message : `${message}: ${issues.join("; ")}`);
    this.issues = issues;
  }
}

/**
 * Kanaele, auf denen ein Befund die Stufe `"complete"` ausschliesst.
 *
 * `diagnostic` und `warning` tun das NICHT: ein Parser darf eine Warnung
 * ausgeben und trotzdem alles erfasst haben. Ein Skip-Ledger-Eintrag, eine
 * Qualitaetsabstufung oder ein Fehler widersprechen dagegen der Aussage
 * "nichts ausgelassen" unmittelbar.
 */
const BLOCKING_CHANNELS: ReadonlySet<string> = new Set([
  "skip_ledger",
  "quality_downgrade",
  "error",
]);

function assertFiniteAmount(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new CompletenessClaimError(`"${label}" must be a finite number, got ${String(value)}`);
  }
  if (value < 0) {
    throw new CompletenessClaimError(`"${label}" must not be negative, got ${String(value)}`);
  }
}

/** Deterministische Reihenfolge der Auslassungen: Grund nach Codepoints, dann Menge. */
function compareOmissions(a: CompletenessOmissionV1, b: CompletenessOmissionV1): number {
  const byReason = compareCodepoints(a.reason, b.reason);
  if (byReason !== 0) {
    return byReason;
  }
  return a.amount === b.amount ? 0 : a.amount < b.amount ? -1 : 1;
}

/**
 * Baut einen Beleg und lehnt jeden ab, dessen Arithmetik nicht aufgeht.
 *
 * Das ist die erste Haelfte der strukturellen Absicherung: eine Aussage, deren
 * Zahlen sich nicht zu `expected` addieren, entsteht gar nicht erst -- sie
 * kann also auch nicht als `"complete"` abgeleitet werden.
 */
export function buildCompletenessEvidence(
  input: CompletenessEvidenceInput,
): CompletenessEvidenceV1 {
  if (input.unit.trim() === "") {
    throw new CompletenessClaimError("completeness evidence must name a non-empty unit");
  }
  assertFiniteAmount(input.expected, "expected");
  assertFiniteAmount(input.accountedFor, "accountedFor");

  const omissions = [...(input.omissions ?? [])];
  for (const [index, omission] of omissions.entries()) {
    assertFiniteAmount(omission.amount, `omissions[${String(index)}].amount`);
    if (omission.amount <= 0) {
      throw new CompletenessClaimError(
        `omissions[${String(index)}] must omit a positive amount, got ${String(omission.amount)}`,
      );
    }
    if (omission.reason.trim() === "") {
      throw new CompletenessClaimError(
        `omissions[${String(index)}] must carry a non-empty reason (E4)`,
      );
    }
  }

  const omitted = omissions.reduce((sum, omission) => sum + omission.amount, 0);
  if (input.accountedFor + omitted !== input.expected) {
    throw new CompletenessClaimError(
      `completeness evidence does not add up: accountedFor ${String(input.accountedFor)} + omitted ${String(
        omitted,
      )} != expected ${String(input.expected)} (unit "${input.unit}")`,
    );
  }

  return {
    schemaVersion: 1,
    unit: input.unit,
    expected: input.expected,
    accountedFor: input.accountedFor,
    omissions: omissions.sort(compareOmissions),
    findings: [...(input.findings ?? [])],
  };
}

/**
 * Leitet die Stufe AUS dem Beleg ab. Die einzige Stelle im Repository, an der
 * der Wert `"complete"` entsteht.
 */
export function deriveCompletenessLevel(evidence: CompletenessEvidenceV1): CompletenessLevel {
  const blocking = evidence.findings.filter((finding) => BLOCKING_CHANNELS.has(finding.channel));
  if (evidence.expected > 0 && evidence.accountedFor === 0) {
    return "failed";
  }
  if (
    evidence.omissions.length === 0 &&
    evidence.accountedFor === evidence.expected &&
    blocking.length === 0
  ) {
    return "complete";
  }
  return "partial";
}

/**
 * DIE einzige Tuer zu einer Vollstaendigkeitsaussage.
 *
 * Nimmt den Beleg, prueft ihn, leitet die Stufe ab. Es gibt bewusst keinen
 * Parameter, mit dem ein Aufrufer `"complete"` verlangen koennte.
 */
export function claimCompleteness(input: {
  readonly subject: string;
  readonly evidence: CompletenessEvidenceInput | CompletenessEvidenceV1;
}): CompletenessClaimV1 {
  if (input.subject.trim() === "") {
    throw new CompletenessClaimError("completeness claim must name a non-empty subject");
  }
  const evidence = buildCompletenessEvidence(input.evidence);
  return {
    schemaVersion: 1,
    completenessWitness: COMPLETENESS_WITNESS_TAG,
    subject: input.subject,
    level: deriveCompletenessLevel(evidence),
    evidence,
  } as CompletenessClaimV1;
  // Die Typumdeutung ist hier unvermeidbar und bewusst auf diese eine Zeile
  // beschraenkt: der Symbolschluessel existiert nur im Typraum, also kann kein
  // Laufzeitobjekt ihn tragen. Genau deshalb verbietet die ESLint-Regel
  // `no-forged-completeness` dieselbe Umdeutung ueberall SONST.
}

// ---------------------------------------------------------------------------
// Pruefen und Lesen
// ---------------------------------------------------------------------------

/** Typwaechter anhand des Laufzeitmarkers (auch fuer JSON aus fremder Quelle). */
export function isCompletenessClaim(value: unknown): value is CompletenessClaimV1 {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<CompletenessClaimV1>;
  return (
    candidate.completenessWitness === COMPLETENESS_WITNESS_TAG &&
    typeof candidate.subject === "string" &&
    typeof candidate.level === "string" &&
    typeof candidate.evidence === "object" &&
    candidate.evidence !== null
  );
}

/**
 * Rechnet die Stufe aus dem mitgefuehrten Beleg neu aus und meldet jede
 * Abweichung. Leeres Ergebnis heisst: der Anspruch traegt seinen Beleg.
 *
 * Das ist die Laufzeitschicht gegen die eine Luecke, die der Typ nicht
 * schliessen kann (`as CompletenessClaimV1`, JSON aus fremder Quelle).
 */
export function verifyCompletenessClaim(value: unknown): readonly string[] {
  if (!isCompletenessClaim(value)) {
    return ["value is not a completeness claim (missing or wrong runtime witness)"];
  }
  const issues: string[] = [];
  let evidence: CompletenessEvidenceV1;
  try {
    evidence = buildCompletenessEvidence(value.evidence);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const derived = deriveCompletenessLevel(evidence);
  if (derived !== value.level) {
    issues.push(
      `claims level "${value.level}" but its own evidence derives "${derived}" (accountedFor ${String(
        evidence.accountedFor,
      )}/${String(evidence.expected)} ${evidence.unit}, ${String(
        evidence.omissions.length,
      )} omission(s), ${String(evidence.findings.length)} finding(s))`,
    );
  }
  if (value.subject.trim() === "") {
    issues.push("subject is empty");
  }
  return issues;
}

/** Wie {@link verifyCompletenessClaim}, wirft aber statt zu melden. */
export function assertCompletenessClaim(value: unknown, label: string): CompletenessClaimV1 {
  const issues = verifyCompletenessClaim(value);
  if (issues.length > 0) {
    throw new CompletenessClaimError(`"${label}" is not a truthful completeness claim`, issues);
  }
  return value as CompletenessClaimV1;
}

/**
 * DIE vorgesehene Lesefunktion. Prueft den Beleg, bevor sie die Stufe
 * herausgibt -- ein gefaelschter Anspruch faellt hier auf, nicht spaeter.
 */
export function completenessLevelOf(claim: CompletenessClaimV1, label: string): CompletenessLevel {
  return assertCompletenessClaim(claim, label).level;
}

/**
 * Waechter fuer Pfade, die echte Vollstaendigkeit voraussetzen (Gegenstueck zu
 * `assertUntangleMetricNumber` in `packages/domain`).
 */
export function requireComplete(claim: CompletenessClaimV1, label: string): CompletenessClaimV1 {
  const verified = assertCompletenessClaim(claim, label);
  if (verified.level !== "complete") {
    throw new CompletenessClaimError(
      `"${label}" requires a complete result, got "${verified.level}" (${formatCompletenessClaim(verified)})`,
    );
  }
  return verified;
}

/**
 * Baut einen Anspruch aus fremden Daten (JSON, Nutzereingabe) neu auf. Eine
 * mitgelieferte `level`-Angabe wird VERWORFEN und neu abgeleitet -- ein
 * serialisiertes `"complete"` ueberlebt die Grenze nicht.
 */
export function parseCompletenessClaim(value: unknown, label: string): CompletenessClaimV1 {
  if (typeof value !== "object" || value === null) {
    throw new CompletenessClaimError(`"${label}" is not an object`);
  }
  const candidate = value as { subject?: unknown; evidence?: unknown };
  if (typeof candidate.subject !== "string") {
    throw new CompletenessClaimError(`"${label}" has no string subject`);
  }
  if (typeof candidate.evidence !== "object" || candidate.evidence === null) {
    throw new CompletenessClaimError(`"${label}" carries no evidence object`);
  }
  return claimCompleteness({
    subject: candidate.subject,
    evidence: candidate.evidence as CompletenessEvidenceInput,
  });
}

/** Kurze Anzeigeform, z. B. fuer Fehlermeldungen und Logs. */
export function formatCompletenessClaim(claim: CompletenessClaimV1): string {
  const { evidence } = claim;
  const omissions =
    evidence.omissions.length === 0
      ? "no omissions"
      : evidence.omissions
          .map((omission) => `${String(omission.amount)} ${evidence.unit} (${omission.reason})`)
          .join(", ");
  return `${claim.subject}: ${claim.level} -- ${String(evidence.accountedFor)}/${String(
    evidence.expected,
  )} ${evidence.unit} accounted for; ${omissions}`;
}
