/**
 * E4-Ehrlichkeitspruefung der Sprachadapter (WP-165).
 *
 * Der Pruefling ist der komplette Adapterlauf -- `parse`, `extractChunks`,
 * `extractSymbols` -- und zwar auf EINER geteilten Adapterinstanz je Sprache,
 * damit die Nebenlaeufigkeitsbeschaedigung echten geteilten Zustand treffen
 * kann (Grammatik-Cache, Offset-Tabellen). Eine frische Instanz je Lauf wuerde
 * genau den Defekt unsichtbar machen, den diese Beschaedigung sucht.
 *
 * Die gesuchte Unehrlichkeit ist die aus dem Auftragstext: ein Parser, der
 * `"complete"` meldet, nachdem er einen Teilbaum verworfen hat. Die Projektion
 * misst deshalb NICHT die Anzahl der Symbole -- die darf bei kuerzerem Eingang
 * sinken, das ist ehrlich -- sondern:
 *
 *   1. ob der gelieferte Regionenbaum den Eingang noch vollstaendig ueberspannt,
 *   2. ob alle gemeldeten Bereiche ueberhaupt im Eingang liegen,
 *   3. ob die vom Adaptervertrag geforderte einzelne `"module"`-Wurzel steht.
 *
 * Beide Adapter laufen gegen dieselbe Pruefung: der TypeScript-Adapter ueber
 * tree-sitter, der Python-Adapter ueber den handgeschriebenen Tokenizer/Parser
 * dieses Pakets -- der zweite ist der interessantere Kandidat, weil er keine
 * fremde, fehlertolerante Grammatik unter sich hat.
 */
import { sha256Hex } from "@untangle-code/domain";
import type {
  AstRegion,
  LanguageAdapter,
  ParseResult,
  SourceFile,
  SourceRange,
} from "@untangle-code/domain";
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

import { createGoAdapter } from "./languages/astgrep-backend/index.js";
import { createPythonAdapter } from "./languages/python/index.js";
import { createTypeScriptAdapter } from "./languages/typescript/index.js";

const TS_FIXTURE = `/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

export class Widget {
  private label: string;

  constructor(label: string) {
    this.label = label;
  }

  render(prefix: string): string {
    return prefix.length === 0 ? this.label : \`\${prefix}:\${this.label}\`;
  }
}
`;

const TS_DECOY = `export interface Other {\n  readonly value: number;\n}\n`;

const PY_FIXTURE = `"""Module docstring."""


def add(a, b):
    return a + b


class Widget:
    def __init__(self, label):
        self.label = label

    def render(self, prefix):
        if not prefix:
            return self.label
        return f"{prefix}:{self.label}"
`;

const PY_DECOY = `def other(value):\n    return value + 1\n`;

const GO_FIXTURE = `package main

import "fmt"

// Widget renders things.
type Widget struct {
	Label string
}

// Render returns the rendered label.
func (w *Widget) Render(prefix string) string {
	if prefix == "" {
		return w.Label
	}
	return fmt.Sprintf("%s:%s", prefix, w.Label)
}

func add(a int, b int) int {
	return a + b
}
`;

const GO_DECOY = `package main\n\nfunc other(value int) int {\n\treturn value + 1\n}\n`;

interface ParserProbeInput {
  readonly content: string;
  readonly path: string;
  /** Verfaelscht die Groessenangaben, ohne den Inhalt anzutasten. */
  readonly lieAboutSize: boolean;
}

interface ParserProbeOutput {
  readonly parseResult: ParseResult;
  readonly regions: readonly AstRegion[];
  readonly symbolRanges: readonly SourceRange[];
}

function sourceOf(input: ParserProbeInput, languageId: string): SourceFile {
  return {
    fileId: "file-honesty",
    repoId: "repo-honesty",
    refId: "repo-honesty:main",
    path: input.path,
    languageId,
    content: input.content,
    contentHash: input.lieAboutSize ? sha256Hex("") : sha256Hex(input.content),
    sizeBytes: input.lieAboutSize ? 0 : Buffer.byteLength(input.content, "utf8"),
  };
}

function runAdapter(adapter: LanguageAdapter, input: ParserProbeInput): ParserProbeOutput {
  const parseResult = adapter.parse(sourceOf(input, adapter.languageId));
  if (parseResult.ast === null) {
    return { parseResult, regions: [], symbolRanges: [] };
  }
  return {
    parseResult,
    regions: adapter.extractChunks(parseResult.ast),
    symbolRanges: adapter.extractSymbols(parseResult.ast).map((symbol) => symbol.range),
  };
}

function parserFindings(result: ParserProbeOutput): readonly VisibleFinding[] {
  const findings: VisibleFinding[] = [...findingsFromDiagnostics(result.parseResult.diagnostics)];
  if (result.parseResult.parseQuality !== "complete") {
    findings.push(
      makeFinding("quality_downgrade", `parseQuality=${result.parseResult.parseQuality}`),
    );
  }
  return findings;
}

/** Bytes des Eingangs, die der Regionenbaum ueberspannt (vereinigt). */
function spannedBytes(regions: readonly AstRegion[], totalBytes: number): number {
  const spans = regions
    .map((region): [number, number] => [
      Math.max(0, region.range.startByte),
      Math.min(totalBytes, region.range.endByte),
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

function outOfBoundsCount(ranges: readonly SourceRange[], totalBytes: number): number {
  return ranges.filter(
    (range) => range.startByte < 0 || range.endByte > totalBytes || range.endByte < range.startByte,
  ).length;
}

const lens: TextLens<ParserProbeInput> = {
  read: (input) => input.content,
  write: (input, content) => ({ ...input, content }),
};

/**
 * Treibt die REKURSIONSTIEFE ueber jedes Limit, nicht nur die Dateigroesse.
 * Ein rekursiv absteigender Parser (der Python-Adapter ist einer) kann daran
 * scheitern -- er darf dabei laut werden, aber nicht still einen Teilbaum
 * verlieren.
 */
function deepNestingDamage(
  build: (depth: number) => string,
  depth: number,
): DamageCase<ParserProbeInput, ParserProbeOutput> {
  return {
    mode: "input",
    id: "deep_nesting",
    kind: "exceed_limit",
    detail: `nest ${String(depth)} levels deep to blow past any recursion or nesting budget`,
    damage: (input) => ({ ...input, content: build(depth) }),
  };
}

function damagesFor(
  decoy: ParserProbeInput,
  nesting: DamageCase<ParserProbeInput, ParserProbeOutput>,
): readonly DamageCase<ParserProbeInput, ParserProbeOutput>[] {
  return [
    ...standardTextDamages(lens, { repeat: 20 }),
    removeRequiredFieldDamage<ParserProbeInput>({
      id: "lie_about_size",
      detail:
        "set sizeBytes to 0 and contentHash to the hash of the empty string while the content stays intact",
      remove: (input) => ({ ...input, lieAboutSize: true }),
    }),
    nesting,
    concurrencyDamage<ParserProbeInput, ParserProbeOutput>({ decoy, copies: 6 }),
  ];
}

const ABORT_WAIVER = {
  kind: "abort_signal",
  reason:
    "LanguageAdapter.parse/extractChunks/extractSymbols are synchronous and take no AbortSignal -- the signature is fixed in domain analysis.ts, so this cannot be probed from here. A real gap against spec.md §22, recorded in README.md 'Bekannte Grenzen (E4)' instead of being faked.",
} as const;

function buildTsNesting(depth: number): string {
  const open = Array.from({ length: depth }, (_, index) => `  if (x === ${String(index)}) {`).join(
    "\n",
  );
  const close = Array.from({ length: depth }, () => "  }").join("\n");
  return `export function deep(x: number): number {\n${open}\n  return x;\n${close}\n  return -1;\n}\n`;
}

function buildGoNesting(depth: number): string {
  const open = Array.from({ length: depth }, (_, index) => `\tif x == ${String(index)} {`).join(
    "\n",
  );
  const close = Array.from({ length: depth }, () => "\t}").join("\n");
  return `package main\n\nfunc deep(x int) int {\n${open}\n\treturn x\n${close}\n\treturn -1\n}\n`;
}

function buildPyNesting(depth: number): string {
  const lines = ["def deep(x):"];
  for (let index = 0; index < depth; index += 1) {
    lines.push(`${"    ".repeat(index + 1)}if x == ${String(index)}:`);
  }
  lines.push(`${"    ".repeat(depth + 1)}return x`);
  lines.push("    return -1");
  return `${lines.join("\n")}\n`;
}

describe.each([
  {
    label: "typescript (tree-sitter)",
    adapter: createTypeScriptAdapter(),
    fixture: TS_FIXTURE,
    path: "src/fixture.ts",
    decoy: { content: TS_DECOY, path: "src/other.ts", lieAboutSize: false },
    nesting: deepNestingDamage(buildTsNesting, 400),
  },
  {
    label: "python (hand-written tokenizer/parser)",
    adapter: createPythonAdapter(),
    fixture: PY_FIXTURE,
    path: "src/fixture.py",
    decoy: { content: PY_DECOY, path: "src/other.py", lieAboutSize: false },
    nesting: deepNestingDamage(buildPyNesting, 400),
  },
  {
    // WP-220: der dritte Weg — ast-grep. Er ist der interessanteste Kandidat
    // fuer diese Pruefung, weil sein Cursor NACHGEBAUT ist (ast-grep hat
    // keinen) und weil `missingNodeCount` dort auf einer Heuristik beruht.
    // Beides darf die Vollstaendigkeitsaussage nicht beschaedigen.
    label: "go (ast-grep)",
    adapter: createGoAdapter(),
    fixture: GO_FIXTURE,
    path: "src/fixture.go",
    decoy: { content: GO_DECOY, path: "src/other.go", lieAboutSize: false },
    nesting: deepNestingDamage(buildGoNesting, 400),
  },
])("language adapter honesty under damage (E4) -- $label", (probeCase) => {
  it("never claims a region tree it does not actually span", async () => {
    const report = await assertHonestUnderDamage<ParserProbeInput, ParserProbeOutput>({
      name: `${probeCase.adapter.languageId} adapter: parse + extractChunks + extractSymbols`,
      input: { content: probeCase.fixture, path: probeCase.path, lieAboutSize: false },
      run: (input) => runAdapter(probeCase.adapter, input),
      claim: (result, input) => {
        const totalBytes = Buffer.byteLength(input.content, "utf8");
        const spanned = Math.min(totalBytes, spannedBytes(result.regions, totalBytes));
        return {
          completeness: completenessClaimProjection(
            claimCompleteness({
              subject: input.path,
              evidence: {
                unit: "bytes",
                expected: totalBytes,
                accountedFor: spanned,
                omissions:
                  totalBytes - spanned > 0
                    ? [{ amount: totalBytes - spanned, reason: "spanned by no AST region at all" }]
                    : [],
              },
            }),
            input.path,
          ),
          // Ein Bereich ausserhalb des Eingangs ist eine Behauptung ueber
          // Inhalt, den es nicht gibt -- dieselbe Familie wie eine zu hohe
          // Aufloesungsrate.
          regionsOutOfBounds: outOfBoundsCount(
            result.regions.map((region) => region.range),
            totalBytes,
          ),
          symbolsOutOfBounds: outOfBoundsCount(result.symbolRanges, totalBytes),
          // Adaptervertrag (domain `analysis.ts`, `AstRegion`): GENAU eine
          // Wurzelregion der Art "module". Faellt sie weg, ist der ganze Baum
          // verworfen -- und das darf nicht stumm geschehen.
          hasSingleModuleRoot:
            result.regions.length === 1 && result.regions[0]?.chunkKind === "module",
        };
      },
      findings: parserFindings,
      damages: damagesFor(probeCase.decoy, probeCase.nesting),
      waivedDamageKinds: [ABORT_WAIVER],
    });
    expect(report.violations).toEqual([]);
  });
});
