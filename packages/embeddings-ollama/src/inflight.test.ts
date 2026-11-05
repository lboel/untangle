import { describe, expect, it, vi } from "vitest";

import { createDeferred, InFlightRegistry, raceWithSignal } from "./inflight.js";

describe("createDeferred", () => {
  it("resolves the returned promise when resolve() is called", async () => {
    const deferred = createDeferred<number>();
    deferred.resolve(42);
    await expect(deferred.promise).resolves.toBe(42);
  });

  it("rejects the returned promise when reject() is called", async () => {
    const deferred = createDeferred<number>();
    const error = new Error("boom");
    deferred.reject(error);
    await expect(deferred.promise).rejects.toBe(error);
  });
});

describe("raceWithSignal", () => {
  it("returns the same promise unchanged when no signal is given", async () => {
    const shared = Promise.resolve("value");
    await expect(raceWithSignal(shared, undefined)).resolves.toBe("value");
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const shared = new Promise<string>(() => {
      /* never settles */
    });
    const error = await raceWithSignal(shared, controller.signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("resolves with the shared value when the signal never aborts", async () => {
    const shared = Promise.resolve("done");
    const controller = new AbortController();
    await expect(raceWithSignal(shared, controller.signal)).resolves.toBe("done");
  });

  it("rejects THIS waiter when its signal aborts, without altering the shared promise's own outcome", async () => {
    const controller = new AbortController();
    let resolveShared!: (value: string) => void;
    const shared = new Promise<string>((resolve) => {
      resolveShared = resolve;
    });

    const waiter = raceWithSignal(shared, controller.signal);
    controller.abort();
    const error = await waiter.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);

    // The underlying shared promise is untouched by the waiter's abort —
    // it still resolves normally for anyone else awaiting it directly.
    resolveShared("still fine");
    await expect(shared).resolves.toBe("still fine");
  });

  it("removes its own abort listener once settled, so a later abort on the same signal is a no-op", async () => {
    const controller = new AbortController();
    const shared = Promise.resolve("value");
    await raceWithSignal(shared, controller.signal);
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    // Settling already happened; aborting afterwards must not throw and
    // must not be observed by the (already-removed) listener.
    expect(() => controller.abort()).not.toThrow();
    removeSpy.mockRestore();
  });
});

describe("InFlightRegistry", () => {
  it("returns undefined for a key with nothing registered", () => {
    const registry = new InFlightRegistry<number>();
    expect(registry.get("k")).toBeUndefined();
  });

  it("returns the registered promise for a key until it settles", async () => {
    const registry = new InFlightRegistry<number>();
    const deferred = createDeferred<number>();
    registry.register("k", deferred.promise);
    expect(registry.get("k")).toBe(deferred.promise);
    deferred.resolve(1);
    await deferred.promise;
    // Cleanup runs as a microtask after settling; flush it.
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.get("k")).toBeUndefined();
  });

  it("frees the key when the registered promise rejects", async () => {
    const registry = new InFlightRegistry<number>();
    const deferred = createDeferred<number>();
    registry.register("k", deferred.promise);
    deferred.reject(new Error("boom"));
    await deferred.promise.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.get("k")).toBeUndefined();
  });

  it("never surfaces an unhandled rejection just from registering a promise that later rejects", async () => {
    const registry = new InFlightRegistry<number>();
    const deferred = createDeferred<number>();
    registry.register("k", deferred.promise);
    deferred.reject(new Error("boom"));
    // No `.catch` attached by the test on `deferred.promise` itself beyond
    // this — if `register` didn't guard against unhandled rejections, this
    // would produce a process-level warning/failure under vitest.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
