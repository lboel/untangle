/**
 * Prepared text builder (spec.md §8.6).
 *
 * Dense text gets a metadata header (repository/ref/path/language/symbol/
 * signature) followed by a blank line and the raw content — this header
 * counts toward the chunk's token budget (architecture.md §14.4), which is
 * why every function here is also usable standalone during chunk planning,
 * before a `CodeChunkDraft` object exists.
 *
 * BM25 text is deliberately undecorated: raw code, path, symbol names and a
 * light identifier extraction, with no natural-language framing, so a
 * lexical index scores on the same surface a keyword search would use.
 */
import type { CodeChunkDraft } from "@untangle-code/domain";

/** Header fields that are not part of a `CodeChunkDraft` (spec.md §8.6). */
export interface PreparedTextContext {
  /** Corresponds to `EmbeddingProfile.documentPrefix` (spec.md §5.7, §9). */
  documentPrefix: string;
  /** Human-readable repository label (`repo_label`), e.g. "untangle". */
  repoLabel: string;
  /** Human-readable ref name (`ref_name`), e.g. "main". */
  refName: string;
}

/** The subset of chunk metadata the dense header needs. */
export interface PreparedTextMeta {
  filePath: string;
  language: string;
  symbolFqn?: string | undefined;
  signature?: string | undefined;
}

function buildDenseHeader(ctx: PreparedTextContext, meta: PreparedTextMeta): string {
  // Trailing "\n\n" reproduces the blank line spec.md §8.6 shows between the
  // header's last line ("signature: ...") and "{content}" — a `join("\n")`
  // over the header lines alone only yields a single trailing newline.
  return (
    [
      ctx.documentPrefix,
      `repository: ${ctx.repoLabel}`,
      `ref: ${ctx.refName}`,
      `path: ${meta.filePath}`,
      `language: ${meta.language}`,
      `symbol: ${meta.symbolFqn ?? ""}`,
      `signature: ${meta.signature ?? ""}`,
    ].join("\n") + "\n\n"
  );
}

/** Builds the dense document text of spec.md §8.6 from loose metadata + content. */
export function buildPreparedDenseText(
  ctx: PreparedTextContext,
  meta: PreparedTextMeta,
  content: string,
): string {
  return buildDenseHeader(ctx, meta) + content;
}

/** Convenience wrapper of {@link buildPreparedDenseText} for an existing draft. */
export function buildPreparedDenseTextForDraft(
  ctx: PreparedTextContext,
  draft: CodeChunkDraft,
): string {
  return buildPreparedDenseText(
    ctx,
    {
      filePath: draft.filePath,
      language: draft.language,
      symbolFqn: draft.symbolFqn,
      signature: draft.signature,
    },
    draft.content,
  );
}

/** Identifier-shaped tokens: letters/digits/underscore/`$`, not starting with a digit. */
const IDENTIFIER_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*/g;

function extractIdentifiers(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
    seen.add(match[0]);
  }
  return [...seen];
}

/** The subset of chunk metadata the BM25 text needs. */
export interface Bm25TextMeta {
  filePath: string;
  symbolName?: string | undefined;
  symbolFqn?: string | undefined;
}

/**
 * Builds the BM25 text of spec.md §8.6: raw code, path, symbol names and
 * identifiers, without natural-language decoration.
 */
export function buildBm25Text(meta: Bm25TextMeta, content: string): string {
  const parts = [meta.filePath];
  if (meta.symbolFqn) {
    parts.push(meta.symbolFqn);
  }
  if (meta.symbolName) {
    parts.push(meta.symbolName);
  }
  parts.push(...extractIdentifiers(content));
  parts.push(content);
  return parts.join("\n");
}

/** Convenience wrapper of {@link buildBm25Text} for an existing draft. */
export function buildBm25TextForDraft(draft: CodeChunkDraft): string {
  return buildBm25Text(
    { filePath: draft.filePath, symbolName: draft.symbolName, symbolFqn: draft.symbolFqn },
    draft.content,
  );
}
