import { describe, expect, it } from "vitest";

import { fixedClock } from "../test-support/fixtures.js";

import { createNodeProcessRunner } from "./node-runner.js";
import { defaultProcessLimits, isLoopbackUrl, redactSecrets } from "./types.js";

/**
 * Die Tests starten `process.execPath` (Node selbst) mit `-e`. Damit brauchen
 * sie kein installiertes Werkzeug, kein Netz und keinen Container
 * (extensions.md §13) — und pruefen trotzdem einen ECHTEN Unterprozess.
 */
const runner = createNodeProcessRunner(fixedClock(0, 5));
const limits = { ...defaultProcessLimits(), timeoutMs: 5_000 };

describe("createNodeProcessRunner", () => {
  it("startet ein Programm mit Argumentarray und sammelt stdout", async () => {
    const result = await runner.run(
      { command: process.execPath, args: ["-e", "process.stdout.write('hello')"] },
      limits,
    );
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stdoutTruncated).toBe(false);
  });

  it("uebergibt Argumente ohne Shell-Interpretation (X4)", async () => {
    // Waere `shell: true` gesetzt, wuerde `$(id)` ausgefuehrt. So bleibt es
    // ein gewoehnlicher String.
    const result = await runner.run(
      {
        command: process.execPath,
        args: ["-e", "process.stdout.write(process.argv[1])", "$(id); rm -rf /"],
      },
      limits,
    );
    expect(result.stdout).toBe("$(id); rm -rf /");
  });

  it("meldet einen von Null verschiedenen Exit-Status, ohne zu werfen", async () => {
    const result = await runner.run(
      { command: process.execPath, args: ["-e", "process.stderr.write('boom'); process.exit(3)"] },
      limits,
    );
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("boom");
  });

  it("liefert spawn_failed statt zu werfen, wenn das Programm fehlt (X2)", async () => {
    const result = await runner.run(
      { command: "untangle-nonexistent-program-for-tests", args: [] },
      limits,
    );
    expect(result.outcome).toBe("spawn_failed");
    expect(result.failureDetail).toBeDefined();
    expect(result.failureDetail).not.toBe("");
  });

  it("bricht bei Ueberschreiten des Zeitbudgets ab", async () => {
    const result = await runner.run(
      { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] },
      { ...limits, timeoutMs: 150, killGraceMs: 200 },
    );
    expect(result.outcome).toBe("timeout");
    expect(result.failureDetail).toContain("time budget");
  });

  it("begrenzt die Ausgabegroesse und meldet die Kuerzung (E4)", async () => {
    const result = await runner.run(
      {
        command: process.execPath,
        args: ["-e", "for (let i = 0; i < 5000; i += 1) process.stdout.write('x'.repeat(1000));"],
      },
      { ...limits, maxOutputBytes: 4096, killGraceMs: 200 },
    );
    expect(result.outcome).toBe("output_limit_exceeded");
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(4096);
    expect(result.failureDetail).toContain("output exceeded the limit");
  });

  it("bricht ueber ein AbortSignal ab", async () => {
    const controller = new AbortController();
    const pending = runner.run(
      { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] },
      { ...limits, killGraceMs: 200 },
      { signal: controller.signal },
    );
    controller.abort();
    const result = await pending;
    expect(result.outcome).toBe("cancelled");
  });

  it("startet gar nicht, wenn das Signal bereits abgebrochen ist", async () => {
    const result = await runner.run(
      { command: process.execPath, args: ["-e", "process.stdout.write('nope')"] },
      limits,
      { signal: AbortSignal.abort() },
    );
    expect(result.outcome).toBe("cancelled");
    expect(result.stdout).toBe("");
  });

  it("reicht stdin durch", async () => {
    const result = await runner.run(
      {
        command: process.execPath,
        args: [
          "-e",
          "let d=''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => process.stdout.write(d.toUpperCase()));",
        ],
        stdin: "payload",
      },
      limits,
    );
    expect(result.stdout).toBe("PAYLOAD");
  });
});

describe("redactSecrets", () => {
  it("ersetzt jeden Geheimniswert", () => {
    expect(redactSecrets("token=abc123 in the log", ["abc123"])).toBe("token=*** in the log");
  });

  it("ignoriert leere Werte", () => {
    expect(redactSecrets("unchanged", [""])).toBe("unchanged");
  });
});

describe("isLoopbackUrl", () => {
  it("erkennt Loopback-Endpunkte", () => {
    expect(isLoopbackUrl("http://127.0.0.1:19000/api")).toBe(true);
    expect(isLoopbackUrl("http://localhost:19000")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:19000")).toBe(true);
  });

  it("weist alles andere zurueck", () => {
    expect(isLoopbackUrl("https://analyzer.example.invalid")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});
