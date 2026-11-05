import { describe, expect, it, vi } from "vitest";

import { mountStory } from "./story.js";

interface StoryEvent {
  target: unknown;
  key?: string;
  pointerId?: number;
  pointerType?: string;
  clientX?: number;
  clientY?: number;
  button?: number;
  isPrimary?: boolean;
  prevented: boolean;
  preventDefault(): void;
}

class EventTarget {
  readonly listeners = new Map<string, Set<(event: StoryEvent) => void>>();
  readonly listenerOptions = new Map<string, unknown>();

  addEventListener(type: string, listener: (event: StoryEvent) => void, options?: unknown) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    this.listenerOptions.set(type, options);
  }

  removeEventListener(type: string, listener: (event: StoryEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, fields: Partial<StoryEvent> = {}) {
    const event: StoryEvent = {
      target: this,
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
      ...fields,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((count, values) => count + values.size, 0);
  }
}

class Classes {
  private readonly values = new Set<string>();

  add(value: string) {
    this.values.add(value);
  }

  remove(value: string) {
    this.values.delete(value);
  }

  contains(value: string) {
    return this.values.has(value);
  }

  toggle(value: string, enabled: boolean) {
    if (enabled) this.values.add(value);
    else this.values.delete(value);
  }
}

class Element extends EventTarget {
  readonly classList = new Classes();
  readonly attributes = new Map<string, string>();
  readonly selectors = new Map<string, Element[]>();
  readonly captured = new Set<number>();
  hidden = false;
  textContent = "";
  top = 100;
  width = 640;
  height = 600;

  constructor(readonly id: string) {
    super();
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  querySelectorAll(selector: string) {
    return this.selectors.get(selector) ?? [];
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getBoundingClientRect() {
    return {
      top: this.top,
      bottom: this.top + this.height,
      width: this.width,
      height: this.height,
    };
  }

  setPointerCapture(pointerId: number) {
    this.captured.add(pointerId);
  }

  releasePointerCapture(pointerId: number) {
    this.captured.delete(pointerId);
  }

  get tabIndex() {
    return Number(this.attributes.get("tabindex") ?? -1);
  }

  set tabIndex(value: number) {
    this.setAttribute("tabindex", String(value));
  }
}

class MediaQuery extends EventTarget {
  matches = false;

  change(matches: boolean) {
    this.matches = matches;
    this.dispatch("change");
  }
}

interface SceneFrame {
  progress: number;
  phase: number;
  yaw: number;
  pitch: number;
  time: number;
  motion: boolean;
}

function harness(options: { reduced?: boolean; offscreen?: boolean } = {}) {
  const section = new Element("untangle-story");
  const canvas = new Element("yarn-canvas");
  const fallback = new Element("yarn-fallback");
  const stage = new Element("yarn-stage");
  const button = new Element("story-motion");
  const phase = new Element("story-phase");
  const status = new Element("story-status");
  const controls = new Element("controls");
  const instructions = new Element("story-instructions");
  instructions.textContent = "Drag to turn. Use arrow keys when the scene is focused.";
  stage.tabIndex = -1;
  canvas.hidden = button.hidden = controls.hidden = true;
  button.textContent = "Pause motion";
  phase.textContent = "Start with intent";
  if (options.offscreen) stage.top = 1200;
  const ids = ["story-intent", "story-search", "story-feature", "story-change"];
  const titles = ["Intent", "Search", "Feature", "Change"];
  const steps = ids.map((id, index) => {
    const step = new Element(id);
    step.top = 600 + index * 600;
    const title = new Element(`title-${index}`);
    title.textContent = titles[index]!;
    step.selectors.set("h3", [title]);
    return step;
  });
  const links = ids.map((id) => {
    const link = new Element(`link-${id}`);
    link.setAttribute("href", `#${id}`);
    return link;
  });
  section.selectors.set("[data-story-step]", steps);
  section.selectors.set("[data-story-link]", links);
  section.selectors.set(".story-controls", [controls]);
  const elements = new Map(
    [section, canvas, fallback, stage, button, phase, status, instructions].map((item) => [
      item.id,
      item,
    ]),
  );
  class Document extends EventTarget {
    hidden = false;
    getElementById(id: string) {
      return elements.get(id) ?? null;
    }
  }
  const document = new Document();
  const media = new MediaQuery();
  media.matches = options.reduced ?? false;
  let time = 0;
  let nextFrame = 1;
  const frames = new Map<number, (timestamp: number) => void>();
  const observers: {
    intersection: Array<{
      target?: Element;
      callback: (entries: { target: Element; isIntersecting: boolean }[]) => void;
      disconnected: boolean;
    }>;
    resize: Array<{ callback: () => void; disconnected: boolean }>;
  } = { intersection: [], resize: [] };
  class IntersectionObserver {
    target?: Element;
    disconnected = false;
    constructor(
      readonly callback: (entries: { target: Element; isIntersecting: boolean }[]) => void,
    ) {
      observers.intersection.push(this);
    }
    observe(target: Element) {
      this.target = target;
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  class ResizeObserver {
    disconnected = false;
    constructor(readonly callback: () => void) {
      observers.resize.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  }
  class Window extends EventTarget {
    innerHeight = 800;
    devicePixelRatio = 3;
    readonly performance = { now: () => time };
    readonly matchMedia = () => media;
    IntersectionObserver: typeof IntersectionObserver | undefined = IntersectionObserver;
    ResizeObserver: typeof ResizeObserver | undefined = ResizeObserver;
    requestAnimationFrame: ((callback: (timestamp: number) => void) => number) | undefined = (
      callback,
    ) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    };
    cancelAnimationFrame = (id: number) => {
      frames.delete(id);
    };
  }
  const window = new Window();
  const scene = { draw: vi.fn<(frame: SceneFrame) => void>(), resize: vi.fn(), destroy: vi.fn() };
  const factory = vi.fn(() => scene);
  const frame = (timestamp: number) => {
    time = timestamp;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(timestamp);
  };
  const last = () => scene.draw.mock.calls.at(-1)![0];
  const intersect = (isIntersecting: boolean) => {
    observers.intersection[0]!.callback([{ target: stage, isIntersecting }]);
  };
  return {
    document,
    window,
    section,
    canvas,
    fallback,
    stage,
    button,
    controls,
    instructions,
    status,
    phase,
    steps,
    links,
    elements,
    scene,
    factory,
    frames,
    observers,
    media,
    frame,
    last,
    intersect,
  };
}

describe("3D story progressive enhancement", () => {
  it("reveals a successfully drawn scene and caps its drawing resolution", () => {
    const h = harness();
    const mounted = mountStory(h.document, h.window, h.factory);
    expect(mounted).not.toBeNull();
    expect(h.factory).toHaveBeenCalledWith(h.canvas);
    expect(h.scene.resize).toHaveBeenCalledWith({ width: 640, height: 600, dpr: 2 });
    expect(h.last()).toMatchObject({ progress: 0, phase: 0, motion: true, time: 0 });
    expect(h.canvas.hidden).toBe(false);
    expect(h.fallback.hidden).toBe(true);
    expect(h.button.hidden).toBe(false);
    expect(h.controls.hidden).toBe(false);
    expect(h.section.classList.contains("is-enhanced")).toBe(true);
    expect(h.button.getAttribute("aria-pressed")).toBe("true");
    expect(h.stage.tabIndex).toBe(0);
    expect(h.status.textContent).toBe("");
    mounted!.destroy();
  });

  it.each(["requestAnimationFrame", "IntersectionObserver"] as const)(
    "keeps the image and copy usable when %s is unavailable",
    (capability) => {
      const h = harness();
      h.window[capability] = undefined;
      expect(mountStory(h.document, h.window, h.factory)).toBeNull();
      expect(h.factory).not.toHaveBeenCalled();
      expect(h.canvas.hidden).toBe(true);
      expect(h.fallback.hidden).toBe(false);
      expect(h.controls.hidden).toBe(true);
      expect(h.stage.tabIndex).toBe(-1);
      expect(h.steps.every((step) => !step.hidden)).toBe(true);
      expect(h.window.listenerCount()).toBe(0);
    },
  );

  it("retains fallback when context creation fails and does not hide content", () => {
    const h = harness();
    expect(mountStory(h.document, h.window, () => null)).toBeNull();
    expect(h.fallback.hidden).toBe(false);
    expect(h.canvas.hidden).toBe(true);
    expect(h.controls.hidden).toBe(true);
    expect(h.steps.every((step) => !step.hidden)).toBe(true);
    expect(
      mountStory(h.document, h.window, () => {
        throw new Error("context refused");
      }),
    ).toBeNull();
  });

  it("restores the static fallback and releases resources after a drawing failure", () => {
    const h = harness();
    h.scene.draw.mockImplementationOnce(() => {
      throw new Error("context lost");
    });
    expect(mountStory(h.document, h.window, h.factory)).toBeNull();
    expect(h.scene.destroy).toHaveBeenCalledOnce();
    expect(h.fallback.hidden).toBe(false);
    expect(h.canvas.hidden).toBe(true);
    expect(h.section.classList.contains("is-enhanced")).toBe(false);
    expect(h.frames.size).toBe(0);
  });

  it("coalesces native scroll events, clamps progress and updates chapter semantics", () => {
    const h = harness();
    const mounted = mountStory(h.document, h.window, h.factory);
    for (const step of h.steps) step.top -= 1600;
    for (let i = 0; i < 10; i += 1) expect(h.window.dispatch("scroll").prevented).toBe(false);
    expect(h.frames.size).toBe(1);
    expect(h.scene.draw).toHaveBeenCalledTimes(1);
    h.frame(34);
    expect(h.last().progress).toBeCloseTo(0.8);
    expect(h.last().phase).toBe(2);
    expect(h.phase.textContent).toBe("Feature");
    expect(h.status.textContent).toBe("Feature");
    expect(h.links.map((link) => link.getAttribute("aria-current"))).toEqual([
      null,
      null,
      "step",
      null,
    ]);
    expect(h.steps.map((step) => step.classList.contains("is-active"))).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(h.window.listenerOptions.get("scroll")).toEqual({ passive: true });
    for (const step of h.steps) step.top -= 20_000;
    h.window.dispatch("scroll");
    h.frame(68);
    expect(h.last()).toMatchObject({ progress: 1, phase: 3 });
    mounted!.destroy();
  });

  it("limits actual scene draws to 30fps and stops idle animation after 90 seconds", () => {
    const h = harness();
    const mounted = mountStory(h.document, h.window, h.factory);
    h.frame(16);
    expect(h.scene.draw).toHaveBeenCalledTimes(1);
    h.frame(34);
    expect(h.scene.draw).toHaveBeenCalledTimes(2);
    expect(h.last().time).toBe(0.034);
    h.frame(50);
    expect(h.scene.draw).toHaveBeenCalledTimes(2);
    h.frame(90_001);
    expect(h.frames.size).toBe(0);
    expect(h.scene.draw).toHaveBeenCalledTimes(2);
    h.window.dispatch("scroll");
    h.frame(90_040);
    expect(h.scene.draw).toHaveBeenCalledTimes(3);
    mounted!.destroy();
  });

  it("does not run a continuous frame loop while offscreen or document-hidden", () => {
    const h = harness({ offscreen: true });
    const mounted = mountStory(h.document, h.window, h.factory);
    expect(h.scene.draw).toHaveBeenCalledTimes(1);
    expect(h.frames.size).toBe(0);
    h.intersect(true);
    expect(h.frames.size).toBe(1);
    h.frame(34);
    h.intersect(false);
    expect(h.frames.size).toBe(0);
    h.intersect(true);
    expect(h.frames.size).toBe(1);
    h.document.hidden = true;
    h.document.dispatch("visibilitychange");
    expect(h.frames.size).toBe(0);
    h.window.dispatch("scroll");
    expect(h.frames.size).toBe(0);
    h.document.hidden = false;
    h.document.dispatch("visibilitychange");
    expect(h.frames.size).toBe(1);
    mounted!.destroy();
  });

  it("starts reduced motion as a fixed scene without losing chapter content", () => {
    const h = harness({ reduced: true });
    const mounted = mountStory(h.document, h.window, h.factory);
    expect(h.last().motion).toBe(false);
    expect(h.frames.size).toBe(0);
    expect(h.button.textContent).toBe("Resume motion");
    expect(h.stage.tabIndex).toBe(-1);
    expect(h.instructions.textContent).toBe("Static view. Resume motion to rotate the scene.");
    expect(h.steps.every((step) => !step.hidden)).toBe(true);
    for (const step of h.steps) step.top -= 1600;
    h.window.dispatch("scroll");
    h.frame(34);
    expect(h.last()).toMatchObject({ phase: 2, motion: false });
    expect(h.frames.size).toBe(0);
    expect(h.stage.dispatch("keydown", { key: "ArrowDown" }).prevented).toBe(false);
    mounted!.destroy();
  });

  it("supports a pause control, explicit resume and changes to the motion preference", () => {
    const h = harness();
    const mounted = mountStory(h.document, h.window, h.factory);
    h.button.dispatch("click");
    h.frame(34);
    expect(h.last().motion).toBe(false);
    expect(h.frames.size).toBe(0);
    expect(h.button.getAttribute("aria-pressed")).toBe("false");
    expect(h.status.textContent).toBe("Motion paused.");
    expect(h.stage.tabIndex).toBe(-1);
    h.media.change(true);
    h.frame(68);
    h.media.change(false);
    h.frame(102);
    expect(h.last().motion).toBe(false);
    h.button.dispatch("click");
    h.frame(136);
    expect(h.last().motion).toBe(true);
    expect(h.status.textContent).toBe("Motion resumed.");
    expect(h.stage.tabIndex).toBe(0);
    expect(h.instructions.textContent).toBe(
      "Drag to turn. Use arrow keys when the scene is focused.",
    );
    h.media.change(true);
    h.frame(170);
    expect(h.last().motion).toBe(false);
    expect(h.frames.size).toBe(0);
    mounted!.destroy();
  });

  it("rotates with keyboard arrows only on the stage and leaves navigation controls alone", () => {
    const h = harness();
    const mounted = mountStory(h.document, h.window, h.factory);
    expect(h.stage.dispatch("keydown", { key: "ArrowRight" }).prevented).toBe(true);
    h.frame(34);
    expect(h.last().yaw).toBeCloseTo(0.12);
    for (let i = 0; i < 30; i += 1) h.stage.dispatch("keydown", { key: "ArrowDown" });
    h.frame(68);
    expect(h.last().pitch).toBe(0.62);
    expect(h.stage.dispatch("keydown", { key: "ArrowLeft", target: h.button }).prevented).toBe(
      false,
    );
    expect(h.stage.dispatch("keydown", { key: "PageDown" }).prevented).toBe(false);
    expect(h.stage.dispatch("keydown", { key: "Home" }).prevented).toBe(true);
    h.frame(102);
    expect(h.last()).toMatchObject({ yaw: 0, pitch: 0 });
    mounted!.destroy();
  });

  it("preserves a vertical touch pan and captures only deliberate horizontal rotation", () => {
    const h = harness();
    const mounted = mountStory(h.document, h.window, h.factory);
    h.stage.dispatch("pointerdown", {
      pointerType: "touch",
      pointerId: 1,
      clientX: 50,
      clientY: 50,
    });
    const vertical = h.stage.dispatch("pointermove", { pointerId: 1, clientX: 53, clientY: 80 });
    expect(vertical.prevented).toBe(false);
    expect(h.stage.captured.size).toBe(0);
    expect(h.last().yaw).toBe(0);
    h.stage.dispatch("pointerdown", {
      pointerType: "touch",
      pointerId: 2,
      clientX: 50,
      clientY: 50,
    });
    expect(
      h.stage.dispatch("pointermove", { pointerId: 2, clientX: 53, clientY: 51 }).prevented,
    ).toBe(false);
    const horizontal = h.stage.dispatch("pointermove", { pointerId: 2, clientX: 80, clientY: 53 });
    expect(horizontal.prevented).toBe(true);
    expect(h.stage.captured.has(2)).toBe(true);
    h.frame(34);
    expect(h.last().yaw).toBeCloseTo(0.18);
    expect(h.last().pitch).toBeCloseTo(0.012);
    h.stage.dispatch("pointerup", { pointerId: 2 });
    expect(h.stage.captured.size).toBe(0);
    expect(
      h.stage.dispatch("pointermove", { pointerId: 2, clientX: 150, clientY: 60 }).prevented,
    ).toBe(false);
    mounted!.destroy();
  });

  it("resizes once per frame and falls back to window resize without ResizeObserver", () => {
    const h = harness({ reduced: true });
    h.window.ResizeObserver = undefined;
    const mounted = mountStory(h.document, h.window, h.factory);
    h.stage.width = 380;
    h.stage.height = 420;
    for (let i = 0; i < 4; i += 1) h.window.dispatch("resize");
    expect(h.scene.resize).toHaveBeenCalledTimes(1);
    h.frame(34);
    expect(h.scene.resize).toHaveBeenCalledTimes(2);
    expect(h.scene.resize).toHaveBeenLastCalledWith({ width: 380, height: 420, dpr: 2 });
    expect(h.frames.size).toBe(0);
    mounted!.destroy();
  });

  it("cleans up all observers/listeners/frames and restores pre-existing attributes", () => {
    const h = harness();
    h.links[0]!.setAttribute("aria-current", "location");
    const mounted = mountStory(h.document, h.window, h.factory);
    mounted!.destroy();
    mounted!.destroy();
    expect(h.scene.destroy).toHaveBeenCalledOnce();
    expect(
      h.window.listenerCount() +
        h.document.listenerCount() +
        h.stage.listenerCount() +
        h.button.listenerCount() +
        h.media.listenerCount(),
    ).toBe(0);
    expect(h.observers.intersection.every((observer) => observer.disconnected)).toBe(true);
    expect(h.observers.resize.every((observer) => observer.disconnected)).toBe(true);
    expect(h.frames.size).toBe(0);
    expect(h.canvas.hidden).toBe(true);
    expect(h.fallback.hidden).toBe(false);
    expect(h.controls.hidden).toBe(true);
    expect(h.section.classList.contains("is-enhanced")).toBe(false);
    expect(h.stage.tabIndex).toBe(-1);
    expect(h.links[0]!.getAttribute("aria-current")).toBe("location");
    h.window.dispatch("scroll");
    h.intersect(true);
    expect(h.frames.size).toBe(0);
  });

  it("restores the image if a later frame loses its graphics context", () => {
    const h = harness();
    mountStory(h.document, h.window, h.factory);
    h.scene.draw.mockImplementationOnce(() => {
      throw new Error("graphics lost");
    });
    h.frame(34);
    expect(h.fallback.hidden).toBe(false);
    expect(h.canvas.hidden).toBe(true);
    expect(h.controls.hidden).toBe(true);
    expect(h.frames.size).toBe(0);
    expect(h.window.listenerCount()).toBe(0);
  });
});
