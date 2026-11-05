/**
 * Lazy loader for the native `tree-sitter` runtime and its grammars.
 *
 * architecture.md §6.5 / the WP-06 mandate require that the CLI NOT load
 * every grammar at startup. We satisfy that with plain lazy `require`
 * (via `node:module#createRequire`, since this package is ESM and the
 * native bindings are CommonJS) cached in module-level maps: nothing here
 * runs until `getParser()`/`loadGrammar()` is first called for a given
 * language, and each grammar is required at most once per process.
 *
 * `require` (not dynamic `import()`) is deliberate: `LanguageAdapter.parse`
 * (domain `analysis.ts`) is a SYNCHRONOUS method, so grammar acquisition on
 * first use must be synchronous too. `createRequire` gives us a synchronous
 * CJS `require` from inside an ESM module without violating
 * `verbatimModuleSyntax`.
 */
import { createRequire } from "node:module";

import type { TsLanguage, TsParserCtor } from "./tree-sitter-types.js";

const require = createRequire(import.meta.url);

let cachedParserCtor: TsParserCtor | undefined;

/** Lazily requires the native `tree-sitter` Parser constructor (once per process). */
export function loadParserCtor(): TsParserCtor {
  if (cachedParserCtor === undefined) {
    cachedParserCtor = require("tree-sitter") as TsParserCtor;
  }
  return cachedParserCtor;
}

/** Which grammar module a dialect is loaded from, and how to reach the language export. */
export interface GrammarSource {
  /** npm module to `require` lazily. */
  moduleName: "tree-sitter-typescript" | "tree-sitter-javascript";
  /** Property on the required module holding the `Language`, or `undefined` for the module's default export itself. */
  exportName?: "typescript" | "tsx";
}

const grammarCache = new Map<string, TsLanguage>();

function grammarCacheKey(source: GrammarSource): string {
  return `${source.moduleName}::${source.exportName ?? "default"}`;
}

/** Lazily requires and caches a single grammar `Language` handle. */
export function loadGrammar(source: GrammarSource): TsLanguage {
  const key = grammarCacheKey(source);
  const cached = grammarCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const loadedModule = require(source.moduleName) as Record<string, unknown>;
  const language = (
    source.exportName === undefined ? loadedModule : loadedModule[source.exportName]
  ) as TsLanguage;
  grammarCache.set(key, language);
  return language;
}

/** Test-only: clears caches so grammar-loading behavior can be re-exercised. */
export function resetGrammarCachesForTests(): void {
  cachedParserCtor = undefined;
  grammarCache.clear();
}
