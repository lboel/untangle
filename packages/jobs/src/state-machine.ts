/**
 * Full-index job state machine — exactly the stages and transitions of
 * spec.md §11.1, including the error states `failed`, `cancel_requested`
 * and `cancelled`. Illegal transitions are REJECTED with a typed error,
 * never silently ignored.
 */
import { INDEX_JOB_STAGES, type IndexJobStage } from "@untangle-code/domain";
import { indexIncompleteError } from "@untangle-code/observability";

/**
 * The linear pipeline chain of spec.md §11.1 (`queued` → … → `completed`).
 * Derived from domain's `INDEX_JOB_STAGES` (the first twelve entries are the
 * pipeline in order; the last three are the error states).
 */
export const JOB_PIPELINE_STAGES: readonly IndexJobStage[] = INDEX_JOB_STAGES.slice(
  0,
  INDEX_JOB_STAGES.indexOf("completed") + 1,
);

/** Terminal stages: no transition leaves them. */
export const TERMINAL_JOB_STAGES: readonly IndexJobStage[] = ["completed", "failed", "cancelled"];

/** True when `stage` is terminal (`completed`, `failed` or `cancelled`). */
export function isTerminalJobStage(stage: IndexJobStage): boolean {
  return TERMINAL_JOB_STAGES.includes(stage);
}

const PIPELINE_INDEX: ReadonlyMap<IndexJobStage, number> = new Map(
  JOB_PIPELINE_STAGES.map((stage, index) => [stage, index]),
);

/** Index of `stage` in the pipeline chain, or null for the error states. */
export function pipelineIndexOf(stage: IndexJobStage): number | null {
  return PIPELINE_INDEX.get(stage) ?? null;
}

/**
 * Pure transition rule of spec.md §11.1:
 *
 * - along the pipeline chain, only the single next stage is reachable;
 * - `failed` and `cancel_requested` are reachable from every non-terminal
 *   pipeline stage;
 * - `cancel_requested` may only move to `cancelled` (or `failed`, when the
 *   cancellation cleanup itself fails);
 * - `completed`, `failed` and `cancelled` are terminal;
 * - self-transitions are not transitions.
 */
export function canTransition(from: IndexJobStage, to: IndexJobStage): boolean {
  if (from === to) {
    return false;
  }
  if (isTerminalJobStage(from)) {
    return false;
  }
  if (from === "cancel_requested") {
    return to === "cancelled" || to === "failed";
  }
  // `from` is now a non-terminal pipeline stage.
  if (to === "failed" || to === "cancel_requested") {
    return true;
  }
  const fromIndex = pipelineIndexOf(from);
  const toIndex = pipelineIndexOf(to);
  return fromIndex !== null && toIndex !== null && toIndex === fromIndex + 1;
}

/**
 * Mutable job stage holder enforcing spec.md §11.1. An illegal transition
 * throws `UntangleError` with code `INDEX_INCOMPLETE` (the job would be left
 * in an inconsistent state) — it never mutates and is never ignored.
 */
export class JobStateMachine {
  #stage: IndexJobStage;

  public constructor(initial: IndexJobStage = "queued") {
    if (!INDEX_JOB_STAGES.includes(initial)) {
      throw indexIncompleteError(`unknown job stage "${initial}"`, {
        retryable: false,
        operation: "job_stage_transition",
        context: { stage: initial },
      });
    }
    this.#stage = initial;
  }

  public get stage(): IndexJobStage {
    return this.#stage;
  }

  /** Applies one legal transition or throws; never a silent no-op. */
  public transition(to: IndexJobStage): void {
    if (!canTransition(this.#stage, to)) {
      throw indexIncompleteError(`illegal job stage transition "${this.#stage}" -> "${to}"`, {
        retryable: false,
        operation: "job_stage_transition",
        context: { from: this.#stage, to },
      });
    }
    this.#stage = to;
  }

  /**
   * Walks the pipeline chain forward, one legal transition at a time, until
   * `target` is reached. A `target` at or before the current stage is a
   * no-op (used for stage high-water marks in the concurrent pipeline,
   * see README "Entscheidungen"). Throws when the machine is in an error
   * state or `target` is not a pipeline stage.
   */
  public advanceTo(target: IndexJobStage): void {
    const targetIndex = pipelineIndexOf(target);
    const currentIndex = pipelineIndexOf(this.#stage);
    if (targetIndex === null || currentIndex === null) {
      throw indexIncompleteError(
        `cannot advance from "${this.#stage}" to "${target}": not a pipeline stage`,
        {
          retryable: false,
          operation: "job_stage_transition",
          context: { from: this.#stage, to: target },
        },
      );
    }
    if (targetIndex <= currentIndex) {
      return;
    }
    for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
      const next = JOB_PIPELINE_STAGES[index];
      if (next !== undefined) {
        this.transition(next);
      }
    }
  }
}
