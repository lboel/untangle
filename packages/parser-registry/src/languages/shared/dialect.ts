import type { SupportLevel } from "@untangle-code/domain";

import type { GrammarSource } from "./grammar-loader.js";

/** Static, per-language configuration for the tree-sitter adapter factory. */
export interface Dialect {
  languageId: string;
  extensions: string[];
  supportLevel: SupportLevel;
  grammar: GrammarSource;
  /** Whether the grammar has TypeScript type syntax (interfaces, type aliases, enums, type annotations, generics). */
  hasTypes: boolean;
  /** Class field/property-signature node type name, which differs between the JS and TS grammars. */
  fieldDefinitionKind: "field_definition" | "public_field_definition";
}

export const TYPESCRIPT_DIALECT: Dialect = {
  languageId: "typescript",
  extensions: [".ts", ".mts", ".cts"],
  supportLevel: "deep",
  grammar: { moduleName: "tree-sitter-typescript", exportName: "typescript" },
  hasTypes: true,
  fieldDefinitionKind: "public_field_definition",
};

export const TSX_DIALECT: Dialect = {
  languageId: "tsx",
  extensions: [".tsx"],
  supportLevel: "deep",
  grammar: { moduleName: "tree-sitter-typescript", exportName: "tsx" },
  hasTypes: true,
  fieldDefinitionKind: "public_field_definition",
};

export const JAVASCRIPT_DIALECT: Dialect = {
  languageId: "javascript",
  extensions: [".js", ".mjs", ".cjs"],
  supportLevel: "deep",
  grammar: { moduleName: "tree-sitter-javascript" },
  hasTypes: false,
  fieldDefinitionKind: "field_definition",
};

export const JSX_DIALECT: Dialect = {
  languageId: "jsx",
  extensions: [".jsx"],
  supportLevel: "deep",
  // tree-sitter-javascript's single grammar already parses JSX syntax
  // (verified empirically — see README "Grammatik-Wahl"); JSX gets its own
  // languageId/extension per spec.md §7.2's MVP table row ("TSX/JSX"), not
  // its own grammar.
  grammar: { moduleName: "tree-sitter-javascript" },
  hasTypes: false,
  fieldDefinitionKind: "field_definition",
};
