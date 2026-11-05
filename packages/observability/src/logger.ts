/**
 * Structured logger (architecture.md §24.2) implementing domain's
 * `LoggerPort`: JSON lines on stderr, level filtering, and a child logger
 * with bound context.
 *
 * `LogEvent` (architecture.md §24.2, fixed in domain) only carries
 * `requestId`/`jobId` as first-class correlation fields; `generationId`,
 * `workspaceId`, `repoId` and `refId` (architecture.md §24.1's full
 * correlation set) have no first-class slot in that shape. This module's
 * decision (README "Entscheidungen"): those four travel inside `context`
 * under their own keys, merged in the same way `context` itself is —
 * closest (call-site) binding wins over an ancestor `child()`'s binding.
 */
import type { Clock, LogEvent, LoggerPort, LogLevel } from "@untangle-code/domain";

import { redact } from "./redact.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

/** Bindings a child logger merges into every event it emits. */
export interface LoggerBindings {
  component?: string;
  requestId?: string;
  jobId?: string;
  generationId?: string;
  workspaceId?: string;
  repoId?: string;
  refId?: string;
  context?: Record<string, unknown>;
}

/** `LoggerPort` plus per-level convenience methods that fill in `timestamp` via `Clock`. */
export interface Logger extends LoggerPort {
  error(event: string, context?: Record<string, unknown>): void;
  warn(event: string, context?: Record<string, unknown>): void;
  info(event: string, context?: Record<string, unknown>): void;
  debug(event: string, context?: Record<string, unknown>): void;
  trace(event: string, context?: Record<string, unknown>): void;
  child(bindings: LoggerBindings): Logger;
}

export interface CreateLoggerOptions {
  /** Time source for auto-timestamped convenience methods (`info()`, …). Never `Date.now()`. */
  clock: Clock;
  /** Minimum level emitted; events below it are dropped without touching `sink`. Default `"info"`. */
  level?: LogLevel;
  /** Where a finished JSON line is written. Default: one `process.stderr.write` call per event. */
  sink?: (line: string) => void;
  /**
   * Opt-in escape hatch (spec.md §24): when `false` (default), source-text
   * fields in `context` are suppressed rather than logged verbatim.
   */
  debugIncludeSourceText?: boolean;
  /** Initial bound context, equivalent to calling `.child(bindings)` once up front. */
  bindings?: LoggerBindings;
}

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
}

function mergeBindings(base: LoggerBindings, next: LoggerBindings): LoggerBindings {
  const merged: LoggerBindings = { ...base, ...next };
  const context = { ...base.context, ...next.context };
  if (Object.keys(context).length > 0) {
    merged.context = context;
  } else {
    delete merged.context;
  }
  return merged;
}

/** Correlation keys promoted from {@link LoggerBindings} into `context` (see module doc). */
function correlationContext(bindings: LoggerBindings): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (bindings.generationId !== undefined) extra["generationId"] = bindings.generationId;
  if (bindings.workspaceId !== undefined) extra["workspaceId"] = bindings.workspaceId;
  if (bindings.repoId !== undefined) extra["repoId"] = bindings.repoId;
  if (bindings.refId !== undefined) extra["refId"] = bindings.refId;
  return extra;
}

class JsonLinesLogger implements Logger {
  private readonly clock: Clock;
  private readonly minLevel: LogLevel;
  private readonly sink: (line: string) => void;
  private readonly includeSourceText: boolean;
  private readonly bindings: LoggerBindings;

  public constructor(
    clock: Clock,
    minLevel: LogLevel,
    sink: (line: string) => void,
    includeSourceText: boolean,
    bindings: LoggerBindings,
  ) {
    this.clock = clock;
    this.minLevel = minLevel;
    this.sink = sink;
    this.includeSourceText = includeSourceText;
    this.bindings = bindings;
  }

  public log(event: LogEvent): void {
    if (LEVEL_ORDER[event.level] < LEVEL_ORDER[this.minLevel]) {
      return;
    }
    const component = event.component || this.bindings.component || "untangle";
    const requestId = event.requestId ?? this.bindings.requestId;
    const jobId = event.jobId ?? this.bindings.jobId;
    const context = {
      ...correlationContext(this.bindings),
      ...this.bindings.context,
      ...event.context,
    };

    const line: LogEvent = {
      timestamp: event.timestamp,
      level: event.level,
      component,
      event: event.event,
      ...(requestId !== undefined ? { requestId } : {}),
      ...(jobId !== undefined ? { jobId } : {}),
      ...(Object.keys(context).length > 0
        ? {
            context: redact(context, { includeSourceText: this.includeSourceText }) as Record<
              string,
              unknown
            >,
          }
        : {}),
    };
    this.sink(JSON.stringify(line));
  }

  public child(bindings: LoggerBindings): Logger {
    return new JsonLinesLogger(
      this.clock,
      this.minLevel,
      this.sink,
      this.includeSourceText,
      mergeBindings(this.bindings, bindings),
    );
  }

  public error(event: string, context?: Record<string, unknown>): void {
    this.emit("error", event, context);
  }

  public warn(event: string, context?: Record<string, unknown>): void {
    this.emit("warn", event, context);
  }

  public info(event: string, context?: Record<string, unknown>): void {
    this.emit("info", event, context);
  }

  public debug(event: string, context?: Record<string, unknown>): void {
    this.emit("debug", event, context);
  }

  public trace(event: string, context?: Record<string, unknown>): void {
    this.emit("trace", event, context);
  }

  private emit(level: LogLevel, event: string, context: Record<string, unknown> | undefined): void {
    this.log({
      timestamp: this.clock.nowIso(),
      level,
      component: this.bindings.component ?? "untangle",
      event,
      ...(context !== undefined ? { context } : {}),
    });
  }
}

/** Creates a structured, JSON-lines-on-stderr {@link Logger} (architecture.md §24.2). */
export function createLogger(options: CreateLoggerOptions): Logger {
  return new JsonLinesLogger(
    options.clock,
    options.level ?? "info",
    options.sink ?? defaultSink,
    options.debugIncludeSourceText ?? false,
    options.bindings ?? {},
  );
}
