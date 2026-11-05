/**
 * Import/re-export/require/dynamic-import detection (spec.md §14.2).
 *
 * `RawImportKind` (domain `analysis.ts`) has exactly four members: `import`,
 * `re_export`, `dynamic_import`, `package_dependency`. CommonJS
 * `require("x")` has no dedicated member — it is mapped to `"import"`
 * (documented WP-06 decision, README "Entscheidungen"): a `require` call is
 * functionally a synchronous import of the same specifier space, and
 * `"package_dependency"` is reserved for a resolved (not source-level)
 * cross-package edge produced downstream by the import resolver / file
 * graph, not by this adapter.
 */
import type { RawImport, RawImportBinding } from "@untangle-code/domain";

import type { FileTextContext } from "./node-utils.js";
import { unquote, rangeOf } from "./node-utils.js";
import type { SyntaxNode } from "./syntax.js";

/**
 * Zerlegt eine Importklausel in ihre BINDUNGEN — lokaler Name UND Name im
 * Zielmodul. Der lokale Name allein genuegt nicht: bei
 * `import { run as go } from "./lib"` ist `go` lokal und `run` der Export.
 * Wer die Zuordnung hier wegwirft, kann sie nirgends mehr herstellen
 * (`RawImportBinding` in domain `analysis.ts`).
 */
function extractImportBindings(clauseOrSpecifierHolder: SyntaxNode): RawImportBinding[] {
  const bindings: RawImportBinding[] = [];
  for (const child of clauseOrSpecifierHolder.children) {
    if (child.type === "identifier") {
      // Direkter Bezeichner der Importklausel: der Vorgabeexport.
      bindings.push({ localName: child.text, importedName: "default", kind: "default" });
    } else if (child.type === "namespace_import") {
      const inner = child.children.find((c) => c.type === "identifier");
      if (inner !== undefined) bindings.push({ localName: inner.text, kind: "namespace" });
    } else if (child.type === "named_imports") {
      for (const specifier of child.children) {
        if (specifier.type !== "import_specifier") continue;
        const alias = specifier.childForFieldName("alias");
        const name = specifier.childForFieldName("name");
        if (name === null) continue;
        const importedName = unquote(name.text);
        bindings.push({
          localName: alias === null ? importedName : unquote(alias.text),
          importedName,
          kind: importedName === "default" ? "default" : "named",
        });
      }
    }
  }
  return bindings;
}

/** Lokale Namen der Bindungen, in Quelltextreihenfolge. */
function localNamesOf(bindings: readonly RawImportBinding[]): string[] {
  return bindings.map((binding) => binding.localName);
}

function hasDirectTypeModifier(node: SyntaxNode): boolean {
  return node.children.some((child) => child.type === "type");
}

/** Detects a static `import ...` / TS `import x = require(...)` statement. */
export function detectStaticImport(node: SyntaxNode, ctx: FileTextContext): RawImport | null {
  const range = rangeOf(node, ctx);
  const requireClause = node.children.find((child) => child.type === "import_require_clause");
  if (requireClause !== undefined) {
    const source = requireClause.childForFieldName("source");
    if (source === null) return null;
    return {
      specifier: unquote(source.text),
      importKind: "import",
      range,
      typeOnly: hasDirectTypeModifier(node),
    };
  }

  const source = node.childForFieldName("source");
  if (source === null) return null;
  const importClause = node.children.find((child) => child.type === "import_clause");
  const bindings = importClause !== undefined ? extractImportBindings(importClause) : [];
  const importedNames = localNamesOf(bindings);

  return {
    specifier: unquote(source.text),
    importKind: "import",
    range,
    ...(importedNames.length > 0 ? { importedNames, bindings } : {}),
    typeOnly: hasDirectTypeModifier(node),
  };
}

/** Detects a re-export (`export { x } from "y"`, `export * from "y"`, `export * as ns from "y"`). */
export function detectReExport(node: SyntaxNode, ctx: FileTextContext): RawImport | null {
  const source = node.childForFieldName("source");
  if (source === null) return null;
  const exportClause = node.children.find((child) => child.type === "export_clause");
  const bindings: RawImportBinding[] = [];
  if (exportClause !== undefined) {
    for (const specifier of exportClause.children) {
      if (specifier.type !== "export_specifier") continue;
      const alias = specifier.childForFieldName("alias");
      const name = specifier.childForFieldName("name");
      if (name === null) continue;
      // Bei `export { run as go } from "m"` ist `run` der Name IM Zielmodul
      // und `go` der hier weitergereichte Name.
      const importedName = unquote(name.text);
      bindings.push({
        localName: alias === null ? importedName : unquote(alias.text),
        importedName,
        kind: importedName === "default" ? "default" : "named",
      });
    }
  }
  const importedNames = localNamesOf(bindings);
  return {
    specifier: unquote(source.text),
    importKind: "re_export",
    range: rangeOf(node, ctx),
    ...(importedNames.length > 0 ? { importedNames, bindings } : {}),
    typeOnly: hasDirectTypeModifier(node),
  };
}

/** Detects `import("specifier")` (dynamic import) given its enclosing `call_expression`. */
export function detectDynamicImport(callNode: SyntaxNode, ctx: FileTextContext): RawImport | null {
  const args = callNode.childForFieldName("arguments");
  const firstArg = args?.namedChild(0) ?? null;
  const specifier =
    firstArg !== null && firstArg.type === "string"
      ? unquote(firstArg.text)
      : (firstArg?.text ?? "");
  return {
    specifier,
    importKind: "dynamic_import",
    range: rangeOf(callNode, ctx),
    typeOnly: false,
  };
}

/** Detects `require("specifier")` given its enclosing `call_expression`. Mapped to `importKind: "import"` (see file doc). */
export function detectRequireCall(callNode: SyntaxNode, ctx: FileTextContext): RawImport | null {
  const args = callNode.childForFieldName("arguments");
  const firstArg = args?.namedChild(0) ?? null;
  const specifier =
    firstArg !== null && firstArg.type === "string"
      ? unquote(firstArg.text)
      : (firstArg?.text ?? "");
  return {
    specifier,
    importKind: "import",
    range: rangeOf(callNode, ctx),
    typeOnly: false,
  };
}
