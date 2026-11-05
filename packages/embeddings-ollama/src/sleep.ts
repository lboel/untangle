/**
 * Real, abortable {@link SleepFn} implementation. The only production
 * implementation of the port declared in `types.ts`; tests inject a fake
 * that resolves immediately instead of waiting for real time to pass.
 */
import type { SleepFn } from "./types.js";

export const realSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason);
    };
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
