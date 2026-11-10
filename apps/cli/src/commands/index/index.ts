/**
 * `untangle index` — der Befehl, an dem die ganze Suchhaelfte des Produkts
 * haengt.
 *
 * Er verdrahtet die Adapter und uebergibt an `@untangle-code/core`. Er
 * entscheidet selbst nur drei Dinge, und jedes davon steht in der Ausgabe:
 * welches Repository (siehe `target.ts`), welcher Einbetter, und ob wirklich
 * geschrieben wird (`--dry-run`).
 *
 * DIE VIER ZUSAGEN DIESES BEFEHLS:
 *
 * 1. FORTSCHRITT IST SICHTBAR. Jede Stufe meldet sich auf stderr, waehrend der
 *    Bericht nach stdout geht.
 * 2. `--dry-run` SCHREIBT NICHTS. Er braucht weder Einbetter noch Sammlung und
 *    sagt trotzdem, was passieren wuerde.
 * 3. STRG-C HINTERLAESST KEIN SCHLOSS. Das Abbruchsignal geht bis in die
 *    Ports; der Laeufer speichert einen Checkpoint an einer sicheren
 *    Stapelgrenze und gibt das Schloss in seinem `finally` frei. Exit-Code 130.
 * 4. EIN AUSGEFALLENER EINBETTER IST EIN FEHLSCHLAG MIT EXIT-CODE 4 — nie
 *    „fertig" mit einem leeren Index. Genau dieser Fehler wurde in Welle 4 in
 *    `query` gefunden, und hier ist die Stelle, an der er entstanden waere.
 * 5. JEDER EINBETTUNGSAUFRUF HAT EINE FRIST (WP-227). Ein Dienst, der nicht
 *    antwortet, laesst den Befehl nicht mehr unbegrenzt und stumm laufen: die
 *    Frist steht in `--timeout`, ihr Ablauf ist ein Fehlschlag mit Exit-Code 4
 *    und genanntem Grund, und solange gewartet wird, sagt der Befehl alle paar
 *    Sekunden, WORAUF gewartet wird.
 */
import path from "node:path";

import {
  OfflineEmbeddingProvider,
  planIndex,
  runIndex,
  type IndexPortsV1,
  type IndexTargetV1,
  type IndexTuningV1,
} from "@untangle-code/core";
import {
  buildEmbeddingProfileId,
  canonicalJson,
  embeddingProfileShortId,
  LEXICAL_TOKENIZER_VERSION,
  sha256Hex,
  UntangleError,
  type EmbeddingProfile,
  type EmbeddingProvider,
  type JobEvent,
} from "@untangle-code/domain";
import { createParserRegistry } from "@untangle-code/parser-registry";
import { NodeFileSystem } from "@untangle-code/scanner/node-fs";
import { openLocalStorage } from "@untangle-code/storage-local";
import {
  codeCollectionName,
  provisionCodeCollection,
  textToBm25SparseVector,
} from "@untangle-code/storage-qdrant";

import {
  enumFlag,
  integerFlag,
  stringFlag,
  type FlagSpecs,
  type ParsedArgs,
} from "../../cli/args.js";
import type { Command, CommandContext } from "../../cli/command.js";
import {
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  withEmbeddingDeadline,
} from "../../cli/embedder-deadline.js";
import { EXIT, EnvironmentError, OperationalError } from "../../cli/exit.js";
import { indexConfigFingerprint } from "../../cli/index-freshness.js";
import {
  indexStateAfterRun,
  indexStateLockKey,
  indexStateRecordPath,
  replaceRunningIndexState,
  resolveIndexState,
  stateRootOf,
  writeIndexState,
  type EmbedderChoice,
  type IndexStateV1,
} from "../../cli/index-state.js";
import { line, note } from "../../cli/io.js";
import { withRenewingLease, type RenewingLeaseGuard } from "../../cli/renewing-lease.js";
import { systemClock, systemRandom } from "../../cli/system.js";
import {
  errorMessage,
  loadWorkspace,
  wireEmbedder,
  wireStorage,
  storageIndexScope,
  type WorkspaceView,
} from "../../cli/workspace.js";

import {
  createIndexProgress,
  renderEvent,
  renderPlan,
  renderReport,
  renderRunHeader,
} from "./render.js";
import { resolveTarget, type ResolvedTarget } from "./target.js";

/** Fehlercodes, die „die Umgebung ist nicht bereit" bedeuten (Exit-Code 4). */
const ENVIRONMENT_CODES = new Set([
  "EMBEDDING_UNAVAILABLE",
  "EMBEDDING_DIMENSION_MISMATCH",
  "QDRANT_UNAVAILABLE",
  "QDRANT_SCHEMA_INCOMPATIBLE",
  "LANCEDB_UNAVAILABLE",
  "LANCEDB_SCHEMA_INCOMPATIBLE",
]);

const INDEX_STATE_LOCK_WAIT_MS = 5_000;
const INDEX_STATE_LOCK_LEASE_MS = 30_000;

const FLAGS: FlagSpecs = {
  root: {
    kind: "string",
    placeholder: "PATH",
    describe: "Project directory; configuration is discovered from here.",
    defaultLabel: "current directory",
  },
  repo: {
    kind: "string",
    placeholder: "ID",
    describe: "Configured repository to index.",
    defaultLabel: "the only configured repository",
  },
  ref: {
    kind: "string",
    placeholder: "NAME",
    describe: "Ref name for the run.",
    defaultLabel: "branch from .git/HEAD, otherwise working-tree",
  },
  "dry-run": {
    kind: "boolean",
    describe: "Preview the plan only. Writes nothing and requires no embedder.",
  },
  embedder: {
    kind: "string",
    placeholder: "auto|offline",
    describe: "auto uses the configured service; offline computes local vectors in this process.",
    defaultLabel: "auto",
  },
  format: {
    kind: "string",
    placeholder: "text|json",
    describe: "Report output format.",
    defaultLabel: "text",
  },
  incremental: {
    kind: "boolean",
    describe: "Skip unchanged files. --no-incremental recomputes everything.",
    defaultLabel: "on",
  },
  resume: {
    kind: "boolean",
    describe: "Resume an existing checkpoint. --no-resume starts again.",
    defaultLabel: "on",
  },
  "batch-size": {
    kind: "number",
    placeholder: "N",
    describe: "Files per embedding and checkpoint batch.",
    defaultLabel: "8",
  },
  "show-files": {
    kind: "number",
    placeholder: "N",
    describe: "Maximum planned files listed individually by --dry-run.",
    defaultLabel: "20",
  },
  verbose: {
    kind: "boolean",
    describe: "Report each analyzed file and checkpoint.",
  },
  timeout: {
    kind: "number",
    placeholder: "MS",
    describe: "Deadline per embedding call. Expiry fails the run with code 4.",
    defaultLabel: String(DEFAULT_EMBEDDING_TIMEOUT_MS),
  },
};

interface IndexRunOptions {
  readonly workspace?: WorkspaceView;
  readonly embeddingFetch?: typeof fetch;
}

export const indexCommand = {
  spec: {
    name: "index",
    implementedBy: "commands/index/index.js",
    summary: "Index a project",
    usage: "untangle index [--root=<PATH>] [--dry-run] [--embedder=offline]",
    details: [
      "Discovers files, parses and chunks them losslessly, measures complexity, embeds and stores points, then builds file and symbol graphs. Afterwards, `untangle query`, `graph` and `flow` are available.",
      "Incremental indexing: a second run over unchanged files recomputes nothing. Content hashes, rather than modification times, determine changes. The embedding cache is content-addressed too, so moved or copied code does not need embedding again even in a new file.",
      "Without an embedding service, `--embedder=offline` computes vectors locally in this process. It is not a language model and its vectors carry no semantics, but lexical search remains complete. The run uses a separate collection so offline vectors never mix with real embeddings.",
      "Deadline and progress: each embedding-service call has a deadline (--timeout, default 60000 ms). An unresponsive service ends the run within that deadline with exit code 4 and a reason. While waiting, stderr reports the active operation and elapsed time.",
      "Every file that could not be indexed appears in the report with a reason and whether a retry may succeed. An embedder failure produces exit code 4, never a completed result.",
    ],
    flags: FLAGS,
    examples: [
      "untangle index",
      "untangle index --dry-run",
      "untangle index --embedder=offline --format=json",
    ],
    exitCodes: [
      [EXIT.ok, "The run completed fully."],
      [EXIT.operational, "Operational error: configuration, lock or storage failure."],
      [EXIT.usage, "Invalid arguments."],
      [
        EXIT.environment,
        "Environment not ready: embedder or vector store, including deadline expiry.",
      ],
      [EXIT.cancelled, "Cancelled; a checkpoint was saved at a safe boundary."],
    ],
  },

  async run(ctx: CommandContext, args: ParsedArgs, options: IndexRunOptions = {}): Promise<number> {
    const format = enumFlag(args, "format", ["text", "json"] as const, "text");
    const embedderChoice = enumFlag(args, "embedder", ["auto", "offline"] as const, "auto");
    const dryRun = args.flags["dry-run"] === true;
    const verbose = args.flags["verbose"] === true;
    const incremental = args.flags["incremental"] !== false;
    let resume = args.flags["resume"] !== false;
    const batchSize = integerFlag(args, "batch-size", 8);
    const showFiles = integerFlag(args, "show-files", 20);
    const timeoutMs = integerFlag(args, "timeout", DEFAULT_EMBEDDING_TIMEOUT_MS);
    const rootFlag = stringFlag(args, "root");

    const view =
      options.workspace ??
      loadWorkspace({
        cwd: rootFlag === undefined ? ctx.cwd : path.resolve(ctx.cwd, rootFlag),
        env: ctx.env,
        strict: true,
      });

    const target = resolveTarget({
      config: view.config,
      cwd: ctx.cwd,
      rootFlag,
      repoFlag: stringFlag(args, "repo"),
      refFlag: stringFlag(args, "ref"),
      configBaseDir: view.load.sources.configBaseDir,
    });

    if (target.synthesized) {
      note(
        ctx.io,
        `Note: no repository is configured. Indexing "${target.rootPath}" ` +
          "as an independent repository. `untangle init` writes a configuration.",
      );
    }

    const scanFs = new NodeFileSystem();
    const indexTarget: IndexTargetV1 = {
      workspaceId: view.workspaceId,
      repoId: target.repoId,
      refId: target.refId,
      refName: target.refName,
      repoLabel: target.repoLabel,
      rootPath: target.rootPath,
    };

    /* --------------------------- Trockenlauf --------------------------- */

    if (dryRun) {
      const storage = wireStorage(view, ctx.env);
      const plan = await planIndex({
        ports: { fs: scanFs, metadataStore: storage.storage.metadataStore },
        target: indexTarget,
        tuning: tuningOf(view, target),
        incremental,
        signal: ctx.signal,
      });
      if (format === "json") {
        line(ctx.io, JSON.stringify({ ...plan, target: indexTarget }, null, 2));
      } else {
        line(ctx.io, `Dry run for ${target.rootPath} (${target.refId}).`);
        line(ctx.io, "Nothing was written.");
        line(ctx.io, "");
        renderPlan(ctx.io, plan, showFiles);
      }
      return EXIT.ok;
    }

    /* ----------------------------- Echter Lauf ------------------------- */

    let embedder: EmbeddingProvider;
    let profile: EmbeddingProfile;
    if (embedderChoice === "offline") {
      const offline = new OfflineEmbeddingProvider(systemClock);
      embedder = offline;
      profile = offline.profile;
      note(
        ctx.io,
        "Embedder: OFFLINE (local, in-process). Vectors carry no semantics; " +
          "lexical search remains complete, while dense search is severely limited.",
      );
    } else {
      embedder = wireEmbedder(view, options.embeddingFetch);
      profile = view.profile;
    }
    const profileId = buildEmbeddingProfileId(profile);

    const storage = wireStorage(view, ctx.env);
    const collection = codeCollectionName(
      storage.collectionPrefix,
      embeddingProfileShortId(profileId),
    );

    // WP-227: Die Frist liegt um den PORT, nicht um eine einzelne Stufe.
    // Dadurch gilt sie fuer die Bereitschaftspruefung genauso wie fuer jeden
    // Stapel — und zwar unabhaengig davon, welche Stufe den Einbetter das
    // naechste Mal anfasst. Der offline-Einbetter wird derselben Huelle
    // unterworfen: eine Ausnahme, die "der ist ja schnell" heisst, ist genau
    // die Annahme, die spaeter nicht mehr stimmt.
    const guardedEmbedder = withEmbeddingDeadline(embedder, {
      timeoutMs,
      outerSignal: ctx.signal,
      onProgress: (text) => {
        note(ctx.io, text);
      },
    });

    renderRunHeader(ctx.io, {
      rootPath: target.rootPath,
      repoId: target.repoId,
      refName: target.refName,
      collection,
      embedder: embedderChoice === "offline" ? "offline (local)" : `${profile.model} (service)`,
      timeoutMs,
    });

    const stateRoot = stateRootOf(target.rootPath);
    const previous = await resolveIndexState([target.rootPath], view.workspaceId, {
      ...storageIndexScope(storage),
      repoIds: [target.repoId],
      refs: [target.refId],
    });
    const previousProfileStates =
      previous.kind === "resolved" || previous.kind === "ambiguous"
        ? previous.all.filter(({ state }) => state.embeddingProfileId === profileId)
        : [];
    if (
      previousProfileStates.length === 0 ||
      previousProfileStates.some(
        ({ state }) =>
          state.lexicalTokenizerVersion !== LEXICAL_TOKENIZER_VERSION ||
          state.indexConfigFingerprint !== indexConfigFingerprint(view, target),
      )
    ) {
      resume = false;
      note(
        ctx.io,
        "Index format or configuration changed or unconfirmed: starting a new indexing run without resuming old checkpoints.",
      );
    }
    let local;
    try {
      local = await openLocalStorage(stateRoot, {
        clock: systemClock,
        random: systemRandom,
      });
    } catch (error) {
      throw new OperationalError(
        `Could not create state directory "${stateRoot}": ${errorMessage(error)}`,
        "Check write permissions in the project directory.",
        { cause: error },
      );
    }

    const ports: IndexPortsV1 = {
      fs: scanFs,
      parsers: createParserRegistry(),
      embedder: guardedEmbedder,
      vectorStore: storage.vectorStore,
      metadataStore: storage.storage.metadataStore,
      graphStore: storage.storage.graphStore,
      clock: systemClock,
      random: systemRandom,
      embeddingCache: local.embeddingCache,
      analysisCache: local.analysisCache,
    };

    const events: JobEvent[] = [];
    const progress = createIndexProgress();
    const indexStateIdentity = {
      schemaVersion: 1,
      workspaceId: view.workspaceId,
      repoId: target.repoId,
      refId: target.refId,
      refName: target.refName,
      embedder: (embedderChoice === "offline" ? "offline" : "service") satisfies EmbedderChoice,
      embeddingProfileId: profileId,
      collection,
      ...(storage.backend === "lancedb"
        ? { storageBackend: "lancedb" as const, storeUrl: storage.storeUrl }
        : { qdrantUrl: storage.storeUrl }),
      indexConfigFingerprint: indexConfigFingerprint(view, target),
      lexicalTokenizerVersion: LEXICAL_TOKENIZER_VERSION,
    } satisfies Omit<IndexStateV1, "generationId" | "outcome">;
    type FailedStateWrite = Extract<Awaited<ReturnType<typeof writeIndexState>>, { ok: false }>;
    const terminalStateWrite: { failure: FailedStateWrite | null } = { failure: null };
    const withIndexStateLock = async <Result>(
      operation: (guard: RenewingLeaseGuard) => Promise<Result>,
    ): Promise<Result> =>
      withRenewingLease({
        lockProvider: local.locks,
        key: indexStateLockKey(indexStateIdentity),
        waitMs: INDEX_STATE_LOCK_WAIT_MS,
        leaseMs: INDEX_STATE_LOCK_LEASE_MS,
        operation,
      });

    const report = await runIndex({
      ports,
      target: indexTarget,
      tuning: tuningOf(view, target),
      profile,
      embeddingProfileId: profileId,
      collection,
      provisionCollection: async (options) => {
        await provisionCodeCollection(
          storage.vectorStore,
          { prefix: storage.collectionPrefix, profile },
          options,
        );
      },
      sparseVectorizer: textToBm25SparseVector,
      storeUrl: storage.storeUrl,
      configHash: sha256Hex(
        canonicalJson({
          configHash: view.load.configHash,
          lexicalTokenizerVersion: LEXICAL_TOKENIZER_VERSION,
          indexConfigFingerprint: indexConfigFingerprint(view, target),
        }),
      ),
      checkpointStore: local.checkpoints,
      lockProvider: local.locks,
      incremental,
      resume,
      embedBatchSize: batchSize,
      signal: ctx.signal,
      // Crash boundary: once a generation exists, publish its incomplete
      // state BEFORE the runner may analyze, checkpoint, build graphs, or
      // upsert. A rejected publication fails the job before those mutations.
      onGenerationStarted: async (generationId) => {
        const runningStateWrite = await withIndexStateLock((guard) =>
          writeIndexState(
            stateRoot,
            {
              ...indexStateIdentity,
              generationId,
              outcome: "running",
            },
            {
              assertOwnership: () => guard.assertOwnership(),
            },
          ),
        );
        if (runningStateWrite.ok) return;
        const invalidationDetail = runningStateWrite.previousStateInvalidated
          ? "A previous index state was safely invalidated."
          : `The previous index state could not be invalidated either (${errorMessage(
              runningStateWrite.invalidationError,
            )}).`;
        throw new UntangleError(
          "INDEX_INCOMPLETE",
          `Could not write the running index state before the first mutation ` +
            `(${errorMessage(runningStateWrite.error)}). ${invalidationDetail}`,
          {
            retryable: false,
            operation: "index_state_publish",
            context: {
              path: runningStateWrite.path,
              previousStateInvalidated: runningStateWrite.previousStateInvalidated,
            },
            cause: runningStateWrite.error,
          },
        );
      },
      // The runner first verifies its renewable repo/ref lease. This shorter
      // repo/ref publication lock serializes the current-profile pointer,
      // while replaceRunningIndexState provides the per-profile generation CAS.
      onGenerationFinished: async (generationId, outcome, corpusRevisionFingerprint) => {
        const terminalIndexState = indexStateAfterRun({
          ...indexStateIdentity,
          generationId,
          ...(corpusRevisionFingerprint === undefined ? {} : { corpusRevisionFingerprint }),
          ...(outcome === "completed" ? { indexedAt: systemClock.nowIso() } : {}),
          outcome,
        });
        if (terminalIndexState === null) return;
        try {
          const result = await withIndexStateLock((guard) =>
            replaceRunningIndexState(stateRoot, terminalIndexState, {
              assertOwnership: () => guard.assertOwnership(),
            }),
          );
          if (!result.ok) terminalStateWrite.failure = result;
        } catch (error) {
          terminalStateWrite.failure = {
            ok: false,
            error,
            path: indexStateRecordPath(stateRoot, indexStateIdentity),
            previousStateInvalidated: false,
            invalidationError: new Error("index-state publication lock was unavailable"),
          };
        }
      },
      onEvent: (event) => {
        events.push(event);
        renderEvent(ctx.io, event, verbose, progress);
      },
    });

    // The runner has already replaced `running` with its terminal outcome
    // while still holding the repo/ref lock. A failure removed the exact old
    // hint where possible, so only diagnostics remain here.
    const stateWrite = terminalStateWrite.failure;
    if (stateWrite !== null) {
      if (stateWrite.previousStateInvalidated) {
        note(
          ctx.io,
          `Note: could not write the index state (${errorMessage(stateWrite.error)}). ` +
            "A previous state was invalidated; `untangle query` cannot automatically discover the " +
            "embedding profile used; " +
            `specify it explicitly with --embedder=${embedderChoice === "offline" ? "offline" : "service"}.`,
        );
      } else {
        note(
          ctx.io,
          `Warning: could not write the index state (${errorMessage(
            stateWrite.error,
          )}) and the old state at "${stateWrite.path}" could not be invalidated ` +
            `(${errorMessage(stateWrite.invalidationError)}). --embedder=auto may therefore route to stale ` +
            "state. After fixing write permissions, remove the file or explicitly select the profile " +
            `with --embedder=${embedderChoice === "offline" ? "offline" : "service"}.`,
        );
      }
    }

    if (format === "json") {
      line(ctx.io, JSON.stringify(report, null, 2));
    } else {
      line(ctx.io, "");
      renderReport(ctx.io, report);
    }

    if (report.outcome === "completed") return EXIT.ok;
    if (report.outcome === "cancelled") {
      note(ctx.io, "");
      note(
        ctx.io,
        "Cancelled. The next run resumes from the saved checkpoint; " + "the lock was released.",
      );
      return EXIT.cancelled;
    }

    const code = report.failure?.code ?? "INDEX_INCOMPLETE";
    const message = report.failure?.message ?? "The run ended without a reason.";
    if (ENVIRONMENT_CODES.has(code)) {
      throw new EnvironmentError(
        `Indexing failed because the environment was not ready (${code}): ${message}`,
        code.startsWith("EMBEDDING")
          ? "Run `untangle index --embedder=offline` for local in-process vectors. " +
              "`untangle doctor` explains service failures; if it only needs more time, use " +
              "`--timeout` to increase the deadline."
          : "Check the vector store with `untangle doctor`.",
      );
    }
    throw new OperationalError(
      `Indexing failed (${code}): ${message}`,
      "The report above describes completed work; `--format=json` lists every skipped item.",
    );
  },
} satisfies Command;

/**
 * Die Stellschrauben aus der wirksamen Konfiguration (spec.md §4.6) UND die
 * Ausschlussmuster des gewaehlten Repositories (spec.md §4.3). Beides gehoert
 * zusammen: eine Grenze, die konfiguriert, aber nicht durchgereicht wird, ist
 * keine Grenze.
 */
function tuningOf(view: ReturnType<typeof loadWorkspace>, target: ResolvedTarget): IndexTuningV1 {
  return {
    maxChunkTokens: view.config.index.maxChunkTokens,
    maxFileSizeBytes: view.config.index.maxFileSizeMb * 1024 * 1024,
    scanConcurrency: view.config.index.scanConcurrency,
    ...(target.include === undefined ? {} : { includePatterns: target.include }),
    ...(target.exclude === undefined ? {} : { excludePatterns: target.exclude }),
  };
}

/** Nur damit ein unerwarteter Wurf des Kerns nicht als Aufruffehler durchgeht. */
export function isUntangle(error: unknown): error is UntangleError {
  return error instanceof UntangleError;
}
