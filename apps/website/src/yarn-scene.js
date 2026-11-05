/**
 * A deterministic, illustrative 3D weave. Perspective, occlusion and lighting
 * come from spatial coordinates; this scene contains no repository measurements.
 * The caller owns animation scheduling, visibility and motion preferences.
 */
const TAU = Math.PI * 2;
const CAMERA_DISTANCE = 4.8;
const STRAND_COUNT = 34;
const SEGMENTS_PER_STRAND = 72;
const THREAD_SEGMENTS = 96;
const LINK_SEGMENTS = 24;

const ROLES = [
  { label: "Spec", x: -1.18, y: -0.65, z: 0.06 },
  { label: "Feature", x: -0.12, y: -0.02, z: 0.15 },
  { label: "Code", x: 1.02, y: -0.57, z: 0.03 },
  { label: "Tests", x: 1.06, y: 0.62, z: 0.12 },
  { label: "Owner", x: -1.02, y: 0.65, z: -0.04 },
];
const BUNDLES = [ROLES[1], ROLES[2], ROLES[3], ROLES[4]];
const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const clamp = (value, min, max) => Math.max(min, Math.min(max, finite(value, min)));
const mix = (a, b, amount) => a + (b - a) * amount;
const smooth = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

export function scenePose(input = {}) {
  const motion = input.motion !== false;
  const progress = motion ? clamp(input.progress, 0, 1) : 1;
  const unfold = smooth((progress - 0.32) / 0.58);
  const time = motion ? finite(input.time) : 0;
  return {
    progress,
    unfold,
    yaw: motion ? -0.3 + progress * 0.6 + finite(input.yaw) : -0.1,
    pitch: motion ? -0.12 + finite(input.pitch) + Math.sin(time * 0.35) * 0.018 : -0.06,
    phase: Math.round(clamp(input.phase, 0, 3)),
  };
}

export function rotatePoint(point, yaw = 0, pitch = 0) {
  const cy = Math.cos(finite(yaw));
  const sy = Math.sin(finite(yaw));
  const cp = Math.cos(finite(pitch));
  const sp = Math.sin(finite(pitch));
  const x = point.x * cy + point.z * sy;
  const z = -point.x * sy + point.z * cy;
  return { x, y: point.y * cp - z * sp, z: point.y * sp + z * cp };
}

/** Points at or behind the camera are clipped rather than projected to infinity. */
export function projectPoint(point, width, height, enlargement = 1) {
  if (![point.x, point.y, point.z, width, height].every(Number.isFinite)) return null;
  if (point.z >= CAMERA_DISTANCE - 0.2 || width <= 0 || height <= 0) return null;
  const perspective = CAMERA_DISTANCE / (CAMERA_DISTANCE - point.z);
  const scale = Math.min(width / 3.9, height / 3.4) * enlargement;
  return {
    x: width * 0.5 + point.x * scale * perspective,
    y: height * 0.46 + point.y * scale * perspective,
    z: point.z,
    scale: scale * perspective,
  };
}

export function createYarnGeometry() {
  const strands = [];
  for (let strand = 0; strand < STRAND_COUNT; strand += 1) {
    const tilt = 0.24 + (strand / STRAND_COUNT) * 2.55;
    const bearing = strand * 2.399963229728653;
    const group = strand % BUNDLES.length;
    const points = [];
    for (let step = 0; step <= SEGMENTS_PER_STRAND; step += 1) {
      const angle = (step / SEGMENTS_PER_STRAND) * TAU;
      const latitude = Math.sin(angle) * Math.sin(tilt);
      const localX = Math.cos(angle);
      const localZ = Math.sin(angle) * Math.cos(tilt);
      const radius = 1.02 + (strand % 5) * 0.009 + Math.sin(angle * 5 + strand) * 0.009;
      points.push({
        x: (localX * Math.cos(bearing) - localZ * Math.sin(bearing)) * radius,
        y: latitude * radius,
        z: (localX * Math.sin(bearing) + localZ * Math.cos(bearing)) * radius,
      });
    }
    strands.push({ group, points });
  }
  return {
    strands,
    roles: ROLES.map((role) => ({ ...role })),
    segmentBudget: STRAND_COUNT * SEGMENTS_PER_STRAND + THREAD_SEGMENTS + 4 * LINK_SEGMENTS,
  };
}

export function unfoldPoint(point, group, unfold) {
  const center = BUNDLES[group];
  const radius = group === 0 ? 0.38 : 0.19;
  return {
    x: mix(point.x, center.x + point.x * radius, unfold),
    y: mix(point.y - 0.04, center.y + point.y * radius, unfold),
    z: mix(point.z, center.z + point.z * radius, unfold),
  };
}

function cubicPoint(a, b, c, d, t) {
  const s = 1 - t;
  return {
    x: s ** 3 * a.x + 3 * s ** 2 * t * b.x + 3 * s * t ** 2 * c.x + t ** 3 * d.x,
    y: s ** 3 * a.y + 3 * s ** 2 * t * b.y + 3 * s * t ** 2 * c.y + t ** 3 * d.y,
    z: s ** 3 * a.z + 3 * s ** 2 * t * b.z + 3 * s * t ** 2 * c.z + t ** 3 * d.z,
  };
}

function palettes() {
  return Array.from({ length: 12 }, (_, index) => {
    const light = index / 11;
    return {
      green: `oklch(${0.24 + light * 0.23} 0.065 184)`,
      greenLight: `oklch(${0.39 + light * 0.23} 0.075 181)`,
      copper: `oklch(${0.48 + light * 0.22} 0.16 44)`,
      copperLight: `oklch(${0.68 + light * 0.12} 0.12 58)`,
    };
  });
}

/** The renderer has no event listeners, timers, animation frames or network access. */
export function createYarnScene(canvas) {
  let context;
  try {
    context = canvas?.getContext?.("2d", { alpha: true });
  } catch {
    return null;
  }
  if (!context) return null;

  const geometry = createYarnGeometry();
  const colors = palettes();
  const frame = Array.from({ length: geometry.segmentBudget }, () => ({}));
  let width = 1;
  let height = 1;
  let destroyed = false;
  let used = 0;

  function resize(size = {}) {
    if (destroyed) return;
    width = clamp(size.width, 1, 2048);
    height = clamp(size.height, 1, 2048);
    const dpr = clamp(size.dpr ?? 1, 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.lineCap = "round";
    context.lineJoin = "round";
  }

  function project(point, pose) {
    return projectPoint(
      rotatePoint(point, pose.yaw, pose.pitch),
      width,
      height,
      1.2 - pose.unfold * 0.2,
    );
  }

  function addSegment(a, b, pose, copper, thickness, opacity, light) {
    const first = project(a, pose);
    const second = project(b, pose);
    if (!first || !second || opacity <= 0) return;
    const segment = frame[used];
    segment.x1 = first.x;
    segment.y1 = first.y;
    segment.x2 = second.x;
    segment.y2 = second.y;
    segment.z = (first.z + second.z) / 2;
    segment.width = ((first.scale + second.scale) / 2) * thickness;
    segment.copper = copper;
    segment.opacity = opacity;
    segment.light = Math.round(clamp(light, 0, 1) * 11);
    used += 1;
  }

  function weave(pose) {
    for (const strand of geometry.strands) {
      let previous = unfoldPoint(strand.points[0], strand.group, pose.unfold);
      for (let index = 1; index < strand.points.length; index += 1) {
        const point = strand.points[index];
        const current = unfoldPoint(point, strand.group, pose.unfold);
        const normal = rotatePoint(point, pose.yaw, pose.pitch);
        const illumination = 0.3 + (-normal.x * 0.35 - normal.y * 0.5 + normal.z * 0.65) * 0.55;
        const thickness = mix(0.035, strand.group === 0 ? 0.017 : 0.011, pose.unfold);
        addSegment(previous, current, pose, false, thickness, 1, illumination);
        previous = current;
      }
    }
  }

  function responsibilityThread(pose) {
    const start = {
      x: mix(0.2, ROLES[0].x, pose.unfold),
      y: mix(0.1, ROLES[0].y, pose.unfold),
      z: mix(1.02, ROLES[0].z, pose.unfold),
    };
    const end = {
      x: mix(1.58, ROLES[2].x, pose.unfold),
      y: mix(0.66, ROLES[2].y, pose.unfold),
      z: mix(0.06, ROLES[2].z, pose.unfold),
    };
    const controlA = { x: mix(1.28, -0.56, pose.unfold), y: mix(0.2, 0.4, pose.unfold), z: 0.85 };
    const controlB = { x: mix(0.74, 0.28, pose.unfold), y: mix(1.05, -0.1, pose.unfold), z: 0.48 };
    let previous = start;
    for (let index = 1; index <= THREAD_SEGMENTS; index += 1) {
      const current = cubicPoint(start, controlA, controlB, end, index / THREAD_SEGMENTS);
      addSegment(previous, current, pose, true, mix(0.047, 0.023, pose.unfold), 1, 0.7);
      previous = current;
    }
    const opacity = smooth((pose.unfold - 0.15) / 0.65);
    for (const role of [ROLES[0], ROLES[2], ROLES[3], ROLES[4]]) {
      const from = ROLES[1];
      const a = { x: mix(from.x, role.x, 0.35), y: from.y - 0.16, z: 0.4 };
      const b = { x: mix(from.x, role.x, 0.7), y: role.y + 0.16, z: 0.3 };
      let previous = from;
      for (let index = 1; index <= LINK_SEGMENTS; index += 1) {
        const current = cubicPoint(from, a, b, role, index / LINK_SEGMENTS);
        addSegment(previous, current, pose, role.label === "Tests", 0.013, opacity, 0.5);
        previous = current;
      }
    }
  }

  function drawSegments() {
    const visible = frame.slice(0, used).sort((a, b) => a.z - b.z);
    for (const segment of visible) {
      const color = colors[segment.light];
      context.globalAlpha = segment.opacity;
      context.beginPath();
      context.moveTo(segment.x1, segment.y1);
      context.lineTo(segment.x2, segment.y2);
      context.strokeStyle = "oklch(0.18 0.025 186)";
      context.lineWidth = segment.width + 1.1;
      context.stroke();
      context.strokeStyle = segment.copper ? color.copper : color.green;
      context.lineWidth = segment.width;
      context.stroke();
      context.strokeStyle = segment.copper ? color.copperLight : color.greenLight;
      context.lineWidth = Math.max(0.4, segment.width * 0.23);
      context.stroke();
    }
    context.globalAlpha = 1;
  }

  function drawRoles(pose) {
    const opacity = smooth((pose.unfold - 0.35) / 0.45);
    if (opacity === 0) return;
    context.globalAlpha = opacity;
    context.font = '600 12px "Avenir Next", Avenir, sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    const selected = ["Spec", "Code", "Feature", "Tests"][pose.phase];
    for (const role of geometry.roles) {
      const point = project(role, pose);
      if (!point) continue;
      const active = role.label === selected;
      const radius = active ? 6 : 4.5;
      context.beginPath();
      context.arc(point.x, point.y, radius + 3, 0, TAU);
      context.fillStyle = "oklch(0.976 0.008 78)";
      context.fill();
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, TAU);
      context.fillStyle = active ? "oklch(0.57 0.16 44)" : "oklch(0.298 0.057 187)";
      context.fill();
      const halfLabel = context.measureText(role.label).width / 2 + 5;
      const labelX = clamp(point.x, halfLabel, width - halfLabel);
      const offset = role.label === "Tests" || role.label === "Owner" ? 26 : -26;
      const labelY = clamp(point.y + offset, 12, height - 12);
      context.lineWidth = 5;
      context.strokeStyle = "oklch(0.976 0.008 78)";
      context.strokeText(role.label, labelX, labelY);
      context.fillStyle = "oklch(0.218 0.026 190)";
      context.fillText(role.label, labelX, labelY);
    }
    context.globalAlpha = 1;
  }

  function draw(input = {}) {
    if (destroyed) return;
    const pose = scenePose(input);
    context.clearRect(0, 0, width, height);
    context.save();
    context.globalAlpha = mix(0.12, 0.045, pose.unfold);
    context.fillStyle = "oklch(0.235 0.043 190)";
    context.shadowColor = "oklch(0.218 0.026 190 / 0.22)";
    context.shadowBlur = 18;
    context.shadowOffsetY = 10;
    context.beginPath();
    context.ellipse(width * 0.5, height * 0.81, width * 0.19, height * 0.018, 0, 0, TAU);
    context.fill();
    context.restore();
    used = 0;
    weave(pose);
    responsibilityThread(pose);
    drawSegments();
    drawRoles(pose);
  }

  function destroy() {
    if (destroyed) return;
    context.clearRect(0, 0, width, height);
    destroyed = true;
  }

  return { resize, draw, destroy };
}
