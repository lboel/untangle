/**
 * Sichtbare Befunde (E4).
 *
 * E4 verlangt: nichts wird stillschweigend uebersprungen. Die bestehenden
 * Mechanismen des Repositorys pruefen, ob BYTES fehlen (Abdeckungspruefung:
 * `covered` vereinigt `excluded` gleich vollstaendiger Dateibereich). Sie
 * pruefen NICHT, ob eine Stufe faelschlich Vollstaendigkeit BEHAUPTET.
 *
 * Dieses Modul definiert die kleinste gemeinsame Form, in der eine Stufe einen
 * Befund sichtbar macht -- egal ob sie ihn als Skip-Ledger-Eintrag, als
 * Parser-Diagnostic, als Warnung oder als geworfenen Fehler ausdrueckt. Erst
 * dadurch kann `assertHonestUnderDamage` (siehe `assert-honest.ts`) ueber alle
 * Pakete hinweg dieselbe Frage stellen: hat das Ergebnis etwas gemeldet?
 *
 * Ein Befund ohne Begruendung ist kein Befund: {@link makeFinding} lehnt einen
 * leeren `detail` ab, genau wie `buildSkipLedgerEntry` in
 * `@untangle-code/domain` es fuer das Skip-Ledger tut.
 */
import type { ParseDiagnostic, SkipLedgerEntryV1 } from "@untangle-code/domain";

/**
 * Kanaele, ueber die eine Stufe einen Befund sichtbar machen kann. Geschlossen,
 * damit Befunde zaehlbar und vergleichbar bleiben (wie `SKIP_REASONS`).
 */
export const FINDING_CHANNELS = [
  /** Eintrag im Skip-Ledger (`SkipLedgerEntryV1` oder eine paketeigene Entsprechung). */
  "skip_ledger",
  /** Parser-/Analyse-Diagnostic mit Quellbereich. */
  "diagnostic",
  /** Warnung ohne Quellbereich (Logger, Reporter). */
  "warning",
  /** Geworfener oder abgelehnter Fehler -- die lauteste Form eines Befunds. */
  "error",
  /**
   * Selbstauskunft ueber verminderte Qualitaet, z. B. `parseQuality: "partial"`
   * oder ein `CompletenessClaimV1` unterhalb von `"complete"`. Der Wert selbst
   * IST der Befund.
   */
  "quality_downgrade",
] as const;

export type FindingChannel = (typeof FINDING_CHANNELS)[number];

/** Ein sichtbar gemachter Befund. */
export interface VisibleFinding {
  readonly channel: FindingChannel;
  /** Menschenlesbare Begruendung; MUSS nicht leer sein -- das ist der Kern von E4. */
  readonly detail: string;
}

/** Erzeugt einen Befund und lehnt eine leere Begruendung ab. */
export function makeFinding(channel: FindingChannel, detail: string): VisibleFinding {
  if (detail.trim() === "") {
    throw new Error(`visible finding on channel "${channel}" must carry a non-empty detail (E4)`);
  }
  return { channel, detail };
}

/** Uebersetzt Skip-Ledger-Eintraege in Befunde. */
export function findingsFromSkipLedger(
  entries: readonly SkipLedgerEntryV1[],
): readonly VisibleFinding[] {
  return entries.map((entry) =>
    makeFinding(
      "skip_ledger",
      `${entry.stage}/${entry.subjectKind}/${entry.reason} ${
        entry.subjectId ?? entry.path ?? "(no subject)"
      }: ${entry.detail}`,
    ),
  );
}

/** Uebersetzt Parser-Diagnostics in Befunde. */
export function findingsFromDiagnostics(
  diagnostics: readonly ParseDiagnostic[],
): readonly VisibleFinding[] {
  return diagnostics.map((diagnostic) =>
    makeFinding(
      "diagnostic",
      `${diagnostic.severity}/${diagnostic.kind} @${String(diagnostic.range.startByte)}..${String(
        diagnostic.range.endByte,
      )}: ${diagnostic.message}`,
    ),
  );
}

/** Uebersetzt einen geworfenen Wert in einen Befund; ein Fehler ist immer sichtbar. */
export function findingFromThrown(thrown: unknown): VisibleFinding {
  if (thrown instanceof Error) {
    const code = (thrown as { code?: unknown }).code;
    const prefix = typeof code === "string" ? `${code}: ` : "";
    return makeFinding("error", `${prefix}${thrown.name}: ${thrown.message}`);
  }
  return makeFinding("error", `non-Error thrown: ${String(thrown)}`);
}

/** Vergleichsschluessel eines Befunds (Kanal plus Begruendung). */
export function findingKey(finding: VisibleFinding): string {
  return `${finding.channel} ${finding.detail}`;
}

/**
 * Multimengen-Differenz `damaged \ baseline`: die Befunde, die der beschaedigte
 * Lauf ZUSAETZLICH gemeldet hat.
 *
 * Bewusst eine Multimenge und bewusst nur die eine Richtung: ein Lauf, der
 * WENIGER meldet als der Referenzlauf und dabei ein anderes Ergebnis liefert,
 * hat nichts sichtbar gemacht -- er hat etwas verloren. Genau das ist die
 * Fehlerklasse, die dieses Modul aufdecken soll.
 */
export function newFindings(
  baseline: readonly VisibleFinding[],
  damaged: readonly VisibleFinding[],
): readonly VisibleFinding[] {
  const remaining = new Map<string, number>();
  for (const finding of baseline) {
    const key = findingKey(finding);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const added: VisibleFinding[] = [];
  for (const finding of damaged) {
    const key = findingKey(finding);
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      remaining.set(key, count - 1);
    } else {
      added.push(finding);
    }
  }
  return added;
}
