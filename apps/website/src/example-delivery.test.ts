import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = path.resolve(sourceRoot, "..");
const roots: string[] = [];

interface PublicExample {
  provenance: {
    revision: string;
    publishedGraphSha256: string;
    renderer: {
      revision: string;
      sourceFiles: { path: string; sha256: string }[];
      distFiles: { path: string; sha256: string }[];
      scriptSha256: string;
      scriptSha256Base64: string;
    };
  };
  graph: {
    summary: {
      features: number;
      totalNodes: number;
      totalEdges: number;
      unmappedCodeFiles: number;
    };
    nodes: Array<{
      kind: string;
      label: string;
      status: string;
      path?: string;
      details: Record<string, unknown>;
    }>;
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "untangle-example-delivery-"));
  roots.push(root);
  const website = path.join(root, "apps/website");
  await mkdir(path.join(website, "src"), { recursive: true });
  await mkdir(path.join(website, "scripts"));
  await Promise.all(
    [
      "index.html",
      "styles.css",
      "site.js",
      "story.js",
      "yarn-scene.js",
      "untangle-logo.svg",
      "untangle-yarn-3d.png",
      "untangle-example.html",
      "untangle-example.json",
    ].map((name) => copyFile(path.join(sourceRoot, name), path.join(website, "src", name))),
  );
  await Promise.all(
    ["build.mjs", "check.mjs", "generate-example.mjs"].map((name) =>
      copyFile(path.join(packageRoot, "scripts", name), path.join(website, "scripts", name)),
    ),
  );
  return { root, website, source: path.join(website, "src"), output: path.join(website, "dist") };
}

async function check(root: string) {
  return execute(process.execPath, ["apps/website/scripts/check.mjs", "src"], {
    cwd: root,
    timeout: 3_000,
  });
}

async function reject(root: string, message: string) {
  await expect(check(root)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(message),
  });
}

async function replaceSource(
  source: string,
  name: string,
  before: string,
  after: string,
  region?: RegExp,
) {
  const file = path.join(source, name);
  const content = await readFile(file, "utf8");
  const selected = region ? content.match(region)?.[0] : content;
  expect(selected).toBeDefined();
  expect(selected).toContain(before);
  await writeFile(file, content.replace(selected!, selected!.replace(before, after)));
}

async function mutateProjection(source: string, change: (example: PublicExample) => void) {
  const file = path.join(source, "untangle-example.json");
  const example = JSON.parse(await readFile(file, "utf8")) as PublicExample;
  change(example);
  example.provenance.publishedGraphSha256 = createHash("sha256")
    .update(JSON.stringify(example.graph))
    .digest("hex");
  await writeFile(file, JSON.stringify(example));
  const html = await readFile(path.join(source, "untangle-example.html"), "utf8");
  await writeFile(
    path.join(source, "untangle-example.html"),
    html.replace(
      /(<script type="application\/json" id="map-data">)[\s\S]*?(<\/script>)/u,
      `$1${Buffer.from(JSON.stringify(example.graph)).toString("base64")}$2`,
    ),
  );
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("Real codebase publication boundary", () => {
  it("builds the selected example byte-for-byte and accepts its sandboxed local viewer", async () => {
    const { root, source, output } = await fixture();
    await expect(check(root)).resolves.toMatchObject({ stderr: "" });
    await execute(process.execPath, ["apps/website/scripts/build.mjs"], {
      cwd: root,
      timeout: 3_000,
    });
    for (const name of ["untangle-example.html", "untangle-example.json"]) {
      expect(
        (await readFile(path.join(output, name))).equals(await readFile(path.join(source, name))),
      ).toBe(true);
    }
  });

  it("reports the frozen snapshot's actual counts and revision in the landing page", async () => {
    const example = JSON.parse(
      await readFile(path.join(sourceRoot, "untangle-example.json"), "utf8"),
    ) as PublicExample;
    const landing = (await readFile(path.join(sourceRoot, "index.html"), "utf8")).replace(
      /\s+/gu,
      " ",
    );
    const { summary } = example.graph;
    expect(landing).toContain(`${summary.features} declared features`);
    expect(landing).toContain(`${summary.totalNodes.toLocaleString("en-US")} nodes`);
    expect(landing).toContain(`${summary.totalEdges.toLocaleString("en-US")} relationships`);
    expect(landing).toContain(`${summary.unmappedCodeFiles} unassigned code files`);
    expect(landing).toContain(`<code>${example.provenance.revision.slice(0, 7)}</code>`);
  });

  it("links directly to the product viewer's real untangle action", async () => {
    const landing = await readFile(path.join(sourceRoot, "index.html"), "utf8");
    const viewer = await readFile(path.join(sourceRoot, "untangle-example.html"), "utf8");
    expect(landing).toContain('href="./untangle-example.html#untangle-view"');
    expect(viewer).toContain('id="untangle-view"');
    expect(viewer).toMatch(/<button\b[^>]*id="untangle"[^>]*>Untangle by feature<\/button>/u);
    expect(viewer).toContain("Code and metrics are unchanged.");
  });

  it("publishes each category as a grouping choice with its own layer filter and declared-context help", async () => {
    const viewer = await readFile(path.join(sourceRoot, "untangle-example.html"), "utf8");
    const grouping = viewer.match(
      /<select id="grouping" aria-describedby="grouping-help">([\s\S]*?)<\/select>/u,
    );
    expect(grouping).not.toBeNull();
    expect(
      [...grouping![1]!.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/gu)].map((option) => [
        option[1],
        option[2],
      ]),
    ).toEqual([
      ["feature", "Features"],
      ["code", "Code areas"],
      ["test", "Test areas"],
      ["owner", "Ownership"],
      ["intent", "Vision / Spec"],
      ["unmapped", "Unassigned"],
    ]);
    expect(viewer).toContain('<label for="kind">Layer</label><select id="kind">');
    expect(viewer).toContain("they do not infer file ownership or specification conformance");
    expect(viewer).toContain(
      "Changing the grouping returns to the tangle without starting motion.",
    );
  });

  it.each([
    ["missing selector", 'id="grouping"', 'id="missing-grouping"', "all six grouping choices"],
    ["unknown option", 'value="code"', 'value="unknown"', "all six grouping choices"],
    ["conflated layer", 'id="kind"', 'id="grouping"', "all six grouping choices"],
    ["missing help", 'id="grouping-help"', 'id="missing-grouping-help"', "grouping help"],
  ])("rejects published grouping controls with %s", async (_name, before, after, message) => {
    const { root, source } = await fixture();
    await replaceSource(
      source,
      "untangle-example.html",
      before,
      after,
      before.startsWith("value=") ? /<select id="grouping"[^>]*>[\s\S]*?<\/select>/u : undefined,
    );
    await reject(root, message);
  });

  it("provides the native Groups disclosure and all targets for complete names and visible counts", async () => {
    const viewer = await readFile(path.join(sourceRoot, "untangle-example.html"), "utf8");
    expect(viewer).toContain(
      '<details id="group-index"><summary>Groups <span id="group-count"></span></summary><p id="group-note"></p><ul id="group-list"></ul></details>',
    );
  });

  it.each(["group-index", "group-count", "group-note", "group-list"])(
    "rejects a published Groups index without the %s target",
    async (id) => {
      const { root, source } = await fixture();
      await replaceSource(source, "untangle-example.html", `id="${id}"`, `id="missing-${id}"`);
      await reject(root, "native Groups disclosure");
    },
  );

  it("rejects replacing the keyboard-native Groups disclosure with a generic section", async () => {
    const { root, source } = await fixture();
    await replaceSource(
      source,
      "untangle-example.html",
      '<details id="group-index">',
      '<section id="group-index">',
    );
    await reject(root, "native Groups disclosure");
  });

  it.each(["revision", "sourceFiles", "distFiles"] as const)(
    "rejects substituted renderer %s provenance without consulting Git history",
    async (field) => {
      const { root, source } = await fixture();
      const file = path.join(source, "untangle-example.json");
      const example = JSON.parse(await readFile(file, "utf8")) as PublicExample;
      if (field === "revision") example.provenance.renderer.revision = example.provenance.revision;
      else example.provenance.renderer[field][0].sha256 = "0".repeat(64);
      await writeFile(file, JSON.stringify(example));
      await reject(root, "provenance must identify the frozen source and the shipped renderer");
    },
  );

  it.each([
    ["sandbox", 'sandbox="allow-scripts"', "", "iframe sandbox"],
    [
      "same-origin",
      'sandbox="allow-scripts"',
      'sandbox="allow-scripts allow-same-origin"',
      "iframe sandbox",
    ],
    ["eager loading", 'loading="lazy"', 'loading="eager"', "iframe loading"],
    [
      "referrers",
      'referrerpolicy="no-referrer"',
      'referrerpolicy="unsafe-url"',
      "iframe referrerpolicy",
    ],
    [
      "inline content",
      'sandbox="allow-scripts"',
      'sandbox="allow-scripts" srcdoc="inline"',
      "must not add inline content",
    ],
    [
      "browser permissions",
      'sandbox="allow-scripts"',
      'sandbox="allow-scripts" allow="camera; microphone"',
      "must not add inline content",
    ],
    [
      "fullscreen permissions",
      'sandbox="allow-scripts"',
      'sandbox="allow-scripts" allowfullscreen',
      "must not add inline content",
    ],
    ["title", 'title="Untangle\'s real 3D feature and code map"', "", "descriptive title"],
    [
      "description",
      'aria-describedby="codebase-controls codebase-provenance"',
      "",
      "linked description",
    ],
    [
      "unresolved description",
      'aria-describedby="codebase-controls codebase-provenance"',
      'aria-describedby="missing-example-help"',
      "description must resolve",
    ],
    [
      "standalone viewer link",
      'href="./untangle-example.html"',
      'href="#real-codebase"',
      "standalone local link to untangle-example.html",
    ],
    [
      "JSON link",
      'href="./untangle-example.json"',
      'href="#real-codebase"',
      "standalone local link to untangle-example.json",
    ],
  ])("rejects an embedding that changes %s", async (_name, before, after, message) => {
    const { root, source } = await fixture();
    await replaceSource(
      source,
      "index.html",
      before,
      after,
      before.startsWith("href=") ? undefined : /<iframe\b[^>]*>/u,
    );
    await reject(root, message);
  });

  it("rejects an iframe description that resolves to empty content", async () => {
    const { root, source } = await fixture();
    const file = path.join(source, "index.html");
    const html = await readFile(file, "utf8");
    await writeFile(
      file,
      html.replace(/(<p\b[^>]*id="codebase-controls"[^>]*>)[\s\S]*?(<\/p>)/u, "$1$2"),
    );
    await reject(root, "description must contain non-empty local content");
  });

  it("rejects additional iframe permission attributes outside the selected contract", async () => {
    const { root, source } = await fixture();
    await replaceSource(
      source,
      "index.html",
      'sandbox="allow-scripts"',
      'sandbox="allow-scripts" allowpaymentrequest',
      /<iframe\b[^>]*>/u,
    );
    await reject(root, "only its selected presentation and sandbox attributes");
  });

  it("rejects changed executable bytes even when their CSP and metadata hashes are updated", async () => {
    const { root, source } = await fixture();
    const htmlFile = path.join(source, "untangle-example.html");
    let html = await readFile(htmlFile, "utf8");
    const original = html.match(/<script>([\s\S]*?)<\/script>/u)![1];
    const modified = `${original}\nfetch("https://example.invalid/tracker");`;
    const oldHash = createHash("sha256").update(original).digest("base64");
    const newHash = createHash("sha256").update(modified).digest("base64");
    html = html.replace(original, modified).replace(`sha256-${oldHash}`, `sha256-${newHash}`);
    await writeFile(htmlFile, html);
    const jsonFile = path.join(source, "untangle-example.json");
    const example = JSON.parse(await readFile(jsonFile, "utf8")) as PublicExample;
    example.provenance.renderer.scriptSha256 = createHash("sha256").update(modified).digest("hex");
    example.provenance.renderer.scriptSha256Base64 = newHash;
    await writeFile(jsonFile, JSON.stringify(example));
    await reject(root, "script differs from the approved renderer");
  });

  it.each([
    ["network CSP", "connect-src 'none'", "connect-src 'self'", "example CSP"],
    [
      "remote image",
      "</header>",
      '</header><img src="https://example.invalid/pixel">',
      "must not embed resources",
    ],
    [
      "namespace as navigation",
      'href="#viewport"',
      'href="http://www.w3.org/2000/svg"',
      "links must be in-page anchors",
    ],
    [
      "redirect",
      "</head>",
      '</head><meta http-equiv="refresh" content="0;url=./private.json">',
      "must not contain redirects",
    ],
    [
      "extra executable tag",
      "</body>",
      "<SCRIPT>globalThis.changed=true</SCRIPT></body>",
      "only its inert graph data",
    ],
    [
      "event handler",
      '<svg id="map"',
      '<svg onload="globalThis.changed=true" id="map"',
      "must not embed resources",
    ],
  ])("rejects a generated page with %s", async (_name, before, after, message) => {
    const { root, source } = await fixture();
    await replaceSource(source, "untangle-example.html", before, after);
    await reject(root, message);
  });

  it("rejects private source text added to the public envelope", async () => {
    const { root, source } = await fixture();
    await mutateProjection(source, (example) => {
      Object.assign(example.provenance, { sourceText: "const confidential = true;" });
    });
    await reject(root, "Unexpected metadata field");
  });

  it("rejects absolute source paths despite matching graph digests and embedded data", async () => {
    const { root, source } = await fixture();
    await mutateProjection(source, (example) => {
      example.graph.nodes.find((node) => node.path !== undefined)!.path =
        "/Users/private/project/source.ts";
    });
    await reject(root, "Private path, remote URL or unsafe metadata text");
  });

  it("rejects a graph in the viewer that differs from its checked public JSON", async () => {
    const { root, source } = await fixture();
    const file = path.join(source, "untangle-example.html");
    const html = await readFile(file, "utf8");
    const data = html.match(
      /<script type="application\/json" id="map-data">([\s\S]*?)<\/script>/u,
    )![1];
    const graph = JSON.parse(
      Buffer.from(data, "base64").toString("utf8"),
    ) as PublicExample["graph"];
    graph.nodes[0].label = "Different graph";
    await writeFile(
      file,
      html.replace(data, Buffer.from(JSON.stringify(graph)).toString("base64")),
    );
    await reject(root, "embedded graph differs from the public JSON projection");
  });

  it("rejects symlinked metadata before reading a public projection", async () => {
    const { root, source } = await fixture();
    const file = path.join(source, "untangle-example.json");
    await rm(file);
    await symlink(path.join(sourceRoot, "untangle-example.json"), file);
    await reject(root, "asset must be a regular file");
  });
});
