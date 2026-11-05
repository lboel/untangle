import type { FeatureMapEdgeV1, FeatureMapNodeV1 } from "./feature-model.js";

export interface FeaturePoint3D {
  x: number;
  y: number;
  z: number;
}

export interface FeatureCamera3D {
  yaw: number;
  pitch: number;
}

/** Stable spatial grouping follows declared edges. Distance is a layout choice, not evidence. */
export function createFeatureWoolLayout(
  nodes: readonly Pick<FeatureMapNodeV1, "id" | "kind">[],
  edges: readonly Pick<FeatureMapEdgeV1, "from" | "to">[],
): Record<string, FeaturePoint3D> {
  const positions: Record<string, FeaturePoint3D> = Object.create(null) as Record<
    string,
    FeaturePoint3D
  >;
  const ordered = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const features = ordered.filter((node) => node.kind === "feature");
  const featureIds = new Set(features.map((node) => node.id));
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (featureIds.has(edge.from)) {
      if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
      adjacency.get(edge.to)!.add(edge.from);
    }
    if (featureIds.has(edge.to)) {
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
      adjacency.get(edge.from)!.add(edge.to);
    }
  }
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  function sphere(index: number, count: number, radius: number): FeaturePoint3D {
    const y = 1 - (2 * (index + 0.5)) / Math.max(1, count);
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    return {
      x: Math.cos(index * goldenAngle) * ring * radius,
      y: y * radius,
      z: Math.sin(index * goldenAngle) * ring * radius,
    };
  }
  features.forEach((node, index) => {
    positions[node.id] =
      features.length === 1 ? { x: 0, y: 0, z: 0 } : sphere(index, features.length, 200);
  });
  const other = ordered.filter((node) => node.kind !== "feature");
  other.forEach((node, index) => {
    const linked = [...(adjacency.get(node.id) ?? [])].sort();
    if (linked.length === 0) {
      positions[node.id] = sphere(index, other.length, 335 + (index % 7) * 5);
      return;
    }
    const center = { x: 0, y: 0, z: 0 };
    for (const id of linked) {
      const point = positions[id]!;
      center.x += point.x / linked.length;
      center.y += point.y / linked.length;
      center.z += point.z / linked.length;
    }
    const radius = node.kind === "code" ? 88 : node.kind === "test" ? 118 : 150;
    const offset = sphere(index, other.length, radius + (index % 11) * 2);
    positions[node.id] = {
      x: center.x + offset.x,
      y: center.y + offset.y,
      z: center.z + offset.z,
    };
  });
  return positions;
}

/** Rotate in world space, then project with a camera outside every bounded layout point. */
export function projectFeaturePoint(
  point: FeaturePoint3D,
  camera: FeatureCamera3D,
): { x: number; y: number; depth: number; scale: number } {
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const x = point.x * cosYaw + point.z * sinYaw;
  const z = point.z * cosYaw - point.x * sinYaw;
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const y = point.y * cosPitch - z * sinPitch;
  const depth = point.y * sinPitch + z * cosPitch;
  const scale = 1000 / (1000 - depth);
  return { x: 650 + x * scale, y: 410 + y * scale, depth, scale };
}

/** Sample a cubic thread in 3D before projection; rotation changes the whole thread. */
export function createFeatureThread(
  from: FeaturePoint3D,
  to: FeaturePoint3D,
  camera: FeatureCamera3D,
  winding: number,
  grouping = 0,
): string {
  const twist = Math.max(-1, Math.min(1, winding)) * 90;
  const a = { x: from.x * 0.35 + twist, y: from.y * 0.35 - twist, z: from.z * 0.35 + twist };
  const b = { x: to.x * 0.35 - twist, y: to.y * 0.35 + twist, z: to.z * 0.35 - twist };
  const amount = Number.isFinite(grouping) ? Math.max(0, Math.min(1, grouping)) : 0;
  if (amount > 0) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dy, dz);
    const bend = Math.max(-1, Math.min(1, winding)) * Math.min(24, length * 0.12);
    const normal = Math.hypot(dx, dy) || 1;
    const offset = { x: (-dy / normal) * bend, y: (dx / normal) * bend, z: bend * 0.35 };
    const localA = {
      x: from.x + dx / 3 + offset.x,
      y: from.y + dy / 3 + offset.y,
      z: from.z + dz / 3 + offset.z,
    };
    const localB = {
      x: from.x + (dx * 2) / 3 + offset.x,
      y: from.y + (dy * 2) / 3 + offset.y,
      z: from.z + (dz * 2) / 3 + offset.z,
    };
    for (const coordinate of ["x", "y", "z"] as const) {
      a[coordinate] += (localA[coordinate] - a[coordinate]) * amount;
      b[coordinate] += (localB[coordinate] - b[coordinate]) * amount;
    }
  }
  const parts: string[] = [];
  for (let i = 0; i <= 18; i += 1) {
    const t = i / 18;
    const s = 1 - t;
    const point = {
      x: s ** 3 * from.x + 3 * s ** 2 * t * a.x + 3 * s * t ** 2 * b.x + t ** 3 * to.x,
      y: s ** 3 * from.y + 3 * s ** 2 * t * a.y + 3 * s * t ** 2 * b.y + t ** 3 * to.y,
      z: s ** 3 * from.z + 3 * s ** 2 * t * a.z + 3 * s * t ** 2 * b.z + t ** 3 * to.z,
    };
    const projected = projectFeaturePoint(point, camera);
    parts.push(`${i === 0 ? "M" : "L"}${projected.x.toFixed(2)},${projected.y.toFixed(2)}`);
  }
  return parts.join(" ");
}
