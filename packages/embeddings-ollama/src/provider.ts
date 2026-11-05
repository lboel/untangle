/**
 * `EmbeddingProvider` port implementation for Ollama (domain `ports.ts`,
 * spec.md §9, architecture.md §6.8).
 */
import type {
  Clock,
  EmbeddingBatchResultV1,
  EmbeddingProfile,
  EmbeddingProvider,
  EmbeddingReadinessV1,
  PortCallOptions,
  Random,
} from "@untangle-code/domain";
import { buildEmbeddingProfileId, isUntangleError, sha256Hex } from "@untangle-code/domain";
import { embeddingUnavailableError, jobCancelledError } from "@untangle-code/observability";

import type { BackoffConfig } from "./backoff.js";
import { withRetry } from "./backoff.js";
import { InMemoryEmbeddingCache } from "./cache.js";
import { mapWithConcurrency } from "./concurrency.js";
import { isRequestCancellation, OllamaHttpClient, OllamaHttpError } from "./http.js";
import type { Deferred } from "./inflight.js";
import { createDeferred, InFlightRegistry, raceWithSignal } from "./inflight.js";
import { embed } from "./ollama-api.js";
import { runReadinessSequence } from "./readiness.js";
import { realSleep } from "./sleep.js";
import { wouldProviderTruncate } from "./truncation.js";
import type {
  EmbeddingBatchProgressV1,
  EmbeddingCacheEntry,
  EmbeddingCacheKey,
  EmbeddingCachePort,
  OllamaEmbeddingProviderConfig,
  SleepFn,
} from "./types.js";
import { DEFAULT_BASE_BACKOFF_MS, DEFAULT_MAX_BACKOFF_MS, DEFAULT_MAX_RETRIES } from "./types.js";
import { assertVectorDimension } from "./validation.js";

export interface OllamaEmbeddingProviderDeps {
  clock: Clock;
  random: Random;
  /** Defaults to {@link InMemoryEmbeddingCache} (spec.md §9.4). */
  cache?: EmbeddingCachePort;
  /** Defaults to {@link realSleep}; tests inject a fake that resolves instantly. */
  sleep?: SleepFn;
  /** Defaults to the global `fetch`; tests inject a fake transport. */
  fetchImpl?: typeof fetch;
}

/**
 * Ein von diesem Aufruf beanspruchter, noch nicht eingebetteter Schlüssel:
 * In-flight-Platz (`keyString`), Cache-Schlüssel, Text und das Deferred, über
 * das jeder beigetretene Aufrufer sein Ergebnis erhält.
 */
interface ClaimedEmbedItem {
  keyString: string;
  key: EmbeddingCacheKey;
  text: string;
  deferred: Deferred<EmbeddingCacheEntry>;
}

function isRetryableEmbedError(error: unknown): boolean {
  return error instanceof OllamaHttpError && error.retryable;
}

/** Same shape as `cache.ts`'s internal key string — local to this module, used only for in-flight bookkeeping. */
function cacheKeyString(key: EmbeddingCacheKey): string {
  return `${key.embeddingProfileId}:${key.preparedTextHash}`;
}

/** Splits `items` into consecutive slices of at most `size` (the last one possibly shorter). */
function chunkIntoSlices<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) {
    return [];
  }
  const slices: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    slices.push(items.slice(start, start + size));
  }
  return slices;
}

/** Normalizes any thrown value into the `UntangleError` this package's public API promises (rule 8). */
function normalizeError(error: unknown, signal: AbortSignal | undefined): unknown {
  if (isUntangleError(error)) {
    return error;
  }
  if (isRequestCancellation(error, signal)) {
    return jobCancelledError("Ollama embedding operation was cancelled.", {
      cause: error,
      retryable: false,
    });
  }
  if (error instanceof OllamaHttpError) {
    return embeddingUnavailableError(error.message, {
      cause: error,
      retryable: false,
      context: error.status === undefined ? {} : { status: error.status },
    });
  }
  return embeddingUnavailableError(`Unexpected Ollama embedding provider error: ${String(error)}`, {
    cause: error,
    retryable: false,
  });
}

async function guarded<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  try {
    signal?.throwIfAborted();
    return await fn();
  } catch (error) {
    throw normalizeError(error, signal);
  }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  public readonly profile: EmbeddingProfile;
  public readonly profileId: string;

  private readonly config: OllamaEmbeddingProviderConfig;
  private readonly clock: Clock;
  private readonly random: Random;
  private readonly cache: EmbeddingCachePort;
  private readonly sleep: SleepFn;
  private readonly httpClient: OllamaHttpClient;
  private readonly backoffConfig: BackoffConfig;

  private cachedReadiness: EmbeddingReadinessV1 | undefined;
  private resolvedEndpointUrl: string | undefined;
  private readyPromise: Promise<void> | undefined;

  /**
   * One shared fetch-and-cache operation per still-uncached cache key
   * (spec.md §9.4, WP-78): concurrent `embedDocuments`/`embedQuery` calls
   * that race for the same not-yet-cached text join the SAME `/api/embed`
   * request instead of each starting their own.
   */
  private readonly inFlightEmbeds = new InFlightRegistry<EmbeddingCacheEntry>();

  public constructor(config: OllamaEmbeddingProviderConfig, deps: OllamaEmbeddingProviderDeps) {
    this.config = config;
    this.profile = config.profile;
    this.profileId = buildEmbeddingProfileId(config.profile);
    this.clock = deps.clock;
    this.random = deps.random;
    this.cache = deps.cache ?? new InMemoryEmbeddingCache();
    this.sleep = deps.sleep ?? realSleep;
    this.httpClient = new OllamaHttpClient({
      requestTimeoutMs: config.requestTimeoutMs,
      maxConnections: config.maxConnections,
      apiKeyEnv: config.apiKeyEnv,
      fetchImpl: deps.fetchImpl,
    });
    this.backoffConfig = {
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      baseDelayMs: config.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
      maxDelayMs: config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    };
  }

  public async ensureReady(options?: PortCallOptions): Promise<EmbeddingReadinessV1> {
    return guarded(options?.signal, async () => {
      await this.ensureReadyOnce(options?.signal);
      // Non-null: ensureReadyOnce either already resolved it or just did.
      return this.cachedReadiness as EmbeddingReadinessV1;
    });
  }

  public async embedDocuments(
    preparedTexts: string[],
    options?: PortCallOptions & { onBatchProgress?: (progress: EmbeddingBatchProgressV1) => void },
  ): Promise<EmbeddingBatchResultV1> {
    return guarded(options?.signal, async () => {
      if (preparedTexts.length === 0) {
        return { vectors: [], truncated: [] };
      }
      await this.ensureReadyOnce(options?.signal);
      return this.embedTexts(preparedTexts, options?.signal, options?.onBatchProgress);
    });
  }

  public async embedQuery(preparedText: string, options?: PortCallOptions): Promise<number[]> {
    return guarded(options?.signal, async () => {
      await this.ensureReadyOnce(options?.signal);
      const { vectors } = await this.embedTexts([preparedText], options?.signal);
      return vectors[0] as number[];
    });
  }

  /**
   * Runs the readiness sequence exactly once per instance; concurrent
   * callers (including through model-pull, spec.md §9.1 step 4) await the
   * SAME run rather than each starting their own (WP-78 fehlerklasse: the
   * same in-flight-dedup requirement applies here, not just to `/api/embed`).
   *
   * The shared run itself is started with NO caller's `signal` (it is
   * intentionally not tied to whichever caller happened to trigger it) —
   * `raceWithSignal` below still lets THIS caller's own signal reject its
   * own wait promptly, without cancelling the readiness sequence still
   * running for other, still-waiting callers.
   */
  private async ensureReadyOnce(signal: AbortSignal | undefined): Promise<void> {
    if (this.cachedReadiness) {
      return;
    }
    if (!this.readyPromise) {
      this.readyPromise = this.runReadiness().catch((error: unknown) => {
        // A failed attempt must not be cached — the next call retries from scratch.
        this.readyPromise = undefined;
        throw error;
      });
    }
    await raceWithSignal(this.readyPromise, signal);
  }

  private async runReadiness(): Promise<void> {
    const outcome = await runReadinessSequence(
      this.config,
      {
        httpClient: this.httpClient,
        clock: this.clock,
        random: this.random,
        sleep: this.sleep,
        backoffConfig: this.backoffConfig,
      },
      undefined,
    );
    this.cachedReadiness = outcome.readiness;
    this.resolvedEndpointUrl = outcome.endpointUrl;
  }

  private async embedTexts(
    texts: string[],
    signal: AbortSignal | undefined,
    onBatchProgress?: (progress: EmbeddingBatchProgressV1) => void,
  ): Promise<EmbeddingBatchResultV1> {
    const endpointUrl = this.resolvedEndpointUrl;
    if (!endpointUrl) {
      throw embeddingUnavailableError(
        "Ollama embedding provider is not ready (no resolved endpoint).",
        {
          retryable: false,
        },
      );
    }
    const slices = chunkIntoSlices(texts, Math.max(1, this.config.batchSize));
    const batchCount = slices.length;
    let embeddedCount = 0;

    const sliceResults = await mapWithConcurrency(
      slices,
      this.config.maxConnections,
      async (slice, sliceIndex) => {
        signal?.throwIfAborted();
        const result = await this.embedSlice(slice, endpointUrl, signal);
        embeddedCount += slice.length;
        onBatchProgress?.({
          batchIndex: sliceIndex,
          batchCount,
          embeddedCount,
          totalCount: texts.length,
        });
        return result;
      },
    );

    const vectors = sliceResults.flatMap((result) => result.vectors);
    const truncated = sliceResults.flatMap((result) => result.truncated);
    return { vectors, truncated };
  }

  private async embedSlice(
    texts: string[],
    endpointUrl: string,
    signal: AbortSignal | undefined,
  ): Promise<EmbeddingBatchResultV1> {
    const keys: EmbeddingCacheKey[] = texts.map((text) => ({
      embeddingProfileId: this.profileId,
      preparedTextHash: sha256Hex(text),
    }));
    const keyStrings = keys.map(cacheKeyString);
    const cached = await Promise.all(keys.map((key) => this.cache.get(key, { signal })));

    const vectors = new Array<number[]>(texts.length);
    const truncated = new Array<boolean>(texts.length);

    // Group the still-missing positions by cache key: (a) the SAME prepared
    // text appearing more than once in this slice must be embedded only
    // once (spec.md §9.4, WP-78 "Batch-interne Deduplizierung"), and (b) a
    // key already being fetched by ANOTHER concurrent call is joined below
    // instead of triggering a second `/api/embed` request.
    const missGroups = new Map<string, number[]>();
    for (let index = 0; index < texts.length; index += 1) {
      const hit = cached[index];
      if (hit) {
        vectors[index] = hit.vector;
        truncated[index] = hit.truncated;
        continue;
      }
      const keyString = keyStrings[index] as string;
      const group = missGroups.get(keyString);
      if (group) {
        group.push(index);
      } else {
        missGroups.set(keyString, [index]);
      }
    }

    if (missGroups.size === 0) {
      return { vectors, truncated };
    }
    signal?.throwIfAborted();

    // Claim/join in-flight fetches. This loop MUST NOT `await` anything: two
    // concurrent `embedSlice` calls that both read a cache miss for the same
    // key resume as two separate, atomically-run continuations (JS never
    // interleaves them mid-loop), so whichever runs this claiming loop first
    // wins the key and the other necessarily observes and joins it instead
    // of starting its own fetch (WP-78 "Nebenläufigkeit").
    const toFetch: ClaimedEmbedItem[] = [];
    const pending: { indexes: number[]; promise: Promise<EmbeddingCacheEntry> }[] = [];
    for (const [keyString, indexes] of missGroups) {
      const existing = this.inFlightEmbeds.get(keyString);
      if (existing) {
        pending.push({ indexes, promise: existing });
        continue;
      }
      const deferred = createDeferred<EmbeddingCacheEntry>();
      this.inFlightEmbeds.register(keyString, deferred.promise);
      const firstIndex = indexes[0] as number;
      toFetch.push({
        keyString,
        key: keys[firstIndex] as EmbeddingCacheKey,
        text: texts[firstIndex] as string,
        deferred,
      });
      pending.push({ indexes, promise: deferred.promise });
    }

    if (toFetch.length > 0) {
      // Deliberately not awaited here: the underlying request must survive
      // (and keep serving every joined caller) even if THIS caller — the
      // one that happened to claim the keys — is the one whose own signal
      // aborts. Errors are routed to each `deferred` inside the method, so
      // this can never become an unhandled rejection.
      void this.fetchAndSettle(toFetch, endpointUrl);
    }

    await Promise.all(
      pending.map(async ({ indexes, promise }) => {
        // `raceWithSignal`, not `promise` directly: THIS call's own signal
        // must be able to reject THIS call without cancelling the shared
        // fetch for any other caller still awaiting the same key.
        const entry = await raceWithSignal(promise, signal);
        for (const index of indexes) {
          vectors[index] = entry.vector;
          truncated[index] = entry.truncated;
        }
      }),
    );

    return { vectors, truncated };
  }

  /**
   * Fetches every text in `items` in a SINGLE `/api/embed` request and
   * settles each item's `deferred` with its own resulting cache entry, or
   * rejects all of them on failure — which also frees their in-flight slots
   * (`InFlightRegistry.register`'s cleanup), so the next call retries from
   * scratch rather than being stuck on a broken promise (WP-78).
   *
   * Vor dem Absetzen des Requests wird der Cache ein ZWEITES Mal gelesen
   * (WP-117, siehe {@link revalidateBeforeFetch}): die Miss-Entscheidung in
   * `embedSlice` kann veraltet sein, sobald `cache.get()` verzögert auflöst.
   *
   * Intentionally takes no `AbortSignal`: this operation is shared by
   * however many callers joined it, so it is not tied to any single one of
   * their lifecycles (see `embedSlice`/`raceWithSignal`).
   */
  private async fetchAndSettle(items: ClaimedEmbedItem[], endpointUrl: string): Promise<void> {
    try {
      // WP-117: erst jetzt, mit den bereits beanspruchten In-flight-Plätzen
      // in der Hand, steht fest, was wirklich über die Leitung muss.
      const outstanding = await this.revalidateBeforeFetch(items);
      if (outstanding.length === 0) {
        return;
      }
      const texts = outstanding.map((item) => item.text);
      const response = await withRetry(
        () => embed(this.httpClient, endpointUrl, this.profile.model, texts),
        this.backoffConfig,
        { random: this.random, sleep: this.sleep },
        { isRetryable: isRetryableEmbedError },
      );
      if (response.embeddings.length !== outstanding.length) {
        throw embeddingUnavailableError(
          `Ollama /api/embed returned ${response.embeddings.length} vectors for ${outstanding.length} inputs.`,
          { retryable: false },
        );
      }
      for (let j = 0; j < outstanding.length; j += 1) {
        const item = outstanding[j] as ClaimedEmbedItem;
        const vector = response.embeddings[j] as number[];
        assertVectorDimension(vector, this.profile.dimensions, {
          endpoint: endpointUrl,
          model: this.profile.model,
          stage: "embed",
        });
        const isTruncated = wouldProviderTruncate(item.text, this.config.contextLength);
        const entry: EmbeddingCacheEntry = { vector, truncated: isTruncated };
        await this.cache.set(item.key, entry);
        item.deferred.resolve(entry);
      }
    } catch (error) {
      // Bewusst über `items` und nicht über `outstanding`: schlägt schon die
      // Revalidierung fehl, ist `outstanding` gar nicht bestimmt. Ein bereits
      // aus dem Cache aufgelöstes Deferred ignoriert das spätere `reject`
      // (die erste Festlegung gewinnt), ein noch offenes wird sicher
      // abgewiesen — kein Aufrufer bleibt hängen.
      for (const item of items) {
        item.deferred.reject(error);
      }
    }
  }

  /**
   * Zweite Cache-Prüfung unmittelbar vor dem Request (WP-117).
   *
   * `embedSlice` trifft die Miss-/Join-Entscheidung EINMAL, aus einem
   * einzigen `Promise.all` über `cache.get()`. Ein Cache, dessen `get()` den
   * Zustand zum Aufrufzeitpunkt liest, aber erst später auflöst — also jeder
   * netzgebundene Cache und damit genau der vorgesehene Erweiterungspunkt
   * für einen persistenten Adapter —, öffnet ein Fenster: Aufrufer A kann
   * zwischen der Anfrage und dem Auflösen von B's `get()` vollständig fertig
   * werden, seinen Eintrag schreiben und seinen In-flight-Platz wieder
   * freigeben. B fände dann weder Cache-Treffer noch In-flight-Eintrag und
   * würde denselben Text ein zweites Mal einbetten.
   *
   * Diese Prüfung schließt das Fenster, weil sie STRIKT NACH der Beanspruchung
   * des In-flight-Platzes liegt: der Platz wird erst freigegeben, nachdem
   * `cache.set()` aufgelöst hat (siehe unten), also sieht ein `get()`, das
   * danach abgesetzt wird, den geschriebenen Eintrag.
   *
   * Kein Deadlock und keine Wiederholungsschleife: genau EIN zusätzliches
   * `cache.get()` je beanspruchtem Schlüssel, kein Warten auf fremde
   * Deferreds (die eigenen Plätze hält dieser Aufruf selbst, ein anderer
   * Aufrufer kann sie also nicht beanspruchen), und jedes Deferred wird auf
   * jedem Pfad festgelegt — aus dem Cache, aus der Antwort oder per
   * `reject` im `catch`.
   *
   * Kein `AbortSignal`: dieser Lauf gehört keinem einzelnen Aufrufer
   * (dieselbe Begründung wie bei {@link fetchAndSettle}).
   *
   * Ein Fehler des Caches wird NICHT verschluckt (E4), sondern nach oben
   * gereicht und weist damit die beteiligten Deferreds ab — dasselbe
   * sichtbare Verhalten wie bei einem Fehlschlag der ERSTEN Cache-Lesung in
   * `embedSlice`. Preis dieser Prüfung: eine zusätzliche Cache-Lesung je
   * echtem Miss (dokumentiert in der README).
   */
  private async revalidateBeforeFetch(items: ClaimedEmbedItem[]): Promise<ClaimedEmbedItem[]> {
    // Erst alle Lesungen abschließen, dann festlegen: so ist bei einem Fehler
    // noch kein Deferred aufgelöst und der `catch` in `fetchAndSettle` weist
    // wirklich alle ab.
    const lateHits = await Promise.all(items.map(async (item) => this.cache.get(item.key)));
    const outstanding: ClaimedEmbedItem[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index] as ClaimedEmbedItem;
      const hit = lateHits[index];
      if (hit) {
        item.deferred.resolve(hit);
        continue;
      }
      outstanding.push(item);
    }
    return outstanding;
  }
}
