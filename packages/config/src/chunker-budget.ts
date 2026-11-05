/**
 * Chunk-token budget wiring: `IndexConfig` (spec.md §4.6) →
 * `@untangle-code/chunker`'s `ChunkerConfigInput.maxTokensPerChunk`.
 *
 * spec.md §4.6 defines TWO index-level chunk-size knobs —
 * `targetChunkTokens` (a soft aim) and `maxChunkTokens` (a hard ceiling) —
 * with their product defaults (900 / 1500) fixed exactly once, in this
 * package's `defaults.ts` (`DEFAULT_INDEX_CONFIG`). That is the single
 * source of truth this file wires onward.
 *
 * `@untangle-code/chunker` currently exposes exactly ONE budget knob,
 * `ChunkerConfigInput.maxTokensPerChunk`, and treats it everywhere as a hard
 * "must not exceed" ceiling (every comparison in chunker's `split.ts` and
 * `line-fallback-strategy.ts` is `<=`). The correct mapping is therefore
 * `maxChunkTokens → maxTokensPerChunk`. `targetChunkTokens` has no
 * chunker-side counterpart today — the chunker does not currently support
 * aiming below its hard ceiling — and is deliberately NOT passed here;
 * smuggling it in as `maxTokensPerChunk` instead would silently turn a soft
 * aim into the hard ceiling the chunker actually enforces, which is a
 * different (smaller) budget than spec.md §4.6 configures.
 *
 * `@untangle-code/config` deliberately does NOT take a runtime dependency on
 * `@untangle-code/chunker` for this: config sits below chunker in the
 * dependency graph (chunker already depends on domain; depending on chunker
 * from here would invert that layering for the sake of one field mapping),
 * and chunker is maintained independently of this package. `deriveChunkerBudget`
 * therefore returns a plain object structurally compatible with
 * `ChunkerConfigInput` (verified in `chunker-budget.test.ts` against the
 * fields spec.md and the chunker README actually document) rather than
 * importing its type.
 *
 * Whatever code builds the indexer (constructing `ChunkerConfigInput` to
 * pass to `@untangle-code/chunker`'s `resolveChunkerConfig`/`chunkFile`) MUST
 * spread this function's result into that input — e.g.
 * `resolveChunkerConfig({ ...deriveChunkerBudget(effectiveConfig.index), preparedText })`
 * — rather than reading `index.maxChunkTokens` directly or (worse) relying
 * on the chunker's own independent default. That is the one piece of wiring
 * this fix cannot complete by itself: no indexer package exists in this
 * repository yet to receive it (see this package's `package.json`
 * `dependencies`, and `packages/`'s directory listing) — but every future
 * caller now has exactly one function to call instead of a field name to
 * remember, which is what keeps a changed config value from silently
 * failing to reach the chunker.
 */
import type { IndexConfig } from "./types.js";

/** Structurally assignable to `@untangle-code/chunker`'s `ChunkerConfigInput` — see file doc comment. */
export interface ChunkerBudgetInput {
  maxTokensPerChunk: number;
}

/**
 * Derives the chunker's token-budget input from the effective `IndexConfig`
 * (spec.md §4.6). This is the ONLY function in the codebase permitted to
 * decide which `IndexConfig` field feeds
 * `ChunkerConfigInput.maxTokensPerChunk` — see file doc comment for why it
 * is `maxChunkTokens`, not `targetChunkTokens`.
 */
export function deriveChunkerBudget(
  index: Pick<IndexConfig, "maxChunkTokens">,
): ChunkerBudgetInput {
  return { maxTokensPerChunk: index.maxChunkTokens };
}
