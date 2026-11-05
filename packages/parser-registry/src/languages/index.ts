/**
 * Central builtin-language registration point.
 *
 * Dateibesitz (BUILD_PLAN §4): every path under `packages/parser-registry/`
 * belongs to WP-06, EXCEPT `src/languages/python/**` and "the registration
 * line" in this file, both owned by WP-09 (a later wave). WP-09 adds its
 * import and ONE `registry.register(createPythonAdapter());` line below,
 * without touching any line above it — that is the whole contract for
 * adding a language without editing existing files/lines.
 */
import type { LazyParserRegistry } from "../registry.js";

import {
  createBreadthAdapters,
  createGoAdapter,
  createRustAdapter,
} from "./astgrep-backend/index.js";
import { createJavaScriptAdapter } from "./javascript/index.js";
import { createJsxAdapter } from "./jsx/index.js";
import { createProseAdapter } from "./prose/index.js";
import { createPythonAdapter } from "./python/index.js";
import { createStructuredTextAdapter } from "./structured-text/index.js";
import { createTsxAdapter } from "./tsx/index.js";
import { createTypeScriptAdapter } from "./typescript/index.js";
import { createVueAdapter } from "./vue/index.js";

/** Registers every builtin language adapter. Registration is cheap and lazy — see `registry.ts`'s doc comment. */
export function registerBuiltinLanguages(registry: LazyParserRegistry): void {
  registry.register(createTypeScriptAdapter());
  registry.register(createJavaScriptAdapter());
  registry.register(createTsxAdapter());
  registry.register(createJsxAdapter());
  registry.register(createVueAdapter());
  registry.register(createPythonAdapter());
  // WP-110/WP-217: Prosa und strukturierte Daten sind Stufe `text`, nicht
  // `unsupported_language` (vision.md §1c, spec.md §7.2). Beide Adapter
  // laden keine Grammatik und kosten bei der Registrierung nichts.
  registry.register(createProseAdapter());
  registry.register(createStructuredTextAdapter());
  // WP-220: Go und Rust laufen ueber das ast-grep-Backend
  // (`languages/astgrep-backend/README.md` sagt, warum GENAU diese Sprachen
  // dort laufen und die JS/TS-Familie nicht). Die Anmeldung kostet nichts:
  // weder `@ast-grep/napi` noch eine Grammatik wird dabei geladen — das
  // passiert erst beim ersten Parse einer dieser Sprachen.
  registry.register(createGoAdapter());
  registry.register(createRustAdapter());
  // WP-86: neun weitere Sprachen ueber DASSELBE Backend und DIESELBE
  // Tabellenform — Java, C#, Ruby, PHP, Kotlin, C, C++, Swift, Bash. Auch sie
  // laden beim Registrieren nichts.
  for (const adapter of createBreadthAdapters()) {
    registry.register(adapter);
  }
}
