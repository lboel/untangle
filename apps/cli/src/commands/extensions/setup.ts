/** Runs a user-supplied setup provider after consent, ownership and digest checks. */
import type { ExtensionManifestV1 } from "@untangle-code/domain";
import {
  isLoopbackUrl,
  type ProcessLimitsV1,
  type ProcessRunnerPort,
} from "@untangle-code/extension-runtime";

import type { ExtensionEnvironmentV1 } from "./environment.js";
import { primaryHostPort, type ProvisionResultV1 } from "./provision.js";
import {
  credentialEndpoint,
  parseSecretValues,
  readStoredSecrets,
  secretEnvironment,
  withSecretLock,
  writeStoredSecrets,
} from "./secret-store.js";

export function missingAnalyzerSecrets(
  manifest: ExtensionManifestV1,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return manifest.secrets
    .filter(
      (secret) =>
        !secret.setupOnly &&
        (secret.required || secret.name === manifest.http?.authSecretName) &&
        !env[secret.envVar],
    )
    .map((secret) => secret.name);
}

export async function setupCredentials(input: {
  environment: ExtensionEnvironmentV1;
  manifest: ExtensionManifestV1;
  provision?: ProvisionResultV1;
  consent: boolean;
  url?: string;
  processRunner: ProcessRunnerPort;
  limits: ProcessLimitsV1;
  signal?: AbortSignal;
}): Promise<Record<string, string | undefined>> {
  const { environment, manifest, provision } = input;
  const setup = manifest.setup;
  if (!input.consent) throw new Error("Credential setup requires --yes.");
  if (
    !setup ||
    !manifest.container ||
    !provision?.healthy ||
    !provision.state.running ||
    !provision.state.ownedByUntangle ||
    provision.state.imageDigest !== manifest.container.digest
  ) {
    throw new Error(
      "Credential setup requires a healthy, owned container whose digest matches the manifest.",
    );
  }
  const url = input.url ?? manifest.http?.defaultUrl;
  if (
    !url ||
    !isLoopbackUrl(url) ||
    credentialEndpoint(url) !== credentialEndpoint(manifest.http?.defaultUrl)
  ) {
    throw new Error(
      "Credential setup only uses the declared loopback endpoint of the managed container.",
    );
  }
  const endpoint = new URL(url);
  if (
    Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)) !==
    primaryHostPort(manifest)
  ) {
    throw new Error("Credential setup endpoint must match the managed container's published port.");
  }
  return withSecretLock(environment, manifest.id, async () => {
    input.signal?.throwIfAborted();
    const stored = await readStoredSecrets(environment, manifest, url);
    const effectiveEnv = secretEnvironment(environment, manifest, stored);
    if (missingAnalyzerSecrets(manifest, effectiveEnv).length === 0) return effectiveEnv;
    const env: Record<string, string> = {
      PATH: environment.env["PATH"] ?? "",
      UNTANGLE_SETUP_URL: url,
      UNTANGLE_SETUP_ID: manifest.id,
    };
    for (const name of ["HOME", "LANG"]) {
      const value = environment.env[name];
      if (value !== undefined) env[name] = value;
    }
    for (const secret of manifest.secrets) {
      const value = effectiveEnv[secret.envVar];
      if (value) env[secret.envVar] = value;
    }
    const result = await input.processRunner.run(
      {
        command: setup.command,
        args: setup.args,
        cwd: environment.userDataDir,
        env,
      },
      {
        ...input.limits,
        timeoutMs: Math.min(input.limits.timeoutMs, 120_000),
        maxOutputBytes: 1_048_576,
      },
      input.signal === undefined ? {} : { signal: input.signal },
    );
    input.signal?.throwIfAborted();
    // Neither stdout nor stderr may appear in diagnostics: both can contain freshly issued secrets.
    if (result.outcome !== "completed" || result.exitCode !== 0 || result.stdoutTruncated) {
      throw new Error(
        `Credential setup provider failed (${result.outcome}, exit ${String(result.exitCode)}). Check the configured administrator credentials and service availability.`,
      );
    }
    let response: unknown;
    try {
      response = JSON.parse(result.stdout);
    } catch {
      throw new Error("Credential setup provider returned invalid JSON; output was withheld.");
    }
    if (
      response === null ||
      typeof response !== "object" ||
      !("schemaVersion" in response) ||
      response.schemaVersion !== 1 ||
      !("secrets" in response)
    ) {
      throw new Error(
        "Credential setup provider must return schemaVersion 1 and declared secrets; output was withheld.",
      );
    }
    const generated = parseSecretValues(response.secrets, manifest);
    const combined = { ...stored, ...generated };
    const resolved = secretEnvironment(environment, manifest, combined);
    if (missingAnalyzerSecrets(manifest, resolved).length > 0)
      throw new Error("Credential setup provider did not supply the required analyzer secrets.");
    await writeStoredSecrets(environment, manifest, combined, url);
    return resolved;
  });
}
