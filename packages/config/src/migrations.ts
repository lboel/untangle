/**
 * Migration scaffold for future `schemaVersion` jumps (architecture.md §6.3:
 * "Migration älterer Configversionen"). spec.md is at `schemaVersion: 1`
 * today; this registry lets a future WP register a `1 -> 2` step (etc.)
 * without `loadConfig` needing to change.
 */
import { CURRENT_SCHEMA_VERSION } from "./defaults.js";

export interface MigrationStep {
  fromVersion: number;
  toVersion: number;
  /** Pure transform: old raw config shape in, new raw config shape out. */
  migrate: (raw: Record<string, unknown>) => Record<string, unknown>;
}

const registry = new Map<number, MigrationStep>();

/** Registers a migration step keyed by its `fromVersion`. Overwrites a step already registered for that version. */
export function registerMigration(step: MigrationStep): void {
  registry.set(step.fromVersion, step);
}

/** Removes every registered migration step (test isolation). */
export function clearMigrations(): void {
  registry.clear();
}

export interface MigrationResult {
  config: Record<string, unknown>;
  finalVersion: number;
  /** Versions the config was migrated through, e.g. `[1, 2]` for a single `1 -> 2` hop. */
  appliedFrom: number[];
}

/**
 * Applies registered migration steps in sequence starting from
 * `raw.schemaVersion` (defaulting to `1` when absent) until
 * `targetVersion` (default: {@link CURRENT_SCHEMA_VERSION}) is reached.
 *
 * A config already at `targetVersion` is returned unchanged — the identity
 * migration — without requiring any step to be registered for it.
 */
export function migrateConfig(
  raw: Record<string, unknown>,
  targetVersion: number = CURRENT_SCHEMA_VERSION,
): MigrationResult {
  let current: Record<string, unknown> = raw;
  let version = typeof raw["schemaVersion"] === "number" ? raw["schemaVersion"] : 1;
  const appliedFrom: number[] = [version];

  while (version < targetVersion) {
    const step = registry.get(version);
    if (step === undefined) {
      throw new Error(
        `no migration registered from schemaVersion ${version} towards ${targetVersion}`,
      );
    }
    current = { ...step.migrate(current), schemaVersion: step.toVersion };
    version = step.toVersion;
    appliedFrom.push(version);
  }

  return { config: current, finalVersion: version, appliedFrom };
}
