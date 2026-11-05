/**
 * Decision-point and nesting-event detection (spec.md §16.2-§16.4).
 *
 * Called once per non-leaf node during the main walk (`engine.ts`); returns
 * the zero-or-one `DecisionFact`/`NestingFact` pair this specific node
 * contributes (attribution to a `symbolScopeId` happens in the caller,
 * which knows the current scope).
 */
import type { DecisionKind } from "@untangle-code/domain";

import {
  BINARY_EXPRESSION,
  CATCH_CLAUSE,
  IF_STATEMENT,
  JUMP_STATEMENT_TYPES,
  LOOP_TYPES,
  SWITCH_CASE,
  SWITCH_STATEMENT,
  TERNARY_EXPRESSION,
} from "./node-kinds.js";
import type { SyntaxNode } from "./syntax.js";

export interface DetectedDecision {
  kind: DecisionKind;
  countsForClassic: boolean;
  countsForExtended: boolean;
  logicalGroupId?: string;
  /**
   * Wie oft dieser EINE Knoten die Entscheidung beitraegt (Vorgabe: 1).
   *
   * WOFUER: eine Grammatik kann eine n-stellige Alternative FLACH ablegen.
   * Rusts `or_pattern` ist linksrekursiv — `A | B | C` sind zwei
   * verschachtelte Knoten, also zwei Entscheidungen ohne weiteres Zutun.
   * Pythons `union_pattern` ist FLACH: `case 1 | 2 | 3` ist EIN Knoten mit
   * drei Zweigen. Ohne diese Zahl kostete `1 | 2 | 3` genauso viel wie
   * `1 | 2`, und die Metrik behauptete eine Gleichheit, die es nicht gibt.
   *
   * Die zusaetzlichen Entscheidungen teilen sich den Bereich des Knotens:
   * die Alternativen liegen darin, und ein erfundener engerer Bereich waere
   * eine Angabe, die der Baum nicht hergibt.
   */
  repeat?: number;
}

export interface DetectedNesting {
  construct: string;
  continuation: boolean;
}

export interface DecisionDetectionResult {
  decision?: DetectedDecision;
  nesting?: DetectedNesting;
}

function isElseIf(node: SyntaxNode): boolean {
  return node.parent !== null && node.parent.type === "else_clause";
}

/** A guard clause: `if (cond) return/throw/break/continue;` with no `else`. */
function isGuardClause(node: SyntaxNode): boolean {
  if (node.childForFieldName("alternative") !== null) return false;
  const consequence = node.childForFieldName("consequence");
  if (consequence === null) return false;
  const soleStatement =
    consequence.type === "statement_block"
      ? consequence.namedChildCount === 1
        ? consequence.namedChild(0)
        : null
      : consequence;
  return soleStatement !== null && JUMP_STATEMENT_TYPES.has(soleStatement.type);
}

/**
 * Finds the topmost node in a maximal chain of the same binary operator (for
 * grouping §16.3/§16.4) and derives a stable id for it from its position in
 * the source (`startIndex`, the group top node's byte offset) rather than
 * tree-sitter's runtime `node.id`. `node.id` is a native-binding identifier
 * (effectively a heap address) that is NOT stable across processes or even
 * across repeated parses of the identical source within the same process —
 * two parse runs of the same file can and do produce different `node.id`
 * values. `startIndex` is deterministic: the same source byte range always
 * yields the same id, which is what vision.md §8.5's determinism principle
 * requires once `ComplexityFacts` are persisted or compared across runs.
 */
function logicalGroupIdFor(node: SyntaxNode, operatorText: string): string {
  let top = node;
  while (top.parent !== null && top.parent.type === BINARY_EXPRESSION) {
    const parentOperator = top.parent.childForFieldName("operator")?.text;
    if (parentOperator !== operatorText) break;
    top = top.parent;
  }
  return `logical-${top.startIndex}`;
}

/**
 * Die Knotentypen, fuer die {@link detectDecisionAndNesting} ueberhaupt etwas
 * anderes als `{}` liefern kann — abgeleitet aus den Verzweigungen unten und
 * durch `decisions.test.ts` an sie gebunden.
 *
 * WOZU: der Cursor-Walk (`engine.ts`, WP-95) materialisiert einen
 * `SyntaxNode`-Wrapper nur dann, wenn ein Detektor ihn wirklich braucht. Ohne
 * dieses Vorsieb muesste er fuer JEDEN inneren Knoten einen Wrapper bauen —
 * also genau die Grenzueberquerung wieder einfuehren, die der Cursor spart.
 */
const DECISION_CANDIDATE_TYPES: ReadonlySet<string> = new Set([
  IF_STATEMENT,
  ...LOOP_TYPES,
  CATCH_CLAUSE,
  TERNARY_EXPRESSION,
  SWITCH_STATEMENT,
  SWITCH_CASE,
  BINARY_EXPRESSION,
]);

/** Kann ein Knoten dieses Typs eine Entscheidung oder ein Nesting-Ereignis tragen? */
export function mayCarryDecisionOrNesting(nodeType: string): boolean {
  return DECISION_CANDIDATE_TYPES.has(nodeType);
}

export function detectDecisionAndNesting(node: SyntaxNode): DecisionDetectionResult {
  if (node.type === IF_STATEMENT) {
    if (isElseIf(node)) {
      return {
        decision: { kind: "else_if", countsForClassic: true, countsForExtended: true },
        nesting: { construct: "if", continuation: true },
      };
    }
    const kind: DecisionKind = isGuardClause(node) ? "guard" : "if";
    return {
      decision: { kind, countsForClassic: true, countsForExtended: true },
      nesting: { construct: "if", continuation: false },
    };
  }

  if (LOOP_TYPES.has(node.type)) {
    return {
      decision: { kind: "loop", countsForClassic: true, countsForExtended: true },
      nesting: { construct: "loop", continuation: false },
    };
  }

  if (node.type === CATCH_CLAUSE) {
    return {
      decision: { kind: "catch", countsForClassic: true, countsForExtended: true },
      nesting: { construct: "catch", continuation: false },
    };
  }

  if (node.type === TERNARY_EXPRESSION) {
    return {
      decision: { kind: "ternary", countsForClassic: true, countsForExtended: true },
      nesting: { construct: "ternary", continuation: false },
    };
  }

  if (node.type === SWITCH_STATEMENT) {
    return { nesting: { construct: "switch", continuation: false } };
  }

  if (node.type === SWITCH_CASE) {
    return { decision: { kind: "case", countsForClassic: true, countsForExtended: true } };
  }

  if (node.type === BINARY_EXPRESSION) {
    const operator = node.childForFieldName("operator")?.text;
    if (operator === "&&") {
      return {
        decision: {
          kind: "logical_and",
          countsForClassic: false,
          countsForExtended: true,
          logicalGroupId: logicalGroupIdFor(node, "&&"),
        },
      };
    }
    if (operator === "||") {
      return {
        decision: {
          kind: "logical_or",
          countsForClassic: false,
          countsForExtended: true,
          logicalGroupId: logicalGroupIdFor(node, "||"),
        },
      };
    }
    if (operator === "??") {
      return {
        decision: {
          kind: "short_circuit",
          countsForClassic: false,
          countsForExtended: true,
          logicalGroupId: logicalGroupIdFor(node, "??"),
        },
      };
    }
  }

  return {};
}

/** Nesting construct for a lambda/local-function boundary (spec.md §16.4). */
export function lambdaNesting(): DetectedNesting {
  return { construct: "lambda", continuation: false };
}
