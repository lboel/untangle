/**
 * Analysis contracts shared by parser-registry, chunker and complexity
 * (architecture.md §6.5, §6.7, §14.1, §15.1).
 *
 * ARCHITECTURE DECISION (documented in README, "Entscheidungen"): contrary to
 * architecture.md §6.5, which places `LanguageAdapter` inside the
 * parser-registry package, the INTERFACE lives here in domain so that
 * chunker, complexity and parser-registry can be built in parallel without
 * drift. parser-registry implements it; nobody redefines it.
 */
import type { ChunkKind, ParseQuality, SourceRange, SupportLevel } from "./types/common.js";

// ---------------------------------------------------------------------------
// Parsing (architecture.md §6.5)
// ---------------------------------------------------------------------------

/** Input to a language adapter: one decoded source file. */
export interface SourceFile {
  fileId: string;
  repoId: string;
  refId: string;
  /** "/"-normalized path relative to the repository root. */
  path: string;
  languageId: string;
  /** Full UTF-8 decoded content. */
  content: string;
  /** SHA-256 of the raw content. */
  contentHash: string;
  sizeBytes: number;
}

/** Diagnostic emitted while parsing (architecture.md §15.1). */
export interface ParseDiagnostic {
  /** Stable optional classification for limitations independent of syntax validity. */
  code?: string;
  severity: "error" | "warning";
  /** Diagnostic origin kind. */
  kind: "error_node" | "missing_node" | "fallback" | "other";
  message: string;
  range: SourceRange;
}

/**
 * Parsed AST handle. `root` is deliberately opaque: the domain must not
 * depend on tree-sitter/ast-grep node APIs (architecture.md §6.5) — only the
 * producing language adapter looks inside.
 */
export interface ParsedAst {
  languageId: string;
  parseQuality: ParseQuality;
  /** Backend-specific root node; owned and interpreted by the adapter only. */
  root: unknown;
  diagnostics: ParseDiagnostic[];
}

/** Result of `LanguageAdapter.parse` (spec.md §7.3). */
export interface ParseResult {
  parseQuality: ParseQuality;
  /** Present for "complete" and "partial"; null for "failed" (text fallback). */
  ast: ParsedAst | null;
  diagnostics: ParseDiagnostic[];
  errorNodeCount: number;
  missingNodeCount: number;
}

// ---------------------------------------------------------------------------
// Extraction outputs (architecture.md §6.5)
// ---------------------------------------------------------------------------

/**
 * An AST region proposed for chunking (architecture.md §6.6). The chunker
 * turns regions into `CodeChunkDraft`s and enforces the lossless coverage
 * invariant (spec.md §8.4).
 *
 * REGION CONTRACT (normative for every adapter and for the chunker — this
 * doc comment is the single place where the seam between
 * `LanguageAdapter.extractChunks` and the chunker is defined):
 *
 * 1. `extractChunks` returns EXACTLY ONE root region with
 *    `chunkKind: "module"` spanning the whole file. Its `children` form the
 *    nested symbol-region tree: an optional `file_preamble` region, the
 *    top-level symbol regions, and — recursively — class members, nested
 *    classes/namespaces and further AST sub-blocks of large symbols
 *    (spec.md §8.3 step 6).
 * 2. The CHUNKER unpacks the root region and dispatches on `chunkKind` at
 *    EVERY depth, not only at the top level. This variant was chosen over
 *    "adapters deliver top-level symbol regions flat" because nested
 *    symbols (methods inside classes, classes inside namespaces, local
 *    functions) sit below the top level anyway — a flat contract would just
 *    push the same recursion into every adapter and make the root/file
 *    span implicit. With one spanning root, the adapter states the full
 *    file range explicitly and the chunker owns all budget decisions.
 * 3. Every region that corresponds to a symbol MUST carry `symbolFqn`
 *    matching the `qualifiedName` of the corresponding `ExtractedSymbol`
 *    from the same parse — that join is how the chunker attaches
 *    `symbolId`/`symbolFqn` to whole-symbol chunks AND to every
 *    `symbol_fragment` of a symbol split across the token budget
 *    (spec.md §8.5).
 * 4. Adapters SHOULD model non-symbol constructs that carry content (e.g.
 *    `class_static_block`) as explicit child regions, but need not model
 *    every interstitial byte (comments between members, delimiters). Bytes
 *    inside a parent region that no child region covers are the CHUNKER's
 *    responsibility: it must either emit them as real content chunks or
 *    record them as "excluded" coverage entries with a reason — never drop
 *    them silently (spec.md §8.4, vision.md §8.4).
 */
export interface AstRegion {
  /** Proposed chunk kind for this region. */
  chunkKind: ChunkKind;
  range: SourceRange;
  /** Stable scope id for chunk identity (symbol id, or file id for file scope). */
  scopeId: string;
  symbolId?: string;
  symbolFqn?: string;
  /** Signature/symbol header to prepend on fragments (spec.md §8.5). */
  headerText?: string;
  /** Whether the region can be split further along AST child boundaries. */
  splittable: boolean;
  /** Child regions for recursive splitting of large symbols (spec.md §8.3 step 6). */
  children?: AstRegion[];
}

/** A symbol extracted by a language adapter (architecture.md §6.5). */
export interface ExtractedSymbol {
  name: string;
  qualifiedName: string;
  /** Language-adapter symbol kind, e.g. "function", "class", "method". */
  kind: string;
  /** Signature as written, when available. */
  signature?: string;
  /** Signature normalized for identity (spec.md §5.5). */
  normalizedSignature: string;
  range: SourceRange;
  /** Doc comment / decorator range bound to this symbol (spec.md §8.3 step 2). */
  docRange?: SourceRange;
  /** Qualified name of the enclosing symbol, when nested. */
  parentQualifiedName?: string;
  exportedNames: string[];
  visibility?: string;
  /** AST-shape fingerprint (change matching, spec.md §17.3). */
  astHash: string;
  /** Token-level fingerprint (change matching, spec.md §17.3). */
  tokenFingerprint: string;
}

/** Import kind of a raw import (spec.md §14.2). */
export type RawImportKind = "import" | "re_export" | "dynamic_import" | "package_dependency";

/**
 * Bindungsformen eines Imports.
 *
 * - `named`: `import { a } from "m"` / `from m import a` — der Name im
 *   Zielmodul steht in `importedName`.
 * - `default`: `import a from "m"` — gebunden wird der Vorgabeexport;
 *   `importedName` ist `"default"`.
 * - `namespace`: `import * as a from "m"` / `import m.sub as a` — gebunden
 *   wird das MODUL, kein einzelner Export; `importedName` fehlt.
 * - `wildcard`: `from m import *` — jeder exportierte Name wird gebunden;
 *   `localName` ist `"*"`, `importedName` fehlt.
 */
export const RAW_IMPORT_BINDING_KINDS = ["named", "default", "namespace", "wildcard"] as const;

export type RawImportBindingKind = (typeof RAW_IMPORT_BINDING_KINDS)[number];

/**
 * EINE Namensbindung eines Importsatzes.
 *
 * WARUM DIESER TYP EXISTIERT: `RawImport.importedNames` traegt nur den LOKALEN
 * Namen. Bei `import { run as go } from "./lib"` steht dort `"go"` — der Name
 * im Zielmodul (`"run"`) ist verloren. Jeder Verbraucher, der den lokalen
 * Namen gegen die Exporte der Zieldatei haelt, loest solche Aufrufe auf das
 * FALSCHE Symbol auf und kann das nicht einmal bemerken. Die Zuordnung
 * lokal → importiert gehoert deshalb in den Adaptervertrag; sie ist im
 * Syntaxbaum vorhanden und nirgends sonst rekonstruierbar.
 */
export interface RawImportBinding {
  /** Name, unter dem die Bindung in der importierenden Datei sichtbar ist. */
  localName: string;
  /**
   * Name IM ZIELMODUL. Gesetzt bei `named` (exportierter Name) und `default`
   * (immer `"default"`); fehlt bei `namespace` und `wildcard`, weil dort kein
   * einzelner Export gebunden wird.
   */
  importedName?: string;
  kind: RawImportBindingKind;
}

/** An unresolved import statement as written in the source (architecture.md §6.5). */
export interface RawImport {
  /** Import specifier as written, e.g. "./util", "react", "pkg.mod". */
  specifier: string;
  importKind: RawImportKind;
  /** Source position of the causing import statement (spec.md §14.2). */
  range: SourceRange;
  /**
   * LOKALE Bindungsnamen, in Quelltextreihenfolge. Bei einem Alias steht hier
   * der lokale Name, NICHT der Name im Zielmodul — wer die Zuordnung braucht,
   * liest {@link RawImport.bindings}.
   */
  importedNames?: string[];
  /**
   * Vollstaendige Bindungen des Satzes, indexgleich zu `importedNames`.
   * Optional, weil aeltere Adapter sie nicht liefern: FEHLT das Feld, ist die
   * Alias-Zuordnung UNBEKANNT und ein Verbraucher darf aus Namensgleichheit
   * keinen Beweis ableiten.
   */
  bindings?: RawImportBinding[];
  /** TypeScript `import type` and friends. */
  typeOnly?: boolean;
}

/** An unresolved call site as written in the source (architecture.md §6.5). */
export interface RawCall {
  /** Callee name as written, unqualified. */
  calleeName: string;
  /** Qualifier when written as member call, e.g. "service" in "service.run()". */
  qualifier?: string;
  /** symbolScopeId of the enclosing symbol scope. */
  callerScopeId: string;
  range: SourceRange;
  argumentCount?: number;
}

// ---------------------------------------------------------------------------
// Complexity facts (architecture.md §15.1)
// ---------------------------------------------------------------------------

/** One symbol scope in a file (architecture.md §15.1; shape: Untangle decision). */
export interface SymbolScopeFact {
  /** Stable scope id, equal to the symbol id where one exists. */
  symbolScopeId: string;
  symbolId?: string;
  name: string;
  qualifiedName: string;
  kind: string;
  range: SourceRange;
  parentScopeId?: string;
  /** Whether the scope contains executable code (drives cyclomatic base of 1). */
  executable: boolean;
}

/** Decision fact kinds feeding cyclomatic classic/extended (spec.md §16.2–§16.3). */
export type DecisionKind =
  | "if"
  | "else_if"
  | "loop"
  | "catch"
  | "ternary"
  | "case"
  | "guard"
  | "logical_and"
  | "logical_or"
  | "pattern_alternative"
  | "short_circuit";

/** A decision point (architecture.md §15.1; shape: Untangle decision). */
export interface DecisionFact {
  kind: DecisionKind;
  range: SourceRange;
  symbolScopeId: string;
  /** Counts toward cyclomatic classic (spec.md §16.2). */
  countsForClassic: boolean;
  /** Counts toward cyclomatic extended (spec.md §16.3). */
  countsForExtended: boolean;
  /**
   * Group id for logical operator sequences: consecutive `&&`/`||` of one
   * independent decision group share an id (spec.md §16.3, §16.4).
   */
  logicalGroupId?: string;
}

/** A nesting event (architecture.md §15.1; shape: Untangle decision). */
export interface NestingFact {
  /** Nesting construct, e.g. "if", "loop", "catch", "lambda", "switch". */
  construct: string;
  range: SourceRange;
  symbolScopeId: string;
  /**
   * True for constructs treated as continuation (`else if`) that receive no
   * full new nesting increment (spec.md §16.4).
   */
  continuation: boolean;
}

/** An operator or operand occurrence for Halstead (architecture.md §15.1). */
export interface TokenFact {
  text: string;
  range: SourceRange;
  symbolScopeId: string;
}

/** One AST node kind occurrence for syntactic metrics (architecture.md §15.1). */
export interface NodeKindFact {
  kind: string;
  /** Depth of the node in the AST, root = 0. */
  depth: number;
  symbolScopeId: string;
}

/** An identifier occurrence (architecture.md §15.1). */
export interface IdentifierFact {
  name: string;
  range: SourceRange;
  symbolScopeId: string;
  role: "declaration" | "reference";
}

/** A literal occurrence (architecture.md §15.1). */
export interface LiteralFact {
  /** Raw literal text as written. */
  raw: string;
  literalKind: "number" | "string" | "boolean" | "null" | "regex" | "template" | "other";
  range: SourceRange;
  symbolScopeId: string;
}

/** Language-neutral complexity facts (architecture.md §15.1) — exact shape. */
export interface ComplexityFacts {
  symbolScopes: SymbolScopeFact[];
  decisions: DecisionFact[];
  nestingEvents: NestingFact[];
  operators: TokenFact[];
  operands: TokenFact[];
  nodeKinds: NodeKindFact[];
  comments: SourceRange[];
  identifiers: IdentifierFact[];
  literals: LiteralFact[];
  parseDiagnostics: ParseDiagnostic[];
}

/** Halstead token streams (architecture.md §6.5). */
export interface HalsteadTokens {
  operators: TokenFact[];
  operands: TokenFact[];
}

// ---------------------------------------------------------------------------
// Complexity IR (architecture.md §6.7)
// ---------------------------------------------------------------------------

/**
 * IR node kinds (set fixed here as an Untangle decision — architecture.md §6.7
 * names `IRKind` without enumerating it).
 */
export const IR_KINDS = [
  "root",
  "symbol",
  "block",
  "decision",
  "loop",
  "switch",
  "case",
  "catch",
  "ternary",
  "logical_sequence",
  "lambda",
  "statement",
  "expression",
  "jump",
  "recursion_marker",
  "other",
] as const;

export type IRKind = (typeof IR_KINDS)[number];

/** Language-neutral complexity IR node (architecture.md §6.7) — exact shape. */
export interface ComplexityIRNode {
  kind: IRKind;
  range: SourceRange;
  children: ComplexityIRNode[];
  decision?: DecisionFact;
  nestingBoundary?: boolean;
  operator?: string;
  operand?: string;
  symbolScopeId: string;
}

// ---------------------------------------------------------------------------
// Coverage ledger (architecture.md §14.1)
// ---------------------------------------------------------------------------

/** Coverage ledger entry (architecture.md §14.1) — exact shape. */
export interface CoverageEntry {
  range: SourceRange;
  status: "chunked" | "excluded";
  /** Required (non-empty) when status is "chunked". */
  chunkIds?: string[];
  /** Required when status is "excluded" (spec.md §8.4). */
  exclusionReason?: string;
}

// ---------------------------------------------------------------------------
// Language adapter (architecture.md §6.5)
// ---------------------------------------------------------------------------

/**
 * Language adapter contract (architecture.md §6.5) — exact shape.
 * Implemented by packages/parser-registry; consumed by chunker and complexity.
 * All methods are synchronous and pure with respect to their inputs.
 */
export interface LanguageAdapter {
  languageId: string;
  /** File extensions incl. leading dot, e.g. [".ts", ".mts"]. */
  extensions: string[];
  supportLevel: SupportLevel;
  parse(source: SourceFile): ParseResult;
  extractChunks(ast: ParsedAst): AstRegion[];
  extractSymbols(ast: ParsedAst): ExtractedSymbol[];
  extractImports(ast: ParsedAst): RawImport[];
  extractCalls(ast: ParsedAst): RawCall[];
  computeComplexity(ast: ParsedAst): ComplexityFacts;
  tokenizeForHalstead(ast: ParsedAst): HalsteadTokens;
}
