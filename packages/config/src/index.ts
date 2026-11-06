/**
 * @untangle-code/config — Untangle configuration: types, discovery,
 * layering, JSON Schema, secret redaction, canonical hashing and migration.
 *
 * This module is the ONLY public export of the package.
 */

// Configuration types (spec.md §4.2-4.8; portfolio.md §14.4)
export * from "./types.js";

// Product defaults (spec.md §4.5; product.md §11)
export * from "./defaults.js";

// JSON Schema (Draft 2020-12)
export * from "./schema.js";

// Config file discovery (spec.md §4.1)
export * from "./discovery.js";

// OS user config directory (spec.md §4.1 layer 5)
export * from "./user-config.js";

// Environment variable layer (spec.md §4.1 layer 2)
export * from "./env.js";

// Deep merge with array-replace semantics (spec.md §4.1)
export * from "./merge.js";

// Path resolution relative to the config file (spec.md §4.3)
export * from "./paths.js";

// Secret references and redaction (spec.md §4.4/§4.5, §24; architecture.md §23.2)
export * from "./secrets.js";

// Canonical effective config hash and embedding profile derivation (architecture.md §6.3)
export * from "./hash.js";

// Validation (spec.md §4.8)
export * from "./validate.js";

// Migration scaffold for future schemaVersion jumps (architecture.md §6.3)
export * from "./migrations.js";

// Top-level orchestration
export * from "./load.js";

// Parse an existing document without loading defaults or environment layers.
export * from "./parse.js";

// IndexConfig -> chunker token-budget wiring (spec.md §4.6)
export * from "./chunker-budget.js";
