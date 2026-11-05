import {
  DeterministicRandom,
  FakeClock,
  InMemoryLockProvider,
  MemoryFileSystem,
} from "@untangle-code/testkit";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeNativeWatcher } from "./testing/fake-native-watcher.js";
import { FakeScheduler } from "./testing/fake-scheduler.js";
import type { WatcherEventV1, WatcherStatusEventV1 } from "./types.js";
import { RepoWatcher } from "./watcher.js";

/** Lets pending microtask chains (fire-and-forget `flushPath`/reconciliation calls) settle. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("RepoWatcher", () => {
  let clock: FakeClock;
  let fs: MemoryFileSystem;
  let scheduler: FakeScheduler;
  let nativeWatcher: FakeNativeWatcher;

  beforeEach(() => {
    clock = new FakeClock(0);
    fs = new MemoryFileSystem(clock);
    fs.seedDirectory("/repo");
    scheduler = new FakeScheduler(clock);
    nativeWatcher = new FakeNativeWatcher();
  });

  function makeWatcher(
    overrides: Partial<ConstructorParameters<typeof RepoWatcher>[0]> = {},
  ): RepoWatcher {
    return new RepoWatcher({
      repoId: "repo-1",
      refId: "ref-1",
      rootPath: "/repo",
      fs,
      nativeWatcher,
      scheduler,
      clock,
      lockProvider: new InMemoryLockProvider(clock, new DeterministicRandom(1)),
      debounceMs: 2000,
      reconciliationIntervalMs: 100_000, // effectively "never" unless a test advances that far
      leaseMs: 60_000,
      restartDelayMs: 1000,
      ...overrides,
    });
  }

  it("debounces a storm of raw events on the same path into exactly one change event", async () => {
    fs.seedFile("/repo/a.ts", "v1");
    const watcher = makeWatcher();
    const changes: WatcherEventV1[][] = [];
    watcher.onChange((events) => {
      changes.push(events);
    });

    await watcher.start();
    // `start()` ran a baseline reconciliation that reported the seeded file
    // as "added" (empty initial snapshot) — clear that noise so this test
    // isolates the debounce/coalescing behavior itself.
    changes.length = 0;

    // One real edit, but the editor/OS reports it as several raw events —
    // exactly the "Ereignissturm" case spec.md §12.3 requires coalescing.
    // Each `emit()` is followed by a `flushAsync()`: delivery through the
    // fake async iterator resolves via a microtask, so without flushing,
    // ALL three emits would only reach `handleNativeEvent`/`notify()` in a
    // single batch after every `advance()` below has already run — which
    // would register every debounce timer against the SAME (too-late)
    // simulated clock reading instead of the three distinct ones intended.
    fs.seedFile("/repo/a.ts", "v2");
    nativeWatcher.emit({ eventType: "change", relativePath: "a.ts" });
    await flushAsync();
    scheduler.advance(500);
    nativeWatcher.emit({ eventType: "change", relativePath: "a.ts" });
    await flushAsync();
    scheduler.advance(500);
    nativeWatcher.emit({ eventType: "rename", relativePath: "a.ts" });
    await flushAsync();

    // Still well within the quiet period since the LAST event.
    scheduler.advance(1999);
    await flushAsync();
    expect(changes).toEqual([]);

    // Crosses the 2000ms quiet period since the last of the three events.
    scheduler.advance(1);
    await flushAsync();

    expect(changes).toHaveLength(1);
    expect(changes[0]).toHaveLength(1);
    expect(changes[0]?.[0]).toMatchObject({ changeKind: "modified", relativePath: "a.ts" });

    await watcher.stop();
  });

  it("periodic reconciliation finds a change the native watcher slept through", async () => {
    fs.seedFile("/repo/a.ts", "v1");
    const watcher = makeWatcher({ reconciliationIntervalMs: 5000 });
    const changes: WatcherEventV1[][] = [];
    watcher.onChange((events) => {
      changes.push(events);
    });

    await watcher.start();
    // See the debounce test above for why the baseline "added" is cleared.
    changes.length = 0;

    // The file changes on disk, but — unlike the test above — NO native
    // event is ever emitted for it (a missed/dropped OS notification).
    fs.seedFile("/repo/a.ts", "v2");
    expect(changes).toEqual([]);

    scheduler.advance(5000); // fires the periodic reconciliation timer
    await flushAsync();

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual([
      expect.objectContaining({ changeKind: "modified", relativePath: "a.ts" }),
    ]);

    await watcher.stop();
  });

  it("isolates a watcher backend failure: process/test keeps running, status degrades, then recovers on restart", async () => {
    const watcher = makeWatcher({ restartDelayMs: 1000 });
    const statusEvents: WatcherStatusEventV1[] = [];
    watcher.onStatusChange((event) => statusEvents.push(event));

    await watcher.start();
    expect(watcher.status).toBe("running");
    expect(nativeWatcher.watchCallCount).toBe(1);

    // Simulate the native backend crashing mid-stream (e.g. EMFILE, or
    // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM on an unsupported OS).
    nativeWatcher.fail(new Error("simulated backend crash"));
    await flushAsync();

    // The failure must be isolated: never rethrown out of the watch loop,
    // only reported — this assertion running at all is part of the proof
    // that nothing crashed the process.
    expect(watcher.status).toBe("degraded");
    const degradedEvent = statusEvents.find((e) => e.status === "degraded");
    expect(degradedEvent?.error).toBeInstanceOf(Error);
    expect(degradedEvent?.error?.code).toBe("INDEX_INCOMPLETE");

    // After the restart delay, the watch loop reopens the backend on its own.
    scheduler.advance(1000);
    await flushAsync();

    expect(nativeWatcher.watchCallCount).toBe(2);
    expect(watcher.status).toBe("running");

    await watcher.stop();
  });

  it("blocks a second watcher on the same repo/ref via the cross-process lock", async () => {
    const lockProvider = new InMemoryLockProvider(clock, new DeterministicRandom(7));
    const watcherA = makeWatcher({ lockProvider });
    const watcherB = makeWatcher({ lockProvider });

    await watcherA.start();
    expect(watcherA.status).toBe("running");

    await expect(watcherB.start()).rejects.toMatchObject({ code: "LOCK_HELD" });
    expect(watcherB.status).toBe("stopped");

    await watcherA.stop();
  });

  it("renews the lock lease so it survives past the original lease duration", async () => {
    const lockProvider = new InMemoryLockProvider(clock, new DeterministicRandom(3));
    const watcher = makeWatcher({ lockProvider, leaseMs: 1000 });

    await watcher.start();
    const key = "repo:repo-1:ref-1:watch";
    expect(await lockProvider.inspect(key)).not.toBeNull();

    // Renewal is scheduled at leaseMs/2 = 500ms; advancing to 1400ms is past
    // the ORIGINAL 1000ms lease but should still be held thanks to renewal.
    scheduler.advance(1400);
    await flushAsync();

    expect(await lockProvider.inspect(key)).not.toBeNull();

    await watcher.stop();
  });

  it("stop() releases the lock so a new watcher can acquire it", async () => {
    const lockProvider = new InMemoryLockProvider(clock, new DeterministicRandom(9));
    const watcherA = makeWatcher({ lockProvider });
    await watcherA.start();

    await watcherA.stop();
    expect(watcherA.status).toBe("stopped");

    const watcherB = makeWatcher({ lockProvider });
    await expect(watcherB.start()).resolves.toBeUndefined();
    await watcherB.stop();
  });
});
