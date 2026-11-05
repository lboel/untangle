/**
 * Integrationstest gegen den ECHTEN Parser (E5: kein Agentenbericht ersetzt
 * einen Testlauf). Hier laeuft `@untangle-code/parser-registry` mit seinen
 * echten Grammatiken, nicht ein nachgebauter Adapter.
 *
 * Der Test belegt insbesondere die Entscheidung aus `build.ts`: die Zuordnung
 * der Aufrufstelle zum aufrufenden Symbol ueber Bereichsenthaltung stimmt mit
 * dem ueberein, was der Adapter in `RawCall.callerScopeId` selbst gebildet
 * haette — ohne dass dieses Paket dessen Format kennt.
 */
import type { SourceFile } from "@untangle-code/domain";
import { validateSkipLedger, validateSymbolEdge } from "@untangle-code/domain";
import { createParserRegistry } from "@untangle-code/parser-registry";
import { describe, expect, it } from "vitest";

import { buildSymbolGraph } from "./build.js";
import { collectSymbolGraphFiles } from "./collect.js";
import { detectEntryPoints } from "./entry-points.js";
import { createSymbolGraphIndex } from "./graph-index.js";
import { analyzeImpact } from "./impact.js";
import { findShortestCallPath } from "./paths.js";
import { GENEROUS_LIMITS } from "./test-support/fixtures.js";

const MAIN_TS = `import { format } from "./format";

export function main(): string {
  return render();
}

export function render(): string {
  return format("hello");
}
`;

const FORMAT_TS = `export function format(value: string): string {
  return value.trim();
}
`;

const NOTES_MD = `# Notizen

Diese Datei hat keine Symbole.
`;

function sourceOf(path: string, content: string, languageId: string, fileId: string): SourceFile {
  return {
    fileId,
    repoId: "repo-1",
    refId: "ref-1",
    path,
    languageId,
    content,
    contentHash: `hash-${fileId}`,
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

function parseAll() {
  const registry = createParserRegistry();
  const files = [
    sourceOf("src/main.ts", MAIN_TS, "typescript", "file-main"),
    sourceOf("src/format.ts", FORMAT_TS, "typescript", "file-format"),
  ];
  return files.map((source) => {
    const adapter = registry.getAdapterForPath(source.path);
    if (adapter === null) throw new Error(`no adapter for ${source.path}`);
    return { adapter, source, parseResult: adapter.parse(source) };
  });
}

describe("Integration mit dem echten Parser", () => {
  it("builds nodes and edges from real TypeScript", () => {
    const collected = collectSymbolGraphFiles(parseAll());
    expect(collected.skipped).toEqual([]);

    const graph = buildSymbolGraph({
      workspaceId: "ws-int",
      graphGeneration: "gen-int",
      files: collected.files,
      resolvedImports: [
        { fromFileId: "file-main", specifier: "./format", toFileId: "file-format" },
      ],
    });

    expect(graph.nodes.map((node) => node.qualifiedName).sort()).toEqual([
      "format",
      "main",
      "render",
    ]);
    for (const edge of graph.edges) expect(validateSymbolEdge(edge)).toEqual([]);
    expect(validateSkipLedger(graph.skipped)).toEqual([]);
  });

  it("attributes each real call site to the enclosing symbol", () => {
    const collected = collectSymbolGraphFiles(parseAll());
    const graph = buildSymbolGraph({
      workspaceId: "ws-int",
      graphGeneration: "gen-int",
      files: collected.files,
      resolvedImports: [
        { fromFileId: "file-main", specifier: "./format", toFileId: "file-format" },
      ],
    });
    const byName = new Map(graph.nodes.map((node) => [node.qualifiedName, node.id]));
    const renderCall = graph.edges.find((edge) => edge.toName === "render");
    const formatCall = graph.edges.find((edge) => edge.toName === "format");
    expect(renderCall?.fromSymbolId).toBe(byName.get("main"));
    expect(renderCall?.resolution).toBe("exact");
    expect(formatCall?.fromSymbolId).toBe(byName.get("render"));
    expect(formatCall?.resolution).toBe("exact");
    expect(formatCall?.target?.qualifiedName).toBe("format");
  });

  it("finds the call path main -> render -> format", () => {
    const collected = collectSymbolGraphFiles(parseAll());
    const graph = buildSymbolGraph({
      workspaceId: "ws-int",
      graphGeneration: "gen-int",
      files: collected.files,
      resolvedImports: [
        { fromFileId: "file-main", specifier: "./format", toFileId: "file-format" },
      ],
    });
    const index = createSymbolGraphIndex(graph);
    const byName = new Map(graph.nodes.map((node) => [node.qualifiedName, node.id]));
    const path = findShortestCallPath(index, {
      fromSymbolId: byName.get("main") ?? "",
      toSymbolId: byName.get("format") ?? "",
      limits: GENEROUS_LIMITS,
    });
    expect(path.path?.depth).toBe(2);
    expect(path.path?.symbolIds).toEqual([
      byName.get("main"),
      byName.get("render"),
      byName.get("format"),
    ]);
    expect(path.path?.weakestResolution).toBe("exact");
  });

  it("reports the transitive impact of changing format", () => {
    const collected = collectSymbolGraphFiles(parseAll());
    const graph = buildSymbolGraph({
      workspaceId: "ws-int",
      graphGeneration: "gen-int",
      files: collected.files,
      resolvedImports: [
        { fromFileId: "file-main", specifier: "./format", toFileId: "file-format" },
      ],
    });
    const index = createSymbolGraphIndex(graph);
    const byName = new Map(graph.nodes.map((node) => [node.qualifiedName, node.id]));
    const impact = analyzeImpact(index, {
      rootSymbolIds: [byName.get("format") ?? ""],
      limits: GENEROUS_LIMITS,
    });
    expect(impact.affected.map((entry) => entry.qualifiedName).sort()).toEqual(["main", "render"]);
    expect(impact.containsAmbiguousEdges).toBe(false);
  });

  it("detects main as an entry point", () => {
    const collected = collectSymbolGraphFiles(parseAll());
    const graph = buildSymbolGraph({
      workspaceId: "ws-int",
      graphGeneration: "gen-int",
      files: collected.files,
      resolvedImports: [
        { fromFileId: "file-main", specifier: "./format", toFileId: "file-format" },
      ],
    });
    const set = detectEntryPoints(createSymbolGraphIndex(graph));
    const main = set.entryPoints.find((entry) => entry.qualifiedName === "main");
    expect(main?.kinds).toEqual(["conventional_name", "orphan"]);
  });

  // WP-110/WP-217 hat diesen Fall umgedreht: Markdown ist nicht mehr
  // "kein Adapter registriert", sondern Stufe "text" mit Abschnittssymbolen.
  // Der Symbolgraph muss damit umgehen, OHNE Kanten zu erfinden — ein
  // Abschnitt ruft nichts auf.
  it("traegt Markdown-Abschnitte als Knoten, erfindet aber keine Kanten", () => {
    const registry = createParserRegistry();
    const adapter = registry.getAdapterForPath("docs/notes.md");
    expect(adapter?.supportLevel).toBe("text");
    if (adapter === null) throw new Error("prose adapter must be registered");

    const parsed = adapter.parse(sourceOf("docs/notes.md", NOTES_MD, "markdown", "file-md"));
    expect(parsed.parseQuality).toBe("complete");
    if (parsed.ast === null) throw new Error("prose parse must never return a null ast");
    const symbols = adapter.extractSymbols(parsed.ast);
    expect(symbols.map((symbol) => symbol.kind)).toEqual(["section"]);

    const graph = buildSymbolGraph({
      workspaceId: "ws-int",
      graphGeneration: "gen-int",
      files: [
        {
          fileId: "file-md",
          repoId: "repo-1",
          refId: "ref-1",
          path: "docs/notes.md",
          languageId: "markdown",
          content: NOTES_MD,
          parseQuality: parsed.parseQuality,
          symbols,
          calls: adapter.extractCalls(parsed.ast),
          imports: adapter.extractImports(parsed.ast),
        },
      ],
    });
    expect(graph.nodes).toHaveLength(symbols.length);
    expect(graph.edges).toEqual([]);
    expect(graph.metrics.symbolLessFileCount).toBe(0);
  });
});
