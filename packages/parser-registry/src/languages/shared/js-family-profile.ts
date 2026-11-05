/**
 * Das Sprachprofil der JS/TS-Familie (TypeScript, JavaScript, TSX, JSX).
 *
 * Diese Datei fuegt zusammen, was vorher fest in `engine.ts`, `chunks.ts` und
 * `fingerprint.ts` stand: die Knotenarten aus `node-kinds.ts` und die
 * handgeschriebenen Detektoren aus `decisions.ts`, `import-detection.ts`,
 * `call-detection.ts`, `scope-naming.ts`, `scope-signature.ts` und
 * `doc-binding.ts`. Es ist eine reine UMSTELLUNG, keine Verhaltensaenderung —
 * jede Verzweigung steht hier in derselben Reihenfolge und mit derselben
 * Bedingung wie vorher im Motor. Die Golden-Tests (`languages/golden.test.ts`)
 * und `cursor-walk.test.ts` sind der Beleg, dass sie es geblieben ist.
 *
 * WARUM DIE DETEKTOREN NICHT MITGEZOGEN SIND: sie sind nicht generisch, und
 * das sollen sie auch nicht sein. `detectStaticImport` kennt `import_clause`,
 * `named_imports`, `namespace_import` — Formen der ECMAScript-Grammatik. Eine
 * tabellengetriebene Fassung davon waere eine Tabelle mit genau einem Eintrag
 * und einer Menge Ausreden. Andere Sprachen bekommen ihre eigene, kleine
 * Fassung ueber `table-profile.ts`.
 */
import type { LiteralFact, SupportLevel } from "@untangle-code/domain";

import { detectCallExpression, detectNewExpression } from "./call-detection.js";
import { detectDecisionAndNesting, mayCarryDecisionOrNesting } from "./decisions.js";
import type { Dialect } from "./dialect.js";
import { resolveDocRange } from "./doc-binding.js";
import {
  detectDynamicImport,
  detectReExport,
  detectRequireCall,
  detectStaticImport,
} from "./import-detection.js";
import {
  CALL_EXPRESSION,
  CLASS_STATIC_BLOCK_TYPE,
  CLASS_TYPES,
  COMMENT_TYPE,
  ENUM_TYPE,
  EXPORT_STATEMENT,
  FIELD_TYPES,
  FUNCTION_LIKE_TYPES,
  IDENTIFIER_LEAF_TYPES,
  IGNORED_PUNCTUATION_TYPES,
  IMPORT_STATEMENT,
  INTERFACE_TYPE,
  LITERAL_CONTAINER_STOP_TYPES,
  METHOD_TYPE,
  NAMESPACE_TYPE,
  NEW_EXPRESSION,
  SCOPE_OPENING_TYPES,
  SIMPLE_LITERAL_LEAF_TYPES,
  TEMPLATE_TEXT_LEAF_TYPES,
  TYPE_ALIAS_TYPE,
} from "./node-kinds.js";
import { rangeOf } from "./node-utils.js";
import type { LanguageProfile, MemberRegion, ModuleFactSink, ScopeSignature } from "./profile.js";
import type { ScopeNode } from "./scope-model.js";
import {
  fieldDelegatesToFunctionValue,
  resolveExportedNames,
  resolveScopeName,
  resolveVisibility,
} from "./scope-naming.js";
import {
  buildFunctionSignature,
  buildHeaderSignature,
  buildPropertySignature,
  isFunctionLikeScope,
} from "./scope-signature.js";
import type { SyntaxNode } from "./syntax.js";

/** Der TS-Knoten, dessen Blaetter reine Typsyntax sind (`string`, `number`, `void`, ...). */
const PREDEFINED_TYPE = "predefined_type";

/**
 * Die Knotenarten, fuer die der Walk einen Knotenwrapper braucht: Scopeoeffner,
 * Entscheidungstraeger, Import/Export, Aufruf. Fuer alles andere bleibt der
 * Cursor unter sich (WP-95).
 */
function needsNodeFor(kind: string): boolean {
  return (
    SCOPE_OPENING_TYPES.has(kind) ||
    mayCarryDecisionOrNesting(kind) ||
    kind === IMPORT_STATEMENT ||
    kind === EXPORT_STATEMENT ||
    kind === CALL_EXPRESSION ||
    kind === NEW_EXPRESSION
  );
}

function simpleLiteralKind(kind: string): LiteralFact["literalKind"] {
  switch (kind) {
    case "number":
      return "number";
    case "true":
    case "false":
      return "boolean";
    case "null":
      return "null";
    default:
      return "other";
  }
}

/**
 * Deklaration oder Verweis? Aus `cursor.currentFieldName` und der Elternart —
 * unveraendert aus `engine.ts` uebernommen.
 */
function identifierRole(
  fieldName: string | undefined,
  parentKind: string,
): "declaration" | "reference" {
  if (fieldName === "name") {
    if (
      parentKind === "variable_declarator" ||
      parentKind === "function_declaration" ||
      parentKind === "class_declaration" ||
      parentKind === "abstract_class_declaration" ||
      parentKind === "interface_declaration" ||
      parentKind === "type_alias_declaration" ||
      parentKind === "enum_declaration" ||
      parentKind === "method_definition" ||
      parentKind === "required_parameter" ||
      parentKind === "optional_parameter" ||
      parentKind === "import_specifier" ||
      parentKind === "namespace_import"
    ) {
      return "declaration";
    }
  }
  if (
    fieldName === "property" &&
    (parentKind === "field_definition" || parentKind === "public_field_definition")
  ) {
    return "declaration";
  }
  return "reference";
}

/** Baut das Profil einer der vier JS/TS-Dialekte. */
export function createJsFamilyProfile(dialect: Dialect): LanguageProfile {
  const supportLevel: SupportLevel = dialect.supportLevel;

  return {
    languageId: dialect.languageId,
    extensions: dialect.extensions,
    supportLevel,

    commentKinds: new Set([COMMENT_TYPE]),
    literalContainerKinds: LITERAL_CONTAINER_STOP_TYPES,
    identifierLeafKinds: IDENTIFIER_LEAF_TYPES,
    simpleLiteralLeafKinds: SIMPLE_LITERAL_LEAF_TYPES,
    templateTextLeafKinds: TEMPLATE_TEXT_LEAF_TYPES,
    ignoredPunctuationKinds: IGNORED_PUNCTUATION_TYPES,
    typeKeywordParentKinds: new Set([PREDEFINED_TYPE]),
    functionLikeKinds: FUNCTION_LIKE_TYPES,
    exportWrapperKinds: new Set([EXPORT_STATEMENT]),

    containerLiteralKind: (kind) => (kind === "regex" ? "regex" : "string"),
    simpleLiteralKind,
    identifierRole,
    needsNode: needsNodeFor,

    scopeKindOf(node: SyntaxNode): ScopeNode["kind"] | null {
      if (FUNCTION_LIKE_TYPES.has(node.type)) return "function";
      if (node.type === METHOD_TYPE) {
        return resolveScopeName(node) === "constructor" ? "constructor" : "method";
      }
      if (CLASS_TYPES.has(node.type)) return "class";
      if (node.type === INTERFACE_TYPE) return "interface";
      if (node.type === TYPE_ALIAS_TYPE) return "type";
      if (node.type === ENUM_TYPE) return "enum";
      if (node.type === NAMESPACE_TYPE) return "namespace";
      if (node.type === dialect.fieldDefinitionKind) return "property";
      return null;
    },

    suppressesScope(node: SyntaxNode): boolean {
      return FIELD_TYPES.has(node.type) && fieldDelegatesToFunctionValue(node);
    },

    scopeName: resolveScopeName,

    scopeSignature(node: SyntaxNode, kind: ScopeNode["kind"], name: string): ScopeSignature {
      return isFunctionLikeScope(node.type)
        ? buildFunctionSignature(node, name)
        : kind === "property"
          ? buildPropertySignature(node, name)
          : buildHeaderSignature(node);
    },

    docRange: resolveDocRange,
    visibility: resolveVisibility,
    exportedNames: resolveExportedNames,
    detectDecisionAndNesting,

    collectModuleFacts(node, kind, callerScopeId, ctx, sink: ModuleFactSink): void {
      if (kind === IMPORT_STATEMENT) {
        const detectedImport = detectStaticImport(node, ctx);
        if (detectedImport !== null) sink.imports.push(detectedImport);
        return;
      }
      if (kind === EXPORT_STATEMENT) {
        if (node.childForFieldName("source") !== null) {
          const reExport = detectReExport(node, ctx);
          if (reExport !== null) sink.imports.push(reExport);
        }
        return;
      }
      if (kind === CALL_EXPRESSION) {
        const functionNode = node.childForFieldName("function");
        if (functionNode?.type === "import") {
          const dynamicImport = detectDynamicImport(node, ctx);
          if (dynamicImport !== null) sink.imports.push(dynamicImport);
        } else if (functionNode?.type === "identifier" && functionNode.text === "require") {
          const requireImport = detectRequireCall(node, ctx);
          if (requireImport !== null) sink.imports.push(requireImport);
        } else {
          const call = detectCallExpression(node, callerScopeId, ctx);
          if (call !== null) sink.calls.push(call);
        }
        return;
      }
      if (kind === NEW_EXPRESSION) {
        const call = detectNewExpression(node, callerScopeId, ctx);
        if (call !== null) sink.calls.push(call);
      }
    },

    memberRegions(node: SyntaxNode, parentScopeId, ctx): MemberRegion[] {
      const body = node.childForFieldName("body");
      if (body === null) return [];
      const regions: MemberRegion[] = [];
      let ordinal = 0;
      for (const child of body.children) {
        if (child.type !== CLASS_STATIC_BLOCK_TYPE) continue;
        regions.push({
          range: rangeOf(child, ctx),
          scopeId: `${parentScopeId}#static_block#${String(ordinal)}`,
          headerText: "static initialization block",
        });
        ordinal += 1;
      }
      return regions;
    },
  };
}
