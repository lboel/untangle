/** Entscheidungs- und Nestingauflösung des Tabellenprofils. */
import type { DecisionKind } from "@untangle-code/domain";

import type { DecisionDetectionResult, DetectedDecision } from "./decisions.js";
import type { SyntaxNode } from "./syntax.js";
import { firstChildOfKinds, setOf } from "./table-profile-queries.js";
import type { DecisionRules } from "./table-profile.js";

function branching(
  kind: DecisionKind,
  construct: string,
  continuation: boolean,
): DecisionDetectionResult {
  return {
    decision: { kind, countsForClassic: true, countsForExtended: true },
    nesting: { construct, continuation },
  };
}

function extendedOnly(kind: DecisionKind, logicalGroupId?: string): DecisionDetectionResult {
  const decision: DetectedDecision = {
    kind,
    countsForClassic: false,
    countsForExtended: true,
    ...(logicalGroupId === undefined ? {} : { logicalGroupId }),
  };
  return { decision };
}

/** Kompiliert ausschliesslich Kontrollflussregeln einer Sprachtabelle. */
export class TableDecisionDetector {
  readonly nodeKinds: ReadonlySet<string>;

  private readonly ifKinds: ReadonlySet<string>;
  private readonly elseIfParentKinds: ReadonlySet<string>;
  private readonly elseIfWrapperKinds: ReadonlySet<string>;
  private readonly elseIfKinds: ReadonlySet<string>;
  private readonly loopKinds: ReadonlySet<string>;
  private readonly catchKinds: ReadonlySet<string>;
  private readonly ternaryKinds: ReadonlySet<string>;
  private readonly switchKinds: ReadonlySet<string>;
  private readonly caseKinds: ReadonlySet<string>;
  private readonly caseExcludeChildKinds: ReadonlySet<string>;
  private readonly guardKinds: ReadonlySet<string>;
  private readonly patternAlternativeKinds: ReadonlySet<string>;
  private readonly shortCircuitKinds: ReadonlySet<string>;
  private readonly anonymousOperatorKinds: ReadonlySet<string>;
  private readonly binaryKinds: ReadonlySet<string>;
  private readonly jumpKinds: ReadonlySet<string>;
  private readonly blockKinds: ReadonlySet<string>;
  private readonly logicalKinds = new Map<string, DecisionKind>();
  private readonly operatorField: string;

  constructor(
    private readonly rules: DecisionRules,
    private readonly triviaKinds: ReadonlySet<string>,
  ) {
    this.ifKinds = setOf(rules.ifKinds);
    this.elseIfParentKinds = setOf(rules.elseIfParentKinds);
    this.elseIfWrapperKinds = setOf(rules.elseIfWrapperKinds);
    this.elseIfKinds = setOf(rules.elseIfKinds);
    this.loopKinds = setOf(rules.loopKinds);
    this.catchKinds = setOf(rules.catchKinds);
    this.ternaryKinds = setOf(rules.ternaryKinds);
    this.switchKinds = setOf(rules.switchKinds);
    this.caseKinds = setOf(rules.caseKinds);
    this.caseExcludeChildKinds = setOf(rules.caseExcludeChildKinds);
    this.guardKinds = setOf(rules.guardKinds);
    this.patternAlternativeKinds = setOf(rules.patternAlternativeKinds);
    this.shortCircuitKinds = setOf(rules.shortCircuitKinds);
    this.anonymousOperatorKinds = setOf(rules.anonymousOperatorKinds);
    this.binaryKinds = setOf(rules.binaryKinds);
    this.jumpKinds = setOf(rules.jumpKinds);
    this.blockKinds = setOf(rules.blockKinds);
    this.operatorField = rules.operatorField ?? "operator";
    this.registerLogicalKinds(rules.logicalAndOperators, "logical_and");
    this.registerLogicalKinds(rules.logicalOrOperators, "logical_or");
    this.registerLogicalKinds(rules.shortCircuitOperators, "short_circuit");
    this.nodeKinds = new Set([
      ...this.ifKinds,
      ...this.loopKinds,
      ...this.catchKinds,
      ...this.ternaryKinds,
      ...this.switchKinds,
      ...this.caseKinds,
      ...this.elseIfKinds,
      ...this.guardKinds,
      ...this.patternAlternativeKinds,
      ...this.shortCircuitKinds,
      ...this.anonymousOperatorKinds,
      ...this.binaryKinds,
    ]);
  }

  private registerLogicalKinds(operators: readonly string[] | undefined, kind: DecisionKind): void {
    for (const operator of operators ?? []) this.logicalKinds.set(operator, kind);
  }

  detect(node: SyntaxNode): DecisionDetectionResult {
    const kind = node.type;
    if (this.elseIfKinds.has(kind)) return branching("else_if", "if", true);
    if (this.guardKinds.has(kind)) return branching("guard", "if", false);
    if (this.patternAlternativeKinds.has(kind)) return extendedOnly("pattern_alternative");
    if (this.shortCircuitKinds.has(kind)) {
      return extendedOnly("short_circuit", `short-circuit-${String(node.startIndex)}`);
    }
    if (this.ifKinds.has(kind)) return this.detectIf(node);
    if (this.loopKinds.has(kind)) return branching("loop", "loop", false);
    if (this.catchKinds.has(kind)) return branching("catch", "catch", false);
    if (this.ternaryKinds.has(kind)) return branching("ternary", "ternary", false);
    if (this.switchKinds.has(kind))
      return { nesting: { construct: "switch", continuation: false } };
    if (this.caseKinds.has(kind)) return this.detectCase(node);
    if (this.binaryKinds.has(kind) || this.anonymousOperatorKinds.has(kind)) {
      return this.detectLogical(node);
    }
    return {};
  }

  private detectIf(node: SyntaxNode): DecisionDetectionResult {
    if (this.isElseIf(node)) return branching("else_if", "if", true);
    return branching(this.isGuardClause(node) ? "guard" : "if", "if", false);
  }

  private isElseIf(node: SyntaxNode): boolean {
    const parent = node.parent;
    if (parent === null) return false;
    if (this.elseIfParentKinds.has(parent.type)) return true;
    if (this.elseIfWrapperKinds.has(parent.type)) {
      let previous = parent.previousSibling;
      while (previous !== null && this.triviaKinds.has(previous.type)) {
        previous = previous.previousSibling;
      }
      if (previous?.type === "else") return true;
    }
    return this.isDetachedElseIfAfterComments(node, parent);
  }

  /**
   * Kotlin 0.0.7 verliert in `else /* ... *\/ if` das `else` als Baumknoten
   * und beendet das erste `if_expression` vor dem Blockkommentar. Die
   * Korrektur bleibt an AST-Grenzen gebunden: links muss ein mit `if` endender
   * Geschwisterteilbaum stehen, dazwischen mindestens ein echter
   * Kommentarknoten, und nur der exakte Keyword-Spalt `else` darf fehlen.
   */
  private isDetachedElseIfAfterComments(node: SyntaxNode, parent: SyntaxNode): boolean {
    if (this.rules.recoverDetachedElseIfAfterComments !== true) return false;

    let right = node;
    let left = node.previousSibling;
    let sawComment = false;
    while (left !== null && this.triviaKinds.has(left.type)) {
      if (!this.isWhitespaceGap(parent, left.endIndex, right.startIndex)) return false;
      sawComment = true;
      right = left;
      left = left.previousSibling;
    }
    if (!sawComment || left === null || !this.endsWithIf(left)) return false;

    const keywordGap = this.textBetween(parent, left.endIndex, right.startIndex);
    return keywordGap !== null && keywordGap.trim() === "else";
  }

  private isWhitespaceGap(parent: SyntaxNode, startIndex: number, endIndex: number): boolean {
    const gap = this.textBetween(parent, startIndex, endIndex);
    return gap !== null && gap.trim().length === 0;
  }

  private textBetween(parent: SyntaxNode, startIndex: number, endIndex: number): string | null {
    const start = startIndex - parent.startIndex;
    const end = endIndex - parent.startIndex;
    if (start < 0 || end < start || end > parent.text.length) return null;
    return parent.text.slice(start, end);
  }

  /** Ob `node` an seiner rechten AST-Grenze in einem `if` endet. */
  private endsWithIf(node: SyntaxNode): boolean {
    const endIndex = node.endIndex;
    const stack: SyntaxNode[] = [node];
    while (stack.length > 0) {
      const current = stack.pop() as SyntaxNode;
      if (current.endIndex !== endIndex) continue;
      if (this.ifKinds.has(current.type)) return true;
      for (const child of current.children) {
        if (child.endIndex === endIndex) stack.push(child);
      }
    }
    return false;
  }

  private isGuardClause(node: SyntaxNode): boolean {
    if (this.rules.consequenceField === undefined || this.jumpKinds.size === 0) return false;
    if (
      this.rules.alternativeField !== undefined &&
      node.childForFieldName(this.rules.alternativeField) !== null
    ) {
      return false;
    }
    const consequence = node.childForFieldName(this.rules.consequenceField);
    const sole = consequence === null ? null : this.soleStatementOf(consequence);
    return sole !== null && this.jumpKinds.has(sole.type);
  }

  private soleStatementOf(node: SyntaxNode): SyntaxNode | null {
    let current: SyntaxNode | null = node;
    while (current !== null && this.blockKinds.has(current.type)) {
      current = current.namedChildCount === 1 ? current.namedChild(0) : null;
    }
    return current;
  }

  private detectCase(node: SyntaxNode): DecisionDetectionResult {
    if (firstChildOfKinds(node, this.caseExcludeChildKinds) !== null) return {};
    const firstText = node.children[0]?.text.trim();
    if (firstText !== undefined && firstText === this.rules.caseExcludeFirstChildText) return {};
    return { decision: { kind: "case", countsForClassic: true, countsForExtended: true } };
  }

  private detectLogical(node: SyntaxNode): DecisionDetectionResult {
    const operator = this.operatorOf(node);
    if (operator === undefined) return {};
    const kind = this.logicalKinds.get(operator);
    return kind === undefined ? {} : extendedOnly(kind, this.logicalGroupIdFor(node, operator));
  }

  private operatorOf(node: SyntaxNode): string | undefined {
    if (!this.anonymousOperatorKinds.has(node.type)) {
      return node.childForFieldName(this.operatorField)?.text;
    }
    for (const child of node.children) {
      const text = child.text.trim();
      if (this.logicalKinds.has(text)) return text;
    }
    return undefined;
  }

  /** Stabile, positionsbasierte Kennung einer maximalen Operatorkette. */
  private logicalGroupIdFor(node: SyntaxNode, operator: string): string {
    let top = node;
    while (top.parent !== null && this.isLogicalExpression(top.parent)) {
      const parent = top.parent;
      if (this.operatorOf(parent) !== operator) break;
      top = parent;
    }
    return `logical-${String(top.startIndex)}`;
  }

  private isLogicalExpression(node: SyntaxNode): boolean {
    return this.binaryKinds.has(node.type) || this.anonymousOperatorKinds.has(node.type);
  }
}
