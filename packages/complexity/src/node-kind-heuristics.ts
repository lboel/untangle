/**
 * Best-effort classification of raw, adapter-specific AST node kind strings
 * (`NodeKindFact.kind`, `ComplexityFacts.nodeKinds`) into the language-neutral
 * buckets `StructuralCalculator`/`SyntacticCalculator` need for
 * `parameter_count`, `return_count`, `exit_point_count`, `statement_count`,
 * `expression_count` and `declaration_count` (spec.md §16.5, §16.8).
 *
 * `ComplexityFacts` deliberately keeps `kind` as an opaque, grammar-specific
 * string (e.g. tree-sitter's `"required_parameter"`, `"return_statement"`) —
 * domain does not define a normalized node-kind taxonomy. This module is
 * Untangle's own, documented, versioned answer to that gap (see README
 * "Entscheidungen" #5); it is intentionally conservative (substring match on
 * common, cross-grammar naming conventions) and is flagged in `openIssues` as
 * a candidate for an additive domain extension once real adapter output
 * exists to validate against.
 */
export type NodeKindClass =
  "parameter" | "return" | "exit" | "statement" | "expression" | "declaration" | "other";

const RETURN_MARKERS = ["return_statement", "return"];
const EXIT_MARKERS = ["throw_statement", "throw", "break_statement", "continue_statement"];
const PARAMETER_MARKERS = ["parameter"];
const DECLARATION_MARKERS = ["declaration", "declarator"];
const STATEMENT_MARKERS = ["statement"];
const EXPRESSION_MARKERS = ["expression"];

function matches(normalizedKind: string, markers: readonly string[]): boolean {
  return markers.some((marker) => normalizedKind === marker || normalizedKind.includes(marker));
}

/** Classifies one raw node-kind string. Order matters: more specific buckets are checked first. */
export function classifyNodeKind(kind: string): NodeKindClass {
  const normalized = kind.toLowerCase();
  if (matches(normalized, RETURN_MARKERS)) return "return";
  if (matches(normalized, EXIT_MARKERS)) return "exit";
  if (matches(normalized, PARAMETER_MARKERS)) return "parameter";
  if (matches(normalized, DECLARATION_MARKERS)) return "declaration";
  if (matches(normalized, STATEMENT_MARKERS)) return "statement";
  if (matches(normalized, EXPRESSION_MARKERS)) return "expression";
  return "other";
}

const ASYNC_MARKERS = ["async", "await"];

/** True when a raw node-kind string looks like an async construct (best-effort, see module docs). */
export function isAsyncNodeKind(kind: string): boolean {
  return matches(kind.toLowerCase(), ASYNC_MARKERS);
}

const EXCEPTION_MARKERS = ["throw_statement", "throw", "try_statement", "catch_clause"];

/** True when a raw node-kind string looks like an exception construct (best-effort, see module docs). */
export function isExceptionNodeKind(kind: string): boolean {
  return matches(kind.toLowerCase(), EXCEPTION_MARKERS);
}
