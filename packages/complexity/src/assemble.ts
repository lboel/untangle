/**
 * Folds calculator outputs into the domain-stored `ComplexitySnapshotV1`
 * shape (spec.md §16, architecture.md §10.5). Pure function of its inputs —
 * `measuredAt`/`snapshotId` etc. are supplied by the caller (who owns the
 * `Clock`/`Random`/identity ports); this package never calls `Date.now()` or
 * generates ids itself.
 *
 * Mapping decisions (README "Entscheidungen" #2):
 * - `cyclomatic.contributors` takes the calculator's superset contribution
 *   list as-is (each `CyclomaticContribution` is structurally a
 *   `MetricContribution` plus the two membership flags, which are dropped —
 *   TypeScript's structural typing lets extra fields pass through, but they
 *   are stripped explicitly here so the stored payload never leaks
 *   calculator-internal fields).
 * - `cognitive.contributors` stores the calculator's
 *   `CognitiveContributionV1[]` UNCHANGED: spec.md §16.4 requires every
 *   persisted contribution to carry source position, kind, base and nesting
 *   share as structured fields ("jeder Beitrag MUSS Quellposition, Art,
 *   Basis und Nesting-Anteil enthalten"), so `ComplexitySnapshotV1` keeps
 *   the full shape instead of flattening `base`/`nestingPenalty` into a
 *   free-text note.
 * - `maintainabilityFormula` records the exact formula string the
 *   maintainability calculator used (spec.md §16.9: "Untangle MUSS die
 *   verwendete Formel explizit ausgeben").
 */
import type {
  ComplexityScope,
  ComplexitySnapshotV1,
  MetricContribution,
  ParseQuality,
} from "@untangle-code/domain";

import type { CognitiveResult, CyclomaticResult, MaintainabilityResult } from "./types.js";

export interface SnapshotContext {
  snapshotId: string;
  scope: ComplexityScope;
  scopeId: string;
  repoId: string;
  refId: string;
  commitSha?: string;
  metricsVersion: string;
  /** ISO-8601, obtained by the caller via the `Clock` port. */
  measuredAt: string;
  parseQuality: ParseQuality;
}

export interface SnapshotParts {
  cyclomatic: CyclomaticResult;
  cognitive: CognitiveResult;
  structural: Record<string, number>;
  textual: Record<string, number>;
  syntactic: Record<string, number>;
  halstead: Record<string, number>;
  maintainability: MaintainabilityResult;
}

function toMetricContribution(
  line: number,
  kind: string,
  value: number,
  note?: string,
): MetricContribution {
  const contribution: MetricContribution = { line, kind, value };
  if (note !== undefined) contribution.note = note;
  return contribution;
}

export function assembleComplexitySnapshot(
  context: SnapshotContext,
  parts: SnapshotParts,
): ComplexitySnapshotV1 {
  const snapshot: ComplexitySnapshotV1 = {
    snapshotId: context.snapshotId,
    scope: context.scope,
    scopeId: context.scopeId,
    repoId: context.repoId,
    refId: context.refId,
    metricsVersion: context.metricsVersion,
    measuredAt: context.measuredAt,
    parseQuality: context.parseQuality,
    cyclomatic: {
      classic: parts.cyclomatic.classic,
      extended: parts.cyclomatic.extended,
      contributors: parts.cyclomatic.contributions.map((c) =>
        toMetricContribution(c.line, c.kind, c.value, c.note),
      ),
    },
    cognitive: {
      value: parts.cognitive.value,
      algorithm: parts.cognitive.algorithm as ComplexitySnapshotV1["cognitive"]["algorithm"],
      // Stored structurally, spec.md §16.4 (base/nestingPenalty/total are
      // required fields of every persisted contribution). Copied so the
      // snapshot never aliases the calculator's arrays.
      contributors: parts.cognitive.contributions.map((c) => ({ ...c })),
    },
    structural: parts.structural,
    textual: parts.textual,
    syntactic: parts.syntactic,
    halstead: parts.halstead,
    maintainabilityIndex: parts.maintainability.value,
    // spec.md §16.9: the formula actually used MUST be output explicitly.
    maintainabilityFormula: parts.maintainability.formula,
  };
  if (context.commitSha !== undefined) {
    snapshot.commitSha = context.commitSha;
  }
  return snapshot;
}
