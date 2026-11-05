/**
 * Test-only fixture helpers: derive byte-accurate `SourceRange`s for a marker
 * substring inside a hand-written fixture file, so tests can build
 * `AstRegion`/`ExtractedSymbol` fixtures without hand-computing byte offsets
 * (and without depending on parser-registry, which this package must not
 * import).
 */
import type { SourceRange } from "@untangle-code/domain";

import { buildLineIndex, rangeForByteSpan } from "./byte-text.js";

/** 0-based byte offset of the `occurrence`-th (0-based) match of `substring` in `content`. */
export function byteOffsetOf(content: string, substring: string, occurrence = 0): number {
  let charIndex = -1;
  for (let i = 0; i <= occurrence; i += 1) {
    charIndex = content.indexOf(substring, charIndex + 1);
    if (charIndex < 0) {
      throw new Error(
        `fixture error: substring not found (occurrence ${i}): ${JSON.stringify(substring)}`,
      );
    }
  }
  return Buffer.byteLength(content.slice(0, charIndex), "utf8");
}

/** The `SourceRange` spanning the `occurrence`-th match of `substring` in `content`. */
export function rangeOf(content: string, substring: string, occurrence = 0): SourceRange {
  const startByte = byteOffsetOf(content, substring, occurrence);
  const endByte = startByte + Buffer.byteLength(substring, "utf8");
  const index = buildLineIndex(content);
  return rangeForByteSpan(index, startByte, endByte);
}

/** The `SourceRange` spanning from the start of `from`'s first match through the end of `to`'s first match at/after it. */
export function spanOf(content: string, from: string, to: string): SourceRange {
  const fromCharIndex = content.indexOf(from);
  if (fromCharIndex < 0) {
    throw new Error(`fixture error: "from" substring not found: ${JSON.stringify(from)}`);
  }
  const startByte = Buffer.byteLength(content.slice(0, fromCharIndex), "utf8");
  const toCharIndex = content.indexOf(to, fromCharIndex);
  if (toCharIndex < 0) {
    throw new Error(`fixture error: "to" substring not found after "from": ${JSON.stringify(to)}`);
  }
  const endByte = Buffer.byteLength(content.slice(0, toCharIndex + to.length), "utf8");
  const index = buildLineIndex(content);
  return rangeForByteSpan(index, startByte, endByte);
}
