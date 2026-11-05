import type {
  AstRegion,
  ComplexityFacts,
  ExtractedSymbol,
  SourceRange,
} from "@untangle-code/domain";

import type { VueScriptAst } from "./index.js";

/** Vue compiler locations use UTF-16; the block range is already converted to UTF-8. */
export function shiftVueRange(
  script: Pick<VueScriptAst, "range">,
  range: SourceRange,
): SourceRange {
  return {
    startByte: script.range.startByte + range.startByte,
    endByte: script.range.startByte + range.endByte,
    startLine: script.range.startLine + range.startLine - 1,
    endLine: script.range.startLine + range.endLine - 1,
  };
}

export function vueQualifiedName(script: VueScriptAst, name: string): string {
  return script.qualifier.length === 0 ? name : `${script.qualifier}.${name}`;
}

/** Both inline blocks share the enclosing file scope, but their child identities stay distinct. */
export function vueScopeId(script: VueScriptAst, scopeId: string, fileId: string): string {
  return scopeId === script.source.fileId ? fileId : scopeId;
}

export function vueSymbol(script: VueScriptAst, symbol: ExtractedSymbol): ExtractedSymbol {
  return {
    ...symbol,
    qualifiedName: vueQualifiedName(script, symbol.qualifiedName),
    range: shiftVueRange(script, symbol.range),
    ...(symbol.docRange !== undefined ? { docRange: shiftVueRange(script, symbol.docRange) } : {}),
    ...(symbol.parentQualifiedName !== undefined
      ? { parentQualifiedName: vueQualifiedName(script, symbol.parentQualifiedName) }
      : {}),
  };
}

export function vueRegion(script: VueScriptAst, region: AstRegion, fileId: string): AstRegion {
  return {
    ...region,
    range: shiftVueRange(script, region.range),
    scopeId: vueScopeId(script, region.scopeId, fileId),
    ...(region.symbolFqn !== undefined
      ? { symbolFqn: vueQualifiedName(script, region.symbolFqn) }
      : {}),
    ...(region.children !== undefined
      ? { children: region.children.map((child) => vueRegion(script, child, fileId)) }
      : {}),
  };
}

export function vueFacts(script: VueScriptAst, fileId: string): ComplexityFacts {
  const facts = script.adapter.computeComplexity(script.ast);
  const scoped = <T extends { symbolScopeId: string }>(fact: T): T => ({
    ...fact,
    symbolScopeId: vueScopeId(script, fact.symbolScopeId, fileId),
  });
  const ranged = <T extends { range: SourceRange }>(fact: T): T => ({
    ...fact,
    range: shiftVueRange(script, fact.range),
  });
  return {
    symbolScopes: facts.symbolScopes
      .filter((scope) => scope.symbolScopeId !== script.source.fileId)
      .map((scope) => ({
        ...ranged(scoped(scope)),
        qualifiedName: vueQualifiedName(script, scope.qualifiedName),
        ...(scope.parentScopeId !== undefined
          ? { parentScopeId: vueScopeId(script, scope.parentScopeId, fileId) }
          : {}),
      })),
    decisions: facts.decisions.map((fact) => ({
      ...ranged(scoped(fact)),
      ...(fact.logicalGroupId !== undefined
        ? { logicalGroupId: `${script.context}:${fact.logicalGroupId}` }
        : {}),
    })),
    nestingEvents: facts.nestingEvents.map((fact) => ranged(scoped(fact))),
    operators: facts.operators.map((fact) => ranged(scoped(fact))),
    operands: facts.operands.map((fact) => ranged(scoped(fact))),
    nodeKinds: facts.nodeKinds.map(scoped),
    comments: facts.comments.map((range) => shiftVueRange(script, range)),
    identifiers: facts.identifiers.map((fact) => ranged(scoped(fact))),
    literals: facts.literals.map((fact) => ranged(scoped(fact))),
    parseDiagnostics: facts.parseDiagnostics.map(ranged),
  };
}
