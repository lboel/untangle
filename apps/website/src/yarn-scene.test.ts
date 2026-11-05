import { describe, expect, it } from "vitest";

import {
  createYarnGeometry,
  createYarnScene,
  projectPoint,
  rotatePoint,
  scenePose,
  unfoldPoint,
} from "./yarn-scene.js";

class DrawingContext {
  strokes = 0;
  clears = 0;
  transforms: number[][] = [];
  segments: number[][] = [];
  labels: { text: string; x: number; y: number }[] = [];
  currentSegment: number[] = [];

  setTransform(...values: number[]) {
    this.transforms.push(values);
  }
  clearRect() {
    this.clears += 1;
    this.segments = [];
    this.labels = [];
  }
  beginPath() {
    this.currentSegment = [];
  }
  moveTo(x: number, y: number) {
    this.currentSegment.push(x, y);
  }
  lineTo(x: number, y: number) {
    this.currentSegment.push(x, y);
  }
  stroke() {
    this.strokes += 1;
    if (this.currentSegment.length === 4) this.segments.push([...this.currentSegment]);
  }
  fillText(text: string, x: number, y: number) {
    this.labels.push({ text, x, y });
  }
  measureText(text: string) {
    return { width: text.length * 7 };
  }
  save() {}
  restore() {}
  ellipse() {}
  arc() {}
  fill() {}
  strokeText() {}
}

function canvasHarness() {
  const context = new DrawingContext();
  const canvas = { width: 0, height: 0, getContext: () => context };
  const scene = createYarnScene(canvas);
  expect(scene).not.toBeNull();
  return { context, canvas, scene: scene! };
}

describe("Spatial yarn illustration", () => {
  it("builds deterministic three-dimensional strands within its fixed rendering budget", () => {
    const first = createYarnGeometry();
    expect(first).toEqual(createYarnGeometry());
    expect(first.segmentBudget).toBeLessThanOrEqual(4_000);
    expect(first.roles.map((role: { label: string }) => role.label)).toEqual([
      "Spec",
      "Feature",
      "Code",
      "Tests",
      "Owner",
    ]);
    const points = first.strands.flatMap(
      (strand: { points: { x: number; y: number; z: number }[] }) => strand.points,
    );
    expect(
      points.every((point: { x: number; y: number; z: number }) =>
        [point.x, point.y, point.z].every(Number.isFinite),
      ),
    ).toBe(true);
    expect(Math.min(...points.map((point: { z: number }) => point.z))).toBeLessThan(-0.95);
    expect(Math.max(...points.map((point: { z: number }) => point.z))).toBeGreaterThan(0.95);
  });

  it("uses perspective depth and real spatial rotation rather than a planar image transform", () => {
    const near = projectPoint({ x: 1, y: 0, z: 1 }, 600, 500)!;
    const far = projectPoint({ x: 1, y: 0, z: -1 }, 600, 500)!;
    expect(near.x - 300).toBeGreaterThan(far.x - 300);
    expect(near.scale).toBeGreaterThan(far.scale);
    const turned = rotatePoint({ x: 1, y: 0, z: 0 }, Math.PI / 2);
    expect(turned.x).toBeCloseTo(0);
    expect(turned.z).toBeCloseTo(-1);
    expect(projectPoint({ x: 0, y: 0, z: 4.8 }, 600, 500)).toBeNull();
    expect(projectPoint({ x: NaN, y: 0, z: 0 }, 600, 500)).toBeNull();
  });

  it("clamps scroll state and resolves the weave into distinct declared responsibility bundles", () => {
    expect(scenePose({ progress: -8 }).unfold).toBe(0);
    expect(scenePose({ progress: 8 }).unfold).toBe(1);
    expect(scenePose({ progress: NaN, time: Infinity }).yaw).toBe(-0.3);
    const geometry = createYarnGeometry();
    const point = { x: 0, y: 0, z: 0 };
    const bundles = [0, 1, 2, 3].map((group) => unfoldPoint(point, group, 1));
    expect(new Set(bundles.map((item) => JSON.stringify(item))).size).toBe(4);
    expect(bundles[0]).toEqual({
      x: geometry.roles[1].x,
      y: geometry.roles[1].y,
      z: geometry.roles[1].z,
    });
    expect(unfoldPoint(point, 0, 0)).toEqual(unfoldPoint(point, 3, 0));
  });

  it("provides a genuinely fixed reduced-motion composition while chapter emphasis may change", () => {
    const { scene, context } = canvasHarness();
    scene.resize({ width: 540, height: 500, dpr: 1 });
    scene.draw({ progress: 0, yaw: 1, pitch: 0.5, phase: 0, motion: false, time: 0 });
    const initial = context.segments.map((segment) => [...segment]);
    scene.draw({ progress: 1, yaw: -1, pitch: -0.5, phase: 3, motion: false, time: 300 });
    expect(context.segments).toEqual(initial);
    expect(context.labels.map((label) => label.text)).toEqual([
      "Spec",
      "Feature",
      "Code",
      "Tests",
      "Owner",
    ]);
  });

  it("renders bounded finite geometry and legible in-frame labels on narrow and desktop canvases", () => {
    for (const size of [
      { width: 320, height: 300 },
      { width: 760, height: 620 },
    ]) {
      const { scene, context } = canvasHarness();
      scene.resize({ ...size, dpr: 2 });
      for (const progress of [0, 0.25, 0.55, 0.8, 1]) {
        const before = context.strokes;
        scene.draw({ progress, yaw: 0.2, pitch: -0.1, phase: 2, motion: true, time: 40 });
        expect(context.strokes - before).toBeLessThanOrEqual(
          createYarnGeometry().segmentBudget * 3,
        );
        expect(context.segments.flat().every(Number.isFinite)).toBe(true);
        for (const label of context.labels) {
          expect(label.x).toBeGreaterThan(0);
          expect(label.x).toBeLessThan(size.width);
          expect(label.y).toBeGreaterThan(0);
          expect(label.y).toBeLessThan(size.height);
        }
      }
    }
  });

  it("caps backing-store density and stops drawing after idempotent destruction", () => {
    const { scene, canvas, context } = canvasHarness();
    scene.resize({ width: 600, height: 400, dpr: 8 });
    expect([canvas.width, canvas.height]).toEqual([1200, 800]);
    expect(context.transforms.at(-1)).toEqual([2, 0, 0, 2, 0, 0]);
    scene.draw({ progress: 0.5 });
    const strokes = context.strokes;
    expect(strokes).toBeGreaterThan(0);
    scene.destroy();
    const clears = context.clears;
    scene.destroy();
    scene.draw({ progress: 1 });
    scene.resize({ width: 800, height: 600, dpr: 1 });
    expect(context.strokes).toBe(strokes);
    expect(context.clears).toBe(clears);
    expect(canvas.width).toBe(1200);
  });

  it("declines unsupported Canvas contexts without taking away the authored image fallback", () => {
    expect(createYarnScene({})).toBeNull();
    expect(createYarnScene({ getContext: () => null })).toBeNull();
    expect(
      createYarnScene({
        getContext: () => {
          throw new Error("Canvas disabled");
        },
      }),
    ).toBeNull();
  });
});
