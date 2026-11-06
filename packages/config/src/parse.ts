import { parse as parseToml } from "smol-toml";

import { migrateConfig } from "./migrations.js";
import type { RawConfigLayer } from "./types.js";

/**
 * Parses a config document without filesystem access, defaults or environment
 * overrides. Syntax and non-object input errors propagate to the caller.
 */
export function parseConfigText(text: string, format: "json" | "toml"): RawConfigLayer {
  const parsed: unknown = format === "json" ? JSON.parse(text) : parseToml(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(
      `Configuration must contain a ${format === "json" ? "JSON object" : "TOML table"}.`,
    );
  }
  return migrateConfig(parsed as Record<string, unknown>).config as RawConfigLayer;
}
