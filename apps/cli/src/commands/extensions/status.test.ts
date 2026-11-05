/**
 * `untangle extensions status` — the read-only view of the two things B29 is
 * about: the license gate and the pinned image digest.
 *
 * Both were enforced before this command existed, but only at the moment of a
 * run. A guarantee nobody can look at is hard to trust and easy to break
 * unnoticed; `status` is where the pin and the gate become inspectable
 * without starting anything.
 *
 * Every test runs against a temporary profile. No socket, no container, no
 * spawned analyzer — the HTTP path goes through an injected `fetch`.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseArgs, type FlagSpecs } from "../../cli/args.js";
import { CliError, EXIT } from "../../cli/exit.js";
import { extensionsCommand } from "../extensions.js";

import { runAdd } from "./add.js";
import { runDisable, runEnable } from "./enable.js";
import { runStatus } from "./status.js";
import {
  containerManifest,
  createHarness,
  fakeFetch,
  httpManifest,
  writeFixture,
  type HarnessV1,
} from "./test-support.js";

const FLAGS: FlagSpecs = extensionsCommand.spec.flags;
const PINNED = `sha256:${"ab".repeat(32)}`;

function args(argv: readonly string[]): ReturnType<typeof parseArgs> {
  return parseArgs(argv, FLAGS);
}

async function install(harness: HarnessV1, id: string, manifest: string): Promise<void> {
  const path = await writeFixture(join(harness.home, "sources", id, "manifest.toml"), manifest);
  const code = await runAdd(
    harness.environment,
    args(["add", `--from=${path}`]),
    harness.io,
    "json",
  );
  expect(code).toBe(EXIT.ok);
  harness.io.stdout.length = 0;
}

function payload(harness: HarnessV1): Record<string, unknown> {
  return JSON.parse(harness.io.outText) as Record<string, unknown>;
}

interface StatusRow {
  id: string;
  enabled: boolean;
  license: {
    spdxId: string;
    usageRestriction: string;
    gate: {
      allowed: boolean;
      tool: { status: string; reason: string };
      acknowledgeCommands: string[];
    };
  };
  pin: { image: string; digest: string } | null;
  health: {
    available: boolean;
    licenseGate: string;
    endpoint?: string;
    imageDigest?: string;
    digestMatchesManifest?: boolean;
    unavailableReasons: { invocation: string; detail: string }[];
  };
  missingSecrets: string[];
}

function rows(harness: HarnessV1): StatusRow[] {
  return payload(harness)["extensions"] as unknown as StatusRow[];
}

describe("extensions status — the pinned digest is visible", () => {
  it("reports the manifest pin for a container extension", async () => {
    const harness = await createHarness();
    await install(harness, "pinned", containerManifest({ id: "pinned", digest: PINNED }));

    const code = await runStatus(harness.environment, args(["status"]), harness.io, "json");

    expect(code).toBe(EXIT.ok);
    const [row] = rows(harness);
    expect(row?.id).toBe("pinned");
    expect(row?.pin).toEqual({
      image: "registry.example.invalid/example-analyzer",
      digest: PINNED,
    });
  });

  it("nennt den Grund, warum kein laufender Digest verglichen werden konnte", async () => {
    const harness = await createHarness();
    await install(harness, "pinned", containerManifest({ id: "pinned", digest: PINNED }));

    await runStatus(harness.environment, args(["status", "pinned"]), harness.io, "json");

    const [row] = rows(harness);
    // Kein Container dieser Extension existiert — also gibt es nichts zu
    // vergleichen. Das ist eine andere Aussage als „stimmt nicht ueberein",
    // und beide sind andere Aussagen als ein leeres Feld (E4). Ob die Runtime
    // ueberhaupt erreichbar ist, entscheidet die Maschine, auf der das laeuft;
    // beide Gruende sind zulaessig, ein stiller ist es nicht.
    expect(row?.health.imageDigest).toBeUndefined();
    expect(row?.health.digestMatchesManifest).toBeUndefined();
    expect(row?.health.available).toBe(false);
    const detail = row?.health.unavailableReasons[0]?.detail ?? "";
    expect(detail === "" ? "(leer)" : detail).toMatch(
      /no container named|no container runtime answered/,
    );
  });

  it("leaves `pin` null for an extension that is not container-invoked", async () => {
    const harness = await createHarness();
    await install(harness, "example-http", httpManifest({ id: "example-http", port: 19999 }));

    await runStatus(harness.environment, args(["status"]), harness.io, "json", {
      fetchImpl: fakeFetch(200, "{}"),
    });

    expect(rows(harness)[0]?.pin).toBeNull();
  });
});

describe("extensions status — the license gate is visible and binding", () => {
  it("probes nothing while the gate is open (X5)", async () => {
    const harness = await createHarness();
    await install(
      harness,
      "restricted-http",
      httpManifest({ id: "restricted-http", port: 19999, restricted: true }),
    );

    let calls = 0;
    const countingFetch = ((...rest: unknown[]) => {
      calls += 1;
      return (fakeFetch(200, "{}") as unknown as (...a: unknown[]) => Promise<unknown>)(...rest);
    }) as unknown as typeof fetch;

    const code = await runStatus(
      harness.environment,
      args(["status", "restricted-http"]),
      harness.io,
      "json",
      { fetchImpl: countingFetch },
    );

    expect(code).toBe(EXIT.ok);
    expect(calls).toBe(0);
    const [row] = rows(harness);
    expect(row?.health.licenseGate).toBe("unacknowledged");
    expect(row?.license.gate.allowed).toBe(false);
    expect(row?.health.available).toBe(false);
    expect(row?.health.endpoint).toBeUndefined();
  });

  it("probes the endpoint once the gate is acknowledged", async () => {
    const harness = await createHarness();
    await install(
      harness,
      "restricted-http",
      httpManifest({ id: "restricted-http", port: 19999, restricted: true }),
    );
    await runEnable(
      harness.environment,
      args(["enable", "restricted-http", "--acknowledge-license"]),
      harness.io,
      "json",
    );
    harness.io.stdout.length = 0;

    await runStatus(harness.environment, args(["status", "restricted-http"]), harness.io, "json", {
      fetchImpl: fakeFetch(200, "{}"),
    });

    const [row] = rows(harness);
    expect(row?.enabled).toBe(true);
    expect(row?.health.licenseGate).toBe("acknowledged");
    expect(row?.health.available).toBe(true);
    expect(row?.health.endpoint).toBe("http://127.0.0.1:19999");
  });
});

describe("extensions status — nothing vanishes without a reason (E4)", () => {
  it("explains an id that is not installed instead of printing an empty report", async () => {
    const harness = await createHarness();

    let error: CliError | undefined;
    try {
      await runStatus(harness.environment, args(["status", "absent"]), harness.io, "json");
    } catch (caught) {
      error = caught as CliError;
    }

    expect(error).toBeInstanceOf(CliError);
    expect(error?.message).toContain("absent");
  });

  it("carries the roots it searched even when nothing is installed", async () => {
    const harness = await createHarness();

    const code = await runStatus(harness.environment, args(["status"]), harness.io, "json");

    expect(code).toBe(EXIT.ok);
    expect(rows(harness)).toEqual([]);
    expect((payload(harness)["rootsScanned"] as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("extensions status — a withdrawn declaration stays a withdrawal (§9.3)", () => {
  it("reports `revoked`, not `unacknowledged`, after --revoke-license", async () => {
    const harness = await createHarness();
    await install(
      harness,
      "restricted-http",
      httpManifest({ id: "restricted-http", port: 19999, restricted: true }),
    );
    await runEnable(
      harness.environment,
      args(["enable", "restricted-http", "--acknowledge-license"]),
      harness.io,
      "json",
    );
    await runDisable(
      harness.environment,
      args(["disable", "restricted-http", "--revoke-license"]),
      harness.io,
      "json",
    );
    harness.io.stdout.length = 0;

    let calls = 0;
    const countingFetch = ((...rest: unknown[]) => {
      calls += 1;
      return (fakeFetch(200, "{}") as unknown as (...a: unknown[]) => Promise<unknown>)(...rest);
    }) as unknown as typeof fetch;

    await runStatus(harness.environment, args(["status", "restricted-http"]), harness.io, "json", {
      fetchImpl: countingFetch,
    });

    const [row] = rows(harness);
    // The difference matters: "never acknowledged" and "acknowledged, then
    // taken back" are different facts about the same user, and the spec asks
    // status to be able to show the second one.
    expect(row?.health.licenseGate).toBe("revoked");
    expect(row?.license.gate.tool.reason).toContain("revoked");
    expect(row?.license.gate.allowed).toBe(false);
    // A revocation is as binding as a missing acknowledgment: still no probe.
    expect(calls).toBe(0);
    expect(row?.license.gate.acknowledgeCommands).toContain(
      "untangle extensions enable restricted-http --acknowledge-license",
    );
  });
});

describe("extensions disable — ein abgelehnter Aufruf hat nichts getan", () => {
  it("deaktiviert nicht, wenn die Flag-Kombination zurueckgewiesen wird", async () => {
    const harness = await createHarness();
    await install(harness, "pinned", containerManifest({ id: "pinned", digest: PINNED }));
    await runEnable(harness.environment, args(["enable", "pinned"]), harness.io, "json");
    harness.io.stdout.length = 0;

    // `--remove-volumes` ohne `--remove-container` ist ein Aufruffehler. Vor
    // Welle 12 lag die Pruefung NACH dem Schreiben des Zustands: die Extension
    // war deaktiviert, und die Fehlermeldung sagte das Gegenteil.
    let threw = false;
    try {
      await runDisable(
        harness.environment,
        args(["disable", "pinned", "--remove-volumes"]),
        harness.io,
        "json",
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    harness.io.stdout.length = 0;
    await runStatus(harness.environment, args(["status", "pinned"]), harness.io, "json");
    expect(rows(harness)[0]?.enabled).toBe(true);
  });
});
