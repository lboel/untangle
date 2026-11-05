import type { LanguageAdapter } from "@untangle-code/domain";

import { createTreeSitterAdapter } from "../shared/create-adapter.js";
import { JAVASCRIPT_DIALECT } from "../shared/dialect.js";

/** JavaScript `LanguageAdapter` (`.js`, `.mjs`, `.cjs`), support level "deep" (spec.md §7.2). */
export function createJavaScriptAdapter(): LanguageAdapter {
  return createTreeSitterAdapter(JAVASCRIPT_DIALECT);
}
