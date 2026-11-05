/**
 * `untangle complexity` gegen ECHTE Dateien, echte Sprachadapter und die
 * echte Metrik-Bibliothek. Keine Attrappe — der Befehl braucht keine, weil er
 * keinen Dienst braucht.
 *
 * Geprueft wird vor allem das, was der Befehl VERSPRICHT und nicht nur das,
 * was er berechnet: dass eine nicht analysierbare Datei mit Grund im
 * Skip-Ledger landet statt zu verschwinden (E4), und dass das Gate wirklich
 * greift statt es nur zu behaupten (E5).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseArgs } from "../cli/args.js";
import type { CommandContext } from "../cli/command.js";
import { EXIT } from "../cli/exit.js";
import { BufferIo } from "../cli/io.js";

import { analyze, complexityCommand } from "./complexity.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "untangle-cli-complexity-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "src", "branchy.ts"),
    [
      "export function branchy(a: number, b: number): number {",
      "  if (a > 0) {",
      "    for (let i = 0; i < a; i++) {",
      "      if (b > i) {",
      "        return i;",
      "      }",
      "    }",
      "  } else if (b > 0) {",
      "    while (b > 0) {",
      "      b -= 1;",
      "    }",
      "  }",
      "  return b;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(root, "src", "flat.ts"),
    "export function flat(a: number): number {\n  return a;\n}\n",
    "utf8",
  );
  // WP-110/WP-217: Markdown ist erstklassiger Inhalt (vision.md §1c). Diese
  // Datei darf NICHT mehr als "unsupported_language" verschwinden, sondern
  // muss ihre eigenen Prosa-Masse bekommen.
  writeFileSync(
    path.join(root, "notes.md"),
    [
      "# Titel",
      "Text.",
      "",
      "## Teil",
      "Verweis auf [flat](./src/flat.ts) und [weg](./gibt-es-nicht.ts).",
      "",
    ].join("\n"),
    "utf8",
  );
  // Strukturierte Konfiguration: unterstuetzt (Stufe text), aber ohne Metrik.
  writeFileSync(path.join(root, "config.toml"), "[a]\nb = 1\n", "utf8");
  // Maschinell erzeugt: eigener Grund, keine Sprachbehauptung.
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  // Eine Sprache, fuer die es wirklich keinen Adapter gibt. WP-86: hier stand
  // frueher `script.rb` — Ruby IST seit der Sprachbreite unterstuetzt, Erlang
  // nicht.
  writeFileSync(path.join(root, "script.erl"), "-module(script).\n", "utf8");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function contextWith(io: BufferIo): CommandContext {
  return { io, cwd: root, env: {}, signal: new AbortController().signal };
}

async function runComplexity(argv: readonly string[]): Promise<{ code: number; io: BufferIo }> {
  const io = new BufferIo();
  const args = parseArgs([...argv, `--root=${root}`], complexityCommand.spec.flags);
  const code = await complexityCommand.run(contextWith(io), args);
  return { code, io };
}

describe("untangle complexity", () => {
  it("rechnet ohne Index und ohne Dienste und ordnet die Hotspots absteigend", async () => {
    const { code, io } = await runComplexity(["--format=json"]);
    expect(code).toBe(EXIT.ok);
    const report = JSON.parse(io.outText) as {
      filesAnalyzed: number;
      totals: { executionUnits: number; cognitive: number };
      hotspots: { name: string; cognitive: number }[];
      skipped: { path: string; reason: string; detail: string }[];
    };
    expect(report.filesAnalyzed).toBe(2);
    expect(report.totals.executionUnits).toBe(2);
    expect(report.hotspots[0]?.name).toBe("branchy");
    expect(report.hotspots[0]?.cognitive).toBeGreaterThan(report.hotspots[1]?.cognitive ?? 0);
  });

  it("traegt eine nicht analysierbare Datei MIT GRUND in den Skip-Ledger", async () => {
    const { io } = await runComplexity(["--format=json"]);
    const report = JSON.parse(io.outText) as {
      skipped: { path?: string; reason: string; detail: string }[];
    };
    const entry = report.skipped.find((skip) => skip.path === "script.erl");
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("unsupported_language");
    // E4: eine Begruendung, die etwas sagt — nicht bloss ein Feld, das existiert.
    expect(entry?.detail.length).toBeGreaterThan(20);
  });

  // WP-217: der richtige Grund, nicht der naechstbeste.
  it("nennt fuer jedes Uebersprungene den PASSENDEN Grund", async () => {
    const { io } = await runComplexity(["--format=json"]);
    const report = JSON.parse(io.outText) as {
      skipped: { path?: string; reason: string; detail: string }[];
    };
    const reasonFor = (p: string) => report.skipped.find((s) => s.path === p)?.reason;
    // Verstandenes Format ohne definierte Metrik — NICHT "unsupported_language".
    expect(reasonFor("config.toml")).toBe("no_metric_defined");
    // Maschinell erzeugt — NICHT "unsupported_language".
    expect(reasonFor("pnpm-lock.yaml")).toBe("generated_content");
    // Und Markdown steht ueberhaupt nicht mehr im Ledger.
    expect(report.skipped.some((s) => s.path === "notes.md")).toBe(false);
  });

  // WP-110/WP-217: Prosa bekommt eigene Masse in einer eigenen Familie.
  it("misst Markdown mit Prosa-Massen statt es zu ueberspringen", async () => {
    const { io } = await runComplexity(["--format=json"]);
    const report = JSON.parse(io.outText) as {
      filesProse: number;
      totals: { executionUnits: number; cognitive: number; cyclomatic: number };
      prose: {
        path: string;
        structureLoad: { proseMeasurement: boolean; value: number; unit: string };
        sectionDepth: { value: number };
        unresolvedLinkRatio: { value: number } | null;
      }[];
    };
    expect(report.filesProse).toBe(1);
    const doc = report.prose.find((p) => p.path === "notes.md");
    expect(doc).toBeDefined();
    // Strukturlast = 1 + 2.
    expect(doc?.structureLoad.value).toBe(3);
    expect(doc?.sectionDepth.value).toBe(2);
    // Einer von zwei relativen Verweisen zeigt ins Leere.
    expect(doc?.unresolvedLinkRatio?.value).toBe(0.5);
    // Die Trennung ist strukturell sichtbar: Objekt mit Einheit, keine Zahl.
    expect(doc?.structureLoad.proseMeasurement).toBe(true);
    expect(doc?.structureLoad.unit).toBe("count");
  });

  // Der Kern von WP-217: die beiden Familien beruehren einander nie.
  it("addiert keine Prosa-Zahl in die Code-Summen", async () => {
    const { io } = await runComplexity(["--format=json"]);
    const report = JSON.parse(io.outText) as {
      filesAnalyzed: number;
      totals: { executionUnits: number; cognitive: number; cyclomatic: number };
    };
    // Nur die beiden .ts-Dateien gehen in die Code-Zahlen ein.
    expect(report.filesAnalyzed).toBe(2);
    expect(report.totals.executionUnits).toBe(2);
    for (const value of Object.values(report.totals)) {
      expect(typeof value).toBe("number");
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("zeigt die Prosa-Tafel unter eigener Ueberschrift", async () => {
    const { io } = await runComplexity(["--prose"]);
    expect(io.outText).toContain("PROSE (separate metric family");
    expect(io.outText).toContain("notes.md");
    // Keine Code-Hotspots in der Prosa-Ansicht.
    expect(io.outText).not.toContain("HOTSPOTS");
  });

  it("haelt ein Gate, das nicht gerissen wird", async () => {
    const { code } = await runComplexity(["--max-cognitive=1000"]);
    expect(code).toBe(EXIT.ok);
  });

  // E5: der Abbruchpfad wird BEWIESEN, nicht behauptet.
  it("endet mit Exit-Code 5, wenn eine Schwelle wirklich gerissen wird", async () => {
    const { code, io } = await runComplexity(["--max-cognitive=0"]);
    expect(code).toBe(EXIT.gate);
    expect(io.errText).toContain("threshold violation");
    expect(io.errText).toContain("branchy");
    expect(io.errText).toContain("Next step:");
  });

  it("liefert deterministisch dieselbe Ausgabe fuer denselben Baum", async () => {
    const first = await runComplexity(["--format=json"]);
    const second = await runComplexity(["--format=json"]);
    expect(first.io.outText).toBe(second.io.outText);
  });
});

describe("execution_unit totals", () => {
  it("counts a nested function once while retaining both hotspot entries", async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "untangle-nested-total-"));
    try {
      writeFileSync(
        path.join(fixture, "nested.ts"),
        `export function outer(a: boolean) {
  if (a) return inner(a);
  function inner(b: boolean) {
    if (b) return 1;
    return 0;
  }
  return 0;
}
`,
      );
      const report = await analyze(fixture, new AbortController().signal);
      expect(report.totalsReading).toBe("execution_unit");
      expect(report.totals).toEqual({
        executionUnits: 2,
        executionUnitRoots: 1,
        cognitive: 3,
        cyclomatic: 4,
      });
      const functions = report.symbols.filter((entry) => entry.executionUnit);
      expect(functions.map((entry) => entry.cognitive)).toEqual([3, 1]);
      expect(functions.reduce((sum, entry) => sum + entry.cognitive, 0)).toBe(4);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("includes control flow outside functions and rejects a missing root", async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "untangle-top-level-total-"));
    try {
      writeFileSync(
        path.join(fixture, "top.ts"),
        "const ready = true; if (ready) console.log(ready);\n",
      );
      const report = await analyze(fixture, new AbortController().signal);
      expect(report.totals).toEqual({
        executionUnits: 0,
        executionUnitRoots: 0,
        cognitive: 1,
        cyclomatic: 2,
      });
      await expect(
        analyze(path.join(fixture, "missing"), new AbortController().signal),
      ).rejects.toThrow("does not exist");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
