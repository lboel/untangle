/**
 * Markdown / ADR adapter (architecture.md §20, spec.md §19.2 "semantische
 * Abschnitte statt fester Zeilenfenster").
 *
 * ADRs are not a separate `ContextArtifactType` (spec.md §19.1's type union
 * has no "adr" literal — an Architecture Decision Record IS a Markdown
 * document, conventionally with `## Status`/`## Context`/`## Decision`/
 * `## Consequences` headings) — this one adapter's heading-based sectioning
 * handles both.
 *
 * WP-110: the sectioning itself no longer lives here. It moved verbatim to
 * `@untangle-code/domain`'s `outlineMarkdown()` so that the SAME partition
 * also serves ordinary `.md` files through the parser-registry prose adapter
 * and the prose metrics — before that move, a configured artifact got
 * breadcrumbed sections while the identical file outside an artifact
 * configuration got arbitrary line windows. Behaviour here is unchanged; the
 * implementation is simply no longer duplicated.
 *
 * Sectioning (defined on `outlineMarkdown`): each ATX heading (`#` …
 * `######`, ignored inside fenced code blocks) starts a new chunk that runs
 * up to the START of the very next heading of ANY level (or EOF) — a flat
 * partition of the file with no overlap. Each chunk's `title` carries the
 * breadcrumb (ancestor headings joined by " › ") instead, so the hierarchy
 * is still fully recoverable even though `content` stays the exact raw slice
 * — the breadcrumb is never spliced into the preserved raw content
 * (spec.md §19.2).
 */
import type {
  ArtifactAdapter,
  ArtifactChunk,
  ArtifactDocument,
  ArtifactInput,
  ArtifactLink,
} from "@untangle-code/domain";
import { outlineMarkdown } from "@untangle-code/domain";

import { buildLineIndex, splitLines } from "../text/line-index.js";

import type { ChunkDraft, SkipLedgerReporter } from "./shared.js";
import { buildChunksReportingSkips, buildDocuments } from "./shared.js";

const MARKDOWN_EXTENSION = /\.(md|markdown|mdx)$/i;

function markdownDrafts(lines: string[]): ChunkDraft[] {
  return outlineMarkdown(lines).map((section) => {
    const draft: ChunkDraft = {
      kind: "markdown_section",
      startLine: section.startLine,
      endLine: section.endLine,
    };
    // Der Vorspann vor der ersten Ueberschrift hat keinen Breadcrumb; ein
    // leerer `title` waere eine Behauptung ueber eine Ueberschrift, die es
    // nicht gibt.
    return section.breadcrumb === "" ? draft : { ...draft, title: section.breadcrumb };
  });
}

export interface MarkdownAdapterOptions {
  /** Overrides how a real skip-ledger finding surfaces from `chunk()` (default: a stderr warning) — see `coverage.ts`'s `SkipLedgerReporter`. */
  onSkipLedgerGap?: SkipLedgerReporter;
}

export function createMarkdownAdapter(options: MarkdownAdapterOptions = {}): ArtifactAdapter {
  return {
    supports(type: string, path: string): boolean {
      return type === "markdown" || (type === "auto" && MARKDOWN_EXTENSION.test(path));
    },

    async read(input: ArtifactInput): Promise<ArtifactDocument[]> {
      return buildDocuments(input, "markdown");
    },

    chunk(document: ArtifactDocument): ArtifactChunk[] {
      const { lines } = splitLines(document.content);
      const index = buildLineIndex(document.content);
      return buildChunksReportingSkips(
        document,
        index,
        markdownDrafts(lines),
        options.onSkipLedgerGap,
      );
    },

    links(): ArtifactLink[] {
      return [];
    },
  };
}
