#!/usr/bin/env node
/**
 * `pnpm complexity:report` — der Selbstanalyse-Lauf als reproduzierbares
 * Repo-Skript (WP-83; spec.md §16.10, vision.md §11.2).
 *
 * Laeuft wie `scripts/e2e-smoke.mjs` gegen die ECHTEN gebauten dists der
 * Pakete — `@untangle-code/scanner` fuer die Dateiauswahl,
 * `@untangle-code/parser-registry` fuer den Parser, `@untangle-code/complexity`
 * fuer Metriken und Aggregation. Keine Mocks, keine handgebauten Facts.
 *
 * Das Skript leistet vier Dinge:
 *
 * 1. INVARIANTENPRUEFUNG ueber JEDEN Scope, in zwei Stufen. Ein Verstoss ist
 *    ein Fehler: das Skript bricht mit Exit-Code 2 ab und nennt die Scopes.
 *    a) WERTSCHRANKE (`checkScopeTreeInvariants`): der Eigenanteil eines
 *       Scopes plus die Summe seiner direkten Kinder darf seinen Gesamtwert
 *       nicht ueberschreiten. Das ist eine EINSEITIGE Schranke — sie faengt
 *       einen zu KLEINEN Elternwert (fehlender Inhalt) und sagt bewusst
 *       NICHTS ueber einen zu grossen Elternwert aus. Sie ist deshalb KEINE
 *       Doppelzaehlungspruefung; der Report behauptet das auch nicht mehr.
 *       Cognitive wird ohne Sockel geprueft, Cyclomatic mit `perScopeBase: 1`
 *       (`computeCyclomatic` legt immer den `M = 1 + decision_points`-Sockel
 *       an).
 *    b) ZAEHLPRUEFUNG (`checkScopeCoverage`, je Lesart): jeder Scope muss in
 *       GENAU EINEN Summanden der Lesart eingehen — weder in zwei (dann
 *       zaehlte die Summe denselben Quelltext doppelt) noch in keinen (dann
 *       verlore sie Inhalt). Das ist die Zusicherung, die die Summen wirklich
 *       tragen; die Wertschranke allein taete es nicht.
 * 2. SUMMEN JE PAKET in den drei definierten Lesarten (siehe
 *    `packages/complexity/src/scope-aggregate.ts`). Eine Zahl ohne Lesart
 *    waere bedeutungslos, deshalb steht nie nur eine da.
 * 3. HOTSPOT-LISTE ueber die Funktions-Lesart: jede aeusserste
 *    Ausfuehrungseinheit genau einmal, verschachtelte Closures in ihr
 *    enthalten.
 * 4. SKIP-LEDGER nach E4: jede Datei, die nicht in die Zahlen eingeht,
 *    steht mit Grund und Detailtext darin — vom Scanner ausgeschlossen,
 *    ohne Sprachadapter, nicht parsbar ODER mit beschaedigtem Syntaxbaum
 *    (`parseQuality !== "complete"`, siehe Punkt 5). Am Ende rechnet das
 *    Skript nach, dass JEDE vom Scanner gelieferte Datei entweder in den
 *    Zahlen oder im Ledger steht, und bricht sonst ab: ein stilles
 *    Ueberspringen gaebe es sonst genau hier.
 * 5. PARSE-QUALITAET: eine Datei mit `parseQuality: "partial"` hat
 *    ERROR-/MISSING-Knoten im Syntaxbaum. Ihre Scope-Grenzen und
 *    Entscheidungspunkte sind dann nachweislich falsch — am eigenen Repo
 *    gemessen fehlten in EINER solchen Datei drei echte Methoden komplett,
 *    und ein Scope stand mit 54 statt 7 in der Hotspot-Liste. Solche Dateien
 *    gehen deshalb NICHT in die Zahlen ein, stehen im Ledger und werden in
 *    Abschnitt 0b einzeln mit Fehlerknoten und Schadensumfang ausgewiesen.
 *
 * Determinismus: keine Uhrzeit, kein Zufall, keine `localeCompare`-Sortierung
 * in der Ausgabe. Zwei Laeufe auf demselben Stand erzeugen byte-gleiche
 * Ausgabe, damit Staende vergleichbar bleiben (vision.md §11.2).
 *
 * Exit-Codes:
 *   0  Alle Invarianten halten.
 *   1  Betriebsfehler (kein Paket gebaut, Datei unlesbar, ...).
 *   2  Mindestens ein Invariantenverstoss — die Zahlen sind nicht belastbar.
 *
 * Optionen:
 *   --top=N        Laenge der Hotspot-Liste (Default 25).
 *   --json         Maschinenlesbare Ausgabe statt Tabellen.
 *   --root=PFAD    Zu analysierendes Verzeichnis (Default: dieses Repo).
 *   --baseline=N   Cognitive-Gesamtwert eines externen Vergleichslaufs. Wird in
 *                  Abschnitt 7 gegenuebergestellt (Verhaeltnis zur Funktions-
 *                  Lesart). Bewusst ein Parameter statt einer fest verdrahteten
 *                  Zahl: eine eingebackene Baseline veraltet still.
 *   --baseline-files=N
 *                  Dateizahl desselben Vergleichslaufs, damit sichtbar wird, ob
 *                  ueberhaupt derselbe Ausschnitt gemessen wurde.
 *   --selftest-violation
 *                  Haengt EINEN synthetischen, invariantenverletzenden Scope
 *                  an die echten Daten. Beweist, dass der Abbruchpfad wirklich
 *                  greift, statt es zu behaupten (E5). Muss mit Exit-Code 2
 *                  enden.
 *   --selftest-duplicate
 *                  Haengt eine WERTGLEICHE Wiederholung eines echten Scopes an.
 *                  Sie loest keinen Invariantenverstoss aus — die Aggregation
 *                  verwirft sie still und zaehlt sie nur in
 *                  `duplicatesDropped`. Beweist, dass der Abbruchpfad auf
 *                  genau diesen Zaehler wirklich greift (E5). Muss mit
 *                  Exit-Code 2 enden.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregate,
  aggregateScopeTree,
  buildSymbolIR,
  checkScopeCoverage,
  checkScopeTreeInvariants,
  computeCognitive,
  computeCyclomatic,
  containsRange,
  SCOPE_SUM_READINGS,
  selectScopeEntries,
  selectSymbolFacts,
  withUniqueScopeIds,
} from "@untangle-code/complexity";
import {
  COGNITIVE_ALGORITHM_ID,
  METRICS_VERSION,
  buildSkipLedgerEntry,
  classifyAdapterFailure,
  classifyTextFormat,
  compareCodepoints,
  sha256Hex,
  summarizeSkipReasons,
  validateSkipLedger,
} from "@untangle-code/domain";
import { createParserRegistry } from "@untangle-code/parser-registry";
import { discoverFiles } from "@untangle-code/scanner";
import { NodeFileSystem } from "@untangle-code/scanner/node-fs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Scope-Arten, die eine eigene Ausfuehrungseinheit sind. `SymbolScopeFact.kind`
 * ist ein adapterspezifischer String; diese Liste ist die Zuordnung, die die
 * Funktions-Lesart braucht (packages/complexity dokumentiert bewusst keine
 * Sprach-Taxonomie).
 */
const EXECUTION_UNIT_KINDS = new Set(["function", "method", "constructor", "lambda"]);

/**
 * Heuristische Trennung Produktions-/Testcode, NUR fuer die Gegenprobe gegen
 * einen externen Lauf ausgewiesen (docs/SONAR.md misst einen anderen
 * Dateiausschnitt). Sie geht in keine Kennzahl ein.
 */
function isTestPath(relativePath) {
  return (
    /(^|\/)[^/]*\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath) ||
    relativePath.includes("/test-support/") ||
    relativePath.includes("/testing/") ||
    relativePath.startsWith("fixtures/") ||
    relativePath.startsWith("benchmarks/")
  );
}

/** Paketzuordnung: "packages/<x>/..." -> "<x>", sonst der erste Pfadabschnitt. */
function packageOf(relativePath) {
  const segments = relativePath.split("/");
  if (segments[0] === "packages" && segments.length > 2) return `packages/${segments[1]}`;
  if (segments.length > 1) return segments[0];
  return "(root)";
}

function parseArgs(argv) {
  const options = {
    top: 25,
    json: false,
    root: REPO_ROOT,
    selftestViolation: false,
    selftestDuplicate: false,
    baseline: undefined,
    baselineFiles: undefined,
  };
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg === "--selftest-violation") options.selftestViolation = true;
    else if (arg === "--selftest-duplicate") options.selftestDuplicate = true;
    else if (arg.startsWith("--top=")) options.top = Number.parseInt(arg.slice(6), 10);
    else if (arg.startsWith("--baseline=")) options.baseline = Number.parseFloat(arg.slice(11));
    else if (arg.startsWith("--baseline-files="))
      options.baselineFiles = Number.parseInt(arg.slice(17), 10);
    else if (arg.startsWith("--root=")) options.root = path.resolve(arg.slice(7));
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.top) || options.top < 1) {
    throw new Error(`--top requires a positive integer; received "${options.top}"`);
  }
  if (options.baseline !== undefined && !Number.isFinite(options.baseline)) {
    throw new Error("--baseline requires a finite number");
  }
  if (options.baselineFiles !== undefined && !Number.isInteger(options.baselineFiles)) {
    throw new Error("--baseline-files requires an integer");
  }
  return options;
}

function renderTable(headers, rows) {
  const all = [headers, ...rows];
  const widths = headers.map((_, column) =>
    all.reduce((width, row) => Math.max(width, String(row[column] ?? "").length), 0),
  );
  const line = (row, pad) =>
    row
      .map((cell, column) => String(cell ?? "").padEnd(widths[column], pad))
      .join("  ")
      .trimEnd();
  return [
    line(headers, " "),
    line(
      widths.map((w) => "-".repeat(w)),
      "-",
    ),
    ...rows.map((r) => line(r, " ")),
  ].join("\n");
}

function num(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * Analysiert eine Datei und liefert je Scope einen `ScopeMetricNodeV1` fuer
 * cognitive und einen fuer cyclomatic-extended.
 *
 * `inclusiveValue` entsteht auf den ungefilterten Datei-Facts (der IR-Builder
 * zieht alle Nachfahren-Scopes hinein), `selfValue` auf
 * `selectSymbolFacts(...)` — denselben Calculator, nur anders zugeschnittene
 * Facts. Genau diese beiden Werte braucht die Invariantenpruefung.
 */
/**
 * Analysiert eine Datei und liefert je Scope einen `ScopeMetricNodeV1` fuer
 * cognitive und einen fuer cyclomatic-extended.
 *
 * Zuerst laeuft `withUniqueScopeIds()`: `SymbolScopeFact.symbolScopeId` aus
 * dem Sprachadapter ist innerhalb einer Datei NICHT eindeutig (siehe
 * Abschnitt 0 der Ausgabe und die Modul-Doku von
 * `packages/complexity/src/scope-identity.ts`). Ueber eine mehrdeutige Id zu
 * deduplizieren wuerde echte Scopes verschmelzen — genau der stille
 * Inhaltsverlust, den E4 verbietet.
 *
 * `inclusiveValue` entsteht dann auf den ungefilterten Datei-Facts (der
 * IR-Builder zieht alle Nachfahren-Scopes hinein), `selfValue` auf
 * `selectSymbolFacts(...)` — derselbe Calculator, nur anders zugeschnittene
 * Facts. Genau diese beiden Werte braucht die Invariantenpruefung.
 *
 * Fuer cyclomatic entsteht `inclusiveValue` aus den Facts des Scopes UND aller
 * Nachfahren (Byte-Containment), damit die Werte dieselbe Bedeutung haben wie
 * bei cognitive.
 */
function scopeNodesForFile(rawFacts, rawCalls, relativePath) {
  const repaired = withUniqueScopeIds(rawFacts, rawCalls, relativePath);
  const facts = repaired.facts;
  const calls = repaired.calls;

  const cognitive = [];
  const cyclomatic = [];
  const labels = new Map();

  for (const scope of facts.symbolScopes) {
    const id = scope.symbolScopeId;
    const inclusiveIr = buildSymbolIR(facts, id, { calls });
    const ownFacts = selectSymbolFacts(facts, id);
    const ownIr = buildSymbolIR(ownFacts, id, { calls });
    const subtreeFacts = {
      ...facts,
      decisions: facts.decisions.filter((d) => containsRange(scope.range, d.range)),
    };
    const shared = {
      metricsScopeId: id,
      executionUnit: EXECUTION_UNIT_KINDS.has(scope.kind),
      sloc: Math.max(1, scope.range.endLine - scope.range.startLine + 1),
      ...(scope.parentScopeId === undefined ? {} : { parentScopeId: scope.parentScopeId }),
    };
    cognitive.push({
      ...shared,
      inclusiveValue:
        inclusiveIr === undefined ? 0 : computeCognitive(inclusiveIr, COGNITIVE_ALGORITHM_ID).value,
      selfValue: ownIr === undefined ? 0 : computeCognitive(ownIr, COGNITIVE_ALGORITHM_ID).value,
    });
    cyclomatic.push({
      ...shared,
      inclusiveValue: computeCyclomatic(subtreeFacts, scope.range.startLine, METRICS_VERSION)
        .extended,
      selfValue: computeCyclomatic(ownFacts, scope.range.startLine, METRICS_VERSION).extended,
    });
    labels.set(id, {
      relativePath,
      name: scope.qualifiedName || scope.name || `(${scope.kind})`,
      kind: scope.kind,
      line: scope.range.startLine,
    });
  }
  return {
    cognitive,
    cyclomatic,
    labels,
    collisions: repaired.collisions,
    nodeKindsAttributedByFallback: repaired.nodeKindsAttributedByFallback,
  };
}

async function collect(options) {
  const registry = createParserRegistry();
  const fs = new NodeFileSystem();
  const skipEntries = [];
  const perFile = [];
  /**
   * Dateien, deren Syntaxbaum ERROR-/MISSING-Knoten traegt. Sie gehen NICHT
   * in die Zahlen ein (siehe Kopfkommentar, Punkt 5) und werden hier fuer
   * Abschnitt 0b mitgefuehrt, damit der Verlust nicht nur als eine Zeile im
   * Ledger auftaucht.
   */
  const degraded = [];
  /** Dateien der Stufe `text`; getrennt gefuehrt, weil getrennt gemessen (WP-217). */
  const proseFiles = [];

  const scannerSkips = [];
  const stream = discoverFiles({
    fs,
    roots: [options.root],
    repoRoot: options.root,
    onSkip: (skip) => scannerSkips.push(skip),
  });

  let discovered = 0;
  for await (const file of stream) {
    discovered++;
    // WP-110/WP-217: Stufe `text` hat keine Scopes. Sie mitzuzaehlen erzeugte
    // Dateien "mit 0 Ausfuehrungseinheiten", die wie gerechnet aussehen; sie
    // mit `unsupported_language` zu begruenden waere falsch, denn sie SIND
    // unterstuetzt. Beides vermeiden die folgenden Zweige.
    //
    // Der Erzeugt-Zweig steht VOR der Adapterfrage: eine `pnpm-lock.yaml` ist
    // gueltiges YAML, aber niemandes Text — der Grund gehoert an den Inhalt,
    // nicht an die Sprache.
    if (classifyTextFormat(file.relativePath) === "generated") {
      skipEntries.push(
        buildSkipLedgerEntry({
          stage: "parse",
          subjectKind: "file",
          path: file.relativePath,
          reason: "generated_content",
          detail:
            "Generated file (such as a lockfile); it contains no authored " +
            "statement to measure.",
          recoverable: false,
        }),
      );
      continue;
    }
    const adapter = registry.getAdapterForPath(file.relativePath);
    if (adapter === null) {
      skipEntries.push(
        buildSkipLedgerEntry({
          stage: "parse",
          subjectKind: "file",
          path: file.relativePath,
          reason: "unsupported_language",
          detail:
            `No language adapter is registered for languageId "${file.languageId}"; the file contributes ` +
            `to no complexity measurement.`,
          recoverable: false,
        }),
      );
      continue;
    }
    if (adapter.supportLevel === "text") {
      const prose = classifyTextFormat(file.relativePath) === "prose";
      proseFiles.push(file.relativePath);
      skipEntries.push(
        buildSkipLedgerEntry({
          stage: "parse",
          subjectKind: "file",
          path: file.relativePath,
          reason: "no_metric_defined",
          detail: prose
            ? `Prose (tier "text") has no control flow and therefore no cyclomatic/cognitive ` +
              `measurement. Prose metrics (structural and reference load) are computed by ` +
              `"untangle complexity --prose" and are not included in this report.`
            : `Structured configuration (tier "text") supports chunks and ` +
              `search but has no control flow or section structure; neither ` +
              `a code metric nor a prose metric is defined for it.`,
          recoverable: false,
        }),
      );
      continue;
    }
    let content;
    try {
      content = readFileSync(file.absolutePath, "utf8");
    } catch (error) {
      skipEntries.push(
        buildSkipLedgerEntry({
          stage: "scan",
          subjectKind: "file",
          path: file.relativePath,
          reason: "provider_unavailable",
          detail: `Cannot read file: ${error instanceof Error ? error.message : String(error)}`,
          recoverable: true,
        }),
      );
      continue;
    }
    const source = {
      fileId: file.relativePath,
      repoId: "untangle",
      refId: "untangle:working-tree",
      path: file.relativePath,
      languageId: file.languageId,
      content,
      contentHash: file.contentHash,
      sizeBytes: file.sizeBytes,
    };
    let parseResult;
    try {
      parseResult = adapter.parse(source);
    } catch (error) {
      // WP-216: benannter Grund statt durchgereichtem Ausnahmetext (E4).
      const failure = classifyAdapterFailure(error, { sizeBytes: file.sizeBytes });
      skipEntries.push(
        buildSkipLedgerEntry({
          stage: "parse",
          subjectKind: "file",
          path: file.relativePath,
          reason: failure.reason,
          detail: `Adapter "${file.languageId}": ${failure.detail}`,
          recoverable: failure.recoverable,
        }),
      );
      continue;
    }
    if (parseResult.ast === null) {
      skipEntries.push(
        buildSkipLedgerEntry({
          stage: "parse",
          subjectKind: "file",
          path: file.relativePath,
          reason: "parse_failed",
          detail: `parseQuality="${parseResult.parseQuality}" has no AST; no facts can be derived.`,
          recoverable: false,
        }),
      );
      continue;
    }
    if (parseResult.parseQuality !== "complete") {
      // Ein beschaedigter Syntaxbaum liefert nachweislich falsche Scopes:
      // fehlende Methoden, falsche Kinderzuordnung, aufgeblaehte Werte. Eine
      // solche Datei mitzurechnen faelscht jede Kennzahl und — schlimmer —
      // die Hotspot-Liste, nach der priorisiert wird. Sie geht deshalb in
      // keine Zahl ein und steht dafuer im Ledger UND in Abschnitt 0b.
      const damagedBytes = parseResult.diagnostics.reduce(
        (sum, diagnostic) => sum + (diagnostic.range.endByte - diagnostic.range.startByte),
        0,
      );
      const totalBytes = Buffer.byteLength(content, "utf8");
      degraded.push({
        relativePath: file.relativePath,
        languageId: file.languageId,
        parseQuality: parseResult.parseQuality,
        errorNodeCount: parseResult.errorNodeCount,
        missingNodeCount: parseResult.missingNodeCount,
        diagnosticCount: parseResult.diagnostics.length,
        damagedBytes,
        totalBytes,
      });
      skipEntries.push(
        buildSkipLedgerEntry({
          stage: "parse",
          subjectKind: "file",
          path: file.relativePath,
          reason: "parse_failed",
          detail:
            `parseQuality="${parseResult.parseQuality}": the syntax tree contains ` +
            `${String(parseResult.errorNodeCount)} error nodes and ` +
            `${String(parseResult.missingNodeCount)} missing nodes ` +
            `(${String(damagedBytes)} of ${String(totalBytes)} bytes fall below ` +
            `error nodes). Scope boundaries and decision points are therefore ` +
            `unreliable; the file contributes to no complexity measurement. This usually ` +
            `results from a language construct unsupported by the embedded grammar version, ` +
            `while the file itself is valid.`,
          recoverable: true,
        }),
      );
      continue;
    }
    const facts = adapter.computeComplexity(parseResult.ast);
    const calls = adapter.extractCalls(parseResult.ast);
    perFile.push({
      relativePath: file.relativePath,
      languageId: file.languageId,
      parseQuality: parseResult.parseQuality,
      contentHash: file.contentHash,
      lineCount: content.length === 0 ? 0 : content.split("\n").length,
      ...scopeNodesForFile(facts, calls, file.relativePath),
    });
  }

  for (const skip of scannerSkips) {
    skipEntries.push(
      buildSkipLedgerEntry({
        stage: "scan",
        subjectKind: "file",
        path: skip.relativePath,
        reason: scannerReason(skip.reason),
        detail:
          `Excluded by the scanner (${skip.reason})` +
          (skip.detail === undefined ? "." : `: ${skip.detail}`),
        recoverable: skip.reason === "unreadable",
      }),
    );
  }

  perFile.sort((a, b) => compareCodepoints(a.relativePath, b.relativePath));
  degraded.sort((a, b) => compareCodepoints(a.relativePath, b.relativePath));
  skipEntries.sort(
    (a, b) =>
      compareCodepoints(a.path ?? "", b.path ?? "") || compareCodepoints(a.reason, b.reason),
  );

  // E4-BUCHFUEHRUNG: jede vom Scanner GELIEFERTE Datei muss genau einmal
  // verbucht sein — entweder in den Zahlen oder mit Grund im Ledger. Ohne
  // diese Gegenrechnung koennte ein kuenftiger `continue` eine Datei
  // spurlos verschwinden lassen, und genau das ist die Fehlerklasse, gegen
  // die der Ledger antritt. `scannerSkips` zaehlen nicht mit: diese Dateien
  // hat der Stream nie geliefert.
  const streamLedgerEntries = skipEntries.length - scannerSkips.length;
  const accounted = perFile.length + streamLedgerEntries;
  const accounting = {
    discovered,
    analyzed: perFile.length,
    ledgered: streamLedgerEntries,
    unaccounted: discovered - accounted,
  };
  proseFiles.sort(compareCodepoints);
  return { discovered, perFile, degraded, proseFiles, skipEntries, accounting };
}

/** Bildet die Scanner-Ausschlussgruende auf die geschlossene SKIP_REASONS-Menge ab. */
function scannerReason(reason) {
  switch (reason) {
    case "binary":
      return "binary_content";
    case "size-limit":
      return "file_too_large";
    case "unreadable":
      return "provider_unavailable";
    case "security":
    case "symlink-cycle":
    case "symlink-escape":
      return "excluded_by_configuration";
    default:
      // config-exclude, untangleignore, gitignore, default-exclude
      return "excluded_by_configuration";
  }
}

function sumsFor(nodes, options) {
  return aggregateScopeTree(nodes, options);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  return collect(options).then((collected) => emit(collected, options));
}

function emit(collected, options) {
  const { perFile, degraded, skipEntries, accounting } = collected;

  // Identifiziert den analysierten Stand OHNE Uhrzeit und ohne git: SHA-256
  // ueber (Pfad, contentHash) aller einbezogenen Dateien. Zwei Laeufe mit
  // demselben Digest MUESSEN dieselben Zahlen liefern; ein abweichender Digest
  // erklaert abweichende Zahlen, ohne dass jemand raten muss.
  const treeDigest = sha256Hex(
    perFile.map((f) => `${f.relativePath}\u001F${f.contentHash}`).join("\n"),
  ).slice(0, 16);

  const collisionStats = {
    files: perFile.filter((f) => f.collisions.length > 0).length,
    ids: perFile.reduce((sum, f) => sum + f.collisions.length, 0),
    scopes: perFile.reduce(
      (sum, f) => sum + f.collisions.reduce((inner, c) => inner + c.scopeCount, 0),
      0,
    ),
    nodeKindFallbacks: perFile.reduce((sum, f) => sum + f.nodeKindsAttributedByFallback, 0),
    examples: perFile
      .filter((f) => f.collisions.length > 0)
      .slice(0, 3)
      .map((f) => {
        const first = f.collisions[0];
        return `${f.relativePath}: "${first.adapterScopeId.split("\u001F").slice(2).join("/")}" bezeichnet ${String(first.scopeCount)} Scopes (Zeilen ${first.startLines.join(", ")})`;
      }),
  };

  const allCognitive = perFile.flatMap((f) => f.cognitive);
  const allCyclomatic = perFile.flatMap((f) => f.cyclomatic);
  if (options.selftestViolation) {
    // Ein Elternscope mit dem Wert 1 und einem Kind mit dem Wert 9: die
    // Kerninvariante MUSS anschlagen und das Skript MUSS mit 2 abbrechen.
    allCognitive.push(
      { metricsScopeId: "selftest/parent", inclusiveValue: 1, selfValue: 1, executionUnit: false },
      {
        metricsScopeId: "selftest/child",
        parentScopeId: "selftest/parent",
        inclusiveValue: 9,
        selfValue: 9,
        executionUnit: true,
      },
    );
  }
  if (options.selftestDuplicate) {
    // Eine WERTGLEICHE Wiederholung des ersten echten Scopes. Genau der Fall,
    // den `resolveTree` nicht als Verstoss meldet (die Werte stimmen ja
    // ueberein) und den nur `duplicatesDropped` sichtbar macht.
    const first = allCognitive[0];
    if (first === undefined) throw new Error("--selftest-duplicate requires at least one scope");
    allCognitive.push({ ...first });
    const firstCyclomatic = allCyclomatic[0];
    if (firstCyclomatic !== undefined) allCyclomatic.push({ ...firstCyclomatic });
  }
  const labels = new Map();
  for (const file of perFile) for (const [id, label] of file.labels) labels.set(id, label);

  // -- 1. Invariantenpruefung (der harte Teil) -----------------------------
  // Stufe a: die einseitige Wertschranke. Stufe b: die Zaehlpruefung je
  // Lesart, die als einzige die Aussage "jeder Scope genau einmal" traegt.
  const cognitiveViolations = checkScopeTreeInvariants(allCognitive);
  const cyclomaticViolations = checkScopeTreeInvariants(allCyclomatic, { perScopeBase: 1 });
  const cognitiveCoverage = SCOPE_SUM_READINGS.flatMap((reading) =>
    checkScopeCoverage(allCognitive, reading),
  );
  const cyclomaticCoverage = SCOPE_SUM_READINGS.flatMap((reading) =>
    checkScopeCoverage(allCyclomatic, reading),
  );
  const violations = [
    ...cognitiveViolations.map((v) => ({ metric: "cognitive", ...v })),
    ...cognitiveCoverage.map((v) => ({ metric: "cognitive", ...v })),
    ...cyclomaticViolations.map((v) => ({ metric: "cyclomatic_extended", ...v })),
    ...cyclomaticCoverage.map((v) => ({ metric: "cyclomatic_extended", ...v })),
  ];

  const ledger = {
    schemaVersion: 1,
    generationId: "complexity-report",
    entries: skipEntries,
    countsByReason: summarizeSkipReasons(skipEntries),
  };
  const ledgerIssues = validateSkipLedger(ledger);

  if (accounting.unaccounted !== 0) {
    process.stdout.write(
      `ABORT (E4 accounting): the scanner supplied ${String(accounting.discovered)} files, ` +
        `accounted for: ${String(accounting.analyzed)} in measurements and ` +
        `${String(accounting.ledgered)} in the ledger; ${String(accounting.unaccounted)} file(s) ` +
        `disappeared without a trace. Silently skipping content is an error, not a note.
`,
    );
    return 2;
  }

  if (violations.length > 0) {
    process.stdout.write(renderViolations(violations, labels));
    if (violations.length > 50) {
      process.stdout.write(
        `   (${String(violations.length - 50)} additional violations are not displayed; the count on ` +
          `the abort line is complete.)
`,
      );
    }
    process.stdout.write(
      `
ABORT: ${violations.length} invariant violation(s). Totals would be unreliable ` +
        `and are therefore not reported.
`,
    );
    return 2;
  }

  // -- 2./3. Summen und Hotspots -------------------------------------------
  const cognitiveTotals = sumsFor(allCognitive, {});
  const cyclomaticTotals = sumsFor(allCyclomatic, { perScopeBase: 1 });

  // `aggregateScopeTree` dedupliziert nach `metricsScopeId` und meldet eine
  // Wiederholung nur dann als Verstoss, wenn sich die WERTE unterscheiden
  // (spec.md §16.10 verlangt die Dedupe fuer wiederholte
  // Retrieval-Fragmente). Hier gibt es keine Retrieval-Fragmente: die Ids
  // sind byte-range-repariert und MUESSEN je Datei eindeutig sein. Jede
  // verworfene Dublette ist deshalb ein ECHTER Scope, der ersatzlos aus der
  // Summe faellt — mit zufaellig gleichen Werten voellig unbemerkt. Genau
  // dieser Zaehler darf nicht auf dem Weg zur Ausgabe verlorengehen.
  const duplicatesDropped = {
    cognitive: cognitiveTotals.duplicatesDropped,
    cyclomatic: cyclomaticTotals.duplicatesDropped,
  };
  if (duplicatesDropped.cognitive > 0 || duplicatesDropped.cyclomatic > 0) {
    process.stdout.write(
      `ABORT: aggregation discarded ${String(duplicatesDropped.cognitive)} (cognitive) bzw. ` +
        `${String(duplicatesDropped.cyclomatic)} (cyclomatic_extended) scopes discarded as duplicates ` +
        `of the same metricsScopeId. This must not happen after ID repair; ` +
        `each discarded duplicate would lose a scope from every total. These values ` +
        `would be too small and are therefore not reported.
`,
    );
    return 2;
  }

  const productionCognitive = perFile
    .filter((f) => !isTestPath(f.relativePath))
    .flatMap((f) => f.cognitive);
  const productionTotals = sumsFor(productionCognitive, {});

  const byPackage = new Map();
  for (const file of perFile) {
    const key = packageOf(file.relativePath);
    const bucket = byPackage.get(key) ?? { nodes: [], files: 0, lines: 0 };
    bucket.nodes.push(...file.cognitive);
    bucket.files += 1;
    bucket.lines += file.lineCount;
    byPackage.set(key, bucket);
  }

  const hotspotEntries = selectScopeEntries(allCognitive, "execution_unit");
  const hotspots = [...hotspotEntries]
    .sort((a, b) => b.value - a.value || compareCodepoints(a.metricsScopeId, b.metricsScopeId))
    .slice(0, options.top);
  const stats = aggregate(hotspotEntries, [10, 15, 25]);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          metricsVersion: METRICS_VERSION,
          cognitiveAlgorithm: COGNITIVE_ALGORITHM_ID,
          analyzedTreeDigest: treeDigest,
          files: perFile.length,
          scopes: cognitiveTotals.scopeCount,
          fileAccounting: accounting,
          degradedParses: degraded,
          duplicatesDropped,
          invariants: {
            note:
              "children_exceed_parent is a one-sided value bound that cannot detect a parent " +
              "value that is too large; freedom from double counting is checked by " +
              "coverageViolations for each measurement scope.",
            cognitiveValueViolations: cognitiveViolations.length,
            cyclomaticValueViolations: cyclomaticViolations.length,
            cognitiveCoverageViolations: cognitiveCoverage.length,
            cyclomaticCoverageViolations: cyclomaticCoverage.length,
          },
          scopeIdCollisions: collisionStats,
          cognitive: cognitiveTotals,
          cyclomaticExtended: cyclomaticTotals,
          cognitiveProductionOnly: productionTotals,
          statistics: stats,
          ...(options.baseline === undefined ? {} : { externalBaseline: options.baseline }),
          hotspots: hotspots.map((h) => ({ ...labels.get(h.metricsScopeId), value: h.value })),
          skipLedger: ledger,
          skipLedgerIssues: ledgerIssues,
        },
        null,
        2,
      )}\n`,
    );
    return ledgerIssues.length > 0 ? 2 : 0;
  }

  const out = [];
  out.push("UNTANGLE COMPLEXITY REPORT");
  out.push(`metricsVersion=${METRICS_VERSION}  cognitiveAlgorithm=${COGNITIVE_ALGORITHM_ID}`);
  out.push(
    `analyzedTreeDigest=${treeDigest}  files measured=${String(perFile.length)}  ` +
      `scanner supplied=${String(accounting.discovered)}  ` +
      `with reasons in ledger=${String(accounting.ledgered)}`,
  );
  out.push("");
  out.push("0) FINDING: symbolScopeId is not unique within each file");
  out.push(
    renderTable(
      ["Metric", "Value"],
      [
        ["Files with at least one colliding adapter ID", String(collisionStats.files)],
        ["colliding adapter IDs", String(collisionStats.ids)],
        ["affected scopes", String(collisionStats.scopes)],
        [
          "NodeKindFacts assigned through fallback (without range)",
          String(collisionStats.nodeKindFallbacks),
        ],
      ],
    ),
  );
  if (collisionStats.ids > 0) {
    out.push(
      "   Cause: the ordinal counter is local to each parent scope, but the ID only includes",
    );
    out.push("   the qualified name. Two anonymous callbacks under anonymous parents receive");
    out.push("   both `<anonymous>.<anonymous>` with ordinal 0. Deduplicating by that ID");
    out.push("   (spec.md §16.10) would merge actual scopes. The report therefore uses");
    out.push("   repaired IDs (byte range, `withUniqueScopeIds`) and reports collisions");
    out.push("   here rather than hiding them. The adapter needs correction (WP-06).");
    out.push("   Examples:");
    for (const example of collisionStats.examples) {
      out.push(`   - ${example}`);
    }
  }
  out.push("");
  out.push("0b) PARSE QUALITY — files with damaged syntax trees");
  if (degraded.length === 0) {
    out.push(`   None. All ${String(perFile.length)} measured files have parseQuality="complete".`);
  } else {
    out.push(
      renderTable(
        ["File", "parseQuality", "error nodes", "missing nodes", "bytes under error nodes"],
        degraded.map((file) => [
          file.relativePath,
          file.parseQuality,
          String(file.errorNodeCount),
          String(file.missingNodeCount),
          `${String(file.damagedBytes)}/${String(file.totalBytes)}`,
        ]),
      ),
    );
    out.push(
      `   These ${String(degraded.length)} file(s) contribute to no measurement in this report and`,
    );
    out.push("   appear with reasons in the skip ledger (section 6, parse_failed). Under an");
    out.push("   ERROR node, the tree loses entire methods and assigns remaining methods to");
    out.push("   the wrong parent scope. In this repository, one such file lost three");
    out.push("   real methods and showed a hotspot value of 54 instead of 7. A");
    out.push("   hotspot ranking that points to the wrong location is more harmful than an");
    out.push("   shorter, accurate ranking.");
  }
  out.push("");
  out.push("1) INVARIANTS");
  out.push(
    renderTable(
      ["Check", "Scopes", "Verstoesse"],
      [
        [
          "a) Cognitive value bound (perScopeBase=0)",
          String(cognitiveTotals.scopeCount),
          String(cognitiveViolations.length),
        ],
        [
          "a) cyclomatic_extended value bound (perScopeBase=1)",
          String(cyclomaticTotals.scopeCount),
          String(cyclomaticViolations.length),
        ],
        [
          "b) Cognitive coverage count (3 measurement scopes)",
          String(cognitiveTotals.scopeCount * SCOPE_SUM_READINGS.length),
          String(cognitiveCoverage.length),
        ],
        [
          "b) cyclomatic_extended coverage count (3 measurement scopes)",
          String(cyclomaticTotals.scopeCount * SCOPE_SUM_READINGS.length),
          String(cyclomaticCoverage.length),
        ],
        [
          "discarded ID duplicates (cognitive / cyclomatic)",
          "-",
          `${String(duplicatesDropped.cognitive)} / ${String(duplicatesDropped.cyclomatic)}`,
        ],
      ],
    ),
  );
  out.push("   a) Value bound per scope: self + sum of direct children <= parent value;");
  out.push("      leaf self == leaf inclusive; no unknown parents or cycles.");
  out.push("      This does not detect a parent value that is too large. The bound is one-sided;");
  out.push("      a parent counting a child twice still satisfies it.");
  out.push("      This cannot be decided from values alone. This line is therefore");
  out.push("      not an assurance against double counting; it was previously read that way.");
  out.push(
    "   b) Coverage count per scope and measurement scope: every scope enters exactly one term,",
  );
  out.push("      never two (double counted) or zero (content lost). This is the assurance");
  out.push("      supporting the totals in sections 2 and 3. It checks the selection structure,");
  out.push("      not the values; a value that internally double counts will remain");
  out.push("      undetected here and is the calculator's responsibility.");
  out.push("   Discarded ID duplicates must be 0: after ID repair, every ID identifies");
  out.push("   exactly one scope. Discarding one loses content, so the script aborts.");
  out.push("");
  out.push("2) TOTALS — cognitive, each value identifies its measurement scope");
  out.push(
    renderTable(
      ["Measurement scope", "Total", "Bedeutung"],
      [
        [
          "top_level",
          num(cognitiveTotals.topLevelSum),
          "once per file, full nesting up to the file",
        ],
        [
          "execution_unit",
          num(cognitiveTotals.executionUnitSum),
          "once per outermost function, with nesting restarted there (DEFAULT)",
        ],
        [
          "self",
          num(cognitiveTotals.selfSum),
          "once per scope, with nesting restarted in each scope",
        ],
        [
          "(naive, INVALID)",
          num(cognitiveTotals.naiveSum),
          `zaehlt ${num(cognitiveTotals.doubleCountedAmount)} double counted; never use as a metric`,
        ],
        [
          "(leaves only, INVALID)",
          num(cognitiveTotals.leafOnlySum),
          `verschluckt ${num(cognitiveTotals.leafOnlyDroppedAmount)} self contribution of scopes with children`,
        ],
      ],
    ),
  );
  out.push("");
  out.push(
    "   cyclomatic_extended uses the same measurement scopes, with M = 1 + decision_points per scope;",
  );
  out.push("   the base reverses the ordering: `self` counts it per scope, `top_level` per file.");
  out.push(
    renderTable(
      ["Measurement scope", "Total"],
      [
        ["top_level", num(cyclomaticTotals.topLevelSum)],
        ["execution_unit", num(cyclomaticTotals.executionUnitSum)],
        ["self", num(cyclomaticTotals.selfSum)],
      ],
    ),
  );
  out.push("");
  out.push("3) TOTALS PER PACKAGE — cognitive");
  const packageRows = [...byPackage.entries()]
    .map(([name, bucket]) => {
      const totals = sumsFor(bucket.nodes, {});
      return {
        name,
        files: bucket.files,
        lines: bucket.lines,
        scopes: totals.scopeCount,
        executionUnit: totals.executionUnitSum,
        topLevel: totals.topLevelSum,
        self: totals.selfSum,
      };
    })
    .sort((a, b) => b.executionUnit - a.executionUnit || compareCodepoints(a.name, b.name));
  out.push(
    renderTable(
      ["Paket", "Files", "Zeilen", "Scopes", "execution_unit", "top_level", "self"],
      packageRows.map((r) => [
        r.name,
        String(r.files),
        String(r.lines),
        String(r.scopes),
        num(r.executionUnit),
        num(r.topLevel),
        num(r.self),
      ]),
    ),
  );
  out.push("");
  out.push(`4) HOTSPOTS — function measurement scope, top ${String(options.top)}`);
  out.push(
    renderTable(
      ["#", "cognitive", "Symbol", "File:Line"],
      hotspots.map((hit, index) => {
        const label = labels.get(hit.metricsScopeId);
        return [
          String(index + 1),
          num(hit.value),
          label === undefined ? hit.metricsScopeId : `${label.name} (${label.kind})`,
          label === undefined ? "?" : `${label.relativePath}:${String(label.line)}`,
        ];
      }),
    ),
  );
  out.push("");
  out.push("5) DISTRIBUTION across function measurement-scope entries");
  out.push(
    renderTable(
      ["count", "sum", "mean", "median", "p90", "p95", "max", ">10", ">15", ">25"],
      [
        [
          String(stats.count),
          num(stats.sum),
          num(stats.mean),
          num(stats.median),
          num(stats.p90),
          num(stats.p95),
          num(stats.max),
          String(stats.thresholdCounts["10"]),
          String(stats.thresholdCounts["15"]),
          String(stats.thresholdCounts["25"]),
        ],
      ],
    ),
  );
  out.push("");
  out.push("6) SKIP LEDGER (E4) — content excluded from measurements");
  const reasonRows = Object.entries(ledger.countsByReason)
    .sort(([a], [b]) => compareCodepoints(a, b))
    .map(([reason, count]) => [reason, String(count)]);
  out.push(renderTable(["Grund", "Count"], reasonRows));
  if (ledgerIssues.length > 0) {
    out.push("   LEDGER FINDINGS:");
    for (const issue of ledgerIssues) out.push(`   - ${issue.kind}: ${issue.message}`);
  }
  out.push("");
  out.push("7) CROSS-CHECK CONTEXT (X8)");
  out.push(
    renderTable(
      ["Ausschnitt", "Files", "cognitive execution_unit"],
      [
        // WP-201: „alle geparsten Dateien" war eine Teilmenge mit dem Etikett
        // einer Gesamtmenge. `perFile` enthaelt NICHT, was der Scanner
        // geliefert, aber der Ledger mit Grund aussortiert hat — beschaedigte
        // Syntaxbaeume (Abschnitt 0b), Textformate, uebersprungene Pfade. Wer
        // die Zahl gegen einen externen Lauf haelt — und genau dafuer ist
        // dieser Abschnitt da —, vergleicht sonst zwei verschieden grosse
        // Mengen und nennt die Differenz einen Metrikunterschied.
        ["all measured files", String(perFile.length), num(cognitiveTotals.executionUnitSum)],
        [
          "excluding test/fixture paths (heuristic)",
          String(perFile.filter((f) => !isTestPath(f.relativePath)).length),
          num(productionTotals.executionUnitSum),
        ],
      ],
    ),
  );
  out.push("   Production/test separation is a path heuristic and contributes to no metric;");
  out.push(
    "   it appears here because an external comparison run measures a different file subset.",
  );
  out.push(
    `   Reference population: ${String(perFile.length)} of ${String(accounting.discovered)} supplied by the scanner ` +
      `supplied files; ${String(accounting.ledgered)} have reasons in the ledger and contribute to ` +
      "no measurement in this table.",
  );
  if (options.baseline !== undefined) {
    const productionFiles = perFile.filter((f) => !isTestPath(f.relativePath)).length;
    const ratio =
      options.baseline === 0 ? NaN : productionTotals.executionUnitSum / options.baseline;
    out.push("");
    out.push(
      renderTable(
        ["Vergleich", "extern", "Untangle (execution_unit, excluding test paths)", "Verhaeltnis"],
        [
          [
            "cognitive",
            num(options.baseline),
            num(productionTotals.executionUnitSum),
            Number.isFinite(ratio) ? `${ratio.toFixed(2)}x` : "n/a",
          ],
          [
            "Files",
            options.baselineFiles === undefined ? "(not supplied)" : String(options.baselineFiles),
            String(productionFiles),
            options.baselineFiles === undefined || options.baselineFiles === 0
              ? "n/a"
              : `${(productionFiles / options.baselineFiles).toFixed(2)}x`,
          ],
        ],
      ),
    );
    out.push("   A ratio near 1 is meaningful only if the file-count ratio is also near 1.");
  }
  out.push("");
  process.stdout.write(`${out.join("\n")}\n`);
  return ledgerIssues.length > 0 ? 2 : 0;
}

function renderViolations(violations, labels) {
  const rows = violations.slice(0, 50).map((violation) => {
    const label = labels.get(violation.metricsScopeId);
    return [
      violation.metric,
      violation.code,
      label === undefined
        ? violation.metricsScopeId
        : `${label.relativePath}:${String(label.line)} ${label.name}`,
      `${num(violation.observed)} > ${num(violation.limit)}`,
    ];
  });
  return `${renderTable(["Metric", "Code", "Scope", "beobachtet"], rows)}\n`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
