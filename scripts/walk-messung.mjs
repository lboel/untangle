#!/usr/bin/env node
/**
 * `node scripts/walk-messung.mjs` — die Messung zu WP-95.
 *
 * GRUNDSATZ (docs/PERFORMANCE.md): keine Optimierung ohne Messung. Ein
 * Leistungsversprechen ohne Zahl ist wertlos, und eine Zahl aus zwei
 * getrennten Laeufen ist es fast auch — auf einer Maschine mit Fremdlast misst
 * man dann die Fremdlast. Dieses Skript laesst deshalb BEIDE Staende im
 * SELBEN Prozess und ABWECHSELND laufen und nimmt je Stand die beste Runde.
 *
 * Gemessen wird je Datei getrennt:
 *   parse         `adapter.parse` — natives tree-sitter plus Parse-Diagnosen.
 *   walk          `computeComplexity` — der vereinheitlichte Walk.
 *   projektionen  Chunks, Symbole, Importe, Aufrufe aus dem memoisierten Ergebnis.
 *
 * AUFRUF
 *   node scripts/walk-messung.mjs [--alt=<pfad/zu/dist/index.js>]
 *                                 [--neu=<pfad>] [--root=<verz>] [--runden=N]
 *
 * Ohne `--alt` wird nur der neue Stand gemessen (kein Vergleich, kein Faktor).
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

function argOf(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(argOf("root") ?? path.join(HERE, ".."));
const ALT = argOf("alt");
const NEU = argOf("neu");
const ROUNDS = Number(argOf("runden") ?? "4");

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

const loaded = {
  neu:
    NEU === null
      ? await import("@untangle-code/parser-registry")
      : await import(pathToFileURL(path.resolve(NEU)).href),
};
if (ALT !== null) loaded.alt = await import(pathToFileURL(path.resolve(ALT)).href);

const registries = Object.fromEntries(
  Object.entries(loaded).map(([name, mod]) => [name, mod.createParserRegistry()]),
);
const names = ALT === null ? ["neu"] : ["alt", "neu"];

const inputs = [];
for (const file of (await collect(ROOT, [])).sort()) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const rel = path.relative(ROOT, file);
  if (registries.neu.getAdapterForPath(rel) === null) continue;
  inputs.push({ rel, content, lines: content.split("\n").length });
}
const LOC = inputs.reduce((sum, i) => sum + i.lines, 0);

function pass(which) {
  const registry = registries[which];
  let parseMs = 0;
  let walkMs = 0;
  let projMs = 0;
  let ok = 0;
  for (const input of inputs) {
    const adapter = registry.getAdapterForPath(input.rel);
    const t0 = performance.now();
    let result;
    try {
      result = adapter.parse({ fileId: input.rel, path: input.rel, content: input.content });
    } catch {
      continue;
    }
    const t1 = performance.now();
    if (result.ast === null) continue;
    adapter.computeComplexity(result.ast);
    const t2 = performance.now();
    adapter.extractChunks(result.ast);
    adapter.extractSymbols(result.ast);
    adapter.extractImports(result.ast);
    adapter.extractCalls(result.ast);
    const t3 = performance.now();
    parseMs += t1 - t0;
    walkMs += t2 - t1;
    projMs += t3 - t2;
    ok += 1;
  }
  return { ok, parseMs, walkMs, projMs, total: parseMs + walkMs + projMs };
}

for (const name of names) pass(name); // aufwaermen: Grammatik laden, JIT

const best = {};
for (let round = 0; round < ROUNDS; round++) {
  // Abwechselnde Reihenfolge, damit kein Stand systematisch die kaeltere
  // oder die staerker gestoerte Haelfte des Laufs abbekommt.
  const order = round % 2 === 0 ? names : [...names].reverse();
  for (const name of order) {
    const row = pass(name);
    console.log(
      `  ${name.padEnd(4)} #${round}  parse ${row.parseMs.toFixed(0)} ms  walk ${row.walkMs.toFixed(0)} ms  ` +
        `projektionen ${row.projMs.toFixed(0)} ms  gesamt ${row.total.toFixed(0)} ms`,
    );
    if (best[name] === undefined || row.total < best[name].total) best[name] = row;
  }
}

const kloc = (ms) => (LOC / ms).toFixed(2);
console.log(`
Files ${best[names[0]].ok}   Zeilen ${LOC}   best round per version:`);
for (const name of names) {
  const b = best[name];
  console.log(
    `${name.toUpperCase().padEnd(4)}  parse ${b.parseMs.toFixed(0)} ms (${kloc(b.parseMs)} kLOC/s)  ` +
      `walk ${b.walkMs.toFixed(0)} ms (${kloc(b.walkMs)} kLOC/s)  ` +
      `gesamt ${b.total.toFixed(0)} ms (${kloc(b.total)} kLOC/s)  ` +
      `Walkanteil ${((b.walkMs / b.total) * 100).toFixed(1)} %`,
  );
}
if (names.length === 2) {
  console.log(
    `FACTOR  walk ${(best.alt.walkMs / best.neu.walkMs).toFixed(2)}x   ` +
      `parse ${(best.alt.parseMs / best.neu.parseMs).toFixed(2)}x   ` +
      `gesamt ${(best.alt.total / best.neu.total).toFixed(2)}x`,
  );
}
