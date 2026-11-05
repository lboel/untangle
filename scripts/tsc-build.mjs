#!/usr/bin/env node
/**
 * Paket-Build mit LEERER Ausgabe — WP-224.
 *
 * DER BEFUND. `pnpm check-publishable` meldete in drei Paketen Testgeruest im
 * Produktions-Tarball (`dist/testing/fake-native-watcher.*`,
 * `dist/testing/memory-file-system.*`, `dist/commands/**\/test-support.*`) und
 * tote Source-Maps. Die naheliegende Erklaerung — ein fehlendes `exclude` —
 * war FALSCH: jedes betroffene tsconfig.json schloss diese Dateien bereits
 * aus. Ausgeliefert wurden ALTE Emissionen aus der Zeit VOR dem `exclude`.
 *
 * `tsc` schreibt Ausgabedateien, es raeumt sie nie weg. Was einmal in `dist`
 * lag, bleibt dort:
 *   - eine Datei, die spaeter per `exclude` aus dem Build faellt,
 *   - ein Modul, das umbenannt wurde (`src/commands/init.ts` wurde zum
 *     Verzeichnis `src/commands/init/`; `dist/commands/init.js` samt Map lag
 *     danach noch monatelang im Tarball und zeigte auf eine Quelle, die es
 *     nicht mehr gibt).
 * Beides landet in jedem Tarball, ohne dass irgendein Werkzeug es sagt.
 *
 * DIE ENTSCHEIDUNG. Nicht `files`-Negationen als Hauptmittel — die verstecken
 * nur die Symptome, die jemand vorher erraten hat (`!dist/**\/testing/**`
 * haette `dist/commands/init.js` nie erwischt). Stattdessen: der Build emit-
 * tiert IMMER in einen leeren Baum. Was in `dist` liegt, ist dann per
 * Konstruktion genau das, was der aktuelle Quelltext und das aktuelle
 * `exclude` hergeben — kein Rest aus einer frueheren Fassung.
 *
 * KOSTEN, gemessen am ganzen Monorepo (20 Pakete, `pnpm build`):
 *   inkrementell (Ausgangslage) : 7,0 s
 *   vollstaendig (diese Fassung): 10,4 s
 * 3,4 s fuer eine Klasse von Fehlern, die sonst niemand sieht. Der Entwick-
 * lerkreis mit Dauerlauf ist davon nicht betroffen (`build:watch` benutzt
 * seine eigene tsconfig und diesen Wrapper nicht).
 *
 * WARUM NEBENAN GEBAUT UND DANN GETAUSCHT WIRD. Zwei Fassungen davor sind an
 * derselben Stelle gescheitert, beide beobachtet, nicht vermutet:
 *
 *   1. `rm -rf dist && tsc`. Schlug `tsc` fehl, stand das Paket OHNE
 *      Ausgabebaum da — `apps/cli/dist/index.js` war weg, obwohl der Fehler in
 *      einer einzigen Datei lag, und wer das Binaer gerade benutzte, sass auf
 *      dem Trockenen.
 *   2. `dist` beiseite legen, `tsc`, bei Fehler zurueckholen. Der Fehlerfall
 *      war damit heil — aber `dist` FEHLTE waehrend des gesamten `tsc`-Laufs.
 *      In diesem Repository arbeiten mehrere Laeufe gleichzeitig; ein
 *      `typecheck` in einem abhaengigen Paket fiel prompt mit
 *      `TS2307: Cannot find module '@untangle-code/parser-registry'` heraus,
 *      weil er genau in dieses Fenster von einigen Sekunden fiel.
 *
 * Deshalb: `tsc` emittiert nach `<outDir>.build` (per `--outDir` ueberschrie-
 * ben), und erst ein GRUENER Lauf tauscht die Baeume per `rename` durch. Das
 * Fenster, in dem `dist` fehlt, ist damit ein Umbenennen lang statt einen
 * Compilerlauf lang. Scheitert `tsc`, bleibt `dist` voellig unberuehrt — der
 * Exit-Code von `tsc` wird trotzdem durchgereicht, der Fehler wird nicht
 * weicher. Reste eines abgebrochenen Laufs (`.build`, `.prev`) raeumt der
 * naechste Lauf weg.
 *
 * Aufruf (aus einem Paketverzeichnis, via `pnpm run build`):
 *   node ../../scripts/tsc-build.mjs [tsconfig.json]
 *
 * Exit-Codes: der Exit-Code von `tsc`; 1 bei Bedienfehlern.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const packageDir = process.cwd();
const projectArg = process.argv[2] ?? "tsconfig.json";
const projectPath = path.resolve(packageDir, projectArg);

if (!existsSync(projectPath)) {
  process.stderr.write(`tsc-build: ${projectPath} does not exist.
`);
  process.exit(1);
}

/**
 * tsconfig-Dateien in diesem Repo tragen Kommentare (JSONC). Wir brauchen
 * genau zwei Felder, also reicht ein sparsamer Entkommentierer; er entfernt
 * nur ganze Kommentarzeilen, nie etwas innerhalb eines Strings.
 */
function readJsonc(file) {
  const text = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON(C): ${error.message}`);
  }
}

const project = readJsonc(projectPath);
const options = project.compilerOptions ?? {};
const projectDir = path.dirname(projectPath);

/**
 * Geloescht wird ausschliesslich, was `tsc` selbst erzeugt: das `outDir` und
 * die Build-Info. Ohne `outDir` wuerde `tsc` neben die Quellen emittieren —
 * dann ist hier nichts sicher loeschbar, und der Lauf bricht lieber ab, als
 * zu raten.
 */
if (typeof options.outDir !== "string" || options.outDir.length === 0) {
  process.stderr.write(
    `tsc-build: ${projectPath} does not set "outDir". Without outDir, the output tree
` +
      `cannot be safely cleared; set outDir (usually "dist").
`,
  );
  process.exit(1);
}

const outDir = path.resolve(projectDir, options.outDir);
if (outDir === projectDir || !outDir.startsWith(projectDir + path.sep)) {
  process.stderr.write(
    `tsc-build: outDir "${options.outDir}" is not inside ${projectDir}.\n` +
      `Aborting; this script deletes nothing outside its own package.
`,
  );
  process.exit(1);
}

const stageDir = `${outDir}.build`;
const backupDir = `${outDir}.prev`;

/**
 * Reste eines abgebrochenen Laufs. `.prev` existiert nur zwischen zwei
 * `rename`-Aufrufen; wurde der Lauf genau dort abgeschossen, ist `.prev` der
 * einzige vollstaendige Baum und wird zurueckgeholt.
 */
rmSync(stageDir, { recursive: true, force: true });
if (existsSync(backupDir)) {
  if (existsSync(outDir)) rmSync(backupDir, { recursive: true, force: true });
  else renameSync(backupDir, outDir);
}

const buildInfoPath =
  typeof options.tsBuildInfoFile === "string" && options.tsBuildInfoFile.length > 0
    ? path.resolve(projectDir, options.tsBuildInfoFile)
    : null;
if (buildInfoPath !== null) rmSync(buildInfoPath, { force: true });

const require = createRequire(import.meta.url);
const tscBin = require.resolve("typescript/bin/tsc");

const result = spawnSync(process.execPath, [tscBin, "-p", projectPath, "--outDir", stageDir], {
  cwd: packageDir,
  stdio: "inherit",
});

const status = result.error ? 1 : (result.status ?? 1);
if (result.error) {
  process.stderr.write(`tsc-build: could not start tsc: ${result.error.message}\n`);
}

if (status !== 0) {
  // `dist` wurde nie angefasst: der alte Baum steht unveraendert, der Fehler
  // steht oben. Nur das halbfertige Zwischenergebnis faellt weg.
  rmSync(stageDir, { recursive: true, force: true });
  process.exit(status);
}

if (!existsSync(stageDir)) {
  process.stderr.write(
    `tsc-build: tsc reported success but wrote nothing to ${path.relative(packageDir, stageDir)}.\n` +
      `Aborting; an empty output tree will not replace the previous build.
`,
  );
  process.exit(1);
}

// Durchtauschen. Zwischen den beiden `rename`-Aufrufen fehlt `dist` — das ist
// das kuerzeste Fenster, das ohne Sperren erreichbar ist.
if (existsSync(outDir)) renameSync(outDir, backupDir);
renameSync(stageDir, outDir);
rmSync(backupDir, { recursive: true, force: true });

process.exit(0);
