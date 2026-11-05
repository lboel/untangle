/**
 * AstRegion tree construction from the `ScopeNode` tree (spec.md §8.2-§8.3).
 *
 * One `AstRegion` of kind `"module"` is returned, spanning the whole file,
 * with a nested `children` tree the chunker descends into for large symbols
 * (spec.md §8.3 step 6) — see domain `analysis.ts` `AstRegion.children` doc.
 *
 * `ChunkKind` (domain `types/common.ts`, spec.md §8.2) has no `"namespace"`
 * member; a TS `namespace`/`module` scope maps to `"module"` (documented
 * WP-06 decision, README "Entscheidungen") since it is itself a nested
 * module-like grouping of symbols.
 */
import type { AstRegion, ChunkKind, SourceRange } from "@untangle-code/domain";
import { UntangleError } from "@untangle-code/domain";

import type { FileTextContext } from "./node-utils.js";
import { rangeOf, unionRange } from "./node-utils.js";
import type { LanguageProfile } from "./profile.js";
import type { ScopeNode } from "./scope-model.js";
import type { SyntaxNode } from "./syntax.js";

function chunkKindOf(kind: ScopeNode["kind"]): ChunkKind {
  switch (kind) {
    case "function":
      return "function";
    case "method":
      return "method";
    case "constructor":
      return "constructor";
    case "class":
      return "class_overview";
    case "interface":
      return "interface";
    case "type":
      return "type";
    case "enum":
      return "enum";
    case "namespace":
    case "file":
      return "module";
    case "property":
      // Individual properties never reach here directly — see groupProperties.
      return "property_group";
  }
}

/**
 * The full source span a symbol's chunk should carry: the scope node itself,
 * widened to the wrapping `export` statement (`export function f ...` —
 * the scope node is only the declaration, but the `export` keyword bytes
 * belong to the symbol's chunk, not to an interstitial module gap) and to
 * the bound doc/decorator range (spec.md §8.3 step 2).
 */
function ownRange(scope: ScopeNode, ctx: FileTextContext, profile: LanguageProfile): SourceRange {
  let range = scope.range;
  const parent = scope.node.parent;
  if (parent !== null && profile.exportWrapperKinds.has(parent.type)) {
    range = unionRange(rangeOf(parent, ctx), range);
  }
  return scope.docRange !== undefined ? unionRange(scope.docRange, range) : range;
}

/**
 * Regionen fuer Inhalt, der KEINEN Scope oeffnet, aber Bytes traegt (JS/TS:
 * `static { ... }` im Klassenrumpf). Welche Knoten das sind, weiss das
 * Sprachprofil, nicht diese Datei — sonst stuende hier je Sprache eine weitere
 * verdrahtete Knotenart. Ohne diese Regionen fielen ihre Bytes durch den
 * Mitgliederlauf; spec.md §8.4 verbietet genau das (kein stiller Datenverlust).
 */
function extraMemberRegions(
  scopeNode: SyntaxNode,
  parentScopeId: string,
  ctx: FileTextContext,
  profile: LanguageProfile,
): AstRegion[] {
  return profile.memberRegions(scopeNode, parentScopeId, ctx).map((member) => ({
    chunkKind: "property_group" as const,
    range: member.range,
    scopeId: member.scopeId,
    headerText: member.headerText,
    splittable: false,
  }));
}

function toRegion(
  scope: ScopeNode,
  groupOrdinal: { next: number },
  ctx: FileTextContext,
  profile: LanguageProfile,
): AstRegion {
  let children = buildChildRegions(scope.children, scope.scopeId, groupOrdinal, ctx, profile);
  if (scope.kind === "class") {
    const extras = extraMemberRegions(scope.node, scope.scopeId, ctx, profile);
    if (extras.length > 0) {
      children = [...children, ...extras].sort((a, b) => a.range.startByte - b.range.startByte);
    }
  }
  const headerText = scope.signature ?? scope.normalizedSignature;
  return {
    chunkKind: chunkKindOf(scope.kind),
    range: ownRange(scope, ctx, profile),
    scopeId: scope.scopeId,
    ...(scope.qualifiedName.length > 0 ? { symbolFqn: scope.qualifiedName } : {}),
    ...(headerText !== undefined && headerText.length > 0 ? { headerText } : {}),
    splittable: children.length > 0,
    ...(children.length > 0 ? { children } : {}),
  };
}

/**
 * Exported (in addition to being called from {@link buildChildRegions})
 * so `chunks.test.ts` can exercise the WP-73 empty-list guard directly:
 * `buildChildRegions`'s own `flushProperties` never calls this with an
 * empty `properties` array, so that path cannot be reached end-to-end
 * through `buildFileRegion` alone.
 */
export function propertyGroupRegion(
  properties: ScopeNode[],
  parentScopeId: string,
  ordinal: number,
  ctx: FileTextContext,
  profile: LanguageProfile,
): AstRegion {
  const [firstProperty, ...restProperties] = properties;
  if (firstProperty === undefined) {
    // WP-73: `properties` must never be empty — the only caller
    // (`flushProperties`) already guards on `pendingProperties.length === 0`
    // and never reaches this function otherwise. An empty list here means
    // that invariant was violated by a future caller; there is no
    // meaningful `SourceRange` for zero properties, so this is an honest
    // internal-defect report (E4) rather than a defined empty-range value
    // that would silently mask the bug, and rather than the bare
    // `Array.prototype.reduce` `TypeError: Reduce of empty array with no
    // initial value` a caller would otherwise see.
    throw new UntangleError(
      "ANALYSIS_INCOMPLETE",
      "propertyGroupRegion called with an empty properties list — a property_group region requires at least one property (spec.md §8.3)",
      {
        retryable: false,
        operation: "chunk",
        context: { parentScopeId, ordinal },
      },
    );
  }
  const range = restProperties.reduce(
    (acc, property) => unionRange(acc, ownRange(property, ctx, profile)),
    ownRange(firstProperty, ctx, profile),
  );
  return {
    chunkKind: "property_group",
    range,
    scopeId: `${parentScopeId}#properties#${ordinal}`,
    splittable: false,
  };
}

/** Builds child regions for one scope, merging consecutive `property` children into `property_group`s. */
function buildChildRegions(
  children: ScopeNode[],
  parentScopeId: string,
  groupOrdinal: { next: number },
  ctx: FileTextContext,
  profile: LanguageProfile,
): AstRegion[] {
  const regions: AstRegion[] = [];
  let pendingProperties: ScopeNode[] = [];

  const flushProperties = (): void => {
    if (pendingProperties.length === 0) return;
    regions.push(
      propertyGroupRegion(pendingProperties, parentScopeId, groupOrdinal.next, ctx, profile),
    );
    groupOrdinal.next += 1;
    pendingProperties = [];
  };

  for (const child of children) {
    if (child.kind === "property") {
      pendingProperties.push(child);
      continue;
    }
    flushProperties();
    regions.push(toRegion(child, groupOrdinal, ctx, profile));
  }
  flushProperties();
  return regions;
}

/** Leading file content (shebang/header comments/imports) before the first top-level region, if non-trivial. */
/** Builds the single root ("module") `AstRegion` for a whole file. */
export function buildFileRegion(
  fileScope: ScopeNode,
  ctx: FileTextContext,
  profile: LanguageProfile,
): AstRegion {
  const groupOrdinal = { next: 0 };
  const topLevelRegions = buildChildRegions(
    fileScope.children,
    fileScope.scopeId,
    groupOrdinal,
    ctx,
    profile,
  );

  const firstRegion = topLevelRegions[0];
  const preamble =
    firstRegion !== undefined ? buildFilePreambleRegion(fileScope, firstRegion, ctx) : null;
  const allChildren = preamble !== null ? [preamble, ...topLevelRegions] : topLevelRegions;

  return {
    chunkKind: "module",
    range: fileScope.range,
    scopeId: fileScope.scopeId,
    splittable: allChildren.length > 0,
    ...(allChildren.length > 0 ? { children: allChildren } : {}),
  };
}

function buildFilePreambleRegion(
  fileScope: ScopeNode,
  firstChild: AstRegion,
  ctx: FileTextContext,
): AstRegion | null {
  if (firstChild.range.startByte <= fileScope.range.startByte) return null;
  const rawPreamble = ctx.sourceText.slice(
    0,
    indexForByteOffsetApprox(ctx, firstChild.range.startByte),
  );
  if (rawPreamble.trim().length === 0) return null;
  return {
    chunkKind: "file_preamble",
    range: {
      startLine: fileScope.range.startLine,
      endLine: firstChild.range.startLine,
      startByte: fileScope.range.startByte,
      endByte: firstChild.range.startByte,
    },
    scopeId: fileScope.scopeId,
    splittable: false,
  };
}

// Approximates a UTF-16 slice index for a byte offset by scanning the
// (small, preamble-sized) prefix — the preamble is always near the top of
// the file, so this is O(preamble length), not O(file length).
function indexForByteOffsetApprox(ctx: FileTextContext, byteOffset: number): number {
  let low = 0;
  let high = ctx.sourceText.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (ctx.byteTable.toByteOffset(mid) < byteOffset) low = mid + 1;
    else high = mid;
  }
  return low;
}
