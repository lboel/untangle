/**
 * Die ganze Kette an einer echten Werkzeugausgabe: flaches Objekt → Messwerte
 * → Bedeutung → Evidenz.
 *
 * Die Ausgabe unten ist die tatsaechliche Form, in der ein Struktur-Analysator
 * seine Zahlen schreibt (hier mit Platzhalternamen, E2). Vor Welle 11 ergab sie
 * NULL Messwerte und genau einen Hinweis: der Parser kannte nur Eintragslisten,
 * und die Lesehilfe war von keinem Manifest aus erreichbar.
 */
import { describe, expect, it } from "vitest";

import { evaluateLicenseGate } from "./license-gate.js";
import type { LoadedExtensionV1 } from "./manifest/load.js";
import { parseExtensionManifest } from "./manifest/shape.js";
import { createLineOffsetResolver } from "./positions.js";
import type { ProcessResultV1, ProcessRunnerPort } from "./process/types.js";
import { defaultProcessLimits } from "./process/types.js";
import { runExtension } from "./runtime.js";
import { countingRandom, fixedClock, readFixture } from "./test-support/fixtures.js";
import type { ExtensionHealthV1 } from "./types.js";

const MANIFEST = readFixture("manifests/metrics-flat.manifest.toml");

/** Wortgleiche Form einer echten Baseline-Ausgabe. */
const OUTPUT = JSON.stringify({
  timestamp: 1788794829.434848,
  quality_signal: 0.4514569553927475,
  coupling_score: 0.01380897583429229,
  cycle_count: 3,
  god_file_count: 2,
  hotspot_count: 0,
  complex_fn_count: 88,
  max_depth: 28,
  total_import_edges: 2607,
  cross_module_edges: 620,
});

function loaded(): LoadedExtensionV1 {
  const parsed = parseExtensionManifest(MANIFEST);
  if (parsed.manifest === null) {
    throw new Error(`fixture manifest is invalid: ${JSON.stringify(parsed.issues)}`);
  }
  return {
    manifest: parsed.manifest,
    origin: "user-data-dir",
    manifestPath: "/home/dev/.untangle/extensions/metrics-flat/manifest.toml",
    manifestSha256: "0".repeat(64),
  };
}

function runner(stdout: string): ProcessRunnerPort {
  const result: ProcessResultV1 = {
    outcome: "completed",
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutBytes: stdout.length,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    wallTimeMs: 9,
  };
  return { run: () => Promise.resolve(result) };
}

function health(): ExtensionHealthV1 {
  return {
    schemaVersion: 1,
    extensionId: "metrics-flat",
    checkedAt: "2026-09-07T00:00:00.000Z",
    available: true,
    effectiveInvocation: "binary",
    toolVersion: "0.5.7",
    licenseGate: "not_required",
    unavailableReasons: [],
  };
}

async function run() {
  const extension = loaded();
  return await runExtension(
    {
      clock: fixedClock(1_767_225_600_000, 7),
      random: countingRandom(),
      processRunner: runner(OUTPUT),
    },
    {
      extension,
      health: health(),
      gate: evaluateLicenseGate({ extension, acknowledgments: [] }),
      workspaceId: "ws-1",
      repoId: "repo-1",
      refId: "ref-1",
      workspacePath: "/work/repo",
      resolveFile: (path: string) => ({ relativePath: path, fileId: `file-${path}` }),
      resolvePosition: createLineOffsetResolver(new Map()),
      limits: defaultProcessLimits(),
    },
  );
}

describe("flache Kennzahlausgabe durch die ganze Kette", () => {
  it("liest alle zehn Zahlen statt keiner", async () => {
    const result = await run();
    expect(result.run.exitStatus).toBe("completed");
    expect(result.measurements).toHaveLength(10);
  });

  it("gibt genau den drei deklarierten Schluesseln eine Bedeutung", async () => {
    const result = await run();
    const named = result.measurements.filter((m) => m.signal !== undefined);
    expect(named.map((m) => m.key).sort()).toEqual(["cycle_count", "max_depth", "quality_signal"]);
  });

  it("laesst den Mischwert ausdruecklich unvergleichbar", async () => {
    const result = await run();
    const composite = result.measurements.find((m) => m.key === "quality_signal");
    expect(composite?.signal?.kind).toBe("proprietary-composite");
    expect(composite?.signal?.comparableTo).toBeUndefined();
  });

  it("oeffnet die Gegenprobe nur fuer die definiert gleichen Groessen", async () => {
    const result = await run();
    const comparable = result.measurements.filter((m) => m.signal?.comparableTo !== undefined);
    expect(comparable.map((m) => m.key).sort()).toEqual(["cycle_count", "max_depth"]);
  });

  it("haelt jeden Wert als Evidenz, nie als Untangle-Metrik (X3)", async () => {
    const result = await run();
    for (const measurement of result.measurements) {
      expect(measurement.evidenceOnly).toBe(true);
      // Der Marker macht die Trennung strukturell: der Wert passt an keine
      // Stelle, an der eine Untangle-Metrik (`number`) erwartet wird.
      expect(measurement.value.externalMeasurement).toBe(true);
      expect(typeof (measurement.value as unknown as { value: unknown }).value).toBe("number");
    }
  });

  it("laesst den Zeitstempel ohne Bedeutung durchlaufen, ohne ihn zu verlieren", async () => {
    const result = await run();
    const timestamp = result.measurements.find((m) => m.key === "timestamp");
    expect(timestamp).toBeDefined();
    expect(timestamp?.signal).toBeUndefined();
  });
});
