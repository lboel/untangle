/**
 * Test-only builders for hand-constructed `ComplexityFacts`/`ComplexityIRNode`
 * fixtures. Excluded from the package build (tsconfig.json excludes
 * `src/test-support/**`) — imported only from `*.test.ts` files.
 */
import type {
  ComplexityFacts,
  ComplexityIRNode,
  DecisionFact,
  IdentifierFact,
  IRKind,
  LiteralFact,
  NestingFact,
  NodeKindFact,
  ParseDiagnostic,
  SourceRange,
  SymbolScopeFact,
  TokenFact,
} from "@untangle-code/domain";

/** Builds a `SourceRange` from line numbers, treating each line as `lineWidth` bytes for byte-offset math. */
export function range(startLine: number, endLine: number, lineWidth = 40): SourceRange {
  return {
    startLine,
    endLine,
    startByte: (startLine - 1) * lineWidth,
    endByte: endLine * lineWidth,
  };
}

export function emptyFacts(): ComplexityFacts {
  return {
    symbolScopes: [],
    decisions: [],
    nestingEvents: [],
    operators: [],
    operands: [],
    nodeKinds: [],
    comments: [],
    identifiers: [],
    literals: [],
    parseDiagnostics: [],
  };
}

export function symbolScope(
  overrides: Partial<SymbolScopeFact> & Pick<SymbolScopeFact, "symbolScopeId" | "range">,
): SymbolScopeFact {
  return {
    name: "symbol",
    qualifiedName: "symbol",
    kind: "function",
    executable: true,
    ...overrides,
  };
}

export function decision(
  overrides: Partial<DecisionFact> & Pick<DecisionFact, "kind" | "range" | "symbolScopeId">,
): DecisionFact {
  return {
    countsForClassic: true,
    countsForExtended: true,
    ...overrides,
  };
}

export function nestingEvent(
  overrides: Partial<NestingFact> & Pick<NestingFact, "construct" | "range" | "symbolScopeId">,
): NestingFact {
  return {
    continuation: false,
    ...overrides,
  };
}

export function token(text: string, r: SourceRange, symbolScopeId: string): TokenFact {
  return { text, range: r, symbolScopeId };
}

export function identifier(
  overrides: Partial<IdentifierFact> & Pick<IdentifierFact, "name" | "range" | "symbolScopeId">,
): IdentifierFact {
  return { role: "reference", ...overrides };
}

export function literal(
  overrides: Partial<LiteralFact> &
    Pick<LiteralFact, "raw" | "literalKind" | "range" | "symbolScopeId">,
): LiteralFact {
  return { ...overrides };
}

export function nodeKind(kind: string, depth: number, symbolScopeId: string): NodeKindFact {
  return { kind, depth, symbolScopeId };
}

export function diagnostic(
  overrides: Partial<ParseDiagnostic> & Pick<ParseDiagnostic, "kind" | "range">,
): ParseDiagnostic {
  return { severity: "warning", message: "", ...overrides };
}

export function ir(
  kind: IRKind,
  r: SourceRange,
  symbolScopeId: string,
  overrides: Partial<Omit<ComplexityIRNode, "kind" | "range" | "symbolScopeId">> = {},
): ComplexityIRNode {
  return {
    kind,
    range: r,
    symbolScopeId,
    children: [],
    ...overrides,
  };
}
