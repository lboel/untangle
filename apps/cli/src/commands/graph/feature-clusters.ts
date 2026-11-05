import type { FeaturePoint3D } from "./feature-3d.js";
import type { FeatureMapEdgeV1, FeatureMapNodeV1 } from "./feature-model.js";

export interface FeatureClusterGroup {
  id: string;
  kind: "feature" | "shared" | "unassigned";
  featureId?: string;
  center: FeaturePoint3D;
  memberIds: string[];
}

export interface FeatureClusterLayout {
  positions: Record<string, FeaturePoint3D>;
  groups: FeatureClusterGroup[];
  memberships: Record<string, string[]>;
}

/** Declared membership determines each island; spatial distance proves nothing beyond layout. */
export function createFeatureClusterLayout(
  nodes: readonly Pick<FeatureMapNodeV1, "id" | "kind">[],
  edges: readonly Pick<FeatureMapEdgeV1, "from" | "to" | "kind">[],
): FeatureClusterLayout {
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const ordered = [...nodes].sort((a, b) => compare(a.id, b.id));
  const byId = new Map(ordered.map((node) => [node.id, node]));
  const features = ordered.filter((node) => node.kind === "feature");
  const featureIds = new Set(features.map((node) => node.id));
  const linked = new Map(ordered.map((node) => [node.id, new Set<string>()]));
  const relations: Record<FeatureMapNodeV1["kind"], readonly FeatureMapEdgeV1["kind"][]> = {
    feature: [],
    code: ["code", "test"],
    test: ["code", "test"],
    owner: ["ownership"],
    intent: ["intent"],
    unmapped: [],
  };
  for (const edge of edges) {
    const fromFeature = featureIds.has(edge.from);
    const toFeature = featureIds.has(edge.to);
    if (fromFeature === toFeature) continue;
    const member = byId.get(fromFeature ? edge.to : edge.from);
    if (!member || !relations[member.kind].includes(edge.kind)) continue;
    linked.get(member.id)!.add(fromFeature ? edge.from : edge.to);
  }

  const positions: Record<string, FeaturePoint3D> = Object.create(null) as Record<
    string,
    FeaturePoint3D
  >;
  const memberships: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const exclusive = new Map(features.map((feature) => [feature.id, [] as string[]]));
  const shared: string[] = [];
  const unassigned: string[] = [];
  for (const node of ordered) {
    const ids = node.kind === "feature" ? [node.id] : [...linked.get(node.id)!].sort(compare);
    memberships[node.id] = ids;
    if (node.kind === "feature") continue;
    if (ids.length === 1) exclusive.get(ids[0]!)!.push(node.id);
    else if (ids.length > 1) shared.push(node.id);
    else unassigned.push(node.id);
  }

  const columns = Math.max(1, Math.ceil(Math.sqrt(features.length * 1.3)));
  const rows = Math.ceil(features.length / columns);
  const stepX = Math.min(140, 700 / Math.max(1, columns - 1));
  const stepY = Math.min(110, 400 / Math.max(1, rows - 1));
  const featureRadius = features.length === 1 ? 140 : Math.min(50, Math.min(stepX, stepY) * 0.4);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const groups: FeatureClusterGroup[] = [];

  function placeMembers(
    ids: readonly string[],
    center: FeaturePoint3D,
    radius: number,
    anchored: boolean,
  ): void {
    ids.forEach((id, index) => {
      const fraction = Math.sqrt((index + 0.5) / ids.length);
      const orbit = radius * ((anchored ? 0.62 : 0.12) + (anchored ? 0.38 : 0.88) * fraction);
      const node = byId.get(id)!;
      const depth =
        node.kind === "test" ? 1 : node.kind === "owner" ? 0.5 : node.kind === "intent" ? -0.5 : -1;
      positions[id] = {
        x: center.x + Math.cos(index * goldenAngle) * orbit,
        y: center.y + Math.sin(index * goldenAngle) * orbit,
        z: center.z + radius * (depth * 0.2 + ((index % 7) - 3) * 0.035),
      };
    });
  }

  features.forEach((feature, index) => {
    const row = Math.floor(index / columns);
    const rowSize = Math.min(columns, features.length - row * columns);
    const center = {
      x: ((index % columns) - (rowSize - 1) / 2) * stepX,
      y: -45 + (row - (rows - 1) / 2) * stepY,
      z: ((index % 3) - 1) * 12,
    };
    const members = exclusive.get(feature.id)!;
    positions[feature.id] = { ...center };
    placeMembers(members, center, featureRadius, true);
    groups.push({
      id: `feature:${feature.id}`,
      kind: "feature",
      featureId: feature.id,
      center,
      memberIds: [feature.id, ...members],
    });
  });

  function addContextGroup(
    kind: "shared" | "unassigned",
    ids: string[],
    x: number,
    z: number,
  ): void {
    if (ids.length === 0) return;
    const center = features.length === 0 ? { x: 0, y: 0, z: 0 } : { x, y: 285, z };
    placeMembers(ids, center, features.length === 0 ? 190 : 70, false);
    groups.push({ id: kind, kind, center, memberIds: [...ids] });
  }
  addContextGroup("shared", shared, -175, 35);
  addContextGroup("unassigned", unassigned, 175, -35);
  return { positions, groups, memberships };
}
