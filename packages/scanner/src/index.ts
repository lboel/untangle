/**
 * @untangle-code/scanner — recursive discovery, ignore rules, symlink
 * safety, binary/language classification and the content-hash pipeline
 * (spec.md §6.1–§6.3, §12.1; architecture.md §6.4, §23.1).
 *
 * Pure core: reads only through `FileSystemPort` (domain), never
 * `node:fs`. A concrete Node adapter is published separately from
 * `@untangle-code/scanner/node-fs` (see that module's docs) — importing it
 * here would make this entry point Node-specific and untestable against
 * arbitrary `FileSystemPort` implementations (e.g. an in-memory one).
 */

// Scanner-local contracts (not domain contracts — see README, "Entscheidungen").
export * from "./types.js";

// Discovery entry point.
export { discoverFiles } from "./discovery.js";

// Ignore engine (spec.md §6.2 priority layering).
export { IgnoreEngine, createIgnoreEngine } from "./ignore-engine.js";
export {
  compilePattern,
  compilePatterns,
  compileGlobList,
  evaluateLayer,
  type CompiledPattern,
} from "./gitignore-pattern.js";

// Content classification, usable standalone (e.g. for re-classifying a
// buffer already in memory, without going through discovery).
export {
  classifyBinarySample,
  detectMinified,
  type MinifiedHeuristics,
} from "./binary-classifier.js";
export {
  detectLanguage,
  detectLanguageByExtension,
  detectLanguageFromContent,
  type LanguageDetectionResult,
} from "./language-classifier.js";

// Hash pipeline (spec.md §12.1).
export { hashBytes, createPortContentHasher } from "./hashing.js";

// Bounded-concurrency primitives (architecture.md §13.1–§13.2).
export { Semaphore } from "./semaphore.js";
export { mapConcurrent } from "./concurrency.js";
