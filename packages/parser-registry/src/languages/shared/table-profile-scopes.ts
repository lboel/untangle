/** Scope-, Namens-, Signatur- und Dokumentationsregeln des Tabellenprofils. */
import type { SourceRange } from "@untangle-code/domain";

import type { FileTextContext } from "./node-utils.js";
import { commentRangeOf, unionRange, unquote } from "./node-utils.js";
import type { ScopeSignature } from "./profile.js";
import type { ScopeNode } from "./scope-model.js";
import { normalizeSpacing } from "./signature.js";
import type { SyntaxNode } from "./syntax.js";
import {
  firstChildOfKind,
  firstChildOfKinds,
  firstDescendantOfKinds,
  setOf,
} from "./table-profile-queries.js";
import type { LanguageKindTable, ScopeRule } from "./table-profile.js";

const ANONYMOUS_NAME = "<anonymous>";
const MAX_DOC_GAP_LINES = 1;
const MAX_NAME_FIELD_DESCENT = 16;

/**
 * Kompiliert nur die Scope-Seite einer Sprachtabelle. Der vereinheitlichte
 * Walk kennt dadurch weder Namenspfade noch Sichtbarkeits- oder Doc-Regeln.
 */
export class TableScopeResolver {
  readonly functionLikeKinds = new Set<string>();
  readonly nodeKinds: ReadonlySet<string>;

  private readonly ruleByNodeKind = new Map<string, ScopeRule>();
  private readonly visibilityKinds: ReadonlySet<string>;
  private readonly visibilityWords: ReadonlySet<string>;
  private readonly bodyField: string;

  constructor(
    private readonly table: LanguageKindTable,
    private readonly commentKinds: ReadonlySet<string>,
  ) {
    this.visibilityKinds = setOf(table.visibilityKinds);
    this.visibilityWords = setOf(table.visibilityWords);
    this.bodyField = table.bodyField ?? "body";
    for (const rule of table.scopes) this.registerRule(rule);
    this.nodeKinds = new Set(this.ruleByNodeKind.keys());
  }

  private registerRule(rule: ScopeRule): void {
    for (const kind of rule.kinds) {
      this.ruleByNodeKind.set(kind, rule);
      if (rule.scopeKind === "function" || rule.scopeKind === "method") {
        this.functionLikeKinds.add(kind);
      }
    }
  }

  /** Einem Feldpfad und optional der wiederholten letzten Kante folgen. */
  private resolveNameField(node: SyntaxNode, rule: ScopeRule): SyntaxNode | null {
    let base: SyntaxNode | null = node;
    for (const kind of rule.nameKindPath ?? []) {
      base = firstChildOfKind(base, kind);
      if (base === null) return null;
    }

    const path = (rule.nameField ?? "name").split(".");
    let found: SyntaxNode | null = base;
    for (const field of path) {
      found = found.childForFieldName(field);
      if (found === null) return this.nameKindFallback(base, rule);
    }
    return rule.nameDescend === true
      ? this.descendRepeatedNameField(found, path.at(-1) as string)
      : found;
  }

  private nameKindFallback(base: SyntaxNode, rule: ScopeRule): SyntaxNode | null {
    return rule.nameKinds === undefined ? null : firstChildOfKinds(base, setOf(rule.nameKinds));
  }

  private descendRepeatedNameField(start: SyntaxNode, field: string): SyntaxNode {
    let current = start;
    for (let depth = 0; depth < MAX_NAME_FIELD_DESCENT; depth += 1) {
      const next = current.childForFieldName(field);
      if (next === null) return current;
      current = next;
    }
    return current;
  }

  nameOf(node: SyntaxNode): string {
    const rule = this.ruleByNodeKind.get(node.type);
    if (rule === undefined) return ANONYMOUS_NAME;
    const byField = this.resolveNameField(node, rule);
    if (byField !== null) return unquote(byField.text);
    const byKind = this.nameKindFallback(node, rule);
    return byKind === null ? ANONYMOUS_NAME : unquote(byKind.text);
  }

  /** Struktureller Traegername fuer Go-Methoden (WP-237). */
  qualifierOf(node: SyntaxNode): string | undefined {
    const rule = this.ruleByNodeKind.get(node.type);
    if (rule?.qualifierField === undefined || rule.qualifierNameKinds === undefined) {
      return undefined;
    }
    const field = node.childForFieldName(rule.qualifierField);
    if (field === null) return undefined;
    const qualifier = firstDescendantOfKinds(field, setOf(rule.qualifierNameKinds));
    return qualifier === null ? undefined : unquote(qualifier.text);
  }

  kindOf(node: SyntaxNode): ScopeNode["kind"] | null {
    const rule = this.ruleByNodeKind.get(node.type);
    if (
      rule === undefined ||
      !this.hasAllowedParent(node, rule) ||
      !this.hasAllowedAncestor(node, rule)
    ) {
      return null;
    }
    if (rule.constructorNames?.includes(this.nameOf(node)) === true) return "constructor";
    return this.refinedKindOf(node, rule) ?? rule.scopeKind;
  }

  private hasAllowedParent(node: SyntaxNode, rule: ScopeRule): boolean {
    if (rule.parentKinds === undefined) return true;
    const parentKind = node.parent?.type;
    return parentKind !== undefined && rule.parentKinds.includes(parentKind);
  }

  private hasAllowedAncestor(node: SyntaxNode, rule: ScopeRule): boolean {
    if (rule.ancestorKinds === undefined) return true;
    let ancestor = node.parent;
    while (ancestor !== null) {
      if (rule.ancestorKinds.includes(ancestor.type)) return true;
      ancestor = ancestor.parent;
    }
    return false;
  }

  private refinedKindOf(node: SyntaxNode, rule: ScopeRule): ScopeNode["kind"] | undefined {
    for (const refinement of rule.refine ?? []) {
      if (firstChildOfKinds(node, setOf(refinement.childKinds)) !== null) {
        return refinement.scopeKind;
      }
    }
    return undefined;
  }

  signatureOf(node: SyntaxNode): ScopeSignature {
    const body = node.childForFieldName(this.bodyField);
    const raw =
      body === null
        ? (node.text.split("\n")[0]?.trim() ?? node.text)
        : node.text.slice(0, Math.max(0, body.startIndex - node.startIndex)).trimEnd();
    return { raw, normalized: normalizeSpacing(raw) };
  }

  /** Der unmittelbar vorangehende Kommentarblock eines Symbols. */
  docRangeOf(node: SyntaxNode, ctx: FileTextContext): SourceRange | undefined {
    const anchor = this.docAnchorOf(node);
    let boundary: SyntaxNode = anchor;
    let previous = anchor.previousSibling;
    let docRange: SourceRange | undefined;
    while (previous !== null && this.commentKinds.has(previous.type)) {
      const commentRange = commentRangeOf(previous, ctx);
      const gap = boundary.startPosition.row + 1 - commentRange.endLine;
      if (gap > MAX_DOC_GAP_LINES) break;
      docRange = docRange === undefined ? commentRange : unionRange(commentRange, docRange);
      boundary = previous;
      previous = previous.previousSibling;
    }
    return docRange;
  }

  /**
   * Go legt Kommentare vor `type_declaration`, den Scope aber unter
   * `type_spec` ab. Solange ein Knoten das einzige benannte Kind ist, steht
   * deshalb seine Huelle fuer ihn; die Wurzel wird nie zum Anker.
   */
  private docAnchorOf(node: SyntaxNode): SyntaxNode {
    let anchor = node;
    for (;;) {
      const parent = anchor.parent;
      if (parent === null || parent.parent === null || parent.namedChildCount !== 1) return anchor;
      anchor = parent;
    }
  }

  visibilityOf(node: SyntaxNode): string | undefined {
    if (this.visibilityKinds.size === 0) return undefined;
    const modifier = firstChildOfKinds(node, this.visibilityKinds);
    if (modifier === null) return undefined;
    if (this.visibilityWords.size === 0) return modifier.text;
    return modifier.text.split(/\s+/).find((word) => this.visibilityWords.has(word));
  }

  exportedNamesOf(node: SyntaxNode, name: string): string[] {
    return this.table.isExported?.(name, node) === true ? [name] : [];
  }
}
