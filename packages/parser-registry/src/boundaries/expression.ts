import type { HttpExpressionV1 } from "@untangle-code/domain";

import type { SyntaxNode } from "../languages/shared/syntax.js";

export function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.children.filter((child) => child.isNamed && child.type !== "comment");
}

export function field(node: SyntaxNode, name: string): SyntaxNode | null {
  return node.childForFieldName(name);
}

export function unknown(detail: string): HttpExpressionV1 {
  return { kind: "unknown", detail };
}

/** Only unescaped literals are accepted. Unsupported escapes remain explicit unknowns. */
export function stringValue(node: SyntaxNode | null): string | null {
  if (node === null || (node.type !== "string" && node.type !== "string_literal")) return null;
  const raw = node.text;
  const quote = raw[0];
  if ((quote !== "'" && quote !== '"') || raw.at(-1) !== quote || raw.includes("\\")) return null;
  if (raw.startsWith(quote.repeat(3))) return null;
  return raw.slice(1, -1);
}

/** Interpret syntax, never execute source expressions or scan comments/string contents as code. */
export function expression(node: SyntaxNode | null, depth = 0): HttpExpressionV1 {
  if (node === null) return unknown("missing expression");
  if (depth > 40) return unknown("expression depth budget exceeded");
  const next = (child: SyntaxNode | null) => expression(child, depth + 1);
  const string = stringValue(node);
  if (string !== null) return { kind: "string", value: string };
  if (node.type === "identifier" || node.type === "shorthand_property_identifier") {
    return node.text === "undefined" ? { kind: "undefined" } : { kind: "name", name: node.text };
  }
  if (
    ["parenthesized_expression", "as_expression", "type_assertion", "await_expression"].includes(
      node.type,
    )
  ) {
    return next(namedChildren(node)[0] ?? null);
  }
  if (node.type === "member_expression" || node.type === "attribute") {
    const property = field(node, "property") ?? field(node, "attribute");
    return property === null
      ? unknown("computed member")
      : {
          kind: "member",
          object: next(field(node, "object")),
          property: property.text,
        };
  }
  if (node.type === "call_expression" || node.type === "call") {
    return {
      kind: "call",
      callee: next(field(node, "function")),
      arguments: namedChildren(field(node, "arguments") ?? node).map(next),
    };
  }
  if (node.type === "template_string") {
    const parts: (string | HttpExpressionV1)[] = [];
    for (const child of namedChildren(node)) {
      if (child.type === "string_fragment") parts.push(child.text);
      else if (child.type === "template_substitution")
        parts.push(next(namedChildren(child)[0] ?? null));
      else return unknown("escaped or unsupported template segment");
    }
    return { kind: "template", parts };
  }
  if (
    node.type === "binary_expression" &&
    node.children.some((child) => child.text === "+" && !child.isNamed)
  ) {
    return { kind: "template", parts: [next(field(node, "left")), next(field(node, "right"))] };
  }
  if (node.type === "object") {
    const entries: Extract<HttpExpressionV1, { kind: "object" }>["entries"] = [];
    for (const child of namedChildren(node)) {
      if (child.type === "spread_element")
        entries.push({ spread: next(namedChildren(child)[0] ?? null) });
      else if (child.type === "pair") {
        const key = field(child, "key");
        const literalKey = stringValue(key);
        if (key === null || (literalKey === null && key.type !== "property_identifier")) {
          entries.push({ spread: unknown("computed object key") });
        } else entries.push({ key: literalKey ?? key.text, value: next(field(child, "value")) });
      } else if (child.type === "shorthand_property_identifier") {
        entries.push({ key: child.text, value: next(child) });
      } else entries.push({ spread: unknown("unsupported object entry") });
    }
    return { kind: "object", entries };
  }
  return unknown(`unsupported ${node.type}`);
}
