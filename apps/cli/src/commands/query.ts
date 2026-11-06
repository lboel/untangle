/**
 * `untangle query` — der Befehl, um den es geht.
 *
 * Er verdrahtet @untangle-code/search und macht dabei ZWEI Dinge unter EINER
 * Oberflaeche sichtbar (Nutzerwunsch A4):
 *
 *   - die SEMANTISCHE Suche (hybrid aus dichtem Vektor, BM25 und exaktem
 *     Symbolnamen, fusioniert per RRF), und
 *   - die GREP-artige Suche (Literal oder regulaerer Ausdruck) mit
 *     Kontextzeilen, Pfad-Ein-/Ausschluss und Trefferbegrenzung.
 *
 * `--explain` ist kein Debug-Anhang, sondern der Kern von vision.md §1d: die
 * Score-Zerlegung beantwortet „warum steht das oben?" — und damit auch die
 * Gegenfrage „warum steht der richtige Treffer NICHT oben?".
 *
 * WICHTIG UND EHRLICH: Gesucht wird im INDEX, nicht auf der Platte. Solange
 * `untangle index` fehlt (siehe dort), ist der Index leer. Dieser Befehl
 * behauptet dann nicht „nichts gefunden", sondern nennt den fehlenden Index
 * als Grund und endet mit Exit-Code 4.
 */

import path from "node:path";

import { OfflineEmbeddingProvider } from "@untangle-code/core";
import {
  compareCodepoints,
  isUntangleError,
  embeddingProfileShortId,
  INDEX_CONTEXT_INCOMPLETE_WARNING_CODE,
  uniqueSortedByCodepoints,
  type IndexFreshnessV1,
  type SearchHitV1,
  type SearchResultSetV1,
  type SkipLedgerEntryV1,
} from "@untangle-code/domain";
import {
  COMPLEXITY_BIASES,
  GREP_SORTS,
  NO_SUFFICIENT_MATCH_WARNING_CODE,
  OUTPUT_FORMATS,
  SEARCH_ABSTENTIONS,
  SEARCH_MODES,
  SEARCH_SORTS,
  formatGrepResultSet,
  formatHitAsText,
  formatSearchGraphRelationsAsText,
  formatSearchResultSet,
  type ComplexityBias,
  type GrepRequestV1,
  type GrepResultSetV1,
  type GrepSort,
  type OutputFormat,
  type SearchAbstention,
  type SearchMode,
  type SearchSort,
  type UntangleSearchRequestV1,
} from "@untangle-code/search";
import { codeCollectionName } from "@untangle-code/storage-qdrant";

import {
  boolFlag,
  enumFlag,
  integerFlag,
  listFlag,
  numberFlag,
  stringFlag,
  type FlagSpecs,
  type ParsedArgs,
} from "../cli/args.js";
import type { Command, CommandContext } from "../cli/command.js";
import { withDeadline } from "../cli/deadline.js";
import { EXIT, EnvironmentError, OperationalError, UsageError } from "../cli/exit.js";
import { inspectIndexFreshness } from "../cli/index-freshness.js";
import { refreshWorkspaceIndex } from "../cli/index-refresh.js";
import {
  resolveIndexState,
  type EmbedderChoice,
  type FoundIndexState,
  type IndexStateResolution,
} from "../cli/index-state.js";
import { line, note } from "../cli/io.js";
import { createSearchGraphEnrichment } from "../cli/search-graph-enrichment.js";
import { systemClock } from "../cli/system.js";
import {
  errorMessage,
  loadWorkspace,
  wireEmbedder,
  wireSearchEngine,
  wireStorage,
  matchesStoredBackend,
  storageIndexScope,
} from "../cli/workspace.js";

/**
 * Frist der ganzen Anfrage.
 *
 * Includes retrieval and optional graph enrichment. Semantic/hybrid search
 * also computes a query embedding, which can require loading a service model.
 * The finite deadline keeps an unresponsive terminal from hanging indefinitely.
 */
export const DEFAULT_QUERY_TIMEOUT_MS = 60_000;

const FLAGS: FlagSpecs = {
  embedder: {
    kind: "string",
    placeholder: "auto|service|offline",
    describe:
      "auto selects the last index run's profile; service forces the configured service, offline selects the locally built collection.",
    defaultLabel: "auto",
  },
  root: {
    kind: "string",
    placeholder: "PATH",
    describe: "Project directory; configuration is discovered from here.",
    defaultLabel: "current directory",
  },
  format: {
    kind: "string",
    placeholder: OUTPUT_FORMATS.join("|"),
    describe: "Output format. jsonl is streamable; json contains the complete result.",
    defaultLabel: "text",
  },
  limit: { kind: "number", alias: "n", placeholder: "N", describe: "Number of results." },
  explain: {
    kind: "boolean",
    describe: "Show each result's score breakdown (vision.md §1d).",
  },
  mode: {
    kind: "string",
    placeholder: SEARCH_MODES.join("|"),
    describe: "Independent retrieval and ranking paths: lexical/symbol require no embedding.",
    defaultLabel: "hybrid",
  },
  abstention: {
    kind: "string",
    placeholder: SEARCH_ABSTENTIONS.join("|"),
    describe:
      "Behavior with insufficient evidence: strict returns no hits; evidence returns hits with the verdict.",
    defaultLabel: "strict",
  },
  sort: {
    kind: "string",
    placeholder: SEARCH_SORTS.join("|"),
    describe: "Result sort key.",
    defaultLabel: "relevance",
  },
  content: { kind: "boolean", describe: "Include chunk content (token-intensive)." },
  linked: {
    kind: "boolean",
    describe: "Direct, unambiguously resolved relationships from the persisted symbol graph.",
  },
  "min-score": {
    kind: "number",
    placeholder: "X",
    describe: "Discard results below this score.",
  },
  "complexity-bias": {
    kind: "string",
    placeholder: COMPLEXITY_BIASES.join("|"),
    describe: "Prefer simpler or more complex results (vision.md §1b).",
    defaultLabel: "none",
  },
  path: {
    kind: "list",
    placeholder: "GLOB",
    describe: "Include these paths only. Repeatable.",
  },
  exclude: {
    kind: "list",
    placeholder: "GLOB",
    describe: "Exclude these paths. Repeatable.",
  },
  lang: { kind: "list", placeholder: "ID", describe: "Include these languages only. Repeatable." },
  repo: {
    kind: "list",
    placeholder: "ID",
    describe: "Include these repositories only. Repeatable.",
  },
  ref: { kind: "list", placeholder: "ID", describe: "Include these refs only. Repeatable." },
  symbol: { kind: "list", placeholder: "NAME", describe: "Exact symbol names. Repeatable." },
  workspace: { kind: "string", placeholder: "ID", describe: "Override workspace ID." },
  timeout: {
    kind: "number",
    placeholder: "MS",
    describe: "Deadline for the entire query. Expiry makes the query fail.",
    defaultLabel: String(DEFAULT_QUERY_TIMEOUT_MS),
  },
  refresh: {
    kind: "boolean",
    describe: "Refresh stale checked-out refs before searching; progress goes to stderr.",
  },
  "require-fresh": {
    kind: "boolean",
    describe: "Search only with confirmed current content hashes; otherwise exit 4.",
  },

  // --- grep-Modus (Nutzerwunsch A4) ---------------------------------------
  grep: {
    kind: "boolean",
    alias: "g",
    describe: "grep mode: literal search in indexed content.",
  },
  regex: { kind: "boolean", alias: "e", describe: "grep mode with a regular expression." },
  "ignore-case": {
    kind: "boolean",
    alias: "i",
    describe: "grep: ignore letter case.",
  },
  word: {
    kind: "boolean",
    alias: "w",
    describe: "grep: whole words only (identifier boundaries).",
  },
  after: {
    kind: "number",
    alias: "A",
    placeholder: "N",
    describe: "grep: context lines after the match.",
  },
  before: {
    kind: "number",
    alias: "B",
    placeholder: "N",
    describe: "grep: context lines before the match.",
  },
  context: {
    kind: "boolean-or-number",
    alias: "C",
    placeholder: "N",
    describe:
      "Search: direct relationships from the persisted file graph. grep: =N or -C N shows context on both sides.",
  },
  "max-matches": {
    kind: "number",
    placeholder: "N",
    describe: "grep: maximum total matches.",
  },
  "max-per-file": { kind: "number", placeholder: "N", describe: "grep: maximum matches per file." },
  "max-scanned": {
    kind: "number",
    placeholder: "N",
    describe: "grep: maximum searched chunks.",
  },
  "grep-sort": {
    kind: "string",
    placeholder: GREP_SORTS.join("|"),
    describe: "grep: match ordering.",
    defaultLabel: "path",
  },
};

export const queryCommand: Command = {
  spec: {
    name: "query",
    implementedBy: "commands/query.js",
    summary: "Search the index with semantic and grep-style queries",
    usage: "untangle query <text> [options]",
    details: [
      "Without --grep/--regex, hybrid search retrieves dense vectors, BM25 and exact symbols independently, then combines them with RRF. --mode selects independent retrieval and ranking paths; lexical/symbol need no embedding service.",
      "Before each search, index freshness is checked against the full current content manifest and returned as indexFreshness. --refresh updates stale checked-out refs; --require-fresh rejects unconfirmed freshness. An outdated lexical index format requires reindexing.",
      "--grep (literal) and --regex search the same index with the same filters and skip ledger. Context lines come from the same chunk and stop at its boundary.",
      "--explain shows the full score breakdown: each component's raw value, weight and contribution, making the ranking inspectable.",
      "Profile discovery: `untangle index` records the embedding profile per repository/ref in the local registry (.untangle/index-states-v1). Without --embedder, query uses the generation-bound current state and reports that choice on stderr. Override with --embedder=service or --embedder=offline.",
      "Search reads the index, not the working tree. Unindexed content cannot be found; the result therefore includes its skip ledger and, for grep, the number of searched chunks.",
    ],
    flags: FLAGS,
    examples: [
      'untangle query "where is the payment triggered"',
      'untangle query "charge" --mode=symbol --explain',
      "untangle query --regex \"await\\\\s+fetch\\\\(\" -C 2 --path='src/**' --exclude='**/*.test.ts'",
      'untangle query "retry" --format=jsonl | jq -r .filePath',
    ],
    exitCodes: [
      [EXIT.ok, "Search completed, including zero-hit results."],
      [EXIT.operational, "Invalid configuration or a storage error."],
      [EXIT.usage, "Invalid arguments."],
      [
        EXIT.environment,
        "No compatible index, or the selected storage/embedding provider is unavailable.",
      ],
      [EXIT.cancelled, "Cancelled."],
    ],
  },

  async run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
    const format = enumFlag<OutputFormat>(args, "format", OUTPUT_FORMATS, "text");
    const isGrep = boolFlag(args, "grep") || boolFlag(args, "regex");
    const text = args.positionals.join(" ").trim();
    if (text.length === 0) {
      throw new UsageError(
        "Search text is required.",
        isGrep
          ? 'Example: untangle query --regex "await\\\\s+fetch\\\\("'
          : 'Example: untangle query "where is the payment triggered"',
      );
    }

    const view = loadWorkspace({
      cwd: args.flags["root"] === undefined ? ctx.cwd : String(args.flags["root"]),
      env: ctx.env,
      workspaceIdOverride: stringFlag(args, "workspace"),
      strict: true,
    });
    if (view.load.warnings.length > 0) {
      for (const warning of view.load.warnings) {
        note(ctx.io, `Configuration warning: ${warning.path || "(root)"}: ${warning.message}`);
      }
    }

    const wiring = wireStorage(view, ctx.env);
    const timeoutMs = integerFlag(args, "timeout", DEFAULT_QUERY_TIMEOUT_MS);

    // `untangle index --embedder=offline` legt seine Punkte in einer EIGENEN
    // Sammlung ab (eigener `embedding_profile_id`, spec.md §10.1) — sonst
    // mischten netzlose und echte Vektoren in einem Raum, in dem sie nicht
    // vergleichbar sind. Damit dieser Index auch DURCHSUCHBAR ist, kennt
    // `query` denselben Schalter.
    //
    // WP-229: Ihn zu KENNEN reichte aber nicht — man musste ihn auch bei jeder
    // Abfrage wiederholen. `auto` liest deshalb den Indexzustand, den
    // `untangle index` hinterlaesst, und nimmt von dort, WOMIT tatsaechlich
    // indiziert wurde. Geraten wird nichts: gibt es keinen Zustand, gilt die
    // Konfiguration wie bisher, und widersprechen sich mehrere, sagt der
    // Befehl das und laesst den Nutzer entscheiden.
    const selectedRepoIds = listFlag(args, "repo");
    const selectedRefIds = listFlag(args, "ref");
    const indexStateResolution = await resolveIndexState(
      indexStateRoots({
        invocationRoot:
          args.flags["root"] === undefined
            ? ctx.cwd
            : path.resolve(ctx.cwd, String(args.flags["root"])),
        configBaseDir: view.load.sources.configBaseDir,
        repositories: view.config.repositories ?? [],
        selectedRepoIds,
      }),
      view.workspaceId,
      { repoIds: selectedRepoIds, refs: selectedRefIds, ...storageIndexScope(wiring) },
    );
    if (indexStateResolution.kind === "invalid") {
      const details = indexStateResolution.diagnostics
        .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
        .join("; ");
      throw new EnvironmentError(
        `The local index state is invalid; search will not use partial or ` +
          `stale provenance. ${details}`,
        "Rerun the affected indexing job. It publishes the repository/ref registry atomically.",
      );
    }
    const automaticEmbedder =
      enumFlag(args, "embedder", ["auto", "service", "offline"] as const, "auto") === "auto";
    const useOffline = resolveEmbedderChoice(ctx, args, indexStateResolution);
    const embedder = useOffline ? new OfflineEmbeddingProvider(systemClock) : wireEmbedder(view);
    const searchView = useOffline
      ? {
          ...view,
          profile: embedder.profile,
          profileId: embedder.profileId,
          profileShortId: embeddingProfileShortId(embedder.profileId),
        }
      : view;
    const collection = useOffline
      ? codeCollectionName(wiring.collectionPrefix, searchView.profileShortId)
      : wiring.codeCollection;
    const foundIndexStates = queryIndexStatesFromResolution(
      indexStateResolution,
      automaticEmbedder,
    );
    const compatibleIndexStates = foundIndexStates.filter(
      ({ state }) =>
        state.embeddingProfileId === searchView.profileId &&
        state.collection === collection &&
        matchesStoredBackend(state, wiring),
    );
    const freshnessCheck = await withDeadline(
      (signal) =>
        inspectIndexFreshness(view, compatibleIndexStates, {
          signal,
          expectedRepoIds: selectedRepoIds.length > 0 ? selectedRepoIds : view.repoIds,
          expectedRefs: selectedRefIds,
        }),
      timeoutMs,
      ctx.signal,
    );
    ctx.signal.throwIfAborted();
    const indexFreshness: IndexFreshnessV1 = freshnessCheck.ok
      ? freshnessCheck.value
      : {
          status: "unknown",
          checkedAt: systemClock.nowIso(),
          repositories: [],
        };
    if (boolFlag(args, "refresh") && indexFreshness.status !== "fresh") {
      await refreshWorkspaceIndex(ctx, {
        view,
        repoIds: selectedRepoIds,
        refIds: selectedRefIds,
        embedder: useOffline ? "offline" : "auto",
      });
      return queryCommand.run(ctx, {
        ...args,
        flags: { ...args.flags, refresh: false, "require-fresh": true },
      });
    }
    if (
      indexFreshness.status === "incompatible" ||
      (boolFlag(args, "require-fresh") && indexFreshness.status !== "fresh")
    ) {
      throw new EnvironmentError(
        `The search index is ${indexFreshness.status}; this query requires a current, compatible index.`,
        "Run the same query with --refresh or update with `untangle index`.",
      );
    }
    note(
      ctx.io,
      `Index freshness: ${indexFreshness.status} (content hashes checked ${indexFreshness.checkedAt}).`,
    );
    const indexContexts = compatibleIndexStates.flatMap(({ state }) =>
      state.generationId !== undefined
        ? [
            {
              repoId: state.repoId,
              refId: state.refId,
              generationId: state.generationId,
              ...(state.corpusRevisionFingerprint === undefined || indexFreshness.status !== "fresh"
                ? {}
                : { corpusRevisionFingerprint: state.corpusRevisionFingerprint }),
              outcome: state.outcome,
            },
          ]
        : [],
    );
    const effectiveRefIds = queryRefIdsFromIndexStates(selectedRefIds, compatibleIndexStates);

    // Der fehlende Index ist der haeufigste Fall und verdient eine eigene,
    // eindeutige Antwort — nicht eine leere Trefferliste (E4).
    const probe = await withDeadline<boolean>(
      (signal) => wiring.vectorStore.collectionExists(collection, { signal }),
      timeoutMs,
      ctx.signal,
    );
    if (!probe.ok) {
      ctx.signal.throwIfAborted();
      throw new EnvironmentError(
        probe.timedOut
          ? `${wiring.backend === "qdrant" ? "Qdrant" : "LanceDB"} at ${wiring.storeUrl} did not answer within ${String(timeoutMs)}ms.`
          : `${wiring.backend === "qdrant" ? "Qdrant" : "LanceDB"} at ${wiring.storeUrl} is unreachable: ${errorMessage(probe.error)}`,
        "Run `untangle doctor` for the next step specific to this failure.",
        { cause: probe.error },
      );
    }
    if (!probe.value) {
      if (boolFlag(args, "refresh")) {
        await refreshWorkspaceIndex(ctx, {
          view,
          repoIds: selectedRepoIds,
          refIds: selectedRefIds,
          embedder: useOffline ? "offline" : "auto",
        });
        return queryCommand.run(ctx, {
          ...args,
          flags: { ...args.flags, refresh: false, "require-fresh": true },
        });
      }
      throw new EnvironmentError(
        `No index exists for this embedding profile: collection "${collection}" ` +
          `is absent from ${wiring.storeUrl}. Nothing was searched; this does not ` +
          `mean there are no results.`,
        useOffline
          ? "Run `untangle index --embedder=offline` to build this collection."
          : "Run `untangle index`. Without an available embedding service, use `untangle index --embedder=offline` and select `--embedder=offline` here too.",
      );
    }

    const engine = wireSearchEngine({
      view: searchView,
      vectorStore: wiring.vectorStore,
      collection,
      embedder,
      indexContexts,
      ...(!isGrep && (boolFlag(args, "context") || boolFlag(args, "linked"))
        ? { graphEnrichment: createSearchGraphEnrichment(wiring.storage.graphStore) }
        : {}),
    });

    if (isGrep) {
      const request = buildGrepRequest(args, view.workspaceId, text, effectiveRefIds);
      const outcome = await withDeadline<GrepResultSetV1>(
        (signal) => engine.grep(request, { signal }),
        timeoutMs,
        ctx.signal,
      );
      if (!outcome.ok) {
        ctx.signal.throwIfAborted();
        throw toRuntimeError(outcome, wiring.storeUrl, timeoutMs, "grep", useOffline);
      }
      outcome.value.indexFreshness = indexFreshness;
      addFreshnessWarning(outcome.value, indexFreshness);
      renderGrep(ctx, outcome.value, format);
      assertEverythingWasSearched(ctx, outcome.value.skipped, wiring.backend);
      return EXIT.ok;
    }

    const request = buildSearchRequest(
      args,
      view.workspaceId,
      text,
      selectedRefIds.length === 0 ? undefined : effectiveRefIds,
    );
    const outcome = await withDeadline<SearchResultSetV1>(
      (signal) => engine.search(request, { signal }),
      timeoutMs,
      ctx.signal,
    );
    if (!outcome.ok) {
      ctx.signal.throwIfAborted();
      throw toRuntimeError(outcome, wiring.storeUrl, timeoutMs, request, useOffline);
    }
    outcome.value.indexFreshness = indexFreshness;
    addFreshnessWarning(outcome.value, indexFreshness);
    renderSearch(ctx, outcome.value, format, boolFlag(args, "explain"));
    assertEverythingWasSearched(ctx, outcome.value.skipped, wiring.backend);
    return EXIT.ok;
  },
};

/* --------------------------------------------------------------------- */

export function addFreshnessWarning(
  result: Pick<SearchResultSetV1, "warnings">,
  freshness: IndexFreshnessV1,
): void {
  if (freshness.status === "fresh") return;
  const warning = {
    code: INDEX_CONTEXT_INCOMPLETE_WARNING_CODE,
    message: `Indexfrische ${freshness.status}: results describe an unconfirmed or stale snapshot. Update with --refresh. This query is not reliable product-complexity evidence.`,
    details: {
      status: freshness.status,
      checkedAt: freshness.checkedAt,
      reasons: freshness.repositories.map((entry) => entry.reason),
    },
  };
  const existingIndex = result.warnings.findIndex(
    (entry) => entry.code === INDEX_CONTEXT_INCOMPLETE_WARNING_CODE,
  );
  const existing = result.warnings[existingIndex];
  if (existing === undefined) result.warnings.push(warning);
  else
    result.warnings[existingIndex] = {
      ...existing,
      message: `${existing.message} ${warning.message}`,
      details: { ...existing.details, indexFreshness: warning.details },
    };
}

/**
 * Welcher Einbetter durchsucht wird — und woher diese Entscheidung stammt
 * (WP-229).
 *
 * `--embedder=offline` und `--embedder=service` sind ausdrueckliche
 * Anweisungen und gewinnen immer. `auto` fragt den Indexzustand: er ist die
 * einzige Quelle, die WEISS, womit gebaut wurde. Was dabei entschieden wird,
 * steht auf stderr — eine Wahl, die der Nutzer nicht sieht, ist eine Wahl,
 * die er nicht ueberstimmen kann.
 */
export function resolveEmbedderChoice(
  ctx: CommandContext,
  args: ParsedArgs,
  resolution: IndexStateResolution,
): boolean {
  const flag = enumFlag(args, "embedder", ["auto", "service", "offline"] as const, "auto");
  if (flag === "offline") return true;
  if (flag === "service") return false;

  if (resolution.kind === "none") {
    // Kein Zustand heisst: es wurde hier noch nicht indiziert, oder mit einer
    // aelteren Fassung. Dann gilt die Konfiguration — und wenn dazu kein Index
    // existiert, meldet das der Aufrufer mit der Begruendung, die es schon gab.
    return false;
  }

  if (resolution.kind === "ambiguous") {
    const states = resolution.found
      .map((entry) => `${entry.state.repoId}/${entry.state.refName}: ${entry.state.embedder}`)
      .join(", ");
    throw new UsageError(
      "The current repository/ref states use different embedders; `auto` " +
        `would search only a subset (${states}). Select --embedder=service or ` +
        "--embedder=offline explicitly.",
      "An explicit selection searches only locally registered refs for that profile.",
    );
  }

  if (resolution.kind === "invalid") {
    // The command rejects this case before selecting an embedder. Keeping the
    // guard here makes the helper exhaustive if it is reused independently.
    throw new EnvironmentError(
      "The local index state is invalid; the embedding profile will not be guessed.",
      "Rerun the affected indexing job.",
    );
  }

  const state = resolution.found.state;
  note(
    ctx.io,
    `Embedding profile from the last index run: ${describeEmbedder(state.embedder)} ` +
      `(${resolution.found.statePath}). ` +
      "Override with --embedder=service or --embedder=offline.",
  );
  if (state.outcome !== "completed") {
    note(
      ctx.io,
      `Warning: this indexing run ended as "${state.outcome}". Anything it could not finish ` +
        "cannot be found here either.",
    );
  }
  return state.embedder === "offline";
}

/**
 * Wo nach dem Indexzustand gesucht wird. Ohne Repo-Filter gilt die bisherige
 * Reihenfolge: Aufrufswurzel, Konfigurationswurzel, dann alle konfigurierten
 * Repositories codepoint-sortiert. Mit `--repo` duerfen dagegen nur die
 * tatsaechlich ausgewaehlten Repository-Wurzeln die Auto-Embedder-Wahl
 * beeinflussen; ein unbeteiligtes Repository darf keine Ambiguitaet erzeugen.
 */
export function indexStateRoots(input: {
  readonly invocationRoot: string;
  readonly configBaseDir: string;
  readonly repositories: readonly { readonly id: string; readonly path: string }[];
  readonly selectedRepoIds: readonly string[];
}): readonly string[] {
  const selected = new Set(input.selectedRepoIds);
  const roots: string[] =
    selected.size === 0 || input.repositories.length === 0
      ? [input.invocationRoot, input.configBaseDir]
      : [];
  const repositories = [...input.repositories]
    .filter((repository) => selected.size === 0 || selected.has(repository.id))
    .sort((a, b) => compareCodepoints(a.id, b.id));
  for (const repository of repositories) {
    roots.push(path.resolve(input.configBaseDir, repository.path));
  }
  return roots;
}

/**
 * Resolves an omitted ref scope to the refs for which the selected collection
 * has local index state. Explicit canonical IDs remain authoritative; an
 * explicit human ref name expands to every compatible canonical ID carrying
 * that name (for example `main` in two selected repositories).
 *
 * The grep path receives these IDs directly. Semantic search receives the
 * richer index contexts and derives the same scope inside the engine, where
 * it can still distinguish an implicit scope for provenance validation. This
 * is deliberately based on profile/collection-compatible states supplied by
 * the caller: an old state for another embedding space must not widen a scan.
 */
export function queryRefIdsFromIndexStates(
  requestedRefIds: readonly string[],
  compatibleIndexStates: readonly FoundIndexState[],
): string[] {
  if (requestedRefIds.length === 0) {
    return uniqueSortedByCodepoints(compatibleIndexStates.map(({ state }) => state.refId));
  }

  const canonicalIds = new Set(compatibleIndexStates.map(({ state }) => state.refId));
  const resolved: string[] = [];
  for (const requested of requestedRefIds) {
    if (canonicalIds.has(requested)) {
      resolved.push(requested);
      continue;
    }
    const nameMatches = compatibleIndexStates
      .filter(({ state }) => state.refName === requested)
      .map(({ state }) => state.refId);
    // Keep an unknown explicit value. It will remain a restrictive store
    // filter and cannot silently fall back to the implicit/all-ref scope.
    resolved.push(...(nameMatches.length === 0 ? [requested] : nameMatches));
  }
  return uniqueSortedByCodepoints(resolved);
}

/**
 * Auto-routing follows only the generation-checked current pointer of every
 * selected repo/ref. An explicit embedder selection may intentionally reopen
 * an older retained profile and therefore receives the complete registry.
 */
export function queryIndexStatesFromResolution(
  resolution: Exclude<IndexStateResolution, { readonly kind: "invalid" }>,
  automaticEmbedder: boolean,
): readonly FoundIndexState[] {
  if (resolution.kind === "none") return [];
  const all = resolution.all;
  return automaticEmbedder ? all.filter((entry) => entry.current) : all;
}

function describeEmbedder(choice: EmbedderChoice): string {
  return choice === "offline" ? "offline (local, in-process)" : "the configured service";
}

/**
 * Ziele, die ueberhaupt nicht durchsucht werden konnten.
 *
 * DIESE UNTERSCHEIDUNG IST DER KERN VON E4 AN DIESER OBERFLAECHE. Der
 * Abrufkern degradiert bewusst sichtbar: faellt ein Embedding-Profil aus (weil
 * Ollama nicht antwortet), meldet er das als Warnung UND als Ledger-Eintrag
 * und liefert die uebrigen Profile trotzdem. Fuer den Aufrufer sieht das
 * Ergebnis dann aus wie „null Treffer" — und genau das waere die Luege:
 * gesucht wurde nichts.
 *
 * Gemessen an einem blockierten Ollama gab diese Oberflaeche vor der
 * Einfuehrung dieser Pruefung „Keine Treffer." mit Exit-Code 0 aus, obwohl im
 * Ledger `provider_unavailable` stand. Jetzt endet derselbe Fall mit
 * Exit-Code 4 und der Begruendung aus dem Ledger.
 *
 * Erkannt wird der Ausfall an der Kombination, die der Abrufkern EXAKT fuer
 * diesen Fall schreibt: `subjectKind === "search_candidate"` zusammen mit
 * `reason === "provider_unavailable"`. Ein wegen Filtern oder Budget
 * ausgelassenes Ziel traegt stattdessen `excluded_by_configuration` und ist
 * kein Ausfall.
 */
export function failedTargets(skipped: readonly SkipLedgerEntryV1[]): readonly SkipLedgerEntryV1[] {
  return skipped.filter(
    (entry) => entry.subjectKind === "search_candidate" && entry.reason === "provider_unavailable",
  );
}

/** Wirft, wenn ein Ziel ausgefallen ist — „nichts durchsucht" ist kein Erfolg. */
function assertEverythingWasSearched(
  ctx: CommandContext,
  skipped: readonly SkipLedgerEntryV1[],
  backend: "lancedb" | "qdrant",
): void {
  const failed = failedTargets(skipped);
  if (failed.length === 0) return;
  for (const entry of failed) {
    note(ctx.io, `Unavailable target: ${entry.detail}`);
  }
  throw new EnvironmentError(
    `${String(failed.length)} search target(s) did not respond. The result above is ` +
      "incomplete; this does not mean nothing was found.",
    `Run \`untangle doctor\` to check Ollama and ${backend === "lancedb" ? "LanceDB" : "Qdrant"} independently with separate deadlines.`,
  );
}

export function buildSearchRequest(
  args: ParsedArgs,
  workspaceId: string,
  text: string,
  refIdsOverride?: readonly string[],
): UntangleSearchRequestV1 {
  if (typeof args.flags["context"] === "number") {
    throw new UsageError(
      'Option "--context=N" applies only in grep mode.',
      'For semantic search, use "--context" without a number.',
    );
  }
  const limit = numberFlag(args, "limit");
  const minScore = numberFlag(args, "min-score");
  const paths = listFlag(args, "path");
  const excludes = listFlag(args, "exclude");
  const languages = listFlag(args, "lang");
  const repositories = listFlag(args, "repo");
  const refs =
    refIdsOverride === undefined ? listFlag(args, "ref") : uniqueSortedByCodepoints(refIdsOverride);
  const symbolNames = listFlag(args, "symbol");

  return {
    query: text,
    workspaceId,
    ...(limit === undefined ? {} : { limit }),
    ...(minScore === undefined ? {} : { minScore }),
    ...(paths.length === 0 ? {} : { pathGlob: paths }),
    ...(excludes.length === 0 ? {} : { pathExclude: excludes }),
    ...(languages.length === 0 ? {} : { languages }),
    ...(repositories.length === 0 ? {} : { repositories }),
    ...(refs.length === 0 ? {} : { refs }),
    ...(symbolNames.length === 0 ? {} : { symbolNames }),
    mode: enumFlag<SearchMode>(args, "mode", SEARCH_MODES, "hybrid"),
    abstention: enumFlag<SearchAbstention>(args, "abstention", SEARCH_ABSTENTIONS, "strict"),
    sort: enumFlag<SearchSort>(args, "sort", SEARCH_SORTS, "relevance"),
    complexityBias: enumFlag<ComplexityBias>(args, "complexity-bias", COMPLEXITY_BIASES, "none"),
    includeContent: boolFlag(args, "content"),
    includeContext: boolFlag(args, "context"),
    includeLinked: boolFlag(args, "linked"),
  };
}

export function buildGrepRequest(
  args: ParsedArgs,
  workspaceId: string,
  pattern: string,
  refIdsOverride?: readonly string[],
): GrepRequestV1 {
  if (args.flags["context"] === true) {
    throw new UsageError(
      'Option "--context" requires a non-negative integer in grep mode.',
      'Example: "--context=2" or "-C 2".',
    );
  }
  const both = integerFlag(args, "context", 0);
  const before = integerFlag(args, "before", both);
  const after = integerFlag(args, "after", both);
  const paths = listFlag(args, "path");
  const excludes = listFlag(args, "exclude");
  const languages = listFlag(args, "lang");
  const repositories = listFlag(args, "repo");
  const refs =
    refIdsOverride === undefined ? listFlag(args, "ref") : uniqueSortedByCodepoints(refIdsOverride);
  const maxMatches = numberFlag(args, "max-matches");
  const maxPerFile = numberFlag(args, "max-per-file");
  const maxScanned = numberFlag(args, "max-scanned");

  return {
    pattern,
    regex: boolFlag(args, "regex"),
    // grep ist per Vorgabe gross-/kleinschreibungsempfindlich, wie das Werkzeug,
    // dessen Namen der Modus traegt. `-i` hebt das auf.
    caseSensitive: !boolFlag(args, "ignore-case"),
    wholeWord: boolFlag(args, "word"),
    workspaceId,
    ...(repositories.length === 0 ? {} : { repositories }),
    ...(refs.length === 0 ? {} : { refs }),
    ...(languages.length === 0 ? {} : { languages }),
    ...(paths.length === 0 ? {} : { pathGlob: paths }),
    ...(excludes.length === 0 ? {} : { pathExclude: excludes }),
    contextLinesBefore: before,
    contextLinesAfter: after,
    ...(maxMatches === undefined ? {} : { maxMatches }),
    ...(maxPerFile === undefined ? {} : { maxMatchesPerFile: maxPerFile }),
    ...(maxScanned === undefined ? {} : { maxScannedChunks: maxScanned }),
    sort: enumFlag<GrepSort>(args, "grep-sort", GREP_SORTS, "path"),
  };
}

/* --------------------------------------------------------------------- */

export function renderSearch(
  ctx: CommandContext,
  set: SearchResultSetV1,
  format: OutputFormat,
  explain: boolean,
): void {
  if (format !== "text") {
    // WP-230: `line` und nicht `out`. Die Formatierer liefern ihren Text OHNE
    // abschliessenden Zeilenumbruch; ohne ihn klebte der Ledger-Hinweis an der
    // letzten Ausgabezeile, und bei `jsonl` haette die letzte Zeile keinen
    // Abschluss — beides macht eine maschinenlesbare Ausgabe unlesbar.
    line(ctx.io, formatSearchResultSet(set, format));
    reportLedger(ctx, set.skipped.length, set.warnings.length);
    return;
  }

  // Die Enthaltung wird VOR dem Leer-Zweig bestimmt und unabhaengig von ihm
  // gemeldet. Frueher stand sie ausschliesslich in `if (totalHits === 0)` —
  // eine Enthaltung wurde also aus der Listenlaenge erschlossen. Sobald
  // Treffer trotz Ablehnung stehenbleiben, haette dieser Zweig geschwiegen und
  // eine selbstbewusst aussehende Trefferliste gedruckt.
  const insufficient = set.warnings.some(
    (warning) => warning.code === NO_SUFFICIENT_MATCH_WARNING_CODE,
  );

  if (set.totalHits === 0) {
    note(
      ctx.io,
      failedTargets(set.skipped).length > 0
        ? "No results, but the search was also incomplete (see below)."
        : insufficient
          ? "No sufficiently relevant results found."
          : "No results.",
    );
    reportLedger(ctx, set.skipped.length, set.warnings.length);
    if (set.skipped.length > 0) {
      note(ctx.io, "Skipped candidates appear in the --format=json skip ledger.");
    }
    return;
  }

  if (insufficient) {
    note(ctx.io, "No sufficiently relevant results found.");
  }

  for (const group of set.groups) {
    if (set.profileSeparation) {
      note(ctx.io, `# Profile ${group.embeddingProfileId} (${group.repoIds.join(", ")})`);
    }
    // Vorbehalte unbedingt drucken. Sie standen bisher NUR unter
    // `profileSeparation`, und das ist im ausgelieferten CLI nie wahr:
    // `wireSearchEngine` baut genau ein Profilziel. Der Vorbehalt traegt die
    // drei gemessenen Werte samt Schwellen — er war damit im Textmodus
    // unsichtbar.
    for (const caveat of group.caveats) note(ctx.io, `# Qualification: ${caveat}`);
    for (const hit of group.hits) {
      if (explain) {
        // WP-230: `formatHitAsText` endet ohne Zeilenumbruch. Mit `out` klebte
        // der naechste Treffer — und am Ende der Ledger-Hinweis — an der
        // letzten Zeile der Score-Zerlegung.
        line(ctx.io, formatHitAsText(hit));
      } else {
        line(ctx.io, compactHitLine(hit));
      }
    }
  }
  reportLedger(ctx, set.skipped.length, set.warnings.length);
}

/** Eine Zeile je Treffer — Rang, Ort, Symbol, Score. */
function compactHitLine(hit: SearchHitV1): string {
  const where = `${hit.filePath}:${String(hit.range.startLine)}-${String(hit.range.endLine)}`;
  const symbol = hit.symbolName === undefined ? "" : `  ${hit.symbolName}`;
  const incomplete =
    hit.incompletePayloadFields === undefined || hit.incompletePayloadFields.length === 0
      ? ""
      : `  [Fallback values: ${[...hit.incompletePayloadFields].sort(compareCodepoints).join(",")}]`;
  const lines = [
    `${String(hit.rank).padStart(3)}  ${hit.score.final.toFixed(4)}  ${where}${symbol}${incomplete}`,
  ];
  if (hit.graphContext !== undefined) {
    lines.push(...formatSearchGraphRelationsAsText("context", hit.graphContext));
  }
  if (hit.linkedSymbols !== undefined) {
    lines.push(...formatSearchGraphRelationsAsText("linked", hit.linkedSymbols));
  }
  return lines.join("\n");
}

export function renderGrep(ctx: CommandContext, set: GrepResultSetV1, format: OutputFormat): void {
  if (format !== "text") {
    // WP-230, dieselbe Ursache wie oben.
    line(ctx.io, formatGrepResultSet(set, format));
    reportGrepTail(ctx, set);
    return;
  }

  for (const match of set.matches) {
    for (const before of match.before) {
      line(ctx.io, `${match.filePath}-${String(before.line)}-${before.text}`);
    }
    line(
      ctx.io,
      `${match.filePath}:${String(match.line)}:${String(match.column)}:${match.lineText}`,
    );
    for (const after of match.after) {
      line(ctx.io, `${match.filePath}-${String(after.line)}-${after.text}`);
    }
  }
  reportGrepTail(ctx, set);
}

function reportGrepTail(ctx: CommandContext, set: GrepResultSetV1): void {
  note(
    ctx.io,
    `${String(set.totalMatches)} results, ${String(set.scannedChunks)} chunks searched.`,
  );
  if (set.truncated) {
    note(ctx.io, `Truncated; reason: ${set.truncationReason ?? "unbenannt"}.`);
  }
  reportLedger(ctx, set.skipped.length, set.warnings.length);
}

/**
 * Der Ledger-Hinweis. Er steht auf stderr, weil er Diagnose ist — aber er
 * steht IMMER, wenn es etwas zu melden gibt. Ein Ledger, den niemand sieht,
 * ist kein Ledger.
 */
function reportLedger(ctx: CommandContext, skipped: number, warnings: number): void {
  if (skipped === 0 && warnings === 0) return;
  note(
    ctx.io,
    `Note: ${String(skipped)} skipped candidates, ${String(warnings)} warning(s). ` +
      "Both are fully available in --format=json.",
  );
}

export function toRuntimeError(
  outcome: { readonly timedOut: boolean; readonly error: unknown },
  qdrantUrl: string,
  timeoutMs: number,
  request: Pick<UntangleSearchRequestV1, "mode" | "includeContext" | "includeLinked"> | "grep",
  useOffline: boolean,
): Error {
  const backendLabel = qdrantUrl.startsWith("file:") ? "LanceDB" : "Qdrant";
  if (outcome.timedOut) {
    const mode = request === "grep" ? "grep" : (request.mode ?? "hybrid");
    const usesEmbedding = mode === "semantic" || mode === "hybrid";
    const stages = [`Search retrieval from ${backendLabel} at ${qdrantUrl}`];
    if (usesEmbedding)
      stages.push(useOffline ? "local query embedding" : "Query embedding through Ollama");
    const graphFlags: string[] = [];
    if (request !== "grep" && request.includeContext) graphFlags.push("--context");
    if (request !== "grep" && request.includeLinked) graphFlags.push("--linked");
    if (graphFlags.length > 0)
      stages.push(`Graph enrichment (${graphFlags.join(" ")}) from ${backendLabel}`);
    return new EnvironmentError(
      `The query was cancelled after ${String(timeoutMs)}ms; no result is available. ` +
        `Mode "${mode}" covers ${stages.join("; ")}.`,
      `Run \`untangle doctor\` to check ${backendLabel}${usesEmbedding && !useOffline ? " and Ollama" : ""} with separate deadlines.` +
        (graphFlags.length > 0
          ? " Compare the runtime with the same query without graph enrichment."
          : ""),
      { cause: outcome.error },
    );
  }
  const error = outcome.error;
  const message = errorMessage(error);
  if (
    (isUntangleError(error) &&
      (error.code === "QDRANT_UNAVAILABLE" ||
        error.code === "LANCEDB_UNAVAILABLE" ||
        error.code === "LANCEDB_SCHEMA_INCOMPATIBLE")) ||
    /QDRANT_UNAVAILABLE|LANCEDB_UNAVAILABLE|fetch failed|ECONNREFUSED|ENOTFOUND|timed out/iu.test(
      message,
    )
  ) {
    return new EnvironmentError(
      `The store at ${qdrantUrl} did not answer the query: ${message}`,
      `Run \`untangle doctor\` to check ${backendLabel} and Ollama independently.`,
      { cause: error },
    );
  }
  if (/EMBEDDING|OLLAMA|model/iu.test(message)) {
    return new EnvironmentError(
      `Could not create the query embedding: ${message}`,
      "Run `untangle doctor` to check whether Ollama is running and has the model.",
      { cause: error },
    );
  }
  return new OperationalError(`Search failed: ${message}`, undefined, {
    cause: error,
  });
}
