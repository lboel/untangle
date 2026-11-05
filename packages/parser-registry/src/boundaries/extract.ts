/** AST projections for HTTP boundaries. Backend-specific ASTs stay inside the parser package. */
import type {
  HttpBoundaryFileFactsV1,
  HttpFunctionFactV1,
  LanguageAdapter,
  ParsedAst,
  SourceFile,
} from "@untangle-code/domain";
import { sha256Hex } from "@untangle-code/domain";

import type { FileTextContext } from "../languages/shared/node-utils.js";
import { rangeOf } from "../languages/shared/node-utils.js";
import type { SyntaxNode } from "../languages/shared/syntax.js";
import { shiftVueRange } from "../languages/vue/index.js";
import type { VueAstRoot } from "../languages/vue/index.js";

import { expression, field, namedChildren } from "./expression.js";
import { extractPythonHttpFacts } from "./python.js";

const FUNCTIONS = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "function_definition",
]);

interface NativePayload {
  tree?: { rootNode: SyntaxNode };
  root?: SyntaxNode;
  ctx: FileTextContext;
}

/** Provenance keys are source locations, never graph identifiers. */
export function functionScope(node: SyntaxNode): string {
  return `function@${String(node.startIndex)}`;
}

export function enclosingFunction(node: SyntaxNode): SyntaxNode | null {
  let current = node.parent;
  while (current !== null) {
    if (FUNCTIONS.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

export function scopeOf(node: SyntaxNode): string {
  const owner = enclosingFunction(node);
  return owner === null ? "module" : functionScope(owner);
}

function boundNames(pattern: SyntaxNode): string[] {
  return walkSyntax(pattern)
    .filter(
      (node) => node.type === "identifier" || node.type === "shorthand_property_identifier_pattern",
    )
    .map((node) => node.text);
}

export function functionFact(node: SyntaxNode, ctx: FileTextContext): HttpFunctionFactV1 {
  const nameNode = field(node, "name");
  const assignedName =
    node.parent?.type === "variable_declarator" ? field(node.parent, "name") : null;
  const params = field(node, "parameters");
  const patternParameters =
    params === null
      ? []
      : namedChildren(params).flatMap((param) => {
          const pattern = field(param, "pattern") ?? param;
          return ["object_pattern", "array_pattern", "rest_pattern"].includes(pattern.type)
            ? boundNames(pattern).map((name) => ({ name }))
            : [];
        });
  return {
    scope: functionScope(node),
    parentScope: scopeOf(node),
    name: nameNode?.text ?? assignedName?.text ?? `<anonymous@${String(node.startIndex)}>`,
    range: rangeOf(node, ctx),
    parameters: [
      ...(params === null
        ? []
        : namedChildren(params).map((param) => {
            const name =
              field(param, "pattern") ??
              field(param, "name") ??
              namedChildren(param).find((child) => child.type === "identifier") ??
              param;
            const value = field(param, "value");
            const annotation = field(param, "type");
            return {
              name: name.text,
              ...(value === null ? {} : { defaultValue: expression(value) }),
              ...(annotation?.text.replaceAll(/\s+/g, " ").trim() === ": typeof fetch"
                ? { fetchTransport: true }
                : {}),
            };
          })),
      ...patternParameters,
    ],
  };
}

export function walkSyntax(root: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode;
    result.push(node);
    const children = namedChildren(node);
    for (let index = children.length - 1; index >= 0; index -= 1)
      stack.push(children[index] as SyntaxNode);
  }
  return result;
}

export function extractHttpBoundaryFacts(
  source: SourceFile,
  ast: ParsedAst,
  adapter?: LanguageAdapter,
): HttpBoundaryFileFactsV1 {
  const facts: HttpBoundaryFileFactsV1 = {
    path: source.path,
    contentHash: source.contentHash,
    languageId: ast.languageId,
    parseQuality: ast.parseQuality,
    imports: adapter?.extractImports(ast) ?? [],
    calls: [],
    functions: [],
    bindings: [],
    routers: [],
    routes: [],
    includes: [],
    pythonImports: [],
    limitations: [],
  };
  if (sha256Hex(source.content) !== source.contentHash) {
    facts.limitations.push("Source content does not match its declared hash");
    return facts;
  }
  if (ast.languageId === "vue") {
    if (ast.parseQuality !== "complete") {
      facts.limitations.push("HTTP boundary extraction requires a complete Vue parse");
      return facts;
    }
    const root = ast.root as VueAstRoot;
    for (const script of root.scripts) {
      const part = extractHttpBoundaryFacts(script.source, script.ast, script.adapter);
      const prefix = `${script.context}:`;
      const scope = (value: string) => `${prefix}${value}`;
      const shift = (range: HttpFunctionFactV1["range"]) => shiftVueRange(script, range);
      facts.functions.push({
        scope: scope("module"),
        parentScope: "module",
        name: `<${script.context}>`,
        range: script.range,
        parameters: [],
      });
      facts.calls.push(
        ...part.calls.map((call) => ({
          ...call,
          scope: scope(call.scope),
          range: shift(call.range),
        })),
      );
      facts.functions.push(
        ...part.functions.map((fn) => ({
          ...fn,
          scope: scope(fn.scope),
          parentScope: scope(fn.parentScope),
          range: shift(fn.range),
        })),
      );
      facts.bindings.push(
        ...part.bindings.map((binding) => ({
          ...binding,
          scope: scope(binding.scope),
          range: shift(binding.range),
        })),
      );
      facts.limitations.push(...part.limitations);
    }
    return facts;
  }
  if (!["typescript", "javascript", "tsx", "jsx", "python"].includes(ast.languageId)) {
    facts.limitations.push(`HTTP boundary extraction is unsupported for ${ast.languageId}`);
    return facts;
  }
  if (ast.parseQuality !== "complete") {
    facts.limitations.push("HTTP boundary extraction requires a complete parse");
    return facts;
  }
  const payload = ast.root as NativePayload;
  const root = payload.tree?.rootNode ?? payload.root;
  if (
    root === undefined ||
    payload.ctx === undefined ||
    payload.ctx.sourceText !== source.content
  ) {
    facts.limitations.push("Unsupported parser AST payload");
    return facts;
  }
  const nodes = walkSyntax(root);
  for (const node of nodes) {
    if (FUNCTIONS.has(node.type)) facts.functions.push(functionFact(node, payload.ctx));
    if (node.type === "variable_declarator" || node.type === "assignment") {
      const name = field(node, "name") ?? field(node, "left");
      const value = field(node, "value") ?? field(node, "right");
      if (name !== null && ["object_pattern", "array_pattern"].includes(name.type)) {
        for (const bound of boundNames(name))
          facts.bindings.push({
            scope: scopeOf(node),
            name: bound,
            value: { kind: "unknown", detail: "destructured binding" },
            range: rangeOf(node, payload.ctx),
          });
      }
      if (name?.type === "identifier" && value !== null)
        facts.bindings.push({
          scope: scopeOf(node),
          name: name.text,
          value:
            node.type === "variable_declarator" &&
            !node.parent?.children.some((child) => child.text === "const" && !child.isNamed)
              ? { kind: "unknown", detail: "mutable variable binding" }
              : expression(value),
          range: rangeOf(node, payload.ctx),
        });
    }
    if (node.type === "catch_clause") {
      const parameter = field(node, "parameter");
      if (parameter !== null)
        for (const name of boundNames(parameter))
          facts.bindings.push({
            scope: scopeOf(node),
            name,
            value: { kind: "unknown", detail: "catch parameter binding" },
            range: rangeOf(node, payload.ctx),
          });
    }
    if (
      node.type === "assignment_expression" ||
      node.type === "augmented_assignment_expression" ||
      node.type === "update_expression" ||
      (node.type === "unary_expression" &&
        node.children.some((child) => !child.isNamed && child.text === "delete"))
    ) {
      let target = field(node, "left") ?? field(node, "argument");
      while (target?.type === "member_expression" || target?.type === "subscript_expression")
        target = field(target, "object");
      if (target !== null && ["object_pattern", "array_pattern"].includes(target.type)) {
        for (const part of walkSyntax(target)) {
          if (
            part.type !== "member_expression" &&
            part.type !== "subscript_expression" &&
            part.type !== "shorthand_property_identifier_pattern"
          )
            continue;
          let object = part;
          while (object.type === "member_expression" || object.type === "subscript_expression") {
            const parent = field(object, "object");
            if (parent === null) break;
            object = parent;
          }
          if (
            object.type === "identifier" ||
            object.type === "shorthand_property_identifier_pattern"
          )
            facts.bindings.push({
              scope: scopeOf(node),
              name: object.text,
              value: { kind: "unknown", detail: "reassigned binding" },
              range: rangeOf(node, payload.ctx),
            });
        }
      }
      if (target?.type === "identifier")
        facts.bindings.push({
          scope: scopeOf(node),
          name: target.text,
          value: { kind: "unknown", detail: "reassigned binding" },
          range: rangeOf(node, payload.ctx),
        });
    }
    if (node.type === "call_expression" || node.type === "call") {
      const owner = enclosingFunction(node);
      const parameter = owner?.parent;
      if (
        owner?.type === "arrow_function" &&
        parameter !== null &&
        parameter !== undefined &&
        ["required_parameter", "optional_parameter"].includes(parameter.type) &&
        field(parameter, "type")?.text.replaceAll(/\s+/g, " ").trim() === ": typeof fetch"
      )
        continue;
      const args = field(node, "arguments");
      facts.calls.push({
        callee: expression(field(node, "function")),
        arguments: args === null ? [] : namedChildren(args).map((arg) => expression(arg)),
        range: rangeOf(node, payload.ctx),
        scope: scopeOf(node),
      });
    }
  }
  if (ast.languageId === "python") extractPythonHttpFacts(nodes, payload.ctx, facts);
  return facts;
}
