import type { FeaturePoint3D } from "./feature-3d.js";
import type { FeatureMapEdgeV1, FeatureMapNodeV1 } from "./feature-model.js";

export type CategoryClusterDimension = "code" | "test" | "owner" | "intent" | "unmapped";
export type CategoryClusterNode = Pick<FeatureMapNodeV1, "id" | "kind"> &
  Partial<Pick<FeatureMapNodeV1, "label" | "path" | "details" | "status">>;

export interface CategoryClusterGroup {
  id: string;
  kind: "category" | "shared" | "unassigned";
  label: string;
  center: FeaturePoint3D;
  memberIds: string[];
}

export interface CategoryClusterLayout {
  positions: Record<string, FeaturePoint3D>;
  groups: CategoryClusterGroup[];
  memberships: Record<string, string[]>;
  description: string;
}

/** Self-contained browser geometry; context paths are declarations, never inferred ownership. */
export function createCategoryClusterLayout(
  nodes: readonly CategoryClusterNode[],
  edges: readonly Pick<FeatureMapEdgeV1, "from" | "to" | "kind">[],
  dimension: CategoryClusterDimension,
): CategoryClusterLayout {
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const descriptions: Record<CategoryClusterDimension, string> = {
    code: "Code areas use repository-relative directories. Other nodes show declared feature context.",
    test: "Test areas use repository-relative directories. Other nodes show declared feature context.",
    owner:
      "Ownership groups use declared roles and feature scopes. They do not establish file ownership.",
    intent:
      "Vision / Spec groups use source paths and declared feature scopes, not semantic similarity.",
    unmapped:
      "Unassigned files use repository-relative directories. Declared context stays separate.",
  };
  if (!Object.hasOwn(descriptions, dimension)) throw new RangeError("Unknown grouping category.");
  const ordered = [...nodes].sort((a, b) => compare(a.id, b.id));
  const byId = new Map(ordered.map((node) => [node.id, node]));
  const features = new Set(
    ordered.filter((node) => node.kind === "feature").map((node) => node.id),
  );
  const memberships: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const positions: Record<string, FeaturePoint3D> = Object.create(null) as Record<
    string,
    FeaturePoint3D
  >;
  const buckets = new Map<string, { label: string; sortKey: string; memberIds: string[] }>();
  const anchorBuckets = new Map<string, string>();
  const featureBuckets = new Map([...features].map((id) => [id, new Set<string>()]));
  const linkedFeatures = new Map(ordered.map((node) => [node.id, new Set<string>()]));
  const compatible: Record<FeatureMapNodeV1["kind"], readonly FeatureMapEdgeV1["kind"][]> = {
    feature: [],
    code: ["code", "test"],
    test: ["code", "test"],
    owner: ["ownership"],
    intent: ["intent"],
    unmapped: [],
  };
  const targetRelations: Record<CategoryClusterDimension, FeatureMapEdgeV1["kind"] | null> = {
    code: "code",
    test: "test",
    owner: "ownership",
    intent: "intent",
    unmapped: null,
  };

  for (const node of ordered) {
    const roles = node.details?.["roles"];
    const hasRole = (role: string): boolean =>
      (node.kind === "code" || node.kind === "test") &&
      Array.isArray(roles) &&
      roles.includes(role);
    const anchor =
      dimension === "code"
        ? node.kind === "code" || node.kind === "unmapped" || hasRole("code")
        : dimension === "test"
          ? node.kind === "test" || hasRole("test")
          : node.kind === dimension;
    if (!anchor) continue;
    let key: string;
    let label: string;
    if (dimension === "owner") {
      key = node.id;
      label = node.label || node.id;
      if (node.status === "missing") label += " (missing ownership)";
    } else if (dimension === "intent") {
      key = node.path || "(no source path)";
      label = node.path || "Intent without a source path";
    } else if (!node.path) {
      key = "(no source path)";
      label = "Files without a source path";
    } else {
      const directories = node.path.replaceAll("\\", "/").split("/").slice(0, -1);
      key = directories.slice(0, 2).join("/") || ".";
      label = key === "." ? "Repository root" : key;
    }
    const id = dimension !== "owner" && !node.path ? `missing:${dimension}` : `${dimension}:${key}`;
    if (!buckets.has(id)) buckets.set(id, { label, sortKey: key, memberIds: [] });
    anchorBuckets.set(node.id, id);
  }

  if (dimension !== "unmapped") {
    for (const edge of edges) {
      const fromFeature = features.has(edge.from);
      const toFeature = features.has(edge.to);
      if (fromFeature === toFeature) continue;
      const feature = fromFeature ? edge.from : edge.to;
      const member = byId.get(fromFeature ? edge.to : edge.from);
      if (!member || !compatible[member.kind].includes(edge.kind)) continue;
      linkedFeatures.get(member.id)!.add(feature);
      const bucket = anchorBuckets.get(member.id);
      if (bucket !== undefined && edge.kind === targetRelations[dimension])
        featureBuckets.get(feature)!.add(bucket);
    }
  }

  const shared: string[] = [];
  const outside: string[] = [];
  for (const node of ordered) {
    const anchor = anchorBuckets.get(node.id);
    const categories =
      anchor !== undefined
        ? [anchor]
        : [
            ...new Set(
              (node.kind === "feature" ? [node.id] : [...linkedFeatures.get(node.id)!]).flatMap(
                (id) => [...featureBuckets.get(id)!],
              ),
            ),
          ].sort(compare);
    memberships[node.id] = categories;
    if (categories.length === 1) buckets.get(categories[0]!)!.memberIds.push(node.id);
    else if (categories.length > 1) shared.push(node.id);
    else outside.push(node.id);
  }

  const primary = [...buckets].sort(
    ([a, first], [b, second]) => compare(first.sortKey, second.sortKey) || compare(a, b),
  );
  const columns = Math.max(1, Math.ceil(Math.sqrt(primary.length * 1.3)));
  const rows = Math.ceil(primary.length / columns);
  const stepX = Math.min(140, 700 / Math.max(1, columns - 1));
  const stepY = Math.min(110, 400 / Math.max(1, rows - 1));
  const radius = primary.length === 1 ? 140 : Math.min(50, Math.min(stepX, stepY) * 0.4);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const groups: CategoryClusterGroup[] = [];

  function placeMembers(ids: readonly string[], center: FeaturePoint3D, extent: number): void {
    ids.forEach((id, index) => {
      const orbit = extent * (0.12 + 0.88 * Math.sqrt((index + 0.5) / ids.length));
      const kind = byId.get(id)!.kind;
      const depth = kind === "test" ? 1 : kind === "owner" ? 0.5 : kind === "intent" ? -0.5 : -1;
      positions[id] = {
        x: center.x + Math.cos(index * goldenAngle) * orbit,
        y: center.y + Math.sin(index * goldenAngle) * orbit,
        z: center.z + extent * (depth * 0.2 + ((index % 7) - 3) * 0.035),
      };
    });
  }

  primary.forEach(([id, bucket], index) => {
    const row = Math.floor(index / columns);
    const rowSize = Math.min(columns, primary.length - row * columns);
    const center = {
      x: ((index % columns) - (rowSize - 1) / 2) * stepX,
      y: -65 + (row - (rows - 1) / 2) * stepY,
      z: ((index % 3) - 1) * 12,
    };
    placeMembers(bucket.memberIds, center, radius);
    groups.push({ id, kind: "category", label: bucket.label, center, memberIds: bucket.memberIds });
  });

  function addContext(kind: "shared" | "unassigned", label: string, ids: string[], x: number) {
    if (ids.length === 0) return;
    const center = primary.length === 0 ? { x: 0, y: 0, z: 0 } : { x, y: 270, z: 0 };
    const extent = primary.length === 0 ? 190 : Math.min(85, 65 + Math.sqrt(ids.length) * 0.75);
    placeMembers(ids, center, extent);
    groups.push({ id: `context:${dimension}:${kind}`, kind, label, center, memberIds: ids });
  }
  const outsideLabels: Record<CategoryClusterDimension, string> = {
    code: "Outside declared code context",
    test: "Outside declared test context",
    owner: "No declared ownership context",
    intent: "No declared vision / spec context",
    unmapped: "Declared context",
  };
  addContext("shared", "Shared context", shared, -175);
  addContext("unassigned", outsideLabels[dimension], outside, 175);
  return { positions, groups, memberships, description: descriptions[dimension] };
}
