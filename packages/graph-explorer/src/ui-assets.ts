/** Trusted static assets. User-controlled values never enter either string. */
export const EXPLORER_CSS = String.raw`
:root {
  color-scheme: light;
  --ink: oklch(0.235 0.018 190);
  --ink-secondary: oklch(0.39 0.022 188);
  --ink-muted: oklch(0.47 0.018 188);
  --canvas: oklch(0.972 0.006 180);
  --surface: oklch(0.992 0.003 180);
  --surface-raised: oklch(0.955 0.009 180);
  --surface-selected: oklch(0.91 0.035 180);
  --line: oklch(0.82 0.014 180);
  --line-strong: oklch(0.65 0.025 185);
  --patina: oklch(0.550 0.095 180.0);
  --patina-dark: oklch(0.39 0.078 180);
  --patina-soft: oklch(0.87 0.045 180);
  --copper: oklch(0.54 0.105 55);
  --danger: oklch(0.49 0.145 25);
  --focus: oklch(0.42 0.11 180);
  --space-2xs: 0.25rem;
  --space-xs: 0.5rem;
  --space-sm: 0.75rem;
  --space-md: 1rem;
  --space-lg: 1.5rem;
  --space-xl: 2rem;
  --radius-sm: 0.375rem;
  --radius-md: 0.75rem;
  --control-size: 2.75rem;
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-kerning: normal;
}

* {
  box-sizing: border-box;
}

html,
body {
  min-height: 100%;
  margin: 0;
}

body {
  min-width: 20rem;
  background: var(--canvas);
  color: var(--ink);
  font-size: 1rem;
  line-height: 1.5;
}

button,
input,
select {
  color: inherit;
  font: inherit;
}

button,
select,
input {
  min-height: var(--control-size);
}

button {
  border: 0;
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.52;
}

button:focus,
input:focus,
select:focus,
[tabindex]:focus {
  outline: none;
}

button:focus-visible,
input:focus-visible,
select:focus-visible,
[tabindex]:focus-visible {
  outline: 0.1875rem solid var(--focus);
  outline-offset: 0.125rem;
}

[hidden] {
  display: none !important;
}

.skip-link {
  position: fixed;
  inset-block-start: var(--space-xs);
  inset-inline-start: var(--space-xs);
  z-index: 4;
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-sm);
  background: var(--ink);
  color: var(--surface);
  transform: translateY(-150%);
  transition: transform 160ms var(--ease-out);
}

.skip-link:focus {
  transform: translateY(0);
}

.app-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm) var(--space-lg);
  padding: var(--space-md) max(var(--space-md), env(safe-area-inset-right)) var(--space-md)
    max(var(--space-md), env(safe-area-inset-left));
  border-block-end: 1px solid var(--line);
  background: var(--surface);
}

.brand-lockup {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--space-sm);
}

.brand-mark {
  position: relative;
  width: 2rem;
  height: 2rem;
  flex: 0 0 auto;
  border: 0.125rem solid var(--patina-dark);
  border-radius: 50%;
}

.brand-mark::before,
.brand-mark::after {
  position: absolute;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--patina);
  content: "";
}

.brand-mark::before {
  inset-block-start: 0.1875rem;
  inset-inline-start: 0.1875rem;
}

.brand-mark::after {
  inset-block-end: 0.1875rem;
  inset-inline-end: 0.1875rem;
}

h1,
h2,
h3,
p {
  margin: 0;
}

h1 {
  overflow: hidden;
  max-width: min(38rem, 75vw);
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.2;
  text-overflow: ellipsis;
  text-wrap: balance;
  white-space: nowrap;
}

.workspace-context {
  overflow: hidden;
  max-width: min(46rem, 80vw);
  color: var(--ink-secondary);
  font-size: 0.875rem;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.completeness-badge {
  display: inline-flex;
  min-height: 2rem;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-2xs) var(--space-sm);
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  color: var(--ink-secondary);
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  white-space: nowrap;
}

.completeness-badge::before {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--patina);
  content: "";
}

.completeness-badge.is-truncated::before {
  background: var(--copper);
}

.app-main {
  display: grid;
  width: 100%;
  min-width: 0;
  gap: var(--space-md);
  padding: var(--space-md) max(var(--space-md), env(safe-area-inset-right))
    max(var(--space-md), env(safe-area-inset-bottom))
    max(var(--space-md), env(safe-area-inset-left));
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: var(--space-sm);
}

.view-tabs {
  display: inline-flex;
  min-height: var(--control-size);
  align-items: center;
  padding: var(--space-2xs);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
}

.tab-button {
  min-height: 2.25rem;
  padding: var(--space-xs) var(--space-md);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink-secondary);
  font-size: 0.875rem;
  font-weight: 650;
  transition:
    background-color 160ms var(--ease-out),
    color 160ms var(--ease-out);
}

.tab-button[aria-selected="true"] {
  background: var(--surface);
  color: var(--patina-dark);
}

.field {
  display: grid;
  min-width: min(100%, 10rem);
  gap: var(--space-2xs);
}

.field-search {
  flex: 1 1 17rem;
}

.field-compact {
  flex: 1 1 10rem;
}

.field label {
  color: var(--ink-secondary);
  font-size: 0.8125rem;
  font-weight: 650;
}

.field input,
.field select {
  min-width: 0;
  width: 100%;
  padding: var(--space-xs) var(--space-sm);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.field input::placeholder {
  color: var(--ink-muted);
  opacity: 1;
}

.field input:hover,
.field select:hover {
  border-color: var(--patina);
}

.export-button,
.icon-button {
  display: inline-flex;
  min-height: var(--control-size);
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  font-weight: 700;
  transition:
    background-color 160ms var(--ease-out),
    color 160ms var(--ease-out),
    transform 100ms var(--ease-out);
}

.export-button {
  flex: 0 0 auto;
  gap: var(--space-xs);
  padding: var(--space-xs) var(--space-md);
  background: var(--patina-dark);
  color: var(--surface);
}

.export-button:hover {
  background: var(--patina);
  color: var(--ink);
}

.export-button:active,
.icon-button:active {
  transform: scale(0.97);
}

.workspace-shell {
  display: grid;
  min-width: 0;
  gap: var(--space-md);
}

.graph-region,
.inspector {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.graph-region {
  overflow: hidden;
}

.graph-heading-bar {
  display: flex;
  min-height: 3.5rem;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border-block-end: 1px solid var(--line);
}

.graph-heading-copy {
  display: grid;
  min-width: 0;
  gap: var(--space-2xs);
}

.graph-heading-copy h2,
.inspector h2 {
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25;
}

.scope-line {
  overflow: hidden;
  color: var(--ink-secondary);
  font-size: 0.8125rem;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.zoom-controls {
  display: inline-flex;
  gap: var(--space-2xs);
}

.icon-button {
  width: var(--control-size);
  padding: 0;
  border: 1px solid var(--line);
  background: var(--surface-raised);
}

.icon-button:hover {
  border-color: var(--patina);
  background: var(--surface-selected);
}

.graph-viewport {
  position: relative;
  min-height: 28rem;
  height: 56vh;
  max-height: 46rem;
  overflow: hidden;
  background: var(--canvas);
  touch-action: none;
}

.graph-viewport.is-panning {
  cursor: grabbing;
}

.graph-svg {
  display: block;
  width: 100%;
  height: 100%;
  user-select: none;
}

.lane {
  fill: var(--surface-raised);
  stroke: var(--line);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.lane.is-alternate {
  fill: var(--canvas);
}

.lane-label {
  fill: var(--ink-secondary);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.edge {
  fill: none;
  stroke: var(--line-strong);
  stroke-linecap: round;
  stroke-width: 1.25;
  opacity: 0.72;
  pointer-events: none;
  vector-effect: non-scaling-stroke;
}

.edge.is-cross-repo {
  stroke: var(--copper);
  stroke-dasharray: 5 4;
  stroke-width: 1.75;
}

.edge.is-ambiguous {
  stroke-dasharray: 2 4;
}

.edge.is-upstream {
  stroke: var(--patina-dark);
  stroke-width: 2.25;
  opacity: 1;
}

.edge.is-unrelated {
  opacity: 0.13;
}

.node {
  cursor: pointer;
}

.node-shape {
  fill: var(--surface);
  stroke: var(--line-strong);
  stroke-width: 1.25;
  transition:
    fill 180ms var(--ease-out),
    opacity 180ms var(--ease-out),
    stroke 180ms var(--ease-out);
  vector-effect: non-scaling-stroke;
}

.node-label {
  fill: var(--ink);
  font-size: 0.75rem;
  font-weight: 700;
  pointer-events: none;
}

.node-meta {
  fill: var(--ink-secondary);
  font-size: 0.6875rem;
  pointer-events: none;
}

.node:hover .node-shape {
  fill: var(--surface-selected);
  stroke: var(--patina-dark);
}

.node.is-selected .node-shape {
  fill: var(--patina-soft);
  stroke: var(--patina-dark);
  stroke-width: 3;
}

.node.is-direct .node-shape {
  stroke: var(--patina-dark);
  stroke-width: 2.25;
}

.node.is-upstream .node-shape {
  stroke: var(--patina);
  stroke-dasharray: 5 3;
  stroke-width: 2;
}

.node.is-unrelated,
.node.is-search-miss {
  opacity: 0.22;
}

.node.is-search-hit .node-shape {
  fill: var(--surface-selected);
}

.node:focus-visible .node-shape {
  stroke: var(--focus);
  stroke-width: 3;
}

.empty-state {
  position: absolute;
  inset: 0;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: var(--space-xs);
  padding: var(--space-xl);
  text-align: center;
}

.empty-state h3 {
  font-size: 1rem;
}

.empty-state p {
  max-width: 52ch;
  color: var(--ink-secondary);
}

.graph-footer {
  display: flex;
  min-height: 3rem;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-xs) var(--space-md);
  padding: var(--space-xs) var(--space-md);
  border-block-start: 1px solid var(--line);
  color: var(--ink-secondary);
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs) var(--space-md);
  padding: 0;
  margin: 0;
  list-style: none;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  white-space: nowrap;
}

.legend-swatch {
  width: 1rem;
  height: 0.625rem;
  border: 1px solid var(--line-strong);
  border-radius: 0.1875rem;
  background: var(--surface);
}

.legend-swatch.selected {
  border: 0.125rem solid var(--patina-dark);
  background: var(--patina-soft);
}

.legend-swatch.direct {
  border: 0.125rem solid var(--patina-dark);
}

.legend-swatch.upstream {
  border: 0.125rem dashed var(--patina);
}

.legend-swatch.cross-repo {
  height: 0;
  border: 0;
  border-block-start: 0.125rem dashed var(--copper);
  border-radius: 0;
}

.inspector {
  overflow: hidden;
}

.inspector-heading {
  display: grid;
  gap: var(--space-2xs);
  padding: var(--space-md);
  border-block-end: 1px solid var(--line);
}

.inspector-heading p,
.inspector-empty,
.neighbor-empty {
  color: var(--ink-secondary);
  font-size: 0.875rem;
  line-height: 1.5;
}

.inspector-empty {
  max-width: 42ch;
  padding: var(--space-lg) var(--space-md);
}

.inspector-content {
  display: grid;
}

.inspector-section {
  display: grid;
  gap: var(--space-sm);
  padding: var(--space-md);
  border-block-end: 1px solid var(--line);
}

.inspector-section:last-child {
  border-block-end: 0;
}

.inspector-section h3 {
  font-size: 0.875rem;
  font-weight: 700;
}

.definition-list {
  display: grid;
  grid-template-columns: minmax(5rem, 0.42fr) minmax(0, 1fr);
  gap: var(--space-xs) var(--space-sm);
  margin: 0;
  font-size: 0.8125rem;
}

.definition-list dt {
  color: var(--ink-secondary);
}

.definition-list dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.neighbor-list {
  display: grid;
  gap: var(--space-xs);
  padding: 0;
  margin: 0;
  list-style: none;
}

.neighbor-button {
  width: 100%;
  min-height: var(--control-size);
  padding: var(--space-xs) var(--space-sm);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
  text-align: start;
}

.neighbor-button:hover {
  border-color: var(--patina);
  background: var(--surface-selected);
}

.neighbor-name,
.neighbor-meta {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.neighbor-name {
  font-size: 0.8125rem;
  font-weight: 700;
}

.neighbor-meta {
  color: var(--ink-secondary);
  font-size: 0.75rem;
}

.limit-detail {
  color: var(--ink-secondary);
  font-size: 0.8125rem;
}

.limit-detail summary {
  min-height: var(--control-size);
  padding: var(--space-sm) var(--space-md);
  cursor: pointer;
  font-weight: 650;
}

.limit-detail p {
  padding: 0 var(--space-md) var(--space-md);
  text-wrap: pretty;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 47.999rem) {
  .app-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .brand-lockup,
  h1,
  .workspace-context {
    width: 100%;
    max-width: 100%;
  }

  .brand-lockup > div {
    min-width: 0;
    flex: 1 1 auto;
  }

  .toolbar {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: end;
  }

  .view-tabs,
  .field-search {
    grid-column: 1 / -1;
    justify-self: start;
  }

  .field,
  .field-search,
  .field-compact {
    width: 100%;
    min-width: 0;
  }

  .export-button {
    width: 100%;
  }

  .graph-viewport {
    height: 32rem;
    min-height: 24rem;
  }
}

@media (max-width: 29.999rem) {
  .toolbar {
    grid-template-columns: minmax(0, 1fr);
  }

  .view-tabs,
  .field-search {
    grid-column: auto;
  }

  .graph-heading-bar {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }

  .zoom-controls {
    justify-self: start;
  }
}

@media (min-width: 48rem) {
  .app-main {
    padding: var(--space-lg);
  }

  .field-compact {
    flex: 0 1 12rem;
  }
}

@media (min-width: 64rem) {
  .workspace-shell {
    grid-template-columns: minmax(0, 1fr) 20rem;
    align-items: stretch;
  }

  .inspector {
    max-height: calc(56vh + 6.5rem);
    overflow: auto;
  }
}

@media (pointer: coarse) {
  .tab-button,
  .field input,
  .field select,
  .export-button,
  .icon-button,
  .neighbor-button {
    min-height: 3rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

@media print {
  .skip-link,
  .toolbar,
  .zoom-controls,
  .inspector,
  .live-region {
    display: none !important;
  }

  body,
  .graph-viewport {
    background: white;
  }

  .graph-region {
    border: 0;
  }
}
`;

export const EXPLORER_SCRIPT = String.raw`
"use strict";
(() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const dataTemplate = required("graph-data");
  const encoded = (dataTemplate.content.textContent || "").trim();
  const data = JSON.parse(decodeBase64Utf8(encoded));

  const state = {
    view: data.initialView,
    layout: data.initialLayout,
    repo: null,
    edgeType: null,
    query: "",
    selected: null,
    viewBox: null,
    pointer: null,
  };

  const title = required("app-title");
  const workspaceContext = required("workspace-context");
  const completeness = required("completeness-badge");
  const fileTab = required("file-tab");
  const symbolTab = required("symbol-tab");
  const search = required("graph-search");
  const repoFilter = required("repo-filter");
  const edgeFilter = required("edge-filter");
  const layoutSelect = required("layout-select");
  const exportButton = required("export-png");
  const zoomIn = required("zoom-in");
  const zoomOut = required("zoom-out");
  const zoomReset = required("zoom-reset");
  const graphHeading = required("graph-heading");
  const scopeLine = required("scope-line");
  const graphViewport = required("graph-viewport");
  const svg = required("graph-svg");
  const emptyState = required("empty-state");
  const emptyTitle = required("empty-title");
  const emptyDetail = required("empty-detail");
  const visibleStats = required("visible-stats");
  const limitDetail = required("limit-detail-copy");
  const inspectorEmpty = required("inspector-empty");
  const inspectorContent = required("inspector-content");
  const inspectorSummary = required("inspector-summary");
  const provenanceList = required("provenance-list");
  const directList = required("direct-list");
  const reverseList = required("reverse-list");
  const liveRegion = required("live-region");

  let currentNodes = [];
  let currentEdges = [];
  let currentPositions = new Map();
  let currentNodeElements = new Map();
  let currentEdgeElements = new Map();
  let currentDimensions = { width: 960, height: 600 };

  title.textContent = data.title;
  document.title = data.title;
  workspaceContext.textContent = data.workspace.label + " · Generation " + data.workspace.generation;
  layoutSelect.value = state.layout;
  if (!data.views.symbol) {
    symbolTab.disabled = true;
    symbolTab.setAttribute("aria-disabled", "true");
    symbolTab.title = "No symbol graph was supplied for this generation.";
  }
  if (data.initialViewFallback) {
    announce("Symbol graph unavailable. Showing the file graph.");
  }

  installEvents();
  setView(state.view, false);

  function required(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error("Explorer element missing: " + id);
    return element;
  }

  function decodeBase64Utf8(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  function installEvents() {
    fileTab.addEventListener("click", () => setView("file", true));
    symbolTab.addEventListener("click", () => {
      if (data.views.symbol) setView("symbol", true);
    });
    for (const tab of [fileTab, symbolTab]) {
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const target = tab === fileTab ? symbolTab : fileTab;
        if (!target.disabled) {
          target.focus();
          target.click();
        }
      });
    }

    search.addEventListener("input", () => {
      state.query = search.value.trim().toLowerCase();
      applyGraphState();
    });
    search.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && search.value !== "") {
        search.value = "";
        state.query = "";
        applyGraphState();
        announce("Search cleared.");
      }
      if (event.key === "Enter") {
        const match = currentNodes.find((node) => matchesQuery(node));
        if (match) selectNode(match.id, true);
      }
    });
    repoFilter.addEventListener("change", () => {
      state.repo = optionValue(repoFilter, "repoId");
      renderGraph();
    });
    edgeFilter.addEventListener("change", () => {
      state.edgeType = optionValue(edgeFilter, "edgeType");
      renderGraph();
    });
    layoutSelect.addEventListener("change", () => {
      state.layout = layoutSelect.value;
      renderGraph();
      announce("Layout: " + layoutLabel(state.layout) + ".");
    });
    exportButton.addEventListener("click", () => void exportPng());
    zoomIn.addEventListener("click", () => zoomBy(0.8));
    zoomOut.addEventListener("click", () => zoomBy(1.25));
    zoomReset.addEventListener("click", resetViewBox);

    graphViewport.addEventListener("keydown", (event) => {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(0.8);
      } else if (event.key === "-") {
        event.preventDefault();
        zoomBy(1.25);
      } else if (event.key === "0") {
        event.preventDefault();
        resetViewBox();
      } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        if (event.target !== graphViewport) return;
        event.preventDefault();
        panByKey(event.key);
      }
    });

    graphViewport.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (event.button !== 0 || (target instanceof Element && target.closest(".node"))) return;
      state.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      graphViewport.setPointerCapture(event.pointerId);
      graphViewport.classList.add("is-panning");
    });
    graphViewport.addEventListener("pointermove", (event) => {
      if (!state.pointer || state.pointer.id !== event.pointerId || !state.viewBox) return;
      const bounds = graphViewport.getBoundingClientRect();
      const dx = ((state.pointer.x - event.clientX) / bounds.width) * state.viewBox.width;
      const dy = ((state.pointer.y - event.clientY) / bounds.height) * state.viewBox.height;
      state.pointer.x = event.clientX;
      state.pointer.y = event.clientY;
      state.viewBox.x += dx;
      state.viewBox.y += dy;
      applyViewBox();
    });
    for (const name of ["pointerup", "pointercancel"]) {
      graphViewport.addEventListener(name, (event) => {
        if (!state.pointer || state.pointer.id !== event.pointerId) return;
        state.pointer = null;
        graphViewport.classList.remove("is-panning");
      });
    }
    graphViewport.addEventListener("wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 0.88 : 1.14);
    }, { passive: false });
  }

  function setView(kind, speak) {
    if (kind === "symbol" && !data.views.symbol) return;
    state.view = kind;
    state.repo = null;
    state.edgeType = null;
    state.selected = null;
    fileTab.setAttribute("aria-selected", String(kind === "file"));
    fileTab.tabIndex = kind === "file" ? 0 : -1;
    symbolTab.setAttribute("aria-selected", String(kind === "symbol"));
    symbolTab.tabIndex = kind === "symbol" ? 0 : -1;
    required("graph-panel").setAttribute("aria-labelledby", kind === "file" ? "file-tab" : "symbol-tab");
    graphHeading.textContent = kind === "file" ? "File dependencies" : "Symbol relationships";
    populateFilters();
    renderGraph();
    if (speak) announce(kind === "file" ? "Showing file graph." : "Showing symbol graph.");
  }

  function activeView() {
    const view = data.views[state.view];
    if (!view) throw new Error("Selected graph view is unavailable.");
    return view;
  }

  function populateFilters() {
    const view = activeView();
    repoFilter.replaceChildren();
    appendOption(repoFilter, "All repositories", "", null);
    view.repositories.forEach((repoId, index) => {
      appendOption(repoFilter, repositoryLabel(repoId), "r" + String(index), { repoId });
    });
    edgeFilter.replaceChildren();
    appendOption(edgeFilter, "All edge types", "", null);
    view.edgeTypes.forEach((edgeType, index) => {
      appendOption(edgeFilter, edgeType, "e" + String(index), { edgeType });
    });
  }

  function appendOption(select, label, value, metadata) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    if (metadata && metadata.repoId) option.dataset.repoId = metadata.repoId;
    if (metadata && metadata.edgeType) option.dataset.edgeType = metadata.edgeType;
    select.append(option);
  }

  function optionValue(select, key) {
    const option = select.options[select.selectedIndex];
    return option && option.dataset[key] ? option.dataset[key] : null;
  }

  function renderGraph() {
    const view = activeView();
    currentNodes = view.nodes.filter((node) => !state.repo || node.repoId === state.repo);
    const nodeIds = new Set(currentNodes.map((node) => node.id));
    currentEdges = view.edges.filter((edge) => {
      return nodeIds.has(edge.from) && nodeIds.has(edge.to) && (!state.edgeType || edge.kind === state.edgeType);
    });
    if (state.selected && !nodeIds.has(state.selected)) state.selected = null;

    const laidOut = computeLayout(currentNodes, state.layout);
    currentPositions = laidOut.positions;
    currentDimensions = { width: laidOut.width, height: laidOut.height };
    svg.replaceChildren();
    currentNodeElements = new Map();
    currentEdgeElements = new Map();

    const defs = svgElement("defs");
    const marker = svgElement("marker");
    marker.setAttribute("id", "edge-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "6");
    marker.setAttribute("markerHeight", "6");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrow = svgElement("path");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    arrow.setAttribute("fill", "context-stroke");
    marker.append(arrow);
    defs.append(marker);
    svg.append(defs);

    if (state.layout === "repository-lanes") appendLanes(laidOut.lanes);
    for (const edge of currentEdges) appendEdge(edge);
    currentNodes.forEach((node, index) => appendNode(node, index));

    emptyState.hidden = currentNodes.length !== 0;
    if (currentNodes.length === 0) {
      emptyTitle.textContent = "No nodes in this view";
      emptyDetail.textContent = state.repo
        ? "The selected repository has no nodes within the export limit. Select another repository."
        : "The supplied snapshot contains no nodes for this view.";
    }
    resetViewBox();
    applyGraphState();
    renderInspector();
    renderStats();
  }

  function appendLanes(lanes) {
    lanes.forEach((lane, index) => {
      const rect = svgElement("rect");
      rect.setAttribute("class", index % 2 === 0 ? "lane" : "lane is-alternate");
      rect.setAttribute("x", String(lane.x));
      rect.setAttribute("y", "16");
      rect.setAttribute("width", String(lane.width));
      rect.setAttribute("height", String(Math.max(1, currentDimensions.height - 32)));
      rect.setAttribute("rx", "10");
      const label = svgElement("text");
      label.setAttribute("class", "lane-label");
      label.setAttribute("x", String(lane.x + 16));
      label.setAttribute("y", "46");
      label.textContent = clip(repositoryLabel(lane.repoId), 34);
      svg.append(rect, label);
    });
  }

  function appendEdge(edge) {
    const from = currentPositions.get(edge.from);
    const to = currentPositions.get(edge.to);
    if (!from || !to) return;
    const path = svgElement("path");
    path.setAttribute("class", edgeClass(edge));
    path.setAttribute("d", edgePath(from, to, edge.id));
    path.setAttribute("marker-end", "url(#edge-arrow)");
    path.setAttribute("aria-hidden", "true");
    svg.append(path);
    currentEdgeElements.set(edge.id, path);
  }

  function appendNode(node, index) {
    const point = currentPositions.get(node.id);
    if (!point) return;
    const group = svgElement("g");
    group.setAttribute("class", "node");
    group.setAttribute("transform", "translate(" + String(point.x) + " " + String(point.y) + ")");
    group.setAttribute("role", "button");
    group.setAttribute("aria-label", nodeAriaLabel(node));
    group.setAttribute("aria-pressed", String(state.selected === node.id));
    group.tabIndex = state.selected === node.id || (!state.selected && index === 0) ? 0 : -1;
    const titleElement = svgElement("title");
    titleElement.textContent = node.label + " · " + node.filePath;
    const shape = svgElement("rect");
    shape.setAttribute("class", "node-shape");
    shape.setAttribute("x", "-68");
    shape.setAttribute("y", "-24");
    shape.setAttribute("width", "136");
    shape.setAttribute("height", "48");
    shape.setAttribute("rx", "7");
    const label = svgElement("text");
    label.setAttribute("class", "node-label");
    label.setAttribute("x", "-58");
    label.setAttribute("y", "-3");
    label.textContent = clip(node.label, 23);
    const meta = svgElement("text");
    meta.setAttribute("class", "node-meta");
    meta.setAttribute("x", "-58");
    meta.setAttribute("y", "13");
    meta.textContent = clip(node.kind === "file" ? node.language : node.kind, 25);
    group.append(titleElement, shape, label, meta);
    group.addEventListener("click", () => selectNode(node.id, false));
    group.addEventListener("keydown", (event) => onNodeKey(event, node.id));
    svg.append(group);
    currentNodeElements.set(node.id, group);
  }

  function onNodeKey(event, nodeId) {
    const index = currentNodes.findIndex((node) => node.id === nodeId);
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectNode(nodeId, true);
      return;
    }
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = Math.min(currentNodes.length - 1, index + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = currentNodes.length - 1;
    else return;
    event.preventDefault();
    const target = currentNodeElements.get(currentNodes[next].id);
    if (target) target.focus({ preventScroll: true });
  }

  function selectNode(nodeId, moveFocus) {
    state.selected = nodeId;
    applyGraphState();
    renderInspector();
    const node = currentNodes.find((candidate) => candidate.id === nodeId);
    if (node) announce(node.label + " selected.");
    if (moveFocus) {
      const element = currentNodeElements.get(nodeId);
      if (element) element.focus({ preventScroll: true });
    }
  }

  function applyGraphState() {
    const relation = graphRelation(state.selected);
    let matches = 0;
    for (const node of currentNodes) {
      const element = currentNodeElements.get(node.id);
      if (!element) continue;
      const isMatch = matchesQuery(node);
      if (isMatch) matches += 1;
      element.setAttribute("class", nodeClass(node.id, relation, isMatch));
      element.setAttribute("aria-pressed", String(state.selected === node.id));
      element.tabIndex = state.selected === node.id || (!state.selected && node === currentNodes[0]) ? 0 : -1;
    }
    for (const edge of currentEdges) {
      const element = currentEdgeElements.get(edge.id);
      if (!element) continue;
      let classes = edgeClass(edge);
      if (state.selected && relation.upstreamEdges.has(edge.id)) classes += " is-upstream";
      else if (state.selected && !relation.directEdges.has(edge.id)) classes += " is-unrelated";
      element.setAttribute("class", classes);
    }
    if (state.query) {
      visibleStats.textContent = String(matches) + " search matches · " + String(currentNodes.length) + " visible nodes";
    } else {
      visibleStats.textContent = String(currentNodes.length) + " visible nodes · " + String(currentEdges.length) + " visible connections";
    }
  }

  function graphRelation(selected) {
    const direct = new Set();
    const directEdges = new Set();
    const upstream = new Set();
    const upstreamEdges = new Set();
    if (!selected) return { direct, directEdges, upstream, upstreamEdges };
    const incoming = new Map();
    for (const edge of currentEdges) {
      if (!incoming.has(edge.to)) incoming.set(edge.to, []);
      incoming.get(edge.to).push(edge);
      if (edge.from === selected || edge.to === selected) {
        direct.add(edge.from === selected ? edge.to : edge.from);
        directEdges.add(edge.id);
      }
    }
    const seen = new Set([selected]);
    const queue = [selected];
    while (queue.length > 0) {
      const target = queue.shift();
      const edges = incoming.get(target) || [];
      for (const edge of edges) {
        upstreamEdges.add(edge.id);
        if (seen.has(edge.from)) continue;
        seen.add(edge.from);
        upstream.add(edge.from);
        queue.push(edge.from);
      }
    }
    upstream.delete(selected);
    for (const id of direct) upstream.delete(id);
    return { direct, directEdges, upstream, upstreamEdges };
  }

  function nodeClass(nodeId, relation, isMatch) {
    let classes = "node";
    if (state.selected === nodeId) classes += " is-selected";
    else if (relation.direct.has(nodeId)) classes += " is-direct";
    else if (relation.upstream.has(nodeId)) classes += " is-upstream";
    else if (state.selected) classes += " is-unrelated";
    if (state.query) classes += isMatch ? " is-search-hit" : " is-search-miss";
    return classes;
  }

  function edgeClass(edge) {
    let classes = "edge";
    if (edge.crossRepo) classes += " is-cross-repo";
    if (edge.resolution === "ambiguous") classes += " is-ambiguous";
    return classes;
  }

  function renderInspector() {
    const node = currentNodes.find((candidate) => candidate.id === state.selected);
    inspectorEmpty.hidden = Boolean(node);
    inspectorContent.hidden = !node;
    if (!node) return;
    inspectorSummary.textContent = node.label;
    provenanceList.replaceChildren();
    appendDefinition("Type", state.view === "file" ? "File" : "Symbol");
    appendDefinition("Kind", node.kind);
    appendDefinition("Repository", repositoryLabel(node.repoId));
    appendDefinition("Ref", node.refId);
    appendDefinition("Path", node.filePath);
    appendDefinition("Language", node.language);
    if (node.startLine !== undefined) appendDefinition("Lines", String(node.startLine) + "–" + String(node.endLine));
    if (node.packageName) appendDefinition("Package", node.packageName);
    if (node.containerService) appendDefinition("Service", node.containerService);
    appendDefinition("Stable ID", node.id);
    appendDefinition("Generation", activeView().generation);

    const incoming = currentEdges.filter((edge) => edge.to === node.id).map((edge) => edge.from);
    const outgoing = currentEdges.filter((edge) => edge.from === node.id).map((edge) => edge.to);
    renderNeighborList(directList, unique(incoming.concat(outgoing)), "No direct neighbors in the filtered view.");
    const upstream = [...graphRelation(node.id).upstream];
    renderNeighborList(reverseList, upstream, "No additional upstream nodes.");
  }

  function appendDefinition(term, value) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    provenanceList.append(dt, dd);
  }

  function renderNeighborList(list, ids, emptyCopy) {
    list.replaceChildren();
    const sorted = ids.map((id) => currentNodes.find((node) => node.id === id)).filter(Boolean).sort(compareNode);
    if (sorted.length === 0) {
      const item = document.createElement("li");
      item.className = "neighbor-empty";
      item.textContent = emptyCopy;
      list.append(item);
      return;
    }
    for (const node of sorted.slice(0, 50)) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "neighbor-button";
      const name = document.createElement("span");
      name.className = "neighbor-name";
      name.textContent = node.label;
      const meta = document.createElement("span");
      meta.className = "neighbor-meta";
      meta.textContent = repositoryLabel(node.repoId) + " · " + node.filePath;
      button.append(name, meta);
      button.addEventListener("click", () => selectNode(node.id, true));
      item.append(button);
      list.append(item);
    }
    if (sorted.length > 50) {
      const more = document.createElement("li");
      more.className = "neighbor-empty";
      more.textContent = "+ " + String(sorted.length - 50) + " more";
      list.append(more);
    }
  }

  function renderStats() {
    const stats = activeView().stats;
    const limited = stats.nodeLimitDroppedCount > 0 || stats.nodeLimitDroppedLinkCount > 0 || stats.edgeLimitDroppedLinkCount > 0;
    const hasGaps = stats.unrenderableSourceEdgeCount > 0 || stats.missingEndpointLinkCount > 0;
    completeness.classList.toggle("is-truncated", limited || hasGaps);
    completeness.textContent = limited ? "Export limited" : hasGaps ? "Graph with gaps" : "Export complete";
    scopeLine.textContent = repositoryScope() + " · " + layoutLabel(state.layout);
    limitDetail.textContent =
      "Nodes: " + String(stats.shownNodeCount) + " of " + String(stats.inputNodeCount) +
      " (Limit " + String(data.limits.maxNodes) + "). Connections: " + String(stats.shownLinkCount) +
      " of " + String(stats.renderableLinkCount) + " renderable candidates (limit " + String(data.limits.maxEdges) + "). " +
      String(stats.unrenderableSourceEdgeCount) + " source edges have no renderable target; " +
      String(stats.missingEndpointLinkCount) + " candidates refer to missing nodes; " +
      String(stats.nodeLimitDroppedLinkCount) + " connections omitted by the node limit; " +
      String(stats.edgeLimitDroppedLinkCount) + " by the edge limit.";
  }

  function repositoryScope() {
    if (state.repo) return repositoryLabel(state.repo);
    const count = activeView().repositories.length;
    return String(count) + (count === 1 ? " Repository" : " Repositories");
  }

  function repositoryLabel(repoId) {
    const repository = data.workspace.repositories.find((candidate) => candidate.id === repoId);
    return repository ? repository.label : repoId;
  }

  function matchesQuery(node) {
    return !state.query || node.searchText.includes(state.query);
  }

  function computeLayout(nodes, kind) {
    if (kind === "circle") return circleLayout(nodes);
    if (kind === "grid") return gridLayout(nodes);
    return laneLayout(nodes);
  }

  function laneLayout(nodes) {
    const repoIds = unique(nodes.map((node) => node.repoId)).sort(compareText);
    const laneWidth = 280;
    const margin = 28;
    const positions = new Map();
    const lanes = [];
    let maxRows = 1;
    repoIds.forEach((repoId, laneIndex) => {
      const members = nodes.filter((node) => node.repoId === repoId).sort(compareNode);
      const rows = Math.max(1, Math.ceil(members.length / 2));
      maxRows = Math.max(maxRows, rows);
      const x = margin + laneIndex * laneWidth;
      lanes.push({ repoId, x, width: laneWidth - 12 });
      members.forEach((node, index) => {
        positions.set(node.id, {
          x: x + (index % 2 === 0 ? 78 : 202),
          y: 92 + Math.floor(index / 2) * 82,
        });
      });
    });
    return {
      positions,
      lanes,
      width: Math.max(960, margin * 2 + Math.max(1, repoIds.length) * laneWidth),
      height: Math.max(600, 142 + maxRows * 82),
    };
  }

  function gridLayout(nodes) {
    const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length * 1.65)));
    const positions = new Map();
    nodes.slice().sort(compareNode).forEach((node, index) => {
      positions.set(node.id, { x: 96 + (index % columns) * 176, y: 72 + Math.floor(index / columns) * 88 });
    });
    return {
      positions,
      lanes: [],
      width: Math.max(960, 192 + Math.max(1, columns - 1) * 176),
      height: Math.max(600, 144 + Math.ceil(nodes.length / columns) * 88),
    };
  }

  function circleLayout(nodes) {
    const ordered = nodes.slice().sort(compareNode);
    const radius = Math.max(230, ordered.length * 19);
    const center = radius + 96;
    const positions = new Map();
    ordered.forEach((node, index) => {
      const angle = -Math.PI / 2 + (index / Math.max(1, ordered.length)) * Math.PI * 2;
      positions.set(node.id, { x: center + Math.cos(angle) * radius, y: center + Math.sin(angle) * radius });
    });
    return { positions, lanes: [], width: center * 2, height: center * 2 };
  }

  function edgePath(from, to, edgeId) {
    if (from.x === to.x && from.y === to.y) {
      return "M " + String(from.x) + " " + String(from.y - 24) + " C " + String(from.x + 74) + " " + String(from.y - 80) + ", " + String(from.x + 74) + " " + String(from.y + 28) + ", " + String(from.x + 62) + " " + String(from.y + 8);
    }
    const offset = (stableNumber(edgeId) % 5 - 2) * 5;
    const mx = (from.x + to.x) / 2 + offset;
    const my = (from.y + to.y) / 2 - offset;
    return "M " + String(from.x) + " " + String(from.y) + " Q " + String(mx) + " " + String(my) + " " + String(to.x) + " " + String(to.y);
  }

  function stableNumber(value) {
    let result = 0;
    for (const character of value) result = (result * 31 + character.codePointAt(0)) >>> 0;
    return result;
  }

  function resetViewBox() {
    const useReadableMobileScale = window.matchMedia("(max-width: 47.999rem) and (pointer: coarse)").matches;
    if (!useReadableMobileScale) {
      state.viewBox = { x: 0, y: 0, width: currentDimensions.width, height: currentDimensions.height };
      applyViewBox();
      return;
    }
    const bounds = graphViewport.getBoundingClientRect();
    const fitScale = Math.min(
      bounds.width / currentDimensions.width,
      bounds.height / currentDimensions.height,
    );
    const scale = Number.isFinite(fitScale) && fitScale > 0 ? Math.max(1, fitScale) : 1;
    const readableWidth = Math.min(currentDimensions.width, bounds.width / scale);
    const readableHeight = Math.min(currentDimensions.height, bounds.height / scale);
    const center = state.layout === "circle";
    state.viewBox = {
      x: center ? Math.max(0, (currentDimensions.width - readableWidth) / 2) : 0,
      y: center ? Math.max(0, (currentDimensions.height - readableHeight) / 2) : 0,
      width: readableWidth,
      height: readableHeight,
    };
    applyViewBox();
  }

  function zoomBy(factor) {
    if (!state.viewBox) return;
    const nextWidth = clamp(state.viewBox.width * factor, Math.min(320, currentDimensions.width), currentDimensions.width * 2);
    const nextHeight = nextWidth * (state.viewBox.height / state.viewBox.width);
    const centerX = state.viewBox.x + state.viewBox.width / 2;
    const centerY = state.viewBox.y + state.viewBox.height / 2;
    state.viewBox = { x: centerX - nextWidth / 2, y: centerY - nextHeight / 2, width: nextWidth, height: nextHeight };
    applyViewBox();
  }

  function panByKey(key) {
    if (!state.viewBox) return;
    const dx = state.viewBox.width * 0.08;
    const dy = state.viewBox.height * 0.08;
    if (key === "ArrowLeft") state.viewBox.x -= dx;
    if (key === "ArrowRight") state.viewBox.x += dx;
    if (key === "ArrowUp") state.viewBox.y -= dy;
    if (key === "ArrowDown") state.viewBox.y += dy;
    applyViewBox();
  }

  function applyViewBox() {
    if (!state.viewBox) return;
    svg.setAttribute("viewBox", [state.viewBox.x, state.viewBox.y, state.viewBox.width, state.viewBox.height].map(round).join(" "));
  }

  async function exportPng() {
    if (!state.viewBox || currentNodes.length === 0) {
      announce("PNG export requires visible nodes.");
      return;
    }
    exportButton.disabled = true;
    exportButton.setAttribute("aria-busy", "true");
    const original = exportButton.textContent;
    exportButton.textContent = "Creating PNG …";
    try {
      const clone = svg.cloneNode(true);
      clone.setAttribute("xmlns", SVG_NS);
      clone.setAttribute("width", String(state.viewBox.width));
      clone.setAttribute("height", String(state.viewBox.height));
      clone.setAttribute("viewBox", svg.getAttribute("viewBox"));
      inlineSvgPresentation(svg, clone);
      const xml = new XMLSerializer().serializeToString(clone);
      const source = "data:image/svg+xml;base64," + encodeBase64Utf8(xml);
      const image = await loadImage(source);
      const scale = Math.min(2, 4096 / state.viewBox.width, 4096 / state.viewBox.height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(state.viewBox.width * scale));
      canvas.height = Math.max(1, Math.floor(state.viewBox.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D is unavailable in this browser.");
      context.fillStyle = "#f4f7f6";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await canvasBlob(canvas);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = safeFilename(data.workspace.id) + "-" + state.view + "-graph.png";
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      announce("PNG exported.");
    } catch (error) {
      announce("Could not create PNG: " + errorMessage(error));
    } finally {
      exportButton.disabled = false;
      exportButton.removeAttribute("aria-busy");
      exportButton.textContent = original;
    }
  }

  function inlineSvgPresentation(original, clone) {
    const originalElements = [original, ...original.querySelectorAll("*")];
    const cloneElements = [clone, ...clone.querySelectorAll("*")];
    const properties = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "opacity", "font-family", "font-size", "font-weight", "letter-spacing"];
    originalElements.forEach((element, index) => {
      const target = cloneElements[index];
      if (!target) return;
      const computed = getComputedStyle(element);
      for (const property of properties) {
        const value = computed.getPropertyValue(property);
        if (value) target.setAttribute(property, value);
      }
    });
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.addEventListener("load", () => resolve(image), { once: true });
      image.addEventListener("error", () => reject(new Error("The browser could not load the graph image.")), { once: true });
      image.src = source;
    });
  }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The browser could not create PNG data."));
      }, "image/png");
    });
  }

  function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    const chunk = 8192;
    for (let start = 0; start < bytes.length; start += chunk) {
      binary += String.fromCharCode(...bytes.subarray(start, start + chunk));
    }
    return btoa(binary);
  }

  function safeFilename(value) {
    const safe = value.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return safe || "untangle";
  }

  function svgElement(name) {
    return document.createElementNS(SVG_NS, name);
  }

  function nodeAriaLabel(node) {
    return node.label + ", " + repositoryLabel(node.repoId) + ", " + node.filePath;
  }

  function clip(value, maximum) {
    return [...value].length <= maximum ? value : [...value].slice(0, maximum - 1).join("") + "…";
  }

  function unique(values) {
    return [...new Set(values)];
  }

  function compareNode(left, right) {
    return compareText(left.repoId, right.repoId) || compareText(left.filePath, right.filePath) || compareText(left.id, right.id);
  }

  function compareText(left, right) {
    const a = [...left];
    const b = [...right];
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    }
    return a.length - b.length;
  }

  function layoutLabel(value) {
    if (value === "repository-lanes") return "Repository lanes";
    if (value === "grid") return "Grid";
    return "Circle";
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function round(value) {
    return String(Math.round(value * 100) / 100);
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function announce(message) {
    liveRegion.textContent = "";
    window.requestAnimationFrame(() => {
      liveRegion.textContent = message;
    });
  }
})();
`;
