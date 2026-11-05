/**
 * Was die Analysestufe fuer die SPAETEREN Stufen aufbewahrt.
 *
 * WARUM EIN EIGENER SAMMLER UND NICHT ZUSAETZLICHE FELDER AUF
 * `AnalyzedFileV1`: Diese Form gehoert `@untangle-code/jobs` und reicht genau
 * so weit, wie der Laeufer sie braucht (Datei, Parsequalitaet, Zahlen,
 * vorbereitete Texte). Graphen und Manifeste brauchen mehr — Importe, Aufrufe,
 * Symbole, den Dateiinhalt —, und dieses Mehr durch die Warteschlangen zu
 * schieben wuerde das Speicherbudget der Pipeline (architecture.md §13.2)
 * gegen Daten aufbrauchen, die erst NACH der Ablage gebraucht werden.
 *
 * PREIS, DEN MAN KENNEN MUSS: Der Sammler haelt je geplanter Datei die
 * Symbole, Importe und Aufrufe im Speicher — bei sehr grossen Repositories ist
 * das die groesste einzelne Speicherposition des Laufs. Sie ist sichtbar
 * ({@link AnalysisCollector.fileCount}) und nicht versteckt.
 */
import type { ExtractedSymbol, ParseQuality, RawCall, RawImport } from "@untangle-code/domain";

/** Alles, was eine analysierte Datei den Graph- und Commit-Stufen hinterlaesst. */
export interface CollectedFileV1 {
  fileId: string;
  repoId: string;
  refId: string;
  /** "/"-normalisierter, repo-relativer Pfad. */
  filePath: string;
  languageId: string;
  contentHash: string;
  sizeBytes: number;
  parseQuality: ParseQuality;
  /** Vollstaendiger Inhalt — der Symbolgraph braucht ihn fuer echte Symbol-Hashes. */
  content: string;
  symbols: ExtractedSymbol[];
  calls: RawCall[];
  imports: RawImport[];
  /**
   * Grund, warum `imports` leer ist, obwohl die Datei welche haben koennte.
   * Ohne ihn gilt eine leere Liste als „hat keine Importe" (E4).
   */
  importsMissingReason?: string | undefined;
  chunkIds: string[];
  symbolIds: string[];
  /** Dedupe-Bereich der Metrikaggregation (spec.md §16.1). */
  metricsScopeId: string;
}

/** Sammelstelle der Analysestufe; genau eine je Lauf. */
export class AnalysisCollector {
  private readonly files = new Map<string, CollectedFileV1>();

  put(file: CollectedFileV1): void {
    this.files.set(file.fileId, file);
  }

  get(fileId: string): CollectedFileV1 | undefined {
    return this.files.get(fileId);
  }

  get fileCount(): number {
    return this.files.size;
  }

  /** In Einfuegereihenfolge; die Verbraucher sortieren selbst kanonisch. */
  all(): CollectedFileV1[] {
    return [...this.files.values()];
  }
}
