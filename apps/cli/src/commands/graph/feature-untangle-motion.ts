import type { FeaturePoint3D } from "./feature-3d.js";

export interface FeatureUntangleState {
  phase: "idle" | "running" | "paused" | "complete";
  target: "wool" | "clusters";
  progress: number;
}

export interface FeatureUntangleTransition {
  from: Readonly<Record<string, FeaturePoint3D>>;
  to: Readonly<Record<string, FeaturePoint3D>>;
  fromAmount: number;
  toAmount: number;
  target: "wool" | "clusters";
}

export interface FeatureUntangleMotionOptions {
  requestFrame?: (callback: (timestamp: number) => void) => number;
  cancelFrame?: (id: number) => void;
  reducedMotion: () => boolean;
  visible: () => boolean;
  onFrame: (positions: Record<string, FeaturePoint3D>, clusterAmount: number) => void;
  onState: (state: FeatureUntangleState) => void;
  durationMs?: number;
  frameIntervalMs?: number;
}

/** Self-contained for the offline viewer's CSP-hashed serialized runtime. */
export function createFeatureUntangleMotion(options: FeatureUntangleMotionOptions) {
  const duration = Math.max(1, options.durationMs ?? 2600);
  const interval = Math.max(33, Math.min(160, options.frameIntervalMs ?? 33));
  if (!Number.isFinite(duration) || !Number.isFinite(interval))
    throw new RangeError("Untangling requires bounded timing.");
  let phase: FeatureUntangleState["phase"] = "idle";
  let target: FeatureUntangleState["target"] = "clusters";
  let transition: FeatureUntangleTransition | null = null;
  let elapsed = 0;
  let lastTimestamp: number | null = null;
  let lastPaint = -Infinity;
  let frame: number | null = null;
  let generation = 0;

  function getState(): FeatureUntangleState {
    return { phase, target, progress: Math.min(1, elapsed / duration) };
  }

  function announce() {
    options.onState(getState());
  }

  function clearFrame() {
    generation += 1;
    if (frame !== null) options.cancelFrame?.(frame);
    frame = null;
    lastTimestamp = null;
  }

  function render(progress: number) {
    if (!transition) return;
    const eased = 1 - (1 - progress) ** 3;
    const positions: Record<string, FeaturePoint3D> = Object.create(null) as Record<
      string,
      FeaturePoint3D
    >;
    for (const id of Object.keys(transition.from)) {
      const from = transition.from[id]!;
      const to = transition.to[id]!;
      positions[id] =
        progress === 1
          ? { ...to }
          : progress === 0
            ? { ...from }
            : {
                x: from.x + (to.x - from.x) * eased,
                y: from.y + (to.y - from.y) * eased,
                z: from.z + (to.z - from.z) * eased,
              };
    }
    try {
      options.onFrame(
        positions,
        transition.fromAmount + (transition.toAmount - transition.fromAmount) * eased,
      );
    } catch (error) {
      clearFrame();
      phase = "paused";
      announce();
      throw error;
    }
  }

  function schedule() {
    if (phase !== "running" || frame !== null || !options.requestFrame) return;
    const token = generation;
    frame = options.requestFrame((timestamp) => {
      if (token !== generation || phase !== "running") return;
      frame = null;
      if (options.reducedMotion()) {
        finish();
        return;
      }
      if (!options.visible()) {
        pause();
        return;
      }
      if (lastTimestamp !== null) elapsed += Math.max(0, timestamp - lastTimestamp);
      lastTimestamp = timestamp;
      if (elapsed >= duration) {
        finish();
        return;
      }
      if (timestamp - lastPaint >= interval) {
        render(elapsed / duration);
        lastPaint = timestamp;
      }
      schedule();
    });
  }

  function finish() {
    if (!transition || phase === "complete") return;
    clearFrame();
    elapsed = duration;
    phase = "complete";
    render(1);
    announce();
  }

  function pause() {
    if (phase !== "running") return;
    clearFrame();
    phase = "paused";
    announce();
  }

  function resume() {
    if (phase !== "paused") return;
    if (options.reducedMotion() || !options.requestFrame) {
      finish();
      return;
    }
    if (!options.visible()) return;
    phase = "running";
    announce();
    schedule();
  }

  function cancel() {
    clearFrame();
    transition = null;
    elapsed = 0;
    phase = "idle";
    announce();
  }

  function start(input: FeatureUntangleTransition) {
    const ids = Object.keys(input.from).sort();
    const targets = Object.keys(input.to).sort();
    if (ids.length !== targets.length || ids.some((id, index) => id !== targets[index]))
      throw new Error("Untangling must preserve every node identity.");
    for (const collection of [input.from, input.to]) {
      for (const point of Object.values(collection)) {
        if (![point.x, point.y, point.z].every(Number.isFinite))
          throw new Error("Untangling requires finite coordinates.");
      }
    }
    if (
      ![input.fromAmount, input.toAmount].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 1,
      )
    )
      throw new Error("Invalid clustering amount.");
    clearFrame();
    const copy = (points: Readonly<Record<string, FeaturePoint3D>>) =>
      Object.fromEntries(Object.entries(points).map(([id, point]) => [id, { ...point }]));
    transition = { ...input, from: copy(input.from), to: copy(input.to) };
    elapsed = 0;
    lastPaint = -Infinity;
    target = input.target;
    phase = "running";
    if (ids.length === 0 || options.reducedMotion() || !options.requestFrame) {
      finish();
      return;
    }
    render(0);
    if (!options.visible()) phase = "paused";
    announce();
    schedule();
  }

  return { start, pause, resume, finish, cancel, getState };
}
