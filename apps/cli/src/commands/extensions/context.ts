/**
 * The shared read path of the extension commands.
 *
 * Every command starts from the same picture: which manifests were found in
 * the user roots, which were rejected and why, which were deliberately
 * ignored and why, which acknowledgments exist, and what the CLI recorded
 * about earlier runs. Building that once keeps `list`, `run` and `enable`
 * from drifting apart in what they consider "installed".
 */
import {
  discoverExtensions,
  evaluateLicenseGate,
  loadLicenseAcknowledgments,
  type ExtensionDiscoveryResultV1,
  type LicenseAcknowledgmentV1,
  type LicenseGateDecisionV1,
  type LoadedExtensionV1,
} from "@untangle-code/extension-runtime";

import type { ExtensionEnvironmentV1 } from "./environment.js";
import { loadCliState, type CliStateV1 } from "./state.js";

export interface ExtensionContextV1 {
  discovery: ExtensionDiscoveryResultV1;
  acknowledgments: LicenseAcknowledgmentV1[];
  state: CliStateV1;
  /** Everything that was skipped, unreadable or ignored, with its reason (E4). */
  warnings: string[];
}

/** Reads discovery, acknowledgments and CLI state in one go. */
export async function loadExtensionContext(
  environment: ExtensionEnvironmentV1,
): Promise<ExtensionContextV1> {
  const discovery = await discoverExtensions(environment.fs, {
    roots: environment.roots,
    projectRoots: environment.projectRoots,
  });
  const acknowledgments = await loadLicenseAcknowledgments(environment.fs, {
    userDataDirectory: environment.userDataDir,
    projectRoots: environment.projectRoots,
  });
  const state = await loadCliState(environment.fs, environment.userDataDir);
  return {
    discovery,
    acknowledgments: acknowledgments.acknowledgments,
    state: state.state,
    warnings: [...acknowledgments.warnings, ...state.warnings],
  };
}

/** Finds a loaded extension by id, or null. */
export function findExtension(
  context: ExtensionContextV1,
  extensionId: string,
): LoadedExtensionV1 | null {
  return context.discovery.extensions.find((entry) => entry.manifest.id === extensionId) ?? null;
}

/**
 * Evaluates both gates for one extension against the stored acknowledgments.
 *
 * `ruleset` is the effective ruleset of the intended run; without one the
 * manifest's `defaultRuleset` applies, which is what the runtime would use.
 */
export function gateFor(
  context: ExtensionContextV1,
  extension: LoadedExtensionV1,
  ruleset?: string,
): LicenseGateDecisionV1 {
  const effective = ruleset ?? extension.manifest.defaultRuleset;
  return evaluateLicenseGate({
    extension,
    acknowledgments: context.acknowledgments,
    ...(effective === undefined ? {} : { ruleset: effective }),
  });
}

/**
 * Explains why an id is not installed, naming the manifests that were
 * rejected or ignored for it. "Not found" without a reason is exactly the
 * silent skip E4 forbids.
 */
export function explainMissing(context: ExtensionContextV1, extensionId: string): string {
  const rejected = context.discovery.rejected.filter(
    (entry) =>
      entry.directoryName === extensionId || entry.manifestPath.includes(`/${extensionId}/`),
  );
  if (rejected.length > 0) {
    const reasons = rejected
      .flatMap((entry) => entry.issues.map((issue) => `${issue.field}: ${issue.message}`))
      .join("; ");
    return `extension "${extensionId}" has a manifest but it was rejected — ${reasons}`;
  }
  const ignored = context.discovery.ignored.filter((entry) =>
    entry.manifestPath.includes(`/${extensionId}/`),
  );
  if (ignored.length > 0) {
    const reasons = ignored.map((entry) => `${entry.reason}: ${entry.detail}`).join("; ");
    return `extension "${extensionId}" was found but not loaded — ${reasons}`;
  }
  const roots = context.discovery.rootsScanned
    .map((entry) => `${entry.root}${entry.exists ? "" : " (does not exist)"}`)
    .join(", ");
  return (
    `no extension "${extensionId}" is installed; searched: ${roots}. ` +
    `Install one with: untangle extensions add --from <path-or-url>`
  );
}
