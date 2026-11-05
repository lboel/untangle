import { Script } from "node:vm";

import { describe, expect, it } from "vitest";

import { normalizeGraphExplorerInput } from "./normalize.js";
import type { GraphExplorerInputV1 } from "./types.js";
import { EXPLORER_SCRIPT } from "./ui-assets.js";

describe("embedded browser runtime", () => {
  it("boots without a symbol graph and handles cyclic reverse traversal and layout changes", () => {
    const data = normalizeGraphExplorerInput(runtimeFixture(), {
      title: "Runtime fixture",
      initialView: "symbol",
      initialLayout: "repository-lanes",
    });
    const document = fakeDocument(Buffer.from(JSON.stringify(data), "utf8").toString("base64"));

    new Script(EXPLORER_SCRIPT).runInNewContext(
      {
        atob,
        document,
        Element: FakeElement,
        TextDecoder,
        Uint8Array,
        window: {
          matchMedia(): { matches: boolean } {
            return { matches: false };
          },
          requestAnimationFrame(callback: (timestamp: number) => void): number {
            callback(0);
            return 1;
          },
        },
      },
      { timeout: 1_000 },
    );

    expect(document.title).toBe("Runtime fixture");
    expect(document.required("symbol-tab").disabled).toBe(true);
    expect(document.required("file-tab").getAttribute("aria-selected")).toBe("true");
    expect(document.required("live-region").textContent).toContain("Symbol graph unavailable");
    expect(document.required("visible-stats").textContent).toBe(
      "3 visible nodes · 3 visible connections",
    );

    const svg = document.required("graph-svg");
    const nodes = svg.children.filter((element) => element.tagName === "g");
    expect(nodes).toHaveLength(3);
    const selected = nodes.find((element) =>
      element.getAttribute("aria-label")?.startsWith("c.ts,"),
    );
    if (!selected) throw new Error("Expected runtime node c.ts");
    selected.click();

    expect(document.required("inspector-empty").hidden).toBe(true);
    expect(document.required("inspector-content").hidden).toBe(false);
    expect(document.required("inspector-summary").textContent).toBe("c.ts");
    expect(document.required("direct-list").children).toHaveLength(1);
    expect(document.required("reverse-list").children).toHaveLength(1);

    const search = document.required("graph-search");
    search.value = "a.ts";
    search.dispatch("input");
    expect(document.required("visible-stats").textContent).toBe(
      "1 search matches · 3 visible nodes",
    );
    expect(
      svg.children.filter(
        (element) => element.tagName === "g" && element.className.includes("is-search-hit"),
      ),
    ).toHaveLength(1);

    const layout = document.required("layout-select");
    layout.value = "circle";
    layout.dispatch("change");
    expect(
      svg.children.filter((element) => element.getAttribute("class")?.startsWith("lane")),
    ).toHaveLength(0);
    expect(document.required("scope-line").textContent).toContain("Circle");
  });

  it("opens a wide graph at a readable one-to-one scale in a narrow viewport", () => {
    const data = normalizeGraphExplorerInput(runtimeFixture());
    const document = fakeDocument(Buffer.from(JSON.stringify(data), "utf8").toString("base64"));
    const viewport = document.required("graph-viewport");
    viewport.boundingWidth = 356;
    viewport.boundingHeight = 512;

    new Script(EXPLORER_SCRIPT).runInNewContext(
      {
        atob,
        document,
        Element: FakeElement,
        TextDecoder,
        Uint8Array,
        window: {
          matchMedia(): { matches: boolean } {
            return { matches: true };
          },
          requestAnimationFrame(callback: (timestamp: number) => void): number {
            callback(0);
            return 1;
          },
        },
      },
      { timeout: 1_000 },
    );

    expect(document.required("graph-svg").getAttribute("viewBox")).toBe("0 0 356 512");
  });
});

type FakeListener = (event: FakeEvent) => void;

interface FakeEvent {
  button: number;
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  deltaY: number;
  key: string;
  metaKey: boolean;
  pointerId: number;
  preventDefault(): void;
  target: FakeElement;
}

class FakeClassList {
  public constructor(private readonly owner: FakeElement) {}

  public add(...names: string[]): void {
    this.write(new Set([...this.read(), ...names]));
  }

  public remove(...names: string[]): void {
    const values = this.read();
    for (const name of names) values.delete(name);
    this.write(values);
  }

  public toggle(name: string, force?: boolean): boolean {
    const values = this.read();
    const enabled = force ?? !values.has(name);
    if (enabled) values.add(name);
    else values.delete(name);
    this.write(values);
    return enabled;
  }

  private read(): Set<string> {
    return new Set(this.owner.className.split(/\s+/u).filter(Boolean));
  }

  private write(values: Set<string>): void {
    this.owner.className = [...values].join(" ");
  }
}

class FakeElement {
  public readonly children: FakeElement[] = [];
  public readonly classList = new FakeClassList(this);
  public readonly content = { textContent: "" };
  public readonly dataset: Record<string, string> = {};
  public className = "";
  public boundingHeight = 600;
  public boundingWidth = 960;
  public disabled = false;
  public hidden = false;
  public selectedIndex = 0;
  public tabIndex = 0;
  public textContent = "";
  public title = "";
  public type = "";
  public value = "";

  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, FakeListener[]>();

  public constructor(public readonly tagName: string) {}

  public get options(): FakeElement[] {
    return this.children.filter((child) => child.tagName === "option");
  }

  public addEventListener(name: string, listener: FakeListener): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  public append(...elements: FakeElement[]): void {
    this.children.push(...elements);
  }

  public click(): void {
    this.dispatch("click");
  }

  public closest(selector: string): FakeElement | null {
    return selector === ".node" && this.className.split(/\s+/u).includes("node") ? this : null;
  }

  public dispatch(name: string, overrides: Partial<FakeEvent> = {}): void {
    const event: FakeEvent = {
      button: 0,
      clientX: 0,
      clientY: 0,
      ctrlKey: false,
      deltaY: 0,
      key: "",
      metaKey: false,
      pointerId: 1,
      preventDefault() {},
      target: this,
      ...overrides,
    };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  public focus(): void {}

  public getAttribute(name: string): string | null {
    if (name === "class") return this.className || null;
    return this.attributes.get(name) ?? null;
  }

  public getBoundingClientRect(): { height: number; width: number } {
    return { height: this.boundingHeight, width: this.boundingWidth };
  }

  public querySelectorAll(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll()]);
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  public replaceChildren(...elements: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...elements);
    this.textContent = "";
  }

  public setAttribute(name: string, value: string): void {
    if (name === "class") this.className = value;
    this.attributes.set(name, value);
  }

  public setPointerCapture(): void {}
}

class FakeDocument {
  public readonly body = new FakeElement("body");
  public title = "";

  public constructor(private readonly elements: Map<string, FakeElement>) {}

  public createElement(name: string): FakeElement {
    return new FakeElement(name);
  }

  public createElementNS(_namespace: string, name: string): FakeElement {
    return new FakeElement(name);
  }

  public getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }

  public required(id: string): FakeElement {
    const element = this.getElementById(id);
    if (!element) throw new Error(`Missing fake element ${id}`);
    return element;
  }
}

function fakeDocument(encodedData: string): FakeDocument {
  const ids = [
    "app-title",
    "workspace-context",
    "completeness-badge",
    "file-tab",
    "symbol-tab",
    "graph-search",
    "repo-filter",
    "edge-filter",
    "layout-select",
    "export-png",
    "zoom-in",
    "zoom-out",
    "zoom-reset",
    "graph-heading",
    "scope-line",
    "graph-viewport",
    "graph-svg",
    "graph-panel",
    "empty-state",
    "empty-title",
    "empty-detail",
    "visible-stats",
    "limit-detail-copy",
    "inspector-empty",
    "inspector-content",
    "inspector-summary",
    "provenance-list",
    "direct-list",
    "reverse-list",
    "live-region",
    "graph-data",
  ];
  const elements = new Map(
    ids.map((id) => [id, new FakeElement(id === "graph-svg" ? "svg" : "div")]),
  );
  const template = elements.get("graph-data");
  if (!template) throw new Error("Missing fake data template");
  template.content.textContent = encodedData;
  return new FakeDocument(elements);
}

function runtimeFixture(): GraphExplorerInputV1 {
  return {
    workspace: {
      workspaceId: "runtime",
      label: "Runtime workspace",
      generationId: "runtime-generation",
      repositories: [{ repoId: "repo", label: "Runtime repo" }],
    },
    fileGraph: {
      schemaVersion: 1,
      workspaceId: "runtime",
      graphGeneration: "runtime-generation",
      nodes: ["a", "b", "c"].map((id) => ({
        fileId: id,
        repoId: "repo",
        refId: "main",
        filePath: `src/${id}.ts`,
        language: "typescript",
      })),
      edges: [
        ["edge-a-b", "a", "b"],
        ["edge-b-c", "b", "c"],
        ["edge-c-b", "c", "b"],
      ].map(([edgeId, fromFileId, targetFileId]) => ({
        edgeId: edgeId as string,
        repoId: "repo",
        refId: "main",
        fromFileId: fromFileId as string,
        kind: "import",
        resolution: { status: "resolved" as const, targetFileId: targetFileId as string },
      })),
    },
  };
}
