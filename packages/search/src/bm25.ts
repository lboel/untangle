/**
 * Deterministisches Okapi BM25 ueber den Kandidatenpool des Abrufkerns.
 *
 * WARUM EIGEN UND NICHT AUS DEM SPEICHER: Der `VectorStore` liefert im
 * spaerlichen Zweig einen Rang, den der Speicher berechnet hat (bei Qdrant
 * mit seiner eigenen IDF-Statistik ueber die ganze Collection). Dieser Rang
 * ist ausgezeichnet fuer den ABRUF (Recall), aber er ist nicht in diesem
 * Prozess nachrechenbar und aendert sich mit dem Speicherstand. Die
 * Score-Zerlegung soll erklaeren, WARUM ein Treffer rankt — dafuer muss der
 * lexikalische Anteil hier berechenbar sein. Deshalb:
 *
 * - der Speicher liefert KANDIDATEN (dichter und spaerlicher Zweig),
 * - der lexikalische RANG entsteht in diesem Modul, mit den Statistiken des
 *   Kandidatenpools.
 *
 * Der Preis dieser Entscheidung ist benannt und nicht wegdiskutiert: IDF
 * ueber den Kandidatenpool ist nicht IDF ueber das ganze Korpus. Bei kleinen
 * Pools kann ein Wort dadurch seltener aussehen, als es ist. Der Pool ist
 * `candidateLimit` gross (Default 50, Maximum 200) und damit gross genug fuer
 * eine stabile Ordnung INNERHALB des Pools — und nur diese Ordnung geht in
 * die Fusion ein, nicht der absolute Wert. Siehe README „Bekannte Grenzen".
 *
 * Konstanten: k1 = 1.2, b = 0.75 — die Standardwerte aus Robertson/Sparck
 * Jones. Sie sind hier keine „magischen Gewichte", sondern die dokumentierte
 * Voreinstellung des Verfahrens; abweichende Werte muessten begruendet werden.
 */
import { compareCodepoints } from "@untangle-code/domain";

import { informativeQueryTokens, termFrequencies, tokenizeIdentifiers } from "./tokenize.js";

/** Saettigungskonstante der Termhaeufigkeit (Standardwert). */
export const BM25_K1 = 1.2;
/** Laengennormalisierung (Standardwert). */
export const BM25_B = 0.75;

/** Ein Dokument des lexikalischen Index. */
export interface LexicalDocument {
  id: string;
  text: string;
}

/** Ein Rangeintrag des lexikalischen Zweigs. */
export interface LexicalRanking {
  id: string;
  score: number;
  /** 1-basierter Rang. */
  rank: number;
}

interface PreparedDocument {
  id: string;
  frequencies: Map<string, number>;
  length: number;
}

/**
 * BM25 ueber eine feste Dokumentmenge. Die Statistiken werden EINMAL im
 * Konstruktor gebildet; danach ist `score()` eine reine Funktion.
 */
export class Bm25Ranker {
  private readonly documents: PreparedDocument[] = [];
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageLength: number;

  public constructor(
    documents: readonly LexicalDocument[],
    private readonly k1: number = BM25_K1,
    private readonly b: number = BM25_B,
  ) {
    let totalLength = 0;
    for (const document of documents) {
      const tokens = tokenizeIdentifiers(document.text);
      const frequencies = termFrequencies(tokens);
      this.documents.push({ id: document.id, frequencies, length: tokens.length });
      totalLength += tokens.length;
      for (const term of frequencies.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
    }
    this.averageLength = this.documents.length === 0 ? 1 : totalLength / this.documents.length;
  }

  public get documentCount(): number {
    return this.documents.length;
  }

  /**
   * Inverse Dokumenthaeufigkeit in der geglaetteten Form
   * `ln(1 + (N - df + 0.5) / (df + 0.5))` — immer positiv, damit ein in jedem
   * Dokument vorkommender Term den Score nicht negativ macht.
   */
  private inverseDocumentFrequency(term: string): number {
    const df = this.documentFrequency.get(term) ?? 0;
    const n = this.documents.length;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  private scoreDocument(queryTerms: readonly string[], document: PreparedDocument): number {
    let total = 0;
    for (const term of queryTerms) {
      const tf = document.frequencies.get(term) ?? 0;
      if (tf === 0) {
        continue;
      }
      const numerator = tf * (this.k1 + 1);
      const denominator =
        tf + this.k1 * (1 - this.b + this.b * (document.length / this.averageLength));
      total += this.inverseDocumentFrequency(term) * (numerator / denominator);
    }
    return total;
  }

  /**
   * Rangliste zu einem Suchtext. Dokumente mit Score 0 (kein Term getroffen)
   * fallen heraus — sie haben lexikalisch nichts beigetragen und duerfen die
   * Fusion nicht mit einem Scheinrang beeinflussen.
   *
   * Gleichstand wird deterministisch nach Codepoints der ID aufgeloest, nie
   * nach Einfuegereihenfolge und nie ueber `localeCompare`.
   */
  public rank(queryText: string): LexicalRanking[] {
    const queryTerms = [...termFrequencies(informativeQueryTokens(queryText)).keys()];
    const scored: { id: string; score: number }[] = [];
    for (const document of this.documents) {
      const score = this.scoreDocument(queryTerms, document);
      if (score > 0) {
        scored.push({ id: document.id, score });
      }
    }
    scored.sort((a, b) =>
      a.score === b.score ? compareCodepoints(a.id, b.id) : b.score - a.score,
    );
    return scored.map((entry, index) => ({ id: entry.id, score: entry.score, rank: index + 1 }));
  }
}
