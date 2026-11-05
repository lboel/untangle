import type { ExtractedSymbol } from "@untangle-code/domain";

import type { ScopeNode } from "./scope-model.js";

function toExtractedSymbol(scope: ScopeNode): ExtractedSymbol {
  return {
    name: scope.name,
    qualifiedName: scope.qualifiedName,
    kind: scope.kind,
    ...(scope.signature !== undefined ? { signature: scope.signature } : {}),
    normalizedSignature: scope.normalizedSignature,
    range: scope.range,
    ...(scope.docRange !== undefined ? { docRange: scope.docRange } : {}),
    ...(scope.parentQualifiedName !== undefined
      ? { parentQualifiedName: scope.parentQualifiedName }
      : {}),
    exportedNames: scope.exportedNames,
    ...(scope.visibility !== undefined ? { visibility: scope.visibility } : {}),
    astHash: scope.astHash,
    tokenFingerprint: scope.tokenFingerprint,
  };
}

/** Flattens the scope tree (excluding the synthetic file-level root) into `ExtractedSymbol[]`, document order. */
export function extractedSymbolsOf(fileScope: ScopeNode): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const visit = (scope: ScopeNode): void => {
    for (const child of scope.children) {
      symbols.push(toExtractedSymbol(child));
      visit(child);
    }
  };
  visit(fileScope);
  return symbols;
}
