/**
 * Configuration validation (spec.md §4.8):
 *
 * - unknown top-level fields SHOULD warn, never be silently dropped;
 * - invalid enum values or unresolvable core values MUST abort startup;
 * - dimension misconfiguration MUST be detectable before the first index upsert;
 * - the validated effective profile MUST be stored with the index.
 *
 * This module never throws for warnings. It returns both lists; callers that
 * want spec.md §4.8's "MUST abort" behavior call {@link assertConfigValid}.
 */
import { isErrorCode, UntangleError } from "@untangle-code/domain";

import { UNTANGLE_CONFIG_V1_KEYS } from "./types.js";

export interface ConfigIssue {
  /** An `ErrorCode` (domain) for errors; a short machine-readable slug for warnings. */
  code: string;
  message: string;
  /** Dotted path into the config object, e.g. `"embeddings.mode"`. */
  path: string;
}

export interface ValidationResult {
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** URI-backed and network locations are outside the embedded backend contract. */
function isLocalStoragePath(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) return false;
  if (/^[\\/]{2}/u.test(value)) return false;
  if (/^[A-Za-z]:[\\/]/u.test(value)) return true;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value);
}

function checkEnum(
  value: unknown,
  allowed: readonly string[],
  path: string,
  errors: ConfigIssue[],
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors.push({
      code: "CONFIG_INVALID",
      message: `"${path}" must be one of ${allowed.map((v) => `"${v}"`).join(", ")}, got ${JSON.stringify(value)}`,
      path,
    });
  }
}

function checkPositiveInteger(value: unknown, path: string, errors: ConfigIssue[]): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    errors.push({
      code: "CONFIG_INVALID",
      message: `"${path}" must be a positive integer, got ${JSON.stringify(value)}`,
      path,
    });
  }
}

function checkFiniteRange(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
  errors: ConfigIssue[],
): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    errors.push({
      code: "CONFIG_INVALID",
      message: `"${path}" must be a finite number in [${String(minimum)}, ${String(maximum)}], got ${JSON.stringify(value)}`,
      path,
    });
  }
}

function validateRelevancePolicies(search: Record<string, unknown>, errors: ConfigIssue[]): void {
  const policies = search["relevancePolicies"];
  if (policies === undefined) return;
  if (!isRecord(policies)) {
    errors.push({
      code: "CONFIG_INVALID",
      message: '"search.relevancePolicies" must be an object keyed by embedding profile id',
      path: "search.relevancePolicies",
    });
    return;
  }

  for (const [profileId, value] of Object.entries(policies)) {
    const basePath = `search.relevancePolicies.${profileId}`;
    if (profileId.trim() === "") {
      errors.push({
        code: "CONFIG_INVALID",
        message: '"search.relevancePolicies" keys must be non-empty embedding profile ids',
        path: "search.relevancePolicies",
      });
    }
    if (!isRecord(value)) {
      errors.push({
        code: "CONFIG_INVALID",
        message: `"${basePath}" must be a relevance policy object`,
        path: basePath,
      });
      continue;
    }
    for (const scopeField of ["workspaceId", "collection"] as const) {
      if (typeof value[scopeField] !== "string" || value[scopeField].trim() === "") {
        errors.push({
          code: "CONFIG_INVALID",
          message: `"${basePath}.${scopeField}" must be a non-empty string`,
          path: `${basePath}.${scopeField}`,
        });
      }
    }
    const policy = value["policy"];
    if (!isRecord(policy)) {
      errors.push({
        code: "CONFIG_INVALID",
        message: `"${basePath}.policy" must be a relevance policy object`,
        path: `${basePath}.policy`,
      });
      continue;
    }
    const policyPath = `${basePath}.policy`;
    if (typeof policy["calibrationId"] !== "string" || policy["calibrationId"].trim() === "") {
      errors.push({
        code: "CONFIG_INVALID",
        message: `"${policyPath}.calibrationId" must be a non-empty string`,
        path: `${policyPath}.calibrationId`,
      });
    }
    checkFiniteRange(policy["minimumDenseScore"], -1, 1, `${policyPath}.minimumDenseScore`, errors);
    checkFiniteRange(
      policy["minimumDenseSpread"],
      0,
      2,
      `${policyPath}.minimumDenseSpread`,
      errors,
    );
    const referenceRank = policy["denseReferenceRank"];
    if (
      typeof referenceRank !== "number" ||
      !Number.isInteger(referenceRank) ||
      referenceRank < 2
    ) {
      errors.push({
        code: "CONFIG_INVALID",
        message: `"${policyPath}.denseReferenceRank" must be an integer >= 2, got ${JSON.stringify(referenceRank)}`,
        path: `${policyPath}.denseReferenceRank`,
      });
    }
    checkFiniteRange(
      policy["minimumCandidateIdfCoverage"],
      0,
      1,
      `${policyPath}.minimumCandidateIdfCoverage`,
      errors,
    );
  }
}

/**
 * Validates a fully layer-merged (but not yet necessarily complete-with-defaults)
 * configuration object. Returns warnings for unknown top-level fields and
 * errors for invalid enums, unresolvable core values, and structural
 * uniqueness violations (spec.md §4.3 repository ids; portfolio.md §14.4
 * blueprint weight sum).
 */
export function validateEffectiveConfig(config: Record<string, unknown>): ValidationResult {
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];

  // Unknown top-level fields (spec.md §4.8). `$schema` is an accepted,
  // ignored editor/tooling hint (product.md §11's example config carries it).
  for (const key of Object.keys(config)) {
    if (key === "$schema") {
      continue;
    }
    if (!(UNTANGLE_CONFIG_V1_KEYS as readonly string[]).includes(key)) {
      warnings.push({
        code: "unknown_field",
        message: `unknown top-level config field "${key}" is ignored`,
        path: key,
      });
    }
  }

  if (config["schemaVersion"] !== undefined && config["schemaVersion"] !== 1) {
    errors.push({
      code: "CONFIG_INVALID",
      message: `unsupported "schemaVersion" ${JSON.stringify(config["schemaVersion"])}; only 1 is understood without migration`,
      path: "schemaVersion",
    });
  }

  const storage = config["storage"];
  if (storage !== undefined) {
    if (!isRecord(storage)) {
      errors.push({
        code: "CONFIG_INVALID",
        message: '"storage" must be an object',
        path: "storage",
      });
    } else {
      checkEnum(storage["backend"], ["lancedb", "qdrant"], "storage.backend", errors);
      if (storage["path"] !== undefined && !isLocalStoragePath(storage["path"])) {
        errors.push({
          code: "CONFIG_INVALID",
          message:
            '"storage.path" must be a non-empty local filesystem path, not a URI or network path',
          path: "storage.path",
        });
      }
    }
  }

  const qdrant = config["qdrant"];
  if (isRecord(qdrant)) {
    checkEnum(qdrant["mode"], ["managed", "external"], "qdrant.mode", errors);
    if (
      qdrant["mode"] === "external" &&
      (typeof qdrant["url"] !== "string" || qdrant["url"].length === 0)
    ) {
      errors.push({
        code: "CONFIG_INVALID",
        message: `"qdrant.url" is required when "qdrant.mode" is "external"`,
        path: "qdrant.url",
      });
    }
  }

  const embeddings = config["embeddings"];
  if (isRecord(embeddings)) {
    checkEnum(embeddings["provider"], ["ollama"], "embeddings.provider", errors);
    checkEnum(embeddings["mode"], ["auto", "managed", "external"], "embeddings.mode", errors);
    checkPositiveInteger(embeddings["dimensions"], "embeddings.dimensions", errors);
    if (
      embeddings["mode"] === "external" &&
      (typeof embeddings["url"] !== "string" || embeddings["url"].length === 0)
    ) {
      errors.push({
        code: "CONFIG_INVALID",
        message: `"embeddings.url" is required when "embeddings.mode" is "external"`,
        path: "embeddings.url",
      });
    }
  }

  const search = config["search"];
  if (isRecord(search)) {
    validateRelevancePolicies(search, errors);
  }

  const qualityGate = config["qualityGate"];
  if (isRecord(qualityGate)) {
    checkEnum(qualityGate["mode"], ["off", "warn", "fail"], "qualityGate.mode", errors);
    checkEnum(
      qualityGate["minimumParseQuality"],
      ["failed", "partial", "complete"],
      "qualityGate.minimumParseQuality",
      errors,
    );
  }

  const complexity = config["complexity"];
  if (isRecord(complexity)) {
    checkEnum(
      complexity["cyclomaticVariant"],
      ["classic", "extended", "both"],
      "complexity.cyclomaticVariant",
      errors,
    );
  }

  const telemetry = config["telemetry"];
  if (isRecord(telemetry)) {
    checkEnum(
      telemetry["logLevel"],
      ["error", "warn", "info", "debug", "trace"],
      "telemetry.logLevel",
      errors,
    );
    checkEnum(
      telemetry["metricsExport"],
      ["none", "prometheus"],
      "telemetry.metricsExport",
      errors,
    );
  }

  const portfolio = config["portfolio"];
  if (isRecord(portfolio)) {
    const enrichment = portfolio["enrichment"];
    if (isRecord(enrichment) && Array.isArray(enrichment["registries"])) {
      const allowed = ["npm", "pypi", "crates", "maven", "nuget", "go", "composer"];
      for (const [index, registry] of (enrichment["registries"] as unknown[]).entries()) {
        checkEnum(registry, allowed, `portfolio.enrichment.registries[${index}]`, errors);
      }
    }
    const weights = isRecord(portfolio["blueprint"])
      ? portfolio["blueprint"]["weights"]
      : undefined;
    if (isRecord(weights)) {
      const adoption = typeof weights["adoption"] === "number" ? weights["adoption"] : 0;
      const recency = typeof weights["recency"] === "number" ? weights["recency"] : 0;
      const health = typeof weights["health"] === "number" ? weights["health"] : 0;
      const versionConsistency =
        typeof weights["versionConsistency"] === "number" ? weights["versionConsistency"] : 0;
      const sum = adoption + recency + health + versionConsistency;
      if (Math.abs(sum - 1.0) > 0.001) {
        errors.push({
          code: "CONFIG_INVALID",
          message: `"portfolio.blueprint.weights" must sum to 1.0 (±0.001), got ${sum}`,
          path: "portfolio.blueprint.weights",
        });
      }
    }
  }

  // Repository id uniqueness (spec.md §4.3: "id MUSS innerhalb eines Workspaces eindeutig sein").
  const repositories = config["repositories"];
  if (Array.isArray(repositories)) {
    const seen = new Set<string>();
    for (const [index, repo] of repositories.entries()) {
      const id = isRecord(repo) ? repo["id"] : undefined;
      if (typeof id !== "string" || id.length === 0) {
        errors.push({
          code: "CONFIG_INVALID",
          message: `"repositories[${index}].id" is required`,
          path: `repositories[${index}].id`,
        });
        continue;
      }
      if (seen.has(id)) {
        errors.push({
          code: "CONFIG_INVALID",
          message: `duplicate repository id "${id}"`,
          path: `repositories[${index}].id`,
        });
      }
      seen.add(id);
    }
  }

  // Context artifact name uniqueness (spec.md §19.2: unique per project).
  const contextArtifacts = config["contextArtifacts"];
  if (Array.isArray(contextArtifacts)) {
    const seen = new Set<string>();
    for (const [index, artifact] of contextArtifacts.entries()) {
      const name = isRecord(artifact) ? artifact["name"] : undefined;
      if (typeof name !== "string" || name.length === 0) {
        errors.push({
          code: "CONFIG_INVALID",
          message: `"contextArtifacts[${index}].name" is required`,
          path: `contextArtifacts[${index}].name`,
        });
        continue;
      }
      if (seen.has(name)) {
        errors.push({
          code: "CONFIG_INVALID",
          message: `duplicate context artifact name "${name}"`,
          path: `contextArtifacts[${index}].name`,
        });
      }
      seen.add(name);
    }
  }

  return { errors, warnings };
}

/**
 * Throws `UntangleError("CONFIG_INVALID", …)` when `errors` is non-empty
 * (spec.md §4.8: invalid enums / unresolvable core values MUST abort
 * startup). Callers decide when to call this — `loadConfig` itself never
 * throws for either warnings or errors, so a caller can inspect both lists
 * first (e.g. to print them) before deciding to abort.
 */
export function assertConfigValid(errors: readonly ConfigIssue[]): void {
  if (errors.length === 0) {
    return;
  }
  const code = isErrorCode(errors[0]?.code) ? errors[0].code : "CONFIG_INVALID";
  throw new UntangleError(
    code,
    `configuration is invalid: ${errors.map((e) => e.message).join("; ")}`,
    {
      operation: "config.validate",
      context: { issues: errors },
    },
  );
}

/**
 * Pre-upsert dimension check (spec.md §4.8: "Falsch konfigurierte Dimensionen
 * MÜSSEN vor dem ersten Index-Upsert erkannt werden."). Callers invoke this
 * with the configured `embeddings.dimensions` and the dimension already
 * committed to an existing Qdrant collection (from `MetadataStore`/
 * `VectorStore` introspection) before ANY upsert into that collection.
 */
export function assertEmbeddingDimensionsMatch(
  configuredDimensions: number,
  existingCollectionDimensions: number | undefined,
): void {
  if (existingCollectionDimensions === undefined) {
    return;
  }
  if (configuredDimensions !== existingCollectionDimensions) {
    throw new UntangleError(
      "EMBEDDING_DIMENSION_MISMATCH",
      `configured embedding dimensions (${configuredDimensions}) do not match the existing collection's dimensions (${existingCollectionDimensions})`,
      {
        operation: "config.validate",
        context: { configuredDimensions, existingCollectionDimensions },
      },
    );
  }
}
