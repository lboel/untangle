/**
 * Call-site detection (architecture.md §6.5, spec.md §15.2). No resolution
 * happens here — that is symbol-graph's job (task instructions, explicit).
 *
 * `require(...)` and dynamic `import(...)` are deliberately EXCLUDED here:
 * they are modeled purely as `RawImport` entries (`import-detection.ts`) so
 * the symbol-graph does not see the same source construct as both an import
 * edge and a call edge.
 */
import type { RawCall } from "@untangle-code/domain";

import type { FileTextContext } from "./node-utils.js";
import { rangeOf } from "./node-utils.js";
import type { SyntaxNode } from "./syntax.js";

function argumentCountOf(node: SyntaxNode): number | undefined {
  const args = node.childForFieldName("arguments");
  return args !== null ? args.namedChildCount : undefined;
}

function isRequireOrDynamicImportCallee(functionNode: SyntaxNode): boolean {
  return (
    functionNode.type === "import" ||
    (functionNode.type === "identifier" && functionNode.text === "require")
  );
}

/** Detects a `call_expression` as a `RawCall`, or `null` for require/dynamic-import (see file doc). */
export function detectCallExpression(
  node: SyntaxNode,
  callerScopeId: string,
  ctx: FileTextContext,
): RawCall | null {
  const functionNode = node.childForFieldName("function");
  if (functionNode === null) return null;
  if (isRequireOrDynamicImportCallee(functionNode)) return null;

  const range = rangeOf(node, ctx);
  const argumentCount = argumentCountOf(node);

  if (functionNode.type === "identifier") {
    return {
      calleeName: functionNode.text,
      callerScopeId,
      range,
      ...(argumentCount !== undefined ? { argumentCount } : {}),
    };
  }

  if (functionNode.type === "member_expression") {
    const property = functionNode.childForFieldName("property");
    const object = functionNode.childForFieldName("object");
    if (property === null) return null;
    return {
      calleeName: property.text,
      ...(object !== null ? { qualifier: object.text } : {}),
      callerScopeId,
      range,
      ...(argumentCount !== undefined ? { argumentCount } : {}),
    };
  }

  // Any other callee shape (IIFE, call result invoked again, computed
  // member, etc.): fall back to the raw written expression text as the
  // callee name so the call site is not silently dropped.
  return {
    calleeName: functionNode.text,
    callerScopeId,
    range,
    ...(argumentCount !== undefined ? { argumentCount } : {}),
  };
}

/** Detects a `new_expression` as a `RawCall` (constructor invocation). */
export function detectNewExpression(
  node: SyntaxNode,
  callerScopeId: string,
  ctx: FileTextContext,
): RawCall | null {
  const constructorNode = node.childForFieldName("constructor");
  if (constructorNode === null) return null;
  const range = rangeOf(node, ctx);
  const args = node.childForFieldName("arguments");
  const argumentCount = args !== null ? args.namedChildCount : undefined;

  if (constructorNode.type === "identifier") {
    return {
      calleeName: constructorNode.text,
      callerScopeId,
      range,
      ...(argumentCount !== undefined ? { argumentCount } : {}),
    };
  }
  if (constructorNode.type === "member_expression") {
    const property = constructorNode.childForFieldName("property");
    const object = constructorNode.childForFieldName("object");
    if (property === null) return null;
    return {
      calleeName: property.text,
      ...(object !== null ? { qualifier: object.text } : {}),
      callerScopeId,
      range,
      ...(argumentCount !== undefined ? { argumentCount } : {}),
    };
  }
  return {
    calleeName: constructorNode.text,
    callerScopeId,
    range,
    ...(argumentCount !== undefined ? { argumentCount } : {}),
  };
}
