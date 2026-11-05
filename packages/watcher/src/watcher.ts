/**
 * `RepoWatcher` — the package's central orchestrator (spec.md §12.1, §12.3;
 * architecture.md §21.1). Ties together:
 *
 * - the native watcher backend (`NativeWatcherPort`) for live events;
 * - `PathDebouncer` for entprellen + koaleszieren (spec.md §12.3);
 * - `reconcileTree` on a periodic timer, as the safety net for events the
 *   native backend missed;
 * - `LockProvider` for the cross-process `repo:<repoId>:<refId>:watch` lock
 *   (architecture.md §21.1), so two watchers on the same ref cannot run
 *   concurrently;
 * - error isolation: a native-backend failure is logged, flips `status` to
 *   `"degraded"`, and triggers an automatic restart — it is NEVER rethrown
 *   out of the watch loop (spec.md §12.3: "Watcherfehler dürfen den
 *   MCP-Prozess nicht unkontrolliert beenden").
 *
 * See README "Entscheidungen" for the constructor defaults and the
 * `INDEX_INCOMPLETE`-as-degraded-signal choice.
 */
import type {
  Clock,
  FileSystemPort,
  LockHandle,
  LockProvider,
  LoggerPort,
  PortCallOptions,
  UntangleError,
} from "@untangle-code/domain";

import { defaultContentHasher } from "./content-hash.js";
import { PathDebouncer } from "./debouncer.js";
import { errorMessage, isUntangleError, toWatcherError } from "./errors.js";
import { noopLogger } from "./noop-logger.js";
import { isDotGitPath, normalizeRelativePath } from "./paths.js";
import { evaluatePath, reconcileTree } from "./reconciler.js";
import type {
  ContentHasher,
  IgnorePredicate,
  NativeChangeEventV1,
  NativeWatcherPort,
  SchedulerPort,
  TimerHandle,
  WatchedFileSnapshotV1,
  WatcherChangeHandler,
  WatcherEventV1,
  WatcherStatus,
  WatcherStatusHandler,
} from "./types.js";

const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_RECONCILIATION_INTERVAL_MS = 30_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RESTART_DELAY_MS = 1000;
const DEFAULT_LOCK_WAIT_MS = 0;

/** Lock key for a repo/ref watch, per architecture.md §21.1's fixed naming scheme. */
export function buildWatchLockKey(repoId: string, refId: string): string {
  return `repo:${repoId}:${refId}:watch`;
}

export interface RepoWatcherOptions {
  repoId: string;
  refId: string;
  /** Absolute, OS-native path to the directory tree being watched. */
  rootPath: string;
  fs: FileSystemPort;
  nativeWatcher: NativeWatcherPort;
  scheduler: SchedulerPort;
  /** Time source for log-event timestamps and lock-record bookkeeping (never `Date.now()`). */
  clock: Clock;
  lockProvider: LockProvider;
  logger?: LoggerPort;
  hasher?: ContentHasher;
  /** Additional exclusion beyond the built-in `.git` skip. */
  ignore?: IgnorePredicate;
  /** Seeds `reconcileTree`'s comparison baseline — typically the last persisted manifest. */
  initialSnapshots?: WatchedFileSnapshotV1[];
  /** Debounce quiet period (spec.md §12.3 default). */
  debounceMs?: number;
  /** Interval between periodic reconciliation passes (spec.md §12.3; no default number is specified there — see README). */
  reconciliationIntervalMs?: number;
  /** Lock lease duration; renewed at half this interval while running. */
  leaseMs?: number;
  /** Delay before restarting the native watch loop after a backend failure. */
  restartDelayMs?: number;
  /** `LockProvider.acquire`'s `waitMs` — default `0` (fail fast) so a second watcher on the same ref is rejected immediately. */
  lockWaitMs?: number;
}

/**
 * One repo/ref's native watch + debounce + reconciliation + lock lifecycle.
 * Construct one per watched ref; call `start()` once, `stop()` to tear down.
 */
export class RepoWatcher {
  private readonly repoId: string;
  private readonly refId: string;
  private readonly rootPath: string;
  private readonly fs: FileSystemPort;
  private readonly nativeWatcher: NativeWatcherPort;
  private readonly scheduler: SchedulerPort;
  private readonly clock: Clock;
  private readonly lockProvider: LockProvider;
  private readonly logger: LoggerPort;
  private readonly hasher: ContentHasher;
  private readonly extraIgnore: IgnorePredicate;
  private readonly debounceMs: number;
  private readonly reconciliationIntervalMs: number;
  private readonly leaseMs: number;
  private readonly restartDelayMs: number;
  private readonly lockWaitMs: number;

  private readonly snapshots = new Map<string, WatchedFileSnapshotV1>();
  private readonly changeHandlers = new Set<WatcherChangeHandler>();
  private readonly statusHandlers = new Set<WatcherStatusHandler>();

  private currentStatus: WatcherStatus = "stopped";
  private lockHandle: LockHandle | null = null;
  private abortController: AbortController | null = null;
  private debouncer: PathDebouncer | null = null;
  private reconciliationTimer: TimerHandle | null = null;
  private lockRenewalTimer: TimerHandle | null = null;
  private watchLoopPromise: Promise<void> | null = null;
  private reconciling = false;
  private started = false;
  private stopped = false;

  public constructor(options: RepoWatcherOptions) {
    this.repoId = options.repoId;
    this.refId = options.refId;
    this.rootPath = options.rootPath;
    this.fs = options.fs;
    this.nativeWatcher = options.nativeWatcher;
    this.scheduler = options.scheduler;
    this.clock = options.clock;
    this.lockProvider = options.lockProvider;
    this.logger = options.logger ?? noopLogger;
    this.hasher = options.hasher ?? defaultContentHasher;
    this.extraIgnore = options.ignore ?? (() => false);
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.reconciliationIntervalMs =
      options.reconciliationIntervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
    this.lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    for (const snapshot of options.initialSnapshots ?? []) {
      this.snapshots.set(snapshot.relativePath, snapshot);
    }
  }

  public get status(): WatcherStatus {
    return this.currentStatus;
  }

  /** Read-only snapshot of the watcher's current per-file bookkeeping (test/debug introspection). */
  public listSnapshots(): WatchedFileSnapshotV1[] {
    return [...this.snapshots.values()];
  }

  /** Subscribes to detected changes; returns an unsubscribe function. */
  public onChange(handler: WatcherChangeHandler): () => void {
    this.changeHandlers.add(handler);
    return () => this.changeHandlers.delete(handler);
  }

  /** Subscribes to status transitions; returns an unsubscribe function. */
  public onStatusChange(handler: WatcherStatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /**
   * Acquires the cross-process ref lock, runs a baseline reconciliation,
   * then starts the native watch loop and the periodic reconciliation/
   * lock-renewal timers. Idempotent: a second call while already started is
   * a no-op. Rejects with `LOCK_HELD` when another watcher already holds
   * the lock for this repo/ref (architecture.md §21.1), or `JOB_CANCELLED`
   * if `options.signal` aborts the startup sequence (spec.md §22).
   */
  public async start(options?: PortCallOptions): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.setStatus("starting");

    try {
      const key = buildWatchLockKey(this.repoId, this.refId);
      const lockOptions: PortCallOptions & { leaseMs?: number; waitMs?: number } = {
        leaseMs: this.leaseMs,
        waitMs: this.lockWaitMs,
      };
      if (options?.signal !== undefined) {
        lockOptions.signal = options.signal;
      }
      this.lockHandle = await this.lockProvider.acquire(key, lockOptions);

      this.abortController = new AbortController();
      this.debouncer = new PathDebouncer({
        scheduler: this.scheduler,
        debounceMs: this.debounceMs,
        onDue: (relativePath) => {
          void this.flushPath(relativePath);
        },
      });

      await this.runReconciliationSafely(options?.signal);

      this.reconciliationTimer = this.scheduler.setInterval(() => {
        void this.runReconciliationSafely();
      }, this.reconciliationIntervalMs);
      this.lockRenewalTimer = this.scheduler.setInterval(
        () => {
          void this.renewLockSafely();
        },
        Math.max(1, Math.floor(this.leaseMs / 2)),
      );

      this.watchLoopPromise = this.runWatchLoop(this.abortController.signal);
    } catch (error) {
      // Startup failed (e.g. `LOCK_HELD`, or `JOB_CANCELLED` while
      // acquiring) — reset so a legitimate later retry is not permanently
      // blocked by the idempotency guard above, and report the watcher as
      // never having actually started rather than stuck mid-"starting".
      this.started = false;
      this.setStatus("stopped");
      throw error;
    }
  }

  /**
   * Stops the watch loop and all timers, releases the lock, and marks the
   * watcher `"stopped"`. Idempotent.
   */
  public async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.abortController?.abort();
    this.reconciliationTimer?.clear();
    this.lockRenewalTimer?.clear();
    this.debouncer?.dispose();
    if (this.watchLoopPromise) {
      await this.watchLoopPromise;
    }
    if (this.lockHandle) {
      const handle = this.lockHandle;
      this.lockHandle = null;
      await handle.release();
    }
    this.setStatus("stopped");
  }

  /**
   * Runs one full reconciliation pass on demand and returns whatever
   * changes it found (also delivered to `onChange` subscribers). Usable
   * standalone, without `start()`, e.g. to build a baseline before the
   * watch loop goes live. Respects `options.signal` (spec.md §22).
   */
  public async reconcileNow(options?: PortCallOptions): Promise<WatcherEventV1[]> {
    const events = await reconcileTree({
      fs: this.fs,
      hasher: this.hasher,
      rootPath: this.rootPath,
      snapshots: this.snapshots,
      ignore: (relativePath) => this.isIgnored(relativePath),
      ...(options !== undefined ? { options } : {}),
    });
    if (events.length > 0) {
      await this.emitChanges(events);
    }
    return events;
  }

  private isIgnored(relativePath: string): boolean {
    return isDotGitPath(relativePath) || this.extraIgnore(relativePath);
  }

  private setStatus(status: WatcherStatus, error?: UntangleError): void {
    this.currentStatus = status;
    const event = error !== undefined ? { status, error } : { status };
    for (const handler of this.statusHandlers) {
      handler(event);
    }
  }

  private async emitChanges(events: WatcherEventV1[]): Promise<void> {
    for (const handler of this.changeHandlers) {
      try {
        await handler(events);
      } catch (error) {
        this.logger.log({
          timestamp: this.clock.nowIso(),
          level: "error",
          component: "watcher",
          event: "change_handler_failed",
          context: { repoId: this.repoId, refId: this.refId, message: errorMessage(error) },
        });
      }
    }
  }

  private async flushPath(relativePath: string): Promise<void> {
    try {
      const event = await evaluatePath({
        fs: this.fs,
        hasher: this.hasher,
        rootPath: this.rootPath,
        relativePath,
        snapshots: this.snapshots,
        ...(this.abortController ? { options: { signal: this.abortController.signal } } : {}),
      });
      if (event) {
        await this.emitChanges([event]);
      }
    } catch (error) {
      if (isUntangleError(error) && error.code === "JOB_CANCELLED") {
        return;
      }
      this.reportDegraded(error, "watcher_flush_path_failed", { relativePath });
    }
  }

  private async runReconciliationSafely(signal?: AbortSignal): Promise<void> {
    if (this.reconciling) {
      return;
    }
    this.reconciling = true;
    try {
      const options: PortCallOptions = {};
      const effectiveSignal = signal ?? this.abortController?.signal;
      if (effectiveSignal !== undefined) {
        options.signal = effectiveSignal;
      }
      const events = await reconcileTree({
        fs: this.fs,
        hasher: this.hasher,
        rootPath: this.rootPath,
        snapshots: this.snapshots,
        ignore: (relativePath) => this.isIgnored(relativePath),
        options,
      });
      if (events.length > 0) {
        await this.emitChanges(events);
      }
      if (this.currentStatus === "degraded") {
        this.setStatus("running");
      }
    } catch (error) {
      if (isUntangleError(error) && error.code === "JOB_CANCELLED") {
        return;
      }
      this.reportDegraded(error, "watcher_reconciliation_failed", {});
    } finally {
      this.reconciling = false;
    }
  }

  private async renewLockSafely(): Promise<void> {
    if (!this.lockHandle) {
      return;
    }
    try {
      await this.lockHandle.renew();
    } catch (error) {
      this.reportDegraded(error, "watcher_lock_renew_failed", {});
      // Exclusivity is broken — stop so a competing holder is not fought.
      void this.stop();
    }
  }

  private reportDegraded(
    error: unknown,
    operation: string,
    extraContext: Record<string, unknown>,
  ): void {
    const wrapped = toWatcherError(error, operation, {
      repoId: this.repoId,
      refId: this.refId,
      rootPath: this.rootPath,
      ...extraContext,
    });
    this.logger.log({
      timestamp: this.clock.nowIso(),
      level: "error",
      component: "watcher",
      event: operation,
      context: { repoId: this.repoId, refId: this.refId, message: wrapped.message },
    });
    this.setStatus("degraded", wrapped);
  }

  private async runWatchLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const iterable = this.nativeWatcher.watch(this.rootPath, { signal });
        this.setStatus("running");
        for await (const event of iterable) {
          if (signal.aborted) {
            break;
          }
          this.handleNativeEvent(event);
        }
        return;
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        this.reportDegraded(error, "watcher_native_backend_failed", {});
        await this.sleepForRestart(signal);
      }
    }
  }

  private sleepForRestart(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const handle = this.scheduler.setTimeout(() => {
        resolve();
      }, this.restartDelayMs);
      signal.addEventListener(
        "abort",
        () => {
          handle.clear();
          resolve();
        },
        { once: true },
      );
    });
  }

  private handleNativeEvent(event: NativeChangeEventV1): void {
    if (event.relativePath === null) {
      // Backend could not name the changed entry — fall back to a full
      // reconciliation instead of guessing (spec.md §12.3).
      void this.runReconciliationSafely();
      return;
    }
    const relativePath = normalizeRelativePath(event.relativePath);
    if (this.isIgnored(relativePath)) {
      return;
    }
    this.debouncer?.notify(relativePath);
  }
}
