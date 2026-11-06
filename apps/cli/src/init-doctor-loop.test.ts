/**
 * WP-222 (a) — DIE SCHLEIFE ALS TEST.
 *
 * Der Ablauf, der einen Nutzer im Kreis laufen liess:
 *
 *   $ untangle init      -> schreibt untangle.toml
 *   $ untangle doctor    -> "keine .untangle.json gefunden"
 *                           "-> Fuehre `untangle init` aus"
 *   $ untangle init      -> die Datei ist schon aktuell
 *   $ untangle doctor    -> ... dieselbe Auskunft, fuer immer
 *
 * `init` schrieb `untangle.toml`, `doctor` suchte `.untangle.json`, und
 * keiner von beiden log — sie redeten aneinander vorbei, weil der Dateiname
 * an zwei Stellen stand. Dieser Test faehrt beide Befehle NACHEINANDER durch
 * denselben Einstiegspunkt, den auch das Binaer benutzt, und verlangt: was
 * `init` geschrieben hat, sieht `doctor`, und `doctor` schickt niemanden
 * zurueck zu `init`.
 *
 * Der Lauf ist offline (`--offline`) und ohne Einbettungstest, damit er
 * weder Ollama noch einen Vektorspeicher braucht — die Schleife hat mit
 * beidem nichts zu tun.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BufferIo } from "./cli/io.js";

import { run } from "./index.js";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), "untangle-wp222-"));
  writeFileSync(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "fremdprojekt", version: "1.0.0", type: "module" }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(path.join(projectRoot, "main.ts"), "export const answer = 42;\n", "utf8");
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

async function invoke(argv: readonly string[]): Promise<{ code: number; io: BufferIo }> {
  const io = new BufferIo();
  const code = await run(argv, {
    io,
    cwd: projectRoot,
    // Eine LEERE Umgebung: kein UNTANGLE_QDRANT_URL, keine geerbte Adresse.
    // Genau der Zustand, in dem `doctor` auf den fremden Port zurueckfiel.
    env: {},
    signal: new AbortController().signal,
  });
  return { code, io };
}

describe("init -> doctor (WP-222 a)", () => {
  it("init schreibt untangle.toml, und doctor sieht genau diese Datei", async () => {
    const init = await invoke(["init", "--offline"]);
    expect(init.code).toBe(0);
    const configPath = path.join(projectRoot, "untangle.toml");
    expect(existsSync(configPath)).toBe(true);

    const doctor = await invoke(["doctor", "--skip-embeddings", "--timeout=1500"]);
    const output = doctor.io.outText;

    expect(output).toContain("untangle.toml");
    expect(output).toContain(configPath);
    // Der Befund selbst, nicht nur der Pfad irgendwo im Text.
    expect(output).toMatch(/\[OK {2}\] Configuration/u);
    expect(output).not.toContain("no untangle.toml or .untangle.json found");
  });

  it("doctor schickt nach einem gelaufenen init NICHT zurueck zu init — die Schleife ist zu", async () => {
    await invoke(["init", "--offline"]);
    const doctor = await invoke(["doctor", "--skip-embeddings", "--timeout=1500"]);
    const everything = `${doctor.io.outText}\n${doctor.io.errText}`;

    // Jede Zeile, die einen naechsten Schritt nennt, wird geprueft: keiner
    // von ihnen darf `untangle init` sein, denn `untangle init` ist gerade
    // gelaufen und hat getan, was es tun sollte.
    const nextSteps = everything
      .split("\n")
      .filter((entry) => entry.includes("-> ") || entry.startsWith("Naechster Schritt:"));
    expect(nextSteps.length).toBeGreaterThan(0);
    for (const step of nextSteps) {
      expect(step, `dieser naechste Schritt fuehrt in die Schleife: ${step}`).not.toMatch(
        /`untangle init`(?! --force)/u,
      );
    }
  });

  it("ohne jede Konfiguration sagt doctor das — und DANN ist `untangle init` der richtige Rat", async () => {
    const doctor = await invoke(["doctor", "--skip-embeddings", "--timeout=1500"]);
    const output = doctor.io.outText;
    expect(output).toContain("No project configuration found");
    expect(output).toContain("untangle init");
  });

  it("doctor liest die Werte aus untangle.toml, nicht nur ihren Pfad", async () => {
    await invoke(["init", "--offline"]);
    const configPath = path.join(projectRoot, "untangle.toml");
    const before = readFileSync(configPath, "utf8");
    // Ein Wert, den nur die TOML-Datei setzen kann.
    writeFileSync(configPath, before.replace(/^dimensions = \d+$/mu, "dimensions = 4711"), "utf8");
    expect(readFileSync(configPath, "utf8")).toContain("dimensions = 4711");

    const doctor = await invoke(["doctor", "--skip-embeddings", "--timeout=1500", "--format=json"]);
    const report = JSON.parse(doctor.io.outText) as {
      checks: { id: string; facts?: Record<string, unknown> }[];
    };
    const config = report.checks.find((check) => check.id === "config");
    expect(config?.facts?.["tomlConfig"]).toBe(configPath);
    // Die geaenderte Dimensionszahl faellt in die Profil-ID ein; waere die
    // Datei ungelesen, waere sie identisch mit der aus dem ersten Lauf.
    expect(String(config?.facts?.["embeddingProfileId"] ?? "")).toHaveLength(64);
  });

  it("doctor meldet den fremden Standardport NICHT mehr als in Ordnung (WP-222 b, am ganzen Befehl)", async () => {
    await invoke(["init", "--offline", "--storage=qdrant"]);
    const doctor = await invoke(["doctor", "--skip-embeddings", "--timeout=1500", "--format=json"]);
    const report = JSON.parse(doctor.io.outText) as {
      checks: { id: string; status: string; detail: string; facts?: Record<string, unknown> }[];
    };
    const qdrant = report.checks.find((check) => check.id === "qdrant");
    expect(qdrant).toBeDefined();
    // Egal, ob dort etwas laeuft oder nicht: 6333 kommt in diesem Bericht
    // nicht vor, weil `doctor` diese Adresse gar nicht erst benutzt.
    expect(JSON.stringify(qdrant)).not.toContain(":6333");
    expect(JSON.stringify(qdrant)).toContain(":16333");
  });
});
