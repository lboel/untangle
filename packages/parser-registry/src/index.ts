/**
 * @untangle-code/parser-registry — the ONLY public export of this package.
 *
 * `createParserRegistry()` returns a `ParserRegistry` (domain `ports.ts`)
 * with the TypeScript/JavaScript/TSX/JSX `LanguageAdapter`s already
 * registered. Registration is cheap: no grammar is loaded until the first
 * `parse()` call for that language (see `registry.ts` / `languages/shared/grammar-loader.ts`).
 *
 * `@untangle-code/core` (WP-23)'s public `createParserRegistry(config)`
 * facade (spec.md §22) wraps this factory.
 */
import type { ParserRegistry } from "@untangle-code/domain";

import { registerBuiltinLanguages } from "./languages/index.js";
import { LazyParserRegistry } from "./registry.js";
export { extractHttpBoundaryFacts } from "./boundaries/extract.js";

export function createParserRegistry(): ParserRegistry {
  const registry = new LazyParserRegistry();
  registerBuiltinLanguages(registry);
  return registry;
}

export { LazyParserRegistry } from "./registry.js";
export { createTypeScriptAdapter } from "./languages/typescript/index.js";
export { createJavaScriptAdapter } from "./languages/javascript/index.js";
export { createTsxAdapter } from "./languages/tsx/index.js";
export { createJsxAdapter } from "./languages/jsx/index.js";
export { createVueAdapter } from "./languages/vue/index.js";
export { createPythonAdapter } from "./languages/python/index.js";
export {
  createProseAdapter,
  PROSE_LANGUAGE_ID,
  PROSE_SYMBOL_KIND,
} from "./languages/prose/index.js";
export {
  createStructuredTextAdapter,
  STRUCTURED_TEXT_LANGUAGE_ID,
} from "./languages/structured-text/index.js";
export {
  astGrepLanguageStates,
  astGrepLanguageStatus,
  createAstGrepAdapter,
  createGoAdapter,
  createRustAdapter,
  MAX_ASTGREP_SOURCE_BYTES,
} from "./languages/astgrep-backend/index.js";
export type {
  AstGrepLanguageSource,
  AstGrepLanguageStatus,
} from "./languages/astgrep-backend/index.js";
