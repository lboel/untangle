/**
 * Index job runner — the pipeline MECHANICS of spec.md §11 and
 * architecture.md §13:
 *
 * - drives the exact state machine of spec.md §11.1 (`JobStateMachine`);
 * - emits the typed job events of architecture.md §2.2 as an
 *   `AsyncIterable<JobEvent>` (spec.md §22);
 * - connects the injected stages with bounded queues so a full queue pauses
 *   the previous stage (backpressure, §13.2) under a configurable, visible
 *   memory budget;
 * - persists an `IndexCheckpointV1` ONLY after a confirmed upsert
 *   (spec.md §10.5, §13.3), one per file batch (spec.md §11.2);
 * - resumes from the last confirmed checkpoint without repeating confirmed
 *   work (spec.md §11.2);
 * - cancels via `AbortSignal` at safe batch boundaries only: checkpoint
 *   saved, then `cancelled` (architecture.md §21.3);
 * - commits the generation per §13.4 — `completed` is only reported when
 *   all planned file operations are confirmed, checkpoints are saved, the
 *   required graphs are stored and the metadata reached its final status
 *   (enforced through domain's `assertGenerationComplete`).
 */
import type {
  CheckpointStorePort,
  Clock,
  IndexCheckpointV1,
  IndexJobStage,
  JobEvent,
  LockHandle,
  LockProvider,
  LoggerPort,
  Random,
} from "@untangle-code/domain";
import {
  UntangleError,
  assertGenerationComplete,
  buildCorpusRevisionFingerprint,
  isUntangleError,
  validateGenerationCompleteness,
} from "@untangle-code/domain";
import { configInvalidError, indexIncompleteError } from "@untangle-code/observability";

import { isJobCancelledError, throwIfAborted } from "./abort.js";
import { BoundedQueue, type OverBudgetAdmissionV1, type QueueStatsV1 } from "./bounded-queue.js";
import { AsyncEventChannel } from "./events.js";
import type { ResumeIdentityV1 } from "./resume.js";
import { planResume } from "./resume.js";
import type { AnalyzedFileV1, EmbeddedBatchV1, IndexJobStages, PlannedFileV1 } from "./stages.js";
import { JobStateMachine } from "./state-machine.js";

/** Identity of the ref this job indexes. */
export type IndexJobIdentityV1 = ResumeIdentityV1;

export interface IndexJobQueueCapacities {
  /** Analyzed-file queue capacity (items). Default 16. */
  analysis?: number;
  /** Embedded-batch queue capacity (items). Default 4. */
  upsert?: number;
}

export interface IndexJobRunnerOptions {
  identity: IndexJobIdentityV1;
  stages: IndexJobStages;
  checkpointStore: CheckpointStorePort;
  clock: Clock;
  random: Random;
  logger?: LoggerPort;
  /** When given, the job holds `repo:<repoId>:<refId>:index` while running. */
  lockProvider?: LockProvider;
  /**
   * Duration of the index-lock lease. While the job is active, the runner
   * renews it with a non-overlapping heartbeat at most one third this long.
   * Default 30 seconds; must be a safe integer >= 3 milliseconds.
   */
  lockLeaseMs?: number;
  /** Job id; defaults to `random.uuid()`. */
  jobId?: string;
  /** Generation id for a FRESH run; a resumed run keeps the checkpoint's. */
  generationId?: string;
  /**
   * Awaited immediately after the generation is chosen and before any
   * analysis, graph, checkpoint, or index mutation starts. Adapters use this
   * boundary to persist a durable `running` marker; rejection fails the job
   * before the pipeline can mutate the index.
   */
  onGenerationStarted?: (generationId: string) => Promise<void>;
  /**
   * Runs for a terminal outcome only after a final owner-checked lease renewal
   * and before release. A detected ownership loss suppresses it. Adapters should serialize and
   * generation-CAS any repo-wide singleton state they replace. Completed
   * outcomes include an immutable fingerprint of the full discovered corpus;
   * terminal failures deliberately do not.
   */
  onGenerationFinished?: (
    generationId: string,
    outcome: "completed" | "cancelled" | "failed",
    corpusRevisionFingerprint?: string,
  ) => Promise<void>;
  /** Graphs the generation must store to complete. Default ["file","symbol"]. */
  requiredGraphs?: readonly ("file" | "symbol")[];
  /** Files per embedding batch (also the checkpoint batch). Default 8. */
  embedBatchSize?: number;
  queueCapacities?: IndexJobQueueCapacities;
  /**
   * Byte budget shared by the pipeline queues (architecture.md §13.2),
   * split evenly between them; visible in `status()`. Default 64 MiB.
   */
  memoryBudgetBytes?: number;
  /** Set false to ignore existing checkpoints and start fresh. Default true. */
  resume?: boolean;
}

/** Live job status (architecture.md §13.2: budget visible in status output). */
export interface JobStatusV1 {
  jobId: string;
  generationId: string | null;
  stage: IndexJobStage;
  filesPlanned: number;
  filesCompleted: number;
  memoryBudgetBytes: number;
  queuedBytes: number;
  queues: { analysis: QueueStatsV1; upsert: QueueStatsV1 } | null;
}

const DEFAULT_MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;
const DEFAULT_EMBED_BATCH_SIZE = 8;
const DEFAULT_ANALYSIS_CAPACITY = 16;
const DEFAULT_UPSERT_CAPACITY = 4;
const DEFAULT_LOCK_LEASE_MS = 30_000;
const MIN_LOCK_LEASE_MS = 3;
/**
 * Kleinstes zulaessiges Gesamtbudget. Das Budget wird haelftig auf beide
 * Queues verteilt (`Math.floor(budget / 2)`), also muss es mindestens 2
 * Bytes betragen, damit beide Haelften positiv sind. Bewusst KEINE hoehere,
 * gegriffene Schwelle: ein knappes Budget ist eine legitime Testkonfiguration
 * — dass es die Byte-Grenze nicht mehr abschaltet, sichert seit WP-116 die
 * `BoundedQueue` selbst, nicht eine Mindestzahl hier.
 */
const MIN_MEMORY_BUDGET_BYTES = 2;

interface PipelineQueues {
  analysis: BoundedQueue<AnalyzedFileV1>;
  upsert: BoundedQueue<EmbeddedBatchV1>;
}

interface IndexLockHeartbeat {
  readonly failure: UntangleError | null;
  /** Stops periodic renewal and waits for an already-running renewal. */
  stop(): Promise<void>;
  /** Stops the heartbeat, then proves ownership once more for terminal publication. */
  assertOwnership(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lockRenewalError(lock: LockHandle, error: unknown): UntangleError {
  return new UntangleError(
    "LOCK_HELD",
    `Index lock "${lock.key}" could not be renewed; exclusive ownership is no longer proven: ${errorMessage(error)}`,
    {
      retryable: true,
      operation: "index_lock_renew",
      context: {
        key: lock.key,
        processInstanceId: lock.record.processInstanceId,
      },
      cause: error,
    },
  );
}

/**
 * Keeps one lease alive without ever issuing overlapping `renew()` calls.
 * A failed renewal aborts the job immediately; `assertOwnership()` repeats
 * the ownership check after the heartbeat has stopped. A runner whose lease
 * loss was observed does not invoke the terminal-generation observer.
 */
function startIndexLockHeartbeat(
  lock: LockHandle,
  leaseMs: number,
  internal: AbortController,
  onFailure: (error: UntangleError) => void,
): IndexLockHeartbeat {
  const intervalMs = Math.max(1, Math.floor(leaseMs / 3));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let failure: UntangleError | null = null;

  const fail = (error: unknown): UntangleError => {
    if (failure === null) {
      failure = lockRenewalError(lock, error);
      onFailure(failure);
      internal.abort();
    }
    return failure;
  };

  const schedule = (): void => {
    if (stopped || failure !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped || failure !== null) return;
      inFlight = lock
        .renew()
        .catch((error: unknown) => {
          fail(error);
        })
        .finally(() => {
          inFlight = null;
          schedule();
        });
    }, intervalMs);
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await inFlight;
  };

  schedule();
  return {
    get failure() {
      return failure;
    },
    stop,
    assertOwnership: async (): Promise<void> => {
      await stop();
      if (failure !== null) throw failure;
      try {
        await lock.renew();
      } catch (error) {
        throw fail(error);
      }
    },
  };
}

export class IndexJobRunner {
  private readonly options: IndexJobRunnerOptions;
  private readonly machine = new JobStateMachine("queued");
  private readonly jobId: string;
  private generationId: string | null = null;
  private readonly completedFiles = new Set<string>();
  private storedPointIdsByFile: Record<string, string[]> = {};
  private manifestHashes: Record<string, string> = {};
  private corpusManifestHashes: Record<string, string> | null = null;
  private filesPlanned = 0;
  private queues: PipelineQueues | null = null;
  private lastQueueStats: { analysis: QueueStatsV1; upsert: QueueStatsV1 } | null = null;
  private started = false;

  public constructor(options: IndexJobRunnerOptions) {
    IndexJobRunner.validateResourceOptions(options);
    this.options = options;
    this.jobId = options.jobId ?? options.random.uuid();
  }

  /**
   * Prueft die Ressourcen-Optionen am EINGANG des Jobs — dort, wo sie ein
   * Aufrufer setzt, nicht erst tief in der Pipeline.
   *
   * WP-116: `queueCapacities` und `memoryBudgetBytes` sind frei
   * konfigurierbar und entscheiden zusammen darueber, ob die Byte-Grenze der
   * Queues ueberhaupt greifen kann. Die Haertung aus WP-79 sitzt im
   * `BoundedQueue`-Konstruktor und damit erst in `runPipeline()` — ein
   * fehlerhafter Wert faellt dort mitten im Lauf auf, nachdem der Job
   * bereits Lock, Generation und Checkpoints angefasst hat. Hier scheitert
   * er, bevor irgendetwas passiert ist.
   */
  private static validateResourceOptions(options: IndexJobRunnerOptions): void {
    const capacities: readonly (readonly [string, number | undefined])[] = [
      ["queueCapacities.analysis", options.queueCapacities?.analysis],
      ["queueCapacities.upsert", options.queueCapacities?.upsert],
      ["embedBatchSize", options.embedBatchSize],
      ["lockLeaseMs", options.lockLeaseMs],
    ];
    for (const [field, value] of capacities) {
      if (value === undefined) {
        continue;
      }
      const minimum = field === "lockLeaseMs" ? MIN_LOCK_LEASE_MS : 1;
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw configInvalidError(
          `IndexJobRunner ${field} must be a safe integer >= ${String(minimum)}, got ${String(value)}`,
          {
            retryable: false,
            operation: "index_job_options",
            context: { field, value, minimum },
          },
        );
      }
    }
    const budget = options.memoryBudgetBytes;
    if (budget === undefined) {
      return;
    }
    if (!Number.isSafeInteger(budget) || budget < MIN_MEMORY_BUDGET_BYTES) {
      throw configInvalidError(
        `IndexJobRunner memoryBudgetBytes must be a safe integer >= ${String(
          MIN_MEMORY_BUDGET_BYTES,
        )}, got ${String(budget)} — the budget is split evenly across the two pipeline queues ` +
          "and a non-integer/non-finite budget would disable their byte bound " +
          "(architecture.md §13.2)",
        {
          retryable: false,
          operation: "index_job_options",
          context: { field: "memoryBudgetBytes", value: budget, minimum: MIN_MEMORY_BUDGET_BYTES },
        },
      );
    }
  }

  public status(): JobStatusV1 {
    const queues =
      this.queues !== null
        ? { analysis: this.queues.analysis.stats(), upsert: this.queues.upsert.stats() }
        : this.lastQueueStats;
    return {
      jobId: this.jobId,
      generationId: this.generationId,
      stage: this.machine.stage,
      filesPlanned: this.filesPlanned,
      filesCompleted: this.completedFiles.size,
      memoryBudgetBytes: this.options.memoryBudgetBytes ?? DEFAULT_MEMORY_BUDGET_BYTES,
      queuedBytes: queues === null ? 0 : queues.analysis.bytes + queues.upsert.bytes,
      queues,
    };
  }

  /**
   * Runs the job once. Cold: work starts when iteration starts. The stream
   * always ends with exactly one terminal event — `job_completed`,
   * `job_failed` or `job_cancelled` — and never throws for job-level
   * failures (they ARE the `job_failed` event).
   */
  public run(options: { signal?: AbortSignal } = {}): AsyncIterable<JobEvent> {
    if (this.started) {
      throw new Error("IndexJobRunner.run() may only be called once per runner");
    }
    this.started = true;
    const channel = new AsyncEventChannel<JobEvent>();
    const internal = new AbortController();
    const external = options.signal;
    if (external !== undefined) {
      if (external.aborted) {
        internal.abort();
      } else {
        external.addEventListener("abort", () => internal.abort(), {
          once: true,
          signal: internal.signal,
        });
      }
    }

    let driver: Promise<void> | null = null;
    const start = (): Promise<void> =>
      this.drive(channel, external, internal).then(
        () => channel.close(),
        (error) => channel.fail(error),
      );

    return {
      [Symbol.asyncIterator]() {
        driver ??= start();
        const iterator = channel[Symbol.asyncIterator]();
        const startedDriver = driver;
        return {
          next: () => iterator.next(),
          async return(value?: unknown): Promise<IteratorResult<JobEvent>> {
            // Consumer abandoned the stream: stop the pipeline, await the
            // driver so no orphaned worker keeps running.
            internal.abort();
            await startedDriver.catch(() => undefined);
            return { done: true, value: value as JobEvent };
          },
        };
      },
    };
  }

  // -- driver ---------------------------------------------------------------

  private async drive(
    channel: AsyncEventChannel<JobEvent>,
    external: AbortSignal | undefined,
    internal: AbortController,
  ): Promise<void> {
    const { clock, stages, identity } = this.options;
    const startedAtMs = clock.nowEpochMs();
    const signal = internal.signal;
    const emit = (event: JobEvent): void => channel.emit(event);
    const base = (): { jobId: string; workspaceId: string; occurredAt: string } & {
      generationId?: string;
    } => ({
      jobId: this.jobId,
      workspaceId: identity.workspaceId,
      occurredAt: clock.nowIso(),
      ...(this.generationId !== null ? { generationId: this.generationId } : {}),
    });

    let lock: LockHandle | null = null;
    let lockHeartbeat: IndexLockHeartbeat | null = null;
    const notifyGenerationFinished = async (
      outcome: "completed" | "cancelled" | "failed",
    ): Promise<void> => {
      if (this.generationId === null || this.options.onGenerationFinished === undefined) return;
      try {
        const corpusRevisionFingerprint =
          outcome === "completed" && this.corpusManifestHashes !== null
            ? buildCorpusRevisionFingerprint(this.corpusManifestHashes)
            : undefined;
        await this.options.onGenerationFinished(
          this.generationId,
          outcome,
          corpusRevisionFingerprint,
        );
      } catch (error) {
        // Terminal state publication is an adapter concern. The index outcome
        // itself is already decided, and the preceding running marker remains
        // conservative if this observer fails.
        this.options.logger?.log({
          timestamp: clock.nowIso(),
          level: "warn",
          component: "jobs.index",
          event: "generation_terminal_observer_failed",
          jobId: this.jobId,
          context: {
            generationId: this.generationId,
            outcome,
            message: errorMessage(error),
          },
        });
      }
    };
    try {
      emit({ kind: "job_queued", operation: "index", ...base() });

      if (this.options.lockProvider !== undefined) {
        lock = await this.options.lockProvider.acquire(
          `repo:${identity.repoId}:${identity.refId}:index`,
          { signal, leaseMs: this.options.lockLeaseMs ?? DEFAULT_LOCK_LEASE_MS },
        );
        lockHeartbeat = startIndexLockHeartbeat(
          lock,
          this.options.lockLeaseMs ?? DEFAULT_LOCK_LEASE_MS,
          internal,
          (error) => {
            this.options.logger?.log({
              timestamp: clock.nowIso(),
              level: "error",
              component: "jobs.index",
              event: "index_lock_renew_failed",
              jobId: this.jobId,
              context: { key: lock?.key ?? "", message: error.message },
            });
          },
        );
      }

      throwIfAborted(external, "index_job");
      this.machine.transition("preparing_infrastructure");
      const infrastructure = await stages.infrastructure.ensureReady({ signal });
      emit({ kind: "infrastructure_ready", endpoints: infrastructure.endpoints, ...base() });

      throwIfAborted(external, "index_job");
      this.machine.transition("discovering_files");
      const discovery = await stages.discovery.discover({ signal });
      this.corpusManifestHashes = { ...discovery.corpusManifestHashes };
      const checkpoint =
        this.options.resume === false
          ? null
          : await this.options.checkpointStore.loadLatest(identity.repoId, identity.refId, {
              signal,
            });
      const plan = planResume(discovery.planned, checkpoint, identity);
      this.generationId =
        plan.resumed && plan.generationId !== null
          ? plan.generationId
          : (this.options.generationId ?? this.options.random.uuid());
      await this.options.onGenerationStarted?.(this.generationId);
      for (const fileId of plan.completedFiles) {
        this.completedFiles.add(fileId);
      }
      this.storedPointIdsByFile = { ...plan.storedPointIdsByFile };
      this.manifestHashes = { ...plan.manifestHashes };
      this.filesPlanned = discovery.planned.length;
      emit({
        kind: "files_discovered",
        repoId: identity.repoId,
        refId: identity.refId,
        totalFiles: discovery.totalFiles,
        changedFiles: plan.remaining.length,
        unchangedFiles: discovery.unchangedFiles + plan.skippedCompleted,
        ignoredFiles: discovery.ignoredFiles,
        ...base(),
      });

      throwIfAborted(external, "index_job");
      this.machine.transition("parsing_and_chunking");
      await this.runPipeline(plan.remaining, emit, base, signal);

      throwIfAborted(external, "index_job");
      this.machine.advanceTo("building_graphs");
      const graphResults = await stages.graphs.buildGraphs({ signal });
      for (const result of graphResults) {
        emit({
          kind: "graph_updated",
          graph: result.graph,
          nodeCount: result.nodeCount,
          edgeCount: result.edgeCount,
          ...base(),
        });
      }

      throwIfAborted(external, "index_job");
      this.machine.advanceTo("indexing_context");
      if (stages.context !== undefined) {
        await stages.context.indexContext({ signal });
      }

      throwIfAborted(external, "index_job");
      this.machine.advanceTo("finalizing");
      await this.saveCheckpoint({ signal });
      emit({
        kind: "checkpoint_saved",
        stage: this.machine.stage,
        completedFileCount: this.completedFiles.size,
        ...base(),
      });

      // Generation commit (architecture.md §13.4). Pre-check everything the
      // runner can prove BEFORE asking for the metadata commit, so an
      // incomplete generation is never even submitted for finalization.
      const plannedFileIds = discovery.planned.map((file) => file.fileId);
      const confirmedFileIds = [...this.completedFiles].sort();
      const storedGraphs = graphResults.map((result) => result.graph);
      const requiredGraphs = this.options.requiredGraphs ?? ["file", "symbol"];
      const preCheck = validateGenerationCompleteness({
        generationId: this.generationId,
        plannedFileIds,
        confirmedFileIds,
        checkpointsSaved: true,
        requiredGraphs,
        storedGraphs,
        metadataStatus: "completed",
      });
      if (!preCheck.complete) {
        throw indexIncompleteError(
          `generation "${this.generationId}" cannot be committed: ${preCheck.reasons.join("; ")}`,
          {
            retryable: false,
            operation: "generation_commit",
            context: {
              generationId: this.generationId,
              missingFileIds: preCheck.missingFileIds,
              missingGraphs: preCheck.missingGraphs,
            },
          },
        );
      }
      const commitResult = await stages.commit.commit(
        {
          jobId: this.jobId,
          generationId: this.generationId,
          workspaceId: identity.workspaceId,
          repoId: identity.repoId,
          refId: identity.refId,
          effectiveProfileId: identity.effectiveProfileId,
          plannedFileIds,
          confirmedFileIds,
          storedGraphs,
        },
        { signal },
      );
      // Full §13.4 gate including the FINAL metadata status the commit
      // stage actually reached — `completed` is only reported after this.
      assertGenerationComplete({
        generationId: this.generationId,
        plannedFileIds,
        confirmedFileIds,
        checkpointsSaved: true,
        requiredGraphs,
        storedGraphs,
        metadataStatus: commitResult.metadataStatus,
      });

      // Stop the heartbeat and perform one last owner-checked renewal before
      // publishing anything terminal. If another process took the lease, this
      // throws LOCK_HELD and the stale runner never calls the observer.
      await lockHeartbeat?.assertOwnership();
      await notifyGenerationFinished("completed");
      this.machine.transition("completed");
      emit({
        kind: "job_completed",
        durationMs: clock.nowEpochMs() - startedAtMs,
        ...base(),
      });
    } catch (error) {
      let effectiveError: unknown = lockHeartbeat?.failure ?? error;
      const externallyCancelled =
        (lockHeartbeat === null || lockHeartbeat.failure === null) &&
        external?.aborted === true &&
        isJobCancelledError(error);

      if (externallyCancelled) {
        const checkpointSaved = await this.prepareCancelled(emit, base);
        try {
          await lockHeartbeat?.assertOwnership();
        } catch (ownershipError) {
          // Cancellation cleanup can outlive a lease. Losing it changes the
          // truthful terminal outcome from cancelled to a lock failure.
          effectiveError = ownershipError;
          this.finishFailed(effectiveError, emit, base);
          return;
        }
        await notifyGenerationFinished("cancelled");
        this.emitCancelled(checkpointSaved, emit, base);
        return;
      }

      let ownsLock = true;
      try {
        await lockHeartbeat?.assertOwnership();
      } catch (ownershipError) {
        effectiveError = ownershipError;
        ownsLock = false;
      }
      if (ownsLock) await notifyGenerationFinished("failed");
      this.finishFailed(effectiveError, emit, base);
    } finally {
      await lockHeartbeat?.stop();
      internal.abort();
      if (lock !== null) {
        try {
          await lock.release();
        } catch {
          // Releasing a lock after the job already reached a terminal state
          // must never mask the job's own outcome.
        }
      }
    }
  }

  /** Cancellation path part one (architecture.md §21.3): save the checkpoint. */
  private async prepareCancelled(
    emit: (event: JobEvent) => void,
    base: () => { jobId: string; workspaceId: string; occurredAt: string },
  ): Promise<boolean> {
    this.machine.transition("cancel_requested");
    let checkpointSaved = false;
    if (this.generationId !== null) {
      try {
        // Only CONFIRMED work is in the runner state, so this checkpoint is
        // valid by construction; per-batch checkpoints were already saved.
        await this.saveCheckpoint({});
        checkpointSaved = true;
        emit({
          kind: "checkpoint_saved",
          stage: this.machine.stage,
          completedFileCount: this.completedFiles.size,
          ...base(),
        });
      } catch {
        checkpointSaved = false;
      }
    }
    return checkpointSaved;
  }

  /** Cancellation path part two: emit only after terminal lock ownership was proven. */
  private emitCancelled(
    checkpointSaved: boolean,
    emit: (event: JobEvent) => void,
    base: () => { jobId: string; workspaceId: string; occurredAt: string },
  ): void {
    emit({ kind: "job_cancelled", checkpointSaved, ...base() });
    this.machine.transition("cancelled");
  }

  private finishFailed(
    error: unknown,
    emit: (event: JobEvent) => void,
    base: () => { jobId: string; workspaceId: string; occurredAt: string },
  ): void {
    const failure = isUntangleError(error)
      ? error
      : new UntangleError(
          // A stage that throws something untyped still leaves the index
          // incomplete — that is the truthful classification. Never guess a
          // more specific infrastructure code (spec.md §25.2).
          "INDEX_INCOMPLETE",
          error instanceof Error ? error.message : String(error),
          { retryable: false, operation: "index_job", cause: error },
        );
    this.machine.transition("failed");
    emit({
      kind: "job_failed",
      errorCode: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      ...base(),
    });
  }

  /**
   * Meldet eine Budgetverletzung der Queues. Eine Ueberschreitung des
   * Speicherbudgets darf nie stillschweigend passieren (E4) — auch dann
   * nicht, wenn sie unvermeidbar ist, weil ein einzelnes Element groesser
   * als das ganze Budget ist.
   */
  private reportOverBudget(queue: "analysis" | "upsert", admission: OverBudgetAdmissionV1): void {
    this.options.logger?.log({
      timestamp: this.options.clock.nowIso(),
      level: "warn",
      component: "jobs.index",
      event: "queue_over_budget_admission",
      jobId: this.jobId,
      context: {
        queue,
        itemBytes: admission.itemBytes,
        maxBytes: admission.maxBytes,
        ordinal: admission.ordinal,
        allowance: admission.allowance,
      },
    });
  }

  // -- pipeline -------------------------------------------------------------

  private async runPipeline(
    remaining: readonly PlannedFileV1[],
    emit: (event: JobEvent) => void,
    base: () => { jobId: string; workspaceId: string; occurredAt: string },
    signal: AbortSignal,
  ): Promise<void> {
    if (remaining.length === 0) {
      return;
    }
    const { stages, identity } = this.options;
    const memoryBudgetBytes = this.options.memoryBudgetBytes ?? DEFAULT_MEMORY_BUDGET_BYTES;
    const embedBatchSize = this.options.embedBatchSize ?? DEFAULT_EMBED_BATCH_SIZE;
    const analysisQueue = new BoundedQueue<AnalyzedFileV1>({
      capacity: this.options.queueCapacities?.analysis ?? DEFAULT_ANALYSIS_CAPACITY,
      maxBytes: Math.floor(memoryBudgetBytes / 2),
      sizeOf: (item) => item.estimatedBytes,
      onOverBudgetAdmission: (admission) => this.reportOverBudget("analysis", admission),
    });
    const upsertQueue = new BoundedQueue<EmbeddedBatchV1>({
      capacity: this.options.queueCapacities?.upsert ?? DEFAULT_UPSERT_CAPACITY,
      maxBytes: Math.floor(memoryBudgetBytes / 2),
      sizeOf: (item) => item.estimatedBytes,
      onOverBudgetAdmission: (admission) => this.reportOverBudget("upsert", admission),
    });
    this.queues = { analysis: analysisQueue, upsert: upsertQueue };

    const failAll = (error: unknown): void => {
      analysisQueue.fail(error);
      upsertQueue.fail(error);
    };

    const analysisWorker = async (): Promise<void> => {
      for (const file of remaining) {
        // Safe batch boundary: between files (architecture.md §21.3).
        throwIfAborted(signal, "index_analysis");
        const analyzed = await stages.analysis.analyze(file, { signal });
        this.machine.advanceTo("computing_metrics");
        emit({
          kind: "file_analyzed",
          repoId: identity.repoId,
          refId: identity.refId,
          fileId: file.fileId,
          filePath: file.filePath,
          parseQuality: analyzed.parseQuality,
          chunkCount: analyzed.chunkCount,
          symbolCount: analyzed.symbolCount,
          ...base(),
        });
        await analysisQueue.push(analyzed, { signal });
      }
      analysisQueue.close();
    };

    const embedWorker = async (): Promise<void> => {
      let batchIndex = 0;
      while (true) {
        const first = await analysisQueue.pull({ signal });
        if (first.done) {
          break;
        }
        const batch: AnalyzedFileV1[] = [first.value];
        while (batch.length < embedBatchSize) {
          const next = analysisQueue.tryPull();
          if (next === null || next.done) {
            break;
          }
          batch.push(next.value);
        }
        // Safe batch boundary: before embedding the next batch.
        throwIfAborted(signal, "index_embedding");
        this.machine.advanceTo("embedding");
        const embedded = await stages.embedding.embedBatch(batch, { signal });
        emit({
          kind: "embedding_batch_completed",
          batchIndex,
          batchSize: batch.length,
          cacheHits: embedded.cacheHits,
          truncatedCount: embedded.truncatedCount,
          ...base(),
        });
        await upsertQueue.push(embedded, { signal });
        batchIndex += 1;
      }
      upsertQueue.close();
    };

    const storeWorker = async (): Promise<void> => {
      while (true) {
        const item = await upsertQueue.pull({ signal });
        if (item.done) {
          break;
        }
        // Safe batch boundary: before starting the next upsert.
        throwIfAborted(signal, "index_storing");
        this.machine.advanceTo("storing");
        const confirmation = await stages.storage.upsertBatch(item.value, { signal });
        emit({
          kind: "points_stored",
          collection: confirmation.collection,
          pointCount: confirmation.pointCount,
          serializedBytes: confirmation.serializedBytes,
          ...base(),
        });
        // Record confirmed work ONLY after the store acknowledged the
        // upsert, and persist the checkpoint ONLY after that (spec.md §10.5).
        for (const file of item.value.files) {
          this.completedFiles.add(file.fileId);
          this.manifestHashes[file.fileId] = file.contentHash;
        }
        for (const [fileId, pointIds] of Object.entries(confirmation.storedPointIdsByFile)) {
          this.storedPointIdsByFile[fileId] = [...pointIds];
        }
        this.machine.advanceTo("checkpointing");
        await this.saveCheckpoint({ signal });
        emit({
          kind: "checkpoint_saved",
          stage: this.machine.stage,
          completedFileCount: this.completedFiles.size,
          ...base(),
        });
      }
    };

    const guard = async (worker: () => Promise<void>): Promise<void> => {
      try {
        await worker();
      } catch (error) {
        failAll(error);
        throw error;
      }
    };

    const settled = await Promise.allSettled([
      guard(analysisWorker),
      guard(embedWorker),
      guard(storeWorker),
    ]);
    this.lastQueueStats = { analysis: analysisQueue.stats(), upsert: upsertQueue.stats() };
    this.queues = null;

    const rejections = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    const firstRealFailure = rejections.find((error) => !isJobCancelledError(error));
    if (firstRealFailure !== undefined) {
      throw firstRealFailure;
    }
    const firstCancellation = rejections[0];
    if (firstCancellation !== undefined) {
      throw firstCancellation;
    }
  }

  private async saveCheckpoint(options: { signal?: AbortSignal }): Promise<void> {
    if (this.generationId === null) {
      throw indexIncompleteError("cannot save a checkpoint before the generation is known", {
        retryable: false,
        operation: "checkpoint_save",
      });
    }
    const checkpoint: IndexCheckpointV1 = {
      jobId: this.jobId,
      generationId: this.generationId,
      workspaceId: this.options.identity.workspaceId,
      repoId: this.options.identity.repoId,
      refId: this.options.identity.refId,
      effectiveProfileId: this.options.identity.effectiveProfileId,
      completedFiles: [...this.completedFiles].sort(),
      storedPointIdsByFile: Object.fromEntries(
        Object.entries(this.storedPointIdsByFile).map(([fileId, ids]) => [fileId, [...ids]]),
      ),
      manifestHashes: { ...this.manifestHashes },
      stage: this.machine.stage,
      savedAt: this.options.clock.nowIso(),
    };
    await this.options.checkpointStore.save(
      checkpoint,
      options.signal !== undefined ? { signal: options.signal } : undefined,
    );
  }
}
