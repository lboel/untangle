/**
 * The single unified AST walk. Every `LanguageAdapter` extraction method
 * (`extractSymbols`, `extractImports`, `extractCalls`, `computeComplexity`,
 * `tokenizeForHalstead`, `extractChunks`) is a thin projection over the ONE
 * `AnalysisResult` this module computes — see `create-adapter.ts`, which
 * memoizes it per `ParsedAst` (via `WeakMap`) so calling multiple extract
 * methods on the same parse re-walks the tree only once.
 *
 * Building everything in one pass is not just a performance optimization:
 * it is what GUARANTEES that a `symbolScopeId` produced for a
 * `SymbolScopeFact` (from `computeComplexity`) is the exact same string as
 * the `callerScopeId` on a `RawCall` (from `extractCalls`) for a call
 * written inside that scope — both come from the same live scope-stack
 * frame during the same walk, not from two independently-reimplemented
 * scope-id algorithms that could drift apart.
 *
 * TRAVERSIERUNG (WP-95): der Walk laeuft ueber die CURSOR-API
 * (`tree.walk()` / `gotoFirstChild` / `gotoNextSibling` / `gotoParent`),
 * NICHT ueber `node.children`. Gemessen an diesem Repository (716 Dateien,
 * 128.219 Zeilen) kostete der `.children`-Weg 25,6 s fuer den Walk gegen
 * 3,6 s fuers Parsen: jeder `.children`-Zugriff baut ein JS-Array aus
 * Knotenwrappern und ueberquert die Grenze zur nativen Bibliothek einmal je
 * Knoten. Der Cursor haelt die Position nativ.
 *
 * WAS DER CURSOR NICHT HAT, und wie es hier ersetzt wird:
 *   - `node.parent`  -> `parentTypeAt[depth]`, waehrend des Abstiegs gefuehrt.
 *   - `node.childCount === 0` -> ein probeweises `gotoFirstChild()`; schlaegt
 *     es fehl, ist der Knoten ein Blatt (sonst bringt `gotoParent()` zurueck).
 *   - `parent.childForFieldName(...)` fuer die Rolle eines Bezeichners ->
 *     `cursor.currentFieldName`, das denselben Feldnamen ohne Wrapper liefert.
 *
 * Ein `SyntaxNode`-Wrapper entsteht nur noch dort, wo ein Detektor ihn
 * wirklich braucht (siehe `visitInnerNode`) — wer diese Vorsiebe aufweicht,
 * baut die Grenzueberquerung je Knoten wieder ein.
 */
import type {
  ComplexityFacts,
  IdentifierFact,
  LiteralFact,
  NodeKindFact,
  RawCall,
  RawImport,
  SourceRange,
  SymbolScopeFact,
  TokenFact,
} from "@untangle-code/domain";

import { lambdaNesting } from "./decisions.js";
import { computeAstHash, computeTokenFingerprint } from "./fingerprint.js";
import type { FileTextContext } from "./node-utils.js";
import { commentRangeOfCursor, rangeOf, rangeOfCursor } from "./node-utils.js";
import type { LanguageProfile, ModuleFactSink } from "./profile.js";
import { isExecutableScopeKind } from "./profile.js";
import type { ScopeNode } from "./scope-model.js";
import type { SyntaxCursor, SyntaxNode } from "./syntax.js";

export interface AnalysisResult {
  scopeTree: ScopeNode;
  facts: ComplexityFacts;
  imports: RawImport[];
  calls: RawCall[];
}

interface MutableFacts {
  symbolScopes: SymbolScopeFact[];
  decisions: ComplexityFacts["decisions"];
  nestingEvents: ComplexityFacts["nestingEvents"];
  operators: TokenFact[];
  operands: TokenFact[];
  nodeKinds: NodeKindFact[];
  comments: SourceRange[];
  identifiers: IdentifierFact[];
  literals: LiteralFact[];
  imports: RawImport[];
  calls: RawCall[];
}

/** Separates scope-id components (U+001F, unit separator) — avoids the classic "ab"+"c" == "a"+"bc" join ambiguity. */
const SCOPE_ID_SEPARATOR = "";

interface WorkingFrame {
  scopeId: string;
  qualifiedName: string;
  executable: boolean;
  scopeNode: ScopeNode;
  childOrdinalCounters: Map<string, number>;
}

function toSymbolScopeFact(
  frame: WorkingFrame,
  parentScopeId: string | undefined,
): SymbolScopeFact {
  const { scopeNode } = frame;
  return {
    symbolScopeId: scopeNode.scopeId,
    name: scopeNode.name,
    qualifiedName: scopeNode.qualifiedName,
    kind: scopeNode.kind,
    range: scopeNode.range,
    ...(parentScopeId !== undefined ? { parentScopeId } : {}),
    executable: scopeNode.executable,
  };
}

function openScope(
  cursor: SyntaxCursor,
  node: SyntaxNode,
  parent: WorkingFrame,
  profile: LanguageProfile,
  ctx: FileTextContext,
  fileId: string,
  out: MutableFacts,
): WorkingFrame | null {
  if (profile.suppressesScope(node)) return null;

  const kind = profile.scopeKindOf(node);
  if (kind === null) return null;

  const name = profile.scopeName(node);
  // WP-237: Sprachen, die den Traeger als FELD statt als Elternknoten fuehren
  // (Gos Methodenempfaenger), liefern ihn hier nach. Der SYMBOLNAME bleibt
  // unveraendert `Run` — nur der qualifizierte Name wird `A.Run`, damit zwei
  // gleichnamige Methoden auf verschiedenen Typen unterscheidbar bleiben.
  const qualifier = profile.scopeQualifier?.(node);
  const localName = qualifier === undefined ? name : `${qualifier}.${name}`;
  const qualifiedName =
    parent.qualifiedName.length > 0 ? `${parent.qualifiedName}.${localName}` : localName;
  const counterKey = `${kind}:${qualifiedName}`;
  const ordinal = parent.childOrdinalCounters.get(counterKey) ?? 0;
  parent.childOrdinalCounters.set(counterKey, ordinal + 1);
  const scopeId = [fileId, "scope", qualifiedName, kind, String(ordinal)].join(SCOPE_ID_SEPARATOR);

  const signature = profile.scopeSignature(node, kind, name);
  const docRange = profile.docRange(node, ctx);
  const executable = isExecutableScopeKind(kind);
  const visibility = profile.visibility(node, name);
  const parentQualifiedName = parent.qualifiedName.length > 0 ? parent.qualifiedName : undefined;

  const scopeNode: ScopeNode = {
    scopeId,
    kind,
    name,
    qualifiedName,
    ...(parentQualifiedName !== undefined ? { parentQualifiedName } : {}),
    range: rangeOf(node, ctx),
    ...(docRange !== undefined ? { docRange } : {}),
    ...(signature.raw !== undefined ? { signature: signature.raw } : {}),
    normalizedSignature: signature.normalized,
    exportedNames: profile.exportedNames(node, name),
    ...(visibility !== undefined ? { visibility } : {}),
    executable,
    astHash: computeAstHash(cursor, profile),
    tokenFingerprint: computeTokenFingerprint(cursor, profile),
    node,
    children: [],
  };

  const frame: WorkingFrame = {
    scopeId,
    qualifiedName,
    executable,
    scopeNode,
    childOrdinalCounters: new Map(),
  };
  out.symbolScopes.push(toSymbolScopeFact(frame, parent.scopeId));
  parent.scopeNode.children.push(scopeNode);
  return frame;
}

/**
 * Ein Blattknoten (kein Kind) wird eingeordnet. Der Cursor steht auf ihm; ein
 * `SyntaxNode`-Wrapper wird NICHT gebaut — `nodeText`, `nodeType` und
 * `currentFieldName` liefern alles Noetige, `parentType` kommt aus dem Abstieg.
 *
 * Die frueher hier stehende `predefined_type`-Pruefung ist ENTFALLEN, nicht
 * vergessen: der einzige Aufrufer (`walkWithCursor`) siebt diesen Fall bereits
 * vor dem Blatt-Zweig aus (ueber `profile.typeKeywordParentKinds`), die
 * Pruefung war an dieser Stelle unerreichbar.
 */
function classifyAndRecordLeaf(
  cursor: SyntaxCursor,
  nodeType: string,
  parentType: string,
  range: SourceRange,
  frame: WorkingFrame,
  profile: LanguageProfile,
  out: MutableFacts,
): void {
  const scopeId = frame.scopeId;

  if (profile.identifierLeafKinds.has(nodeType)) {
    const text = cursor.nodeText;
    out.identifiers.push({
      name: text,
      range,
      symbolScopeId: scopeId,
      role: profile.identifierRole(cursor.currentFieldName, parentType),
    });
    out.operands.push({ text, range, symbolScopeId: scopeId });
    return;
  }

  if (profile.simpleLiteralLeafKinds.has(nodeType)) {
    const text = cursor.nodeText;
    out.literals.push({
      raw: text,
      literalKind: profile.simpleLiteralKind(nodeType),
      range,
      symbolScopeId: scopeId,
    });
    out.operands.push({ text, range, symbolScopeId: scopeId });
    return;
  }

  if (profile.templateTextLeafKinds.has(nodeType)) {
    const text = cursor.nodeText;
    out.literals.push({ raw: text, literalKind: "template", range, symbolScopeId: scopeId });
    out.operands.push({ text, range, symbolScopeId: scopeId });
    return;
  }

  if (profile.ignoredPunctuationKinds.has(nodeType)) return;

  out.operators.push({ text: cursor.nodeText, range, symbolScopeId: scopeId });
}

/**
 * Alles, was ein innerer Knoten (mindestens ein Kind) beitraegt: Entscheidung,
 * Nesting, Import, Aufruf, eigener Scope. Gibt den neu geoeffneten Scope-Rahmen
 * zurueck, sonst `null`.
 *
 * HIER und nur hier entsteht ein `SyntaxNode`-Wrapper, und nur wenn das Profil
 * fuer diese Knotenart ueberhaupt einen Detektor auf den Plan ruft
 * (`profile.needsNode`). Fuer die grosse Mehrheit der inneren Knoten faellt die
 * Grenzueberquerung damit ganz weg — beim tree-sitter-Backend spart das den
 * Wrapper, beim ast-grep-Backend den weit teureren `children()`-Aufbau.
 */
function visitInnerNode(
  cursor: SyntaxCursor,
  nodeType: string,
  range: SourceRange,
  frame: WorkingFrame,
  profile: LanguageProfile,
  ctx: FileTextContext,
  fileId: string,
  out: MutableFacts,
): WorkingFrame | null {
  // Kein Detektor zustaendig: kein Wrapper, kein Scope. Das Lambda-Nesting
  // unten kann hier nicht verloren gehen — ein funktionsartiger Knoten oeffnet
  // immer auch einen Scope, also ist `needsNode` dort wahr (in
  // `js-family-profile.ts` wie in `table-profile.ts` durch Konstruktion).
  if (!profile.needsNode(nodeType)) return null;

  const node = cursor.currentNode;

  // Decision / nesting facts.
  const detected = profile.detectDecisionAndNesting(node);
  if (detected.decision !== undefined) {
    const fact = {
      kind: detected.decision.kind,
      range,
      symbolScopeId: frame.scopeId,
      countsForClassic: detected.decision.countsForClassic,
      countsForExtended: detected.decision.countsForExtended,
      ...(detected.decision.logicalGroupId !== undefined
        ? { logicalGroupId: detected.decision.logicalGroupId }
        : {}),
    };
    // `repeat` (Vorgabe 1) ist die flache n-stellige Alternative — siehe
    // `DetectedDecision.repeat`. Jede Wiederholung ist eine EIGENE Tatsache
    // mit demselben Bereich, kein Zaehler auf einer.
    for (let index = 0; index < (detected.decision.repeat ?? 1); index += 1) {
      out.decisions.push({ ...fact });
    }
  }
  if (detected.nesting !== undefined) {
    out.nestingEvents.push({
      construct: detected.nesting.construct,
      range,
      symbolScopeId: frame.scopeId,
      continuation: detected.nesting.continuation,
    });
  }

  // Importe und Aufrufe (Aufrufe dem AKTUELLEN Scope zugerechnet, also dem Rufer).
  const sink: ModuleFactSink = { imports: out.imports, calls: out.calls };
  profile.collectModuleFacts(node, nodeType, frame.scopeId, ctx, sink);

  const openedScope = openScope(cursor, node, frame, profile, ctx, fileId, out);

  // A directly-nested function-like node (lambda/local function) inside an
  // already-executable scope gets an extra lambda nesting event (spec.md
  // §16.4: "lokale Funktionen/Lambdas verwenden einen dokumentierten
  // Nesting-Kontext") in addition to becoming its own scope below. A node kind
  // can be function-like only in a particular syntactic context, so a rejected
  // scope must not leave behind a phantom lambda event.
  if (openedScope !== null && frame.executable && profile.functionLikeKinds.has(nodeType)) {
    const lambda = lambdaNesting();
    out.nestingEvents.push({
      construct: lambda.construct,
      range,
      symbolScopeId: frame.scopeId,
      continuation: lambda.continuation,
    });
  }

  return openedScope;
}

/**
 * Der vereinheitlichte Walk, iterativ ueber einen Baumcursor.
 *
 * Der Cursor beginnt auf der Wurzel und endet wieder dort. Besuchsreihenfolge,
 * `depth`-Zaehlung und die Reihenfolge JEDER Faktenliste sind identisch mit
 * der frueheren Rekursion ueber `node.children` — die Gegenprobe
 * (`diff-walk.mjs`, siehe README) faehrt beide Wege ueber dieses Repository
 * und vergleicht Symbole, Regionen, Chunk-IDs und Metriken Datei fuer Datei.
 *
 * `frameAt`/`parentTypeAt` sind nach Tiefe indiziert und ersetzen zusammen den
 * Aufrufstapel der Rekursion samt `node.parent`. Eintraege unterhalb der
 * aktuellen Tiefe sind veraltet, werden aber vor jedem Lesen ueberschrieben.
 */
function walkWithCursor(
  cursor: SyntaxCursor,
  rootType: string,
  rootFrame: WorkingFrame,
  profile: LanguageProfile,
  ctx: FileTextContext,
  fileId: string,
  out: MutableFacts,
): void {
  if (!cursor.gotoFirstChild()) return;

  const frameAt: WorkingFrame[] = [rootFrame, rootFrame];
  const parentTypeAt: string[] = [rootType, rootType];
  let depth = 1;

  for (;;) {
    const frame = frameAt[depth] as WorkingFrame;
    const parentType = parentTypeAt[depth] as string;
    const nodeType = cursor.nodeType;
    const range = rangeOfCursor(cursor, ctx);
    out.nodeKinds.push({ kind: nodeType, depth, symbolScopeId: frame.scopeId });

    let descended = false;

    if (profile.commentKinds.has(nodeType)) {
      out.comments.push(commentRangeOfCursor(cursor, ctx));
    } else if (profile.typeKeywordParentKinds.has(parentType)) {
      // Ein Typschluessselwort-Blatt (z. B. das `string`/`number`/`void`-Kind
      // von `predefined_type`): dieselben Namen wie Literale, aber Typsyntax,
      // kein Wert. Weiter in `nodeKinds` gezaehlt (oben), nie als
      // Operator/Operand/Literal/Bezeichner. Muss VOR dem Literalcontainer
      // unten stehen: das Kind fuer das Typschluesselwort `string` hat den
      // Knotentyp "string" — genau denselben wie ein echtes Zeichenkettenliteral.
    } else if (profile.literalContainerKinds.has(nodeType)) {
      const text = cursor.nodeText;
      out.operands.push({ text, range, symbolScopeId: frame.scopeId });
      out.literals.push({
        raw: text,
        literalKind: profile.containerLiteralKind(nodeType),
        range,
        symbolScopeId: frame.scopeId,
      });
    } else if (!cursor.gotoFirstChild()) {
      // Der Cursor kennt kein `childCount`: der fehlgeschlagene Abstieg IST
      // die Blattpruefung, und er hat die Position nicht veraendert.
      classifyAndRecordLeaf(cursor, nodeType, parentType, range, frame, profile, out);
    } else {
      cursor.gotoParent(); // zurueck auf den inneren Knoten selbst
      const childFrame = visitInnerNode(cursor, nodeType, range, frame, profile, ctx, fileId, out);
      cursor.gotoFirstChild();
      depth += 1;
      frameAt[depth] = childFrame ?? frame;
      parentTypeAt[depth] = nodeType;
      descended = true;
    }

    if (descended) continue;

    // Aufsteigen, bis ein Geschwisterknoten da ist. Tiefe 1 ohne Geschwister
    // heisst: die Kinder der Wurzel sind abgearbeitet.
    while (!cursor.gotoNextSibling()) {
      if (depth === 1) return;
      cursor.gotoParent();
      depth -= 1;
    }
  }
}

/** Runs the single unified walk over a file's root node. */
export function analyzeTree(
  root: SyntaxNode,
  ctx: FileTextContext,
  fileId: string,
  profile: LanguageProfile,
): AnalysisResult {
  const out: MutableFacts = {
    symbolScopes: [],
    decisions: [],
    nestingEvents: [],
    operators: [],
    operands: [],
    nodeKinds: [],
    comments: [],
    identifiers: [],
    literals: [],
    imports: [],
    calls: [],
  };

  // EIN Cursor fuer alles: er beginnt auf der Wurzel, und nur ein von der
  // Wurzel her abgestiegener Cursor meldet Knotentypen verlaesslich (siehe
  // `fingerprint.ts`, Punkt 2). Jede Hilfsfunktion, die ihn bewegt, gibt ihn
  // an der Ausgangsposition zurueck.
  const cursor = root.walk();

  const fileScopeNode: ScopeNode = {
    scopeId: fileId,
    kind: "file",
    name: "",
    qualifiedName: "",
    range: rangeOf(root, ctx),
    normalizedSignature: "",
    exportedNames: [],
    executable: true,
    astHash: computeAstHash(cursor, profile),
    tokenFingerprint: computeTokenFingerprint(cursor, profile),
    node: root,
    children: [],
  };
  const rootFrame: WorkingFrame = {
    scopeId: fileId,
    qualifiedName: "",
    executable: true,
    scopeNode: fileScopeNode,
    childOrdinalCounters: new Map(),
  };
  out.symbolScopes.push(toSymbolScopeFact(rootFrame, undefined));

  walkWithCursor(cursor, root.type, rootFrame, profile, ctx, fileId, out);

  const facts: ComplexityFacts = {
    symbolScopes: out.symbolScopes,
    decisions: out.decisions,
    nestingEvents: out.nestingEvents,
    operators: out.operators,
    operands: out.operands,
    nodeKinds: out.nodeKinds,
    comments: out.comments,
    identifiers: out.identifiers,
    literals: out.literals,
    // Leer AN DIESER STELLE mit Absicht: die Parse-Diagnosen entstehen in
    // `parse()` und werden in `create-adapter.ts#getAnalysis` eingesetzt,
    // bevor die Facts den Adapter verlassen. Wer diese Zeile als "sowieso
    // immer leer" liest, hat den falschen Ausschnitt vor sich.
    parseDiagnostics: [],
  };

  return { scopeTree: fileScopeNode, facts, imports: out.imports, calls: out.calls };
}
