/**
 * Aufloesung von Aufrufstellen zu Zielsymbolen — mit EHRLICHER Confidence
 * (architecture.md §17.2; docs/BUILD_PLAN.md §12 E4).
 *
 * Die Regel dieses Moduls in einem Satz: eine Kante behauptet nie mehr
 * Genauigkeit, als ihre Herleitung hergibt.
 *
 * - `exact` gibt es nur, wenn die Bindung BEWIESEN ist: eine Deklaration in
 *   derselben Datei, der KEINE Importbindung desselben Namens widerspricht,
 *   oder eine Importbindung, deren Modul der DATEIGRAPH aufgeloest hat, deren
 *   ALIAS-ZUORDNUNG der Adapter gemeldet hat und in deren Zieldatei genau ein
 *   passender Export steht.
 *
 * WARUM DIE DECKUNGSGLEICHE DECLARATION KEIN FREIBRIEF IST (Welle-3b-Befund):
 * bindet eine Datei denselben Namen ZUSAETZLICH per Import, entscheidet die
 * Reihenfolge im Quelltext, welche Bindung am Aufrufort gilt — in Python
 * gewinnt die spaetere. Diese Reihenfolge kennt dieses Paket nicht, also ist
 * die Kante mehrdeutig und traegt beide Kandidaten. Frueher gewann die lokale
 * Deklaration kampflos: `exact`/1/`deterministic`, die konkurrierende Bindung
 * spurlos verschwunden.
 *
 * WO DER BEWEIS FRUEHER FEHLTE (Welle-3-Befund): `RawImport.importedNames`
 * traegt nur den LOKALEN Namen. Wer ihn gegen die Exporte der Zieldatei haelt,
 * loest `import { run as go }` auf `lib.go` statt auf `lib.run` auf — und
 * zwar als `exact`/`deterministic`. `validateSymbolEdge` kann das NICHT
 * abfangen: eine Kante mit resolution `exact`, Confidence 1 und Basis
 * `deterministic` ist in sich stimmig; falsch ist nur das ZIEL, und das kennt
 * der Vertrag nicht. Die Durchsetzungsstelle ist deshalb hier, an der Stelle,
 * an der `exact` BEHAUPTET wird: `exact` setzt {@link BindingProbe.proven}
 * voraus, und das ist nur wahr, wenn `RawImport.bindings` die Zuordnung
 * lokal → importiert wirklich liefert. Fehlt sie, bleibt die Kante
 * `heuristic` mit dem Signal `import_alias_unreported`.
 * - `heuristic` ist Namensgleichheit ohne Beweis (workspaceweit eindeutiger
 *   Name; Qualifizierer, der auf einen bekannten Scope passt).
 * - `ambiguous` behaelt ALLE Kandidaten. Es gibt in diesem Modul keine Stelle,
 *   die bei mehreren Kandidaten heimlich einen auswaehlt; das ist der Kern
 *   von E4 fuer Graphen.
 * - `unresolved` traegt einen benannten Grund und ein Pflichtdetail.
 *
 * Modulspezifizierer loest dieses Paket ABSICHTLICH nicht selbst auf. Das ist
 * Aufgabe des Dateigraphen; sein Ergebnis kommt als
 * `ResolvedImportTargetV1[]` herein. Fehlt es, bleiben Kanten heuristisch —
 * ein zweiter, konkurrierender Modulresolver waere genau die Vertragsspaltung,
 * die dieses Projekt vermeidet.
 */
import type {
  GraphConfidenceV1,
  RawImport,
  RawImportBindingKind,
  SymbolEdgeResolution,
  SymbolEdgeUnresolvedReason,
  SymbolNodeV1,
} from "@untangle-code/domain";
import { UntangleError, compareCodepoints } from "@untangle-code/domain";

import type { ResolvedImportTargetV1, SymbolGraphBuildOptions } from "./types.js";

/** Vorgaben der Aufloesung; jede Zahl ist bewusst konservativ. */
export const RESOLUTION_DEFAULTS = {
  /** Workspaceweit eindeutiger Name, ohne Importbeweis. */
  uniqueNameConfidence: 0.6,
  /** Bindung ueber einen Qualifizierer (`obj.method()`); der Empfaenger bleibt unbewiesen. */
  qualifiedNameConfidence: 0.5,
  /** Hoechste Confidence, die eine mehrdeutige Kante tragen darf (< 1, architecture.md §17.2). */
  maxAmbiguousConfidence: 0.99,
  maxCandidates: 16,
} as const;

/** Nachschlagetabellen ueber alle Symbolknoten des Workspaces. */
export interface SymbolNameIndex {
  byId: ReadonlyMap<string, SymbolNodeV1>;
  byFileId: ReadonlyMap<string, readonly SymbolNodeV1[]>;
  byName: ReadonlyMap<string, readonly SymbolNodeV1[]>;
  byQualifiedName: ReadonlyMap<string, readonly SymbolNodeV1[]>;
}

function push(map: Map<string, SymbolNodeV1[]>, key: string, node: SymbolNodeV1): void {
  const bucket = map.get(key);
  if (bucket === undefined) {
    map.set(key, [node]);
    return;
  }
  bucket.push(node);
}

/**
 * Baut die Namensindizes. Jede Trefferliste ist nach `id` (Codepoints)
 * sortiert, damit die Aufloesung unabhaengig von der Dateireihenfolge
 * dasselbe Ergebnis liefert.
 */
export function buildSymbolNameIndex(nodes: readonly SymbolNodeV1[]): SymbolNameIndex {
  const byId = new Map<string, SymbolNodeV1>();
  const byFileId = new Map<string, SymbolNodeV1[]>();
  const byName = new Map<string, SymbolNodeV1[]>();
  const byQualifiedName = new Map<string, SymbolNodeV1[]>();

  for (const node of nodes) {
    byId.set(node.id, node);
    push(byFileId, node.fileId, node);
    push(byName, node.name, node);
    push(byQualifiedName, node.qualifiedName, node);
  }
  for (const bucket of [...byFileId.values(), ...byName.values(), ...byQualifiedName.values()]) {
    bucket.sort((a, b) => compareCodepoints(a.id, b.id));
  }
  return { byId, byFileId, byName, byQualifiedName };
}

/**
 * EINE Namensbindung der Aufruferdatei.
 *
 * Getrennt von `RawImport`, weil ein Importsatz mehrere Namen bindet und weil
 * ZWEI Saetze denselben lokalen Namen binden koennen (`from a import run` und
 * danach `from b import run`). Diese Kollision ist eine echte Mehrdeutigkeit
 * und darf nicht als Gewissheit auf den erstbesten Satz auflaufen.
 */
export interface FileImportBinding {
  /** Importsatz, aus dem die Bindung stammt. */
  statement: RawImport;
  /** Name, unter dem die Bindung in der Aufruferdatei sichtbar ist. */
  localName: string;
  /** Name im Zielmodul; fehlt bei `namespace`/`wildcard` und bei Adaptern ohne Bindungsangabe. */
  importedName?: string;
  /**
   * Bindungsform. `"unreported"` heisst: der Adapter hat sie NICHT gemeldet —
   * die Alias-Zuordnung ist unbekannt und aus Namensgleichheit folgt kein
   * Beweis. Bewusst ein eigener Wert statt `undefined`, damit jede
   * Fallunterscheidung ihn benennen MUSS.
   */
  kind: RawImportBindingKind | "unreported";
}

/** Kontext einer einzelnen Aufloesung. */
export interface CallResolutionContext {
  /** Datei-ID der Aufrufstelle. */
  fromFileId: string;
  /** "/"-normalisierter Pfad der Aufrufstelle (fuer die Kandidatengewichtung). */
  fromFilePath: string;
  /**
   * Lokaler Name → ALLE Bindungen dieses Namens, in Quelltextreihenfolge.
   * Eine Liste, kein Einzelwert: bei Namenskollision bleiben beide Bindungen
   * sichtbar, statt dass die zweite still verschwindet (E4).
   */
  importBindings: ReadonlyMap<string, readonly FileImportBinding[]>;
  /** Spezifizierer → Aufloesung des Dateigraphen. */
  importTargets: ReadonlyMap<string, ResolvedImportTargetV1>;
}

/** Ein gewichteter Aufloesungskandidat. */
export interface WeightedCandidate {
  node: SymbolNodeV1;
  /** Anteil in [0, 1]; die Summe aller Gewichte ist nie groesser als 1. */
  weight: number;
}

/** Ergebnis einer Aufloesung. */
export interface CallResolutionOutcome {
  resolution: SymbolEdgeResolution;
  /** Gesetzt bei `exact` und `heuristic`. */
  target?: SymbolNodeV1;
  /** Gesetzt bei `ambiguous` (mindestens zwei Eintraege). */
  candidates?: WeightedCandidate[];
  confidence: GraphConfidenceV1;
  unresolvedReason?: SymbolEdgeUnresolvedReason;
  unresolvedDetail?: string;
  /** Wegen `maxCandidates` nicht behaltene Kandidaten (E4: nie stillschweigend). */
  droppedCandidates: SymbolNodeV1[];
  /**
   * Begruendete Anmerkungen zur Aufloesung, die der Aufbau in den Skip-Ledger
   * schreibt: konkurrierende Bindungen desselben Namens, Bindungen, deren
   * Modul nicht aufgeloest werden konnte, waehrend eine andere traf. Ohne sie
   * verschwaende jede dieser Auslassungen spurlos (E4).
   */
  notes: string[];
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/**
 * Bewertet einen Kandidaten nach Naehe zur Aufrufstelle. Rein struktureller
 * Vergleich, keine Textaehnlichkeit — damit die Gewichte reproduzierbar sind.
 */
function proximityScore(
  candidate: SymbolNodeV1,
  context: CallResolutionContext,
  importedFileIds: ReadonlySet<string>,
): number {
  if (candidate.fileId === context.fromFileId) return 4;
  if (importedFileIds.has(candidate.fileId)) return 3;
  if (directoryOf(candidate.filePath) === directoryOf(context.fromFilePath)) return 2;
  return 1;
}

/** Schneidet auf sechs Nachkommastellen ab (nie auf), damit die Gewichtssumme nie ueber 1 steigt. */
function floorTo6(value: number): number {
  return Math.floor(value * 1e6) / 1e6;
}

/**
 * Sortiert Kandidaten deterministisch (Naehe absteigend, dann `id` nach
 * Codepoints) und verteilt Gewichte proportional zur Naehe.
 */
export function weightCandidates(
  candidates: readonly SymbolNodeV1[],
  context: CallResolutionContext,
  importedFileIds: ReadonlySet<string>,
): WeightedCandidate[] {
  const scored = candidates.map((node) => ({
    node,
    score: proximityScore(node, context, importedFileIds),
  }));
  scored.sort((a, b) => b.score - a.score || compareCodepoints(a.node.id, b.node.id));
  const total = scored.reduce((sum, entry) => sum + entry.score, 0);
  if (total === 0) {
    return scored.map((entry) => ({ node: entry.node, weight: 0 }));
  }
  return scored.map((entry) => ({ node: entry.node, weight: floorTo6(entry.score / total) }));
}

function collectImportedFileIds(context: CallResolutionContext): Set<string> {
  const ids = new Set<string>();
  for (const target of context.importTargets.values()) {
    if (target.fromFileId === context.fromFileId && target.toFileId !== null) {
      ids.add(target.toFileId);
    }
  }
  return ids;
}

interface DecisionInput {
  candidates: readonly SymbolNodeV1[];
  /** Aufloesungsart bei GENAU EINEM Kandidaten. */
  singleResolution: "exact" | "heuristic";
  /**
   * Confidence bei GENAU EINEM Kandidaten und `singleResolution: "heuristic"`.
   * Bei `"exact"` ist sie immer 1 und dieses Feld wird ignoriert.
   */
  singleConfidence: number;
  signals: readonly string[];
  context: CallResolutionContext;
  importedFileIds: ReadonlySet<string>;
  options: Required<SymbolGraphBuildOptions>;
}

/**
 * Wandelt eine Kandidatenliste in ein Ergebnis. EIN Kandidat wird zum Ziel,
 * MEHRERE bleiben mehrdeutig — hier wird nie ausgewaehlt.
 */
function decide(input: DecisionInput): CallResolutionOutcome | null {
  if (input.candidates.length === 0) return null;

  const weighted = weightCandidates(input.candidates, input.context, input.importedFileIds);
  const first = weighted[0];
  if (weighted.length === 1 && first !== undefined) {
    const value = input.singleResolution === "exact" ? 1 : input.singleConfidence;
    return {
      resolution: input.singleResolution,
      target: first.node,
      confidence: {
        value,
        basis: input.singleResolution === "exact" ? "deterministic" : "heuristic",
        signals: [...input.signals],
      },
      droppedCandidates: [],
      notes: [],
    };
  }

  const kept = weighted.slice(0, input.options.maxCandidates);
  const dropped = weighted.slice(input.options.maxCandidates).map((entry) => entry.node);
  const topWeight = kept[0]?.weight ?? 0;
  const signals = [...input.signals, "multiple_candidates"];
  if (dropped.length > 0) signals.push("candidate_list_truncated");

  return {
    resolution: "ambiguous",
    candidates: kept,
    confidence: {
      value: Math.min(topWeight, RESOLUTION_DEFAULTS.maxAmbiguousConfidence),
      basis: "heuristic",
      signals,
    },
    droppedCandidates: dropped,
    notes: [],
  };
}

function unresolved(
  reason: SymbolEdgeUnresolvedReason,
  detail: string,
  signals: readonly string[],
): CallResolutionOutcome {
  return {
    resolution: "unresolved",
    confidence: { value: 0, basis: "heuristic", signals: [...signals] },
    unresolvedReason: reason,
    unresolvedDetail: detail,
    droppedCandidates: [],
    notes: [],
  };
}

function rejectOption(field: string, value: number, requirement: string): never {
  throw new UntangleError(
    "CONFIG_INVALID",
    `SymbolGraphBuildOptions.${field} is ${String(value)}, but ${requirement}`,
    { operation: "buildSymbolGraph", context: { field, value } },
  );
}

/**
 * Fuellt fehlende Optionen mit den dokumentierten Vorgaben — und WEIST
 * unzulaessige Werte ZURUECK, statt sie stillschweigend zu verbiegen.
 *
 * Warum die Pruefung hier steht und nicht erst an der Kante: `maxCandidates`
 * kleiner als 2 laesst `decide()` eine mehrdeutige Kante mit weniger als zwei
 * Kandidaten bauen. `validateSymbolEdge` bemerkt das zwar (`insufficient_
 * candidates`), aber erst, wenn die Kante fertig ist — und der Aufbau
 * verwirft sie dann VOLLSTAENDIG. Eine oeffentliche Option, die den Graphen
 * loescht statt ihn zu beschneiden, ist ein Vertragsbruch am Eingang; dort
 * gehoert er gemeldet.
 */
export function withResolutionDefaults(
  options: SymbolGraphBuildOptions | undefined,
): Required<SymbolGraphBuildOptions> {
  const resolved = {
    uniqueNameConfidence: options?.uniqueNameConfidence ?? RESOLUTION_DEFAULTS.uniqueNameConfidence,
    qualifiedNameConfidence:
      options?.qualifiedNameConfidence ?? RESOLUTION_DEFAULTS.qualifiedNameConfidence,
    maxCandidates: options?.maxCandidates ?? RESOLUTION_DEFAULTS.maxCandidates,
  };
  if (!Number.isInteger(resolved.maxCandidates) || resolved.maxCandidates < 2) {
    rejectOption(
      "maxCandidates",
      resolved.maxCandidates,
      "an ambiguous edge carries at least two candidates (validateSymbolEdge); a lower limit would not shorten the candidate list, it would delete the whole edge",
    );
  }
  for (const field of ["uniqueNameConfidence", "qualifiedNameConfidence"] as const) {
    const value = resolved[field];
    if (!(value > 0 && value < 1)) {
      rejectOption(
        field,
        value,
        "a heuristic edge must claim more than nothing and less than certainty: 0 < value < 1 (architecture.md §17.2)",
      );
    }
  }
  return resolved;
}

/**
 * Loest einen Aufruf auf.
 *
 * Reihenfolge fuer UNQUALIFIZIERTE Aufrufe (`foo()`):
 * 1. Deklaration in derselben Datei → `exact` (Beweis: gleiche Datei), ABER
 *    nur, wenn keine Importbindung desselben Namens einen Kandidaten
 *    beisteuert; sonst `ambiguous` ueber beide Seiten mit Ledger-Eintrag.
 * 2. Importbindung mit vom Dateigraphen aufgeloestem Modul → `exact`, wenn die
 *    Zieldatei genau einen passenden Export hat.
 * 3. Workspaceweiter Namenstreffer → `heuristic` bei Eindeutigkeit.
 * Bleibt alles erfolglos: `unresolved` mit benanntem Grund.
 *
 * Fuer QUALIFIZIERTE Aufrufe (`obj.foo()`) gibt es NIE `exact`: der Empfaenger
 * ist statisch nicht bewiesen. Bestenfalls `heuristic`.
 */
export function resolveCall(
  calleeName: string,
  qualifier: string | undefined,
  index: SymbolNameIndex,
  context: CallResolutionContext,
  options: Required<SymbolGraphBuildOptions>,
): CallResolutionOutcome {
  const importedFileIds = collectImportedFileIds(context);
  const sameFile = index.byFileId.get(context.fromFileId) ?? [];

  if (qualifier !== undefined && qualifier !== "") {
    return resolveQualified(
      calleeName,
      qualifier,
      index,
      context,
      options,
      importedFileIds,
      sameFile,
    );
  }
  return resolveUnqualified(calleeName, index, context, options, importedFileIds, sameFile);
}

function resolveQualified(
  calleeName: string,
  qualifier: string,
  index: SymbolNameIndex,
  context: CallResolutionContext,
  options: Required<SymbolGraphBuildOptions>,
  importedFileIds: ReadonlySet<string>,
  sameFile: readonly SymbolNodeV1[],
): CallResolutionOutcome {
  const memberFqn = `${qualifier}.${calleeName}`;

  const localMembers = sameFile.filter((node) => node.qualifiedName === memberFqn);
  const localDecision = decide({
    candidates: localMembers,
    singleResolution: "heuristic",
    singleConfidence: options.qualifiedNameConfidence,
    signals: ["qualifier_binding", "qualified_name_in_same_file"],
    context,
    importedFileIds,
    options,
  });
  if (localDecision !== null) return localDecision;

  const globalMembers = index.byQualifiedName.get(memberFqn) ?? [];
  const globalDecision = decide({
    candidates: globalMembers,
    singleResolution: "heuristic",
    singleConfidence: options.qualifiedNameConfidence,
    signals: ["qualifier_binding", "qualified_name_in_workspace"],
    context,
    importedFileIds,
    options,
  });
  if (globalDecision !== null) return globalDecision;

  // Der Qualifizierer selbst kann ein importiertes Modulobjekt sein
  // (`import * as svc from "./x"; svc.run()`). Bindet die Datei denselben
  // Qualifizierer mehrfach, tragen ALLE Bindungen bei — es wird nicht die
  // erste bevorzugt.
  const qualifierBindings = context.importBindings.get(qualifier) ?? [];
  if (qualifierBindings.length > 0) {
    const seen = new Set<string>();
    const inTarget: SymbolNodeV1[] = [];
    for (const binding of qualifierBindings) {
      const target = context.importTargets.get(binding.statement.specifier);
      if (target === undefined || target.toFileId === null) continue;
      for (const node of index.byFileId.get(target.toFileId) ?? []) {
        if (node.name !== calleeName && !(node.exportedAs ?? []).includes(calleeName)) continue;
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        inTarget.push(node);
      }
    }
    const decision = decide({
      candidates: inTarget,
      singleResolution: "heuristic",
      singleConfidence: options.qualifiedNameConfidence,
      signals: ["qualifier_binding", "qualifier_is_imported_module", "resolved_module"],
      context,
      importedFileIds,
      options,
    });
    if (decision !== null) {
      if (qualifierBindings.length > 1) {
        decision.notes.push(shadowedBindingNote(qualifier, qualifierBindings, decision.resolution));
      }
      return decision;
    }
  }

  const byName = index.byName.get(calleeName) ?? [];
  const nameDecision = decide({
    candidates: byName,
    singleResolution: "heuristic",
    singleConfidence: options.qualifiedNameConfidence,
    signals: ["qualifier_binding", "member_name_only"],
    context,
    importedFileIds,
    options,
  });
  if (nameDecision !== null) return nameDecision;

  return unresolved(
    "dynamic_dispatch_not_statically_analyzable",
    `qualified call "${qualifier}.${calleeName}()" has no candidate: neither "${memberFqn}" nor a symbol named "${calleeName}" exists in the index, and the receiver "${qualifier}" is not a resolved module binding`,
    ["qualifier_binding", "no_candidate"],
  );
}

// ---------------------------------------------------------------------------
// Importbindungen
// ---------------------------------------------------------------------------

/** Ergebnis des Abgleichs einer Bindung gegen die Symbole der Zieldatei. */
interface ExportMatch {
  nodes: SymbolNodeV1[];
  /** Name, gegen den geprueft wurde — steht so im Ledger- und Fehlertext. */
  wanted: string;
  /**
   * True, wenn der Abgleich den Namen im ZIELMODUL kannte (kein Alias-Raten)
   * UND die Zieldatei diesen Namen nachweislich exportiert (WP-179).
   */
  proven: boolean;
  /** WP-179: Der Treffer kam ueber `node.name`, nicht ueber einen deklarierten Export. */
  exportUndeclared?: boolean;
}

/**
 * Gleicht eine Bindung gegen die Symbole der Zieldatei ab.
 *
 * Der `proven`-Ausgang ist die Stelle, an der die Ehrlichkeit der Kante
 * entschieden wird: nur wenn der Adapter den Namen im Zielmodul gemeldet hat
 * (`named`/`default`), pruefen wir gegen den RICHTIGEN Namen und duerfen
 * `exact` behaupten. Ohne Bindungsangabe pruefen wir gegen den LOKALEN Namen —
 * das kann zufaellig treffen und ist deshalb bestenfalls `heuristic`.
 */
function matchExportedNodes(
  nodes: readonly SymbolNodeV1[],
  calleeName: string,
  binding: FileImportBinding,
): ExportMatch {
  const byName = (wanted: string): SymbolNodeV1[] =>
    nodes.filter((node) => node.name === wanted || (node.exportedAs ?? []).includes(wanted));

  switch (binding.kind) {
    case "named":
    case "default": {
      const wanted = binding.importedName;
      if (wanted === undefined) {
        // `RawImportBinding.importedName` ist im Domainvertrag OPTIONAL
        // (packages/domain/src/analysis.ts). Eine `named`/`default`-Bindung
        // ohne diesen Namen ist also vertragskonform — sie sagt aber genau
        // NICHT, welcher Name im Zielmodul gemeint ist. Der Rueckfall auf den
        // LOKALEN Namen ist deshalb dasselbe Raten wie bei `"unreported"` und
        // darf nie als Beweis gelten. Frueher stand hier
        // `binding.importedName ?? calleeName` mit `proven: true`: die
        // widerlegte Herleitung wurde als bewiesen verbucht.
        return { nodes: byName(calleeName), wanted: calleeName, proven: false };
      }
      // WP-179: EIN NAMENSTREFFER IST KEIN EXPORTNACHWEIS.
      //
      // `byName` trifft auf zwei Wegen: ueber `node.exportedAs` (die Datei
      // exportiert diesen Namen — das ist der Beweis) und ueber `node.name`
      // (die Datei ENTHAELT ein so heissendes Symbol — das ist eine
      // Vermutung). Beide galten bisher als bewiesen, also `exact`,
      // Konfidenz 1, `deterministic`, Signal `unique_export`. Eine Kante, die
      // „unique_export" sagt, obwohl die Zieldatei diesen Namen nirgends
      // exportiert, behauptet genau das Gegenteil dessen, was beobachtet
      // wurde.
      //
      // Liegt ein echter Exportnachweis vor, gewinnt er auch inhaltlich: das
      // exportierte Symbol ist das gebundene, nicht ein gleichnamiges
      // internes daneben.
      const exported = nodes.filter((node) => (node.exportedAs ?? []).includes(wanted));
      if (exported.length > 0) {
        return { nodes: exported, wanted, proven: true };
      }
      return { nodes: byName(wanted), wanted, proven: false, exportUndeclared: true };
    }
    case "namespace":
      // Ein Modulobjekt ist selbst nicht aufrufbar; `svc()` bindet kein
      // Symbol der Zieldatei. Qualifizierte Aufrufe (`svc.run()`) laufen
      // ueber resolveQualified.
      return { nodes: [], wanted: binding.localName, proven: false };
    case "wildcard":
      // `from m import *` bindet jeden EXPORTIERTEN Namen. Nicht exportierte
      // Symbole der Zieldatei sind damit nicht gebunden.
      return {
        nodes: nodes.filter((node) => (node.exportedAs ?? []).includes(calleeName)),
        wanted: calleeName,
        proven: false,
      };
    case "unreported":
      return { nodes: byName(calleeName), wanted: calleeName, proven: false };
  }
}

/** Ein Aufloesungsversuch fuer GENAU EINE Bindung. */
interface BindingProbe {
  binding: FileImportBinding;
  candidates: SymbolNodeV1[];
  proven: boolean;
  /** WP-179: Der Treffer kam ueber `node.name`, nicht ueber einen deklarierten Export. */
  exportUndeclared?: boolean;
  failure?: { reason: SymbolEdgeUnresolvedReason; detail: string; moduleMissing: boolean };
}

function probeBinding(
  calleeName: string,
  binding: FileImportBinding,
  index: SymbolNameIndex,
  context: CallResolutionContext,
): BindingProbe {
  const specifier = binding.statement.specifier;
  const target = context.importTargets.get(specifier);
  if (target === undefined) {
    return {
      binding,
      candidates: [],
      proven: false,
      failure: {
        reason: "import_unresolved",
        detail: `"${calleeName}" is imported from "${specifier}", but no module resolution was supplied for that specifier`,
        moduleMissing: true,
      },
    };
  }
  if (target.toFileId === null) {
    const external = target.external === true;
    return {
      binding,
      candidates: [],
      proven: false,
      failure: {
        reason: external ? "target_outside_index" : "import_unresolved",
        detail: external
          ? `"${calleeName}" is imported from "${specifier}", which the file graph classified as external to the index`
          : `"${calleeName}" is imported from "${specifier}", which the file graph could not resolve: ${target.unresolvedDetail ?? "no detail supplied by the file graph"}`,
        moduleMissing: false,
      },
    };
  }
  const match = matchExportedNodes(index.byFileId.get(target.toFileId) ?? [], calleeName, binding);
  if (match.nodes.length === 0) {
    return {
      binding,
      candidates: [],
      proven: false,
      failure: {
        reason: "no_candidate_found",
        detail: `"${calleeName}" is imported from "${specifier}" as ${describeBinding(binding)}, which resolves to file "${target.toFileId}", but that file has no symbol "${match.wanted}"`,
        moduleMissing: false,
      },
    };
  }
  return {
    binding,
    candidates: match.nodes,
    proven: match.proven,
    ...(match.exportUndeclared === true ? { exportUndeclared: true } : {}),
  };
}

/**
 * Ist die Zuordnung lokal → importiert UNBEKANNT? Dann wird gegen den lokalen
 * Namen geraten, und aus einem Treffer folgt kein Beweis.
 *
 * Zwei Faelle, EINE Regel: der Adapter hat die Bindungsform gar nicht gemeldet
 * (`"unreported"`), ODER er hat `named`/`default` gemeldet, aber
 * `importedName` weggelassen. Der zweite Fall ist vertragskonform und wurde
 * frueher wie ein Beweis behandelt.
 */
function aliasIsUnknown(binding: FileImportBinding): boolean {
  if (binding.kind === "unreported") return true;
  return (
    (binding.kind === "named" || binding.kind === "default") && binding.importedName === undefined
  );
}

/** Menschenlesbare Kurzform einer Bindung fuer Ledger- und Fehlertexte. */
function describeBinding(binding: FileImportBinding): string {
  switch (binding.kind) {
    case "named":
      return binding.importedName === undefined
        ? `the local name "${binding.localName}" (the adapter reported a named import but not the name in the target module)`
        : `the exported name "${binding.importedName}"`;
    case "default":
      return binding.importedName === undefined
        ? `the local name "${binding.localName}" (the adapter reported a default import but not the name in the target module)`
        : "the default export";
    case "namespace":
      return "a module namespace";
    case "wildcard":
      return "a wildcard import";
    case "unreported":
      return `the local name "${binding.localName}" (the adapter did not report the alias mapping)`;
  }
}

/**
 * Alle Bindungen, unter denen ein aufgerufener Name gebunden sein kann: die
 * direkten Bindungen des Namens und jede Wildcard-Bindung der Datei
 * (`from m import *` bindet jeden exportierten Namen).
 */
function bindingsForName(
  context: CallResolutionContext,
  calleeName: string,
): readonly FileImportBinding[] {
  const direct = context.importBindings.get(calleeName) ?? [];
  if (calleeName === "*") return [...direct];
  const wildcards = (context.importBindings.get("*") ?? []).filter(
    (binding) => binding.kind === "wildcard",
  );
  if (wildcards.length === 0) return direct;
  return [...direct, ...wildcards];
}

function shadowedBindingNote(
  name: string,
  bindings: readonly FileImportBinding[],
  resolution: SymbolEdgeResolution,
): string {
  const specifiers = bindings.map((binding) => `"${binding.statement.specifier}"`).join(", ");
  return `"${name}" is bound ${String(bindings.length)} times in this file (${specifiers}); the later binding shadows the earlier one at runtime, so the edge is reported as "${resolution}" over the candidates of ALL bindings instead of claiming the first one`;
}

/**
 * Loest einen Aufruf ueber die Importbindungen seines Namens auf.
 *
 * ZWEI REGELN, die hier zusammenkommen:
 * 1. `exact` nur bei GENAU EINER Bindung, deren Alias-Zuordnung der Adapter
 *    gemeldet hat und deren Zieldatei genau ein passendes Symbol enthaelt.
 * 2. Mehrere Bindungen desselben Namens werden nie zu einer verkuerzt: jede
 *    steuert ihre Kandidaten bei, das Ergebnis wird mehrdeutig statt falsch
 *    sicher, und die Kollision steht in den Anmerkungen (E4).
 */
function resolveViaImportBindings(
  calleeName: string,
  bindings: readonly FileImportBinding[],
  index: SymbolNameIndex,
  context: CallResolutionContext,
  options: Required<SymbolGraphBuildOptions>,
  importedFileIds: ReadonlySet<string>,
): CallResolutionOutcome {
  const probes = bindings.map((binding) => probeBinding(calleeName, binding, index, context));
  const contributing = probes.filter((probe) => probe.candidates.length > 0);
  const failed = probes.filter((probe) => probe.failure !== undefined);

  if (contributing.length === 0) {
    const details = failed.map((probe) => probe.failure?.detail ?? "").join("; ");
    if (failed.some((probe) => probe.failure?.moduleMissing === true)) {
      // Der Dateigraph hat zu diesem Spezifizierer nichts geliefert. Wir raten
      // NICHT, sondern fallen auf die Namensheuristik zurueck und markieren,
      // dass die Bindung ungeprueft ist.
      const fallback = decide({
        candidates: index.byName.get(calleeName) ?? [],
        singleResolution: "heuristic",
        singleConfidence: options.uniqueNameConfidence,
        signals: ["import_binding", "module_resolution_missing"],
        context,
        importedFileIds,
        options,
      });
      if (fallback !== null) {
        if (bindings.length > 1) {
          fallback.notes.push(shadowedBindingNote(calleeName, bindings, fallback.resolution));
        }
        return fallback;
      }
      return unresolved(
        "import_unresolved",
        `${details} and no symbol named "${calleeName}" exists in the index`,
        ["import_binding", "module_resolution_missing"],
      );
    }
    const first = probes[0]?.failure;
    return unresolved(first?.reason ?? "no_candidate_found", details, [
      "import_binding",
      first?.moduleMissing === true ? "module_resolution_missing" : "module_unresolved",
    ]);
  }

  const seen = new Set<string>();
  const candidates: SymbolNodeV1[] = [];
  for (const probe of contributing) {
    for (const node of probe.candidates) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      candidates.push(node);
    }
  }

  const first = probes[0];
  const proven = probes.length === 1 && first !== undefined && first.proven;
  const signals = ["import_binding", "resolved_module"];
  if (proven) {
    signals.push("unique_export");
  } else {
    if (contributing.some((probe) => aliasIsUnknown(probe.binding))) {
      signals.push("import_alias_unreported");
    }
    if (contributing.some((probe) => probe.binding.kind === "wildcard")) {
      signals.push("wildcard_import");
    }
    if (contributing.some((probe) => probe.exportUndeclared === true)) {
      // WP-179: benannt, nicht bloss weggelassen. Ohne dieses Signal sieht
      // eine Kante, die auf einem Namenstreffer steht, genauso aus wie eine
      // auf einem unbekannten Alias — zwei verschiedene Unsicherheiten.
      signals.push("export_not_declared");
    }
    if (bindings.length > 1) signals.push("shadowed_import_binding");
    if (failed.length > 0) signals.push("partial_binding_failure");
  }

  const decision = decide({
    candidates,
    singleResolution: proven ? "exact" : "heuristic",
    singleConfidence: options.uniqueNameConfidence,
    signals,
    context,
    importedFileIds,
    options,
  });
  // `candidates` ist hier nie leer, `decide` liefert also nie null.
  if (decision === null) {
    return unresolved("no_candidate_found", `no candidate for "${calleeName}"`, signals);
  }
  if (bindings.length > 1) {
    decision.notes.push(shadowedBindingNote(calleeName, bindings, decision.resolution));
  }
  for (const probe of failed) {
    decision.notes.push(
      `the binding of "${calleeName}" from "${probe.binding.statement.specifier}" contributed no candidate while another binding did: ${probe.failure?.detail ?? ""}`,
    );
  }
  return decision;
}

/**
 * Kandidaten, die die Importbindungen desselben Namens beisteuern — nur die
 * Knoten, ohne Ergebnisaufbau. Gebraucht, um zu ERKENNEN, ob eine lokale
 * Deklaration ueberhaupt Konkurrenz hat.
 */
function importCandidatesForName(
  calleeName: string,
  bindings: readonly FileImportBinding[],
  index: SymbolNameIndex,
  context: CallResolutionContext,
): SymbolNodeV1[] {
  const seen = new Set<string>();
  const nodes: SymbolNodeV1[] = [];
  for (const binding of bindings) {
    for (const node of probeBinding(calleeName, binding, index, context).candidates) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      nodes.push(node);
    }
  }
  return nodes;
}

function shadowedLocalDeclarationNote(
  name: string,
  locals: readonly SymbolNodeV1[],
  bindings: readonly FileImportBinding[],
  resolution: SymbolEdgeResolution,
): string {
  const declared = locals.map((node) => `"${node.qualifiedName}"`).join(", ");
  const specifiers = uniqueSpecifiers(bindings)
    .map((specifier) => `"${specifier}"`)
    .join(", ");
  return `"${name}" is BOTH declared in this file (${declared}) and bound by an import (${specifiers}); whichever of the two is written LATER binds the name at runtime, and this package does not decide that order, so the edge is reported as "${resolution}" over the candidates of both instead of claiming the local declaration`;
}

function uniqueSpecifiers(bindings: readonly FileImportBinding[]): string[] {
  const seen = new Set<string>();
  const specifiers: string[] = [];
  for (const binding of bindings) {
    if (seen.has(binding.statement.specifier)) continue;
    seen.add(binding.statement.specifier);
    specifiers.push(binding.statement.specifier);
  }
  return specifiers;
}

function resolveUnqualified(
  calleeName: string,
  index: SymbolNameIndex,
  context: CallResolutionContext,
  options: Required<SymbolGraphBuildOptions>,
  importedFileIds: ReadonlySet<string>,
  sameFile: readonly SymbolNodeV1[],
): CallResolutionOutcome {
  const localDeclarations = sameFile.filter((node) => node.name === calleeName);
  const bindings = bindingsForName(context, calleeName);

  // VORRANGREGEL, nicht Sonderfall: eine Deklaration in derselben Datei ist
  // nur dann ein BEWEIS, wenn ihr niemand denselben Namen streitig macht.
  // Bindet die Datei denselben Namen ZUSAETZLICH per Import, entscheidet die
  // Reihenfolge im Quelltext, welche Bindung am Aufrufort gilt — in Python
  // gewinnt die spaetere, in TypeScript ist die Doppelbindung ein Fehler des
  // Uebersetzers. Diese Reihenfolge kennt dieses Paket nicht. Frueher kehrte
  // die Aufloesung hier mit `exact`/1/`deterministic` zurueck, BEVOR die
  // Importbindungen ueberhaupt gelesen wurden: die konkurrierende Bindung
  // verschwand spurlos, ohne Kandidat, ohne Signal, ohne Ledger-Eintrag.
  if (localDeclarations.length > 0) {
    const imported =
      bindings.length === 0 ? [] : importCandidatesForName(calleeName, bindings, index, context);
    const localIds = new Set(localDeclarations.map((node) => node.id));
    const rivals = imported.filter((node) => !localIds.has(node.id));
    if (rivals.length > 0) {
      const contested = decide({
        candidates: [...localDeclarations, ...rivals],
        singleResolution: "heuristic",
        singleConfidence: options.uniqueNameConfidence,
        signals: [
          "same_file_declaration",
          "import_binding",
          "resolved_module",
          "shadowed_local_declaration",
        ],
        context,
        importedFileIds,
        options,
      });
      if (contested !== null) {
        contested.notes.push(
          shadowedLocalDeclarationNote(
            calleeName,
            localDeclarations,
            bindings,
            contested.resolution,
          ),
        );
        return contested;
      }
    }
    const localDecision = decide({
      candidates: localDeclarations,
      singleResolution: "exact",
      singleConfidence: 1,
      signals: ["same_file_declaration"],
      context,
      importedFileIds,
      options,
    });
    if (localDecision !== null) return localDecision;
  }

  if (bindings.length > 0) {
    return resolveViaImportBindings(calleeName, bindings, index, context, options, importedFileIds);
  }

  const globalDecision = decide({
    candidates: index.byName.get(calleeName) ?? [],
    singleResolution: "heuristic",
    singleConfidence: options.uniqueNameConfidence,
    signals: ["unique_name_in_workspace"],
    context,
    importedFileIds,
    options,
  });
  if (globalDecision !== null) return globalDecision;

  return unresolved(
    "no_candidate_found",
    `no symbol named "${calleeName}" exists in the index, and the calling file has no import binding for that name`,
    ["no_candidate"],
  );
}
