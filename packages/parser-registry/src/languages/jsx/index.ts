import type { LanguageAdapter } from "@untangle-code/domain";

import { createTreeSitterAdapter } from "../shared/create-adapter.js";
import { JSX_DIALECT } from "../shared/dialect.js";

/** JSX `LanguageAdapter` (`.jsx`), support level "deep" (spec.md §7.2). */
export function createJsxAdapter(): LanguageAdapter {
  return createTreeSitterAdapter(JSX_DIALECT);
}
