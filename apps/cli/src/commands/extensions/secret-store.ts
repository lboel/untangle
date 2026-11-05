/** Private, endpoint-bound extension credentials; never part of project configuration. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExtensionManifestV1 } from "@untangle-code/domain";

import { canonicalize, isInsideAnyRoot, type ExtensionEnvironmentV1 } from "./environment.js";

export function secretStorePath(environment: ExtensionEnvironmentV1, id: string): string {
  return join(environment.userDataDir, "extension-secrets", `${id}.json`);
}

export function credentialEndpoint(url?: string): string | null {
  if (url === undefined) return null;
  const parsed = new URL(url);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "Credential endpoint must be an HTTP(S) base URL without credentials, query or fragment.",
    );
  }
  return parsed.href.replace(/\/$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Error messages intentionally contain neither raw JSON nor credential values. */
export function parseSecretValues(
  value: unknown,
  manifest: ExtensionManifestV1,
): Record<string, string> {
  if (!isRecord(value))
    throw new Error("Credential configuration must be an object keyed by declared secret names.");
  const declared = new Set(manifest.secrets.map((secret) => secret.name));
  const entries = Object.entries(value);
  if (
    entries.some(
      ([name, secret]) =>
        !declared.has(name) || typeof secret !== "string" || secret.includes("\0"),
    )
  ) {
    throw new Error(
      "Credential configuration contains an undeclared secret or a non-string value.",
    );
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

async function checkDirectory(
  environment: ExtensionEnvironmentV1,
  create: boolean,
): Promise<string> {
  const directory = dirname(secretStorePath(environment, "placeholder"));
  const canonical = await canonicalize(environment.fs, directory);
  if (isInsideAnyRoot(canonical, environment.projectRoots)) {
    throw new Error("Extension credentials must be stored outside project directories.");
  }
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    ) {
      throw new Error(
        `Credential directory must be owned by this user with mode 0700: ${directory}`,
      );
    }
  } catch (error) {
    if (hasCode(error, "ENOENT") && !create) return directory;
    throw error;
  }
  return directory;
}

export function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}

export async function readStoredSecrets(
  environment: ExtensionEnvironmentV1,
  manifest: ExtensionManifestV1,
  url = manifest.http?.defaultUrl,
): Promise<Record<string, string>> {
  if (manifest.secrets.length === 0) return {};
  await checkDirectory(environment, false);
  const path = secretStorePath(environment, manifest.id);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return {};
    throw new Error(`Cannot safely open credential configuration: ${path}`);
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > 1_048_576 ||
      (process.platform !== "win32" &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
    ) {
      throw new Error(`Credential configuration must be a user-owned file with mode 0600: ${path}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(await handle.readFile("utf8"));
    } catch {
      throw new Error(`Invalid JSON in credential configuration: ${path}`);
    }
    if (!isRecord(value) || value["schemaVersion"] !== 1 || value["extensionId"] !== manifest.id) {
      throw new Error(`Invalid credential configuration schema: ${path}`);
    }
    if (value["endpoint"] !== credentialEndpoint(url)) {
      throw new Error(
        "Stored credentials belong to a different endpoint; configure credentials for the selected endpoint first.",
      );
    }
    return parseSecretValues(value["secrets"], manifest);
  } finally {
    await handle.close();
  }
}

export function secretEnvironment(
  environment: ExtensionEnvironmentV1,
  manifest: ExtensionManifestV1,
  stored: Readonly<Record<string, string>>,
): Record<string, string | undefined> {
  const env = { ...environment.env };
  for (const secret of manifest.secrets) {
    if (!env[secret.envVar] && stored[secret.name]) env[secret.envVar] = stored[secret.name];
  }
  return env;
}

/** A complete environment override does not depend on an old endpoint's config. */
export async function resolveSecretEnvironment(
  environment: ExtensionEnvironmentV1,
  manifest: ExtensionManifestV1,
  url = manifest.http?.defaultUrl,
): Promise<Record<string, string | undefined>> {
  const needsStoredValues = manifest.secrets.some(
    (secret) => !secret.setupOnly && !environment.env[secret.envVar],
  );
  return secretEnvironment(
    environment,
    manifest,
    needsStoredValues ? await readStoredSecrets(environment, manifest, url) : {},
  );
}

/** Caller holds the per-extension lock while changing stored credentials. */
export async function writeStoredSecrets(
  environment: ExtensionEnvironmentV1,
  manifest: ExtensionManifestV1,
  values: Readonly<Record<string, string>>,
  url = manifest.http?.defaultUrl,
): Promise<void> {
  await checkDirectory(environment, true);
  const secrets = parseSecretValues(values, manifest);
  const path = secretStorePath(environment, manifest.id);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify(
          {
            schemaVersion: 1,
            extensionId: manifest.id,
            endpoint: credentialEndpoint(url),
            secrets,
          },
          null,
          2,
        ) + "\n",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function withSecretLock<T>(
  environment: ExtensionEnvironmentV1,
  id: string,
  action: () => Promise<T>,
): Promise<T> {
  const directory = await checkDirectory(environment, true);
  const path = join(directory, `${id}.lock`);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (hasCode(error, "EEXIST"))
      throw new Error(
        `Credential setup is already locked for ${id}; retry after it finishes. If interrupted, inspect and remove ${path}.`,
      );
    throw new Error("Cannot lock the private credential store.");
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await rm(path, { force: true });
  }
}
