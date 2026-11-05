import { createRequire } from "node:module";

import type {
  AstRegion,
  ComplexityFacts,
  LanguageAdapter,
  ParseDiagnostic,
  ParsedAst,
  ParseResult,
  SourceFile,
  SourceRange,
} from "@untangle-code/domain";
import { AdapterParseError, sha256Hex } from "@untangle-code/domain";
import type { SFCBlock, SFCParseResult, SFCScriptBlock } from "@vue/compiler-sfc";
import type * as VueCompiler from "@vue/compiler-sfc";

import { buildByteOffsetTable } from "../../text/byte-offset-table.js";
import { createJavaScriptAdapter } from "../javascript/index.js";
import { createJsxAdapter } from "../jsx/index.js";
import { MAX_PARSE_SOURCE_BYTES } from "../shared/parse-limits.js";
import { createTsxAdapter } from "../tsx/index.js";
import { createTypeScriptAdapter } from "../typescript/index.js";

import { shiftVueRange, vueFacts, vueRegion, vueScopeId, vueSymbol } from "./mapping.js";

export { shiftVueRange, vueQualifiedName, vueScopeId } from "./mapping.js";

export interface VueScriptAst {
  context: "script" | "setup";
  /** Only dual-script SFCs need explicit context names to keep equal bindings distinct. */
  qualifier: string;
  adapter: LanguageAdapter;
  ast: ParsedAst;
  source: SourceFile;
  /** Content range in the original SFC, not the surrounding script tags. */
  range: SourceRange;
}

export interface VueAstRoot {
  kind: "vue-sfc";
  fileId: string;
  range: SourceRange;
  scripts: VueScriptAst[];
}

const require = createRequire(import.meta.url);
let parseSfc:
  | ((
      source: string,
      options: { filename: string; sourceMap: false; ignoreEmpty: false },
    ) => SFCParseResult)
  | undefined;

function parseDescriptor(source: SourceFile): SFCParseResult {
  // Loading the registry must not load Vue's compiler or any native grammar.
  parseSfc ??= (require("@vue/compiler-sfc") as typeof VueCompiler).parse;
  return parseSfc(source.content, { filename: source.path, sourceMap: false, ignoreEmpty: false });
}

function rootOf(ast: ParsedAst): VueAstRoot {
  return ast.root as VueAstRoot;
}

function emptyFacts(diagnostics: ParseDiagnostic[]): ComplexityFacts {
  return {
    symbolScopes: [],
    decisions: [],
    nestingEvents: [],
    operators: [],
    operands: [],
    nodeKinds: [],
    comments: [],
    identifiers: [],
    literals: [],
    parseDiagnostics: diagnostics,
  };
}

function combinedFacts(ast: ParsedAst): ComplexityFacts {
  const root = rootOf(ast);
  const facts = emptyFacts(ast.diagnostics);
  // A template-only component has no executable-code scope and no invented base complexity.
  if (root.scripts.length === 0) return facts;
  facts.symbolScopes.push({
    symbolScopeId: root.fileId,
    name: "",
    qualifiedName: "",
    kind: "file",
    range: root.range,
    executable: true,
  });
  for (const script of root.scripts) {
    const part = vueFacts(script, root.fileId);
    facts.symbolScopes.push(...part.symbolScopes);
    facts.decisions.push(...part.decisions);
    facts.nestingEvents.push(...part.nestingEvents);
    facts.operators.push(...part.operators);
    facts.operands.push(...part.operands);
    facts.nodeKinds.push(...part.nodeKinds);
    facts.comments.push(...part.comments);
    facts.identifiers.push(...part.identifiers);
    facts.literals.push(...part.literals);
  }
  return facts;
}

function blockRange(source: SourceFile, block: Pick<SFCBlock, "loc">): SourceRange {
  const offsets = buildByteOffsetTable(source.content);
  return {
    startLine: block.loc.start.line,
    endLine: block.loc.end.line,
    startByte: offsets.toByteOffset(block.loc.start.offset),
    endByte: offsets.toByteOffset(block.loc.end.offset),
  };
}

function diagnostic(
  message: string,
  range: SourceRange,
  kind: ParseDiagnostic["kind"] = "fallback",
): ParseDiagnostic {
  return { severity: "warning", kind, message, range };
}

function parseVue(source: SourceFile, adapters: ReadonlyMap<string, LanguageAdapter>): ParseResult {
  const bytes = Buffer.byteLength(source.content, "utf8");
  if (bytes > MAX_PARSE_SOURCE_BYTES) {
    throw new AdapterParseError("file_too_large", "Vue SFC exceeds the parser source-byte limit.", {
      measurements: { sizeBytes: bytes, limitBytes: MAX_PARSE_SOURCE_BYTES },
    });
  }
  const parsed = parseDescriptor(source);
  const range: SourceRange = {
    startByte: 0,
    endByte: bytes,
    startLine: 1,
    endLine: source.content.split("\n").length,
  };
  const diagnostics: ParseDiagnostic[] = parsed.errors.map((error) => ({
    severity: "error",
    kind: "error_node",
    message: `Vue SFC: ${error.message}`,
    range:
      "loc" in error && error.loc !== undefined ? blockRange(source, { loc: error.loc }) : range,
  }));
  let errorNodeCount = parsed.errors.length;
  let missingNodeCount = 0;
  let incomplete = parsed.errors.length > 0;
  const scripts: VueScriptAst[] = [];
  const descriptor = parsed.descriptor;
  const blocks: ["script" | "setup", SFCScriptBlock | null][] = [
    ["script", descriptor.script],
    ["setup", descriptor.scriptSetup],
  ];
  blocks.sort(
    (left, right) =>
      (left[1]?.loc.start.offset ?? Number.POSITIVE_INFINITY) -
      (right[1]?.loc.start.offset ?? Number.POSITIVE_INFINITY),
  );
  const dual = descriptor.script !== null && descriptor.scriptSetup !== null;
  if (dual && (descriptor.script?.lang ?? "js") !== (descriptor.scriptSetup?.lang ?? "js")) {
    incomplete = true;
    diagnostics.push(
      diagnostic(
        "Vue script and script setup must use the same language; cross-block compilation is not validated.",
        range,
      ),
    );
  }
  for (const [context, block] of blocks) {
    if (block === null) continue;
    const partRange = blockRange(source, block);
    const lang = block.lang ?? "js";
    const adapter = adapters.get(lang);
    if (block.src !== undefined || adapter === undefined) {
      incomplete = true;
      diagnostics.push(
        diagnostic(
          block.src !== undefined
            ? `Vue ${context}: external script src is not analyzed; analyze its source file separately.`
            : `Vue ${context}: unsupported script language "${lang}".`,
          partRange,
        ),
      );
      continue;
    }
    const scriptSource: SourceFile = {
      ...source,
      fileId: `${source.fileId}\u001fvue-${context}`,
      languageId: adapter.languageId,
      content: block.content,
      contentHash: sha256Hex(block.content),
      sizeBytes: Buffer.byteLength(block.content, "utf8"),
    };
    const part = adapter.parse(scriptSource);
    const script = {
      context,
      qualifier: dual ? context : "",
      adapter,
      source: scriptSource,
      range: partRange,
    };
    diagnostics.push(
      ...part.diagnostics.map((item) => ({
        ...item,
        range: shiftVueRange(script, item.range),
      })),
    );
    errorNodeCount += part.errorNodeCount;
    missingNodeCount += part.missingNodeCount;
    incomplete ||= part.parseQuality !== "complete";
    if (part.ast !== null) scripts.push({ ...script, ast: part.ast });
  }
  if (blocks.every(([, block]) => block === null)) {
    incomplete = true;
    diagnostics.push(
      diagnostic("Vue SFC contains no inline script; template logic is not analyzed.", range),
    );
  }
  // Valid syntax is distinct from analysis scope: these warnings do not invent syntax errors.
  const unmeasuredBlocks = [descriptor.template, ...descriptor.styles, ...descriptor.customBlocks];
  for (const block of unmeasuredBlocks) {
    if (block === null) continue;
    diagnostics.push({
      ...diagnostic(
        `Vue analysis scope: inline script code only; ${block.type} block complexity and runtime bindings are not measured. The original block remains text-searchable.`,
        blockRange(source, block),
        "other",
      ),
      code: "analysis_scope_limited",
    });
  }
  const parseQuality = incomplete ? "partial" : "complete";
  const ast: ParsedAst = {
    languageId: "vue",
    parseQuality,
    diagnostics,
    root: { kind: "vue-sfc", fileId: source.fileId, range, scripts } satisfies VueAstRoot,
  };
  return { parseQuality, ast, diagnostics, errorNodeCount, missingNodeCount };
}

/** Vue SFC adapter: source-level inline scripts, never generated render/setup code. */
export function createVueAdapter(): LanguageAdapter {
  const adapters = new Map([
    ["js", createJavaScriptAdapter()],
    ["javascript", createJavaScriptAdapter()],
    ["ts", createTypeScriptAdapter()],
    ["typescript", createTypeScriptAdapter()],
    ["tsx", createTsxAdapter()],
    ["jsx", createJsxAdapter()],
  ]);
  const cache = new WeakMap<ParsedAst, ComplexityFacts>();
  const facts = (ast: ParsedAst): ComplexityFacts => {
    const previous = cache.get(ast);
    if (previous !== undefined) return previous;
    const computed = combinedFacts(ast);
    cache.set(ast, computed);
    return computed;
  };
  return {
    languageId: "vue",
    extensions: [".vue"],
    supportLevel: "structural",
    parse: (source) => parseVue(source, adapters),
    extractChunks(ast): AstRegion[] {
      const root = rootOf(ast);
      const children = root.scripts
        .flatMap((script) =>
          script.adapter
            .extractChunks(script.ast)
            .flatMap((region) => region.children ?? [])
            .map((region) => vueRegion(script, region, root.fileId)),
        )
        .sort((left, right) => left.range.startByte - right.range.startByte);
      return [
        {
          chunkKind: "module",
          range: root.range,
          scopeId: root.fileId,
          splittable: children.length > 0,
          children,
        },
      ];
    },
    extractSymbols: (ast) =>
      rootOf(ast).scripts.flatMap((script) =>
        script.adapter.extractSymbols(script.ast).map((symbol) => vueSymbol(script, symbol)),
      ),
    extractImports: (ast) =>
      rootOf(ast).scripts.flatMap((script) =>
        script.adapter
          .extractImports(script.ast)
          .map((item) => ({ ...item, range: shiftVueRange(script, item.range) })),
      ),
    extractCalls: (ast) => {
      const root = rootOf(ast);
      return root.scripts.flatMap((script) =>
        script.adapter.extractCalls(script.ast).map((call) => ({
          ...call,
          callerScopeId: vueScopeId(script, call.callerScopeId, root.fileId),
          range: shiftVueRange(script, call.range),
        })),
      );
    },
    computeComplexity: facts,
    tokenizeForHalstead(ast) {
      const { operators, operands } = facts(ast);
      return { operators, operands };
    },
  };
}
