/**
 * `ParserRegistry` (domain `ports.ts`) implementation: registration plus
 * resolution by extension / language id (architecture.md §6.5).
 *
 * Registering an adapter here does NOT load its grammar — `createTreeSitterAdapter`
 * (see `languages/shared/create-adapter.ts`) only touches the native
 * `tree-sitter` module and the specific grammar module inside `parse()`,
 * via `grammar-loader.ts`'s lazy, cached `require`. A CLI can therefore call
 * `createParserRegistry()` and list/resolve adapters at startup without
 * loading a single native grammar; the first grammar load happens on the
 * first `parse()` call for that language, and only that language's grammar
 * is ever touched if a workspace has, say, TypeScript files only.
 */
import type { LanguageAdapter, ParserRegistry, SupportLevel } from "@untangle-code/domain";

export class LazyParserRegistry implements ParserRegistry {
  private readonly adaptersByLanguageId = new Map<string, LanguageAdapter>();
  private readonly adaptersByExtension = new Map<string, LanguageAdapter>();

  register(adapter: LanguageAdapter): void {
    this.adaptersByLanguageId.set(adapter.languageId, adapter);
    for (const extension of adapter.extensions) {
      this.adaptersByExtension.set(extension.toLowerCase(), adapter);
    }
  }

  listAdapters(): LanguageAdapter[] {
    return [...this.adaptersByLanguageId.values()];
  }

  getAdapterByLanguage(languageId: string): LanguageAdapter | null {
    return this.adaptersByLanguageId.get(languageId) ?? null;
  }

  getAdapterForPath(path: string, _contentSample?: string): LanguageAdapter | null {
    const extension = extensionOf(path);
    if (extension === null) {
      // Extensionless-file content probing (spec.md §6.1) has no MVP use
      // case in this package — every language it supports (TS/JS/TSX/JSX)
      // is always extension-identified. `_contentSample` is accepted (per
      // the domain port signature) but unused; a future adapter that needs
      // it (e.g. a shebang-sniffed shell/Python script) implements the
      // probe itself.
      return null;
    }
    return this.adaptersByExtension.get(extension) ?? null;
  }

  supportLevelOf(languageId: string): SupportLevel | null {
    return this.adaptersByLanguageId.get(languageId)?.supportLevel ?? null;
  }
}

function extensionOf(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const fileName = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) return null; // no dot, or a dotfile like ".gitignore" (no extension)
  return fileName.slice(lastDot).toLowerCase();
}
