import { createHash } from "node:crypto";
import { Script } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { createFeatureThread } from "./feature-3d.js";
import {
  createFeatureUntangleMotion,
  type FeatureUntangleMotionOptions,
  type FeatureUntangleTransition,
} from "./feature-untangle-motion.js";

function transition(): FeatureUntangleTransition {
  return {
    from: { a: { x: -100, y: 20, z: 80 }, b: { x: 50, y: -20, z: -80 } },
    to: { a: { x: 300, y: -120, z: 0 }, b: { x: 330, y: -100, z: 5 } },
    fromAmount: 0,
    toAmount: 1,
    target: "clusters",
  };
}

function clock(overrides: Partial<FeatureUntangleMotionOptions> = {}) {
  const frames = new Map<number, (time: number) => void>();
  let nextId = 0;
  let hidden = false;
  let reduced = false;
  const onFrame = vi.fn<FeatureUntangleMotionOptions["onFrame"]>();
  const onState = vi.fn<FeatureUntangleMotionOptions["onState"]>();
  const options: FeatureUntangleMotionOptions = {
    requestFrame(callback) {
      frames.set(++nextId, callback);
      return nextId;
    },
    cancelFrame(id) {
      frames.delete(id);
    },
    visible: () => !hidden,
    reducedMotion: () => reduced,
    onFrame,
    onState,
    ...overrides,
  };
  return {
    frames,
    onFrame,
    onState,
    motion: createFeatureUntangleMotion(options),
    setHidden(value: boolean) {
      hidden = value;
    },
    setReduced(value: boolean) {
      reduced = value;
    },
    step(time: number) {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(time));
    },
  };
}

describe("bounded feature untangling timeline", () => {
  it("interpolates actual XYZ positions and grouping together, preserves identities and never changes inputs", () => {
    const run = clock();
    const input = transition();
    const original = JSON.stringify(input);
    expect(run.frames.size).toBe(0);
    run.motion.start(input);
    expect(run.onFrame.mock.lastCall).toEqual([input.from, 0]);
    expect(run.frames.size).toBe(1);
    run.step(100);
    run.step(1400);
    expect(run.motion.getState()).toEqual({ phase: "running", target: "clusters", progress: 0.5 });
    const [points, amount] = run.onFrame.mock.lastCall!;
    expect(Object.keys(points).sort()).toEqual(["a", "b"]);
    expect(amount).toBe(0.875);
    expect(points["a"]).toEqual({ x: 250, y: -102.5, z: 10 });
    expect(points["b"]).toEqual({ x: 295, y: -90, z: -5.625 });
    run.step(2700);
    expect(run.onFrame.mock.lastCall).toEqual([input.to, 1]);
    expect(run.motion.getState()).toEqual({ phase: "complete", target: "clusters", progress: 1 });
    expect(run.frames.size).toBe(0);
    expect(JSON.stringify(input)).toBe(original);
    const count = run.onFrame.mock.calls.length;
    run.motion.finish();
    expect(run.onFrame).toHaveBeenCalledTimes(count);
  });

  it("pauses and resumes at the same coordinates without counting time spent paused", () => {
    const run = clock();
    run.motion.start(transition());
    run.step(0);
    run.step(650);
    run.motion.pause();
    const points = run.onFrame.mock.lastCall;
    expect(run.frames.size).toBe(0);
    expect(run.motion.getState().progress).toBe(0.25);
    run.step(80000);
    expect(run.onFrame.mock.lastCall).toBe(points);
    run.motion.resume();
    run.step(90000);
    expect(run.motion.getState().progress).toBe(0.25);
    run.step(90650);
    expect(run.motion.getState().progress).toBe(0.5);
    run.step(91950);
    expect(run.motion.getState().phase).toBe("complete");
    expect(run.frames.size).toBe(0);
  });

  it("ignores stale callbacks after cancellation and supports a complete reverse replay", () => {
    const run = clock();
    const input = transition();
    run.motion.start(input);
    const stale = [...run.frames.values()][0]!;
    run.motion.cancel();
    const count = run.onFrame.mock.calls.length;
    stale(1000);
    expect(run.onFrame).toHaveBeenCalledTimes(count);
    expect(run.motion.getState().phase).toBe("idle");
    expect(run.frames.size).toBe(0);
    run.motion.start(input);
    run.motion.finish();
    run.motion.start({
      from: input.to,
      to: input.from,
      fromAmount: 1,
      toAmount: 0,
      target: "wool",
    });
    run.step(0);
    run.step(1300);
    expect(run.onFrame.mock.lastCall![1]).toBe(0.125);
    run.step(2600);
    expect(run.onFrame.mock.lastCall).toEqual([input.from, 0]);
    expect(run.motion.getState().target).toBe("wool");
    expect(run.frames.size).toBe(0);
  });

  it("groups instantly with reduced motion or no scheduler, including preference changes during motion", () => {
    const reduced = clock({ reducedMotion: () => true });
    reduced.motion.start(transition());
    expect(reduced.onFrame.mock.calls).toEqual([[transition().to, 1]]);
    expect(reduced.frames.size).toBe(0);
    expect(reduced.motion.getState().phase).toBe("complete");
    const unavailable = vi.fn<FeatureUntangleMotionOptions["onFrame"]>();
    const noScheduler = createFeatureUntangleMotion({
      reducedMotion: () => false,
      visible: () => true,
      onFrame: unavailable,
      onState: () => undefined,
    });
    noScheduler.start(transition());
    expect(unavailable.mock.lastCall).toEqual([transition().to, 1]);
    const changing = clock();
    changing.motion.start(transition());
    changing.setReduced(true);
    changing.step(16);
    expect(changing.onFrame.mock.lastCall).toEqual([transition().to, 1]);
    expect(changing.frames.size).toBe(0);
  });

  it("pauses offscreen or hidden, never resumes without an action and leaves no scheduled work", () => {
    const run = clock();
    run.motion.start(transition());
    run.step(0);
    run.step(500);
    run.setHidden(true);
    run.step(1000);
    expect(run.motion.getState().phase).toBe("paused");
    expect(run.motion.getState().progress).toBeCloseTo(500 / 2600);
    expect(run.frames.size).toBe(0);
    run.motion.resume();
    expect(run.frames.size).toBe(0);
    run.setHidden(false);
    expect(run.frames.size).toBe(0);
    run.motion.resume();
    expect(run.frames.size).toBe(1);
    run.motion.finish();
    expect(run.frames.size).toBe(0);
  });

  it("bounds paint frequency for dense graphs and completes even when frames are sparse", () => {
    const run = clock({ frameIntervalMs: 100 });
    run.motion.start(transition());
    for (let time = 0; time < 2600; time += 10) run.step(time);
    expect(run.onFrame.mock.calls.length).toBeLessThanOrEqual(27);
    expect(run.motion.getState().phase).toBe("running");
    run.step(9000);
    expect(run.onFrame.mock.lastCall).toEqual([transition().to, 1]);
    expect(run.frames.size).toBe(0);
  });

  it("freezes input coordinates and rejects topology, timing or coordinate errors without cancelling a valid run", () => {
    const run = clock();
    const input = transition();
    run.motion.start(input);
    input.to["a"]!.x = 9999;
    expect(() => run.motion.start({ ...transition(), to: {} })).toThrow("identity");
    expect(() =>
      run.motion.start({ ...transition(), to: { ...transition().to, a: { x: NaN, y: 0, z: 0 } } }),
    ).toThrow("finite");
    expect(() => run.motion.start({ ...transition(), toAmount: Infinity })).toThrow("amount");
    expect(run.motion.getState().phase).toBe("running");
    expect(run.frames.size).toBe(1);
    run.motion.finish();
    expect(run.onFrame.mock.lastCall![0]["a"]!.x).toBe(300);
    expect(() => clock({ durationMs: Infinity })).toThrow("timing");
    expect(() => clock({ frameIntervalMs: NaN })).toThrow("timing");
  });

  it("pauses after a rendering failure rather than leaking an animation loop", () => {
    const run = clock({
      onFrame: () => {
        throw new Error("draw failed");
      },
    });
    expect(() => run.motion.start(transition())).toThrow("draw failed");
    expect(run.motion.getState().phase).toBe("paused");
    expect(run.frames.size).toBe(0);
  });

  it("runs as a self-contained function in the offline CSP runtime", () => {
    const frames: unknown[] = [];
    new Script(`(${createFeatureUntangleMotion.toString()})(options).start(input)`).runInNewContext(
      {
        options: {
          reducedMotion: () => true,
          visible: () => true,
          onFrame: (...args: unknown[]) => frames.push(args),
          onState: () => undefined,
        },
        input: transition(),
      },
    );
    expect(frames).toEqual([[transition().to, 1]]);
  });
});

describe("feature-local thread routing", () => {
  it("keeps the original wool path byte-identical by default and preserves endpoints while routing locally", () => {
    const from = { x: 280, y: 150, z: 0 },
      to = { x: 320, y: 180, z: 0 };
    const camera = { yaw: 0, pitch: 0 };
    const wool = createFeatureThread(from, to, camera, 0.7);
    expect(createHash("sha256").update(wool).digest("hex")).toBe(
      "8dca33d49d99d2b45e5b46ef5e1c76a053d965e2c51bc008d600dfc49f9e5929",
    );
    expect(createFeatureThread(from, to, camera, 0.7, 0)).toBe(wool);
    expect(createFeatureThread(from, to, camera, 0.7, NaN)).toBe(wool);
    const grouped = createFeatureThread(from, to, camera, 0.7, 1);
    expect(grouped.startsWith("M930.00,560.00 ")).toBe(true);
    expect(grouped.endsWith("L970.00,590.00")).toBe(true);
    const coordinates = [...grouped.matchAll(/[ML]([\d.-]+),([\d.-]+)/gu)].map((match) => [
      Number(match[1]),
      Number(match[2]),
    ]);
    expect(coordinates).toHaveLength(19);
    expect(coordinates.every(([x, y]) => x! >= 930 && x! <= 971 && y! >= 560 && y! <= 591)).toBe(
      true,
    );
    expect(wool).not.toBe(grouped);
    expect(createFeatureThread(from, to, camera, 0.7, 0.5)).not.toBe(wool);
    expect(createFeatureThread(from, to, camera, 0.7, 0.5)).not.toBe(grouped);
  });
});
