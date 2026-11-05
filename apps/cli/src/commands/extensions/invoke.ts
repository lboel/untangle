/** Shared extension execution for `extensions run` and `scan`.
 * Expected refusals and failures are data; cancellation still aborts the caller.
 * The caller owns rendering and persistence of the returned run record.
 */
import { buildRefId, buildRepoId, buildWorkspaceId, sha256Hex } from "@untangle-code/domain";
import {
  buildHttpAuthHeaders,
  createFetchHttpRunner,
  createNodeProcessRunner,
  detectExtension,
  runExtension,
  redactSecrets,
  type ExtensionHealthV1,
  type ExtensionRunResultV1,
  type FileResolutionV1,
  type LicenseGateDecisionV1,
  type LoadedExtensionV1,
  type ProcessLimitsV1,
} from "@untangle-code/extension-runtime";

import { createContainerCli } from "./container.js";
import type { ExtensionContextV1 } from "./context.js";
import { gateFor } from "./context.js";
import type { ExtensionEnvironmentV1 } from "./environment.js";
import { provisionContainer, type ProvisionResultV1 } from "./provision.js";
import { resolveSecretEnvironment } from "./secret-store.js";
import { missingAnalyzerSecrets, setupCredentials } from "./setup.js";

/**
 * Warum eine Extension NICHT gelaufen ist — geschlossene Menge (E4).
 *
 * Bewusst NICHT die `SkipReason` des Domains: die beschreibt uebersprungene
 * GEGENSTAENDE einer Pipeline und hat fuer offenes Gate, fehlendes Secret,
 * verweigerte Zustimmung und nicht-aktiviert kein Glied. Diese Menge beschreibt
 * einen nicht stattgefundenen AUFRUF, und sie bleibt lokal, bis ein zweiter
 * Konsument sie braucht.
 */
export const EXTENSION_NOT_RUN_REASONS = [
  "not_enabled",
  "license_gate_open",
  "consent_withheld",
  "secret_missing",
  "setup_failed",
  "provision_failed",
  "invocation_failed",
] as const;

export type ExtensionNotRunReason = (typeof EXTENSION_NOT_RUN_REASONS)[number];

export interface ExtensionNotRunV1 {
  status: "not_run";
  extensionId: string;
  reason: ExtensionNotRunReason;
  /** Menschenlesbare Begruendung; nie leer (E4). */
  detail: string;
  /** Der Befehl, der den Zustand aufloesen wuerde, sofern es einen gibt. */
  nextStep?: string;
}

export interface ExtensionRanV1 {
  status: "ran";
  extensionId: string;
  health: ExtensionHealthV1;
  result: ExtensionRunResultV1;
  provision?: ProvisionResultV1;
}

export type InvokeExtensionOutcome = ExtensionRanV1 | ExtensionNotRunV1;

export interface InvokeExtensionInput {
  environment: ExtensionEnvironmentV1;
  context: ExtensionContextV1;
  extension: LoadedExtensionV1;
  workspacePath: string;
  target: string;
  ruleset?: string;
  httpUrl?: string;
  limits: ProcessLimitsV1;
  /**
   * Ob eine Container-Bereitstellung erfolgen darf (X1). Ohne sie wird nichts
   * gestartet und nichts gezogen; der Fall erscheint als `consent_withheld`.
   */
  provisionConsent: boolean;
  /** Nur fuer den Fall `not_enabled` — der Aufrufer entscheidet, ob er ihn prueft. */
  requireEnabled?: boolean;
  fetchImpl?: typeof fetch;
  onProvisionStep?: (step: string) => void;
  /** Called after the gate, before provisioning, to disclose resource costs. */
  onProvisionPlanned?: (detail: string) => void;
  signal?: AbortSignal;
  /** Wie ein vom Werkzeug genannter Pfad auf das Repository abgebildet wird. */
  resolveFile: (path: string) => FileResolutionV1;
  /** Wie eine Werkzeugposition in einen Bytebereich uebersetzt wird. */
  resolvePosition: Parameters<typeof runExtension>[1]["resolvePosition"];
}

export async function invokeExtension(
  input: InvokeExtensionInput,
): Promise<InvokeExtensionOutcome> {
  input.signal?.throwIfAborted();
  const secrets = input.extension.manifest.secrets
    .map((secret) => input.environment.env[secret.envVar])
    .filter((value): value is string => value !== undefined && value !== "");
  try {
    const outcome = await executeExtension(input, secrets);
    input.signal?.throwIfAborted();
    return outcome;
  } catch (error) {
    input.signal?.throwIfAborted();
    return {
      status: "not_run",
      extensionId: input.extension.manifest.id,
      reason: "invocation_failed",
      detail: redactSecrets(error instanceof Error ? error.message : String(error), secrets),
      nextStep: `untangle extensions status ${input.extension.manifest.id}`,
    };
  }
}

async function executeExtension(
  input: InvokeExtensionInput,
  sensitiveValues: string[],
): Promise<InvokeExtensionOutcome> {
  const { environment, context, extension } = input;
  const manifest = extension.manifest;
  const extensionId = manifest.id;
  const ruleset = input.ruleset ?? manifest.defaultRuleset;

  if (input.requireEnabled === true && !context.state.enabled.includes(extensionId)) {
    return {
      status: "not_run",
      extensionId,
      reason: "not_enabled",
      detail: `"${extensionId}" is installed but not enabled; enabling starts nothing (X1)`,
      nextStep: `untangle extensions enable ${extensionId}`,
    };
  }

  // Das Lizenz-Gate steht vor allem anderen (X5): ohne Bestaetigung wird nicht
  // einmal die Version abgefragt.
  const gate: LicenseGateDecisionV1 = gateFor(context, extension, ruleset);
  if (!gate.allowed) {
    const reasons = [gate.tool, ...gate.rulesets]
      .filter((outcome) => outcome.status !== "acknowledged" && outcome.status !== "not_required")
      .map((outcome) => outcome.reason)
      .join("; ");
    return {
      status: "not_run",
      extensionId,
      reason: "license_gate_open",
      detail: `nothing was started and nothing was pulled: ${reasons}`,
      ...(gate.acknowledgeCommands.length === 0
        ? {}
        : { nextStep: gate.acknowledgeCommands.join(" && ") }),
    };
  }

  const clock = environment.clock;
  const runtimeDeps = {
    clock,
    random: environment.random,
    processRunner: createNodeProcessRunner(clock),
    httpRunner: createFetchHttpRunner(
      (input.fetchImpl ?? fetch) as Parameters<typeof createFetchHttpRunner>[0],
      clock,
    ),
  };

  let provision: ProvisionResultV1 | undefined;
  if (manifest.container !== undefined) {
    if (!input.provisionConsent) {
      const resources = manifest.resources;
      return {
        status: "not_run",
        extensionId,
        reason: "consent_withheld",
        detail:
          `a container would have to be provisioned first: at least ` +
          `${String(resources.minMemoryMb)} MB memory (recommended ` +
          `${String(resources.recommendedMemoryMb)} MB), ${String(resources.recommendedCpus)} CPUs, ` +
          `image ${manifest.container.image}@${manifest.container.digest}`,
        nextStep: `untangle extensions run ${extensionId} --yes`,
      };
    }
    const resources = manifest.resources;
    input.onProvisionPlanned?.(
      `${extensionId}: memory at least ${String(resources.minMemoryMb)} MB, ` +
        `recommended ${String(resources.recommendedMemoryMb)} MB; ` +
        `cpus recommended ${String(resources.recommendedCpus)}; ` +
        `image ${manifest.container.image}@${manifest.container.digest}`,
    );
    provision = await provisionContainer(
      {
        fs: environment.fs,
        container: createContainerCli({
          processRunner: runtimeDeps.processRunner,
          limits: { ...input.limits, timeoutMs: 300_000 },
          ...(environment.env["UNTANGLE_CONTAINER_CLI"] === undefined
            ? {}
            : { command: environment.env["UNTANGLE_CONTAINER_CLI"] }),
        }),
        httpRunner: runtimeDeps.httpRunner,
        limits: input.limits,
        wait: waitForRetry,
      },
      {
        manifest,
        userDataDirectory: environment.userDataDir,
        workspacePath: input.workspacePath,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
    for (const step of provision.steps) {
      input.onProvisionStep?.(step);
    }
    if (!provision.healthy) {
      return {
        status: "not_run",
        extensionId,
        reason: "provision_failed",
        detail: provision.detail,
        nextStep: `untangle extensions logs ${extensionId}`,
      };
    }
  }

  const httpUrl = input.httpUrl ?? manifest.http?.defaultUrl;
  let effectiveEnv = await resolveSecretEnvironment(environment, manifest, httpUrl);
  if (manifest.setup && missingAnalyzerSecrets(manifest, effectiveEnv).length > 0) {
    try {
      effectiveEnv = await setupCredentials({
        environment,
        manifest,
        ...(provision === undefined ? {} : { provision }),
        consent: input.provisionConsent,
        ...(httpUrl === undefined ? {} : { url: httpUrl }),
        processRunner: runtimeDeps.processRunner,
        limits: input.limits,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      input.onProvisionStep?.(
        "required credentials were initialized and stored in the private user profile",
      );
    } catch (error) {
      input.signal?.throwIfAborted();
      return {
        status: "not_run",
        extensionId,
        reason: "setup_failed",
        detail: error instanceof Error ? error.message : "Credential setup failed.",
        nextStep: `untangle extensions configure ${extensionId}`,
      };
    }
  }
  for (const secret of manifest.secrets) {
    const value = effectiveEnv[secret.envVar];
    if (value) sensitiveValues.push(value);
  }

  // Secrets kommen aus Umgebung/privatem Store, nie aus dem Manifest (§8.5). Die
  // Reihenfolge nach der Bereitstellung ist Absicht: ein Token kann der Dienst
  // erst ausstellen, wenn er laeuft.
  const secretEnv: Record<string, string> = {};
  const secretValues: string[] = [];
  const missingSecrets: string[] = [];
  for (const secret of manifest.secrets) {
    if (secret.setupOnly) continue;
    const value = effectiveEnv[secret.envVar];
    if (value === undefined || value === "") {
      if (secret.required) {
        missingSecrets.push(`${secret.name} (${secret.envVar}): ${secret.purpose}`);
      }
      continue;
    }
    secretEnv[secret.envVar] = value;
    secretValues.push(value);
  }
  if (missingSecrets.length > 0) {
    return {
      status: "not_run",
      extensionId,
      reason: "secret_missing",
      detail:
        `required secrets are not set in the environment or private config: ${missingSecrets.join("; ")}` +
        (provision?.healthy === true
          ? "; the service itself is up, so a token can be created there now"
          : ""),
      nextStep: `untangle extensions configure ${extensionId}`,
    };
  }

  const toolEnv: Record<string, string> = {
    PATH: environment.env["PATH"] ?? "",
    ...(environment.env["HOME"] === undefined ? {} : { HOME: environment.env["HOME"] }),
    ...(environment.env["LANG"] === undefined ? {} : { LANG: environment.env["LANG"] }),
    ...secretEnv,
  };
  const httpHeaders = buildHttpAuthHeaders(manifest, effectiveEnv);

  const health = await detectExtension(runtimeDeps, {
    extension,
    licenseGate: gate.tool.status,
    env: toolEnv,
    secretValues,
    limits: input.limits,
    ...(httpUrl === undefined ? {} : { httpUrl }),
    ...(Object.keys(httpHeaders).length === 0 ? {} : { httpHeaders }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  // X6: der Pin gilt fuer den Container, den Untangle gestartet hat — auch
  // wenn analysiert wird, indem man ihn fragt.
  if (provision !== undefined && manifest.container !== undefined) {
    const digest = provision.state.imageDigest;
    if (digest !== undefined) {
      health.imageDigest = digest;
      health.digestMatchesManifest = digest === manifest.container.digest;
    }
  }

  const repoId = buildRepoId({ canonicalPath: input.workspacePath });
  const workspaceId = buildWorkspaceId({ configHash: sha256Hex(input.workspacePath) });
  const refId = buildRefId(repoId, "working-tree");

  const result = await runExtension(runtimeDeps, {
    extension,
    health,
    gate,
    workspaceId,
    repoId,
    refId,
    workspacePath: input.workspacePath,
    target: input.target,
    env: toolEnv,
    secretValues,
    limits: input.limits,
    ...(ruleset === undefined ? {} : { ruleset }),
    ...(httpUrl === undefined ? {} : { httpUrl }),
    ...(Object.keys(httpHeaders).length === 0 ? {} : { httpHeaders }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    resolveFile: input.resolveFile,
    resolvePosition: input.resolvePosition,
  });

  return {
    status: "ran",
    extensionId,
    health,
    result,
    ...(provision === undefined ? {} : { provision }),
  };
}

/** Abortable wait without leaving listeners behind after each health probe. */
function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
