/**
 * E4-Ehrlichkeitspruefung des Chunkers (WP-165).
 *
 * Der Pruefling ist die ECHTE Naht Parser -> Chunker: der TypeScript-Adapter
 * parst den (beschaedigten) Text, der Chunker zerlegt ihn. Damit trifft jede
 * Beschaedigung den Chunker so, wie sie ihn im Betrieb traefe -- ein von Hand
 * gebauter Regionenbaum wuerde die interessanten Pfade gar nicht erst
 * erreichen.
 *
 * Die Projektion (`claim`) ist bewusst relativ zum Eingang: "welcher Anteil
 * DIESES Textes ist als Chunk erfasst, und was wurde mit welchem Grund
 * ausgeschlossen". Sie bleibt gleich, wenn der Chunker dieselbe Datei nur
 * feiner schneidet (das ist kein Verlust), und aendert sich genau dann, wenn
 * Inhalt verschwindet oder ein Ausschlussgrund hinzukommt.
 */
import { sha256Hex } from "@untangle-code/domain";
import type { CoverageEntry, ParseDiagnostic, SourceFile } from "@untangle-code/domain";
import { createTypeScriptAdapter } from "@untangle-code/parser-registry";
import {
  assertHonestUnderDamage,
  claimCompleteness,
  completenessClaimProjection,
  concurrencyDamage,
  findingsFromDiagnostics,
  makeFinding,
  removeRequiredFieldDamage,
  standardTextDamages,
  type DamageCase,
  type TextLens,
  type VisibleFinding,
} from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { chunkFile } from "./chunker.js";
import type { ChunkFileIdentity, ChunkFileResult, ChunkerConfigInput } from "./types.js";

const identity: ChunkFileIdentity = {
  workspaceId: "ws-honesty",
  repoId: "repo-honesty",
  refId: "repo-honesty:main",
  fileId: "file-honesty",
  filePath: "src/fixture.ts",
  languageId: "typescript",
};

const preparedText: ChunkerConfigInput["preparedText"] = {
  documentPrefix: "search_document:",
  repoLabel: "untangle",
  refName: "main",
};

const FIXTURE = `/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

export class Widget {
  private label: string;

  constructor(label: string) {
    this.label = label;
  }

  /** Renders the widget. */
  render(prefix: string): string {
    if (prefix.length === 0) {
      return this.label;
    }
    return \`\${prefix}:\${this.label}\`;
  }
}

export const DEFAULT_WIDGET = new Widget("default");
`;

interface ChunkerProbeInput {
  readonly content: string;
  readonly maxTokensPerChunk: number;
  /** Simuliert einen Adapter, der seine Regionen verliert (Pflichtangabe weg). */
  readonly dropRegions: boolean;
}

/**
 * `chunkFile` liefert `parseQuality`, aber nicht die Diagnostics des Parsers.
 * Fuer die Befundliste braucht die Pruefung beides, deshalb reicht der
 * Pruefling sie mit durch.
 */
interface ChunkerProbeOutput {
  readonly chunking: ChunkFileResult;
  readonly diagnostics: readonly ParseDiagnostic[];
}

function runChunker(input: ChunkerProbeInput): ChunkerProbeOutput {
  const adapter = createTypeScriptAdapter();
  const source: SourceFile = {
    fileId: identity.fileId,
    repoId: identity.repoId,
    refId: identity.refId,
    path: identity.filePath,
    languageId: identity.languageId,
    content: input.content,
    contentHash: sha256Hex(input.content),
    sizeBytes: Buffer.byteLength(input.content, "utf8"),
  };
  const parseResult = adapter.parse(source);
  const regions =
    parseResult.ast === null || input.dropRegions ? [] : adapter.extractChunks(parseResult.ast);
  const symbols = parseResult.ast === null ? [] : adapter.extractSymbols(parseResult.ast);
  return {
    chunking: chunkFile({
      identity,
      content: input.content,
      parseResult,
      regions,
      symbols,
      config: { preparedText, maxTokensPerChunk: input.maxTokensPerChunk },
    }),
    diagnostics: parseResult.diagnostics,
  };
}

/** Bytes, die von "chunked"-Eintraegen abgedeckt sind (vereinigt, ohne Doppelzaehlung). */
function chunkedBytes(entries: readonly CoverageEntry[], totalBytes: number): number {
  const spans = entries
    .filter((entry) => entry.status === "chunked")
    .map((entry): [number, number] => [
      Math.max(0, entry.range.startByte),
      Math.min(totalBytes, entry.range.endByte),
    ])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let cursor = 0;
  for (const [start, end] of spans) {
    const from = Math.max(start, cursor);
    if (end > from) {
      covered += end - from;
      cursor = end;
    }
  }
  return covered;
}

function chunkerFindings(result: ChunkerProbeOutput): readonly VisibleFinding[] {
  const findings: VisibleFinding[] = [...findingsFromDiagnostics(result.diagnostics)];
  if (result.chunking.parseQuality !== "complete") {
    findings.push(makeFinding("quality_downgrade", `parseQuality=${result.chunking.parseQuality}`));
  }
  for (const degradation of result.chunking.degradations) {
    findings.push(
      makeFinding(
        "quality_downgrade",
        `chunker degraded to ${degradation.strategy}: ${degradation.reason} -- ${degradation.detail}`,
      ),
    );
  }
  for (const entry of result.chunking.coverage) {
    if (entry.status === "excluded") {
      findings.push(
        makeFinding(
          "skip_ledger",
          `chunk/range/${entry.exclusionReason ?? "(no reason)"} bytes ${String(
            entry.range.startByte,
          )}..${String(entry.range.endByte)}`,
        ),
      );
    }
  }
  return findings;
}

const lens: TextLens<ChunkerProbeInput> = {
  read: (input) => input.content,
  write: (input, content) => ({ ...input, content }),
};

function chunkerDamages(): readonly DamageCase<ChunkerProbeInput, ChunkerProbeOutput>[] {
  return [
    ...standardTextDamages(lens, { repeat: 40 }),
    removeRequiredFieldDamage<ChunkerProbeInput>({
      id: "drop_ast_regions",
      detail: "the language adapter returns no chunk regions although the parse succeeded",
      remove: (input) => ({ ...input, dropRegions: true }),
    }),
    {
      mode: "input",
      id: "shrink_token_budget",
      kind: "exceed_limit",
      detail: "shrink the per-chunk token budget to 1, so every region blows the budget",
      damage: (input) => ({ ...input, maxTokensPerChunk: 1 }),
    },
    concurrencyDamage<ChunkerProbeInput, ChunkerProbeOutput>({
      decoy: {
        content: "export const other = 1;\n",
        maxTokensPerChunk: 400,
        dropRegions: false,
      },
    }),
  ];
}

describe("chunker honesty under damage (E4)", () => {
  it("either reports what it lost or provably loses nothing", async () => {
    const report = await assertHonestUnderDamage<ChunkerProbeInput, ChunkerProbeOutput>({
      name: "parser-registry -> chunkFile",
      input: { content: FIXTURE, maxTokensPerChunk: 400, dropRegions: false },
      run: runChunker,
      claim: (result, input) => {
        const totalBytes = Buffer.byteLength(input.content, "utf8");
        const covered = chunkedBytes(result.chunking.coverage, totalBytes);
        const excluded = result.chunking.coverage
          .filter((entry) => entry.status === "excluded")
          .map((entry) => ({
            amount: Math.max(
              0,
              Math.min(totalBytes, entry.range.endByte) - Math.max(0, entry.range.startByte),
            ),
            reason: entry.exclusionReason ?? "(no reason given)",
          }))
          .filter((omission) => omission.amount > 0);
        const accountedFor = Math.min(totalBytes, covered);
        const excludedBytes = excluded.reduce((sum, omission) => sum + omission.amount, 0);
        const unexplained = totalBytes - accountedFor - excludedBytes;
        return completenessClaimProjection(
          claimCompleteness({
            subject: identity.filePath,
            evidence: {
              unit: "bytes",
              expected: totalBytes,
              accountedFor,
              omissions: [
                ...excluded,
                ...(unexplained > 0
                  ? [{ amount: unexplained, reason: "covered by no ledger entry at all" }]
                  : []),
                ...(unexplained < 0
                  ? [{ amount: -unexplained, reason: "ledger double-counts bytes" }]
                  : []),
              ],
            },
          }),
          identity.filePath,
        );
      },
      findings: chunkerFindings,
      damages: chunkerDamages(),
      waivedDamageKinds: [
        {
          kind: "abort_signal",
          reason:
            "chunkFile() is a synchronous pure function and accepts no AbortSignal -- see README.md 'Bekannte Grenzen (E4)'; this is a real gap against spec.md §22, waived here rather than faked",
        },
      ],
    });
    expect(report.violations).toEqual([]);
  });
});

describe("chunkFile degradation ledger (WP-165 regression)", () => {
  it("names the reason when a successful parse delivers no AST regions", () => {
    const result = runChunker({ content: FIXTURE, maxTokensPerChunk: 400, dropRegions: true });
    expect(result.chunking.strategy).toBe("line_fallback");
    expect(result.chunking.parseQuality).toBe("complete");
    // Vor WP-165 war genau diese Kombination stumm: lueckenlose Byte-Abdeckung,
    // `parseQuality: "complete"` -- und trotzdem keine einzige Symbolzuordnung.
    expect(result.chunking.degradations).toEqual([
      {
        reason: "ast_regions_missing",
        strategy: "line_fallback",
        detail:
          'the parse reported "complete" but the language adapter delivered no chunk regions, so the file was cut into line windows; no symbol association exists for this file although the parse claims success',
      },
    ]);
    expect(result.chunking.drafts.every((draft) => draft.symbolId === undefined)).toBe(true);
  });

  it("stays empty when the AST strategy actually ran", () => {
    const result = runChunker({ content: FIXTURE, maxTokensPerChunk: 400, dropRegions: false });
    expect(result.chunking.strategy).toBe("ast");
    expect(result.chunking.degradations).toEqual([]);
  });

  it("names the reason for a minified file too", () => {
    const minified = `${"const a=1;a+=2;".repeat(400)}\n`;
    const result = runChunker({ content: minified, maxTokensPerChunk: 400, dropRegions: false });
    expect(result.chunking.strategy).toBe("minified");
    expect(result.chunking.degradations.map((entry) => entry.reason)).toEqual(["minified_content"]);
  });
});
