/**
 * Die Resolver-Pipeline (architecture.md §16.2).
 *
 * Reihenfolge wie dort festgelegt: relativer Pfad → Sprachaliase →
 * Projektaliase → Workspace-Paketkarte → installierte Paketmetadaten →
 * Klassifikation als extern/unaufgeloest.
 *
 * DER WICHTIGE TEIL IST DAS SCHEITERN. Ein Resolver, der zustaendig war und
 * NICHT getroffen hat, beendet die Suche nicht: der naechste zustaendige darf
 * es versuchen. Erst wenn keiner mehr uebrig ist, entsteht eine unaufgeloeste
 * Kante — und die traegt dann den Grund des ERSTEN zustaendigen Resolvers,
 * ergaenzt um die Namen aller weiteren Versuche und die Vereinigung aller
 * geprueften Kandidaten. Ein pauschales „konnte nicht aufgeloest werden" ohne
 * diese Spur waere genau die stille Ausblendung, die E4 verbietet.
 */
import { compareCodepoints } from "@untangle-code/domain";

import type { ImportResolverV1, ResolveContextV1, ResolveResultV1 } from "../types.js";

import {
  configuredAliasResolver,
  installedPackageResolver,
  projectAliasResolver,
  pythonModuleResolver,
  relativePathResolver,
  runtimeBuiltinResolver,
  subpathImportResolver,
  workspacePackageResolver,
} from "./resolvers.js";

/** Die Standardpipeline in der Reihenfolge von architecture.md §16.2. */
export const DEFAULT_RESOLVER_PIPELINE: readonly ImportResolverV1[] = [
  relativePathResolver,
  runtimeBuiltinResolver,
  subpathImportResolver,
  pythonModuleResolver,
  projectAliasResolver,
  configuredAliasResolver,
  workspacePackageResolver,
  installedPackageResolver,
];

/** Ergebnis eines Pipelinelaufs samt der Spur der befragten Resolver. */
export interface PipelineOutcomeV1 {
  result: ResolveResultV1;
  /** Namen aller Resolver, die sich zustaendig erklaert haben, in Reihenfolge. */
  attemptedResolvers: string[];
}

export function resolveImport(
  specifier: string,
  context: ResolveContextV1,
  pipeline: readonly ImportResolverV1[] = DEFAULT_RESOLVER_PIPELINE,
): PipelineOutcomeV1 {
  const attempted: string[] = [];
  const failures: {
    resolver: string;
    result: Extract<ResolveResultV1, { status: "unresolved" }>;
  }[] = [];

  for (const resolver of pipeline) {
    let supports: boolean;
    try {
      supports = resolver.supports(specifier, context);
    } catch (error) {
      // Ein werfender Resolver darf die Kette nicht abbrechen — der Fehler
      // wird zum benannten Fehlschlag, nicht zum verschluckten Ausnahmefall.
      attempted.push(resolver.name);
      failures.push({
        resolver: resolver.name,
        result: {
          status: "unresolved",
          reason: "no_resolver_supports_specifier",
          detail: `resolver "${resolver.name}" threw while deciding support: ${messageOf(error)}`,
        },
      });
      continue;
    }
    if (!supports) continue;
    attempted.push(resolver.name);

    let outcome: ResolveResultV1 | null;
    try {
      outcome = resolver.resolve(specifier, context);
    } catch (error) {
      failures.push({
        resolver: resolver.name,
        result: {
          status: "unresolved",
          reason: "target_file_not_found",
          detail: `resolver "${resolver.name}" threw: ${messageOf(error)}`,
        },
      });
      continue;
    }
    if (outcome === null) continue;
    if (outcome.status !== "unresolved") {
      return { result: outcome, attemptedResolvers: attempted };
    }
    failures.push({ resolver: resolver.name, result: outcome });
  }

  if (failures.length === 0) {
    return {
      result: {
        status: "unresolved",
        reason: "no_resolver_supports_specifier",
        detail: `no resolver in [${pipeline.map((entry) => entry.name).join(", ")}] claims specifier "${specifier}" from "${context.fromPath}"`,
      },
      attemptedResolvers: attempted,
    };
  }

  const first = failures[0] as {
    resolver: string;
    result: Extract<ResolveResultV1, { status: "unresolved" }>;
  };
  const rejected = new Set<string>();
  for (const failure of failures) {
    for (const candidate of failure.result.rejectedCandidates ?? []) {
      rejected.add(candidate);
    }
  }
  const trail = failures
    .map((failure) => `${failure.resolver}: ${failure.result.detail}`)
    .join(" | ");
  return {
    result: {
      status: "unresolved",
      reason: first.result.reason,
      detail: trail,
      ...(rejected.size > 0 ? { rejectedCandidates: [...rejected].sort(compareCodepoints) } : {}),
    },
    attemptedResolvers: attempted,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
