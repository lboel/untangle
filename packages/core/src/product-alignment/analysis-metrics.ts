import {
  aggregateScopeTree,
  buildSymbolIR,
  checkAllScopeCoverage,
  computeCognitive,
  computeCyclomatic,
  computeStructural,
  containsRange,
  selectSymbolFacts,
  splitLines,
  withUniqueScopeIds,
} from "@untangle-code/complexity";
import type { ScopeMetricNodeV1, ScopeTreeAggregateV1 } from "@untangle-code/complexity";
import { COGNITIVE_ALGORITHM_ID, METRICS_VERSION, compareCodepoints } from "@untangle-code/domain";
import type {
  LanguageAdapter,
  ParsedAst,
  ProductCodeMetricsV1,
  ProductHotspotV1,
  ProductMetricReadingsV1,
  SourceRange,
} from "@untangle-code/domain";

const EXECUTION_UNIT_KINDS = new Set(["function", "method", "constructor", "lambda"]);

/** Internal pure measurement; it never selects only exports or retrieved fragments. */
export function measureParsedProductFile(
  adapter: LanguageAdapter,
  ast: ParsedAst,
  filePath: string,
  contentHash: string,
  text: string,
): { metrics: ProductCodeMetricsV1; hotspots: ProductHotspotV1[]; limitations: string[] } {
  const repaired = withUniqueScopeIds(
    adapter.computeComplexity(ast),
    adapter.extractCalls(ast),
    filePath,
  );
  const { facts, calls } = repaired;
  const cognitive: ScopeMetricNodeV1[] = [];
  const classic: ScopeMetricNodeV1[] = [];
  const extended: ScopeMetricNodeV1[] = [];
  const hotspots: ProductHotspotV1[] = [];

  if (facts.symbolScopes.length === 0) throw new Error("A code AST has no measurable scopes");
  for (const scope of facts.symbolScopes) {
    const id = scope.symbolScopeId;
    const inclusiveIr = buildSymbolIR(facts, id, { calls });
    const ownFacts = selectSymbolFacts(facts, id);
    const ownIr = buildSymbolIR(ownFacts, id, { calls });
    const inclusiveCognitive =
      inclusiveIr === undefined ? 0 : computeCognitive(inclusiveIr, COGNITIVE_ALGORITHM_ID).value;
    const ownCognitive =
      ownIr === undefined ? 0 : computeCognitive(ownIr, COGNITIVE_ALGORITHM_ID).value;
    const subtreeFacts = {
      ...facts,
      decisions: facts.decisions.filter((decision) => containsRange(scope.range, decision.range)),
    };
    const inclusiveCyclomatic = computeCyclomatic(
      subtreeFacts,
      scope.range.startLine,
      METRICS_VERSION,
    );
    const ownCyclomatic = computeCyclomatic(ownFacts, scope.range.startLine, METRICS_VERSION);
    const shared = {
      metricsScopeId: id,
      executionUnit: EXECUTION_UNIT_KINDS.has(scope.kind),
      ...(scope.parentScopeId === undefined ? {} : { parentScopeId: scope.parentScopeId }),
    };
    cognitive.push({ ...shared, inclusiveValue: inclusiveCognitive, selfValue: ownCognitive });
    classic.push({
      ...shared,
      inclusiveValue: inclusiveCyclomatic.classic,
      selfValue: ownCyclomatic.classic,
    });
    extended.push({
      ...shared,
      inclusiveValue: inclusiveCyclomatic.extended,
      selfValue: ownCyclomatic.extended,
    });
    if (shared.executionUnit)
      hotspots.push({
        path: filePath,
        contentHash,
        symbol: scope.qualifiedName || scope.name || `(${scope.kind})`,
        scopeId: id,
        startLine: scope.range.startLine,
        endLine: scope.range.endLine,
        cognitive: inclusiveCognitive,
        cyclomaticClassic: inclusiveCyclomatic.classic,
        cyclomaticExtended: inclusiveCyclomatic.extended,
      });
  }

  const cognitiveTotals = checkedTotals(cognitive, 0);
  const classicTotals = checkedTotals(classic, 1);
  const extendedTotals = checkedTotals(extended, 1);
  const range: SourceRange = {
    startLine: 1,
    endLine: splitLines(text).length,
    startByte: 0,
    endByte: Buffer.byteLength(text, "utf8"),
  };
  const sloc = computeStructural(facts, text, range).metrics["sloc"];
  if (sloc === undefined || !Number.isFinite(sloc) || sloc < 0)
    throw new Error("Invalid structural SLOC");
  return {
    metrics: {
      metricsVersion: METRICS_VERSION,
      cognitiveAlgorithm: COGNITIVE_ALGORITHM_ID,
      cognitive: readings(cognitiveTotals),
      cyclomaticClassic: readings(classicTotals),
      cyclomaticExtended: readings(extendedTotals),
      files: 1,
      scopes: cognitiveTotals.scopeCount,
      executionUnitRoots: cognitiveTotals.executionUnitRootCount,
      sloc,
      cyclomaticPerScopeBase: 1,
    },
    hotspots: hotspots.sort(compareProductHotspots),
    limitations:
      repaired.collisions.length === 0
        ? []
        : [
            `Source "${filePath}" had ${String(repaired.collisions.length)} colliding raw adapter scope IDs; byte-range identity repair preserved all scopes and post-repair metric and coverage checks passed.`,
          ],
  };
}

function checkedTotals(
  nodes: readonly ScopeMetricNodeV1[],
  perScopeBase: number,
): ScopeTreeAggregateV1 {
  if (
    nodes.some((node) => !Number.isFinite(node.inclusiveValue) || !Number.isFinite(node.selfValue))
  )
    throw new Error("Non-finite scope metric");
  const totals = aggregateScopeTree(nodes, { perScopeBase });
  if (totals.duplicatesDropped > 0 || checkAllScopeCoverage(nodes).length > 0)
    throw new Error("Invalid scope identity or coverage");
  return totals;
}

function readings(totals: ScopeTreeAggregateV1): ProductMetricReadingsV1 {
  return {
    top_level: totals.topLevelSum,
    execution_unit: totals.executionUnitSum,
    self: totals.selfSum,
  };
}

export function compareProductHotspots(left: ProductHotspotV1, right: ProductHotspotV1): number {
  return (
    right.cognitive - left.cognitive ||
    right.cyclomaticExtended - left.cyclomaticExtended ||
    compareCodepoints(left.path, right.path) ||
    left.startLine - right.startLine ||
    compareCodepoints(left.scopeId, right.scopeId)
  );
}

export function emptyProductMetrics(): ProductCodeMetricsV1 {
  return {
    metricsVersion: METRICS_VERSION,
    cognitiveAlgorithm: COGNITIVE_ALGORITHM_ID,
    cognitive: { top_level: 0, execution_unit: 0, self: 0 },
    cyclomaticClassic: { top_level: 0, execution_unit: 0, self: 0 },
    cyclomaticExtended: { top_level: 0, execution_unit: 0, self: 0 },
    files: 0,
    scopes: 0,
    executionUnitRoots: 0,
    sloc: 0,
    cyclomaticPerScopeBase: 1,
  };
}

export function addProductMetrics(
  total: ProductCodeMetricsV1,
  metrics: ProductCodeMetricsV1,
): void {
  for (const reading of ["top_level", "execution_unit", "self"] as const) {
    total.cognitive[reading] += metrics.cognitive[reading];
    total.cyclomaticClassic[reading] += metrics.cyclomaticClassic[reading];
    total.cyclomaticExtended[reading] += metrics.cyclomaticExtended[reading];
  }
  total.files += metrics.files;
  total.scopes += metrics.scopes;
  total.executionUnitRoots += metrics.executionUnitRoots;
  total.sloc += metrics.sloc;
}
