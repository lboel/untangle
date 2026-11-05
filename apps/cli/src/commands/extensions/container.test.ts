/**
 * Die Besitzprobe — der Teil, bei dem ein Fehler fremde Arbeit zerstoert.
 *
 * Auf einer Entwicklermaschine laufen fremde Container. Ein Werkzeug, das nach
 * dem NAMEN greift, findet irgendwann den falschen: `untangle-ext-<id>` ist
 * vorhersagbar, und niemand hindert einen anderen daran, so zu heissen.
 * `down` und `logs` verlangen deshalb BEIDE Labels aus extensions.md §8.2,
 * bevor sie irgendetwas anfassen.
 *
 * Kein Test hier startet einen Container: die Prozessgrenze ist ein Fake, der
 * die Aufrufe aufzeichnet.
 */
import type { ExtensionManifestV1 } from "@untangle-code/domain";
import type { ProcessInvocationV1, ProcessResultV1 } from "@untangle-code/extension-runtime";
import { defaultProcessLimits, parseExtensionManifest } from "@untangle-code/extension-runtime";
import { describe, expect, it } from "vitest";

import { containerNameFor, createContainerCli } from "./container.js";
import { containerManifest } from "./test-support.js";

const PINNED = `sha256:${"ab".repeat(32)}`;

function manifest(): ExtensionManifestV1 {
  const parsed = parseExtensionManifest(containerManifest({ id: "probe", digest: PINNED }));
  if (parsed.manifest === null) {
    throw new Error(`fixture invalid: ${JSON.stringify(parsed.issues)}`);
  }
  return parsed.manifest;
}

function completed(stdout: string, exitCode = 0): ProcessResultV1 {
  return {
    outcome: "completed",
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    stdoutBytes: stdout.length,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    wallTimeMs: 3,
  };
}

/** Antwortet je Unterbefehl; zeichnet jeden Aufruf auf. */
function fakeCli(answers: Record<string, ProcessResultV1>) {
  const calls: ProcessInvocationV1[] = [];
  return {
    calls,
    port: createContainerCli({
      processRunner: {
        run(invocation) {
          calls.push(invocation);
          const key = invocation.args
            .filter((arg) => !arg.startsWith("-") && !arg.includes("/"))
            .join(" ");
          const match = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
          return Promise.resolve(match?.[1] ?? completed("", 1));
        },
      },
      limits: defaultProcessLimits(),
      command: "container-cli",
    }),
  };
}

/** Zeile, wie `inspect --format` sie liefert: managed, id, running, image. */
function inspectLine(managed: string, id: string, running: string, image: string): string {
  return `${managed}\t${id}\t${running}\t${image}\n`;
}

const OURS = inspectLine(
  "true",
  "probe",
  "true",
  `registry.example.invalid/example-analyzer@${PINNED}`,
);
const FOREIGN = inspectLine("<no value>", "<no value>", "true", "someone-else/image:latest");

describe("inspect", () => {
  it("liest Digest und Zustand des eigenen Containers", async () => {
    const cli = fakeCli({ inspect: completed(OURS) });
    const state = await cli.port.inspect(manifest());

    expect(state.exists).toBe(true);
    expect(state.running).toBe(true);
    expect(state.ownedByUntangle).toBe(true);
    expect(state.imageDigest).toBe(PINNED);
  });

  it("erklaert einen Container gleichen Namens ohne Labels fuer FREMD", async () => {
    const cli = fakeCli({ inspect: completed(FOREIGN) });
    const state = await cli.port.inspect(manifest());

    expect(state.exists).toBe(true);
    expect(state.ownedByUntangle).toBe(false);
    expect(state.imageDigest).toBeUndefined();
    expect(state.detail).toContain("does not touch containers it did not create");
  });

  it("meldet einen fehlenden Container als fehlend, nicht als Fehler", async () => {
    const cli = fakeCli({ inspect: completed("", 1) });
    const state = await cli.port.inspect(manifest());
    expect(state.exists).toBe(false);
    expect(state.detail).toContain(containerNameFor("probe"));
  });
});

describe("down und logs fassen nichts Fremdes an", () => {
  it("bricht `down` ab, sobald der Container nicht Untangle gehoert", async () => {
    const cli = fakeCli({ inspect: completed(FOREIGN), compose: completed("") });
    const result = await cli.port.down({
      manifest: manifest(),
      composeFilePath: "/tmp/compose.yaml",
      removeVolumes: true,
    });

    expect(result.ok).toBe(false);
    // Entscheidend: es wurde KEIN compose-Aufruf abgesetzt.
    expect(cli.calls.map((call) => call.args[0])).toEqual(["inspect"]);
  });

  it("bricht `logs` ebenso ab", async () => {
    const cli = fakeCli({ inspect: completed(FOREIGN), compose: completed("") });
    const result = await cli.port.logs({
      manifest: manifest(),
      composeFilePath: "/tmp/compose.yaml",
      tail: 50,
    });

    expect(result.ok).toBe(false);
    expect(cli.calls.map((call) => call.args[0])).toEqual(["inspect"]);
  });

  it("startet nicht neben einem fremden Container gleichen Namens", async () => {
    const cli = fakeCli({ inspect: completed(FOREIGN), compose: completed("") });
    const result = await cli.port.up({
      manifest: manifest(),
      composeFilePath: "/tmp/compose.yaml",
    });

    expect(result.ok).toBe(false);
    expect(cli.calls.map((call) => call.args[0])).toEqual(["inspect"]);
  });

  it("entfernt Volumes nur auf ausdrueckliche Anweisung", async () => {
    const cli = fakeCli({ inspect: completed(OURS), compose: completed("") });
    await cli.port.down({
      manifest: manifest(),
      composeFilePath: "/tmp/compose.yaml",
      removeVolumes: false,
    });
    const withoutVolumes = cli.calls.at(-1)?.args ?? [];
    expect(withoutVolumes).not.toContain("--volumes");

    const second = fakeCli({ inspect: completed(OURS), compose: completed("") });
    await second.port.down({
      manifest: manifest(),
      composeFilePath: "/tmp/compose.yaml",
      removeVolumes: true,
    });
    expect(second.calls.at(-1)?.args ?? []).toContain("--volumes");
  });
});

describe("available", () => {
  it("nennt den Grund, wenn keine Runtime antwortet — und rät nicht", async () => {
    const cli = fakeCli({ version: completed("", 127) });
    const runtime = await cli.port.available();
    expect(runtime.available).toBe(false);
    expect(runtime.detail).toContain("UNTANGLE_CONTAINER_CLI");
  });
});
