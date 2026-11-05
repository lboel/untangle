import { createHash } from "node:crypto";

import { normalizeGraphExplorerInput } from "./normalize.js";
import type { GraphExplorerArtifact, GraphExplorerInputV1, GraphExplorerOptions } from "./types.js";
import { EXPLORER_CSS, EXPLORER_SCRIPT } from "./ui-assets.js";

/**
 * Creates one byte-deterministic, self-contained HTML artifact.
 *
 * Only the normalized, source-free document model is serialized. It is
 * Base64-encoded so even adversarial graph labels cannot break out of the
 * inert template element or become executable markup.
 */
export function createGraphExplorerHtml(
  input: GraphExplorerInputV1,
  options: GraphExplorerOptions = {},
): GraphExplorerArtifact {
  assertStaticAssetBoundary(EXPLORER_CSS, "style");
  assertStaticAssetBoundary(EXPLORER_SCRIPT, "script");

  const data = normalizeGraphExplorerInput(input, options);
  const encodedData = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  const styleHash = sha256Base64(EXPLORER_CSS);
  const scriptHash = sha256Base64(EXPLORER_SCRIPT);
  const contentSecurityPolicy = [
    "default-src 'none'",
    `script-src 'sha256-${scriptHash}'`,
    `style-src 'sha256-${styleHash}'`,
    "img-src data: blob:",
    "connect-src 'none'",
    "font-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="referrer" content="no-referrer">
  <meta name="color-scheme" content="light">
  <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">
  <title>Untangle Graph Explorer</title>
  <style>${EXPLORER_CSS}</style>
</head>
<body>
  <a class="skip-link" href="#graph-viewport">Skip to graph</a>
  <header class="app-header">
    <div class="brand-lockup">
      <span class="brand-mark" aria-hidden="true"></span>
      <div>
        <h1 id="app-title">Untangle Graph Explorer</h1>
        <p id="workspace-context" class="workspace-context">Local snapshot</p>
      </div>
    </div>
    <p id="completeness-badge" class="completeness-badge">Checking export</p>
  </header>

  <main class="app-main">
    <section class="toolbar" aria-label="Graph controls">
      <div class="view-tabs" role="tablist" aria-label="Graph view">
        <button id="file-tab" class="tab-button" type="button" role="tab" aria-selected="true" aria-controls="graph-panel">Files</button>
        <button id="symbol-tab" class="tab-button" type="button" role="tab" aria-selected="false" aria-controls="graph-panel" tabindex="-1">Symbols</button>
      </div>

      <div class="field field-search">
        <label for="graph-search">Find nodes</label>
        <input id="graph-search" type="search" autocomplete="off" spellcheck="false" placeholder="Path, symbol or language">
      </div>

      <div class="field field-compact">
        <label for="repo-filter">Repository</label>
        <select id="repo-filter"><option>All repositories</option></select>
      </div>

      <div class="field field-compact">
        <label for="edge-filter">Edge type</label>
        <select id="edge-filter"><option>All edge types</option></select>
      </div>

      <div class="field field-compact">
        <label for="layout-select">Layout</label>
        <select id="layout-select">
          <option value="repository-lanes">Repository lanes</option>
          <option value="grid">Grid</option>
          <option value="circle">Circle</option>
        </select>
      </div>

      <button id="export-png" class="export-button" type="button">Export PNG</button>
    </section>

    <div class="workspace-shell">
      <section id="graph-panel" class="graph-region" role="tabpanel" aria-labelledby="file-tab">
        <div class="graph-heading-bar">
          <div class="graph-heading-copy">
            <h2 id="graph-heading">File dependencies</h2>
            <p id="scope-line" class="scope-line">Loading snapshot</p>
          </div>
          <div class="zoom-controls" aria-label="Graph zoom">
            <button id="zoom-out" class="icon-button" type="button" aria-label="Zoom out" title="Zoom out">−</button>
            <button id="zoom-reset" class="icon-button" type="button" aria-label="Reset view" title="Reset view">1:1</button>
            <button id="zoom-in" class="icon-button" type="button" aria-label="Zoom in" title="Zoom in">+</button>
          </div>
        </div>

        <div id="graph-viewport" class="graph-viewport" tabindex="0" role="region" aria-labelledby="graph-heading" aria-describedby="graph-help">
          <p id="graph-help" class="sr-only">Zoom with plus and minus, pan with arrow keys. Reach nodes with Tab and select with Enter.</p>
          <svg id="graph-svg" class="graph-svg" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="Interactive dependency graph"></svg>
          <div id="empty-state" class="empty-state" hidden>
            <h3 id="empty-title">No nodes</h3>
            <p id="empty-detail">This view contains no renderable nodes.</p>
          </div>
        </div>

        <footer class="graph-footer">
          <p id="visible-stats">0 visible nodes</p>
          <ul class="legend" aria-label="Highlights">
            <li class="legend-item"><span class="legend-swatch selected" aria-hidden="true"></span>Selection</li>
            <li class="legend-item"><span class="legend-swatch direct" aria-hidden="true"></span>Direct</li>
            <li class="legend-item"><span class="legend-swatch upstream" aria-hidden="true"></span>Reachable upstream</li>
            <li class="legend-item"><span class="legend-swatch cross-repo" aria-hidden="true"></span>Repository boundary</li>
          </ul>
        </footer>
      </section>

      <aside class="inspector" aria-labelledby="inspector-title">
        <div class="inspector-heading">
          <h2 id="inspector-title">Inspector</h2>
          <p>Provenance and dependencies of the selected node</p>
        </div>
        <p id="inspector-empty" class="inspector-empty">Select a node to inspect its provenance and neighbors.</p>
        <div id="inspector-content" class="inspector-content" hidden>
          <section class="inspector-section">
            <h3 id="inspector-summary">Node</h3>
            <dl id="provenance-list" class="definition-list"></dl>
          </section>
          <section class="inspector-section">
            <h3>Direct neighbors</h3>
            <ul id="direct-list" class="neighbor-list"></ul>
          </section>
          <section class="inspector-section">
            <h3>Reachable upstream</h3>
            <ul id="reverse-list" class="neighbor-list"></ul>
          </section>
        </div>
        <details class="limit-detail">
          <summary>Export limits</summary>
          <p id="limit-detail-copy">Calculating limits.</p>
        </details>
      </aside>
    </div>
  </main>

  <noscript><p>This offline explorer requires JavaScript to display the embedded snapshot.</p></noscript>
  <p id="live-region" class="sr-only live-region" role="status" aria-live="polite" aria-atomic="true"></p>
  <template id="graph-data">${encodedData}</template>
  <script>${EXPLORER_SCRIPT}</script>
</body>
</html>
`;

  return {
    html,
    bytes: Buffer.byteLength(html, "utf8"),
    sha256: sha256Hex(html),
    limits: data.limits,
    views: {
      file: data.views.file.stats,
      symbol: data.views.symbol?.stats ?? null,
    },
  };
}

function assertStaticAssetBoundary(asset: string, element: "script" | "style"): void {
  if (asset.toLowerCase().includes(`</${element}`)) {
    throw new Error(`Trusted ${element} asset contains a closing-element boundary`);
  }
}

function sha256Base64(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
