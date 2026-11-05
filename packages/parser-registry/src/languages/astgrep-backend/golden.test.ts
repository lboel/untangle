/**
 * Golden-Tests der Sprachbreite (WP-86).
 *
 * JE SPRACHE EINE ECHTE BEISPIELDATEI unter `__golden__/`, geschrieben so,
 * dass sie die EIGENHEITEN der Sprache zeigt und nicht nur ihre Grammatik
 * beweist: Gos `select` und Typ-`switch`, Rusts `impl`/`match`/`?`, Javas
 * `switch` mit `default` und `finally`, Rubys Nachstellformen und `rescue`,
 * PHPs `trait` und `elseif`, Kotlins `when` und feldlose Grammatik, Cs
 * Zeigerdeklaratoren, C++-Vorlagen und -Namensraeume, Swifts `guard` und
 * `extension`, Bashs `case`-Auffangzweig.
 *
 * WAS HIER FESTGENAGELT WIRD und warum genau das:
 *
 *  1. `parseQuality === "complete"` und NULL Fehlerknoten. Eine Grammatik, die
 *     an gewoehnlichem Code der Sprache Fehlerknoten baut, taugt nicht — und
 *     das soll auffallen, bevor jemand ihre Zahlen benutzt.
 *  2. Die SYMBOLE nach qualifiziertem Namen und Art. Das ist die Zusage
 *     "Symbol-Extraktion" aus dem Auftrag.
 *  3. Die ZAHL je Entscheidungsart. Das ist die Zusage "Entscheidungspunkte",
 *     und es ist die Zahl, die in Zyklomatik, Hotspots, Ratsche und
 *     Risikobewertung einfliesst. Sie ist HIER nachgerechnet, nicht geraten:
 *     jede Erwartung unten laesst sich an der Beispieldatei nachzaehlen.
 *  4. Dass der AUFFANGZWEIG NICHT zaehlt — in allen sechs Sprachen, die einen
 *     haben. Genau dort lag der Defekt, den WP-86 in der Go-Tabelle gefunden
 *     hat (`default_case` zaehlte mit).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { DecisionKind, LanguageAdapter, SourceFile } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { createAstGrepAdapter } from "./adapter.js";
import { AST_GREP_LANGUAGES } from "./lang/index.js";
import { GO_SOURCE, GO_TABLE, RUST_SOURCE, RUST_TABLE } from "./languages.js";

interface GoldenCase {
  languageId: string;
  file: string;
  /** `qualifiedName:kind`, in Quelltextreihenfolge — vollstaendig. */
  symbols: readonly string[];
  /** Zahl je Entscheidungsart; fehlende Arten muessen NULL sein. */
  decisions: Readonly<Partial<Record<DecisionKind, number>>>;
  comments: number;
  imports: readonly string[];
  /** Aufrufe, die vorkommen MUESSEN (`qualifier.name` oder `name`). */
  calls: readonly string[];
}

/**
 * Alle Adapter werden VOR dem ersten Parse gebaut. Das ist keine
 * Bequemlichkeit: `registerDynamicLanguage` wirkt genau einmal, und ein
 * spaeter gebauter Adapter wuerde eine Sprache anmelden, die nie registriert
 * wird (`napi.ts` wirft dann — genau deshalb steht dieser Kommentar hier).
 */
const ADAPTERS = new Map<string, LanguageAdapter>(
  [
    createAstGrepAdapter(GO_TABLE, GO_SOURCE),
    createAstGrepAdapter(RUST_TABLE, RUST_SOURCE),
    ...AST_GREP_LANGUAGES.map((language) => createAstGrepAdapter(language.table, language.source)),
  ].map((adapter) => [adapter.languageId, adapter]),
);

function sourceFileOf(name: string, languageId: string): SourceFile {
  const content = readFileSync(
    fileURLToPath(new URL(`./__golden__/${name}`, import.meta.url)),
    "utf8",
  );
  return {
    fileId: `golden:${name}`,
    repoId: "golden",
    refId: "golden:main",
    path: name,
    languageId,
    content,
    contentHash: "golden",
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

function runGolden(golden: GoldenCase): void {
  const adapter = ADAPTERS.get(golden.languageId);
  expect(adapter, `kein Adapter fuer "${golden.languageId}"`).toBeDefined();
  const result = (adapter as LanguageAdapter).parse(sourceFileOf(golden.file, golden.languageId));

  expect(result.parseQuality).toBe("complete");
  expect(result.errorNodeCount).toBe(0);
  expect(result.missingNodeCount).toBe(0);
  expect(result.ast).not.toBeNull();
  const ast = result.ast as NonNullable<typeof result.ast>;
  const language = adapter as LanguageAdapter;

  expect(
    language.extractSymbols(ast).map((symbol) => `${symbol.qualifiedName}:${symbol.kind}`),
  ).toEqual([...golden.symbols]);

  const facts = language.computeComplexity(ast);
  const counted: Partial<Record<DecisionKind, number>> = {};
  for (const decision of facts.decisions) {
    counted[decision.kind] = (counted[decision.kind] ?? 0) + 1;
  }
  expect(counted).toEqual(golden.decisions);
  expect(facts.comments.length).toBe(golden.comments);

  expect(language.extractImports(ast).map((entry) => entry.specifier)).toEqual([...golden.imports]);

  const calls = language
    .extractCalls(ast)
    .map((call) =>
      call.qualifier === undefined ? call.calleeName : `${call.qualifier}.${call.calleeName}`,
    );
  for (const expected of golden.calls) {
    expect(calls, `Aufruf "${expected}" fehlt`).toContain(expected);
  }

  // Jede `symbolScopeId` einer Entscheidung und jedes Aufrufs muss auf einen
  // gemeldeten Scope zeigen. Das ist die Zusage des EINEN Walks: Symbole,
  // Metriken und Aufrufe koennen nicht auseinanderdriften.
  const scopeIds = new Set(facts.symbolScopes.map((scope) => scope.symbolScopeId));
  for (const decision of facts.decisions) expect(scopeIds.has(decision.symbolScopeId)).toBe(true);
  for (const call of language.extractCalls(ast)) {
    expect(scopeIds.has(call.callerScopeId)).toBe(true);
  }

  // Der Regionenvertrag (domain `analysis.ts`): GENAU EINE `module`-Wurzel
  // ueber die ganze Datei.
  const regions = language.extractChunks(ast);
  expect(regions.length).toBe(1);
  expect(regions[0]?.chunkKind).toBe("module");
  expect(regions[0]?.range.startByte).toBe(0);
}

const GOLDEN: readonly GoldenCase[] = [
  {
    languageId: "go",
    file: "go-basic.go",
    symbols: [
      "Job:class",
      "Runner:interface",
      // Interface-Signaturen haben keinen Rumpf, sind aber echte Methoden.
      "Runner.Run:method",
      "pool:class",
      "NewPool:function",
      "pool.Drain:method",
      "pool.runOne:method",
      "describe:function",
      "each:function",
    ],
    // 3 Schleifen (`for` ist Gos einzige), 5 Faelle (2x `select`, 1x
    // Ausdrucks-`switch`, 2x Typ-`switch`) — die BEIDEN `default`-Zweige
    // zaehlen NICHT. 3 Waechter (`if ... { return }` ohne `else`), 1 `if`,
    // `&&` zweimal, `||` einmal.
    decisions: { loop: 3, case: 5, guard: 3, if: 1, logical_and: 2, logical_or: 1 },
    comments: 6,
    imports: ["context", "errors", "fmt", "time"],
    calls: ["errors.New", "fmt.Errorf", "p.runner.Run", "ts.Sleep"],
  },
  {
    languageId: "rust",
    file: "rust-basic.rs",
    symbols: [
      "Record:class",
      "Slot:enum",
      "Store:interface",
      // `function_signature_item` hat keinen Rumpf und darf deshalb nicht aus
      // dem Symbolgraphen verschwinden (WP-242).
      "Store.get:method",
      "Store.put:method",
      "MemStore:class",
      // Ein `impl`-Block oeffnet einen Scope mit dem Namen seines Typs; drei
      // Bloecke ergeben drei Eintraege. Bekannte Ungenauigkeit von WP-220,
      // hier festgenagelt statt verschwiegen.
      "MemStore:class",
      "MemStore.new:function",
      "MemStore.check:function",
      "MemStore:class",
      "MemStore.get:function",
      "MemStore.put:function",
      "Record:class",
      "Record.fmt:function",
      "count_all:function",
      "Alias:type",
    ],
    // 3 `match`-Arme, KEIN Auffangarm in dieser Datei. `?` einmal, und zwar
    // als `short_circuit` (nur erweitert, nie klassisch).
    decisions: {
      if: 3,
      else_if: 1,
      short_circuit: 1,
      case: 3,
      loop: 2,
      logical_and: 1,
      logical_or: 1,
    },
    comments: 3,
    imports: ["std::collections::HashMap", "std::fmt"],
    calls: ["self.items.insert", "self.check"],
  },
  {
    languageId: "java",
    file: "java-basic.java",
    symbols: [
      "Ledger:class",
      "Ledger.balances:property",
      "Ledger.MAX:property",
      "Ledger.Ledger:constructor",
      "Ledger.apply:method",
      "Ledger.Visitor:interface",
      "Ledger.Visitor.visit:method",
      "Ledger.Kind:enum",
      "Ledger.Entry:class",
      "Ledger.close:method",
    ],
    // 3 Faelle (`case "a"`, `case "b"`, `case "c"`) — `default` zaehlt nicht.
    // 1 `catch`; das `finally` zaehlt nicht, weil es immer laeuft.
    decisions: {
      if: 1,
      else_if: 1,
      loop: 2,
      case: 3,
      catch: 1,
      ternary: 1,
      logical_and: 1,
      logical_or: 1,
    },
    comments: 2,
    imports: ["java.util.List", "java.util.Map", "java.util.Collections.emptyList"],
    calls: ["account.isEmpty", "balances.getOrDefault", "IllegalStateException"],
  },
  {
    languageId: "csharp",
    file: "csharp-basic.cs",
    symbols: [
      "Example.Caching:namespace",
      "Example.Caching.ICache:interface",
      "Example.Caching.ICache.Get:method",
      "Example.Caching.Mode:enum",
      "Example.Caching.Slot:class",
      "Example.Caching.Slot.Size:property",
      "Example.Caching.Cache:class",
      "Example.Caching.Cache._items:property",
      "Example.Caching.Cache.Max:property",
      "Example.Caching.Cache.Cache:constructor",
      "Example.Caching.Cache.Name:property",
      "Example.Caching.Cache.Get:method",
      "Example.Caching.Cache.Dispose:method",
    ],
    // 2 Faelle (`case "a"`, `case "b"`) — `default:` zaehlt nicht, obwohl es
    // in C# DIESELBE Knotenart `switch_section` ist.
    decisions: {
      if: 1,
      else_if: 1,
      guard: 1,
      loop: 3,
      case: 2,
      catch: 1,
      ternary: 1,
      logical_or: 1,
    },
    comments: 2,
    imports: ["System", "System.Collections.Generic", "System.Text"],
    calls: ["_items.Clear", "Console.WriteLine"],
  },
  {
    languageId: "ruby",
    file: "ruby-basic.rb",
    symbols: [
      "Reporting:namespace",
      "Reporting.Report:class",
      "Reporting.Report.initialize:constructor",
      "Reporting.Report.render:method",
      "Reporting.Report.header:method",
      "Reporting.Report.body:method",
      "Reporting.Report.build:method",
      "Reporting.quick:method",
    ],
    // 4x `if`, davon DREI in der Nachstellform (`raise ... if ...`,
    // `next if ...`, `row.to_s if ...`) — sie zaehlen wie die Langform.
    // 2 `when`; der `else`-Zweig eines `case` zaehlt nicht. 1 `rescue`.
    decisions: { if: 4, else_if: 1, case: 2, catch: 1, logical_and: 1, logical_or: 1 },
    comments: 3,
    // Ruby hat keine Importanweisung — `require` ist ein Aufruf (siehe unten).
    imports: [],
    calls: ["require", "require_relative", "@rows.each_with_index"],
  },
  {
    languageId: "php",
    file: "php-basic.php",
    symbols: [
      "App\\Billing:namespace",
      "Payable:interface",
      "Payable.total:method",
      "HasLines:interface",
      "HasLines.lineCount:method",
      "Invoice:class",
      "Invoice.$lines:property",
      "Invoice.__construct:constructor",
      "Invoice.total:method",
      "makeInvoice:function",
    ],
    decisions: {
      if: 2,
      else_if: 1,
      loop: 3,
      case: 1,
      catch: 1,
      ternary: 1,
      logical_and: 1,
      logical_or: 1,
    },
    comments: 2,
    imports: ["App\\Money", "App\\Contracts\\Payable"],
    calls: ["count", "empty"],
  },
  {
    languageId: "kotlin",
    file: "kotlin-basic.kt",
    symbols: [
      "LIMIT:property",
      "Entry:class",
      "Store:interface",
      "Store.get:function",
      "Mode:enum",
      "Registry:namespace",
      "Registry.all:property",
      "MemStore:class",
      "MemStore.name:property",
      "MemStore.get:function",
      "MemStore.sizes:function",
      // Mitglieder eines `companion object` erscheinen flach an der Klasse:
      // `companion_object` ist keine eigene Scope-Art in der Tabelle.
      "MemStore.empty:function",
      "biggest:function",
    ],
    // Drei eigenstaendige `if` plus EIN `else if`. Kotlin haengt den zweiten
    // Zweig in einen `control_structure_body`; dessen vorangehendes anonymes
    // `else`-Geschwister macht die Fortsetzung strukturell erkennbar (WP-243).
    // 2 `when`-Zweige; `else ->` zaehlt nicht.
    decisions: {
      if: 3,
      else_if: 1,
      loop: 2,
      case: 2,
      catch: 1,
      logical_and: 1,
      logical_or: 1,
    },
    comments: 2,
    imports: ["kotlin.math.max", "java.util.concurrent.ConcurrentHashMap"],
    calls: ["key.isEmpty", "items.clear", "max"],
  },
  {
    languageId: "c",
    file: "c-basic.c",
    symbols: [
      "ring_t:type",
      "ring_t.ring:class",
      "ring_t.ring.data:property",
      "ring_t.ring.head:property",
      "ring_t.ring.len:property",
      "ring_state:enum",
      "clamp:function",
      // `ring_t *ring_new(...)` — der Name kommt aus der Deklaratorenkette,
      // sonst hiesse die Funktion `*ring_new(size_t cap)`.
      "ring_new:function",
      "ring_push:function",
      "ring_free:function",
    ],
    // 2 Faelle (`case '\\n'`, `case '\\0'`) — `default:` ist dieselbe
    // Knotenart `case_statement` und zaehlt nicht.
    decisions: { if: 2, else_if: 1, guard: 2, loop: 3, case: 2, ternary: 1, logical_or: 2 },
    comments: 2,
    // Die spitzen Klammern bleiben stehen: sie unterscheiden Systemeinbindung
    // von Projekteinbindung (siehe `lang/c.ts`).
    imports: ["<stdlib.h>", "<string.h>", "ring.h"],
    calls: ["malloc", "clamp", "free"],
  },
  {
    languageId: "cpp",
    file: "cpp-basic.cpp",
    symbols: [
      "linalg:namespace",
      "linalg.Shape:class",
      "linalg.Shape.rows:property",
      "linalg.Shape.cols:property",
      "linalg.Order:enum",
      "linalg.Matrix:class",
      // Bekannte Ungenauigkeit: der Konstruktor `Matrix(int, int)` traegt
      // dieselbe Knotenart wie jede andere Methode und wird deshalb als
      // `function` gefuehrt, nicht als `constructor`.
      "linalg.Matrix.Matrix:function",
      "linalg.Matrix.at:function",
      "linalg.Matrix.fill:function",
      "linalg.Matrix.rows_:property",
      "linalg.Matrix.cols_:property",
      "linalg.Matrix.data_:property",
      "linalg.twice:function",
      "linalg.identity:function",
    ],
    decisions: { if: 2, else_if: 1, loop: 3, catch: 1, logical_and: 1, logical_or: 3 },
    comments: 3,
    imports: ["<vector>", "<stdexcept>", "matrix.hpp"],
    calls: ["data_.clear", "m.fill"],
  },
  {
    languageId: "swift",
    file: "swift-basic.swift",
    symbols: [
      "limit:property",
      "Record:class",
      "Record.id:property",
      "Record.size:property",
      "Store:interface",
      "Store.get:function",
      "Mode:enum",
      "MemStore:class",
      "MemStore.items:property",
      "MemStore.init:constructor",
      "MemStore.get:function",
      "MemStore.load:function",
      // `extension MemStore { ... }` -> `namespace`: kein neuer Typ, ein
      // benannter Ort fuer weitere Mitglieder.
      "MemStore:namespace",
      "MemStore.count:property",
      "biggest:function",
    ],
    // 1 `guard` (Swifts eigenes Schluesselwort fuer die vorzeitige Rueckkehr),
    // 2 `case` — `default:` zaehlt nicht.
    decisions: {
      guard: 1,
      if: 2,
      else_if: 1,
      loop: 2,
      case: 2,
      catch: 1,
      ternary: 1,
      logical_and: 1,
      logical_or: 1,
    },
    comments: 2,
    imports: ["Foundation", "os.log"],
    // `items["a"]` ist ein INDEXZUGRIFF und kein Aufruf — ohne den Filter in
    // `lang/swift.ts` stuende hier `items`.
    calls: ["items.removeAll", "load"],
  },
  {
    languageId: "shell",
    file: "bash-basic.sh",
    symbols: ["log_info:function", "retry:function", "deploy:function"],
    // 3 Schleifen (`while`, `for`, `until` — `until` ist dieselbe Knotenart
    // wie `while`), 2 Faelle: der Auffangzweig `*)` zaehlt nicht.
    decisions: { loop: 3, if: 2, else_if: 1, case: 2, logical_and: 1, logical_or: 1 },
    comments: 2,
    // Die Shell hat keine Importanweisung; `source` ist ein Kommando.
    imports: [],
    calls: ["source", "log_info", "printf"],
  },
];

describe("Sprachbreite ueber ast-grep (WP-86) — Golden-Dateien", () => {
  for (const golden of GOLDEN) {
    it(`${golden.languageId}: ${golden.file}`, () => {
      runGolden(golden);
    });
  }

  it("deckt jede angemeldete ast-grep-Sprache mit genau einer Golden-Datei ab", () => {
    const covered = new Set(GOLDEN.map((golden) => golden.languageId));
    const registered = [...ADAPTERS.keys()];
    // Eine Sprache OHNE Golden-Datei ist nur behauptet. Dieser Test ist die
    // Schranke dagegen: wer eine Tabelle hinzufuegt, muss eine Beispieldatei
    // dazulegen, sonst schlaegt hier fehl.
    expect(registered.filter((languageId) => !covered.has(languageId))).toEqual([]);
    expect(registered.length).toBe(GOLDEN.length);
  });
});

describe("Sprachbreite ueber ast-grep (WP-86) — der Auffangzweig zaehlt nie", () => {
  /**
   * Der Auffangzweig eines `switch`/`match`/`case` eroeffnet keinen
   * zusaetzlichen unabhaengigen Pfad — ein `switch` mit N Faellen und einem
   * `default` hat N Entscheidungen, nicht N+1. Diese Pruefung steht getrennt,
   * weil genau dieser Punkt in der Go-Tabelle falsch war (`default_case`
   * zaehlte mit) und in vier weiteren Sprachen dieselbe Falle stellt: Java,
   * C, C# und Bash fuehren Fall und Auffangzweig unter DERSELBEN Knotenart.
   */
  const CASES: readonly { languageId: string; withDefault: string; withoutDefault: string }[] = [
    {
      languageId: "go",
      withDefault:
        "package p\nfunc f(v int) int {\n\tswitch v {\n\tcase 1:\n\t\treturn 1\n\tdefault:\n\t\treturn 0\n\t}\n}\n",
      withoutDefault:
        "package p\nfunc f(v int) int {\n\tswitch v {\n\tcase 1:\n\t\treturn 1\n\tcase 2:\n\t\treturn 2\n\t}\n\treturn 0\n}\n",
    },
    {
      languageId: "java",
      withDefault:
        "class A { int f(int v) { switch (v) { case 1: return 1; default: return 0; } } }\n",
      withoutDefault:
        "class A { int f(int v) { switch (v) { case 1: return 1; case 2: return 2; } return 0; } }\n",
    },
    {
      languageId: "csharp",
      withDefault:
        "class A { int F(int v) { switch (v) { case 1: return 1; default: return 0; } } }\n",
      withoutDefault:
        "class A { int F(int v) { switch (v) { case 1: return 1; case 2: return 2; } return 0; } }\n",
    },
    {
      languageId: "c",
      withDefault: "int f(int v) { switch (v) { case 1: return 1; default: return 0; } }\n",
      withoutDefault:
        "int f(int v) { switch (v) { case 1: return 1; case 2: return 2; } return 0; }\n",
    },
    {
      languageId: "rust",
      withDefault: "fn f(v: u8) -> u8 { match v { 1 => 1, _ => 0 } }\n",
      withoutDefault: "fn f(v: u8) -> u8 { match v { 1 => 1, 2 => 0 } }\n",
    },
    {
      languageId: "kotlin",
      withDefault: "fun f(v: Int): Int { return when (v) { 1 -> 1 else -> 0 } }\n",
      withoutDefault: "fun f(v: Int): Int { return when (v) { 1 -> 1 2 -> 0 } }\n",
    },
    {
      languageId: "swift",
      withDefault: "func f(_ v: Int) -> Int { switch v { case 1: return 1 default: return 0 } }\n",
      withoutDefault:
        "func f(_ v: Int) -> Int { switch v { case 1: return 1 case 2: return 0 } }\n",
    },
    {
      languageId: "shell",
      withDefault: 'f() {\ncase "$1" in\n  a) echo a ;;\n  *) echo z ;;\nesac\n}\n',
      withoutDefault: 'f() {\ncase "$1" in\n  a) echo a ;;\n  b) echo z ;;\nesac\n}\n',
    },
  ];

  function caseCountOf(languageId: string, content: string): number {
    const adapter = ADAPTERS.get(languageId) as LanguageAdapter;
    const parsed = adapter.parse({
      fileId: `default-probe:${languageId}`,
      repoId: "golden",
      refId: "golden:main",
      path: `probe.${languageId}`,
      languageId,
      content,
      contentHash: "probe",
      sizeBytes: Buffer.byteLength(content, "utf8"),
    });
    expect(parsed.ast, `${languageId} liess sich nicht parsen`).not.toBeNull();
    return adapter
      .computeComplexity(parsed.ast as NonNullable<typeof parsed.ast>)
      .decisions.filter((decision) => decision.kind === "case").length;
  }

  for (const probe of CASES) {
    it(`${probe.languageId}: ein Auffangzweig zaehlt nicht als Fall`, () => {
      expect(caseCountOf(probe.languageId, probe.withDefault)).toBe(1);
      expect(caseCountOf(probe.languageId, probe.withoutDefault)).toBe(2);
    });
  }
});

describe("WP-243 — Kotlin-else-if hat dieselbe kognitive Form wie Java", () => {
  function controlShapeOf(languageId: "java" | "kotlin", content: string) {
    const adapter = ADAPTERS.get(languageId) as LanguageAdapter;
    const parsed = adapter.parse({
      fileId: `else-if-probe:${languageId}`,
      repoId: "golden",
      refId: "golden:main",
      path: languageId === "java" ? "Probe.java" : "probe.kt",
      languageId,
      content,
      contentHash: "else-if-probe",
      sizeBytes: Buffer.byteLength(content, "utf8"),
    });
    expect(parsed.parseQuality).toBe("complete");
    const facts = adapter.computeComplexity(parsed.ast as NonNullable<typeof parsed.ast>);
    return {
      decisions: facts.decisions.map((decision) => decision.kind),
      nesting: facts.nestingEvents
        .filter((event) => event.construct === "if")
        .map((event) => ({ construct: event.construct, continuation: event.continuation })),
    };
  }

  it.each([
    ["Zeilenkommentar", ["  // Erklaerung"]],
    ["Blockkommentar", ["  /* Erklaerung */"]],
    ["Zeilen- plus Blockkommentar", ["  // Erklaerung", "  /* mehr */"]],
    ["Block- plus Zeilenkommentar", ["  /* Erklaerung */", "  // mehr"]],
  ])("markiert den zweiten Zweig mit %s wie Java als Fortsetzung", (_label, comments) => {
    const java = controlShapeOf(
      "java",
      [
        "class C { int f(boolean a, boolean b) {",
        "  if (a) return 1; else",
        ...comments,
        "  if (b) return 2; else return 3;",
        "} }",
        "",
      ].join("\n"),
    );
    const kotlin = controlShapeOf(
      "kotlin",
      [
        "fun f(a: Boolean, b: Boolean): Int { return if (a) 1 else",
        ...comments,
        "  if (b) 2 else 3",
        "}",
        "",
      ].join("\n"),
    );

    expect(kotlin).toEqual(java);
    expect(kotlin).toEqual({
      decisions: ["if", "else_if"],
      nesting: [
        { construct: "if", continuation: false },
        { construct: "if", continuation: true },
      ],
    });
  });

  it("verwechselt ein `if` im ungekammerten Dann-Rumpf nicht mit `else if`", () => {
    const kotlin = controlShapeOf(
      "kotlin",
      [
        "fun nested(a: Boolean, b: Boolean) { if (a)",
        "  /* erklaert den echten Dann-Rumpf */",
        "  if (b) println(b)",
        "}",
        "",
      ].join("\n"),
    );

    expect(kotlin.decisions).toEqual(["if", "if"]);
    expect(kotlin.nesting.every((event) => event.continuation === false)).toBe(true);
  });

  it("verbindet zwei eigenstaendige `if` trotz Blockkommentar nicht", () => {
    const kotlin = controlShapeOf(
      "kotlin",
      [
        "fun independent(a: Boolean, b: Boolean) {",
        "  if (a) println(a)",
        "  /* trennt zwei echte Anweisungen */",
        "  if (b) println(b)",
        "}",
        "",
      ].join("\n"),
    );

    expect(kotlin.decisions).toEqual(["if", "if"]);
    expect(kotlin.nesting.every((event) => event.continuation === false)).toBe(true);
  });
});

describe("Sprachbreite ueber ast-grep (WP-86) — Rusts `?` ist Kontrollfluss", () => {
  it("zaehlt `?` erweitert, aber nicht klassisch", () => {
    const adapter = ADAPTERS.get("rust") as LanguageAdapter;
    const content = "fn f(a: Option<u8>) -> Option<u8> { let b = a?; Some(b) }\n";
    const parsed = adapter.parse({
      fileId: "try-probe",
      repoId: "golden",
      refId: "golden:main",
      path: "probe.rs",
      languageId: "rust",
      content,
      contentHash: "probe",
      sizeBytes: Buffer.byteLength(content, "utf8"),
    });
    const facts = adapter.computeComplexity(parsed.ast as NonNullable<typeof parsed.ast>);
    const shortCircuits = facts.decisions.filter((decision) => decision.kind === "short_circuit");
    expect(shortCircuits.length).toBe(1);
    // Genau das ist die konservative Auslegung: `?` ist in idiomatischem Rust
    // so haeufig wie ein Semikolon. Klassisch mitgezaehlt bekaeme jede
    // Funktion, die drei Aufrufe weiterreicht, dieselbe Zahl wie eine mit drei
    // `if` — eine falsche Zahl in Hotspots und Risikobewertung.
    expect(shortCircuits[0]?.countsForClassic).toBe(false);
    expect(shortCircuits[0]?.countsForExtended).toBe(true);
  });
});
