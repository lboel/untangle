import { performance } from "node:perf_hooks";

import { isUntangleError, UntangleError } from "@untangle-code/domain";

/** Monotonic infrastructure deadlines; native writes are awaited before unlocking. */
export class StorageCall {
  private readonly deadline: number;
  public mayHaveCommitted = false;

  public constructor(
    public readonly operation: string,
    public readonly signal: AbortSignal | undefined,
    timeoutMs: number,
  ) {
    this.deadline = performance.now() + timeoutMs;
  }

  public check(): void {
    if (this.signal?.aborted)
      throw new UntangleError("JOB_CANCELLED", "Local storage operation cancelled.", {
        operation: this.operation,
        context: { mayHaveCommitted: this.mayHaveCommitted },
      });
    if (performance.now() >= this.deadline)
      throw unavailable("Local storage operation exceeded its deadline.", this, true);
  }

  public remaining(): number {
    this.check();
    return Math.max(1, Math.ceil(this.deadline - performance.now()));
  }
}

export function unavailable(
  message: string,
  call: StorageCall,
  retryable = true,
  cause?: unknown,
): UntangleError {
  return new UntangleError("LANCEDB_UNAVAILABLE", message, {
    operation: call.operation,
    retryable,
    context: { mayHaveCommitted: call.mayHaveCommitted },
    ...(cause === undefined ? {} : { cause }),
  });
}

export function schemaError(message: string, context: Record<string, unknown> = {}): UntangleError {
  return new UntangleError("LANCEDB_SCHEMA_INCOMPATIBLE", message, { context });
}

export function invalid(message: string): UntangleError {
  return new UntangleError("CONFIG_INVALID", message);
}

export function wrapStorageError(error: unknown, call: StorageCall): never {
  if (isUntangleError(error)) throw error;
  call.check();
  throw unavailable(
    "LanceDB operation failed; no empty result was substituted.",
    call,
    true,
    error,
  );
}
