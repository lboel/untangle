import type { SourceRange } from "@untangle-code/domain";

import type { SyntaxNode } from "./syntax.js";

/**
 * Internal (package-private) representation of one symbol scope, built once
 * per parse by `engine.ts#analyze` and then projected into the public
 * `ExtractedSymbol[]` / `SymbolScopeFact[]` / `AstRegion[]` shapes by
 * `extractSymbols.ts`, `complexity.ts` and `chunks.ts` respectively. Keeping
 * ONE tree as the single source of truth guarantees `scopeId`s line up
 * exactly across `extractSymbols`, `computeComplexity` and `extractCalls`,
 * since all three are projections of the same walk.
 */
export interface ScopeNode {
  scopeId: string;
  /** Adapter-internal kind: superset of ExtractedSymbol.kind plus "file". */
  kind:
    | "file"
    | "function"
    | "method"
    | "constructor"
    | "class"
    | "interface"
    | "type"
    | "enum"
    | "namespace"
    | "property";
  name: string;
  qualifiedName: string;
  parentQualifiedName?: string;
  range: SourceRange;
  docRange?: SourceRange;
  signature?: string;
  normalizedSignature: string;
  exportedNames: string[];
  visibility?: string;
  executable: boolean;
  astHash: string;
  tokenFingerprint: string;
  /** The tree-sitter node whose range/body IS this scope (used only within this package). */
  node: SyntaxNode;
  children: ScopeNode[];
}
