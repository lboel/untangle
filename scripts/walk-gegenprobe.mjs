#!/usr/bin/env node
/**
 * `node scripts/walk-gegenprobe.mjs` — die Gegenprobe zu WP-95
 * (Cursor-Traversierung statt `node.children`).
 *
 * WOZU: eine Beschleunigung, die Ergebnisse veraendert, ist kein Gewinn,
 * sondern ein Defekt. Dieses Skript fuehrt BEIDE Wege ueber JEDE Quelldatei
 * eines Verzeichnisses und vergleicht, was ein Aufrufer wirklich sieht:
 * Symbole samt Fingerabdruecken, AST-Regionen, Chunk-IDs, Chunk-Entwuerfe und
 * Abdeckungsledger, Importe, Aufrufkanten, `ComplexityFacts` und
 * Halstead-Tokens.
 *
 * ZWEITE STUFE — und die ist die wichtigere: bei einer Abweichung prueft das
 * Skript, ob sie sich VOLLSTAENDIG auf eine benannte Ursache zurueckfuehren
 * laesst. Bei WP-95 ist das der Fall, und die Ursache liegt NICHT in der
 * Umstellung, sondern in `tree-sitter@0.21.1`: `node.children` (und ein auf
 * einen Teilbaum zurueckgesetzter Cursor) melden fuer manche Kommentarknoten
 * einen falschen Typ. Nur ein von der WURZEL abgestiegener Cursor sieht ihn
 * richtig. Der alte Walk zaehlte diese Kommentare deshalb als
 * Halstead-Operatoren, liess sie aus `ComplexityFacts.comments` heraus und
 * nahm sie in `astHash`/`tokenFingerprint` auf.
 *
 * Das Skript besteht nur, wenn JEDE Abweichung so erklaert ist. Bleibt auch
 * nur eine unerklaert, ist die Umstellung defekt (Exit-Code 1).
 *
 * AUFRUF
 *   node scripts/walk-gegenprobe.mjs --alt=<pfad/zu/dist/index.js>
 *                                    [--neu=<pfad>] [--root=<verzeichnis>]
 *
 *   --alt  Vergleichsstand (eine vor der Umstellung gesicherte `dist`).
 *          PFLICHT — das Skript baut sich keinen Vergleichsstand selbst.
 *   --neu  Der zu pruefende Stand. Vorgabe: das gebaute
 *          `@untangle-code/parser-registry` dieses Arbeitsbereichs.
 *   --root Zu vergleichendes Verzeichnis. Vorgabe: das Wurzelverzeichnis.
 *
 * EXIT-CODES
 *   0  jede Datei identisch, oder jede Abweichung vollstaendig erklaert.
 *   1  mindestens eine Abweichung ist UNERKLAERT.
 *   2  Aufruffehler (fehlendes `--alt`, unlesbarer Pfad).
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Die Grammatiken haengen an `@untangle-code/parser-registry`, nicht am
 * Wurzelverzeichnis — der `require` muss dort verankert sein, sonst findet er
 * `tree-sitter-typescript` nicht.
 */
const require = createRequire(import.meta.resolve("@untangle-code/parser-registry"));

function argOf(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(argOf("root") ?? path.join(HERE, ".."));
const ALT = argOf("alt");
const NEU = argOf("neu");
if (ALT === null) {
  console.error(
    "Missing: --alt=<path/to/dist/index.js>; no cross-check is possible without a comparison version.",
  );
  process.exit(2);
}

const IGNORE = new Set(["node_modules", ".git", "coverage", ".untangle", ".vite", ".vite-temp"]);
/**
 * Uebersprungen wird jedes Verzeichnis, dessen Name mit "dist" beginnt —
 * uebersetzte Ausgabe gehoert nie in den Messkorpus, und der gesicherte
 * Vergleichsstand (`dist-baseline`) liegt fuer die Modulaufloesung im
 * Arbeitsbereich, darf sich aber nicht selbst mitmessen.
 */
const skipDir = (name) => IGNORE.has(name) || name.startsWith("dist");
const EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

async function collect(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (skipDir(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(full, out);
    else if (EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const A = await import(pathToFileURL(path.resolve(ALT)).href);
const B =
  NEU === null
    ? await import("@untangle-code/parser-registry")
    : await import(pathToFileURL(path.resolve(NEU)).href);
const { chunkFile } = await import("@untangle-code/chunker");

const registryAlt = A.createParserRegistry();
const registryNeu = B.createParserRegistry();

const PREPARED_TEXT = { documentPrefix: "", repoLabel: "untangle", refName: "main" };

/** Alles, was ein Aufrufer aus einem Parse herausholen kann — eine Datei, ein Stand. */
function project(registry, rel, content) {
  const adapter = registry.getAdapterForPath(rel);
  if (adapter === null) return null;
  let parseResult;
  try {
    parseResult = adapter.parse({ fileId: rel, path: rel, content });
  } catch (error) {
    return { threw: String(error?.message ?? error) };
  }
  if (parseResult.ast === null) return { parseQuality: parseResult.parseQuality, ast: null };

  const ast = parseResult.ast;
  const regions = adapter.extractChunks(ast);
  const symbols = adapter.extractSymbols(ast);
  const chunked = chunkFile({
    identity: {
      workspaceId: "w",
      repoId: "r",
      refId: "main",
      fileId: rel,
      filePath: rel,
      languageId: adapter.languageId,
    },
    content,
    parseResult,
    regions,
    symbols,
    config: { preparedText: PREPARED_TEXT },
  });

  return {
    parseQuality: parseResult.parseQuality,
    errorNodeCount: parseResult.errorNodeCount,
    missingNodeCount: parseResult.missingNodeCount,
    diagnostics: parseResult.diagnostics,
    symbols,
    regions,
    imports: adapter.extractImports(ast),
    calls: adapter.extractCalls(ast),
    facts: adapter.computeComplexity(ast),
    halstead: adapter.tokenizeForHalstead(ast),
    chunkIds: chunked.drafts.map((d) => d.chunkId),
    symbolIds: chunked.drafts.map((d) => d.symbolId ?? null),
    chunkDrafts: chunked.drafts,
    coverage: chunked.coverage,
    chunkStrategy: chunked.strategy,
  };
}

/*
 * ZWEITE STUFE — die Ursachenpruefung.
 */
const GRAMMARS = (() => {
  const ts = require("tree-sitter-typescript");
  const js = require("tree-sitter-javascript");
  return {
    ".ts": ts.typescript,
    ".mts": ts.typescript,
    ".cts": ts.typescript,
    ".tsx": ts.tsx,
    ".js": js,
    ".mjs": js,
    ".cjs": js,
    ".jsx": js,
  };
})();
const Parser = require("tree-sitter");

/**
 * Die Knoten, deren Typ `node.children` anders meldet als ein von der Wurzel
 * abgestiegener Cursor. Beide Durchlaeufe besuchen dieselben Knoten in
 * derselben Ordnung; verglichen wird Position fuer Position.
 */
function mistypedNodes(file, source) {
  const language = GRAMMARS[path.extname(file)];
  if (language === undefined) return null;
  const parser = new Parser();
  parser.setLanguage(language);
  let tree;
  try {
    tree = parser.parse(source, undefined, {
      bufferSize: Math.max(32768, Math.ceil(Buffer.byteLength(source) * 1.25)),
    });
  } catch {
    return null;
  }

  const viaCursor = [];
  const cursor = tree.walk();
  (function descend() {
    viaCursor.push([cursor.nodeType, cursor.startIndex, cursor.endIndex]);
    if (cursor.gotoFirstChild()) {
      do descend();
      while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  })();

  const viaChildren = [];
  (function descend(node) {
    viaChildren.push([node.type, node.startIndex, node.endIndex]);
    for (const child of node.children) descend(child);
  })(tree.rootNode);

  if (viaCursor.length !== viaChildren.length) return null;
  const found = [];
  for (let i = 0; i < viaCursor.length; i++) {
    if (viaCursor[i][0] === viaChildren[i][0]) continue;
    found.push({
      typeViaChildren: viaChildren[i][0],
      typeViaCursor: viaCursor[i][0],
      start: viaCursor[i][1],
      end: viaCursor[i][2],
    });
  }
  return found;
}

const looksLikeComment = (text) => text.startsWith("//") || text.startsWith("/*");

/** Ist die Abweichung dieser Datei vollstaendig durch falsch typisierte Kommentare erklaert? */
function explain(alt, neu, source, mistyped) {
  const problems = [];
  if (mistyped === null) return ["incomparable node kinds"];
  if (mistyped.length === 0) return ["different, but no incorrectly typed node"];

  for (const node of mistyped) {
    if (node.typeViaCursor !== "comment") {
      problems.push(`${node.typeViaChildren} -> ${node.typeViaCursor} is not a comment`);
    }
    if (!looksLikeComment(source.slice(node.start, node.end))) {
      problems.push(`Node text at ${node.start} is not a comment`);
    }
  }

  // 1) Besuchsliste: gleiche Laenge, Unterschiede nur "<falsch> -> comment",
  //    bei gleicher Tiefe und gleichem Scope.
  const kindsAlt = alt.facts.nodeKinds;
  const kindsNeu = neu.facts.nodeKinds;
  if (kindsAlt.length !== kindsNeu.length) {
    problems.push(`nodeKinds-Laenge ${kindsAlt.length} != ${kindsNeu.length}`);
  } else {
    for (let i = 0; i < kindsAlt.length; i++) {
      const a = kindsAlt[i];
      const b = kindsNeu[i];
      if (a.kind === b.kind && a.depth === b.depth && a.symbolScopeId === b.symbolScopeId) continue;
      if (!(b.kind === "comment" && a.depth === b.depth && a.symbolScopeId === b.symbolScopeId)) {
        problems.push(`nodeKinds[${i}] unerklaert: ${a.kind} -> ${b.kind}`);
      }
    }
  }

  // 2) Kommentarbereiche: NEU = ALT plus genau die falsch typisierten Knoten.
  const keyOf = (r) => `${r.startByte}-${r.endByte}`;
  const commentsAlt = new Set(alt.facts.comments.map(keyOf));
  const commentsNeu = new Set(neu.facts.comments.map(keyOf));
  for (const key of commentsAlt)
    if (!commentsNeu.has(key)) problems.push(`Kommentar ${key} verschwunden`);
  const added = [...commentsNeu].filter((key) => !commentsAlt.has(key));
  if (added.length !== mistyped.length) {
    problems.push(`new comments ${added.length} != incorrectly typed nodes ${mistyped.length}`);
  }

  // 3) Operatoren: ALT = NEU plus genau diese Kommentartexte.
  const opKey = (o) => `${o.range.startByte}-${o.range.endByte}-${o.symbolScopeId}`;
  const opKeysNeu = new Set(neu.facts.operators.map(opKey));
  const dropped = alt.facts.operators.filter((o) => !opKeysNeu.has(opKey(o)));
  if (dropped.length !== mistyped.length) {
    problems.push(`removed operators ${dropped.length} != ${mistyped.length}`);
  }
  for (const o of dropped) {
    if (!looksLikeComment(o.text)) problems.push(`removed operator is not a comment`);
  }
  const opKeysAlt = new Set(alt.facts.operators.map(opKey));
  for (const o of neu.facts.operators) {
    if (!opKeysAlt.has(opKey(o)))
      problems.push(`new operator ${JSON.stringify(o.text.slice(0, 20))}`);
  }

  // 4) Was gar nicht betroffen sein darf, muss byte-gleich sein.
  for (const key of [
    "decisions",
    "nestingEvents",
    "operands",
    "identifiers",
    "literals",
    "symbolScopes",
  ]) {
    if (JSON.stringify(alt.facts[key]) !== JSON.stringify(neu.facts[key])) {
      problems.push(`facts.${key} abweichend`);
    }
  }
  for (const key of [
    "imports",
    "calls",
    "regions",
    "chunkIds",
    "symbolIds",
    "coverage",
    "diagnostics",
  ]) {
    if (JSON.stringify(alt[key]) !== JSON.stringify(neu[key])) problems.push(`${key} abweichend`);
  }

  // 5) Symbole: identisch bis auf die beiden Fingerabdruecke.
  // Die beiden Fingerabdruecke sind die EINZIGEN Symbolfelder, die sich
  // aendern duerfen; alles andere am Symbol muss gleich bleiben.
  const strip = (list) =>
    list.map((symbol) => {
      const rest = { ...symbol };
      delete rest.astHash;
      delete rest.tokenFingerprint;
      return rest;
    });
  if (JSON.stringify(strip(alt.symbols)) !== JSON.stringify(strip(neu.symbols))) {
    problems.push("symbols differ outside the fingerprints");
  }

  return problems;
}

const files = (await collect(ROOT, [])).sort();
let compared = 0;
let identical = 0;
let explained = 0;
let mistypedTotal = 0;
const unexplained = [];
const partCounts = new Map();

for (const file of files) {
  const rel = path.relative(ROOT, file);
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue; // Datei ist zwischen Auflistung und Lesen verschwunden.
  }
  const alt = project(registryAlt, rel, content);
  const neu = project(registryNeu, rel, content);
  if (alt === null && neu === null) continue;
  compared += 1;
  if (JSON.stringify(alt) === JSON.stringify(neu)) {
    identical += 1;
    continue;
  }
  for (const key of Object.keys(alt ?? {})) {
    if (JSON.stringify(alt?.[key]) !== JSON.stringify(neu?.[key])) {
      partCounts.set(key, (partCounts.get(key) ?? 0) + 1);
    }
  }
  const mistyped =
    alt?.facts === undefined || neu?.facts === undefined ? null : mistypedNodes(file, content);
  mistypedTotal += mistyped?.length ?? 0;
  const problems = explain(alt, neu, content, mistyped);
  if (problems.length === 0) explained += 1;
  else unexplained.push({ rel, problems: [...new Set(problems)].slice(0, 5) });
}

console.log(`Root: ${ROOT}`);
console.log(`Files compared:                     ${compared}`);
console.log(`  byte-gleich:                       ${identical}`);
console.log(
  `  different, fully explained: ${explained}   (incorrectly typed nodes: ${mistypedTotal})`,
);
console.log(`  different, unexplained:          ${unexplained.length}`);
if (partCounts.size > 0) {
  console.log("Differing areas (files per area):");
  for (const [key, count] of [...partCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${key}`);
  }
}
for (const item of unexplained.slice(0, 20)) {
  console.log(`  UNEXPLAINED ${item.rel}: ${item.problems.join(" | ")}`);
}
if (unexplained.length > 0) process.exitCode = 1;
