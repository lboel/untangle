/**
 * Golden-file assertions (spec.md §27.1 "Golden Tests pro Sprache";
 * architecture.md §27.3: "Golden-Änderungen benötigen Review, da sie
 * Algorithmusbedeutung verändern können").
 *
 * Golden files live in a `__golden__` directory next to the calling test
 * file (pass `import.meta.url`), one pretty-printed, key-sorted JSON file
 * per golden name — sorted keys and 2-space indentation so a real
 * algorithm change shows up as a small, readable diff in review, not a
 * reordered wall of JSON.
 *
 * Update mode: set `UNTANGLE_UPDATE_GOLDEN=1` to (re-)write every golden
 * file a test touches instead of asserting against it — review the diff
 * this produces before committing, exactly like a snapshot-test update.
 *
 * Deliberately does NOT import `expect` from `vitest`: `vitest`'s exported
 * bindings (including `expect`) initialize against the current vitest
 * worker's internal state as a side effect of merely importing the
 * package, so any file that imports them at module scope can only ever be
 * loaded from inside a running vitest process. `assertGoldenJson` compares
 * two already-serialized strings itself and throws a plain `Error` with
 * both sides inlined on mismatch — everything a human (or `expect(() =>
 * ...).toThrow()` from a caller that already runs under vitest) needs,
 * without forcing that constraint onto this module itself.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_UPDATE_ENV_VAR = "UNTANGLE_UPDATE_GOLDEN";

export interface AssertGoldenJsonOptions {
  /** `import.meta.url` of the calling test file. */
  metaUrl: string;
  /** Override the update-mode environment variable name (default `UNTANGLE_UPDATE_GOLDEN`). */
  updateEnvVar?: string;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const propertyValue = (value as Record<string, unknown>)[key];
      if (propertyValue !== undefined) {
        sorted[key] = sortKeysDeep(propertyValue);
      }
    }
    return sorted;
  }
  return value;
}

/** Deterministic, human-diffable serialization: sorted keys, 2-space indent. */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

function goldenFilePath(metaUrl: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      `assertGoldenJson: golden name must be a plain filename-safe string, got "${name}"`,
    );
  }
  const testFileDir = path.dirname(fileURLToPath(metaUrl));
  return path.join(testFileDir, "__golden__", `${name}.json`);
}

/**
 * Asserts that `value` matches the stored golden JSON file named `name`.
 *
 * - the golden file does not exist yet → it is written and the call passes
 *   (first run always "establishes" a golden; review the new file itself
 *   in that commit, same as reviewing a new snapshot);
 * - `UNTANGLE_UPDATE_GOLDEN=1` is set → the golden file is (re-)written to
 *   match `value` and the call passes;
 * - otherwise → `value`'s stable serialization is compared byte-for-byte
 *   against the golden file's content; a mismatch throws a plain `Error`
 *   whose message inlines both sides (golden vs. actual) plus a reminder of
 *   how to update.
 */
export function assertGoldenJson(
  name: string,
  value: unknown,
  options: AssertGoldenJsonOptions,
): void {
  const envVar = options.updateEnvVar ?? DEFAULT_UPDATE_ENV_VAR;
  const filePath = goldenFilePath(options.metaUrl, name);
  const serializedValue = stableStringify(value);
  const shouldWrite = process.env[envVar] === "1" || !existsSync(filePath);

  if (shouldWrite) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, serializedValue, "utf8");
    return;
  }

  const golden = readFileSync(filePath, "utf8");
  if (serializedValue !== golden) {
    throw new Error(
      `assertGoldenJson("${name}"): value does not match the golden file at "${filePath}".\n` +
        `--- golden ---\n${golden}\n--- actual ---\n${serializedValue}\n` +
        `Re-run with ${envVar}=1 to update the golden file, after reviewing this diff.`,
    );
  }
}
