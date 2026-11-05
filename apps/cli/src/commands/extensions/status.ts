/**
 * `untangle extensions status [<id>]`
 *
 * The read-only view of the two promises B29 makes: every extension runs
 * behind a license gate, and every container image is pinned to a complete
 * digest. Both were already enforced — the gate before any process start, the
 * pin as a validation rule and as `EXTENSION_IMAGE_MISMATCH` at run time —
 * but only ever at the moment of a run. A guarantee nobody can inspect is
 * hard to trust and easy to break unnoticed, so this command shows the pin
 * the runtime would enforce, the gate that stands in front of it, the
 * endpoint that would be contacted, and what the last run did.
 *
 * What it does NOT do is start anything the gate has not cleared. `detect`
 * looks harmless but is not: a version query starts the foreign program, an
 * endpoint probe talks to the foreign service. The runtime therefore refuses
 * both while the gate is open (X5), and this command inherits that refusal
 * rather than re-implementing it. Containers are never started or pulled here
 * under any circumstances (X1); without a container runtime probe the running
 * digest is reported as unknown, with the reason, instead of being quietly
 * omitted (E4).
 *
 * Secrets never appear. Their VALUES are passed to the runtime only so it can
 * redact them from probe output; what the report shows is which required
 * secret is missing, by name and environment variable.
 */
import {
  buildHttpAuthHeaders,
  createFetchHttpRunner,
  createNodeProcessRunner,
  defaultProcessLimits,
  detectExtension,
  type ExtensionHealthV1,
  type LicenseGateDecisionV1,
  type LoadedExtensionV1,
} from "@untangle-code/extension-runtime";

import { type ParsedArgs } from "../../cli/args.js";
import { EXIT, OperationalError } from "../../cli/exit.js";
import { line, type Io } from "../../cli/io.js";

import { createContainerCli } from "./container.js";
import { explainMissing, findExtension, gateFor, loadExtensionContext } from "./context.js";
import type { ExtensionEnvironmentV1 } from "./environment.js";
import { emitJson, renderTable } from "./render.js";
import { resolveSecretEnvironment } from "./secret-store.js";
import type { LastRunRecordV1 } from "./state.js";

export interface StatusDeps {
  /** Injected in tests so no unit test opens a socket. */
  fetchImpl?: typeof fetch;
}

/** The manifest pin (X6) — `null` when the extension is not container-invoked. */
interface ImagePinV1 {
  image: string;
  digest: string;
}

interface StatusRowV1 {
  id: string;
  displayName: string;
  category: string;
  invocation: string[];
  enabled: boolean;
  license: {
    spdxId: string;
    usageRestriction: string;
    gate: LicenseGateDecisionV1;
  };
  pin: ImagePinV1 | null;
  health: ExtensionHealthV1;
  /** Required secrets that are not set here — reported, not fatal. */
  missingSecrets: string[];
  manifestPath: string;
  origin: string;
  lastRun?: LastRunRecordV1;
}

export async function runStatus(
  environment: ExtensionEnvironmentV1,
  args: ParsedArgs,
  io: Io,
  format: "text" | "json",
  deps: StatusDeps = {},
): Promise<number> {
  const context = await loadExtensionContext(environment);
  const wanted = args.positionals[1];

  let extensions: LoadedExtensionV1[];
  if (wanted === undefined) {
    extensions = [...context.discovery.extensions];
  } else {
    const found = findExtension(context, wanted);
    if (found === null) {
      throw new OperationalError(
        explainMissing(context, wanted),
        "Install it first: untangle extensions add --from=<path-or-url>",
      );
    }
    extensions = [found];
  }

  const clock = environment.clock;
  const processRunner = createNodeProcessRunner(clock);
  // Nur INSPIZIEREN, nie starten: `status` ist eine Leseoperation (X1). Der
  // laufende Digest ist damit erstmals wirklich beobachtet statt behauptet —
  // bis Welle 12 gab es keine Sonde, und der Abgleich gegen den Pin blieb
  // Vertragsevidenz.
  const containerCli = createContainerCli({
    processRunner,
    limits: { ...defaultProcessLimits(), timeoutMs: 20_000 },
    ...(environment.env["UNTANGLE_CONTAINER_CLI"] === undefined
      ? {}
      : { command: environment.env["UNTANGLE_CONTAINER_CLI"] }),
  });
  const runtimeDeps = {
    clock,
    random: environment.random,
    processRunner,
    httpRunner: createFetchHttpRunner(
      (deps.fetchImpl ?? fetch) as Parameters<typeof createFetchHttpRunner>[0],
      clock,
    ),
    containerProbe: async (
      extension: LoadedExtensionV1,
      probeOptions: { signal?: AbortSignal } = {},
    ) => {
      const runtime = await containerCli.available(probeOptions);
      if (!runtime.available) {
        return { available: false, detail: runtime.detail };
      }
      const state = await containerCli.inspect(extension.manifest, probeOptions);
      return {
        available: state.running && state.ownedByUntangle,
        ...(state.imageDigest === undefined ? {} : { imageDigest: state.imageDigest }),
        detail: state.detail,
      };
    },
  };

  const rows: StatusRowV1[] = [];
  for (const extension of extensions) {
    const manifest = extension.manifest;
    const gate = gateFor(context, extension);

    let effectiveEnv: Readonly<Record<string, string | undefined>> = environment.env;
    try {
      effectiveEnv = await resolveSecretEnvironment(environment, manifest);
    } catch (error) {
      context.warnings.push(
        `${manifest.id}: ${error instanceof Error ? error.message : "Cannot read credential configuration"}`,
      );
    }
    const secretValues: string[] = [];
    const missingSecrets: string[] = [];
    const secretEnv: Record<string, string> = {};
    for (const secret of manifest.secrets) {
      if (secret.setupOnly) continue;
      const value = effectiveEnv[secret.envVar];
      if (value === undefined || value === "") {
        if (secret.required) {
          missingSecrets.push(`${secret.name} (${secret.envVar})`);
        }
        continue;
      }
      secretEnv[secret.envVar] = value;
      secretValues.push(value);
    }

    const httpHeaders = buildHttpAuthHeaders(manifest, effectiveEnv);
    const health = await detectExtension(runtimeDeps, {
      extension,
      licenseGate: gate.tool.status,
      ...(Object.keys(httpHeaders).length === 0 ? {} : { httpHeaders }),
      env: {
        PATH: environment.env["PATH"] ?? "",
        ...(environment.env["HOME"] === undefined ? {} : { HOME: environment.env["HOME"] }),
        ...secretEnv,
      },
      secretValues,
      ...(manifest.http?.defaultUrl === undefined ? {} : { httpUrl: manifest.http.defaultUrl }),
    });

    // Der Digest gehoert zur EXTENSION, nicht zum Analyseweg. Ein Dienst wird
    // als Container bereitgestellt und ueber HTTP befragt; `detect` betritt den
    // Container-Zweig dann nie, und der Pin bliebe ungeprueft — obwohl genau
    // dieser Container laeuft. Deshalb wird hier unabhaengig vom Aufrufmodus
    // nachgesehen, sobald das Manifest einen Container beschreibt.
    if (manifest.container !== undefined) {
      const state = await containerCli.inspect(manifest);
      if (state.ownedByUntangle && state.imageDigest !== undefined) {
        health.imageDigest = state.imageDigest;
        health.digestMatchesManifest = state.imageDigest === manifest.container.digest;
      } else if (state.exists && !state.ownedByUntangle) {
        health.unavailableReasons.push({ invocation: "container", detail: state.detail });
      }
    }

    const lastRun = context.state.lastRuns[manifest.id];
    rows.push({
      id: manifest.id,
      displayName: manifest.displayName,
      category: manifest.category,
      invocation: [...manifest.invocation],
      enabled: context.state.enabled.includes(manifest.id),
      license: {
        spdxId: manifest.license.spdxId,
        usageRestriction: manifest.license.usageRestriction,
        gate,
      },
      pin:
        manifest.container === undefined
          ? null
          : { image: manifest.container.image, digest: manifest.container.digest },
      health,
      missingSecrets,
      manifestPath: extension.manifestPath,
      origin: extension.origin,
      ...(lastRun === undefined ? {} : { lastRun }),
    });
  }

  if (format === "json") {
    emitJson(io, {
      command: "extensions status",
      rootsScanned: context.discovery.rootsScanned,
      projectRootsExcluded: environment.projectRoots,
      extensions: rows,
      rejected: context.discovery.rejected,
      ignored: context.discovery.ignored,
      warnings: context.warnings,
    });
    return EXIT.ok;
  }

  renderText(io, rows, context.discovery.rootsScanned, context.warnings);
  return EXIT.ok;
}

function renderText(
  io: Io,
  rows: readonly StatusRowV1[],
  rootsScanned: readonly { root: string; exists: boolean }[],
  warnings: readonly string[],
): void {
  if (rows.length === 0) {
    line(io, "no extensions installed.");
  }
  for (const row of rows) {
    line(io, `${row.id}  (${row.displayName})`);
    for (const rendered of renderTable(
      ["FIELD", "VALUE"],
      [
        ["enabled", row.enabled ? "yes" : "no"],
        ["invocation", row.invocation.join(", ")],
        ["available", row.health.available ? "yes" : "no"],
        ["effective mode", row.health.effectiveInvocation ?? "—"],
        ["tool version", row.health.toolVersion ?? "—"],
        ["endpoint", row.health.endpoint ?? "—"],
        ["binary", row.health.binaryPath ?? "—"],
        ["license", `${row.license.spdxId} (${row.license.usageRestriction})`],
        ["license gate", `${row.health.licenseGate} — ${row.license.gate.tool.reason}`],
        ["pinned image", row.pin === null ? "— (not container-invoked)" : row.pin.image],
        ["pinned digest", row.pin === null ? "—" : row.pin.digest],
        ["running digest", describeRunningDigest(row)],
        ["last run", describeLastRun(row.lastRun)],
        [
          "missing secrets",
          row.missingSecrets.length === 0 ? "none" : row.missingSecrets.join(", "),
        ],
      ],
    )) {
      line(io, `  ${rendered}`);
    }
    for (const entry of row.license.gate.rulesets) {
      line(io, `  ruleset ${entry.ruleset}: ${entry.status} — ${entry.reason}`);
    }
    for (const reason of row.health.unavailableReasons) {
      line(io, `  unavailable via ${reason.invocation}: ${reason.detail}`);
    }
    for (const command of row.license.gate.acknowledgeCommands) {
      line(io, `  to acknowledge: ${command}`);
    }
    line(io, `  manifest: ${row.manifestPath} (${row.origin})`);
    line(io, "");
  }

  line(io, "roots searched (project directories are never searched):");
  for (const root of rootsScanned) {
    line(io, `  ${root.root}${root.exists ? "" : "  (does not exist)"}`);
  }
  for (const warning of warnings) {
    line(io, `warning: ${warning}`);
  }
}

/**
 * A digest that could not be read is said to be unreadable, with the reason.
 * "—" alone would look like "no container", which is a different statement.
 */
function describeRunningDigest(row: StatusRowV1): string {
  if (row.pin === null) {
    return "—";
  }
  if (row.health.imageDigest === undefined) {
    return "unknown (nothing was started or pulled to find out)";
  }
  return `${row.health.imageDigest} (${row.health.digestMatchesManifest === true ? "matches the pin" : "DIFFERS from the pin"})`;
}

function describeLastRun(lastRun: LastRunRecordV1 | undefined): string {
  if (lastRun === undefined) {
    return "never run";
  }
  return (
    `${lastRun.startedAt} ${lastRun.exitStatus}` +
    `${lastRun.errorCode === undefined ? "" : ` (${lastRun.errorCode})`}` +
    `, ${String(lastRun.findingsTotal)} findings`
  );
}
