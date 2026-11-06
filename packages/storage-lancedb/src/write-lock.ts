import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { UntangleError } from "@untangle-code/domain";

import type { StorageCall } from "./operation.js";
import { schemaError } from "./operation.js";

export const MUTATION_GUARD_FILE = ".untangle-writer.sqlite";

/**
 * SQLite is only an OS-backed mutex, never a vector/catalog mirror. Its reserved
 * lock survives suspension and is released by the OS on process death. There is
 * no stale timeout, PID guessing, unlink takeover or unfenced lease holder.
 */
export async function withMutationLock<T>(
  root: string,
  call: StorageCall,
  lockTimeoutMs: number,
  work: () => Promise<T>,
): Promise<T> {
  call.check();
  const file = path.join(root, MUTATION_GUARD_FILE);
  try {
    const handle = await open(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw schemaError("The mutation guard must be a physical regular file.");

  // Lazy: importing this package, constructing it and absent-path reads do not
  // load SQLite or the Lance native SDK. These APIs exist in Node 22.13.
  const { DatabaseSync } = await import("node:sqlite");
  const guard = new DatabaseSync(file);
  let acquired = false;
  const deadline = performance.now() + lockTimeoutMs;
  try {
    guard.exec("PRAGMA busy_timeout=0");
    let waited = false;
    for (;;) {
      call.check();
      if (waited && performance.now() >= deadline)
        throw new UntangleError("LOCK_HELD", "Another process holds the LanceDB mutation guard.", {
          retryable: true,
          operation: call.operation,
        });
      try {
        guard.exec("BEGIN IMMEDIATE");
        acquired = true;
        break;
      } catch (error) {
        const code = (error as { errcode?: number }).errcode;
        if (code !== 5 && code !== 6) throw error;
        waited = true;
        if (performance.now() >= deadline)
          throw new UntangleError(
            "LOCK_HELD",
            "Another process holds the LanceDB mutation guard.",
            {
              retryable: true,
              operation: call.operation,
            },
          );
        await delay(Math.min(20, call.remaining()), undefined, { signal: call.signal });
      }
    }
    guard.exec("CREATE TABLE IF NOT EXISTS writer_guard (id INTEGER PRIMARY KEY)");
    call.check();
    // Never race work against cancellation: releasing the guard while an
    // uninterruptible native write is still running would permit lost upserts.
    const result = await work();
    call.check();
    guard.exec("COMMIT");
    acquired = false;
    return result;
  } finally {
    try {
      if (acquired) guard.exec("ROLLBACK");
    } finally {
      guard.close();
    }
  }
}
