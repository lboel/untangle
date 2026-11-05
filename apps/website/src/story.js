/* global document, window */

import { createYarnScene } from "./yarn-scene.js";

const FRAME_INTERVAL = 1000 / 30;
const IDLE_LIMIT = 90_000;
const PHASE_LABELS = [
  "Start with intent",
  "Find the implementation",
  "See the whole feature",
  "Keep the next change small",
];

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** Native scrolling remains the navigation; the canvas is progressive enhancement. */
export function mountStory(pageDocument, pageWindow, sceneFactory = createYarnScene) {
  const section = pageDocument.getElementById("untangle-story");
  const canvas = pageDocument.getElementById("yarn-canvas");
  const fallback = pageDocument.getElementById("yarn-fallback");
  const stage = pageDocument.getElementById("yarn-stage");
  const motionButton = pageDocument.getElementById("story-motion");
  const phaseLabel = pageDocument.getElementById("story-phase");
  const status = pageDocument.getElementById("story-status");
  const instructions = pageDocument.getElementById("story-instructions");
  const steps = section ? Array.from(section.querySelectorAll("[data-story-step]")) : [];
  const links = section ? Array.from(section.querySelectorAll("[data-story-link]")) : [];
  const controls = section?.querySelector(".story-controls");
  if (
    !section ||
    !canvas ||
    !fallback ||
    !stage ||
    !motionButton ||
    !controls ||
    steps.length !== PHASE_LABELS.length ||
    typeof pageWindow.requestAnimationFrame !== "function" ||
    typeof pageWindow.cancelAnimationFrame !== "function" ||
    typeof pageWindow.IntersectionObserver !== "function"
  ) {
    return null;
  }

  let scene;
  try {
    scene = sceneFactory(canvas);
  } catch {
    return null;
  }
  if (!scene) return null;

  const reducedMotion = pageWindow.matchMedia?.("(prefers-reduced-motion: reduce)");
  const now = () => pageWindow.performance?.now?.() ?? 0;
  const restorations = [];
  const listeners = [];
  let intersectionObserver;
  let resizeObserver;
  let frame = null;
  let destroyed = false;
  let dirty = true;
  let geometryDirty = true;
  let sizeDirty = true;
  let motion = reducedMotion ? !reducedMotion.matches : false;
  let userMotionChoice = null;
  let visible = isInViewport();
  let lastActivity = now();
  let lastDraw = -Infinity;
  let progress = 0;
  let phase = -1;
  let yaw = 0;
  let pitch = 0;
  let pointer = null;

  function preserveAttribute(element, name) {
    const previous = element.getAttribute(name);
    restorations.push(() => {
      if (previous === null) element.removeAttribute(name);
      else element.setAttribute(name, previous);
    });
  }

  for (const element of [canvas, fallback, motionButton, controls]) {
    const hidden = element.hidden;
    restorations.push(() => {
      element.hidden = hidden;
    });
  }
  preserveAttribute(section, "data-motion");
  preserveAttribute(stage, "data-scene-ready");
  preserveAttribute(stage, "tabindex");
  preserveAttribute(motionButton, "aria-pressed");
  const initialButtonText = motionButton.textContent;
  const initialPhaseText = phaseLabel?.textContent;
  const initialStatusText = status?.textContent;
  const initialInstructionsText = instructions?.textContent;
  restorations.push(() => {
    motionButton.textContent = initialButtonText;
    if (phaseLabel) phaseLabel.textContent = initialPhaseText;
    if (status) status.textContent = initialStatusText;
    if (instructions) instructions.textContent = initialInstructionsText;
  });
  for (const link of links) preserveAttribute(link, "aria-current");
  const initiallyEnhanced = section.classList.contains("is-enhanced");
  const initialActiveSteps = steps.map((step) => step.classList.contains("is-active"));
  restorations.push(() => {
    section.classList.toggle("is-enhanced", initiallyEnhanced);
    steps.forEach((step, index) => step.classList.toggle("is-active", initialActiveSteps[index]));
  });

  function listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    listeners.push(() => target.removeEventListener(type, listener, options));
  }

  function isInViewport() {
    const rect = stage.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < pageWindow.innerHeight;
  }

  function canDraw() {
    return !destroyed && visible && !pageDocument.hidden;
  }

  function canContinue(timestamp) {
    return canDraw() && motion && timestamp - lastActivity < IDLE_LIMIT;
  }

  function cancelFrame() {
    if (frame !== null) pageWindow.cancelAnimationFrame(frame);
    frame = null;
  }

  function requestFrame() {
    if (frame === null && canDraw() && (dirty || canContinue(now()))) {
      frame = pageWindow.requestAnimationFrame(tick);
    }
  }

  function invalidate({ geometry = false, size = false, activity = false } = {}) {
    dirty = true;
    geometryDirty ||= geometry;
    sizeDirty ||= size;
    if (activity) lastActivity = now();
    requestFrame();
  }

  function readProgress() {
    const anchor = pageWindow.innerHeight * 0.55;
    const bounds = steps.map((step) => step.getBoundingClientRect());
    const start = bounds[0].top;
    const end = bounds[bounds.length - 1].top;
    progress = end > start ? clamp((anchor - start) / (end - start), 0, 1) : 0;
    let nextPhase = 0;
    for (let index = 1; index < bounds.length; index += 1) {
      if (bounds[index].top <= anchor) nextPhase = index;
    }
    if (phase !== nextPhase) {
      const initial = phase === -1;
      phase = nextPhase;
      const label =
        steps[phase].getAttribute("data-story-title") ||
        steps[phase].querySelector("h3")?.textContent?.trim() ||
        PHASE_LABELS[phase];
      if (phaseLabel) phaseLabel.textContent = label;
      if (status && !initial) status.textContent = label;
      steps.forEach((step, index) => step.classList.toggle("is-active", index === phase));
      links.forEach((link) => {
        if (link.getAttribute("href") === `#${steps[phase].id}`) {
          link.setAttribute("aria-current", "step");
        } else link.removeAttribute("aria-current");
      });
    }
    geometryDirty = false;
  }

  function draw(timestamp) {
    if (geometryDirty) readProgress();
    if (sizeDirty) {
      const rect = stage.getBoundingClientRect();
      scene.resize({
        width: clamp(rect.width, 1, 1920),
        height: clamp(rect.height, 1, 1200),
        dpr: clamp(pageWindow.devicePixelRatio || 1, 1, 2),
      });
      sizeDirty = false;
    }
    scene.draw({ progress, yaw, pitch, phase, motion, time: timestamp / 1000 });
    dirty = false;
    lastDraw = timestamp;
  }

  function tick(timestamp) {
    frame = null;
    if (!canDraw()) return;
    try {
      if ((dirty || canContinue(timestamp)) && timestamp - lastDraw >= FRAME_INTERVAL) {
        draw(timestamp);
      }
    } catch {
      destroy();
      return;
    }
    if (dirty || canContinue(timestamp)) requestFrame();
  }

  function updateMotionControl() {
    motionButton.setAttribute("aria-pressed", String(motion));
    motionButton.textContent = motion ? "Pause motion" : "Resume motion";
    section.setAttribute("data-motion", motion ? "on" : "off");
    stage.tabIndex = motion ? 0 : -1;
    if (instructions) {
      instructions.textContent = motion
        ? initialInstructionsText
        : "Static view. Resume motion to rotate the scene.";
    }
  }

  function stopPointer() {
    if (pointer?.captured) {
      try {
        stage.releasePointerCapture?.(pointer.id);
      } catch {
        /* A native vertical pan may already have cancelled pointer capture. */
      }
    }
    pointer = null;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancelFrame();
    stopPointer();
    intersectionObserver?.disconnect();
    resizeObserver?.disconnect();
    for (const remove of listeners) remove();
    for (const restore of restorations) restore();
    try {
      scene.destroy();
    } catch {
      /* The static image and copy remain usable if a graphics context is lost. */
    }
  }

  try {
    draw(now());
    updateMotionControl();
    canvas.hidden = false;
    fallback.hidden = true;
    motionButton.hidden = false;
    controls.hidden = false;
    stage.setAttribute("data-scene-ready", "true");
    section.classList.add("is-enhanced");

    listen(pageWindow, "scroll", () => invalidate({ geometry: true, activity: true }), {
      passive: true,
    });
    listen(pageWindow, "resize", () => invalidate({ geometry: true, size: true }), {
      passive: true,
    });
    listen(pageDocument, "visibilitychange", () => {
      if (pageDocument.hidden) {
        cancelFrame();
        stopPointer();
      } else invalidate({ geometry: true, size: true, activity: true });
    });
    listen(motionButton, "click", () => {
      motion = !motion;
      userMotionChoice = motion;
      stopPointer();
      updateMotionControl();
      if (status) status.textContent = motion ? "Motion resumed." : "Motion paused.";
      invalidate({ activity: true });
    });
    listen(stage, "keydown", (event) => {
      if (!motion || (event.target !== stage && event.target !== canvas)) return;
      if (event.key === "ArrowLeft") yaw -= 0.12;
      else if (event.key === "ArrowRight") yaw += 0.12;
      else if (event.key === "ArrowUp") pitch -= 0.08;
      else if (event.key === "ArrowDown") pitch += 0.08;
      else if (event.key === "Home") yaw = pitch = 0;
      else return;
      pitch = clamp(pitch, -0.62, 0.62);
      event.preventDefault();
      invalidate({ activity: true });
    });
    listen(stage, "pointerdown", (event) => {
      if (
        !motion ||
        event.isPrimary === false ||
        (event.button !== undefined && event.button !== 0)
      )
        return;
      if (event.target !== stage && event.target !== canvas) return;
      pointer = {
        id: event.pointerId,
        type: event.pointerType,
        x: event.clientX,
        y: event.clientY,
        captured: false,
      };
    });
    listen(
      stage,
      "pointermove",
      (event) => {
        if (!pointer || pointer.id !== event.pointerId) return;
        const dx = event.clientX - pointer.x;
        const dy = event.clientY - pointer.y;
        if (!pointer.captured) {
          if (Math.hypot(dx, dy) < 8) return;
          if (pointer.type === "touch" && Math.abs(dx) <= Math.abs(dy) * 1.2) {
            pointer = null;
            return;
          }
          stage.setPointerCapture?.(pointer.id);
          pointer.captured = true;
        }
        yaw += dx * 0.006;
        pitch = clamp(pitch + dy * 0.004, -0.62, 0.62);
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        event.preventDefault();
        invalidate({ activity: true });
      },
      { passive: false },
    );
    listen(stage, "pointerup", stopPointer);
    listen(stage, "pointercancel", stopPointer);
    listen(stage, "lostpointercapture", () => {
      pointer = null;
    });

    if (reducedMotion?.addEventListener) {
      listen(reducedMotion, "change", () => {
        motion = reducedMotion.matches ? false : (userMotionChoice ?? true);
        stopPointer();
        updateMotionControl();
        invalidate({ activity: true });
      });
    }
    intersectionObserver = new pageWindow.IntersectionObserver((entries) => {
      const entry = entries.find((value) => value.target === stage);
      if (!entry || destroyed) return;
      visible = entry.isIntersecting;
      if (visible) invalidate({ geometry: true, size: true, activity: true });
      else {
        cancelFrame();
        stopPointer();
      }
    });
    intersectionObserver.observe(stage);
    if (typeof pageWindow.ResizeObserver === "function") {
      resizeObserver = new pageWindow.ResizeObserver(() => {
        if (!destroyed) invalidate({ geometry: true, size: true });
      });
      resizeObserver.observe(stage);
    }
    requestFrame();
  } catch {
    destroy();
    return null;
  }

  return { destroy };
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  mountStory(document, window);
}
