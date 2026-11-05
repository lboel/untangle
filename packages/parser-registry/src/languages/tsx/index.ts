import type { LanguageAdapter } from "@untangle-code/domain";

import { createTreeSitterAdapter } from "../shared/create-adapter.js";
import { TSX_DIALECT } from "../shared/dialect.js";

/** TSX `LanguageAdapter` (`.tsx`), support level "deep" (spec.md §7.2). */
export function createTsxAdapter(): LanguageAdapter {
  return createTreeSitterAdapter(TSX_DIALECT);
}
