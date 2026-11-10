import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { beforeAll, describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));

let html = "";
let script = "";
let styles = "";

beforeAll(async () => {
  [html, script, styles] = await Promise.all([
    readFile(path.join(sourceRoot, "index.html"), "utf8"),
    readFile(path.join(sourceRoot, "site.js"), "utf8"),
    readFile(path.join(sourceRoot, "styles.css"), "utf8"),
  ]);
});

describe("Untangle website content contract", () => {
  it("explains the three product layers without framework or marketing jargon", () => {
    const copy = html.replace(/\s+/gu, " ");
    expect(html).toContain("Keep spec-driven code easy to change.");
    expect(copy).toContain("A local search and complexity harness for coding agents.");
    for (const layer of [
      "Repository complexity",
      "Complexity per feature",
      "Search-based monitoring",
    ]) {
      expect(html).toContain(`<h3>${layer}</h3>`);
    }
    expect(copy).toContain("When your agent finds the code it needs, that is a useful signal.");
    expect(copy).toContain("Repeated, comparable searches");
    expect(html).toContain("AST metrics, file and symbol graphs.");
    expect(copy).toContain("Results state their scope and coverage.");
    expect(html).not.toMatch(
      /\b(?:FOOL|Ontology|Operations|Foundation|Love|verifier-closed|feedback-open|Wave 9)\b/iu,
    );
  });

  it("shows a complete clear and tangled Search Journey vector", () => {
    for (const label of ["Searches", "Candidates", "Observed hops", "Target rank"]) {
      expect(html).toContain(`<dt>${label}</dt>`);
    }

    expect(html).toContain("6 candidates returned");
    expect(html).toContain("42 candidates");
    expect(html).toContain("Search 02 · reformulated");
    expect(html).toContain("Returned at rank 1");
    expect(html).toContain("Returned at rank 7");
    expect(html).toContain("Explicitly confirmed");
    expect(html).toContain("Illustrative journey · not benchmark data");
    expect(html.replace(/\s+/gu, " ")).toContain(
      "Observed hops are counted searches plus explicitly reported navigation events.",
    );
  });

  it("maps declared features to code, tests and ownership with separate complexity reports", () => {
    const copy = html.replace(/\s+/gu, " ");
    expect(html).toContain('id="feature-probe"');
    expect(html).toMatch(
      /<strong>Vision &amp; spec<\/strong>[\s\S]*<strong>Feature<\/strong>[\s\S]*<strong>Code<\/strong>[\s\S]*<strong>Tests<\/strong>[\s\S]*<strong>Ownership<\/strong>/u,
    );
    expect(copy).toContain("Your manifest defines the feature boundaries and owners.");
    expect(copy).toContain("Code and test metrics reported separately");
    expect(copy).toContain("Shared files, declared feature dependencies and unmapped code");
    expect(copy).toContain("Threshold violations and next actions for agents");
    expect(copy).toContain("Set complexity budgets per feature.");
    expect(copy).toContain("does not independently certify feature behavior or ownership.");
    expect(copy).toContain("never combined into one score");
    expect(copy).toContain("Embeddings help retrieve code. They do not measure its complexity.");
    expect(copy).toContain("immutable corpus revision");
  });

  it("distinguishes current analysis and monitoring from planned automation", () => {
    const copy = html.replace(/\s+/gu, " ");
    expect(copy).toContain(
      "Repository analysis, declared feature reports and explicitly recorded Search Journeys are available.",
    );
    expect(copy).toContain(
      "Automatic feature detection, historical feature baselines and autonomous refactoring remain planned.",
    );
    expect(copy).toContain(
      "built-in time-series and before/after trend views are not available yet.",
    );
    expect(copy).toContain("Missing parser coverage and unresolved graph endpoints remain visible");
    expect(copy).toContain("Recording is opt-in.");
    expect(copy).toContain("Without a specification");
    expect(copy).toContain(
      "Initialization does not invent a spec, assign owners or start recording searches.",
    );
    expect(copy).toContain(
      "Add Sentrux, SonarQube or another analyzer through an explicit extension manifest.",
    );
    expect(copy).toContain("This does not trigger a new Sonar scan.");
    expect(copy).toContain(
      "These patterns are hypotheses to investigate, not automatic diagnoses.",
    );
  });

  it("describes local-first privacy without overstating fingerprints", () => {
    expect(html).toContain("The default path stays local.");
    expect(html).toContain("remote\n              endpoints are an explicit operator choice");
    expect(html).toContain("Telemetry is off by default.");
    expect(html).toContain("Searches count only when the host links them to that session");
    expect(html).toContain("navigation counts only");
    expect(html).toContain("Journey free text is opt-in.");
    expect(html).toMatch(
      /Goals, queries and optional feature identifiers default to fingerprints/u,
    );
    expect(html).toContain("Fingerprints are pseudonymous");
    expect(html).toContain("controlled abandonment reason code");
    expect(html).toContain("no analytics");
  });

  it("offers npm install routes and connects the installed CLI to MCP", () => {
    expect(html).toContain(
      "npm exec --yes --package=@untangle-code/cli@0.1.0 -- untangle complexity --top=10",
    );
    expect(html).toContain("npm install --global @untangle-code/cli@next");
    expect(html).toContain("npm exec -- untangle mcp --stdio");
    expect(html).toContain(
      '"/absolute/path/to/project/node_modules/@untangle-code/cli/dist/index.js"',
    );
    expect(html).toContain('"--root=/absolute/path/to/project"');
    expect(html).toContain("--embedder=offline");
    expect(html).toContain("avoids Ollama");
    expect(html).toContain("FEATURE_UNAVAILABLE");
  });
});

describe("Untangle website static delivery", () => {
  it("uses only local assets and resolves every in-page link", async () => {
    const localAssets = [
      ...new Set([...html.matchAll(/(?:href|src)="(\.\/[^"#]+)"/gu)].map((match) => match[1])),
    ];
    expect(localAssets).toEqual([
      "./styles.css",
      "./untangle-logo.svg",
      "./site.js",
      "./story.js",
      "./untangle-yarn-3d.png",
      "./untangle-example.html",
      "./untangle-example.json",
    ]);

    await Promise.all(
      localAssets.map((asset) => access(path.join(sourceRoot, asset.replace(/^\.\//u, "")))),
    );

    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]));
    const anchors = [...html.matchAll(/href="#([^"]+)"/gu)].map((match) => match[1]);
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(ids.has(anchor), `missing anchor target #${anchor}`).toBe(true);
    }

    expect([...html.matchAll(/href="(https:\/\/[^"]+)"/gu)].map((match) => match[1])).toEqual([
      "https://www.npmjs.com/package/@untangle-code/cli",
      "https://github.com/lboel/untangle",
    ]);
    const localHtml = html
      .replace(
        '<a href="https://www.npmjs.com/package/@untangle-code/cli">Untangle from npm</a>',
        "",
      )
      .replace('<a href="https://github.com/lboel/untangle">Repository</a>', "");
    expect(`${localHtml}\n${styles}\n${script}`).not.toMatch(/(?:https?:)?\/\//iu);
  });

  it("keeps both scenarios readable without JavaScript", () => {
    const clearPanel = html.match(/<article\b[^>]*data-journey-panel="clear"[^>]*>/u)?.[0];
    const tangledPanel = html.match(/<article\b[^>]*data-journey-panel="tangled"[^>]*>/u)?.[0];

    expect(clearPanel).toBeDefined();
    expect(tangledPanel).toBeDefined();
    expect(clearPanel).not.toContain("hidden");
    expect(tangledPanel).not.toContain("hidden");
    expect(html).toContain("<noscript>");
    expect(styles).toMatch(/\.journey-tabs\s*\{[^}]*display:\s*none;/su);
    expect(styles).toMatch(/\.js \.journey-tabs\s*\{[^}]*display:\s*inline-flex;/su);
  });

  it("codifies keyboard, focus, mobile and reduced-motion support", () => {
    expect(html).toContain('href="#main-content"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-live="polite"');
    expect(script).toContain('event.key === "ArrowRight"');
    expect(script).toContain('event.key === "ArrowLeft"');
    expect(script).toContain('event.key === "Home"');
    expect(script).toContain('event.key === "End"');
    expect(styles).toContain(":focus-visible");
    expect(styles).toContain("@media (max-width: 36rem)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("stays within the authored visual constraints", () => {
    const allAssets = `${html}\n${styles}\n${script}`;
    expect(allAssets).not.toMatch(/\b(?:linear|radial|conic)-gradient\s*\(/iu);
    expect(styles).not.toMatch(/#[\da-f]{3,8}\b/iu);
    expect(styles).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|lab|lch)\s*\(/iu);
    expect(styles).toContain("--white: oklch(1 0 0)");
    expect(styles).toContain('"Avenir Next"');
  });
});

class FakeClassList {
  private readonly values = new Set<string>();

  constructor(...initialValues: string[]) {
    for (const value of initialValues) {
      this.values.add(value);
    }
  }

  add(value: string): void {
    this.values.add(value);
  }

  remove(value: string): void {
    this.values.delete(value);
  }

  toggle(value: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(value);
    if (enabled) {
      this.values.add(value);
    } else {
      this.values.delete(value);
    }
    return enabled;
  }

  contains(value: string): boolean {
    return this.values.has(value);
  }
}

interface FakeEvent {
  readonly key?: string;
  preventDefault(): void;
}

class FakeElement {
  readonly classList = new FakeClassList();
  readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  hidden = false;
  tabIndex = 0;
  textContent: string;

  constructor(
    readonly id: string,
    textContent: string,
    private readonly attributes: Map<string, string>,
    private readonly focusElement: (element: FakeElement) => void,
  ) {
    this.textContent = textContent;
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  getAttribute(name: string): string {
    return this.attributes.get(name) ?? "";
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  focus(): void {
    this.focusElement(this);
  }

  dispatch(type: string, key?: string): boolean {
    let prevented = false;
    const event: FakeEvent = {
      key,
      preventDefault: () => {
        prevented = true;
      },
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
    return prevented;
  }
}

describe("Search Journey interaction", () => {
  it("enhances the fallback into tabs and supports arrow-key selection", () => {
    let activeElement: FakeElement | undefined;
    const focusElement = (element: FakeElement) => {
      activeElement = element;
    };
    const clearTab = new FakeElement(
      "tab-clear",
      "Clear route",
      new Map([
        ["aria-controls", "scenario-clear"],
        ["aria-selected", "true"],
      ]),
      focusElement,
    );
    const tangledTab = new FakeElement(
      "tab-tangled",
      "Tangled route",
      new Map([
        ["aria-controls", "scenario-tangled"],
        ["aria-selected", "false"],
      ]),
      focusElement,
    );
    const clearPanel = new FakeElement("scenario-clear", "", new Map(), focusElement);
    const tangledPanel = new FakeElement("scenario-tangled", "", new Map(), focusElement);
    const announcement = new FakeElement("journey-announcement", "", new Map(), focusElement);
    const documentElement = { classList: new FakeClassList("no-js") };
    const elements = new Map(
      [clearTab, tangledTab, clearPanel, tangledPanel, announcement].map((element) => [
        element.id,
        element,
      ]),
    );
    const fakeDocument = {
      documentElement,
      getElementById: (id: string) => elements.get(id),
      querySelectorAll: (selector: string) =>
        selector === "[data-journey-tab]" ? [clearTab, tangledTab] : [],
    };

    runInNewContext(script, { document: fakeDocument });

    expect(documentElement.classList.contains("js")).toBe(true);
    expect(documentElement.classList.contains("no-js")).toBe(false);
    expect(clearPanel.hidden).toBe(false);
    expect(tangledPanel.hidden).toBe(true);

    tangledTab.dispatch("click");
    expect(tangledTab.getAttribute("aria-selected")).toBe("true");
    expect(clearPanel.hidden).toBe(true);
    expect(tangledPanel.hidden).toBe(false);
    expect(activeElement).toBe(tangledTab);
    expect(announcement.textContent).toBe("Tangled route selected.");

    expect(tangledTab.dispatch("keydown", "ArrowLeft")).toBe(true);
    expect(clearTab.getAttribute("aria-selected")).toBe("true");
    expect(activeElement).toBe(clearTab);
  });
});
