/**
 * Parse-quality diagnostics (spec.md §7.3): counts and reports tree-sitter
 * `ERROR` and "missing" nodes, and classifies overall `ParseQuality`.
 *
 * Threshold choice (documented WP-06 decision, no normative value given by
 * spec.md/architecture.md): `failed` is reserved for trees where at least
 * half of all nodes are broken — tree-sitter's error recovery almost always
 * produces SOME usable tree, even for badly broken input, so a small
 * absolute count of error/missing nodes is treated as `partial`
 * (spec.md §7.3: "AST nutzbar, aber mit Fehlerknoten"), while a
 * majority-broken tree is treated as unusable (`failed`, `ast: null` per
 * domain `ParseResult` doc).
 *
 * TRAVERSIERUNG (WP-95): ueber die Cursor-API statt ueber `node.children` —
 * derselbe Grund wie in `engine.ts` und `fingerprint.ts`. Die
 * BESUCHSREIHENFOLGE ist absichtlich unveraendert geblieben: der fruehere
 * Stapel (`stack.pop()` nach `push` aller Kinder) lief Vorordnung mit
 * UMGEKEHRTER Kindfolge, und genau die stellen `gotoLastChild` /
 * `gotoPreviousSibling` nach. Wer hier auf die natuerliche Kindfolge
 * umstellt, aendert die Reihenfolge von `ParseDiagnostic[]` — sichtbar in
 * jedem Bericht, der die erste Diagnose zeigt.
 */
import type { ParseDiagnostic, ParseQuality } from "@untangle-code/domain";

import type { FileTextContext } from "./node-utils.js";
import { rangeOfCursor } from "./node-utils.js";
import type { SyntaxNode } from "./syntax.js";

const ERROR_NODE_TYPE = "ERROR";
const FAILED_RATIO_THRESHOLD = 0.5;

/**
 * Woher die Angabe "fehlender Knoten" stammt.
 *
 * `measured` — tree-sitter meldet `ts_node_is_missing`, ein Messwert der
 * Fehlerkorrektur. `heuristic` — ast-grep hat dazu kein Gegenstueck; dort ist
 * es ein Blatt der Breite null (siehe `languages/astgrep-backend/syntax.ts`).
 * Der Unterschied gehoert in die DIAGNOSE, nicht in eine Fussnote: wer
 * `missing_node_count` liest, muss wissen, ob die Zahl gemessen oder
 * geschaetzt ist (E4).
 */
export type MissingNodeEvidence = "measured" | "heuristic";

export interface ParseDiagnosticsResult {
  parseQuality: ParseQuality;
  diagnostics: ParseDiagnostic[];
  errorNodeCount: number;
  missingNodeCount: number;
}

export function collectParseDiagnostics(
  root: SyntaxNode,
  ctx: FileTextContext,
  missingNodeEvidence: MissingNodeEvidence = "measured",
): ParseDiagnosticsResult {
  const diagnostics: ParseDiagnostic[] = [];
  let errorNodeCount = 0;
  let missingNodeCount = 0;
  let totalNodeCount = 0;

  // Iterativ, nicht rekursiv: ein Syntaxbaum kann tausende Ebenen tief sein
  // (eine lange `a || b || c ...`-Kette genuegt), und ein Aufrufstapel darf
  // daran nicht zerbrechen.
  const cursor = root.walk();
  let depth = 0;
  for (;;) {
    totalNodeCount += 1;
    const nodeType = cursor.nodeType;

    if (cursor.nodeIsMissing) {
      missingNodeCount += 1;
      diagnostics.push({
        severity: "error",
        kind: "missing_node",
        message:
          missingNodeEvidence === "measured"
            ? `Missing "${nodeType}" node`
            : `Missing "${nodeType}" node (heuristically detected as a zero-width node; ` +
              `ast-grep has no nodeIsMissing API)`,
        range: rangeOfCursor(cursor, ctx),
      });
    } else if (nodeType === ERROR_NODE_TYPE) {
      // Frueher stand hier zusaetzlich `|| node.isError`. Das ist dieselbe
      // Bedingung: `ts_node_is_error` prueft auf das eingebaute Fehlersymbol,
      // und dessen Typname IST "ERROR" — ein eingebautes Symbol wird nie
      // aliasiert. Der Cursor bietet kein `nodeIsError`, wohl aber `nodeType`.
      errorNodeCount += 1;
      diagnostics.push({
        severity: "error",
        kind: "error_node",
        message: `Unexpected syntax near "${cursor.nodeText.slice(0, 40)}"`,
        range: rangeOfCursor(cursor, ctx),
      });
    }

    if (cursor.gotoLastChild()) {
      depth += 1;
      continue;
    }
    while (!cursor.gotoPreviousSibling()) {
      if (depth === 0) {
        return finish(diagnostics, errorNodeCount, missingNodeCount, totalNodeCount);
      }
      cursor.gotoParent();
      depth -= 1;
    }
  }
}

function finish(
  diagnostics: ParseDiagnostic[],
  errorNodeCount: number,
  missingNodeCount: number,
  totalNodeCount: number,
): ParseDiagnosticsResult {
  const brokenRatio = totalNodeCount > 0 ? (errorNodeCount + missingNodeCount) / totalNodeCount : 0;
  const parseQuality: ParseQuality =
    errorNodeCount === 0 && missingNodeCount === 0
      ? "complete"
      : brokenRatio >= FAILED_RATIO_THRESHOLD
        ? "failed"
        : "partial";

  return { parseQuality, diagnostics, errorNodeCount, missingNodeCount };
}
