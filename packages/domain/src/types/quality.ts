/**
 * Quality gate contracts (spec.md §18).
 */

/** Gate status (spec.md §18.2). */
export type QualityGateStatus = "passed" | "warning" | "failed" | "incomplete";

/**
 * A single gate violation (shape: Untangle decision; spec.md §18.2 references
 * the type without defining it). Delta-first semantics (spec.md §18.1) are
 * encoded in `newViolation`/`worsened`.
 */
export interface QualityViolationV1 {
  /** Policy rule key, e.g. "cognitivePerSymbolMax", "newCyclesAllowed". */
  rule: string;
  severity: "warning" | "error";
  scope: "symbol" | "file" | "workspace";
  scopeId: string;
  filePath?: string;
  symbolId?: string;
  symbolFqn?: string;
  /** Metric key the rule evaluated, when metric-based. */
  metric?: string;
  baseValue?: number;
  headValue?: number;
  threshold?: number;
  /** True: introduced by this change; false: pre-existing violation that worsened. */
  newViolation: boolean;
  /** True when an existing violation got worse (only meaningful with newViolation=false). */
  worsened: boolean;
  message: string;
}

/** A measurable improvement surfaced alongside violations (spec.md §18.2). */
export interface QualityImprovementV1 {
  rule: string;
  scope: "symbol" | "file" | "workspace";
  scopeId: string;
  filePath?: string;
  symbolId?: string;
  symbolFqn?: string;
  metric?: string;
  baseValue?: number;
  headValue?: number;
  message: string;
}

/** Quality gate result (spec.md §18.2) — exact spec shape. */
export interface QualityGateResultV1 {
  status: QualityGateStatus;
  /** Base revision descriptor (ref or commit). */
  base: string;
  head: string;
  violations: QualityViolationV1[];
  improvements: QualityImprovementV1[];
  analysisCoverage: {
    filesChanged: number;
    filesAnalyzed: number;
    symbolsChanged: number;
    parseFailures: number;
  };
}
