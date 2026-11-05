/**
 * @untangle-code/jobs — the job core of the Untangle indexer
 * (spec.md §11, §12.2; architecture.md §2.2, §6.14, §13, §21.3–§21.4).
 *
 * Pipeline MECHANICS only: the exact spec.md §11.1 state machine, typed job
 * events as `AsyncIterable`, a checkpoint store (`IndexCheckpointV1`,
 * checkpoints only after confirmed upserts), resume planning, generation
 * commit per §13.4, bounded queues with backpressure and a visible memory
 * budget, and `AbortSignal` cancellation at safe batch boundaries. The
 * domain-specific stages (scanner, parser, chunker, embedder, stores) are
 * injected behind narrow interfaces. This module is the ONLY public export
 * of the package.
 */

// Abort helpers (spec.md §22).
export * from "./abort.js";

// State machine (spec.md §11.1).
export * from "./state-machine.js";

// Async event channel (architecture.md §2.2).
export * from "./events.js";

// Bounded queues with backpressure (architecture.md §13.2).
export * from "./bounded-queue.js";

// Injected stage interfaces (architecture.md §13.1).
export * from "./stages.js";

// Checkpoint store (architecture.md §13.3; spec.md §10.5).
export * from "./checkpoint-store.js";

// Resume planning (spec.md §11.2).
export * from "./resume.js";

// Index job runner (spec.md §11; architecture.md §13.4, §21.3).
export * from "./runner.js";
