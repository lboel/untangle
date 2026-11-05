/**
 * Region splitting mechanics shared by the AST strategy (spec.md §8.3 steps
 * 6-8) and reused defensively by the fallback strategies:
 *
 * 1. `flattenToAtoms` — recursive AST-block splitting (step 6) plus
 *    statement grouping (step 7): descends into `AstRegion.children` only as
 *    far as needed, filling any gap between/around children with a raw
 *    "leftover text" atom so the atom list always covers the parent range
 *    exactly, then greedily re-merges adjacent atoms under the token budget.
 * 2. `splitByTokenBoundary` — safe token/byte-boundary splitting (step 8):
 *    the last resort for a single atom that is still too large on its own
 *    (e.g. one enormous statement with no further AST structure).
 */
import type { AstRegion, SourceRange } from "@untangle-code/domain";

import { rangeForByteSpan, safeUtf8Boundary, sliceBytes } from "./byte-text.js";
import {
  type BuildContext,
  contentOf,
  estimateTokensWithHeader,
  type HeaderMeta,
} from "./context.js";

type Header = Pick<HeaderMeta, "symbolFqn" | "signature">;

function fits(ctx: BuildContext, range: SourceRange, header: Header): boolean {
  return (
    estimateTokensWithHeader(ctx, contentOf(ctx, range), header) <= ctx.config.maxTokensPerChunk
  );
}

function merge(a: SourceRange, b: SourceRange): SourceRange {
  return { startLine: a.startLine, endLine: b.endLine, startByte: a.startByte, endByte: b.endByte };
}

/** Greedily merges adjacent (contiguous, ordered) atoms while staying under budget. */
export function groupAtomsByBudget(
  ctx: BuildContext,
  atoms: readonly SourceRange[],
  header: Header,
): SourceRange[] {
  if (atoms.length === 0) {
    return [];
  }
  const result: SourceRange[] = [];
  let current = atoms[0]!;
  for (let i = 1; i < atoms.length; i += 1) {
    const next = atoms[i]!;
    const merged = merge(current, next);
    if (fits(ctx, merged, header)) {
      current = merged;
    } else {
      result.push(current);
      current = next;
    }
  }
  result.push(current);
  return result;
}

/**
 * Recursively splits `node` into an ordered, gap-free list of ranges that
 * together cover `node.range` exactly. A node that already fits the budget
 * is returned whole. A node with no further AST structure that still does
 * not fit is returned whole too — {@link splitByTokenBoundary} handles it.
 */
export function flattenToAtoms(ctx: BuildContext, node: AstRegion, header: Header): SourceRange[] {
  if (fits(ctx, node.range, header)) {
    return [node.range];
  }
  if (node.splittable && node.children && node.children.length > 0) {
    const children = [...node.children].sort((a, b) => a.range.startByte - b.range.startByte);
    const atoms: SourceRange[] = [];
    let cursor = node.range.startByte;
    for (const child of children) {
      if (child.range.startByte > cursor) {
        atoms.push(rangeForByteSpan(ctx.lineIndex, cursor, child.range.startByte));
      }
      atoms.push(...flattenToAtoms(ctx, child, header));
      cursor = Math.max(cursor, child.range.endByte);
    }
    if (cursor < node.range.endByte) {
      atoms.push(rangeForByteSpan(ctx.lineIndex, cursor, node.range.endByte));
    }
    return groupAtomsByBudget(ctx, atoms, header);
  }
  return [node.range];
}

/** How far back (bytes) to look for a newline to split on instead of a hard cut. */
const NEWLINE_LOOKBACK_BYTES = 120;

function findBudgetEnd(ctx: BuildContext, start: number, maxEnd: number, header: Header): number {
  const wholeRange = rangeForByteSpan(ctx.lineIndex, start, maxEnd);
  if (fits(ctx, wholeRange, header)) {
    return maxEnd;
  }
  let lo = start + 1;
  let hi = maxEnd;
  // Guard: even one byte does not fit under an absurdly small budget — make
  // forced minimal progress rather than looping forever.
  if (!fits(ctx, rangeForByteSpan(ctx.lineIndex, start, lo), header)) {
    return lo;
  }
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (fits(ctx, rangeForByteSpan(ctx.lineIndex, start, mid), header)) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

function preferNewlineBoundary(buffer: Buffer, start: number, end: number): number {
  const lookbackFloor = Math.max(start, end - NEWLINE_LOOKBACK_BYTES);
  // Do not shrink the piece by more than half just for a nicer boundary.
  const minAcceptable = Math.max(start + 1, start + Math.floor((end - start) / 2));
  for (let i = end - 1; i >= lookbackFloor; i -= 1) {
    if (buffer[i] === 0x0a && i + 1 >= minAcceptable) {
      return i + 1;
    }
  }
  return end;
}

/**
 * Splits `range` into an ordered, gap-free, non-overlapping list of ranges,
 * each within the token budget, at safe UTF-8 boundaries (architecture.md
 * §14.4). Last-resort splitter: used only on atoms `flattenToAtoms` could
 * not shrink through AST structure.
 */
export function splitByTokenBoundary(
  ctx: BuildContext,
  range: SourceRange,
  header: Header,
): SourceRange[] {
  const pieces: SourceRange[] = [];
  let cursor = range.startByte;
  while (cursor < range.endByte) {
    let end = findBudgetEnd(ctx, cursor, range.endByte, header);
    if (end > cursor + 1) {
      end = preferNewlineBoundary(ctx.lineIndex.buffer, cursor, end);
    }
    end = safeUtf8Boundary(ctx.lineIndex.buffer, end);
    if (end <= cursor) {
      // Never emit an empty piece or fail to progress: force one byte, then
      // walk forward off any continuation byte it landed on.
      end = cursor + 1;
      while (end < range.endByte && (ctx.lineIndex.buffer[end]! & 0b1100_0000) === 0b1000_0000) {
        end += 1;
      }
    }
    pieces.push(rangeForByteSpan(ctx.lineIndex, cursor, end));
    cursor = end;
  }
  return pieces;
}

/** Re-exported for strategies that need a raw byte slice without going through an `AstRegion`. */
export function sliceRange(ctx: BuildContext, range: SourceRange): string {
  return sliceBytes(ctx.lineIndex, range.startByte, range.endByte);
}
