/**
 * tree-sitter node `.type` string constants shared by the JS/TS grammar
 * family (tree-sitter-javascript, tree-sitter-typescript `typescript` and
 * `tsx` dialects). Verified against each grammar's `src/node-types.json`
 * (see package README, "Grammatik-Wahl").
 *
 * A set may list a node kind that a particular dialect's grammar never
 * actually produces (e.g. `public_field_definition` never appears in a
 * plain JavaScript tree) — that is harmless: `Set#has` on a type string the
 * grammar never emits simply never matches.
 */

/**
 * Nodes whose entire subtree collapses to ONE operand/literal token (do not
 * recurse into children). `template_string` is deliberately EXCLUDED here
 * even though it is a literal: `${expr}` interpolations can contain calls,
 * identifiers and decisions that must still be walked (verified against the
 * grammar: a `template_string` node's children are `` ` ``, `string_fragment`,
 * `escape_sequence` and `template_substitution` — see `TEMPLATE_TEXT_LEAF_TYPES`
 * below, and the `` ` ``/`${` delimiters folded into `IGNORED_PUNCTUATION_TYPES`,
 * for how its non-substitution parts are classified instead).
 */
export const LITERAL_CONTAINER_STOP_TYPES: ReadonlySet<string> = new Set(["string", "regex"]);

/** Static-text leaves inside a `template_string` (its non-`${}` content) — operands. */
export const TEMPLATE_TEXT_LEAF_TYPES: ReadonlySet<string> = new Set([
  "string_fragment",
  "escape_sequence",
]);

/** Leaf node types that are identifier occurrences (operands). */
export const IDENTIFIER_LEAF_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "property_identifier",
  "type_identifier",
  "private_property_identifier",
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern",
  "statement_identifier",
  "this",
  "super",
]);

/** Leaf node types that are simple (non-container) literals. */
export const SIMPLE_LITERAL_LEAF_TYPES: ReadonlySet<string> = new Set([
  "number",
  "true",
  "false",
  "null",
  "undefined",
]);

/** Punctuation leaves that count neither as operator nor operand (pure structure). */
export const IGNORED_PUNCTUATION_TYPES: ReadonlySet<string> = new Set([
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  ",",
  ";",
  ".",
  "`",
  "${",
]);

/** Function-shaped scope node types (produce ExtractedSymbol kind "function"). */
export const FUNCTION_LIKE_TYPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "generator_function",
  "arrow_function",
]);

export const METHOD_TYPE = "method_definition";
export const CLASS_TYPES: ReadonlySet<string> = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "class",
]);
export const INTERFACE_TYPE = "interface_declaration";
export const TYPE_ALIAS_TYPE = "type_alias_declaration";
export const ENUM_TYPE = "enum_declaration";
export const NAMESPACE_TYPE = "internal_module";
export const FIELD_TYPES: ReadonlySet<string> = new Set([
  "field_definition",
  "public_field_definition",
]);

/**
 * `static { ... }` initialization block inside a class body. NOT a scope
 * opener (it declares no symbol and has no name to build a stable scope id
 * from) — but it carries executable content, so `chunks.ts` models it as an
 * explicit child region of its class so its bytes become a real content
 * chunk instead of falling through the chunker's member walk (spec.md §8.4:
 * no silent data loss).
 */
export const CLASS_STATIC_BLOCK_TYPE = "class_static_block";

/** All node types that open a new symbol scope (superset across dialects). */
export const SCOPE_OPENING_TYPES: ReadonlySet<string> = new Set([
  ...FUNCTION_LIKE_TYPES,
  METHOD_TYPE,
  ...CLASS_TYPES,
  INTERFACE_TYPE,
  TYPE_ALIAS_TYPE,
  ENUM_TYPE,
  NAMESPACE_TYPE,
  ...FIELD_TYPES,
]);

/** Decision-bearing node types (spec.md §16.2-16.3). */
export const IF_STATEMENT = "if_statement";
export const LOOP_TYPES: ReadonlySet<string> = new Set([
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
]);
export const CATCH_CLAUSE = "catch_clause";
export const TERNARY_EXPRESSION = "ternary_expression";
export const SWITCH_CASE = "switch_case";
export const SWITCH_STATEMENT = "switch_statement";
export const BINARY_EXPRESSION = "binary_expression";
export const AUGMENTED_ASSIGNMENT = "augmented_assignment_expression";

/** Jump statements used by the guard-clause heuristic. */
export const JUMP_STATEMENT_TYPES: ReadonlySet<string> = new Set([
  "return_statement",
  "throw_statement",
  "break_statement",
  "continue_statement",
]);

export const COMMENT_TYPE = "comment";
export const DECORATOR_TYPE = "decorator";

/** Import/export related node types (architecture.md §6.5, spec.md §14.2). */
export const IMPORT_STATEMENT = "import_statement";
export const IMPORT_CLAUSE = "import_clause";
export const IMPORT_REQUIRE_CLAUSE = "import_require_clause"; // TS only: `import x = require(...)`
export const NAMED_IMPORTS = "named_imports";
export const NAMESPACE_IMPORT = "namespace_import";
export const IMPORT_SPECIFIER = "import_specifier";
export const EXPORT_STATEMENT = "export_statement";
export const EXPORT_CLAUSE = "export_clause";
export const EXPORT_SPECIFIER = "export_specifier";
export const CALL_EXPRESSION = "call_expression";
export const NEW_EXPRESSION = "new_expression";
export const MEMBER_EXPRESSION = "member_expression";
export const IMPORT_KEYWORD_NODE = "import"; // the bare `import` token used in `import(...)` dynamic import
