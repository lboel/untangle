/**
 * Name/signature/visibility derivation for one scope-opening node.
 *
 * A scope-opening node (function/method/class/interface/type/enum/property,
 * see `node-kinds.ts#SCOPE_OPENING_TYPES`) is either self-naming (its own
 * `name` field) or anonymous, in which case the name is borrowed from the
 * enclosing syntactic context — `const x = () => {}`, `{ key: () => {} }`,
 * `x.y = function () {}`, `export default function () {}`, or a class field
 * initialized with an arrow function (spec.md §8.3 step 3: "Top-Level-Symbole
 * bestimmen").
 */
import { CLASS_TYPES, FIELD_TYPES, FUNCTION_LIKE_TYPES, METHOD_TYPE } from "./node-kinds.js";
import { unquote } from "./node-utils.js";
import type { SyntaxNode } from "./syntax.js";

const ANONYMOUS_NAME = "<anonymous>";

/** Derives the declared or contextually-borrowed name of a scope-opening node. */
export function resolveScopeName(node: SyntaxNode): string {
  const ownName = node.childForFieldName("name");
  if (ownName !== null) {
    return ownName.type === "computed_property_name" ? ownName.text : unquote(ownName.text);
  }

  if (FIELD_TYPES.has(node.type)) {
    const property = node.childForFieldName("property");
    if (property !== null) return unquote(property.text);
  }

  if (
    FUNCTION_LIKE_TYPES.has(node.type) ||
    node.type === METHOD_TYPE ||
    CLASS_TYPES.has(node.type)
  ) {
    const parent = node.parent;
    if (parent === null) return ANONYMOUS_NAME;

    switch (parent.type) {
      case "variable_declarator": {
        const declaratorName = parent.childForFieldName("name");
        return declaratorName !== null && declaratorName.type === "identifier"
          ? declaratorName.text
          : ANONYMOUS_NAME;
      }
      case "pair":
      case "pair_pattern": {
        const key = parent.childForFieldName("key");
        return key !== null ? unquote(key.text) : ANONYMOUS_NAME;
      }
      case "assignment_expression": {
        const left = parent.childForFieldName("left");
        if (left === null) return ANONYMOUS_NAME;
        if (left.type === "identifier") return left.text;
        if (left.type === "member_expression") {
          const property = left.childForFieldName("property");
          return property !== null ? property.text : ANONYMOUS_NAME;
        }
        return ANONYMOUS_NAME;
      }
      case "field_definition":
      case "public_field_definition": {
        const property = parent.childForFieldName("property");
        return property !== null ? unquote(property.text) : ANONYMOUS_NAME;
      }
      case "export_statement":
        return "default";
      default:
        return ANONYMOUS_NAME;
    }
  }

  return ANONYMOUS_NAME;
}

/**
 * True when a field's initializer is itself a function-like node: in that
 * case the FIELD does not get its own scope — the function value does,
 * borrowing the field's property name (avoids a redundant doubled
 * `Class.field.field` qualified name for `class C { handler = () => {} }`).
 */
export function fieldDelegatesToFunctionValue(node: SyntaxNode): boolean {
  if (!FIELD_TYPES.has(node.type)) return false;
  const value = node.childForFieldName("value");
  return value !== null && (FUNCTION_LIKE_TYPES.has(value.type) || value.type === "class");
}

const VISIBILITY_MODIFIER_TYPE = "accessibility_modifier";

/** `public`/`private`/`protected` if explicit, `"private"` for a `#name`, else `undefined` (implicit public). */
export function resolveVisibility(node: SyntaxNode, name: string): string | undefined {
  const modifier = node.children.find((child) => child.type === VISIBILITY_MODIFIER_TYPE);
  if (modifier !== undefined) return modifier.text;
  if (name.startsWith("#")) return "private";
  return undefined;
}

/**
 * Names this declaration exports, per spec.md §8.3 step 2/§14 (best-effort:
 * only direct `export` / `export default` wrapping the declaration itself is
 * recognized — a later `export { name }` clause elsewhere in the file is a
 * documented simplification, see README "Entscheidungen").
 */
export function resolveExportedNames(node: SyntaxNode, name: string): string[] {
  let current: SyntaxNode | null = node;
  // Walk up through wrapping declarator/declaration nodes that carry no name of their own.
  while (current !== null) {
    const parent: SyntaxNode | null = current.parent;
    if (parent === null) return [];
    if (parent.type === "export_statement") {
      const hasDefault = parent.children.some((child) => child.type === "default");
      return [hasDefault ? "default" : name];
    }
    if (
      parent.type === "variable_declarator" ||
      parent.type === "lexical_declaration" ||
      parent.type === "variable_declaration"
    ) {
      current = parent;
      continue;
    }
    return [];
  }
  return [];
}
