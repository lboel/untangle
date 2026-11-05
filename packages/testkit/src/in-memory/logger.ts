/**
 * `LoggerPort` implementation that collects every event into a shared array
 * instead of writing anywhere, so tests can assert on structured log output
 * (architecture.md §24.2). `child()` bindings take precedence over whatever
 * an individual `log()` call passes for `component`/`requestId`/`jobId`;
 * `context` objects deep-merge (event keys win over inherited ones).
 */
import type { LogEvent, LoggerPort } from "@untangle-code/domain";

interface Bindings {
  component?: string;
  requestId?: string;
  jobId?: string;
  context?: Record<string, unknown>;
}

export class CollectingLogger implements LoggerPort {
  private readonly sink: LogEvent[];
  private readonly bindings: Bindings;

  public constructor(bindings: Bindings = {}, sink: LogEvent[] = []) {
    this.bindings = bindings;
    this.sink = sink;
  }

  /** Every event logged by this logger or any of its `child()` loggers, in order. */
  public get events(): readonly LogEvent[] {
    return this.sink;
  }

  public clear(): void {
    this.sink.length = 0;
  }

  public log(event: LogEvent): void {
    const requestId = this.bindings.requestId ?? event.requestId;
    const jobId = this.bindings.jobId ?? event.jobId;
    const context =
      this.bindings.context || event.context
        ? { ...this.bindings.context, ...event.context }
        : undefined;
    const merged: LogEvent = {
      ...event,
      component: this.bindings.component ?? event.component,
      ...(requestId !== undefined ? { requestId } : {}),
      ...(jobId !== undefined ? { jobId } : {}),
      ...(context !== undefined ? { context } : {}),
    };
    this.sink.push(merged);
  }

  public child(bindings: Bindings): LoggerPort {
    const mergedContext =
      this.bindings.context || bindings.context
        ? { ...this.bindings.context, ...bindings.context }
        : undefined;
    const component = bindings.component ?? this.bindings.component;
    const requestId = bindings.requestId ?? this.bindings.requestId;
    const jobId = bindings.jobId ?? this.bindings.jobId;
    const merged: Bindings = {
      ...(component !== undefined ? { component } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(jobId !== undefined ? { jobId } : {}),
      ...(mergedContext !== undefined ? { context: mergedContext } : {}),
    };
    return new CollectingLogger(merged, this.sink);
  }
}
