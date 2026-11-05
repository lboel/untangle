/**
 * REGRESSION (Welle-3-Befund 2 und 3).
 *
 * BEFUND 2: `checkScopeTreeInvariants` wurde in seiner eigenen Doku und in
 * der Report-Zeile "Verstoesse 0" als Doppelzaehlungspruefung ausgegeben.
 * `children_exceed_parent` prueft `self + Σ Kinder <= inclusive` und ist damit
 * eine EINSEITIGE Schranke: ein Elternwert, der einen Kindbeitrag zweimal
 * enthaelt, erfuellt sie erst recht. Die Luecke zwischen Anspruch und Leistung
 * wird hier auf beiden Seiten geschlossen:
 *   - der Detailtext eines Verstosses benennt jetzt die WIRKLICHE Ursache
 *     (dem Elternwert FEHLT Inhalt) statt der falschen (Doppelzaehlung);
 *   - die Zusicherung "jeder Scope zaehlt genau einmal" leistet
 *     `checkScopeCoverage`/`checkSelectionCoverage` STRUKTURELL, und ihr
 *     Alarmfall wird hier vorgefuehrt statt behauptet;
 *   - was WEITERHIN nicht erkennbar ist, steht als ausfuehrbarer Beleg
 *     ("dokumentierte Grenze") ebenfalls hier, damit die alte Behauptung
 *     nicht unbemerkt zurueckkehrt.
 *
 * BEFUND 3: `duplicatesDropped` wies stillen Inhaltsverlust aus, und niemand
 * las den Zaehler. Hier wird festgehalten, was er bedeutet.
 */
import { describe, expect, it } from "vitest";

import {
  aggregateScopeTree,
  assertScopeTreeInvariants,
  checkAllScopeCoverage,
  checkScopeCoverage,
  checkScopeTreeInvariants,
  checkSelectionCoverage,
  selectionForReading,
  selectScopeEntries,
  SCOPE_SUM_READINGS,
  type ScopeMetricNodeV1,
  type ScopeSelectionKind,
} from "./scope-aggregate.js";

function node(
  metricsScopeId: string,
  inclusiveValue: number,
  selfValue: number,
  executionUnit: boolean,
  parentScopeId?: string,
): ScopeMetricNodeV1 {
  return parentScopeId === undefined
    ? { metricsScopeId, inclusiveValue, selfValue, executionUnit }
    : { metricsScopeId, inclusiveValue, selfValue, executionUnit, parentScopeId };
}

/** Datei -> Methode -> Closure; Werte konsistent, keine Invariante verletzt. */
const WELLFORMED: ScopeMetricNodeV1[] = [
  node("file", 9, 1, false),
  node("file/method", 8, 4, true, "file"),
  node("file/method/closure", 4, 4, true, "file/method"),
];

describe("children_exceed_parent sagt, was es wirklich bedeutet", () => {
  it("nennt fehlenden Inhalt als Ursache und behauptet KEINE Doppelzaehlung", () => {
    // Elternwert 3, Kind 4: dem Elternwert FEHLT der Beitrag seines Kindes.
    const violations = checkScopeTreeInvariants([
      node("P", 3, 2, false),
      node("A", 4, 4, true, "P"),
    ]);
    expect(violations.map((v) => v.code)).toEqual(["children_exceed_parent"]);
    const detail = violations[0]?.detail ?? "";
    expect(detail).toContain("missing child content");
    // Der alte Text schloss mit "Ein Beitrag ist dann in mindestens zwei
    // Scopes gleichzeitig enthalten." — das ist die falsche Richtung und
    // schickte den Leser auf die Suche nach einer Doppelzaehlung, die es
    // hier gar nicht gibt.
    expect(detail).not.toContain("included in at least two scopes simultaneously");
    expect(detail).toContain("one-sided");
  });

  it("DOKUMENTIERTE GRENZE: ein zu GROSSER Elternwert bleibt unerkannt", () => {
    // Wahrer Inhalt waere 10 (Eigenanteil 2 + A 4 + B 4); der Elternwert
    // zaehlt B ein zweites Mal mit und steht auf 14.
    const inflated: ScopeMetricNodeV1[] = [
      node("P", 14, 2, false),
      node("A", 4, 4, true, "P"),
      node("B", 4, 4, true, "P"),
    ];
    expect(checkScopeTreeInvariants(inflated)).toEqual([]);
    expect(checkAllScopeCoverage(inflated)).toEqual([]);
    // Und die top_level-Lesart gibt die aufgeblaehte Zahl bereitwillig aus.
    expect(aggregateScopeTree(inflated).topLevelSum).toBe(14);
    // Genau deshalb darf keine Doku und keine Report-Zeile behaupten, hier
    // sei Doppelzaehlungsfreiheit geprueft worden. Aus Werten allein ist der
    // Fall nicht entscheidbar; die Verantwortung liegt beim Calculator.
  });
});

describe("checkScopeCoverage: jeder Scope zaehlt in genau einen Summanden", () => {
  it("meldet fuer einen wohlgeformten Baum in allen drei Lesarten nichts", () => {
    for (const reading of SCOPE_SUM_READINGS) {
      expect(checkScopeCoverage(WELLFORMED, reading)).toEqual([]);
    }
  });

  it("die Auswahl deckt sich mit dem, was selectScopeEntries wirklich summiert", () => {
    for (const reading of SCOPE_SUM_READINGS) {
      const selection = selectionForReading(WELLFORMED, reading);
      const entries = selectScopeEntries(WELLFORMED, reading);
      expect([...selection.keys()].sort()).toEqual(entries.map((e) => e.metricsScopeId).sort());
    }
  });

  it("meldet scope_counted_twice, wenn zwei Summanden denselben Scope tragen", () => {
    // Auswahl, in der Datei UND Methode je mit `inclusive` zaehlen: der
    // Beitrag der Methode und der Closure steckte dann in zwei Summanden.
    // Genau diese Auswahl entsteht, wenn jemand die Bedingung in
    // `selectionFor` auf "jede Ausfuehrungseinheit" verkuerzt.
    const broken = new Map<string, ScopeSelectionKind>([
      ["file", "inclusive"],
      ["file/method", "inclusive"],
      ["file/method/closure", "inclusive"],
    ]);
    const violations = checkSelectionCoverage(WELLFORMED, broken, "kaputte Auswahl");
    expect(violations.map((v) => v.code)).toEqual(["scope_counted_twice", "scope_counted_twice"]);
    expect(violations.map((v) => v.metricsScopeId)).toEqual(["file/method", "file/method/closure"]);
    expect(violations[0]?.detail).toContain("contributing terms simultaneously");
    expect(violations[1]?.observed).toBe(3);
  });

  it("meldet scope_uncounted, wenn ein Scope in keinem Summanden steckt", () => {
    // Das ist die Blatt-Lesart, die die Modul-Doku als FALSCH beschreibt:
    // sie zaehlt nur Blaetter und verliert den Eigenanteil aller Scopes mit
    // Kindern ersatzlos.
    const leafOnly = new Map<string, ScopeSelectionKind>([["file/method/closure", "self"]]);
    const violations = checkSelectionCoverage(WELLFORMED, leafOnly, "nur Blaetter");
    expect(violations.map((v) => v.code)).toEqual(["scope_uncounted", "scope_uncounted"]);
    expect(violations.map((v) => v.metricsScopeId)).toEqual(["file", "file/method"]);
    expect(violations[0]?.detail).toContain("belongs to no contributing term");
  });

  it("liefert Verstoesse deterministisch nach Codepoints sortiert", () => {
    const nodes = [node("zz", 1, 1, false), node("aa", 1, 1, false), node("mm", 1, 1, false)];
    const empty = new Map<string, ScopeSelectionKind>();
    expect(checkSelectionCoverage(nodes, empty, "leer").map((v) => v.metricsScopeId)).toEqual([
      "aa",
      "mm",
      "zz",
    ]);
  });

  it("assertScopeTreeInvariants wirft auch bei einem reinen Zaehlfehler", () => {
    // Zwei Ausfuehrungseinheiten, die sich gegenseitig als Eltern nennen:
    // die Funktions-Lesart waehlt dann KEINE von beiden aus und summiert 0,
    // obwohl beide Inhalt tragen.
    const cyclic = [node("P", 5, 5, true, "Q"), node("Q", 5, 5, true, "P")];
    expect(checkScopeCoverage(cyclic, "execution_unit").map((v) => v.code)).toEqual([
      "scope_uncounted",
      "scope_uncounted",
    ]);
    expect(selectScopeEntries(cyclic, "execution_unit")).toEqual([]);
    expect(() => {
      assertScopeTreeInvariants(cyclic);
    }).toThrow();
  });
});

describe("duplicatesDropped ist verlorener Inhalt, kein Betriebsdetail", () => {
  it("verwirft zwei verschiedene Scopes mit gleicher Id und gleichen Werten ohne Verstoss", () => {
    const nodes = [
      node("F", 9, 1, false),
      node("X", 4, 4, true, "F"),
      // Zweiter, in Wahrheit ANDERER Scope, der zufaellig dieselbe Id und
      // dieselben Werte traegt.
      node("X", 4, 4, true, "F"),
    ];
    expect(checkScopeTreeInvariants(nodes)).toEqual([]);
    const result = aggregateScopeTree(nodes);
    // Der Verlust ist NUR an diesem Zaehler erkennbar: die Summe waere
    // 4 + 4 + 1 = 9, sie ist 5.
    expect(result.duplicatesDropped).toBe(1);
    expect(result.executionUnitSum).toBe(5);
    // Wer ihn nicht liest, bemerkt den fehlenden Scope nie. Deshalb bricht
    // `scripts/complexity-report.mjs` bei duplicatesDropped > 0 ab.
  });
});
