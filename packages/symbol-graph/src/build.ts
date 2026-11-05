/**
 * Aufbau des Symbolgraphen (architecture.md §17.1): Knoten aus
 * `ExtractedSymbol`s, Kanten aus `RawCall`s, Aufloesung ueber `resolve.ts`.
 *
 * ZUORDNUNG DER AUFRUFSTELLE ZUM AUFRUFENDEN SYMBOL (Entscheidung, normativ
 * fuer dieses Paket): `RawCall.callerScopeId` ist eine ADAPTER-INTERNE
 * Scope-Kennung — ihr Aufbau gehoert dem jeweiligen Sprachadapter und ist
 * bewusst kein oeffentlicher Vertrag. `ExtractedSymbol` traegt sie nicht.
 * Statt diese Kennung nachzubauen (und damit an einem fremden Format zu
 * kleben) ordnet dieses Paket die Aufrufstelle ueber BEREICHSENTHALTUNG zu:
 * das innerste Symbol, dessen Byte-Bereich die Aufrufstelle vollstaendig
 * enthaelt. Das funktioniert fuer jede Sprache gleich und braucht vom Adapter
 * nur, was `ExtractedSymbol` ohnehin liefert.
 *
 * Aufrufe AUSSERHALB jedes Symbols (Modulebene, Skriptzeilen) haben kein
 * Quellsymbol und koennen deshalb keine Symbol-zu-Symbol-Kante werden. Sie
 * verschwinden nicht, sondern landen mit Grund im Skip-Ledger (E4).
 */
import type {
  RawCall,
  RawImport,
  SkipLedgerEntryV1,
  SymbolEdgeCandidateV1,
  SymbolEdgeV1,
  SymbolNodeV1,
} from "@untangle-code/domain";
import {
  ID_COMPONENT_SEPARATOR,
  SYMBOL_GRAPH_VERSION,
  buildSkipLedgerEntry,
  buildSymbolEdgeId,
  compareCodepoints,
  summarizeSkipReasons,
  validateSymbolEdge,
} from "@untangle-code/domain";

import { computeSymbolGraphMetrics } from "./metrics.js";
import { buildFileSymbolNodes } from "./nodes.js";
import type { CallResolutionContext, FileImportBinding } from "./resolve.js";
import { buildSymbolNameIndex, resolveCall, withResolutionDefaults } from "./resolve.js";
import type {
  ResolvedImportTargetV1,
  SymbolGraphBuildInput,
  SymbolGraphFileInput,
  SymbolGraphV1,
} from "./types.js";

/** Kante des Symbolgraphen, wie dieses Paket sie erzeugt: immer `kind: "calls"`. */
const CALL_EDGE_KIND = "calls" as const;

interface CallerCandidate {
  node: SymbolNodeV1;
  startByte: number;
  endByte: number;
}

/**
 * Findet das innerste Symbol, dessen Bereich die Aufrufstelle vollstaendig
 * enthaelt. Gleichstand wird deterministisch nach `id`-Codepoints aufgeloest.
 */
export function findEnclosingSymbol(
  callers: readonly CallerCandidate[],
  startByte: number,
  endByte: number,
): SymbolNodeV1 | null {
  let best: CallerCandidate | null = null;
  for (const candidate of callers) {
    if (candidate.startByte > startByte || candidate.endByte < endByte) continue;
    if (best === null) {
      best = candidate;
      continue;
    }
    const bestSpan = best.endByte - best.startByte;
    const span = candidate.endByte - candidate.startByte;
    if (
      span < bestSpan ||
      (span === bestSpan && compareCodepoints(candidate.node.id, best.node.id) < 0)
    ) {
      best = candidate;
    }
  }
  return best?.node ?? null;
}

/**
 * Bildet die Namensbindungen einer Datei ab: lokaler Name → ALLE Bindungen
 * dieses Namens.
 *
 * WARUM EINE LISTE UND KEIN EINZELWERT: `from alpha import run` gefolgt von
 * `from beta import run` ist in Python voellig legal, und zur Laufzeit gilt das
 * SPAETERE Binding. Die frueher hier stehende Regel „der erste Eintrag gewinnt"
 * hat das zweite Binding spurlos verworfen und die Kante trotzdem als `exact`
 * auf `alpha.run` ausgeliefert — eine falsche Gewissheit ohne Ledger-Eintrag,
 * also genau die Fehlerklasse, die E4 verbietet. Jetzt bleiben beide Bindungen
 * stehen; die Aufloesung macht daraus eine mehrdeutige Kante mit beiden
 * Kandidaten und schreibt die Kollision in den Ledger.
 *
 * EINZIGE Verdraengung: ein `import type`-Eintrag weicht einem gleichnamigen
 * Wert-Import, weil nur letzterer zur Laufzeit aufrufbar ist.
 */
export function buildImportBindings(
  imports: readonly RawImport[],
): Map<string, FileImportBinding[]> {
  const bindings = new Map<string, FileImportBinding[]>();

  const add = (binding: FileImportBinding): void => {
    const bucket = bindings.get(binding.localName);
    if (bucket === undefined) {
      bindings.set(binding.localName, [binding]);
      return;
    }
    // Wortgleiche Wiederholung derselben Bindung ist keine Mehrdeutigkeit.
    const duplicate = bucket.some(
      (known) =>
        known.statement.specifier === binding.statement.specifier &&
        known.importedName === binding.importedName &&
        known.kind === binding.kind,
    );
    if (!duplicate) bucket.push(binding);
  };

  for (const entry of imports) {
    if (entry.bindings !== undefined && entry.bindings.length > 0) {
      for (const declared of entry.bindings) {
        // `RawImportBinding.importedName` ist OPTIONAL. Eine `named`- oder
        // `default`-Bindung ohne diesen Namen nennt die Bindungsform, aber
        // nicht den Namen im Zielmodul — das ist wortgleich der Zustand, den
        // `"unreported"` beschreibt. Ohne diese Gleichsetzung faellt der
        // Abgleich still auf den LOKALEN Namen zurueck und gilt trotzdem als
        // bewiesen (`exact`/1/`deterministic` auf ein ungeprueftes Ziel).
        const aliasKnown = declared.importedName !== undefined;
        const kind: FileImportBinding["kind"] =
          !aliasKnown && (declared.kind === "named" || declared.kind === "default")
            ? "unreported"
            : declared.kind;
        add({
          statement: entry,
          localName: declared.localName,
          ...(aliasKnown ? { importedName: declared.importedName } : {}),
          kind,
        });
      }
      continue;
    }
    // Adapter ohne Bindungsangabe: nur der LOKALE Name ist bekannt. `kind`
    // bleibt undefined — daran erkennt die Aufloesung, dass sie aus
    // Namensgleichheit keinen Beweis ableiten darf.
    for (const name of entry.importedNames ?? []) {
      add({
        statement: entry,
        localName: name,
        kind: name === "*" ? "wildcard" : "unreported",
      });
    }
  }

  for (const [name, bucket] of bindings) {
    const runtimeBindings = bucket.filter((binding) => binding.statement.typeOnly !== true);
    if (runtimeBindings.length > 0 && runtimeBindings.length < bucket.length) {
      bindings.set(name, runtimeBindings);
    }
  }
  return bindings;
}

function compareCalls(a: RawCall, b: RawCall): number {
  return (
    a.range.startByte - b.range.startByte ||
    a.range.endByte - b.range.endByte ||
    compareCodepoints(a.calleeName, b.calleeName) ||
    compareCodepoints(a.qualifier ?? "", b.qualifier ?? "")
  );
}

function toCandidateRecord(node: SymbolNodeV1, weight: number): SymbolEdgeCandidateV1 {
  return {
    symbolId: node.id,
    qualifiedName: node.qualifiedName,
    repoId: node.repoId,
    refId: node.refId,
    filePath: node.filePath,
    weight,
  };
}

/** Aussagekraft einer Modulauskunft: aufgeloest > extern > unaufgeloest. */
function importTargetRank(target: ResolvedImportTargetV1): number {
  if (target.toFileId !== null) return 2;
  if (target.external === true) return 1;
  return 0;
}

/**
 * Gruppiert die Modulauskuenfte des Dateigraphen nach Datei und Spezifizierer.
 *
 * Fuer die Namensbindung zaehlt je (Datei, Spezifizierer) genau EINE Auskunft.
 * Liefert der Aufrufer zwei widersprechende, gewann frueher stumm die
 * ZULETZT einsortierte — das Ergebnis hing damit an der Eingabereihenfolge und
 * die verworfene Auskunft verschwand spurlos. Jetzt gewinnt deterministisch
 * die aussagekraeftigere (bei Gleichstand die kleinere nach Codepoints), und
 * die verdraengte steht mit Grund im Ledger (E4).
 */
function groupImportTargets(
  targets: readonly ResolvedImportTargetV1[],
  skipped: SkipLedgerEntryV1[],
): Map<string, Map<string, ResolvedImportTargetV1>> {
  const grouped = new Map<string, Map<string, ResolvedImportTargetV1>>();
  for (const target of targets) {
    let bucket = grouped.get(target.fromFileId);
    if (bucket === undefined) {
      bucket = new Map<string, ResolvedImportTargetV1>();
      grouped.set(target.fromFileId, bucket);
    }
    const known = bucket.get(target.specifier);
    if (known === undefined) {
      bucket.set(target.specifier, target);
      continue;
    }
    const keyOf = (entry: ResolvedImportTargetV1): string =>
      entry.toFileId ?? entry.unresolvedDetail ?? "";
    const winner =
      importTargetRank(target) > importTargetRank(known) ||
      (importTargetRank(target) === importTargetRank(known) &&
        compareCodepoints(keyOf(target), keyOf(known)) < 0)
        ? target
        : known;
    const loser = winner === target ? known : target;
    bucket.set(target.specifier, winner);
    skipped.push(
      buildSkipLedgerEntry({
        stage: "symbol_graph",
        subjectKind: "file",
        subjectId: target.fromFileId,
        reason: "ambiguous_resolution",
        detail: `two module resolutions were supplied for specifier "${target.specifier}" in file "${target.fromFileId}"; the more specific one ("${keyOf(winner)}") binds the names, the other ("${keyOf(loser)}") does not`,
        recoverable: true,
      }),
    );
  }
  return grouped;
}

/**
 * Baut den Symbolgraphen aus geparsten Dateien.
 *
 * Sprachagnostik: Dateien ohne Symbole (Markdown, Text, Konfiguration)
 * liefern keine Knoten und keine Kanten — und keinen Fehler. Der leere
 * Symbolgraph ist fuer sie das richtige Ergebnis (vision.md §1c).
 */
export function buildSymbolGraph(input: SymbolGraphBuildInput): SymbolGraphV1 {
  const options = withResolutionDefaults(input.options);
  const skipped: SkipLedgerEntryV1[] = [];

  const files = [...input.files].sort((a, b) => compareCodepoints(a.fileId, b.fileId));
  const seenFileIds = new Set<string>();
  const acceptedFiles: SymbolGraphFileInput[] = [];
  const nodesByFile = new Map<string, SymbolNodeV1[]>();
  const callerCandidatesByFile = new Map<string, CallerCandidate[]>();
  const allNodes: SymbolNodeV1[] = [];

  for (const file of files) {
    if (seenFileIds.has(file.fileId)) {
      skipped.push(
        buildSkipLedgerEntry({
          stage: "symbol_graph",
          subjectKind: "file",
          subjectId: file.fileId,
          path: file.path,
          repoId: file.repoId,
          refId: file.refId,
          reason: "duplicate",
          detail: `file id "${file.fileId}" was supplied more than once; only the first occurrence contributes symbols and calls`,
          recoverable: false,
        }),
      );
      continue;
    }
    seenFileIds.add(file.fileId);
    acceptedFiles.push(file);

    const built = buildFileSymbolNodes(input.workspaceId, file);
    skipped.push(...built.skipped);
    nodesByFile.set(file.fileId, built.nodes);
    allNodes.push(...built.nodes);

    const callers: CallerCandidate[] = [];
    for (const [index, symbol] of file.symbols.entries()) {
      const node = built.nodeBySymbolIndex[index];
      if (node === null || node === undefined) continue;
      callers.push({ node, startByte: symbol.range.startByte, endByte: symbol.range.endByte });
    }
    callerCandidatesByFile.set(file.fileId, callers);
  }

  const nameIndex = buildSymbolNameIndex(allNodes);
  const importTargetsByFile = groupImportTargets(input.resolvedImports ?? [], skipped);

  const edges: SymbolEdgeV1[] = [];
  const ordinals = new Map<string, number>();

  for (const file of acceptedFiles) {
    const callers = callerCandidatesByFile.get(file.fileId) ?? [];
    const context: CallResolutionContext = {
      fromFileId: file.fileId,
      fromFilePath: file.path,
      importBindings: buildImportBindings(file.imports),
      importTargets: importTargetsByFile.get(file.fileId) ?? new Map(),
    };
    const calls = [...file.calls].sort(compareCalls);

    for (const call of calls) {
      if (call.calleeName.trim() === "") {
        skipped.push(
          buildSkipLedgerEntry({
            stage: "symbol_graph",
            subjectKind: "symbol_edge",
            path: file.path,
            range: call.range,
            repoId: file.repoId,
            refId: file.refId,
            reason: "resolution_failed",
            detail: `call site at bytes ${String(call.range.startByte)}..${String(call.range.endByte)} has an empty callee name; an edge without a written name would carry no resolver-independent fact`,
            recoverable: false,
          }),
        );
        continue;
      }
      const caller = findEnclosingSymbol(callers, call.range.startByte, call.range.endByte);
      if (caller === null) {
        skipped.push(
          buildSkipLedgerEntry({
            stage: "symbol_graph",
            subjectKind: "symbol_edge",
            path: file.path,
            range: call.range,
            repoId: file.repoId,
            refId: file.refId,
            reason: "missing_index_entry",
            detail: `call to "${call.calleeName}" at line ${String(call.range.startLine)} lies outside every extracted symbol range (module-level or script-level code); a symbol-to-symbol edge needs a source symbol`,
            recoverable: false,
          }),
        );
        continue;
      }

      const outcome = resolveCall(call.calleeName, call.qualifier, nameIndex, context, options);
      const ordinalKey = [caller.id, CALL_EDGE_KIND, call.calleeName, call.qualifier ?? ""].join(
        ID_COMPONENT_SEPARATOR,
      );
      const occurrenceOrdinal = ordinals.get(ordinalKey) ?? 0;
      ordinals.set(ordinalKey, occurrenceOrdinal + 1);

      const edge: SymbolEdgeV1 = {
        schemaVersion: 1,
        edgeId: buildSymbolEdgeId({
          workspaceId: input.workspaceId,
          fromSymbolId: caller.id,
          edgeKind: CALL_EDGE_KIND,
          toName: call.calleeName,
          ...(call.qualifier !== undefined ? { toQualifier: call.qualifier } : {}),
          occurrenceOrdinal,
        }),
        workspaceId: input.workspaceId,
        repoId: file.repoId,
        refId: file.refId,
        fromSymbolId: caller.id,
        kind: CALL_EDGE_KIND,
        toName: call.calleeName,
        ...(call.qualifier !== undefined ? { toQualifier: call.qualifier } : {}),
        resolution: outcome.resolution,
        ...(outcome.target !== undefined
          ? {
              target: {
                symbolId: outcome.target.id,
                qualifiedName: outcome.target.qualifiedName,
                repoId: outcome.target.repoId,
                refId: outcome.target.refId,
                filePath: outcome.target.filePath,
              },
            }
          : {}),
        ...(outcome.candidates !== undefined
          ? {
              candidates: outcome.candidates.map((candidate) =>
                toCandidateRecord(candidate.node, candidate.weight),
              ),
            }
          : {}),
        ...(outcome.unresolvedReason !== undefined
          ? { unresolvedReason: outcome.unresolvedReason }
          : {}),
        ...(outcome.unresolvedDetail !== undefined
          ? { unresolvedDetail: outcome.unresolvedDetail }
          : {}),
        confidence: outcome.confidence,
        // Eine mehrdeutige Kante hat kein `target`. Frueher stand hier
        // deshalb immer `false` — und `crossRepoEdgeCount` meldete null
        // Repo-Grenzen, obwohl saemtliche Kandidaten in fremden
        // Repositories lagen. Fuer `ambiguous` zaehlt jeder Kandidat.
        crossRepo:
          outcome.target !== undefined
            ? outcome.target.repoId !== file.repoId
            : (outcome.candidates ?? []).some((candidate) => candidate.node.repoId !== file.repoId),
        sites: [{ repoId: file.repoId, refId: file.refId, filePath: file.path, range: call.range }],
        occurrenceOrdinal,
        graphGeneration: input.graphGeneration,
        graphVersion: SYMBOL_GRAPH_VERSION,
      };

      for (const note of outcome.notes) {
        skipped.push(
          buildSkipLedgerEntry({
            stage: "symbol_graph",
            subjectKind: "symbol_edge",
            subjectId: edge.edgeId,
            path: file.path,
            range: call.range,
            repoId: file.repoId,
            refId: file.refId,
            reason: "ambiguous_resolution",
            detail: note,
            recoverable: true,
          }),
        );
      }

      for (const dropped of outcome.droppedCandidates) {
        skipped.push(
          buildSkipLedgerEntry({
            stage: "symbol_graph",
            subjectKind: "symbol_edge",
            subjectId: edge.edgeId,
            path: file.path,
            range: call.range,
            repoId: file.repoId,
            refId: file.refId,
            reason: "ambiguous_resolution",
            detail: `candidate "${dropped.qualifiedName}" (${dropped.filePath}) exceeded the candidate limit of ${String(options.maxCandidates)} for "${call.calleeName}" and is not carried on the edge`,
            recoverable: true,
          }),
        );
      }

      const issues = validateSymbolEdge(edge);
      if (issues.length > 0) {
        // Eine Kante, die den Domainvertrag verletzt, ist ein Defekt dieses
        // Pakets. Sie wird NICHT ausgeliefert — und sie verschwindet auch
        // nicht: der Vertragsbruch steht mit Begruendung im Ledger (E4).
        skipped.push(
          buildSkipLedgerEntry({
            stage: "symbol_graph",
            subjectKind: "symbol_edge",
            subjectId: edge.edgeId,
            path: file.path,
            range: call.range,
            repoId: file.repoId,
            refId: file.refId,
            reason: "resolution_failed",
            detail: `edge for "${call.calleeName}" violates validateSymbolEdge: ${issues
              .map((issue) => `${issue.kind}: ${issue.message}`)
              .join("; ")}`,
            recoverable: false,
          }),
        );
        continue;
      }
      edges.push(edge);
    }
  }

  allNodes.sort((a, b) => compareCodepoints(a.id, b.id));
  edges.sort((a, b) => compareCodepoints(a.edgeId, b.edgeId));

  return {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    graphGeneration: input.graphGeneration,
    graphVersion: SYMBOL_GRAPH_VERSION,
    nodes: allNodes,
    edges,
    skipped: {
      schemaVersion: 1,
      generationId: input.graphGeneration,
      entries: skipped,
      countsByReason: summarizeSkipReasons(skipped),
    },
    metrics: computeSymbolGraphMetrics({
      nodes: allNodes,
      edges,
      fileCount: acceptedFiles.length,
      symbolLessFileCount: acceptedFiles.filter(
        (file) => (nodesByFile.get(file.fileId) ?? []).length === 0,
      ).length,
      skippedCount: skipped.length,
    }),
  };
}
