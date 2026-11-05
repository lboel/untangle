/**
 * Sammler fuer den Skip-Ledger der Suche (docs/BUILD_PLAN.md E4).
 *
 * E4 ist im Abrufkern besonders leicht zu verletzen: eine Suche wirft
 * staendig Kandidaten weg — durch Nachfilter, durch `minScore`, durch
 * Dedupe, durch `limit`. Jedes dieser Wegwerfen ist eine ENTSCHEIDUNG und
 * muss benannt werden, sonst sieht der Nutzer eine kurze Trefferliste und
 * haelt sie fuer die ganze Wahrheit.
 *
 * Der Sammler haelt die Eintraege in Einfuegereihenfolge; die Einfuegereihen-
 * folge ist ihrerseits deterministisch, weil jede Stufe ihre Kandidaten in
 * einer stabilen Ordnung abarbeitet.
 */
import type { SkipLedgerEntryV1, SkipReason } from "@untangle-code/domain";
import { buildSkipLedgerEntry, summarizeSkipReasons } from "@untangle-code/domain";

/** Eingabe eines Suchstufen-Eintrags; `stage` ist immer `"search"`. */
export interface SearchSkipInput {
  subjectKind: SkipLedgerEntryV1["subjectKind"];
  subjectId?: string;
  path?: string;
  repoId?: string;
  refId?: string;
  reason: SkipReason;
  detail: string;
  recoverable?: boolean;
}

/**
 * Sammelt Ledger-Eintraege einer einzelnen Suchausfuehrung.
 *
 * `add()` verweigert (ueber `buildSkipLedgerEntry`) eine leere Begruendung —
 * ein Uebersprungeintrag ohne Grund taeuscht Diagnose vor, wo keine ist.
 */
export class SearchSkipLedger {
  private readonly entries: SkipLedgerEntryV1[] = [];

  public add(input: SearchSkipInput): void {
    this.entries.push(
      buildSkipLedgerEntry({
        stage: "search",
        subjectKind: input.subjectKind,
        ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.repoId === undefined ? {} : { repoId: input.repoId }),
        ...(input.refId === undefined ? {} : { refId: input.refId }),
        reason: input.reason,
        detail: input.detail,
        recoverable: input.recoverable ?? false,
      }),
    );
  }

  /** Ein Kandidat, der die Trefferliste nicht erreicht hat. */
  public addCandidate(input: Omit<SearchSkipInput, "subjectKind"> & { subjectId: string }): void {
    this.add({ subjectKind: "search_candidate", ...input });
  }

  public get size(): number {
    return this.entries.length;
  }

  /** Kopie der gesammelten Eintraege in Einfuegereihenfolge. */
  public toArray(): SkipLedgerEntryV1[] {
    return [...this.entries];
  }

  /** Zaehlung je Grund — dieselbe Form wie `SkipLedgerV1.countsByReason`. */
  public countsByReason(): Partial<Record<SkipReason, number>> {
    return summarizeSkipReasons(this.entries);
  }
}
