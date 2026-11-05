import { INDEX_JOB_STAGES, isUntangleError, type IndexJobStage } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import {
  JOB_PIPELINE_STAGES,
  JobStateMachine,
  canTransition,
  isTerminalJobStage,
  pipelineIndexOf,
} from "./state-machine.js";

/** The complete allowed-transition relation of spec.md §11.1, spelled out. */
function expectedAllowed(from: IndexJobStage, to: IndexJobStage): boolean {
  if (from === to) {
    return false;
  }
  if (from === "completed" || from === "failed" || from === "cancelled") {
    return false;
  }
  if (from === "cancel_requested") {
    return to === "cancelled" || to === "failed";
  }
  if (to === "failed" || to === "cancel_requested") {
    return true;
  }
  const chain = JOB_PIPELINE_STAGES;
  return (
    chain.indexOf(to) === chain.indexOf(from) + 1 && chain.includes(from) && chain.includes(to)
  );
}

describe("canTransition", () => {
  it("matches the spec.md §11.1 relation for every ordered stage pair", () => {
    for (const from of INDEX_JOB_STAGES) {
      for (const to of INDEX_JOB_STAGES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expectedAllowed(from, to));
      }
    }
  });

  it("allows the full pipeline chain in order", () => {
    for (let index = 0; index < JOB_PIPELINE_STAGES.length - 1; index += 1) {
      const from = JOB_PIPELINE_STAGES[index] as IndexJobStage;
      const to = JOB_PIPELINE_STAGES[index + 1] as IndexJobStage;
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it("rejects skipping a pipeline stage", () => {
    expect(canTransition("queued", "discovering_files")).toBe(false);
    expect(canTransition("embedding", "checkpointing")).toBe(false);
    expect(canTransition("discovering_files", "completed")).toBe(false);
  });

  it("rejects moving backwards", () => {
    expect(canTransition("storing", "embedding")).toBe(false);
    expect(canTransition("completed", "queued")).toBe(false);
  });

  it("treats completed, failed and cancelled as terminal", () => {
    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      expect(isTerminalJobStage(terminal)).toBe(true);
      for (const to of INDEX_JOB_STAGES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it("routes cancel_requested only to cancelled or failed", () => {
    expect(canTransition("cancel_requested", "cancelled")).toBe(true);
    expect(canTransition("cancel_requested", "failed")).toBe(true);
    expect(canTransition("cancel_requested", "queued")).toBe(false);
    expect(canTransition("cancel_requested", "storing")).toBe(false);
  });
});

describe("JobStateMachine", () => {
  it("starts in queued and walks the whole pipeline to completed", () => {
    const machine = new JobStateMachine();
    expect(machine.stage).toBe("queued");
    for (const stage of JOB_PIPELINE_STAGES.slice(1)) {
      machine.transition(stage);
      expect(machine.stage).toBe(stage);
    }
    expect(machine.stage).toBe("completed");
  });

  it("REJECTS an illegal transition with a typed error instead of ignoring it", () => {
    const machine = new JobStateMachine();
    let caught: unknown;
    try {
      machine.transition("embedding");
    } catch (error) {
      caught = error;
    }
    expect(isUntangleError(caught)).toBe(true);
    if (isUntangleError(caught)) {
      expect(caught.code).toBe("INDEX_INCOMPLETE");
      expect(caught.context).toMatchObject({ from: "queued", to: "embedding" });
    }
    // The rejected transition must not have mutated the machine.
    expect(machine.stage).toBe("queued");
  });

  it("supports cancellation from any non-terminal pipeline stage", () => {
    const machine = new JobStateMachine();
    machine.transition("preparing_infrastructure");
    machine.transition("discovering_files");
    machine.transition("cancel_requested");
    machine.transition("cancelled");
    expect(machine.stage).toBe("cancelled");
    expect(() => machine.transition("queued")).toThrow();
  });

  it("supports failure from every non-terminal stage", () => {
    for (const from of INDEX_JOB_STAGES) {
      if (isTerminalJobStage(from)) {
        continue;
      }
      const machine = new JobStateMachine(from);
      machine.transition("failed");
      expect(machine.stage).toBe("failed");
    }
  });

  it("advanceTo walks forward one legal step at a time and no-ops backwards", () => {
    const machine = new JobStateMachine();
    machine.advanceTo("embedding");
    expect(machine.stage).toBe("embedding");
    machine.advanceTo("embedding");
    expect(machine.stage).toBe("embedding");
    machine.advanceTo("parsing_and_chunking");
    expect(machine.stage).toBe("embedding");
    machine.advanceTo("completed");
    expect(machine.stage).toBe("completed");
  });

  it("advanceTo rejects error-state targets", () => {
    const machine = new JobStateMachine();
    expect(() => machine.advanceTo("failed")).toThrow();
    expect(() => machine.advanceTo("cancelled")).toThrow();
  });

  it("pipelineIndexOf places error states outside the pipeline", () => {
    expect(pipelineIndexOf("queued")).toBe(0);
    expect(pipelineIndexOf("completed")).toBe(JOB_PIPELINE_STAGES.length - 1);
    expect(pipelineIndexOf("failed")).toBeNull();
    expect(pipelineIndexOf("cancel_requested")).toBeNull();
    expect(pipelineIndexOf("cancelled")).toBeNull();
  });
});
