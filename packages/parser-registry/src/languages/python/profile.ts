/**
 * Die Python-Regeln, die KEINE Tabelle ausdrueckt.
 *
 * Alles Uebrige — Entscheidungen, Nesting, Kommentare, Halstead-Token,
 * Aufrufe, Scopes — kommt aus `table.ts` durch den gemeinsamen Motor
 * (`shared/table-profile.ts`, `shared/engine.ts`). Hier steht nur, was
 * Python anders macht als jede andere Sprache dieses Projekts:
 *
 *  1. DOCSTRINGS. Python bindet die Beschreibung nicht an einen Kommentar VOR
 *     der Definition, sondern an die erste Anweisung IM Rumpf.
 *  2. SICHTBARKEIT. Es gibt keinen Modifikator; sie steht in der
 *     Namenskonvention (`_x` geschuetzt, `__x` privat, `__x__` oeffentlich).
 *  3. `__all__`. Was eine Datei exportiert, steht in einer Zuweisung auf
 *     Modulebene — also je DATEI, nicht je Knoten. Deshalb wird dieses Profil
 *     je Parse gebaut (`AstGrepAdapterHooks.profileForFile`) und nicht einmal
 *     je Adapter.
 *  4. METHODE ODER FUNKTION. `def` ist beides; welches, sagt erst der
 *     umgebende Knoten. Eine Tabelle bildet Knotenart auf Scope-Art ab und
 *     kann das nicht.
 *  5. IMPORTE. Eine Anweisung fuehrt mehrere Ziele mit je eigenem Alias
 *     (`from a import b as c, d`) — `ImportRules` kennt genau eines.
 *  6. SIGNATUREN. Die Normalform folgt `signature.ts` (Vorgabewerte fallen
 *     weg, Annotationen bleiben) und nicht der Rohtextregel der Tabelle.
 *  7. ZEICHENKETTEN. Ein `string` ist hier KEIN geschlossener Container
 *     (siehe `table.ts`); seine Textblaetter muessen deshalb ausdruecklich
 *     als Zeichenkettenliterale gelten.
 */
import type { LiteralFact, RawImport, SourceFile, SourceRange } from "@untangle-code/domain";

import type { DecisionDetectionResult } from "../shared/decisions.js";
import type { FileTextContext } from "../shared/node-utils.js";
import { rangeOf } from "../shared/node-utils.js";
import type { LanguageProfile, ModuleFactSink, ScopeSignature } from "../shared/profile.js";
import type { ScopeNode } from "../shared/scope-model.js";
import type { SyntaxNode } from "../shared/syntax.js";

import { normalizeHeaderText, normalizeParameterList, normalizeReturnType } from "./signature.js";
import { PYTHON_STRING_LEAF_KINDS } from "./table.js";

const INIT_FILE_RE = /(^|\/)__init__\.pyi?$/;
const STRING_LEAF_KINDS: ReadonlySet<string> = new Set(PYTHON_STRING_LEAF_KINDS);

/** Knotenarten, die einen eigenen Namensraum aufmachen — die Grenze fuer "steht in einer Klasse". */
const SCOPE_OPENING_KINDS: ReadonlySet<string> = new Set([
  "function_definition",
  "class_definition",
  "lambda",
]);

// ---------------------------------------------------------------------------
// 2. Sichtbarkeit aus der Namenskonvention (PEP 8)
// ---------------------------------------------------------------------------

/**
 * `__x__` ist das oeffentliche Protokoll (`__init__`, `__len__`) und bekommt
 * deshalb GAR KEINE Angabe — nicht "public": das Feld ist optional, und
 * "keine Angabe" ist die ehrliche Aussage ueber eine Sprache ohne
 * Sichtbarkeitsmodifikatoren.
 */
function pythonVisibility(name: string): string | undefined {
  if (name.startsWith("__") && name.endsWith("__") && name.length > 4) return undefined;
  if (name.startsWith("__")) return "private";
  if (name.startsWith("_")) return "protected";
  return undefined;
}

// ---------------------------------------------------------------------------
// 1. Docstrings
// ---------------------------------------------------------------------------

/** Der Text eines Zeichenkettenknotens ohne Anfuehrungszeichen (auch dreifache). */
function stringLiteralText(node: SyntaxNode): string | null {
  if (node.type !== "string") return null;
  for (const child of node.children) {
    if (child.type === "string_content") return child.text;
  }
  return "";
}

/**
 * Der Docstring eines Scopes: die erste Anweisung des Rumpfes, wenn sie aus
 * nichts als einem Zeichenkettenliteral besteht. Alles andere ist Code, und
 * ein Stueck Code als Beschreibung auszugeben waere eine Erfindung.
 */
function docstringRange(
  node: SyntaxNode,
  ctx: FileTextContext,
  bodyField: string,
): SourceRange | undefined {
  const body = node.childForFieldName(bodyField);
  if (body === null) return undefined;
  const first = body.namedChild(0);
  if (first === null || first.type !== "expression_statement") return undefined;
  const expression = first.namedChild(0);
  if (expression === null || stringLiteralText(expression) === null) return undefined;
  return rangeOf(expression, ctx);
}

// ---------------------------------------------------------------------------
// 3. `__all__`
// ---------------------------------------------------------------------------

/**
 * Die Namen aus `__all__ = [...]` auf Modulebene, oder `null`, wenn die Datei
 * keines hat. `null` und nicht "leere Menge": ohne `__all__` gilt die
 * Unterstrich-Konvention, mit leerem `__all__` exportiert die Datei nichts.
 * Die beiden Faelle zu vermengen hiesse, jede Datei ohne `__all__` fuer
 * exportlos zu erklaeren.
 */
function findDunderAll(root: SyntaxNode): ReadonlySet<string> | null {
  for (const statement of root.children) {
    if (statement.type !== "expression_statement") continue;
    const assignment = statement.namedChild(0);
    if (assignment === null || assignment.type !== "assignment") continue;
    const left = assignment.childForFieldName("left");
    if (left === null || left.type !== "identifier" || left.text !== "__all__") continue;
    const right = assignment.childForFieldName("right");
    if (
      right === null ||
      (right.type !== "list" && right.type !== "tuple" && right.type !== "set")
    ) {
      continue;
    }
    const names = new Set<string>();
    for (const element of right.children) {
      const text = stringLiteralText(element);
      if (text !== null) names.add(text);
    }
    return names;
  }
  return null;
}

/** Steht dieser Knoten unmittelbar auf Modulebene (auch unter einem Dekorator)? */
function isTopLevel(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (parent === null) return false;
  if (parent.type === "module") return true;
  return parent.type === "decorated_definition" && parent.parent?.type === "module";
}

// ---------------------------------------------------------------------------
// 4. Methode oder Funktion
// ---------------------------------------------------------------------------

/** Der naechste umschliessende Knoten, der selbst einen Namensraum oeffnet. */
function enclosingScopeKind(node: SyntaxNode): string | null {
  let current = node.parent;
  while (current !== null) {
    if (SCOPE_OPENING_KINDS.has(current.type)) return current.type;
    current = current.parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. Importe
// ---------------------------------------------------------------------------

/** Ziel und Alias eines einzelnen Importeintrags (`os.path as osp`, `helper`). */
function importEntryOf(node: SyntaxNode): { path: string; alias?: string } | null {
  if (node.type === "dotted_name") return { path: node.text };
  if (node.type !== "aliased_import") return null;
  const path = node.childForFieldName("name");
  const alias = node.childForFieldName("alias");
  if (path === null) return null;
  return { path: path.text, ...(alias === null ? {} : { alias: alias.text }) };
}

/**
 * `import a, b as c` — jedes Ziel ist ein eigener Import mit eigenem Pfad.
 * `from m import a, b as c` — EIN Pfad (`m`) mit mehreren gebundenen Namen.
 * Zwei Formen, deshalb zwei Zweige und keine gemeinsame Schleife, die beide
 * halb falsch bedient.
 */
function collectPythonImports(
  node: SyntaxNode,
  ctx: FileTextContext,
  sink: ModuleFactSink,
  isInitFile: boolean,
): void {
  const range = rangeOf(node, ctx);
  // spec.md §6.2: was ein Paketkopf (`__init__.py`) auf oberster Ebene
  // hereinholt, reicht er weiter — das ist ein Re-Export, kein Verbrauch.
  const importKind: RawImport["importKind"] =
    isInitFile && isTopLevel(node) ? "re_export" : "import";

  if (node.type === "import_statement") {
    for (const child of node.children) {
      const entry = importEntryOf(child);
      if (entry === null) continue;
      sink.imports.push({
        specifier: entry.path,
        importKind,
        range,
        ...(entry.alias === undefined ? {} : { importedNames: [entry.alias] }),
      });
    }
    return;
  }

  const moduleNode = node.childForFieldName("module_name");
  if (moduleNode === null) return;
  const importedNames: string[] = [];
  // Die gebundenen Namen stehen NACH dem Schluesselwort `import`; davor steht
  // der Modulpfad, der genauso aussieht. Ohne diese Schranke stuende
  // `collections` bei `from collections import x` als importierter Name da.
  let afterKeyword = false;
  for (const child of node.children) {
    if (child.type === "import") {
      afterKeyword = true;
      continue;
    }
    if (!afterKeyword) continue;
    // `from m import *` bindet unbekannt viele Namen. KEINEN zu nennen ist
    // die einzige ehrliche Antwort (domain `analysis.ts`: ein fehlendes Feld
    // heisst "unbekannt").
    const entry = importEntryOf(child);
    if (entry !== null) importedNames.push(entry.alias ?? entry.path);
  }
  sink.imports.push({
    specifier: moduleNode.text,
    importKind,
    range,
    ...(importedNames.length > 0 ? { importedNames } : {}),
  });
}

// ---------------------------------------------------------------------------
// 6. Signaturen
// ---------------------------------------------------------------------------

function headerBeforeBody(node: SyntaxNode, bodyField: string): string {
  const body = node.childForFieldName(bodyField);
  if (body === null) return node.text.split("\n")[0]?.trim() ?? node.text;
  return node.text.slice(0, Math.max(0, body.startIndex - node.startIndex)).trimEnd();
}

function pythonSignature(node: SyntaxNode, name: string, bodyField: string): ScopeSignature {
  if (node.type === "class_definition") {
    const raw = headerBeforeBody(node, bodyField);
    return { raw, normalized: normalizeHeaderText(raw) };
  }

  const parameters = node.childForFieldName("parameters");
  // `lambda_parameters` traegt KEINE Klammern; `parameters` traegt sie. Beide
  // muessen als `(...)` in die Normalform, sonst zerfaellt die Aufteilung.
  const parametersText =
    parameters === null
      ? "()"
      : parameters.text.trim().startsWith("(")
        ? parameters.text
        : `(${parameters.text})`;
  const returnType = node.childForFieldName("return_type");
  // `async` ist ein anonymes Kind, kein Feld — und es gehoert zur
  // Aufrufschnittstelle: eine Koroutine ist nicht dasselbe wie eine Funktion.
  const isAsync = node.children.some((child) => child.type === "async");
  const head = `${isAsync ? "async " : ""}${name}`;
  const raw = `${head}${parametersText}${returnType === null ? "" : ` -> ${returnType.text}`}`;
  const normalized = `${head}${normalizeParameterList(parametersText)}${normalizeReturnType(
    returnType?.text,
  )}`;
  return { raw, normalized };
}

// ---------------------------------------------------------------------------

/**
 * Baut das Python-Profil ueber dem Tabellenprofil — EINMAL JE DATEI, weil
 * `__all__` und `__init__.py` Dateieigenschaften sind.
 */
export function createPythonProfile(
  base: LanguageProfile,
  root: SyntaxNode,
  file: SourceFile,
): LanguageProfile {
  const dunderAll = findDunderAll(root);
  const isInitFile = INIT_FILE_RE.test(file.path.replace(/\\/g, "/"));
  const bodyField = "body";

  return {
    ...base,

    // 7. Zeichenkettenblaetter (siehe `table.ts`: `string` ist kein Container).
    simpleLiteralLeafKinds: new Set([...base.simpleLiteralLeafKinds, ...STRING_LEAF_KINDS]),
    simpleLiteralKind(kind: string): LiteralFact["literalKind"] {
      return STRING_LEAF_KINDS.has(kind) ? "string" : base.simpleLiteralKind(kind);
    },

    // Der Dekorator gehoert zum Symbol: `@app.route(...)` steht ueber der
    // Funktion und beschreibt sie. `chunks.ts` weitet den Bereich darauf aus.
    exportWrapperKinds: new Set(["decorated_definition"]),

    // 4. `def` ist Funktion, Methode oder Konstruktor.
    scopeKindOf(node: SyntaxNode): ScopeNode["kind"] | null {
      const kind = base.scopeKindOf(node);
      if (kind !== "function" || node.type !== "function_definition") return kind;
      if (enclosingScopeKind(node) !== "class_definition") return "function";
      return base.scopeName(node) === "__init__" ? "constructor" : "method";
    },

    scopeSignature(node: SyntaxNode, _kind: ScopeNode["kind"], name: string): ScopeSignature {
      return pythonSignature(node, name, bodyField);
    },

    docRange: (node, ctx) => docstringRange(node, ctx, bodyField),

    visibility: (_node, name) => pythonVisibility(name),

    // 3. `__all__` schlaegt die Unterstrich-Konvention. Beides gilt nur fuer
    // Namen auf Modulebene: eine Methode wird nicht aus der Datei exportiert.
    exportedNames(node: SyntaxNode, name: string): string[] {
      if (!isTopLevel(node)) return [];
      if (dunderAll !== null) return dunderAll.has(name) ? [name] : [];
      return name.startsWith("_") ? [] : [name];
    },

    detectDecisionAndNesting(node: SyntaxNode): DecisionDetectionResult {
      const detected = base.detectDecisionAndNesting(node);
      // `union_pattern` ist FLACH: `case 1 | 2 | 3` ist EIN Knoten mit drei
      // Zweigen, waehrend Rusts `or_pattern` fuer dasselbe zwei verschachtelte
      // Knoten baut. Ohne diese Zahl kostete `1 | 2 | 3` so viel wie `1 | 2`.
      if (node.type !== "union_pattern" || detected.decision === undefined) return detected;
      const alternatives = node.namedChildCount;
      if (alternatives <= 1) return detected;
      return { ...detected, decision: { ...detected.decision, repeat: alternatives - 1 } };
    },

    collectModuleFacts(node, kind, callerScopeId, ctx, sink): void {
      if (
        kind === "import_statement" ||
        kind === "import_from_statement" ||
        kind === "future_import_statement"
      ) {
        collectPythonImports(node, ctx, sink, isInitFile);
        return;
      }
      base.collectModuleFacts(node, kind, callerScopeId, ctx, sink);
    },
  };
}
