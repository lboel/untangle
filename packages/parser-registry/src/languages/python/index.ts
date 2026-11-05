import type { LanguageAdapter } from "@untangle-code/domain";

import { createPythonAdapter as createPythonAdapterImpl } from "./create-adapter.js";

/** Python `LanguageAdapter` (`.py`, `.pyi`), support level "deep" (spec.md §7.2, WP-09). */
export function createPythonAdapter(): LanguageAdapter {
  return createPythonAdapterImpl();
}
