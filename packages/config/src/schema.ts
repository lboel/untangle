/**
 * JSON Schema export (architecture.md §6.3, §7.3; docs/BUILD_PLAN.md §3
 * assigns the repo-level `schemas/` directory to this package's WP).
 *
 * NOTE (openIssues): the task that produced this package restricts writes to
 * `packages/config/**`, so the authoritative file lives at
 * `packages/config/schemas/config-v1.json`, not the (currently empty, WP-02
 * owned per docs/BUILD_PLAN.md §4) repo-root `schemas/`. It still needs to be
 * mirrored to `schemas/config-v1.json` by whoever is authorized to write
 * there.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const schemaUrl = new URL("../schemas/config-v1.json", import.meta.url);

/** Absolute filesystem path to the hand-authored JSON Schema (Draft 2020-12) for `UntangleConfigV1`. */
export const CONFIG_SCHEMA_PATH: string = fileURLToPath(schemaUrl);

/** The parsed JSON Schema object itself, read once at module load. */
export const CONFIG_SCHEMA: Record<string, unknown> = JSON.parse(
  readFileSync(schemaUrl, "utf8"),
) as Record<string, unknown>;
