/**
 * @untangle-code/storage-local — local state under `.untangle/`
 * (architecture.md §12, §21.1–§21.2; spec.md §11.2, §12.3, §24).
 *
 * This module is the ONLY public export of the package.
 */

// `.untangle/` layout (architecture.md §12)
export * from "./layout.js";

// Path-sandboxed `FileSystemPort` adapter (architecture.md §2.1, §23.1)
export * from "./local-file-system.js";

// File-based `LockProvider` (architecture.md §21.1–§21.2)
export * from "./lock-provider.js";

// Atomic local checkpoint mirror (architecture.md §12, §13.3)
export * from "./checkpoint-store.js";

// Persistent, size-bounded embedding cache (spec.md §9.4)
export * from "./embedding-cache.js";

// Inhaltsadressierte Caches fuer Parse, Chunk und Komplexitaet (WP-100)
export * from "./analysis-cache.js";

// Explizit aktivierte, lokale Dynamic-Product-Complexity-Sessions (Welle 9)
export * from "./search-journey-store.js";

// Convenience wiring of the above
export * from "./storage.js";
