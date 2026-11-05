/**
 * Aggregation ueber einen Scope-BAUM, ohne Doppelzaehlung (WP-82; spec.md
 * §16.10, docs/BUILD_PLAN.md E4).
 *
 * ## Das Problem
 *
 * `aggregate()` in `aggregator.ts` dedupliziert ueber `metricsScopeId` und
 * loest damit genau einen Fall: dasselbe Retrieval-Fragment zweimal in der
 * Eingabe. Es loest NICHT den Fall, um den es hier geht — verschachtelte
 * Scopes. `buildSymbolIR()` bezieht bewusst jeden Nachfahren-Scope in die IR
 * des Zielscopes ein (siehe `ir/build-ir.ts`, "documented nesting context"
 * nach spec.md §16.4): der `file`-Scope traegt also den Kontrollfluss ALLER
 * Klassen, Methoden und Closures der Datei, die Methode den ihrer Closures.
 * Jeder dieser Scopes hat eine eigene, gueltige `metricsScopeId` — die
 * Deduplizierung greift nicht, und `sum` zaehlt denselben Quelltext einmal
 * je umschliessendem Scope.
 *
 * Am eigenen Repo gemessen (siehe `scripts/complexity-report.mjs`): naiv
 * summiert ergibt cognitive rund das Dreifache der Summe, die jeden Scope
 * genau einmal zaehlt. Eine Hotspot-Liste auf dieser Basis steuert in die
 * falsche Richtung.
 *
 * ## Die drei Lesarten
 *
 * "Summe ueber ein Paket" ist ohne Angabe der Lesart bedeutungslos. Dieses
 * Modul kennt genau drei, alle drei zaehlen jeden Scope GENAU EINMAL, und
 * sie unterscheiden sich ausschliesslich darin, wie viel Nesting-Kontext ein
 * Konstrukt mitbekommt:
 *
 * - `"top_level"` (Datei-Lesart): Summe der `inclusiveValue` ueber die
 *   Wurzel-Scopes. Jedes Konstrukt zaehlt einmal, mit dem VOLLEN
 *   Nesting-Kontext bis zur Wurzel — jede umschliessende Funktion zaehlt als
 *   Nesting-Ebene. Beantwortet: "wie schwer ist diese Datei am Stueck zu
 *   lesen".
 * - `"execution_unit"` (Funktions-Lesart, DEFAULT): Summe der
 *   `inclusiveValue` ueber die AEUSSERSTEN Ausfuehrungseinheiten (Funktion,
 *   Methode, Konstruktor) plus die `selfValue` aller Scopes, die selbst keine
 *   Ausfuehrungseinheit sind und auch keine ueber sich haben (Datei, Klasse,
 *   Interface, Namespace). Der Nesting-Zaehler startet bei jeder aeussersten
 *   Funktion neu; verschachtelte Closures bleiben — wie von spec.md §16.4
 *   verlangt — Teil ihrer umschliessenden Funktion. Das ist die Lesart, die
 *   der verbreiteten "cognitive complexity je Funktion, danach aufsummiert"
 *   Konvention entspricht und damit die einzige, die einer Gegenprobe gegen
 *   ein etabliertes Werkzeug (X8) standhaelt.
 * - `"self"` (Eigenanteil-Lesart): Summe der `selfValue` ueber ALLE Scopes.
 *   Der Nesting-Zaehler startet in jedem Scope neu, auch in einer Closure.
 *   Untere Schranke; nuetzlich, um den Anteil sichtbar zu machen, den reines
 *   Nesting am Gesamtwert hat.
 *
 * Fuer eine Metrik OHNE Sockel je Scope (`perScopeBase === 0`, also cognitive)
 * gilt strukturell `self <= execution_unit <= top_level`, und zwar als Folge
 * der Kerninvariante: die Differenzen sind nicht Rauschen, sondern genau der
 * Nesting-Aufschlag der jeweils zusaetzlich beruecksichtigten Ebenen (belegt
 * in `scope-aggregate.test.ts`).
 *
 * ## Woraus die Doppelzaehlungsfreiheit tatsaechlich folgt
 *
 * Nicht aus `checkScopeTreeInvariants`. Deren Kernpruefung
 * `children_exceed_parent` ist eine EINSEITIGE Schranke
 * (`self + Summe Kinder <= inclusive`): sie faengt einen zu KLEINEN
 * Elternwert, also fehlenden Inhalt. Ein zu GROSSER Elternwert — der Fall, in
 * dem ein Kindbeitrag zweimal im Elternwert steckt — erfuellt sie erst recht
 * und bleibt damit unentdeckt. Aus Werten allein ist er auch nicht
 * entscheidbar: ein aufgeblaehter `inclusiveValue` sieht genauso aus wie ein
 * Scope, der im eigenen Koerper einfach viel Kontrollfluss traegt.
 *
 * Was dieses Modul stattdessen ZUSICHERT und mit `checkScopeCoverage`
 * NACHPRUEFT, ist die strukturelle Aussage: in jeder der drei Lesarten geht
 * jeder Scope in GENAU EINEN Summanden ein — entweder als eigener Summand
 * oder als Nachfahre genau eines Summanden, der mit `inclusiveValue` zaehlt.
 * Damit kann keine Lesart denselben Quelltext zweimal aufaddieren. Das ist
 * die Zusicherung, die die Summen tragen; die Werttreue der einzelnen
 * `inclusiveValue`s liegt beim Aufrufer, der sie berechnet hat.
 *
 * Fuer eine Metrik MIT Sockel (`perScopeBase > 0`, also cyclomatic:
 * `M = 1 + decision_points`) kehrt sich die Reihenfolge um, und das ist
 * korrekt: die `self`-Lesart zaehlt den Sockel einmal JE SCOPE, die
 * `top_level`-Lesart nur einmal je Datei. Die drei Zahlen bleiben
 * doppelzaehlungsfrei — sie beantworten nur verschiedene Fragen. Wer sie
 * nebeneinander zeigt, muss den Sockel dazusagen.
 *
 * ## Warum es KEINE Blatt-Lesart gibt
 *
 * "Summe der Blatt-Scopes" waere die naheliegende vierte Lesart und ist
 * FALSCH: der Kontrollfluss, der direkt im Koerper eines Scopes MIT Kindern
 * steht (eine `if`-Kette in einer Methode, die ausserdem eine Closure
 * definiert), gehoert keinem Blatt und faellt ersatzlos weg. Das ist kein
 * Deduplizieren, sondern stilles Verlieren von Inhalt — genau das, was E4
 * verbietet. `ScopeTreeAggregateV1.leafOnlySum` weist die Zahl trotzdem aus,
 * aber ausdruecklich als Diagnose zusammen mit `leafOnlyDroppedAmount`, dem
 * Betrag, den sie verschluckt.
 *
 * ## Determinismus
 *
 * Kein `localeCompare`, kein `Date.now()`, kein `Math.random()`. Reihenfolgen
 * werden ueber `compareCodepoints` aus `@untangle-code/domain` hergestellt.
 */
import { compareCodepoints, UntangleError } from "@untangle-code/domain";

import type { AggregationEntry } from "./types.js";

/**
 * Ein Scope mit beiden Lesarten desselben Metrikwerts.
 *
 * Der Aufrufer erzeugt die Werte mit demselben Calculator, nur mit
 * unterschiedlich zugeschnittenen Facts:
 * - `inclusiveValue`: Calculator auf `buildSymbolIR(facts, id)` — die
 *   ungefilterten Datei-Facts, der Builder zieht alle Nachfahren-Scopes mit
 *   hinein.
 * - `selfValue`: Calculator auf
 *   `buildSymbolIR(selectSymbolFacts(facts, id), id)` — nur die eigenen
 *   Facts des Scopes, ohne Nachfahren.
 */
export interface ScopeMetricNodeV1 {
  /** `metrics_scope_id` nach spec.md §16.10; hier die `symbolScopeId`. */
  metricsScopeId: string;
  /** Eltern-Scope; fehlt genau bei einem Wurzel-Scope (typisch: der Datei-Scope). */
  parentScopeId?: string;
  /** Wert EINSCHLIESSLICH aller Nachfahren-Scopes. */
  inclusiveValue: number;
  /** Wert allein aus den eigenen Facts des Scopes, OHNE Nachfahren. */
  selfValue: number;
  /**
   * True, wenn der Scope eine eigene Ausfuehrungseinheit ist (Funktion,
   * Methode, Konstruktor, Lambda) — false bei Datei, Klasse, Interface,
   * Namespace, Typ, Property-Gruppe. Steuert ausschliesslich die Lesart
   * `"execution_unit"`; die Zuordnung trifft der Aufrufer, weil
   * `SymbolScopeFact.kind` ein adapterspezifischer String ist und dieses
   * Paket keine Sprach-Taxonomie kennt.
   */
  executionUnit: boolean;
  /** SLOC des Scopes, fuer den SLOC-gewichteten Mittelwert in `aggregate()`. */
  sloc?: number;
}

/** Die drei definierten Lesarten einer Scope-Summe. */
export const SCOPE_SUM_READINGS = ["top_level", "execution_unit", "self"] as const;

export type ScopeSumReading = (typeof SCOPE_SUM_READINGS)[number];

/** Geschlossene Menge der Invariantenverstoesse. Ein Verstoss ist ein Fehler, kein Hinweis. */
export const SCOPE_INVARIANT_CODES = [
  "duplicate_scope_id",
  "unknown_parent",
  "parent_cycle",
  "negative_value",
  "self_exceeds_inclusive",
  "children_exceed_parent",
  "leaf_self_differs_from_inclusive",
  "scope_counted_twice",
  "scope_uncounted",
] as const;

export type ScopeInvariantCode = (typeof SCOPE_INVARIANT_CODES)[number];

/** Ein Invariantenverstoss mit Pflicht-Detailtext (E4). */
export interface ScopeInvariantViolationV1 {
  code: ScopeInvariantCode;
  metricsScopeId: string;
  /** Beobachteter Wert (Bedeutung je nach `code`). */
  observed: number;
  /** Obergrenze/Erwartungswert, gegen den `observed` geprueft wurde. */
  limit: number;
  /** Menschenlesbare Begruendung; nie leer. */
  detail: string;
}

export interface ScopeTreeOptions {
  /**
   * Konstanter Sockel, den JEDER gemessene Scope traegt, unabhaengig von
   * seinem Inhalt. Cognitive: `0` (Default). Cyclomatic classic/extended:
   * `1`, weil `computeCyclomatic` immer den `M = 1 + decision_points`-Sockel
   * anlegt — ohne diese Angabe meldet die Eltern/Kind-Pruefung fuer
   * Cyclomatic Scheinverstoesse, sobald ein Scope mehr als ein Kind hat.
   * Die Pruefung rechnet mit `wert - perScopeBase`; die ausgewiesenen Summen
   * bleiben unveraendert.
   */
  perScopeBase?: number;
  /** Toleranz fuer Fliesskomma-Vergleiche. Default 1e-9. */
  epsilon?: number;
}

/** Ergebnis von `aggregateScopeTree`. */
export interface ScopeTreeAggregateV1 {
  /** Scopes nach Dedupe ueber `metricsScopeId`. */
  scopeCount: number;
  /** Wegen wiederholter `metricsScopeId` verworfene Eingaben (spec.md §16.10). */
  duplicatesDropped: number;
  rootCount: number;
  /** Anzahl der aeussersten Ausfuehrungseinheiten (Basis der Funktions-Lesart). */
  executionUnitRootCount: number;
  leafCount: number;
  /** Lesart `"top_level"`. */
  topLevelSum: number;
  /** Lesart `"execution_unit"` — die Vorgabezahl. */
  executionUnitSum: number;
  /** Lesart `"self"`. */
  selfSum: number;
  /**
   * NUR DIAGNOSE: Summe der `inclusiveValue` ueber alle Scopes — die naiv
   * doppelt zaehlende Zahl. Nie als Kennzahl ausgeben.
   */
  naiveSum: number;
  /** `naiveSum - topLevelSum`: der Betrag, den eine naive Summe doppelt zaehlt. */
  doubleCountedAmount: number;
  /** NUR DIAGNOSE: Summe ueber die Blatt-Scopes (siehe Modul-Doku). */
  leafOnlySum: number;
  /** `selfSum - leafOnlySum`: der Betrag, den eine Blatt-Lesart verschlucken wuerde. */
  leafOnlyDroppedAmount: number;
}

interface ResolvedTree {
  /** Deduplizierte Knoten, stabil nach `metricsScopeId` sortiert. */
  nodes: ScopeMetricNodeV1[];
  byId: Map<string, ScopeMetricNodeV1>;
  childrenByParent: Map<string, ScopeMetricNodeV1[]>;
  duplicatesDropped: number;
  duplicateConflicts: ScopeInvariantViolationV1[];
}

/**
 * Die Felder, in denen sich zwei Eintraege mit derselben `metricsScopeId`
 * unterscheiden — als LISTE, nicht als Ja/Nein.
 *
 * WP-186: Die Begruendung im Verstoss darf nicht behaupten, „die Werte
 * weichen ab", und dann zweimal dieselbe Zahl drucken. Genau das geschah,
 * sobald der Unterschied in `parentScopeId` oder `executionUnit` lag: der
 * Text nannte `inclusive`/`self`, die dort identisch waren, und das
 * tatsaechlich abweichende Feld kam nirgends vor. Wer so etwas liest, sucht
 * einen Fehler in einer Zahl, die stimmt.
 *
 * WP-200: `sloc` gehoert dazu. Es blieb ausserhalb des Vergleichs, obwohl es
 * das GEWICHT im SLOC-gewichteten Mittel von `aggregate()` stellt: zwei
 * Eintraege mit derselben Id und verschiedenem `sloc` galten als identisch,
 * der zweite wurde ohne Verstoss verworfen — und mit ihm sein Gewicht. Der
 * Mittelwert verschob sich, und nichts sagte es.
 */
function differingFields(a: ScopeMetricNodeV1, b: ScopeMetricNodeV1): string[] {
  const differing: string[] = [];
  if (a.inclusiveValue !== b.inclusiveValue) {
    differing.push(`inclusive ${String(b.inclusiveValue)} vs. ${String(a.inclusiveValue)}`);
  }
  if (a.selfValue !== b.selfValue) {
    differing.push(`self ${String(b.selfValue)} vs. ${String(a.selfValue)}`);
  }
  if (a.executionUnit !== b.executionUnit) {
    differing.push(`executionUnit ${String(b.executionUnit)} vs. ${String(a.executionUnit)}`);
  }
  if (a.parentScopeId !== b.parentScopeId) {
    differing.push(
      `parentScopeId ${b.parentScopeId ?? "(none)"} vs. ${a.parentScopeId ?? "(none)"}`,
    );
  }
  if (a.sloc !== b.sloc) {
    differing.push(`sloc ${String(b.sloc ?? "(none)")} vs. ${String(a.sloc ?? "(none)")}`);
  }
  return differing;
}

/**
 * Dedupliziert nach `metricsScopeId` (erstes Vorkommen gewinnt, wie
 * `aggregate()`, spec.md §16.10: doppelte Retrieval-Fragmente MUESSEN ueber
 * `metrics_scope_id` dedupliziert werden) und meldet dabei jede
 * WIDERSPRUECHLICHE Wiederholung als Verstoss: zwei gleiche Ids mit
 * verschiedenen Werten sind keine harmlose Dublette, sondern ein Zeichen,
 * dass die Ids nicht das identifizieren, was sie sollen.
 *
 * ACHTUNG FUER AUFRUFER — was `duplicatesDropped` bedeutet: eine
 * Wiederholung mit ZUFAELLIG gleichen Werten ist von einer echten Dublette
 * nicht zu unterscheiden und wird deshalb ohne Verstoss verworfen. Wer keine
 * wiederholten Retrieval-Fragmente in der Eingabe hat — wer also einen ECHTEN
 * Scope-Baum aggregiert, in dem jede Id genau einen Scope bezeichnen MUSS —
 * fuer den ist jedes `duplicatesDropped > 0` verlorener Inhalt und muss als
 * Fehler behandelt werden. Die Zahl steht deshalb in
 * `ScopeTreeAggregateV1.duplicatesDropped`; sie zu ignorieren waere ein
 * stilles Ueberspringen (E4). `scripts/complexity-report.mjs` bricht darauf
 * ab.
 */
function resolveTree(nodes: readonly ScopeMetricNodeV1[]): ResolvedTree {
  const byId = new Map<string, ScopeMetricNodeV1>();
  const deduped: ScopeMetricNodeV1[] = [];
  const duplicateConflicts: ScopeInvariantViolationV1[] = [];
  let duplicatesDropped = 0;
  for (const node of nodes) {
    const existing = byId.get(node.metricsScopeId);
    if (existing !== undefined) {
      duplicatesDropped++;
      const differing = differingFields(existing, node);
      if (differing.length > 0) {
        duplicateConflicts.push({
          code: "duplicate_scope_id",
          metricsScopeId: node.metricsScopeId,
          observed: node.inclusiveValue,
          limit: existing.inclusiveValue,
          detail:
            `metricsScopeId "${node.metricsScopeId}" appears more than once with differing ` +
            `${differing.length === 1 ? "field" : "fields"}: ` +
            `${differing.join(", ")}. The ID therefore does not identify exactly one scope; ` +
            `a total over this set would be meaningless.`,
        });
      }
      continue;
    }
    byId.set(node.metricsScopeId, node);
    deduped.push(node);
  }
  deduped.sort((a, b) => compareCodepoints(a.metricsScopeId, b.metricsScopeId));

  const childrenByParent = new Map<string, ScopeMetricNodeV1[]>();
  for (const node of deduped) {
    if (node.parentScopeId === undefined) continue;
    const siblings = childrenByParent.get(node.parentScopeId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentScopeId, siblings);
  }
  return { nodes: deduped, byId, childrenByParent, duplicatesDropped, duplicateConflicts };
}

/** True, wenn `node` in einer Elternkette liegt, die sich schliesst oder ins Leere laeuft. */
function ancestryProblem(
  node: ScopeMetricNodeV1,
  byId: ReadonlyMap<string, ScopeMetricNodeV1>,
): "cycle" | "unknown_parent" | null {
  const seen = new Set<string>([node.metricsScopeId]);
  let current = node;
  for (;;) {
    const parentId = current.parentScopeId;
    if (parentId === undefined) return null;
    if (seen.has(parentId)) return "cycle";
    const parent = byId.get(parentId);
    if (parent === undefined) return "unknown_parent";
    seen.add(parentId);
    current = parent;
  }
}

/**
 * Prueft alle Invarianten des Scope-Baums und liefert JEDEN Verstoss mit
 * Begruendung. Leere Liste heisst: der Baum traegt eine sinnvolle Summe.
 *
 * Geprueft wird:
 * 1. `duplicate_scope_id` — dieselbe Id mit abweichenden Werten.
 * 2. `unknown_parent` — `parentScopeId` zeigt auf einen Scope, der nicht in
 *    der Menge ist. Ihn stillschweigend als Wurzel zu behandeln waere ein
 *    E4-Verstoss: der Elternwert, gegen den geprueft werden muesste, fehlt.
 * 3. `parent_cycle` — die Elternkette schliesst sich.
 * 4. `negative_value` — negative Metrikwerte.
 * 5. `self_exceeds_inclusive` — der Eigenanteil ist groesser als der Wert
 *    mit Nachfahren. Der Eigenanteil ist per Definition ein Teil davon.
 * 6. `children_exceed_parent` — der Eigenanteil eines Scopes plus die Summe
 *    seiner direkten Kinder darf seinen eigenen Wert nicht ueberschreiten.
 *
 *    WAS DIESE PRUEFUNG LEISTET UND WAS NICHT — sie ist eine EINSEITIGE
 *    Schranke (`self + Summe Kinder <= inclusive`) und darf deshalb nicht als
 *    Doppelzaehlungspruefung gelesen werden:
 *    - Sie schlaegt an, wenn der Elternwert ZU KLEIN ist, dem Elternwert
 *      also Inhalt seiner Kinder FEHLT (oder ein Kindwert zu gross ist).
 *      Ein Verstoss heisst: der Baum verliert Inhalt, nicht: er zaehlt
 *      doppelt.
 *    - Sie schlaegt NICHT an, wenn der Elternwert ZU GROSS ist — genau der
 *      Fall, in dem ein Kindbeitrag zweimal im Elternwert steckt. Ein
 *      aufgeblaehter `inclusiveValue` ist aus Werten allein nicht von einem
 *      Scope zu unterscheiden, der im eigenen Koerper viel Kontrollfluss
 *      traegt.
 *
 *    Die Zusicherung "jeder Beitrag zaehlt genau einmal" leistet
 *    `checkScopeCoverage` auf der Struktur der jeweiligen Lesart, nicht
 *    diese Wertschranke.
 * 7. `leaf_self_differs_from_inclusive` — ein Scope ohne Kinder hat keine
 *    Nachfahren, sein Eigenanteil MUSS also sein Gesamtwert sein. Weicht er
 *    ab, hat der Aufrufer die beiden Werte nicht aus demselben Scope
 *    berechnet.
 *
 * NICHT geprueft (und mit Absicht hier benannt statt verschwiegen): ein zu
 * grosser `inclusiveValue` eines Scopes MIT Kindern. Siehe Punkt 6 und die
 * Modul-Doku, Abschnitt "Woraus die Doppelzaehlungsfreiheit tatsaechlich
 * folgt".
 *
 * Alle Wertvergleiche laufen auf `wert - perScopeBase` (siehe
 * `ScopeTreeOptions.perScopeBase`).
 */
export function checkScopeTreeInvariants(
  nodes: readonly ScopeMetricNodeV1[],
  options: ScopeTreeOptions = {},
): ScopeInvariantViolationV1[] {
  const perScopeBase = options.perScopeBase ?? 0;
  const epsilon = options.epsilon ?? 1e-9;
  const tree = resolveTree(nodes);
  const violations: ScopeInvariantViolationV1[] = [...tree.duplicateConflicts];

  for (const node of tree.nodes) {
    if (node.inclusiveValue < 0 || node.selfValue < 0) {
      violations.push({
        code: "negative_value",
        metricsScopeId: node.metricsScopeId,
        observed: Math.min(node.inclusiveValue, node.selfValue),
        limit: 0,
        detail:
          `Scope "${node.metricsScopeId}" has a negative metric value ` +
          `(inclusive ${String(node.inclusiveValue)}, self ${String(node.selfValue)}). ` +
          `Complexity metrics are non-negative.`,
      });
    }

    const problem = ancestryProblem(node, tree.byId);
    if (problem === "unknown_parent") {
      violations.push({
        code: "unknown_parent",
        metricsScopeId: node.metricsScopeId,
        observed: 0,
        limit: 0,
        detail:
          `Scope "${node.metricsScopeId}" references a scope through its parent chain ` +
          `that is absent from the set. It is not treated as a root: without the parent value, ` +
          `we cannot determine whether its contribution is already included there (E4).`,
      });
    } else if (problem === "cycle") {
      violations.push({
        code: "parent_cycle",
        metricsScopeId: node.metricsScopeId,
        observed: 0,
        limit: 0,
        detail:
          `The parent chain of scope "${node.metricsScopeId}" closes a cycle. ` +
          `A scope tree with a cycle has no root or well-defined total.`,
      });
    }

    const inclusive = node.inclusiveValue - perScopeBase;
    const own = node.selfValue - perScopeBase;
    if (own > inclusive + epsilon) {
      violations.push({
        code: "self_exceeds_inclusive",
        metricsScopeId: node.metricsScopeId,
        observed: own,
        limit: inclusive,
        detail:
          `Scope "${node.metricsScopeId}": self contribution ${String(node.selfValue)} exceeds ` +
          `the inclusive value ${String(node.inclusiveValue)}. The self contribution is part ` +
          `of the total and cannot exceed it.`,
      });
    }

    const children = tree.childrenByParent.get(node.metricsScopeId) ?? [];
    if (children.length === 0) {
      if (Math.abs(node.inclusiveValue - node.selfValue) > epsilon) {
        violations.push({
          code: "leaf_self_differs_from_inclusive",
          metricsScopeId: node.metricsScopeId,
          observed: node.selfValue,
          limit: node.inclusiveValue,
          detail:
            `Scope "${node.metricsScopeId}" has no child scopes, but its self contribution ` +
            `${String(node.selfValue)} differs from the inclusive value ${String(node.inclusiveValue)}. ` +
            `Without descendants, both values must be identical.`,
        });
      }
      continue;
    }
    const childrenSum = children.reduce(
      (sum, child) => sum + (child.inclusiveValue - perScopeBase),
      0,
    );
    if (own + childrenSum > inclusive + epsilon) {
      const childList = children
        .map((child) => `${child.metricsScopeId}=${String(child.inclusiveValue)}`)
        .join(", ");
      violations.push({
        code: "children_exceed_parent",
        metricsScopeId: node.metricsScopeId,
        observed: own + childrenSum,
        limit: inclusive,
        detail:
          `Scope "${node.metricsScopeId}": self contribution ${String(own)} plus the sum of ` +
          `${String(children.length)} direct children ${String(childrenSum)} equals ` +
          `${String(own + childrenSum)} and exceeds the parent value ${String(inclusive)} ` +
          `(values after subtracting perScopeBase=${String(perScopeBase)}). Children: ${childList}. ` +
          `The parent value is missing child content, or a child value is too large; ` +
          `a root total would be too small. This one-sided bound cannot detect ` +
          `a parent value that is too large; checkScopeCoverage checks that separately.`,
      });
    }
  }

  violations.sort(
    (a, b) =>
      compareCodepoints(a.metricsScopeId, b.metricsScopeId) || compareCodepoints(a.code, b.code),
  );
  return violations;
}

/**
 * Wirft bei jedem Invariantenverstoss. Die Meldung nennt Anzahl und die
 * ersten Verstoesse im Klartext; `context.violations` traegt die volle Liste.
 *
 * Geprueft wird in ZWEI Stufen: erst die Wert- und Bauminvarianten
 * (`checkScopeTreeInvariants`), danach — nur wenn der Baum ueberhaupt
 * wohlgeformt ist — die strukturelle Zaehlpruefung ueber alle drei Lesarten
 * (`checkAllScopeCoverage`). Erst beide zusammen tragen die Aussage, dass die
 * ausgegebenen Summen jeden Scope genau einmal enthalten; die Wertschranke
 * allein taete es nicht (siehe Punkt 6 oben).
 */
export function assertScopeTreeInvariants(
  nodes: readonly ScopeMetricNodeV1[],
  options: ScopeTreeOptions = {},
): void {
  const treeViolations = checkScopeTreeInvariants(nodes, options);
  const violations = treeViolations.length > 0 ? treeViolations : checkAllScopeCoverage(nodes);
  if (violations.length === 0) return;
  const preview = violations
    .slice(0, 3)
    .map((violation) => `${violation.code}: ${violation.detail}`)
    .join(" | ");
  throw new UntangleError(
    "ANALYSIS_INCOMPLETE",
    `scope tree invariants violated (${String(violations.length)} violation(s)): ${preview}`,
    { operation: "complexity.aggregateScopeTree", context: { violations } },
  );
}

/**
 * Liefert genau die Eintraege, die eine Lesart zaehlt — jeder Scope hoechstens
 * einmal, jeweils mit dem fuer die Lesart richtigen Wert. Das Ergebnis geht
 * unveraendert in `aggregate()`; damit gelten count/mean/median/p90/p95/max/
 * Schwellenzaehlung (spec.md §16.10) auf einer doppelzaehlungsfreien Basis.
 *
 * Prueft KEINE Invarianten — dafuer ist `checkScopeTreeInvariants` da. Ein
 * `unknown_parent` wird hier zwangslaeufig wie eine Wurzel behandelt; genau
 * deshalb meldet die Pruefung ihn als Fehler, statt ihn zu tolerieren.
 */
export function selectScopeEntries(
  nodes: readonly ScopeMetricNodeV1[],
  reading: ScopeSumReading,
): AggregationEntry[] {
  const tree = resolveTree(nodes);
  const selection = selectionFor(tree, reading);
  const entries: AggregationEntry[] = [];
  for (const node of tree.nodes) {
    const kind = selection.get(node.metricsScopeId);
    if (kind === undefined) continue;
    const entry: AggregationEntry = {
      metricsScopeId: node.metricsScopeId,
      value: kind === "inclusive" ? node.inclusiveValue : node.selfValue,
    };
    if (node.sloc !== undefined) entry.sloc = node.sloc;
    entries.push(entry);
  }
  return entries;
}

/**
 * Mit welchem Wert ein ausgewaehlter Scope in seine Lesart eingeht — und
 * damit auch, WIE WEIT sein Summand reicht: `"inclusive"` deckt den Scope
 * und alle seine Nachfahren ab, `"self"` nur ihn selbst.
 */
export type ScopeSelectionKind = "inclusive" | "self";

/**
 * Welche Scopes eine Lesart als Summanden zaehlt und mit welcher Reichweite.
 * Was nicht in der Abbildung steht, ist kein eigener Summand.
 */
export type ScopeSelectionV1 = ReadonlyMap<string, ScopeSelectionKind>;

/**
 * Die Auswahl einer Lesart. Einzige Quelle der Wahrheit fuer
 * `selectScopeEntries` UND `checkScopeCoverage`: die Pruefung soll dieselbe
 * Auswahl sehen, die auch summiert wird, sonst prueft sie etwas anderes als
 * das, was ausgegeben wird.
 */
export function selectionForReading(
  nodes: readonly ScopeMetricNodeV1[],
  reading: ScopeSumReading,
): ScopeSelectionV1 {
  return selectionFor(resolveTree(nodes), reading);
}

function selectionFor(
  tree: ResolvedTree,
  reading: ScopeSumReading,
): Map<string, ScopeSelectionKind> {
  const selection = new Map<string, ScopeSelectionKind>();
  for (const node of tree.nodes) {
    switch (reading) {
      case "self":
        selection.set(node.metricsScopeId, "self");
        break;
      case "top_level":
        if (node.parentScopeId === undefined || !tree.byId.has(node.parentScopeId)) {
          selection.set(node.metricsScopeId, "inclusive");
        }
        break;
      case "execution_unit":
        // Ein Scope MIT umschliessender Ausfuehrungseinheit ist bereits in
        // deren `inclusiveValue` enthalten und darf nicht erneut zaehlen.
        if (enclosingExecutionUnit(node, tree.byId) === null) {
          selection.set(node.metricsScopeId, node.executionUnit ? "inclusive" : "self");
        }
        break;
    }
  }
  return selection;
}

/**
 * Prueft STRUKTURELL, dass eine Lesart jeden Scope genau einmal zaehlt — die
 * Zusicherung, die `children_exceed_parent` NICHT leisten kann (siehe die
 * Modul-Doku, Abschnitt "Woraus die Doppelzaehlungsfreiheit tatsaechlich
 * folgt", und Punkt 6 von `checkScopeTreeInvariants`).
 *
 * Fuer jeden Scope wird gezaehlt, wie viele Summanden der Lesart seinen
 * Beitrag tragen: er selbst, falls er ausgewaehlt ist, plus jeder echte
 * Vorfahre, der mit `inclusiveValue` ausgewaehlt ist (dessen Summand deckt
 * den ganzen Teilbaum ab). Genau EINER muss es sein.
 *
 * Was die Pruefung NICHT leisten kann: sie sieht die Struktur, nicht die
 * Werte. Ein `inclusiveValue`, der den Beitrag eines Kindes intern doppelt
 * enthaelt, ist aus Zahlen allein nicht erkennbar — dafuer haftet der
 * Aufrufer, der die Werte berechnet hat.
 */
export function checkScopeCoverage(
  nodes: readonly ScopeMetricNodeV1[],
  reading: ScopeSumReading,
): ScopeInvariantViolationV1[] {
  return checkSelectionCoverage(nodes, selectionForReading(nodes, reading), reading);
}

/**
 * Dieselbe Zaehlpruefung wie `checkScopeCoverage`, aber gegen eine BELIEBIGE
 * Auswahl. Sie ist der eigentliche Kern; `checkScopeCoverage` ist nur die
 * Anwendung auf die Auswahl, die eine der drei Lesarten trifft.
 *
 * Getrennt exportiert, weil die Zusicherung sonst nicht vorfuehrbar waere:
 * die Auswahlen der drei Lesarten koennen `scope_counted_twice` per
 * Konstruktion nicht ausloesen (dort ist ein Scope ausgewaehlt GENAU DANN,
 * wenn er keinen ausgewaehlten `inclusive`-Vorfahren hat). Eine Pruefung,
 * deren Alarmfall ueber die oeffentliche Schnittstelle nicht erreichbar ist,
 * waere eine Behauptung statt einer Pruefung — mit dieser Funktion laesst er
 * sich zeigen, und der Waechter greift, sobald jemand `selectionFor` aendert.
 *
 * @param label Erscheint im Detailtext an der Stelle der Lesart.
 */
export function checkSelectionCoverage(
  nodes: readonly ScopeMetricNodeV1[],
  selection: ScopeSelectionV1,
  label: string,
): ScopeInvariantViolationV1[] {
  const tree = resolveTree(nodes);
  const violations: ScopeInvariantViolationV1[] = [];

  for (const node of tree.nodes) {
    const carriers: string[] = [];
    if (selection.has(node.metricsScopeId)) carriers.push(node.metricsScopeId);
    const seen = new Set<string>([node.metricsScopeId]);
    let parentId = node.parentScopeId;
    while (parentId !== undefined && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = tree.byId.get(parentId);
      if (parent === undefined) break;
      if (selection.get(parentId) === "inclusive") carriers.push(parentId);
      parentId = parent.parentScopeId;
    }

    if (carriers.length === 1) continue;
    if (carriers.length > 1) {
      violations.push({
        code: "scope_counted_twice",
        metricsScopeId: node.metricsScopeId,
        observed: carriers.length,
        limit: 1,
        detail:
          `Selection "${label}": the contribution of scope "${node.metricsScopeId}" appears in ` +
          `${String(carriers.length)} contributing terms simultaneously (${carriers.join(", ")}). ` +
          `The total counts the same source text more than once.`,
      });
      continue;
    }
    violations.push({
      code: "scope_uncounted",
      metricsScopeId: node.metricsScopeId,
      observed: 0,
      limit: 1,
      detail:
        `Selection "${label}": the contribution of scope "${node.metricsScopeId}" belongs to no ` +
        `contributing term. Its content is lost from the total without a replacement; ` +
        `silently losing content is forbidden by E4.`,
    });
  }

  violations.sort(
    (a, b) =>
      compareCodepoints(a.metricsScopeId, b.metricsScopeId) || compareCodepoints(a.code, b.code),
  );
  return violations;
}

/**
 * `checkScopeCoverage` fuer ALLE drei Lesarten, Verstoesse deterministisch
 * nach Lesart und Scope sortiert.
 */
export function checkAllScopeCoverage(
  nodes: readonly ScopeMetricNodeV1[],
): ScopeInvariantViolationV1[] {
  return SCOPE_SUM_READINGS.flatMap((reading) => checkScopeCoverage(nodes, reading));
}

/** Naechster Vorfahre, der Ausfuehrungseinheit ist; `null`, wenn es keinen gibt. */
function enclosingExecutionUnit(
  node: ScopeMetricNodeV1,
  byId: ReadonlyMap<string, ScopeMetricNodeV1>,
): ScopeMetricNodeV1 | null {
  const seen = new Set<string>([node.metricsScopeId]);
  let parentId = node.parentScopeId;
  while (parentId !== undefined && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (parent === undefined) return null;
    if (parent.executionUnit) return parent;
    parentId = parent.parentScopeId;
  }
  return null;
}

/**
 * Summiert einen Scope-Baum in allen drei Lesarten, ohne Doppelzaehlung.
 *
 * WIRFT bei jedem Invariantenverstoss (`UntangleError`, Code
 * `ANALYSIS_INCOMPLETE`): eine Summe ueber einen widerspruechlichen Baum ist
 * keine Zahl mit Bedeutung, und ein Hinweis waere hier zu wenig. Wer die
 * Verstoesse anzeigen statt abbrechen will, ruft vorher
 * `checkScopeTreeInvariants` auf.
 */
export function aggregateScopeTree(
  nodes: readonly ScopeMetricNodeV1[],
  options: ScopeTreeOptions = {},
): ScopeTreeAggregateV1 {
  assertScopeTreeInvariants(nodes, options);
  const tree = resolveTree(nodes);

  const sumOf = (reading: ScopeSumReading): number =>
    selectScopeEntries(nodes, reading).reduce((sum, entry) => sum + entry.value, 0);

  let rootCount = 0;
  let executionUnitRootCount = 0;
  let leafCount = 0;
  let naiveSum = 0;
  let leafOnlySum = 0;
  for (const node of tree.nodes) {
    naiveSum += node.inclusiveValue;
    if (node.parentScopeId === undefined) rootCount++;
    if (node.executionUnit && enclosingExecutionUnit(node, tree.byId) === null) {
      executionUnitRootCount++;
    }
    if ((tree.childrenByParent.get(node.metricsScopeId) ?? []).length === 0) {
      leafCount++;
      leafOnlySum += node.inclusiveValue;
    }
  }

  const topLevelSum = sumOf("top_level");
  const selfSum = sumOf("self");
  return {
    scopeCount: tree.nodes.length,
    duplicatesDropped: tree.duplicatesDropped,
    rootCount,
    executionUnitRootCount,
    leafCount,
    topLevelSum,
    executionUnitSum: sumOf("execution_unit"),
    selfSum,
    naiveSum,
    doubleCountedAmount: naiveSum - topLevelSum,
    leafOnlySum,
    leafOnlyDroppedAmount: selfSum - leafOnlySum,
  };
}
