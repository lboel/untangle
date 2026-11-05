/**
 * WP-110, der Beweis: eine GEWOEHNLICHE `.md`-Datei — ohne jede Context-
 * Artifact-Konfiguration — bekommt ueberschriftenbewusste Abschnitte statt
 * willkuerlicher Zeilenfenster.
 *
 * Der Test faehrt die echte Naht parser-registry -> chunker, mit dem echten
 * Prosa-Adapter und ueber eine ECHTE Datei dieses Repositories (`vision.md`).
 * Nichts ist von Hand gebaut: kein Regionenbaum, kein Symbol, kein Fixture-
 * Text. Genau darum geht es — vorher lieferte `getAdapterForPath("vision.md")`
 * `null`, der Chunker sah `regions.length === 0` und fiel auf
 * `line_fallback` zurueck.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "@untangle-code/domain";
import type { SourceFile } from "@untangle-code/domain";
import { createProseAdapter } from "@untangle-code/parser-registry";
import { describe, expect, it } from "vitest";

import { chunkFile } from "./chunker.js";
import type { ChunkFileIdentity, ChunkerConfigInput } from "./types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const preparedText: ChunkerConfigInput["preparedText"] = {
  documentPrefix: "search_document:",
  repoLabel: "untangle",
  refName: "main",
};

function chunkMarkdown(relativePath: string, content: string, maxTokensPerChunk = 1024) {
  const identity: ChunkFileIdentity = {
    workspaceId: "ws-prose",
    repoId: "repo-prose",
    refId: "repo-prose:main",
    fileId: `file:${relativePath}`,
    filePath: relativePath,
    languageId: "markdown",
  };
  const adapter = createProseAdapter();
  const source: SourceFile = {
    fileId: identity.fileId,
    repoId: identity.repoId,
    refId: identity.refId,
    path: relativePath,
    languageId: identity.languageId,
    content,
    contentHash: sha256Hex(content),
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
  const parseResult = adapter.parse(source);
  const regions = parseResult.ast === null ? [] : adapter.extractChunks(parseResult.ast);
  const symbols = parseResult.ast === null ? [] : adapter.extractSymbols(parseResult.ast);
  const result = chunkFile({
    identity,
    content,
    parseResult,
    regions,
    symbols,
    config: { preparedText, maxTokensPerChunk },
  });
  return { result, symbols };
}

describe("WP-110: gewoehnliche Markdown-Dateien im Chunker", () => {
  const visionPath = "vision.md";
  const vision = readFileSync(path.join(repoRoot, visionPath), "utf8");

  it("laeuft ueber die AST-Strategie, nicht ueber line_fallback", () => {
    const { result } = chunkMarkdown(visionPath, vision);
    expect(result.strategy).toBe("ast");
    // E4: keine Abstufung heisst auch KEIN Abstufungseintrag.
    expect(result.degradations).toEqual([]);
    expect(result.parseQuality).toBe("complete");
  });

  it("schneidet an Ueberschriften und traegt den Breadcrumb als Signatur", () => {
    const { result } = chunkMarkdown(visionPath, vision);
    const sections = result.drafts.filter((draft) => draft.chunkKind === "prose_section");
    expect(sections.length).toBeGreaterThan(30);

    // Jeder Abschnittschunk beginnt mit seiner eigenen Ueberschriftenzeile —
    // das ist der Unterschied zum Zeilenfenster, das mitten im Satz anfaengt.
    for (const draft of sections) {
      expect(draft.content.trimStart().startsWith("#"), draft.chunkId).toBe(true);
    }

    // Der Breadcrumb einer Unterueberschrift nennt ihren Vorfahren.
    const nested = result.drafts.find((draft) => draft.symbolFqn?.includes("The core thesis"));
    expect(nested?.symbolFqn).toContain("Untangle — Vision");
  });

  it("bindet jeden Abschnitt an ein Symbol (spec.md §8.5)", () => {
    const { result, symbols } = chunkMarkdown(visionPath, vision);
    expect(symbols.length).toBeGreaterThan(30);
    for (const symbol of symbols) {
      expect(symbol.kind).toBe("section");
    }
    for (const draft of result.drafts.filter((d) => d.chunkKind === "prose_section")) {
      expect(draft.symbolId, draft.chunkId).toBeDefined();
      expect(draft.symbolKind, draft.chunkId).toBe("section");
    }
    // Kein einziges willkuerliches Zeilenfenster ueber dem Prosainhalt.
    expect(result.drafts.some((draft) => draft.chunkKind === "fallback_lines")).toBe(false);
  });

  it("teilt einen zu grossen Abschnitt in symbol_fragments MIT symbolId", () => {
    // Winziges Budget erzwingt den Fragmentpfad ueber echtem Text.
    const { result } = chunkMarkdown(visionPath, vision, 64);
    const fragments = result.drafts.filter((draft) => draft.chunkKind === "symbol_fragment");
    expect(fragments.length).toBeGreaterThan(0);
    for (const fragment of fragments) {
      expect(fragment.symbolId, fragment.chunkId).toBeDefined();
    }
  });

  it("erfasst jedes Byte des Dokuments (spec.md §8.4)", () => {
    const { result } = chunkMarkdown(visionPath, vision);
    const total = Buffer.byteLength(vision, "utf8");
    const covered = result.coverage.reduce(
      (sum, entry) => sum + (entry.range.endByte - entry.range.startByte),
      0,
    );
    expect(covered).toBe(total);
  });
});
