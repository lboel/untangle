/**
 * Production `SchedulerPort` backed by the real `setTimeout`/`setInterval`.
 * Handles are `.unref()`-ed where available so an idle watcher never keeps
 * a Node process alive by itself — the caller decides the process
 * lifetime, not this package.
 */
import type { SchedulerPort, TimerHandle } from "./types.js";

export class NodeScheduler implements SchedulerPort {
  public setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const handle = globalThis.setTimeout(callback, delayMs);
    handle.unref?.();
    return { clear: () => globalThis.clearTimeout(handle) };
  }

  public setInterval(callback: () => void, intervalMs: number): TimerHandle {
    const handle = globalThis.setInterval(callback, intervalMs);
    handle.unref?.();
    return { clear: () => globalThis.clearInterval(handle) };
  }
}
