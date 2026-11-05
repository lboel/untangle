import type { HttpBoundaryFileFactsV1 } from "@untangle-code/domain";

import type { FileTextContext } from "../languages/shared/node-utils.js";
import { rangeOf } from "../languages/shared/node-utils.js";
import type { SyntaxNode } from "../languages/shared/syntax.js";

import { field, namedChildren, stringValue } from "./expression.js";
import { scopeOf } from "./extract.js";

const METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options", "trace"]);

function keyword(node: SyntaxNode, name: string): SyntaxNode | null {
  return (
    namedChildren(node).find(
      (child) => child.type === "keyword_argument" && field(child, "name")?.text === name,
    ) ?? null
  );
}

function prefix(node: SyntaxNode): string | null {
  const value = keyword(node, "prefix");
  return value === null ? "" : stringValue(field(value, "value"));
}

function importFacts(
  nodes: readonly SyntaxNode[],
  ctx: FileTextContext,
  facts: HttpBoundaryFileFactsV1,
): void {
  for (const node of nodes) {
    if (node.type !== "import_from_statement" || scopeOf(node) !== "module") continue;
    const module = field(node, "module_name");
    if (module === null) continue;
    for (const child of namedChildren(node)) {
      if (child.startIndex === module.startIndex) continue;
      const name = child.type === "aliased_import" ? field(child, "name") : child;
      const alias = child.type === "aliased_import" ? field(child, "alias") : child;
      if (
        name === null ||
        alias === null ||
        !["identifier", "dotted_name", "aliased_import"].includes(child.type)
      )
        continue;
      facts.pythonImports.push({
        module: module.text,
        local: alias.text,
        imported: name.text,
        range: rangeOf(child, ctx),
      });
    }
  }
}

function expandedIncludeTargets(node: SyntaxNode, target: SyntaxNode): string[] {
  if (target.type !== "identifier") return [target.text];
  let parent = node.parent;
  while (parent !== null) {
    if (parent.type === "for_statement" && field(parent, "left")?.text === target.text) {
      const right = field(parent, "right");
      if (right !== null && ["tuple", "list"].includes(right.type)) {
        const items = namedChildren(right);
        if (items.every((item) => item.type === "attribute" || item.type === "identifier"))
          return items.map((item) => item.text);
      }
      return ["<dynamic-router-iteration>"];
    }
    if (parent.type === "function_definition") break;
    parent = parent.parent;
  }
  return [target.text];
}

/** Only FastAPI-imported constructors, literal prefixes and actual decorated functions produce routes. */
export function extractPythonHttpFacts(
  nodes: readonly SyntaxNode[],
  ctx: FileTextContext,
  facts: HttpBoundaryFileFactsV1,
): void {
  importFacts(nodes, ctx, facts);
  const constructorNames = new Map(
    facts.pythonImports
      .filter(
        (item) =>
          item.module === "fastapi" && ["FastAPI", "APIRouter"].includes(item.imported ?? ""),
      )
      .map((item) => [item.local, item.imported]),
  );
  for (const node of nodes) {
    if (node.type === "assignment") {
      const left = field(node, "left"),
        right = field(node, "right");
      if (left?.type !== "identifier" || right?.type !== "call") continue;
      const kind = constructorNames.get(field(right, "function")?.text ?? "");
      const args = field(right, "arguments");
      if (kind === undefined || args === null) continue;
      const constructorName = field(right, "function")?.text;
      let scope = scopeOf(node);
      let parameterShadow = false;
      for (let depth = 0; depth < 30 && scope !== "module"; depth += 1) {
        const fn = facts.functions.find((candidate) => candidate.scope === scope);
        if (fn?.parameters.some((parameter) => parameter.name === constructorName))
          parameterShadow = true;
        scope = fn?.parentScope ?? "module";
      }
      if (
        parameterShadow ||
        facts.pythonImports.filter((item) => item.local === constructorName).length !== 1 ||
        facts.bindings.some((binding) => binding.name === constructorName) ||
        facts.functions.some((fn) => fn.name === constructorName)
      ) {
        facts.limitations.push(`FastAPI constructor ${constructorName ?? "<unknown>"} is shadowed`);
        continue;
      }
      facts.routers.push({
        name: left.text,
        scope: scopeOf(node),
        kind: kind === "FastAPI" ? "app" : "router",
        prefix: prefix(args),
        range: rangeOf(node, ctx),
      });
    }
    if (node.type === "decorated_definition") {
      const handler = namedChildren(node).find((child) => child.type === "function_definition");
      if (handler === undefined) continue;
      for (const decorator of namedChildren(node).filter((child) => child.type === "decorator")) {
        const call = namedChildren(decorator)[0];
        if (call?.type !== "call") continue;
        const callee = field(call, "function");
        if (callee?.type !== "attribute") continue;
        const method = field(callee, "attribute")?.text;
        const object = field(callee, "object");
        const args = field(call, "arguments");
        if (
          method === undefined ||
          !METHODS.has(method) ||
          object?.type !== "identifier" ||
          args === null
        )
          continue;
        const first = namedChildren(args).find((arg) => arg.type !== "keyword_argument");
        facts.routes.push({
          router: object.text,
          scope: scopeOf(node),
          method: method.toUpperCase(),
          path: stringValue(first ?? null),
          handler: field(handler, "name")?.text ?? "<unnamed>",
          range: rangeOf(decorator, ctx),
          handlerRange: rangeOf(handler, ctx),
        });
      }
    }
    if (node.type === "call") {
      const callee = field(node, "function");
      if (callee?.type === "attribute" && field(callee, "attribute")?.text === "mount") {
        facts.limitations.push(
          "ASGI app.mount routing is unsupported; app entrypoints cannot be inferred",
        );
      }
      if (callee?.type !== "attribute" || field(callee, "attribute")?.text !== "include_router")
        continue;
      const owner = field(callee, "object"),
        args = field(node, "arguments");
      if (owner?.type !== "identifier" || args === null) continue;
      const target = namedChildren(args).find((arg) => arg.type !== "keyword_argument");
      if (target === undefined) continue;
      for (const router of expandedIncludeTargets(node, target))
        facts.includes.push({
          owner: owner.text,
          scope: scopeOf(node),
          router,
          prefix: prefix(args),
          range: rangeOf(node, ctx),
        });
    }
  }
  // A partial module graph remains visible; no app/include discovery is inferred from path names.
  if (facts.routes.length > 0 && facts.routers.length === 0)
    facts.limitations.push(
      "Route decorators have no proven FastAPI router constructor in this file",
    );
}
