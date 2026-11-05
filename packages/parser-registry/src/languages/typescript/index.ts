import type { LanguageAdapter } from "@untangle-code/domain";

import { createTreeSitterAdapter } from "../shared/create-adapter.js";
import { TYPESCRIPT_DIALECT } from "../shared/dialect.js";

/** TypeScript `LanguageAdapter` (`.ts`, `.mts`, `.cts`), support level "deep" (spec.md §7.2). */
export function createTypeScriptAdapter(): LanguageAdapter {
  return createTreeSitterAdapter(TYPESCRIPT_DIALECT);
}
