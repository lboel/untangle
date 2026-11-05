/**
 * Cross-artifact configuration validation (spec.md §19.2: "Name MUSS
 * projektweit eindeutig sein.").
 */
import type { ContextArtifactConfig } from "@untangle-code/domain";
import { configInvalidError } from "@untangle-code/observability";

/**
 * Validates a whole project's `ContextArtifactConfig` list: every `name`
 * must be non-empty and unique across the list (case-sensitive — two
 * artifacts differing only by case are almost certainly a copy/paste bug,
 * and case-insensitive uniqueness would silently reject that legitimate
 * edge case too, so this stays deliberately literal).
 *
 * Throws `UntangleError("CONFIG_INVALID", …)` (rule 8) with every offending
 * name listed in `context.duplicateNames`, not just the first one found, so
 * a single fix-and-rerun cycle can catch everything at once.
 */
export function validateArtifactConfigs(configs: readonly ContextArtifactConfig[]): void {
  const seen = new Map<string, number>();
  const emptyNameCount = configs.filter((config) => config.name.trim().length === 0).length;
  if (emptyNameCount > 0) {
    throw configInvalidError(
      `${emptyNameCount} context artifact config(s) have an empty "name" (spec.md §19.2 requires a project-wide unique name)`,
      { context: { emptyNameCount } },
    );
  }
  for (const config of configs) {
    seen.set(config.name, (seen.get(config.name) ?? 0) + 1);
  }
  const duplicateNames = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
  if (duplicateNames.length > 0) {
    throw configInvalidError(
      `context artifact name(s) are not project-wide unique (spec.md §19.2): ${duplicateNames.join(", ")}`,
      { context: { duplicateNames } },
    );
  }
}
