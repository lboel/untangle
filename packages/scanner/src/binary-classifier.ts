/**
 * Binary / encoding / minified-file classification from a content sample
 * (spec.md §6.1: "binäre Dateien erkennen"; WP-05 order: "Nullbytes, Anteil
 * nicht druckbarer Bytes, BOM-/Encoding-Erkennung" + minified heuristics).
 *
 * Pure functions over bytes already in memory — no I/O.
 */
import { DEFAULT_MINIFIED_RULE, isMinifiedShape } from "@untangle-code/domain";
import type { TextFormatKind } from "@untangle-code/domain";

import type { BinaryClassification, TextEncodingGuess } from "./types.js";

interface BomSpec {
  bytes: readonly number[];
  encoding: TextEncodingGuess;
}

// Longest match first (utf16le/be are 2-byte prefixes of nothing else here,
// but ordering is kept explicit and defensive).
//
// NOTE (checked per WP defect audit, not fixed — out of spec.md/architecture.md
// scope): UTF-32 is not a recognized `TextEncodingGuess` and has no BOM_SPECS
// entry. A UTF-32LE-BOM'd sample (FF FE 00 00 …) therefore still matches the
// 2-byte utf16le prefix above and is (mis-)tagged "utf16le" with a 2-byte BOM
// length. `classifyUtf16Body` below decodes the remaining bytes as UTF-16LE
// in that case, which — because every UTF-32LE code unit contributes two
// extra 0x00 bytes — reliably decodes to text containing genuine embedded
// NUL characters, so the sample still ends up classified `isBinary: true`.
// That is the pre-existing, undocumented-until-now behavior for UTF-32
// input: not a regression introduced by this fix, but also not a real fix —
// neither spec.md nor architecture.md specify UTF-32 support, so adding a
// dedicated "utf32le"/"utf32be" encoding is a separate, out-of-scope
// decision rather than something to guess at here.
const BOM_SPECS: readonly BomSpec[] = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: "utf8" },
  { bytes: [0xff, 0xfe], encoding: "utf16le" },
  { bytes: [0xfe, 0xff], encoding: "utf16be" },
];

function detectBom(sample: Uint8Array): {
  hasBom: boolean;
  encoding: TextEncodingGuess;
  length: number;
} {
  for (const spec of BOM_SPECS) {
    if (sample.length < spec.bytes.length) {
      continue;
    }
    let matches = true;
    for (let i = 0; i < spec.bytes.length; i += 1) {
      if (sample[i] !== spec.bytes[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return { hasBom: true, encoding: spec.encoding, length: spec.bytes.length };
    }
  }
  return { hasBom: false, encoding: "unknown", length: 0 };
}

/** Control bytes that indicate non-text content; tab/LF/CR are excluded (they're common in text). */
function isNonPrintableControlByte(byte: number): boolean {
  return (
    byte <= 0x08 ||
    byte === 0x0b ||
    byte === 0x0c ||
    (byte >= 0x0e && byte <= 0x1f) ||
    byte === 0x7f
  );
}

/**
 * Classifies the body of a sample confirmed (by BOM or by the BOM-less
 * heuristic in `detectUtf16WithoutBom`) to be UTF-16 (LE or BE).
 *
 * The raw "a NUL byte means binary" rule from `classifyBinarySample` cannot
 * be applied to UTF-16 bytes directly: every Basic-Latin code unit (i.e.
 * every plain ASCII character) carries a 0x00 byte as one half of its
 * 16-bit unit, so a legitimate UTF-16 text file is close to 50% NUL bytes
 * by construction. Decoding first and inspecting actual *characters*
 * avoids that false positive while still catching real NUL characters and
 * a high ratio of real control characters.
 */
function classifyUtf16Body(
  body: Uint8Array,
  encoding: "utf16le" | "utf16be",
  threshold: number,
  hasBom: boolean,
): BinaryClassification {
  // Non-fatal decode: a byte sequence that only coincidentally starts with a
  // UTF-16 BOM (rare, but the classifier must stay robust for arbitrary
  // binary input) must not throw here — invalid sequences become U+FFFD
  // instead, which is handled like any other non-control character below.
  const text = new TextDecoder(encoding === "utf16le" ? "utf-16le" : "utf-16be", {
    fatal: false,
  }).decode(body);

  let hasNullByte = false;
  let nonPrintable = 0;
  let unitCount = 0;
  for (const char of text) {
    unitCount += 1;
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0) {
      hasNullByte = true;
      continue;
    }
    if (codePoint < 0x100 && isNonPrintableControlByte(codePoint)) {
      nonPrintable += 1;
    }
  }

  const nonPrintableRatio = unitCount === 0 ? 0 : nonPrintable / unitCount;
  const isBinary = hasNullByte || nonPrintableRatio > threshold;

  return { isBinary, hasNullByte, nonPrintableRatio, encoding, hasBom };
}

// --- BOM-less UTF-16 detection (defect fix, spec.md E4) --------------------
//
// A UTF-16 file with no BOM is legal (spec.md/architecture.md do not require
// one, and plenty of real tooling emits BOM-less UTF-16). Without a BOM,
// `detectBom` reports `hasBom:false` and — before this fix — the sample fell
// straight into the raw byte-level loop below, which sees every other byte
// as 0x00 (the high or low half of each Basic-Latin code unit) and
// classifies the file as binary. That is a false NEGATIVE (real source text
// silently vanishes from the index), which is worse than the false-POSITIVE
// risk of a speculative heuristic, so this is a deliberate, narrow, and
// documented exception to "don't guess encodings beyond spec": see
// README.md "Entscheidung 12".
//
// Detection requires BOTH of the following (either alone is too weak):
//
//   1. Pattern: over the sample, one specific byte parity (even bytes for
//      UTF-16BE, odd bytes for UTF-16LE) is zero at a very high, regular
//      rate (>= UTF16_HEURISTIC_DOMINANT_NULL_RATIO), while the *opposite*
//      parity is zero only rarely (<= UTF16_HEURISTIC_OPPOSITE_NULL_RATIO).
//      A real binary file's NUL bytes are not reliably tied to byte parity
//      like that; this is the "regelmäßig alternierende Nullbytes"
//      signature of Basic-Latin text encoded as fixed-width 16-bit units.
//   2. Validation: decoding the sample under the *candidate* encoding and
//      counting actual code units, at least
//      UTF16_HEURISTIC_MIN_PRINTABLE_RATIO of them must be printable
//      (excluding NUL, other control characters, and the U+FFFD decode-
//      error marker). This is the same "decode and inspect real
//      characters" principle `classifyUtf16Body` already applies to
//      BOM-confirmed UTF-16 — it is what rejects a real binary blob whose
//      bytes happen to satisfy the parity pattern by chance.
//
// Both gates apply only once the sample reaches UTF16_HEURISTIC_MIN_SAMPLE_BYTES
// (32 bytes = 16 code units) — below that, parity ratios are too noisy to
// trust one way or the other, so short samples fall through to the existing
// (conservative: binary-by-default) raw byte-level classification. This is
// the documented "sehr kurze Probe" edge case; see the co-located test.
const UTF16_HEURISTIC_MIN_SAMPLE_BYTES = 32;
const UTF16_HEURISTIC_DOMINANT_NULL_RATIO = 0.6;
const UTF16_HEURISTIC_OPPOSITE_NULL_RATIO = 0.1;
const UTF16_HEURISTIC_MIN_PRINTABLE_RATIO = 0.9;

/**
 * Attempts to identify BOM-less UTF-16 text in `sample` via the two-gate
 * heuristic documented above. Returns the detected encoding, or `null` when
 * the sample is too short, does not show the alternating-NUL pattern, or
 * fails the printability validation (including: genuinely random/binary
 * data that happens to satisfy the parity check alone).
 */
function detectUtf16WithoutBom(sample: Uint8Array): "utf16le" | "utf16be" | null {
  const pairCount = Math.floor(sample.length / 2);
  if (sample.length < UTF16_HEURISTIC_MIN_SAMPLE_BYTES || pairCount === 0) {
    return null;
  }

  let nullAtEven = 0; // high byte of each pair is 0x00 -> UTF-16BE ASCII signal
  let nullAtOdd = 0; // low byte of each pair is 0x00 -> UTF-16LE ASCII signal
  const bodyLength = pairCount * 2;
  for (let i = 0; i < bodyLength; i += 2) {
    if (sample[i] === 0) {
      nullAtEven += 1;
    }
    if (sample[i + 1] === 0) {
      nullAtOdd += 1;
    }
  }

  const evenRatio = nullAtEven / pairCount;
  const oddRatio = nullAtOdd / pairCount;

  let candidate: "utf16le" | "utf16be" | null = null;
  if (
    oddRatio >= UTF16_HEURISTIC_DOMINANT_NULL_RATIO &&
    evenRatio <= UTF16_HEURISTIC_OPPOSITE_NULL_RATIO
  ) {
    candidate = "utf16le";
  } else if (
    evenRatio >= UTF16_HEURISTIC_DOMINANT_NULL_RATIO &&
    oddRatio <= UTF16_HEURISTIC_OPPOSITE_NULL_RATIO
  ) {
    candidate = "utf16be";
  }
  if (candidate === null) {
    return null;
  }

  // Gate 2: decode under the candidate encoding and require the result to be
  // overwhelmingly printable — this is what keeps real binary data (which
  // can coincidentally satisfy the byte-parity check above, e.g. a run of
  // small little-endian integers) from being misread as text.
  const body = sample.subarray(0, bodyLength);
  const text = new TextDecoder(candidate === "utf16le" ? "utf-16le" : "utf-16be", {
    fatal: false,
  }).decode(body);

  let printable = 0;
  let total = 0;
  for (const char of text) {
    total += 1;
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0) {
      continue;
    }
    if (codePoint === 0xfffd) {
      // TextDecoder's replacement character: an invalid code unit sequence
      // under this candidate encoding, not evidence of real text.
      continue;
    }
    if (codePoint < 0x100 && isNonPrintableControlByte(codePoint)) {
      continue;
    }
    printable += 1;
  }

  if (total === 0 || printable / total < UTF16_HEURISTIC_MIN_PRINTABLE_RATIO) {
    return null;
  }

  return candidate;
}

/**
 * Classifies a content sample as binary or text.
 *
 * A sample is binary when it contains a NUL byte or when the ratio of
 * non-printable control bytes exceeds `nonPrintableThreshold` (default
 * 0.3). Bytes in the 0x80–0xFF range are NOT counted as non-printable —
 * valid UTF-8 text uses them for non-ASCII characters, and flagging them
 * would misclassify ordinary internationalized source/comments as binary.
 *
 * When the sample carries a UTF-16 BOM, the body is decoded per the
 * confirmed encoding and classified over actual characters instead
 * (`classifyUtf16Body`) — see that function's doc comment for why the raw
 * byte-level NUL rule does not apply there.
 *
 * Absent a BOM, `detectUtf16WithoutBom` still checks for a conservative,
 * two-gate BOM-less UTF-16 signature (regular alternating NUL bytes at one
 * parity, validated by decoding and requiring the result be overwhelmingly
 * printable) before falling back to the raw byte-level rule — see that
 * function's doc comment for the documented thresholds and rationale
 * (spec.md E4: a false negative here silently drops real source text from
 * the index).
 */
export function classifyBinarySample(
  sample: Uint8Array,
  options?: { nonPrintableThreshold?: number },
): BinaryClassification {
  const threshold = options?.nonPrintableThreshold ?? 0.3;
  const bom = detectBom(sample);
  const body = bom.hasBom ? sample.subarray(bom.length) : sample;

  if (bom.hasBom && (bom.encoding === "utf16le" || bom.encoding === "utf16be")) {
    return classifyUtf16Body(body, bom.encoding, threshold, true);
  }

  if (!bom.hasBom) {
    const bomlessUtf16 = detectUtf16WithoutBom(sample);
    if (bomlessUtf16 !== null) {
      return classifyUtf16Body(sample, bomlessUtf16, threshold, false);
    }
  }

  let hasNullByte = false;
  let nonPrintable = 0;
  let highBit = false;
  for (const byte of body) {
    if (byte === 0) {
      hasNullByte = true;
      continue;
    }
    if (isNonPrintableControlByte(byte)) {
      nonPrintable += 1;
    } else if (byte >= 0x80) {
      highBit = true;
    }
  }

  const nonPrintableRatio = body.length === 0 ? 0 : nonPrintable / body.length;
  const isBinary = hasNullByte || nonPrintableRatio > threshold;

  const encoding: TextEncodingGuess = bom.hasBom
    ? bom.encoding
    : isBinary
      ? "unknown"
      : highBit
        ? "utf8"
        : "ascii";

  return { isBinary, hasNullByte, nonPrintableRatio, encoding, hasBom: bom.hasBom };
}

export interface MinifiedHeuristics {
  /**
   * A single line at or above this byte length signals minification. Default 500.
   * Does NOT apply to prose (`textFormat === "prose"`): a long Markdown table
   * row is ordinary prose, not minification.
   */
  maxLineLengthThreshold?: number;
  /** Average bytes/line at or above this signals minification (low line-to-byte ratio). Default 300. */
  averageBytesPerLineThreshold?: number;
}

/**
 * Heuristic minified-file detection ("sehr lange Zeilen, geringes
 * Zeilen-zu-Byte-Verhaeltnis") from a raw content sample. Operates on
 * newline bytes (0x0A) directly rather than decoding, so it is safe to run
 * on the same sample used for binary classification.
 */
export function detectMinified(
  sample: Uint8Array,
  heuristics?: MinifiedHeuristics,
  textFormat?: TextFormatKind | null,
): boolean {
  if (sample.length === 0) {
    return false;
  }
  const maxLineLengthThreshold =
    heuristics?.maxLineLengthThreshold ?? DEFAULT_MINIFIED_RULE.maxLineLengthThreshold;
  const averageBytesPerLineThreshold =
    heuristics?.averageBytesPerLineThreshold ?? DEFAULT_MINIFIED_RULE.averageLineLengthThreshold;

  let lineBreaks = 0;
  let longestLine = 0;
  let currentLine = 0;
  for (const byte of sample) {
    if (byte === 0x0a) {
      lineBreaks += 1;
      longestLine = Math.max(longestLine, currentLine);
      currentLine = 0;
    } else {
      currentLine += 1;
    }
  }
  longestLine = Math.max(longestLine, currentLine);

  const averageBytesPerLine = sample.length / Math.max(lineBreaks, 1);
  // Die Entscheidung selbst liegt in `@untangle-code/domain`, damit Scanner und
  // Chunker dieselbe Frage nicht mit verschiedenen Schwellen beantworten. Hier
  // wird nur GEMESSEN — auf Bytes, weil dieselbe Stichprobe schon fuer die
  // Binaerklassifikation gelesen wurde.
  return isMinifiedShape(
    { maxLineLength: longestLine, averageLineLength: averageBytesPerLine },
    { textFormat: textFormat ?? null },
    { maxLineLengthThreshold, averageLineLengthThreshold: averageBytesPerLineThreshold },
  );
}
