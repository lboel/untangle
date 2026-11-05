/**
 * Deterministic `EmbeddingProvider` (architecture.md §27.2: "Tests verwenden
 * einen Fake Embedder, der aus Text deterministische Vektoren erzeugt").
 *
 * Algorithm — feature hashing over a token bag, no external model, no
 * network, no `Math.random()`:
 *
 * 1. tokenize with the unchanged hashed-token-bag-v1 rules: lower-case,
 *    split on runs of non-alphanumeric characters. Lexical indexing has a
 *    separate versioned identifier tokenizer; it must not change these vectors;
 * 2. for each distinct token, deterministically hash it to a dimension index
 *    in `[0, dimensions)` (`hashToken` from `bm25.ts`, reduced mod
 *    `dimensions`) and a sign in `{-1, +1}` (a second, differently-salted
 *    hash of the same token) — accumulating `sign` once per token
 *    *occurrence* into that dimension;
 * 3. L2-normalize the resulting vector (`l2Normalize`, `math.ts`).
 *
 * This gives the two properties the spec asks for:
 * - reproducible: pure arithmetic over the input text, no randomness or
 *   process-local state — the same text yields the same vector in any
 *   process, on any platform, forever;
 * - similar texts get similar vectors: texts that share tokens accumulate
 *   into the same dimensions with the same signs (a token's dimension and
 *   sign depend only on the token itself), so their vectors point in
 *   similar directions and score a high cosine similarity — while an
 *   all-zero vector (e.g. empty text) is returned unchanged by
 *   `l2Normalize` rather than `NaN`.
 */
import type {
  Clock,
  EmbeddingBatchResultV1,
  EmbeddingProfile,
  EmbeddingProvider,
  EmbeddingReadinessV1,
  PortCallOptions,
} from "@untangle-code/domain";
import { buildEmbeddingProfileId } from "@untangle-code/domain";

import { hashToken } from "./bm25.js";
import { l2Normalize } from "./math.js";

/** A ready-to-use profile for tests that don't care about specific values. */
export const DEFAULT_DETERMINISTIC_EMBEDDING_PROFILE: EmbeddingProfile = {
  provider: "testkit-deterministic",
  model: "hashed-token-bag-v1",
  dimensions: 64,
  queryPrefix: "search_query: ",
  documentPrefix: "search_document: ",
  includePath: true,
  normalization: "l2",
  preparedTextVersion: "v1",
};

/**
 * Salt distinguishing the "which dimension" hash from the "which sign" hash
 * below — without it, a token's dimension index and its sign would be
 * derived from the exact same hash value, correlating the two in ways that
 * would bias the resulting vector directions.
 */
const SIGN_SALT = "testkit-deterministic-embedder-sign";

/** Preserve the v1 dense embedding profile independently of lexical tokenizer changes. */
function tokenizeForEmbedding(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Deterministically hashes `token` to a dimension index in `[0, dimensions)`. */
export function hashTokenToDimension(token: string, dimensions: number): number {
  return hashToken(token) % dimensions;
}

/** Deterministic per-token sign in `{-1, 1}`, independent of its dimension index. */
export function hashTokenToSign(token: string): 1 | -1 {
  return hashToken(SIGN_SALT + token) % 2 === 0 ? 1 : -1;
}

/**
 * Turns `text` into a reproducible, L2-normalized vector of `dimensions`
 * dimensions via hashed-token-bag feature hashing (see module doc comment).
 */
export function embedTextDeterministically(text: string, dimensions: number): number[] {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(
      `embedTextDeterministically: dimensions must be a positive integer, got ${dimensions}`,
    );
  }
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokenizeForEmbedding(text)) {
    const dimension = hashTokenToDimension(token, dimensions);
    vector[dimension] = (vector[dimension] ?? 0) + hashTokenToSign(token);
  }
  return l2Normalize(vector);
}

/**
 * `EmbeddingProvider` implementation backed entirely by
 * {@link embedTextDeterministically} — no readiness probe against a real
 * server, no network, no truncation (a hashed-token-bag vector has no
 * context window to truncate against, so `truncated` is always `false`;
 * documented decision, see README "Entscheidungen").
 */
export class DeterministicEmbedder implements EmbeddingProvider {
  public readonly profile: EmbeddingProfile;
  public readonly profileId: string;

  public constructor(
    private readonly clock: Clock,
    profile: EmbeddingProfile = DEFAULT_DETERMINISTIC_EMBEDDING_PROFILE,
  ) {
    if (!Number.isInteger(profile.dimensions) || profile.dimensions <= 0) {
      throw new Error(
        `DeterministicEmbedder: profile.dimensions must be a positive integer, got ${profile.dimensions}`,
      );
    }
    this.profile = profile;
    this.profileId = buildEmbeddingProfileId(profile);
  }

  public async ensureReady(options?: PortCallOptions): Promise<EmbeddingReadinessV1> {
    options?.signal?.throwIfAborted();
    return {
      endpoint: "in-memory://testkit-deterministic-embedder",
      model: this.profile.model,
      dimensions: this.profile.dimensions,
      probedAt: this.clock.nowIso(),
    };
  }

  public async embedDocuments(
    preparedTexts: string[],
    options?: PortCallOptions,
  ): Promise<EmbeddingBatchResultV1> {
    options?.signal?.throwIfAborted();
    const vectors = preparedTexts.map((text) =>
      embedTextDeterministically(text, this.profile.dimensions),
    );
    return { vectors, truncated: preparedTexts.map(() => false) };
  }

  public async embedQuery(preparedText: string, options?: PortCallOptions): Promise<number[]> {
    options?.signal?.throwIfAborted();
    return embedTextDeterministically(preparedText, this.profile.dimensions);
  }
}
