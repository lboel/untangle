/**
 * Regression fuer WP-215 (32-KiB-Puffergrenze) und WP-216 (benannter Grund
 * statt durchgereichtem Bibliothekstext).
 *
 * Der Test parst eine ECHTE Datei ueber 32 KiB mit dem ECHTEN Adapter. Ein
 * handgebauter Knotenstumpf wuerde nur beweisen, dass der Stumpf tut, was der
 * Test sich ausgedacht hat — nicht, dass die native Bindung die Datei
 * annimmt (docs/BUILD_PLAN.md E5).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AdapterParseError,
  classifyAdapterFailure,
  isAdapterParseError,
  type SourceFile,
} from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { createTypeScriptAdapter } from "../typescript/index.js";

import {
  MAX_PARSE_SOURCE_BYTES,
  NATIVE_DEFAULT_BUFFER_BYTES,
  parseBufferSizeFor,
  sourceByteLength,
} from "./parse-limits.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("./__fixtures__/large-over-32kib.ts.txt", import.meta.url),
);

function sourceOf(content: string, path = "fixture.ts"): SourceFile {
  return {
    fileId: path,
    repoId: "test",
    refId: "test:working-tree",
    path,
    languageId: "typescript",
    content,
    contentHash: "0".repeat(64),
    sizeBytes: sourceByteLength(content),
  };
}

describe("WP-215: Dateien ueber der nativen 32-KiB-Puffergrenze", () => {
  const fixture = readFileSync(FIXTURE_PATH, "utf8");

  it("die Fixture ist wirklich groesser als der Vorgabepuffer der Bindung", () => {
    // Ohne diese Zusicherung koennte die Fixture unbemerkt unter die Grenze
    // schrumpfen und der Regressionstest waere still wertlos.
    expect(NATIVE_DEFAULT_BUFFER_BYTES).toBe(32 * 1024);
    expect(sourceByteLength(fixture)).toBeGreaterThan(NATIVE_DEFAULT_BUFFER_BYTES);
  });

  it("parst eine Datei ueber 32 KiB vollstaendig, statt zu werfen", () => {
    const adapter = createTypeScriptAdapter();
    const result = adapter.parse(sourceOf(fixture, "large.ts"));

    expect(result.parseQuality).toBe("complete");
    expect(result.ast).not.toBeNull();
    expect(result.errorNodeCount).toBe(0);
    expect(result.missingNodeCount).toBe(0);

    // Und der Baum traegt wirklich Inhalt — nicht nur "hat nicht geworfen".
    const symbols = adapter.extractSymbols(result.ast as NonNullable<typeof result.ast>);
    expect(symbols.length).toBeGreaterThan(50);
    expect(symbols.some((symbol) => symbol.name === "readingOf0")).toBe(true);
  });

  it("waechst der Puffer mit der Eingabe und faellt nie unter die native Vorgabe", () => {
    expect(parseBufferSizeFor(0)).toBe(NATIVE_DEFAULT_BUFFER_BYTES);
    expect(parseBufferSizeFor(NATIVE_DEFAULT_BUFFER_BYTES)).toBeGreaterThan(
      NATIVE_DEFAULT_BUFFER_BYTES,
    );
    expect(parseBufferSizeFor(1_000_000)).toBeGreaterThanOrEqual(1_000_000);
    expect(parseBufferSizeFor(2_000_000)).toBeGreaterThan(parseBufferSizeFor(1_000_000));
  });

  it("weist eine Datei ueber der gemessenen Obergrenze mit benanntem Grund UND Groesse ab", () => {
    const adapter = createTypeScriptAdapter();
    // Ein Zeichen pro Byte, damit die gemeldete Groesse nachrechenbar ist.
    const oversized = "a".repeat(MAX_PARSE_SOURCE_BYTES + 1);

    let thrown: unknown;
    try {
      adapter.parse(sourceOf(oversized, "oversized.ts"));
    } catch (error) {
      thrown = error;
    }

    expect(isAdapterParseError(thrown)).toBe(true);
    const failure = classifyAdapterFailure(thrown);
    expect(failure.kind).toBe("file_too_large");
    expect(failure.reason).toBe("file_too_large");
    expect(failure.recoverable).toBe(false);
    // Der Grund ist ohne die GEMESSENE Groesse wertlos (E4).
    expect(failure.measurements["sizeBytes"]).toBe(MAX_PARSE_SOURCE_BYTES + 1);
    expect(failure.measurements["limitBytes"]).toBe(MAX_PARSE_SOURCE_BYTES);
    expect(failure.detail).toContain(String(MAX_PARSE_SOURCE_BYTES + 1));
  });

  it("die Obergrenze liegt ueber der Vorgabegrenze des Scanners", () => {
    // Sonst waere der Parser bei Standardkonfiguration die engere,
    // unausgesprochene Grenze — siehe Modulkopf von `parse-limits.ts`.
    expect(MAX_PARSE_SOURCE_BYTES).toBeGreaterThan(5 * 1024 * 1024);
  });
});

describe("WP-216: jede Adapterausnahme bekommt einen benannten Grund", () => {
  it('"Invalid argument" wird zu parser_buffer_exhausted, nicht durchgereicht', () => {
    const failure = classifyAdapterFailure(new Error("Invalid argument"), { sizeBytes: 33_871 });

    expect(failure.kind).toBe("parser_buffer_exhausted");
    expect(failure.reason).toBe("parse_failed");
    expect(failure.measurements["sizeBytes"]).toBe(33_871);
    // Der Rohtext ueberlebt als Anhang — aber er ist NICHT mehr der Grund.
    expect(failure.detail).not.toBe("Invalid argument");
    expect(failure.detail.startsWith("parser_buffer_exhausted:")).toBe(true);
    expect(failure.detail).toContain("Invalid argument");
    expect(failure.detail).toContain("input buffer");
  });

  it("eine fehlende Grammatik ist provider_unavailable und wiederholbar", () => {
    const error = Object.assign(new Error("Cannot find module 'tree-sitter-typescript'"), {
      code: "MODULE_NOT_FOUND",
    });
    const failure = classifyAdapterFailure(error);

    expect(failure.kind).toBe("grammar_unavailable");
    expect(failure.reason).toBe("provider_unavailable");
    expect(failure.recoverable).toBe(true);
  });

  it("ein geworfener Nicht-Error bleibt auswertbar, statt als Text zu enden", () => {
    const failure = classifyAdapterFailure({ nope: true });

    expect(failure.kind).toBe("unknown_adapter_failure");
    expect(failure.reason).toBe("parse_failed");
  });

  it("eine unbekannte Ausnahme wird parser_internal_error, nie ein roher Text", () => {
    const failure = classifyAdapterFailure(new Error("something oddly specific happened"));

    expect(failure.kind).toBe("parser_internal_error");
    expect(failure.reason).toBe("parse_failed");
    expect(failure.detail).not.toBe("something oddly specific happened");
    expect(failure.rawMessage).toBe("something oddly specific happened");
  });

  it("ist deterministisch: gleiche Eingabe, gleicher Detailtext", () => {
    const first = classifyAdapterFailure(new Error("Invalid argument"), { sizeBytes: 40_000 });
    const second = classifyAdapterFailure(new Error("Invalid argument"), { sizeBytes: 40_000 });
    expect(first.detail).toBe(second.detail);
  });
});

describe("WP-216: der Grund wird nicht doppelt eingewickelt", () => {
  it("ein Adapterfehler traegt den ROHEN Ausnahmetext, nicht ein zweites Detail", () => {
    // Regression: `parseWithBuffer` reichte frueher `failure.detail` als
    // Ausnahmetext weiter. Der Aufrufer klassifizierte erneut und der
    // Ledger-Eintrag enthielt die Erlaeuterung ZWEIMAL, ineinander
    // geschachtelt — lesbar war er damit nicht mehr.
    const inner = new AdapterParseError("parser_buffer_exhausted", "Invalid argument", {
      measurements: { sizeBytes: 33_871, bufferSize: 42_339 },
    });
    const failure = classifyAdapterFailure(inner);

    expect(failure.kind).toBe("parser_buffer_exhausted");
    expect(failure.rawMessage).toBe("Invalid argument");
    // Genau EIN "(exception text: " im fertigen Detail.
    expect(failure.detail.split("(exception text: ").length - 1).toBe(1);
    expect(failure.detail.split("parser_buffer_exhausted").length - 1).toBe(1);
    expect(failure.measurements["bufferSize"]).toBe(42_339);
  });
});
