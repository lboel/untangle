/**
 * Eindeutige Scope-Identitaet fuer die Aggregation (WP-82).
 *
 * ## Warum es dieses Modul gibt
 *
 * spec.md §16.10 verlangt die Deduplizierung ueber `metrics_scope_id`. Das
 * setzt voraus, dass diese Id GENAU EINEN Scope bezeichnet. Der Bezeichner,
 * den die Sprachadapter heute liefern — `SymbolScopeFact.symbolScopeId` — tut
 * das innerhalb einer Datei NICHT: er wird aus dem qualifizierten Namen plus
 * einem Ordinal gebildet, das je Elternscope zaehlt. Zwei anonyme Callbacks
 * unter zwei verschiedenen, ebenfalls anonymen Eltern bekommen damit beide den
 * qualifizierten Namen `<anonymous>.<anonymous>` und beide das Ordinal 0 —
 * dieselbe Id fuer zwei verschiedene Scopes. Am eigenen Repo betrifft das rund
 * ein Fuenftel aller Scopes.
 *
 * Die Folge waere nicht nur eine schiefe Summe, sondern stiller Inhaltsverlust
 * (E4): `aggregate()` verwirft den zweiten Scope als Dublette,
 * `selectSymbolFacts()` liefert die VEREINIGUNG der Facts beider Scopes, und
 * `buildSymbolIR()` baut die IR fuer denjenigen, der die interne Map zuletzt
 * gewonnen hat.
 *
 * ## Was dieses Modul tut
 *
 * `withUniqueScopeIds()` schreibt einen Facts-Satz auf nachweislich eindeutige
 * Scope-Ids um: Byte-Range statt Name plus Ordinal. Jede Fact-Zuordnung wird
 * ueber Byte-Containment neu aufgeloest (der ENGSTE Scope, der die Id des
 * Facts traegt und dessen Range den Fact enthaelt). Die aufgetretenen
 * Kollisionen werden GEZAEHLT UND ZURUECKGEGEBEN, nicht stillschweigend
 * geheilt — wer den Bericht liest, sieht, dass die Adapter-Id das Problem hat,
 * und nicht nur, dass jemand daran vorbeigearbeitet hat.
 *
 * Das ist eine Reparatur an der Datenkante, KEIN Ersatz fuer die Behebung im
 * Adapter. Sobald `symbolScopeId` je Datei eindeutig ist, bleibt `collisions`
 * leer und dieses Modul kann entfallen.
 *
 * ## Grenze (bewusst, nicht verschwiegen)
 *
 * `NodeKindFact` traegt als einzige Fact-Art KEINE `SourceRange` (domain
 * `analysis.ts`); ihre Zuordnung ist ueber Containment daher nicht
 * reparierbar. Sie wird auf den ERSTEN Scope mit der jeweiligen Adapter-Id
 * abgebildet und die Zahl der so behandelten Facts in
 * `nodeKindsAttributedByFallback` ausgewiesen. Betroffen sind nur die
 * syntaktischen Metriken (`computeSyntactic`), nicht Cyclomatic/Cognitive.
 */
import type {
  ComplexityFacts,
  NodeKindFact,
  RawCall,
  SourceRange,
  SymbolScopeFact,
} from "@untangle-code/domain";
import { ID_COMPONENT_SEPARATOR, compareCodepoints } from "@untangle-code/domain";

import { containsRange } from "./scope.js";

/** Eine Adapter-Id, die mehr als einen Scope bezeichnet. */
export interface ScopeIdCollisionV1 {
  /** Die mehrdeutige `symbolScopeId` aus dem Sprachadapter. */
  adapterScopeId: string;
  /** Wie viele verschiedene Scopes sie bezeichnet (>= 2). */
  scopeCount: number;
  /** Startzeilen der betroffenen Scopes, aufsteigend — zum Nachschlagen. */
  startLines: number[];
}

export interface UniqueScopeIdsResultV1 {
  /** Facts mit eindeutigen Scope-Ids; sonst strukturgleich zur Eingabe. */
  facts: ComplexityFacts;
  /** Aufrufe mit umgeschriebenem `callerScopeId`. */
  calls: RawCall[];
  /** Abbildung neue Id -> urspruengliche Adapter-Id, fuer Diagnosen. */
  originalScopeIds: Map<string, string>;
  /** Jede mehrdeutige Adapter-Id, nach Codepoints sortiert. Leer heisst: alles war eindeutig. */
  collisions: ScopeIdCollisionV1[];
  /** `NodeKindFact`s ohne Range, die per Fallback zugeordnet wurden (siehe Modul-Doku). */
  nodeKindsAttributedByFallback: number;
}

interface Rewritten {
  scope: SymbolScopeFact;
  uniqueId: string;
}

/** Byte-Range-basierte, innerhalb einer Datei eindeutige Id. */
function uniqueIdFor(prefix: string, range: SourceRange): string {
  return [prefix, "scope", String(range.startByte), String(range.endByte)].join(
    ID_COMPONENT_SEPARATOR,
  );
}

/** Innerster Scope aus `candidates`, dessen Range `range` enthaelt. */
function innermostOwner(
  candidates: readonly Rewritten[],
  range: SourceRange,
): Rewritten | undefined {
  let best: Rewritten | undefined;
  for (const candidate of candidates) {
    if (!containsRange(candidate.scope.range, range)) continue;
    if (
      best === undefined ||
      candidate.scope.range.endByte - candidate.scope.range.startByte <
        best.scope.range.endByte - best.scope.range.startByte
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Schreibt einen Facts-Satz auf eindeutige Scope-Ids um.
 *
 * @param facts Facts einer Datei, wie der Sprachadapter sie liefert.
 * @param calls Rohaufrufe derselben Datei (`extractCalls`); ihr
 *   `callerScopeId` wird mit umgeschrieben, damit die Rekursionsmarkierung in
 *   `buildSymbolIR` weiter greift.
 * @param idPrefix Praefix der neuen Ids, ueblicherweise der repo-relative
 *   Pfad. Er macht die Ids ueber Dateigrenzen hinweg eindeutig; innerhalb der
 *   Datei sorgt die Byte-Range dafuer.
 *
 * Kann ein Fact ueber Containment keinem Scope zugeordnet werden (er laege
 * ausserhalb jeder Range seines eigenen Scopes — ein Adapterfehler anderer
 * Art), bleibt seine Adapter-Id stehen. Die Aggregation sieht dann einen
 * unbekannten Eltern-Scope und meldet ihn als Invariantenverstoss, statt eine
 * saubere Zahl vorzutaeuschen.
 */
export function withUniqueScopeIds(
  facts: ComplexityFacts,
  calls: readonly RawCall[],
  idPrefix: string,
): UniqueScopeIdsResultV1 {
  const rewritten: Rewritten[] = facts.symbolScopes.map((scope) => ({
    scope,
    uniqueId: uniqueIdFor(idPrefix, scope.range),
  }));

  const byAdapterId = new Map<string, Rewritten[]>();
  for (const entry of rewritten) {
    const bucket = byAdapterId.get(entry.scope.symbolScopeId) ?? [];
    bucket.push(entry);
    byAdapterId.set(entry.scope.symbolScopeId, bucket);
  }

  const collisions: ScopeIdCollisionV1[] = [];
  for (const [adapterScopeId, bucket] of byAdapterId) {
    if (bucket.length < 2) continue;
    collisions.push({
      adapterScopeId,
      scopeCount: bucket.length,
      startLines: bucket.map((entry) => entry.scope.range.startLine).sort((a, b) => a - b),
    });
  }
  collisions.sort((a, b) => compareCodepoints(a.adapterScopeId, b.adapterScopeId));

  const originalScopeIds = new Map<string, string>();
  for (const entry of rewritten) originalScopeIds.set(entry.uniqueId, entry.scope.symbolScopeId);

  /** Neue Id fuer einen Fact mit Range. */
  const resolve = (adapterScopeId: string, range: SourceRange): string => {
    const bucket = byAdapterId.get(adapterScopeId);
    if (bucket === undefined || bucket.length === 0) return adapterScopeId;
    const first = bucket[0] as Rewritten;
    if (bucket.length === 1) return first.uniqueId;
    const owner = innermostOwner(bucket, range);
    return owner === undefined ? adapterScopeId : owner.uniqueId;
  };

  let nodeKindsAttributedByFallback = 0;
  const mappedNodeKinds: NodeKindFact[] = facts.nodeKinds.map((fact) => {
    const bucket = byAdapterId.get(fact.symbolScopeId);
    if (bucket === undefined || bucket.length === 0) return fact;
    if (bucket.length > 1) nodeKindsAttributedByFallback++;
    return { ...fact, symbolScopeId: (bucket[0] as Rewritten).uniqueId };
  });

  const mappedScopes: SymbolScopeFact[] = rewritten.map((entry) => {
    const parentAdapterId = entry.scope.parentScopeId;
    if (parentAdapterId === undefined) {
      return { ...entry.scope, symbolScopeId: entry.uniqueId };
    }
    const parentBucket = byAdapterId.get(parentAdapterId);
    let parentId: string;
    if (parentBucket === undefined || parentBucket.length === 0) {
      parentId = parentAdapterId;
    } else if (parentBucket.length === 1) {
      parentId = (parentBucket[0] as Rewritten).uniqueId;
    } else {
      const owner = innermostOwner(
        parentBucket.filter((candidate) => candidate !== entry),
        entry.scope.range,
      );
      parentId = owner === undefined ? parentAdapterId : owner.uniqueId;
    }
    return { ...entry.scope, symbolScopeId: entry.uniqueId, parentScopeId: parentId };
  });

  const nextFacts: ComplexityFacts = {
    symbolScopes: mappedScopes,
    decisions: facts.decisions.map((fact) => ({
      ...fact,
      symbolScopeId: resolve(fact.symbolScopeId, fact.range),
    })),
    nestingEvents: facts.nestingEvents.map((fact) => ({
      ...fact,
      symbolScopeId: resolve(fact.symbolScopeId, fact.range),
    })),
    operators: facts.operators.map((fact) => ({
      ...fact,
      symbolScopeId: resolve(fact.symbolScopeId, fact.range),
    })),
    operands: facts.operands.map((fact) => ({
      ...fact,
      symbolScopeId: resolve(fact.symbolScopeId, fact.range),
    })),
    nodeKinds: mappedNodeKinds,
    comments: facts.comments,
    identifiers: facts.identifiers.map((fact) => ({
      ...fact,
      symbolScopeId: resolve(fact.symbolScopeId, fact.range),
    })),
    literals: facts.literals.map((fact) => ({
      ...fact,
      symbolScopeId: resolve(fact.symbolScopeId, fact.range),
    })),
    parseDiagnostics: facts.parseDiagnostics,
  };

  const nextCalls: RawCall[] = calls.map((call) => ({
    ...call,
    callerScopeId: resolve(call.callerScopeId, call.range),
  }));

  return {
    facts: nextFacts,
    calls: nextCalls,
    originalScopeIds,
    collisions,
    nodeKindsAttributedByFallback,
  };
}
