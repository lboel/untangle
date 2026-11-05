import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import { GraphExplorerInputError } from "./errors.js";
import { createGraphExplorerHtml } from "./html.js";
import { normalizeGraphExplorerInput } from "./normalize.js";
import type {
  ExplorerFileEdgeV1,
  ExplorerFileNodeV1,
  ExplorerSymbolNodeV1,
  GraphExplorerDocumentDataV1,
  GraphExplorerInputV1,
} from "./types.js";
import { EXPLORER_SCRIPT } from "./ui-assets.js";
import { writeGraphExplorerHtml } from "./write.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("createGraphExplorerHtml", () => {
  it("uses English controls while preserving original repository labels", () => {
    const input = fixture();
    input.workspace = { ...input.workspace!, label: "Buchhaltung und Aufträge" };
    const { html } = createGraphExplorerHtml(input);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain(">Find nodes</label>");
    expect(html).toContain(">File dependencies</h2>");
    expect(html).toContain('aria-label="Reset view"');
    expect(html).not.toContain("Knoten suchen");
    const encoded = extract(html, /<template id="graph-data">([^<]*)<\/template>/u);
    const data = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as GraphExplorerDocumentDataV1;
    expect(data.workspace.label).toBe("Buchhaltung und Aufträge");
  });

  it("embeds hostile labels only as Base64 and never serializes source content", () => {
    const hostile = `</template><script>globalThis.pwned=true</script><img src=x onerror=alert(1)>`;
    const sourceSentinels = [
      "TOP SECRET SOURCE CODE",
      "TOP SECRET RAW IMPORT",
      "TOP SECRET CONTENT HASH",
      "TOP SECRET SIGNATURE",
    ];
    const input = fixture();
    input.workspace = {
      workspaceId: input.fileGraph.workspaceId,
      generationId: input.fileGraph.graphGeneration,
      label: hostile,
      repositories: [{ repoId: "repo-a", label: `A & "B" ${hostile}` }],
    };
    input.fileGraph.nodes = [
      {
        ...input.fileGraph.nodes[0],
        filePath: `src/${hostile}.ts`,
        content: sourceSentinels[0],
        imports: [sourceSentinels[1]],
        contentHash: sourceSentinels[2],
      } as ExplorerFileNodeV1,
    ];
    input.fileGraph.edges = [];
    input.symbolGraph = {
      schemaVersion: 1,
      workspaceId: input.fileGraph.workspaceId,
      graphGeneration: input.fileGraph.graphGeneration,
      nodes: [
        {
          ...symbolNode("symbol-a", "alpha", "src/alpha.ts", 1),
          signature: sourceSentinels[3],
          contentHash: sourceSentinels[2],
        } as ExplorerSymbolNodeV1,
      ],
      edges: [],
    };

    const artifact = createGraphExplorerHtml(input, { title: hostile });
    const encoded = extract(artifact.html, /<template id="graph-data">([^<]*)<\/template>/u);
    const outsideData = artifact.html.replace(encoded, "BASE64_DATA");
    const decoded = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as GraphExplorerDocumentDataV1;

    expect(outsideData).not.toContain(hostile);
    for (const sentinel of sourceSentinels) expect(artifact.html).not.toContain(sentinel);
    expect(decoded.title).toBe(hostile);
    expect(decoded.workspace.label).toBe(hostile);
    expect(decoded.views.file.nodes[0]?.filePath).toContain(hostile);
    for (const sentinel of sourceSentinels) expect(JSON.stringify(decoded)).not.toContain(sentinel);
    expect(artifact.html).not.toMatch(/\.innerHTML|insertAdjacentHTML|document\.write/u);
  });

  it("is byte-deterministic across shuffled equivalent snapshots", () => {
    const firstInput = fixture();
    const secondInput = fixture();
    secondInput.fileGraph.nodes = [...secondInput.fileGraph.nodes].reverse();
    secondInput.fileGraph.edges = [...secondInput.fileGraph.edges].reverse();
    secondInput.workspace = {
      ...secondInput.workspace,
      repositories: [...(secondInput.workspace?.repositories ?? [])].reverse(),
    } as NonNullable<GraphExplorerInputV1["workspace"]>;

    const first = createGraphExplorerHtml(firstInput);
    const second = createGraphExplorerHtml(secondInput);

    expect(second.html).toBe(first.html);
    expect(second.bytes).toBe(first.bytes);
    expect(second.sha256).toBe(first.sha256);
    expect(first.sha256).toBe(createHash("sha256").update(first.html, "utf8").digest("hex"));
    expect(first.bytes).toBe(Buffer.byteLength(first.html, "utf8"));
  });

  it("uses exact CSP hashes for its sole inline style and script", () => {
    const { html } = createGraphExplorerHtml(fixture());
    const policy = extract(html, /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/u);
    const css = extract(html, /<style>([\s\S]*?)<\/style>/u);
    const script = extract(html, /<script>([\s\S]*?)<\/script>/u);

    expect(policy).toContain(`style-src 'sha256-${sha256Base64(css)}'`);
    expect(policy).toContain(`script-src 'sha256-${sha256Base64(script)}'`);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it("ships parseable offline runtime code without network or markup sinks", () => {
    expect(() => new Script(EXPLORER_SCRIPT)).not.toThrow();
    expect(EXPLORER_SCRIPT).not.toMatch(
      /fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon|import\s*\(|\.innerHTML|insertAdjacentHTML|eval\s*\(|new\s+Function/u,
    );
    expect(EXPLORER_SCRIPT).toContain("document.createElement(");
    expect(EXPLORER_SCRIPT).toContain("document.createElementNS(");
    expect(EXPLORER_SCRIPT).toContain("textContent");
    expect(EXPLORER_SCRIPT).toContain('canvas.getContext("2d")');
    expect(EXPLORER_SCRIPT).toContain("canvas.toBlob(");
    expect(EXPLORER_SCRIPT).toContain("URL.createObjectURL(");
    expect(EXPLORER_SCRIPT).toContain("4096 / state.viewBox.width");
  });

  it("contains labelled controls, keyboard help, inspector and reduced-motion styling", () => {
    const { html } = createGraphExplorerHtml(fixture());

    expect(html).toContain('label for="graph-search"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-describedby="graph-help"');
    expect(html).toContain('id="provenance-list"');
    expect(html).toContain('id="direct-list"');
    expect(html).toContain('id="reverse-list"');
    expect(html).toContain("@media (max-width: 29.999rem)");
    expect(html).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
    expect(html).toContain("oklch(0.550 0.095 180.0)");
  });
});

describe("normalizeGraphExplorerInput", () => {
  it("truncates deterministically and reports every dropped category exactly", () => {
    const input = fixture();
    input.fileGraph.nodes = [node("c", "src/c.ts"), node("a", "src/a.ts"), node("b", "src/b.ts")];
    input.fileGraph.edges = [
      edge("e4", "a", "b"),
      edge("e2", "b", "c"),
      edge("e5", "b", "a"),
      edge("e3", "a", "missing"),
      {
        ...edge("e1", "a", "b"),
        resolution: { status: "external" },
      },
    ];

    const data = normalizeGraphExplorerInput(input, { maxNodes: 2, maxEdges: 1 });

    expect(data.views.file.nodes.map((value) => value.id)).toEqual(["a", "b"]);
    expect(data.views.file.edges).toHaveLength(1);
    expect(data.views.file.stats).toEqual({
      inputNodeCount: 3,
      shownNodeCount: 2,
      nodeLimitDroppedCount: 1,
      sourceEdgeCount: 5,
      candidateLinkCount: 4,
      renderableLinkCount: 2,
      shownLinkCount: 1,
      unrenderableSourceEdgeCount: 1,
      missingEndpointLinkCount: 1,
      nodeLimitDroppedLinkCount: 1,
      edgeLimitDroppedLinkCount: 1,
    });
  });

  it("expands ambiguous symbol candidates deterministically and keeps provenance metadata", () => {
    const input = fixture();
    input.symbolGraph = {
      schemaVersion: 1,
      workspaceId: "workspace-1",
      graphGeneration: "generation-1",
      nodes: [
        symbolNode("symbol-b", "beta", "src/b.ts", 9),
        symbolNode("symbol-a", "alpha", "src/a.ts", 3),
      ],
      edges: [
        {
          edgeId: "call-1",
          repoId: "repo-a",
          refId: "ref-a",
          fromSymbolId: "symbol-a",
          kind: "call",
          resolution: "ambiguous",
          candidates: [
            { symbolId: "missing", weight: 0.2 },
            { symbolId: "symbol-b", weight: 0.6 },
            { symbolId: "symbol-a", weight: 0.1 },
          ],
          confidence: { value: 0.75, basis: "ignored source-free evidence" },
        },
      ],
    };

    const data = normalizeGraphExplorerInput(input);

    expect(data.views.symbol?.edges.map((value) => value.to)).toEqual(["symbol-a", "symbol-b"]);
    expect(data.views.symbol?.edges.map((value) => value.confidence)).toEqual([0.1, 0.6]);
    expect(data.views.symbol?.stats.candidateLinkCount).toBe(3);
    expect(data.views.symbol?.stats.missingEndpointLinkCount).toBe(1);
  });

  it("falls back visibly to files when a requested symbol snapshot is absent", () => {
    const data = normalizeGraphExplorerInput(fixture(), { initialView: "symbol" });

    expect(data.initialView).toBe("file");
    expect(data.initialViewFallback).toBe(true);
    expect(data.views.symbol).toBeNull();
  });

  it("derives cross-repository links from endpoint provenance", () => {
    const input = fixture();
    const second = node("b", "src/b.ts");
    input.fileGraph.nodes = [node("a", "src/a.ts"), { ...second, repoId: "repo-b" }];
    input.fileGraph.edges = [edge("cross", "a", "b")];

    expect(normalizeGraphExplorerInput(input).views.file.edges[0]?.crossRepo).toBe(true);
  });

  it("rejects unsafe display controls and snapshot generation mismatches", () => {
    const hostile = fixture();
    const hostileNode = hostile.fileGraph.nodes[0];
    if (!hostileNode) throw new Error("Fixture node missing");
    hostile.fileGraph.nodes = [{ ...hostileNode, filePath: "src/safe\u202Egpj.ts" }];
    expect(() => normalizeGraphExplorerInput(hostile)).toThrowError(GraphExplorerInputError);

    const mismatch = fixture();
    mismatch.workspace = { ...mismatch.workspace, generationId: "different" } as NonNullable<
      GraphExplorerInputV1["workspace"]
    >;
    expect(() => normalizeGraphExplorerInput(mismatch)).toThrow(
      /workspace\.generationId .* does not match/u,
    );
  });
});

describe("writeGraphExplorerHtml", () => {
  it("atomically replaces a file, preserves deterministic bytes and leaves no sibling temp file", async () => {
    const directory = await makeTemporaryDirectory();
    const outputPath = join(directory, "graph.html");
    const expected = createGraphExplorerHtml(fixture());

    const first = await writeGraphExplorerHtml(outputPath, fixture());
    expect(await readFile(outputPath, "utf8")).toBe(expected.html);
    expect(first).toMatchObject({
      path: outputPath,
      bytes: expected.bytes,
      sha256: expected.sha256,
    });

    const second = await writeGraphExplorerHtml(outputPath, fixture(), { title: "Updated" });
    const replaced = await readFile(outputPath, "utf8");
    expect(second.sha256).not.toBe(first.sha256);
    expect(createHash("sha256").update(replaced, "utf8").digest("hex")).toBe(second.sha256);
    expect(await readdir(directory)).toEqual(["graph.html"]);
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects invalid target options before creating any file", async () => {
    const directory = await makeTemporaryDirectory();
    await expect(writeGraphExplorerHtml("  ", fixture())).rejects.toThrow(TypeError);
    await expect(
      writeGraphExplorerHtml(join(directory, "graph.html"), fixture(), { mode: 0o1000 }),
    ).rejects.toThrow(RangeError);
    expect(await readdir(directory)).toEqual([]);
  });
});

function fixture(): GraphExplorerInputV1 {
  return {
    workspace: {
      workspaceId: "workspace-1",
      label: "Workspace One",
      generationId: "generation-1",
      repositories: [
        { repoId: "repo-b", label: "Repository B", refId: "ref-b", refName: "main" },
        { repoId: "repo-a", label: "Repository A", refId: "ref-a", commitSha: "abc123" },
      ],
    },
    fileGraph: {
      schemaVersion: 1,
      workspaceId: "workspace-1",
      graphGeneration: "generation-1",
      nodes: [node("b", "src/b.ts"), node("a", "src/a.ts")],
      edges: [edge("edge-b", "b", "a"), edge("edge-a", "a", "b")],
    },
  };
}

function node(id: string, filePath: string): ExplorerFileNodeV1 {
  return {
    fileId: id,
    repoId: "repo-a",
    refId: "ref-a",
    filePath,
    language: "typescript",
    packageName: "fixture",
  };
}

function edge(edgeId: string, fromFileId: string, targetFileId: string): ExplorerFileEdgeV1 {
  return {
    edgeId,
    repoId: "repo-a",
    refId: "ref-a",
    fromFileId,
    kind: "import",
    resolution: { status: "resolved", targetFileId },
    boundary: { crossRepo: false },
  };
}

function symbolNode(id: string, name: string, filePath: string, line: number) {
  return {
    id,
    name,
    qualifiedName: `fixture.${name}`,
    kind: "function",
    repoId: "repo-a",
    refId: "ref-a",
    fileId: filePath,
    filePath,
    language: "typescript",
    startLine: line,
    endLine: line + 2,
  } as const;
}

function extract(value: string, pattern: RegExp): string {
  const match = pattern.exec(value);
  if (!match?.[1]) throw new Error(`Expected pattern ${String(pattern)} in generated HTML`);
  return match[1];
}

function sha256Base64(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64");
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "untangle-graph-explorer-"));
  temporaryDirectories.push(directory);
  return directory;
}
