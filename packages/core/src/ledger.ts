/**
 * Der Sammler des Skip-Ledgers (docs/BUILD_PLAN.md E4, vision.md §8.4).
 *
 * WARUM ES IHN GIBT: Die Stufen des Indexlaufs laufen NEBENLAEUFIG (die
 * Warteschlangen von `@untangle-code/jobs` halten Analyse, Einbettung und
 * Ablage gleichzeitig in Betrieb). Ein Ledger, das jede Stufe fuer sich
 * fuehrt, ist am Ende nicht mehr zusammensetzbar, und ein Eintrag, der
 * nirgends ankommt, ist genau das stillschweigende Ueberspringen, das E4
 * verbietet. Deshalb GENAU EINE Sammelstelle je Lauf, in die jede Stufe
 * schreibt.
 *
 * Die Ausgabe ist deterministisch geordnet (Codepoints, nie `localeCompare`)
 * und traegt keine Uhrzeit — ein Ledger ist ERGEBNISDATEN.
 */
import {
  buildSkipLedgerEntry,
  compareCodepoints,
  summarizeSkipReasons,
  type SkipLedgerEntryV1,
  type SkipLedgerV1,
  type SkipReason,
  type SkipStage,
  type SkipSubjectKind,
  type SourceRange,
} from "@untangle-code/domain";

/** Eingabe eines Eintrags; `schemaVersion` setzt der Sammler. */
export interface SkipInput {
  stage: SkipStage;
  subjectKind: SkipSubjectKind;
  subjectId?: string | undefined;
  path?: string | undefined;
  range?: SourceRange | undefined;
  repoId?: string | undefined;
  refId?: string | undefined;
  reason: SkipReason;
  detail: string;
  recoverable: boolean;
}

/**
 * Sammelt Ledger-Eintraege waehrend eines Laufs.
 *
 * OBERGRENZE MIT GRUND: Ein Lauf ueber ein grosses Repository kann sehr viele
 * Eintraege erzeugen (jede ignorierte Datei ist einer). Statt unbegrenzt zu
 * wachsen, behaelt der Sammler die ersten `maxEntries` und ZAEHLT den Rest
 * weiter — die Summen in {@link SkipCollector.counts} bleiben also vollstaendig,
 * auch wenn die Liste gekuerzt ist. Eine stillschweigend gekuerzte Liste waere
 * derselbe Fehler noch einmal, deshalb meldet {@link SkipCollector.truncated}
 * die Kuerzung ausdruecklich.
 */
export class SkipCollector {
  private readonly entries: SkipLedgerEntryV1[] = [];
  private readonly byReason = new Map<SkipReason, number>();
  private readonly byStage = new Map<SkipStage, number>();
  private droppedCount = 0;

  constructor(private readonly maxEntries = 5000) {}

  add(input: SkipInput): void {
    this.byReason.set(input.reason, (this.byReason.get(input.reason) ?? 0) + 1);
    this.byStage.set(input.stage, (this.byStage.get(input.stage) ?? 0) + 1);
    if (this.entries.length >= this.maxEntries) {
      this.droppedCount++;
      return;
    }
    this.entries.push(
      buildSkipLedgerEntry({
        stage: input.stage,
        subjectKind: input.subjectKind,
        ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.range === undefined ? {} : { range: input.range }),
        ...(input.repoId === undefined ? {} : { repoId: input.repoId }),
        ...(input.refId === undefined ? {} : { refId: input.refId }),
        reason: input.reason,
        detail: input.detail,
        recoverable: input.recoverable,
      }),
    );
  }

  /** Uebernimmt fertige Eintraege fremder Pakete (Graphen, Topologie). */
  addAll(entries: readonly SkipLedgerEntryV1[]): void {
    for (const entry of entries) {
      this.add({
        stage: entry.stage,
        subjectKind: entry.subjectKind,
        subjectId: entry.subjectId,
        path: entry.path,
        range: entry.range,
        repoId: entry.repoId,
        refId: entry.refId,
        reason: entry.reason,
        detail: entry.detail,
        recoverable: entry.recoverable,
      });
    }
  }

  /** Gesamtzahl gemeldeter Uebersprungen — auch der nicht behaltenen. */
  get total(): number {
    return this.entries.length + this.droppedCount;
  }

  /** Wie viele Eintraege wegen der Obergrenze nicht in der Liste stehen. */
  get truncated(): number {
    return this.droppedCount;
  }

  get counts(): Partial<Record<SkipReason, number>> {
    return Object.fromEntries(
      [...this.byReason.entries()].sort(([a], [b]) => compareCodepoints(a, b)),
    );
  }

  /**
   * Grund → Anzahl reicht nicht zum Lesen: „9207 missing_index_entry" klingt
   * nach einem kaputten Index, ist aber die voellig normale Meldung des
   * Symbolgraphen ueber Aufrufe auf Symbole ausserhalb des Index (`console.log`
   * und Verwandte). Erst die STUFE trennt „Dateien, die nicht indiziert wurden"
   * von „Kanten, die nicht aufgeloest wurden" — zwei Befunde, die nichts
   * miteinander zu tun haben und in einer gemeinsamen Zahl nur verwirren.
   */
  get countsByStage(): Partial<Record<SkipStage, number>> {
    return Object.fromEntries(
      [...this.byStage.entries()].sort(([a], [b]) => compareCodepoints(a, b)),
    );
  }

  /** Behaltene Eintraege in kanonischer Ordnung. */
  list(): SkipLedgerEntryV1[] {
    return [...this.entries].sort(
      (a, b) =>
        compareCodepoints(a.stage, b.stage) ||
        compareCodepoints(a.path ?? "", b.path ?? "") ||
        compareCodepoints(a.reason, b.reason) ||
        compareCodepoints(a.detail, b.detail),
    );
  }

  /**
   * Das Ledger einer Generation. `countsByReason` zaehlt ALLE Meldungen,
   * `entries` nur die behaltenen — bei einer Kuerzung passen die beiden
   * absichtlich nicht zusammen, und `validateSkipLedger` meldet das als
   * `count_mismatch`. Deshalb wird bei Kuerzung auf die Zaehlung der
   * behaltenen Eintraege zurueckgeschaltet und die Gesamtzahl steht in
   * {@link SkipCollector.total} — sichtbar statt widerspruechlich.
   */
  toLedger(generationId: string): SkipLedgerV1 {
    const entries = this.list();
    return {
      schemaVersion: 1,
      generationId,
      entries,
      countsByReason: this.droppedCount === 0 ? this.counts : summarizeSkipReasons(entries),
    };
  }
}
