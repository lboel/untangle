/**
 * Signature text composition per scope kind (see `signature.ts` for the
 * normalization primitives this builds on, and its doc comment for the
 * normative whitespace/defaults/optional-marker/type-annotation rules).
 */
import { FUNCTION_LIKE_TYPES, METHOD_TYPE } from "./node-kinds.js";
import {
  normalizeHeaderText,
  normalizeParameterList,
  normalizeReturnType,
  normalizeTypeParameterList,
} from "./signature.js";
import type { SyntaxNode } from "./syntax.js";

const MODIFIER_ORDER = [
  "accessibility_modifier",
  "static",
  "abstract",
  "override_modifier",
  "readonly",
  "declare",
  "async",
] as const;

function collectModifiers(node: SyntaxNode): string[] {
  const found: string[] = [];
  for (const modifierType of MODIFIER_ORDER) {
    const child = node.children.find((c) => c.type === modifierType);
    if (child !== undefined) found.push(child.text);
  }
  return found;
}

function isGenerator(node: SyntaxNode): boolean {
  return node.children.some((child) => child.type === "*");
}

function accessorKeyword(node: SyntaxNode): "get" | "set" | undefined {
  const hasGet = node.children.some((child) => child.type === "get");
  const hasSet = node.children.some((child) => child.type === "set");
  return hasGet ? "get" : hasSet ? "set" : undefined;
}

interface FunctionSignature {
  raw: string;
  normalized: string;
}

/** Builds the signature for a function/arrow/method-shaped scope node. */
export function buildFunctionSignature(node: SyntaxNode, name: string): FunctionSignature {
  const typeParamsNode = node.childForFieldName("type_parameters");
  const parametersNode = node.childForFieldName("parameters");
  const returnTypeNode = node.childForFieldName("return_type");

  const modifiers = collectModifiers(node);
  const accessor = accessorKeyword(node);
  const generatorMarker = isGenerator(node) ? "*" : "";

  const headParts = [...modifiers];
  if (accessor !== undefined) headParts.push(accessor);
  const head =
    headParts.length > 0
      ? `${headParts.join(" ")} ${generatorMarker}${name}`
      : `${generatorMarker}${name}`;

  const rawTypeParams = typeParamsNode?.text;
  const rawParams =
    parametersNode?.text ??
    (node.childForFieldName("parameter")?.text !== undefined
      ? `(${node.childForFieldName("parameter")?.text})`
      : "()");
  const rawReturnType = returnTypeNode?.text;

  const raw = `${head}${rawTypeParams ?? ""}${rawParams}${rawReturnType !== undefined ? rawReturnType : ""}`;

  const normalizedTypeParams = normalizeTypeParameterList(rawTypeParams);
  const normalizedParams = normalizeParameterList(rawParams);
  const normalizedReturnType = normalizeReturnType(rawReturnType);
  const normalized = `${head}${normalizedTypeParams}${normalizedParams}${normalizedReturnType}`;

  return { raw, normalized };
}

/** Builds the signature for a class/interface/enum/type-alias/namespace scope node. */
export function buildHeaderSignature(node: SyntaxNode): FunctionSignature {
  const bodyNode = node.childForFieldName("body");
  const raw =
    bodyNode !== null
      ? node.text.slice(0, bodyNode.startIndex - node.startIndex).trimEnd()
      : node.text.replace(/;\s*$/, "");
  return { raw, normalized: normalizeHeaderText(raw) };
}

/** Builds the signature for a class field / property scope node. */
export function buildPropertySignature(node: SyntaxNode, name: string): FunctionSignature {
  const typeNode = node.childForFieldName("type");
  const modifiers = collectModifiers(node);
  const head = modifiers.length > 0 ? `${modifiers.join(" ")} ${name}` : name;
  const rawType = typeNode?.text;
  const raw = `${head}${rawType ?? ""}`;
  const normalized =
    rawType !== undefined ? `${head}${normalizeReturnType(rawType)}` : normalizeHeaderText(head);
  return { raw, normalized };
}

export function isFunctionLikeScope(nodeType: string): boolean {
  return FUNCTION_LIKE_TYPES.has(nodeType) || nodeType === METHOD_TYPE;
}
