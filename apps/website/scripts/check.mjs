import { createHash } from "node:crypto";
import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  assertFrozenExampleMeasurement,
  validatePublicExampleProjection,
} from "./generate-example.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const requestedTarget = process.argv[2] ?? "src";
const allowedTargets = new Set(["src", "dist"]);

if (!allowedTargets.has(requestedTarget)) {
  throw new Error(`website check: target must be src or dist, received ${requestedTarget}.`);
}

const targetRoot = path.join(packageRoot, requestedTarget);
const assets = {
  html: path.join(targetRoot, "index.html"),
  script: path.join(targetRoot, "site.js"),
  story: path.join(targetRoot, "story.js"),
  scene: path.join(targetRoot, "yarn-scene.js"),
  styles: path.join(targetRoot, "styles.css"),
  logo: path.join(targetRoot, "untangle-logo.svg"),
  illustration: path.join(targetRoot, "untangle-yarn-3d.png"),
  examplePage: path.join(targetRoot, "untangle-example.html"),
  exampleData: path.join(targetRoot, "untangle-example.json"),
};

await Promise.all(
  Object.values(assets).map(async (asset) => {
    await access(asset);
    const stat = await lstat(asset);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`website check: asset must be a regular file, received ${asset}.`);
    }
  }),
);

const [html, script, styles, story, scene, examplePage, exampleData] = await Promise.all([
  readFile(assets.html, "utf8"),
  readFile(assets.script, "utf8"),
  readFile(assets.styles, "utf8"),
  readFile(assets.story, "utf8"),
  readFile(assets.scene, "utf8"),
  readFile(assets.examplePage, "utf8"),
  readFile(assets.exampleData, "utf8"),
]);

const errors = [];
const requireText = (source, fragment, label) => {
  if (!source.includes(fragment)) {
    errors.push(`missing ${label}`);
  }
};

requireText(html, '<html lang="en" class="no-js">', "English document language");
requireText(html, 'href="#main-content"', "skip link");
requireText(html, '<main id="main-content"', "main landmark target");
requireText(html, 'role="tablist"', "Search Journey tab list");
requireText(html, "<noscript>", "no-JavaScript explanation");
requireText(styles, ":focus-visible", "visible keyboard focus styles");
requireText(styles, "prefers-reduced-motion: reduce", "reduced-motion support");
requireText(script, 'classList.add("js")', "progressive-enhancement marker");
requireText(script, 'event.key === "ArrowRight"', "tab-list keyboard navigation");

// Only these user-initiated source links and the displayed command may leave the page.
// Match complete inert fragments in their intended location, never URL substrings or code.
const quickstart = html.slice(html.indexOf('id="local-install"'), html.indexOf('id="start"'));
const footer = html.slice(html.indexOf('<footer class="site-footer">'));
const setup = html.match(/<code id="setup-command">([\s\S]*?)<\/code>/u)?.[1] ?? "";
let localHtml = html;
for (const [fragment, region] of [
  ['<a href="https://github.com/lboel/untangle">Untangle repository</a>', quickstart],
  ['<a href="https://github.com/lboel/untangle">Repository</a>', footer],
  ["<span>git clone https://github.com/lboel/untangle.git</span>", setup],
]) {
  if (!region.includes(fragment) || html.split(fragment).length !== 2) {
    errors.push("repository navigation must appear exactly once in its intended location");
  } else localHtml = localHtml.replace(fragment, "");
}
const allSource = `${localHtml}\n${styles}\n${script}\n${story}\n${scene}`;
const forbidden = [
  { pattern: /(?:https?:)?\/\//iu, label: "remote URL" },
  { pattern: /@import\b/iu, label: "CSS import" },
  { pattern: /\b(?:linear|radial|conic)-gradient\s*\(/iu, label: "gradient" },
  { pattern: /\b(?:rgb|rgba|hsl|hsla|lab|lch)\s*\(/iu, label: "non-OKLCH color" },
  { pattern: /#[\da-f]{3,8}\b/iu, label: "hex color" },
  { pattern: /\binnerHTML\b/u, label: "unsafe HTML mutation" },
];

for (const rule of forbidden) {
  if (rule.pattern.test(allSource)) {
    errors.push(`contains forbidden ${rule.label}`);
  }
}

try {
  checkExamplePage(examplePage, JSON.parse(exampleData));
  checkExampleFrame(html);
} catch (error) {
  errors.push(`example boundary: ${error.message}`);
}

if (errors.length > 0) {
  throw new Error(`website check failed:\n- ${errors.join("\n- ")}`);
}

console.log(`website check: ${requestedTarget} passed static, privacy and design constraints.`);

function assertExample(condition, message) {
  if (!condition) throw new Error(message);
}

function checkExampleFrame(source) {
  const frames = [...source.matchAll(/<iframe\b[^>]*>/giu)];
  assertExample(frames.length === 1, "exactly one sandboxed example frame is required");
  const frame = frames[0][0];
  for (const [name, value] of [
    ["src", "./untangle-example.html"],
    ["sandbox", "allow-scripts"],
    ["loading", "lazy"],
    ["referrerpolicy", "no-referrer"],
  ]) {
    const attributes = [...frame.matchAll(new RegExp(`\\b${name}="([^"]*)"`, "gu"))];
    assertExample(
      attributes.length === 1 && attributes[0][1] === value,
      `example iframe ${name} must be exactly ${value}`,
    );
  }
  assertExample(
    frame.match(/\btitle="([^"]+)"/u)?.[1].trim(),
    "example iframe needs a descriptive title",
  );
  assertExample(
    !/\s(?:srcdoc|allow|allowfullscreen|credentialless|browsingtopics|sharedstoragewritable)(?:[\s=>])/iu.test(
      frame,
    ) && !/\son[a-z][\w:-]*\s*=/iu.test(frame),
    "example iframe must not add inline content, permissions or event handlers",
  );
  const allowedAttributes = new Set([
    "class",
    "id",
    "src",
    "title",
    "aria-describedby",
    "sandbox",
    "loading",
    "referrerpolicy",
  ]);
  assertExample(
    [...frame.matchAll(/\s([\w:-]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gu)].every((match) =>
      allowedAttributes.has(match[1]),
    ),
    "example iframe must use only its selected presentation and sandbox attributes",
  );
  const description = frame.match(/\baria-describedby="([^"]+)"/u)?.[1];
  assertExample(description, "example iframe needs a linked description");
  for (const id of description.split(/\s+/u)) {
    assertExample(
      /^[A-Za-z][\w-]*$/u.test(id) && source.includes(`id="${id}"`),
      "example iframe description must resolve to local content",
    );
    const content = source.match(
      new RegExp(`<([a-z][\\w-]*)\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)<\\/\\1>`, "u"),
    )?.[2];
    assertExample(
      content?.replace(/<[^>]+>/gu, "").trim(),
      "example iframe description must contain non-empty local content",
    );
  }
  for (const asset of ["untangle-example.html", "untangle-example.json"]) {
    assertExample(
      new RegExp(`<a\\b[^>]*\\bhref="\\./${asset.replace(".", "\\.")}"`, "u").test(source),
      `example needs a standalone local link to ${asset}`,
    );
  }
}

function checkExamplePage(source, envelope) {
  validatePublicExampleProjection(envelope);
  assertFrozenExampleMeasurement(envelope);
  assertExample(source.includes('<html lang="en">'), "example must be English");
  assertExample(
    source.includes('<meta name="referrer" content="no-referrer">'),
    "example must suppress referrers",
  );
  const scripts = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)];
  const styles = [...source.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/giu)];
  assertExample(
    [...source.matchAll(/<script\b/giu)].length === 2 &&
      [...source.matchAll(/<style\b/giu)].length === 1 &&
      scripts.length === 2 &&
      scripts[0][1].trim() === 'type="application/json" id="map-data"' &&
      scripts[1][1].trim() === "" &&
      styles.length === 1 &&
      styles[0][1].trim() === "",
    "example must contain only its inert graph data and approved inline runtime/style",
  );
  const runtime = scripts[1][2];
  const css = styles[0][2];
  const hash = (value, encoding = "hex") =>
    createHash("sha256").update(value, "utf8").digest(encoding);
  // Approved 8dfb919 renderer bytes; the measurement remains the independent d11bdaf snapshot.
  assertExample(
    hash(runtime) === "fc5c0403406e844823823a63ff86726dc93a431af86724e504a497a902fef248",
    "example script differs from the approved renderer",
  );
  assertExample(
    hash(css) === "f4a358e3fd98d19305eecc37a07f49f8a3a79d1885c181c7021944735fc409e5",
    "example style differs from the approved renderer",
  );
  assertExample(
    envelope.provenance.revision === "d11bdaf0b474cbe4c09095d59a9da05463cc1134" &&
      envelope.provenance.renderer.revision === "8dfb919d54a698c10034f1ee6576dd16b67f6a89" &&
      envelope.provenance.renderer.gitSourceManifestSha256 ===
        "dd3287613d45d786caca2ca118400782089e5a8441df5d489aa7c4b328e6a4be" &&
      envelope.provenance.renderer.builtDistManifestSha256 ===
        "f58eea57b833d987353dc5c0a27352e41768a11d9c3150f292925eaaeafe572f" &&
      hash(JSON.stringify(envelope.provenance.renderer.sourceFiles)) ===
        "e78a287cf3fa18242051607f987d099e2f5a0f8f55045892489f23e2cd1f0dc4" &&
      hash(JSON.stringify(envelope.provenance.renderer.distFiles)) ===
        "d1500dc1c9cce32f6b8f616c4817acb116c3ecac0e2b283af4d0877579961aac" &&
      envelope.provenance.renderer.scriptSha256 === hash(runtime) &&
      envelope.provenance.renderer.styleSha256 === hash(css),
    "example provenance must identify the frozen source and the shipped renderer",
  );
  const policy = [
    "default-src 'none'",
    `script-src 'sha256-${hash(runtime, "base64")}'`,
    `style-src 'sha256-${hash(css, "base64")}'`,
    "connect-src 'none'",
    "img-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const policies = [
    ...source.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/gu),
  ];
  assertExample(
    policies.length === 1 && policies[0][1] === policy,
    "example CSP must use exact renderer hashes and deny network access",
  );
  const encoded = scripts[0][2];
  assertExample(
    /^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) &&
      Buffer.from(encoded, "base64").toString("base64") === encoded,
    "example graph data must be canonical base64",
  );
  const graph = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64")),
  );
  assertExample(
    isDeepStrictEqual(graph, envelope.graph),
    "example embedded graph differs from the public JSON projection",
  );
  const markup = source
    .replace(scripts[0][0], "")
    .replace(scripts[1][0], "")
    .replace(styles[0][0], "");
  const groupings = [
    ...markup.matchAll(/<select\b[^>]*\bid="grouping"[^>]*>([\s\S]*?)<\/select>/giu),
  ];
  const groupingOptions = [
    ["feature", "Features"],
    ["code", "Code areas"],
    ["test", "Test areas"],
    ["owner", "Ownership"],
    ["intent", "Vision / Spec"],
    ["unmapped", "Unassigned"],
  ];
  assertExample(
    groupings.length === 1 &&
      groupings[0][0].startsWith('<select id="grouping" aria-describedby="grouping-help">') &&
      groupings[0][1] ===
        groupingOptions
          .map(([value, label]) => `<option value="${value}">${label}</option>`)
          .join("") &&
      markup.includes('<label for="grouping">Untangle by</label>') &&
      markup.includes('<label for="kind">Layer</label><select id="kind">') &&
      [...markup.matchAll(/<select\b[^>]*\bid="kind"[^>]*>/giu)].length === 1,
    "example must expose all six grouping choices separately from the layer filter",
  );
  const groupingHelp = markup.match(/<p id="grouping-help" class="sr">([^<]+)<\/p>/u)?.[1] ?? "";
  assertExample(
    [
      "Choose a grouping independently of the layer filter.",
      "Code and test areas use file directories.",
      "Ownership and document context follow declared feature links; they do not infer file ownership or specification conformance.",
      "Changing the grouping returns to the tangle without starting motion.",
    ].every((sentence) => groupingHelp.includes(sentence)),
    "example grouping help must explain directory and declared-context boundaries",
  );
  const groupIndexes = [
    ...markup.matchAll(/<details\b[^>]*\bid="group-index"[^>]*>[\s\S]*?<\/details>/giu),
  ];
  assertExample(
    groupIndexes.length === 1 &&
      groupIndexes[0][0] ===
        '<details id="group-index"><summary>Groups <span id="group-count"></span></summary><p id="group-note"></p><ul id="group-list"></ul></details>',
    "example must expose a native Groups disclosure with its count, note and list targets",
  );
  assertExample(
    [...markup.matchAll(/<meta\b[^>]*\bhttp-equiv\s*=[^>]*>/giu)].every(
      (match) => match[0] === policies[0][0],
    ),
    "example must not contain redirects or additional HTTP-equivalent policies",
  );
  assertExample(
    !/<(?:base|iframe|frame|frameset|object|embed|link|img|image|audio|video|source|form|foreignObject)\b/iu.test(
      markup,
    ) &&
      !/\son[a-z][\w:-]*\s*=/iu.test(markup) &&
      !/\b(?:src|srcset|poster|action|formaction|ping)\s*=/iu.test(markup),
    "example must not embed resources, forms or event-handler attributes",
  );
  const links = [...markup.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/giu)];
  assertExample(
    links.length === [...markup.matchAll(/\bhref\s*=/giu)].length,
    "example links must use quoted in-page anchors",
  );
  for (const link of links) {
    assertExample(/^#[A-Za-z][\w-]*$/u.test(link[2]), "example links must be in-page anchors");
  }
  assertExample(!/@import\b|\burl\s*\(/iu.test(css), "example style must not load resources");
  assertExample(
    !/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|\.sendBeacon\b|\bimport\s*\(|\b(?:eval|Function)\s*\(|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|(?:window|globalThis)\.(?:open|location)\b|navigator\.serviceWorker|new\s+(?:Worker|SharedWorker)\b/u.test(
      runtime,
    ),
    "example runtime must not use network APIs or dynamic code/markup sinks",
  );
  // The SVG namespace is an identifier, not a resource URL. Accept only these exact contexts.
  const localSource = `${markup}\n${css}\n${runtime}`
    .replaceAll('xmlns="http://www.w3.org/2000/svg"', 'xmlns="SVG_NAMESPACE"')
    .replaceAll(
      'document.createElementNS("http://www.w3.org/2000/svg",',
      'document.createElementNS("SVG_NAMESPACE",',
    );
  assertExample(!/(?:https?:)?\/\//iu.test(localSource), "example contains a remote URL");
}
