/**
 * Doc-comment binding (spec.md §8.3 step 2: "Doccomment, Annotationen und
 * Dekoratoren an das folgende Symbol binden").
 *
 * Decorators are represented by the grammar as PRECEDING SIBLINGS of the
 * member they decorate inside `class_body` (verified empirically — not as a
 * nested field on the member node, despite `node-types.json` listing
 * `decorator` as an optional field; that field shape applies to parameter
 * decorators, e.g. `constructor(@Inject() dep: Dep)`, which nest inside
 * `required_parameter` instead). A leading doc comment is, in turn, a
 * preceding sibling of the (possibly decorator-preceded) member.
 *
 * For a symbol whose defining node is buried inside an expression (an arrow
 * function assigned to a `const`, a function expression as an object
 * property value, ...), the anchor for "preceding sibling" purposes is not
 * the function node itself but its enclosing statement — see
 * `resolveDocAnchor`.
 */
import type { SourceRange } from "@untangle-code/domain";

import { COMMENT_TYPE, DECORATOR_TYPE } from "./node-kinds.js";
import type { FileTextContext } from "./node-utils.js";
import { rangeOf, unionRange } from "./node-utils.js";
import type { SyntaxNode } from "./syntax.js";

/** Climbs from a (possibly deeply nested) scope-defining node to its statement-level anchor. */
export function resolveDocAnchor(node: SyntaxNode): SyntaxNode {
  let anchor = node;
  const parent = node.parent;
  if (parent !== null) {
    if (parent.type === "variable_declarator") {
      const declarationList = parent.parent;
      if (
        declarationList !== null &&
        (declarationList.type === "lexical_declaration" ||
          declarationList.type === "variable_declaration")
      ) {
        anchor = declarationList;
      }
    } else if (
      parent.type === "assignment_expression" &&
      parent.parent?.type === "expression_statement"
    ) {
      anchor = parent.parent;
    }
  }
  if (anchor.parent !== null && anchor.parent.type === "export_statement") {
    anchor = anchor.parent;
  }
  return anchor;
}

const MAX_BLANK_LINES_BETWEEN_DOC_AND_SYMBOL = 1;

/** Resolves the bound doc-comment range for a scope-defining node, if any (spec.md §8.3 step 2). */
export function resolveDocRange(node: SyntaxNode, ctx: FileTextContext): SourceRange | undefined {
  const anchor = resolveDocAnchor(node);

  let cursor = anchor.previousSibling;
  let boundary = anchor;
  // Skip immediately-preceding decorators (they travel with the symbol's own range, not the doc range,
  // but a comment further back must still be considered "immediately preceding" through them).
  while (cursor !== null && cursor.type === DECORATOR_TYPE) {
    boundary = cursor;
    cursor = cursor.previousSibling;
  }

  let docRange: SourceRange | undefined;
  while (cursor !== null && cursor.type === COMMENT_TYPE) {
    const gap = boundary.startPosition.row - cursor.endPosition.row;
    if (gap > MAX_BLANK_LINES_BETWEEN_DOC_AND_SYMBOL) break;
    const commentRange = rangeOf(cursor, ctx);
    docRange = docRange === undefined ? commentRange : unionRange(commentRange, docRange);
    boundary = cursor;
    cursor = cursor.previousSibling;
  }
  return docRange;
}
