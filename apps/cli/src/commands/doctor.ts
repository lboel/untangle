/**
 * `untangle doctor` — die Antwort auf „warum geht das nicht?".
 *
 * REGEL DIESES BEFEHLS: Jeder fehlgeschlagene Test nennt GENAU EINEN
 * naechsten Schritt. Nicht drei Moeglichkeiten, nicht „pruefe deine
 * Konfiguration" — einen Schritt, den man tippen kann. Ein Diagnosewerkzeug,
 * das eine Auswahl praesentiert, hat die Diagnose nicht zu Ende gefuehrt.
 *
 * `doctor` ist AUSSCHLIESSLICH LESEND. Er legt keine Collection an, laedt
 * kein Modell nach und schreibt keine Datei. Das ist wichtig, weil auf einem
 * Entwicklungsrechner fremde Dienste auf denselben Vorgabeports liegen
 * koennen (spec.md §3.2): ein Diagnoselauf darf nichts anfassen, was ihm
 * nicht gehoert.
 */

import path from "node:path";

import { compareCodepoints, type EmbeddingReadinessV1 } from "@untangle-code/domain";
import { DEFAULT_MANAGED_URL, DEFAULT_NATIVE_PROBE_URL } from "@untangle-code/embeddings-ollama";

/** Nur fuer den Hinweistext im Fehlschlag — nie fuer eine Entscheidung. */
const DEFAULT_PROBE_HINT = DEFAULT_NATIVE_PROBE_URL;

/**
 * Warum `doctor` eine EIGENE Frist braucht und die der Adapter nicht genuegt.
 *
 * Gemessen an einem ausgelasteten Ollama: die Bereitschaftsfolge des
 * Embedding-Adapters wiederholt einen Zeitueberlauf mit Backoff und meldet
 * den Fehlschlag erst nach ueber drei Minuten. Fuer den Indexlauf ist das
 * richtig — dort ist Durchhalten mehr wert als Tempo. Fuer ein
 * Diagnosewerkzeug ist es falsch: wer fragt „warum geht das nicht?", wartet
 * nicht drei Minuten auf die Antwort „Ollama antwortet nicht".
 *
 * Also bricht `doctor` jeden Einzeltest nach dieser Frist ab — und sagt
 * ausdruecklich, DASS er abgebrochen hat. Ein abgebrochener Test ist keine
 * bestandene Pruefung; er wird als Fehlschlag gewertet.
 */
export const DEFAULT_CHECK_TIMEOUT_MS = 15_000;

/**
 * WARUM DIESE FRIST ALLEIN NICHT REICHT — und was `doctor` deshalb tut.
 *
 * Gemessen auf dem Abnahmerechner: ein Ollama, das ein Einbettungsmodell zum
 * ERSTEN Mal laedt, braucht 31-37 s bis zur ersten Antwort; danach liegt
 * dieselbe Anfrage unter einer Sekunde. Mit einer starren Frist von 15 s
 * meldete `doctor` fuer einen vollkommen gesunden Dienst „Keine Antwort" —
 * eine falsche Aussage ueber die Umgebung, also E4 an der Oberflaeche.
 *
 * Die Frist wird deshalb NICHT einfach hochgesetzt (dann wartete auch der,
 * dessen Ollama gar nicht laeuft, eine Minute auf eine Auskunft, die nach
 * drei Sekunden feststeht). Stattdessen prueft `doctor` nach dem Fristablauf
 * nach, ob der Dienst ueberhaupt eine HTTP-Verbindung annimmt:
 *
 *   nimmt er keine an  -> „antwortet nicht", sofortiger Fehlschlag;
 *   antwortet er       -> er lebt, also wird bis zu dieser Zusatzfrist
 *                         weitergewartet, und der Unterschied wird BENANNT.
 *
 * Das Weiterwarten kostet nichts Zusaetzliches: die Bereitschaftsfolge des
 * Adapters laeuft nach einem abgelaufenen Aufruferzeitlimit im Hintergrund
 * weiter (`OllamaEmbeddingProvider.ensureReadyOnce` startet sie ohne das
 * Signal des Aufrufers), der zweite Aufruf haengt sich an denselben Lauf.
 */
export const DEFAULT_COLD_START_TIMEOUT_MS = 90_000;

/**
 * Frist der Lebenszeichen-Probe. Sie beantwortet eine einzige Frage — nimmt
 * der Dienst eine Verbindung an? —, und diese Antwort steht sofort fest oder
 * gar nicht.
 */
const LIVENESS_TIMEOUT_MS = 3_000;

/**
 * Ab dieser Dauer wird der Kaltstart als Erklaerung ANGEBOTEN. Darunter steht
 * nur die gemessene Zahl — eine Frist, die jemand mit `--timeout=5` selbst zu
 * eng gesetzt hat, ist kein Modellladen.
 */
const COLD_START_HINT_MS = 5_000;

import {
  boolFlag,
  enumFlag,
  integerFlag,
  stringFlag,
  type FlagSpecs,
  type ParsedArgs,
} from "../cli/args.js";
import type { Command, CommandContext } from "../cli/command.js";
import { withDeadline } from "../cli/deadline.js";
import { CliError, EXIT } from "../cli/exit.js";
import { inspectIndexFreshness } from "../cli/index-freshness.js";
import { resolveIndexState } from "../cli/index-state.js";
import { line, note } from "../cli/io.js";
import {
  describeConfigIssues,
  errorMessage,
  loadWorkspace,
  wireEmbedder,
  wireStorage,
  type WorkspaceView,
} from "../cli/workspace.js";

import { checkLanguages } from "./doctor.languages.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** Bei "fail" und "warn" Pflicht: GENAU EIN naechster Schritt. */
  readonly nextStep?: string;
  readonly facts?: Readonly<Record<string, string | number | boolean>>;
}

const FLAGS: FlagSpecs = {
  root: {
    kind: "string",
    placeholder: "PATH",
    describe: "Project directory; configuration is discovered from here.",
    defaultLabel: "current directory",
  },
  format: {
    kind: "string",
    placeholder: "text|json",
    describe: "Output format.",
    defaultLabel: "text",
  },
  "skip-embeddings": {
    kind: "boolean",
    describe: "Skip the Ollama check (it costs one request).",
  },
  timeout: {
    kind: "number",
    placeholder: "MS",
    describe:
      "Deadline per check. Expiry fails the check; for Ollama, only when the service also gives no sign of life.",
    defaultLabel: String(DEFAULT_CHECK_TIMEOUT_MS),
  },
  "cold-start-timeout": {
    kind: "number",
    placeholder: "MS",
    describe:
      "Additional Ollama deadline when the service responds but is still loading. 0 disables the additional wait.",
    defaultLabel: String(DEFAULT_COLD_START_TIMEOUT_MS),
  },
};

export const doctorCommand: Command = {
  spec: {
    name: "doctor",
    implementedBy: "commands/doctor.js",
    summary: "Check configuration, Ollama, Qdrant, index state and language availability",
    usage: "untangle doctor [--root=<PATH>] [--format=text|json]",
    details: [
      "Checks, in order: configuration, Ollama (reachability, model, dimensions), Qdrant (reachability), index state (this embedding profile's collection), analyzer extensions and languages.",
      'Language availability is measured, not assumed: each adapter parses a word to load its actual grammar. This verifies which registered languages work on this machine. ast-grep language prebuilds support five platforms; a failed fallback build can still exit 0 during installation. Languages without a loadable grammar are reported as tier "text" with a reason, never as a claimed "deep" tier.',
      "The Ollama check exercises the endpoint indexing actually uses, ending with a probe embedding on /api/embed. An available /api/tags endpoint alone does not count as a pass.",
      "If Ollama misses the deadline, a follow-up checks whether it accepts HTTP connections. A responding service may still be loading its model (measured cold starts took 31–37 s); the check then waits up to --cold-start-timeout. A service accepting no connection fails immediately. This distinguishes an unresponsive service from a model still loading.",
      "Every failed check gives one next step.",
      "The run is read-only: it creates no collection, downloads no model and writes no file. Language checks load grammars from the existing node_modules tree without fetching or building anything.",
    ],
    flags: FLAGS,
    examples: ["untangle doctor", "untangle doctor --format=json"],
    exitCodes: [
      [EXIT.ok, "All checks passed (warnings allowed)."],
      [EXIT.operational, "The diagnostic run itself failed."],
      [EXIT.environment, "At least one check failed."],
    ],
  },

  async run(ctx: CommandContext, args: ParsedArgs): Promise<number> {
    ctx.signal.throwIfAborted();
    const format = enumFlag(args, "format", ["text", "json"] as const, "text");
    const cwd = stringFlag(args, "root") ?? ctx.cwd;
    const timeoutMs = integerFlag(args, "timeout", DEFAULT_CHECK_TIMEOUT_MS);
    const coldStartTimeoutMs = integerFlag(
      args,
      "cold-start-timeout",
      DEFAULT_COLD_START_TIMEOUT_MS,
    );
    const checks: CheckResult[] = [];

    // --- 1. Konfiguration ---------------------------------------------------
    let view: WorkspaceView | undefined;
    try {
      view = loadWorkspace({ cwd, env: ctx.env, strict: false });
      const errors = describeConfigIssues(view.load.errors);
      const warnings = describeConfigIssues(view.load.warnings);
      // WP-222: WELCHE Datei geladen wurde, statt der Datei, die `doctor`
      // erwartet hat. `untangle init` schreibt `untangle.toml`; solange
      // `doctor` nur nach `.untangle.json` sah, meldete es „keine
      // Konfiguration" ueber eine Konfiguration, die es gerade gab, und riet
      // zu `untangle init` — was soeben gelaufen war. Der Nutzer lief im
      // Kreis. Jetzt nennt der Befund die Datei beim Namen.
      const configFile = primaryConfigFile(view);
      if (errors.length > 0) {
        checks.push({
          id: "config",
          title: "Configuration",
          status: "fail",
          detail: `${String(errors.length)} errors: ${errors.join("; ")}`,
          nextStep:
            configFile === undefined
              ? "Run `untangle init` to write a valid untangle.toml."
              : `Fix the first reported error in ${configFile} and run \`untangle doctor\` again.`,
          facts: configFacts(view, configFile),
        });
      } else if (configFile === undefined) {
        // KEIN Fehler und trotzdem kein Rat zum Kreislauf: es gibt schlicht
        // keine Projektkonfiguration, also gelten die Produktvorgaben. Das
        // wird gesagt, nicht als „alles in Ordnung" verkauft.
        checks.push({
          id: "config",
          title: "Configuration",
          status: "warn",
          detail:
            "No project configuration found (neither untangle.toml nor .untangle.json). " +
            "Only product defaults apply.",
          nextStep: "Run `untangle init` to write a commented untangle.toml.",
          facts: configFacts(view, configFile),
        });
      } else {
        checks.push({
          id: "config",
          title: "Configuration",
          status: warnings.length > 0 ? "warn" : "ok",
          detail:
            warnings.length > 0
              ? `${configFile} loaded with ${String(warnings.length)} Warnung(en): ${warnings.join("; ")}`
              : `${configFile} loaded and valid.`,
          ...(warnings.length > 0
            ? {
                nextStep: `Fix the first reported warning in ${configFile}; otherwise it will be ignored.`,
              }
            : {}),
          facts: configFacts(view, configFile),
        });
      }
    } catch (error) {
      ctx.signal.throwIfAborted();
      checks.push({
        id: "config",
        title: "Configuration",
        status: "fail",
        detail: `Cannot load: ${errorMessage(error)}`,
        nextStep: "Run `untangle init` to write a valid untangle.toml.",
      });
    }

    if (view === undefined) {
      return emit(ctx, checks, format);
    }

    // --- 2. Repositories ----------------------------------------------------
    checks.push(
      view.repoIds.length === 0
        ? {
            id: "repositories",
            title: "Repositories",
            status: "fail",
            detail: "The configuration contains no repository, so there is nothing to index.",
            nextStep: "Run `untangle init --force` in the project directory.",
          }
        : {
            id: "repositories",
            title: "Repositories",
            status: "ok",
            detail: `${String(view.repoIds.length)}: ${[...view.repoIds].sort(compareCodepoints).join(", ")}`,
          },
    );

    // --- 3. Ollama ----------------------------------------------------------
    if (boolFlag(args, "skip-embeddings")) {
      checks.push({
        id: "ollama",
        title: "Ollama",
        status: "warn",
        detail: "Skipped (--skip-embeddings). Ollama availability was not checked.",
        nextStep: "Run `untangle doctor` without --skip-embeddings to perform the check.",
      });
    } else {
      checks.push(await checkOllama(view, ctx, timeoutMs, coldStartTimeoutMs));
      ctx.signal.throwIfAborted();
    }

    // --- 4. Qdrant und Indexstand ------------------------------------------
    const storageChecks = await checkStorage(view, ctx, timeoutMs);
    ctx.signal.throwIfAborted();
    for (const check of storageChecks) checks.push(check);

    // --- 5. Extensions ------------------------------------------------------
    checks.push(await checkExtensions(ctx));
    ctx.signal.throwIfAborted();

    // --- 6. Sprachen --------------------------------------------------------
    checks.push(await checkLanguages());
    ctx.signal.throwIfAborted();

    return emit(ctx, checks, format);
  },
};

/* --------------------------------------------------------------------- */

/**
 * Die Konfigurationsdatei, die fuer dieses Projekt wirklich gilt — oder
 * `undefined`, wenn es keine gibt.
 *
 * `.untangle.json` gewinnt vor `untangle.toml`, weil die Ladeordnung
 * (spec.md §4.1, Ebene 4 vor 4b) genau das tut. Liegen beide da, meldet der
 * Lader das als Warnung; hier wird nur die genannt, die obenauf liegt, damit
 * ein naechster Schritt auf die Datei zeigt, an der eine Aenderung auch
 * wirkt.
 */
function primaryConfigFile(view: WorkspaceView): string | undefined {
  return view.load.sources.projectConfigPath ?? view.load.sources.tomlConfigPath;
}

function configFacts(
  view: WorkspaceView,
  configFile: string | undefined,
): Readonly<Record<string, string | number | boolean>> {
  return {
    projectConfig: configFile ?? "(no untangle.toml or .untangle.json found)",
    tomlConfig: view.load.sources.tomlConfigPath ?? "(none)",
    jsonConfig: view.load.sources.projectConfigPath ?? "(none)",
    localConfig: view.load.sources.localConfigPath ?? "(none)",
    userConfig: view.load.sources.userConfigPath ?? "(none)",
    workspaceId: view.workspaceId,
    embeddingProfileId: view.profileId,
    repositories: view.repoIds.length,
  };
}

/**
 * Ergebnis der Lebenszeichen-Probe. `alive` heisst AUSSCHLIESSLICH: der Dienst
 * hat eine HTTP-Verbindung angenommen und geantwortet. Es heisst NICHT, dass
 * das Modell geladen oder /api/embed brauchbar ist — genau diese Verwechslung
 * ist der Befund WP-228, und sie wird hier nicht wiederholt.
 */
interface LivenessProbeV1 {
  readonly url: string;
  readonly alive: boolean;
  /** Wortlaut fuer die Ausgabe: entweder der HTTP-Status oder der Grund des Fehlschlags. */
  readonly detail: string;
  readonly elapsedMs: number;
}

/**
 * Die Adressen, an denen der Adapter der Reihe nach sucht (spec.md §3.1,
 * §4.5). Nachgebaut, nicht geraten: `auto` fasst zuerst den nativen
 * Probe-Endpunkt an und faellt dann auf den verwalteten zurueck; ein
 * gesetztes `url` gilt in `auto` als verwalteter Ersatz.
 */
function livenessCandidates(view: WorkspaceView): readonly string[] {
  const embeddings = view.config.embeddings;
  const raw: readonly (string | undefined)[] =
    embeddings.mode === "external"
      ? [embeddings.url]
      : embeddings.mode === "managed"
        ? [embeddings.url ?? DEFAULT_MANAGED_URL]
        : [DEFAULT_NATIVE_PROBE_URL, embeddings.url ?? DEFAULT_MANAGED_URL];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const candidate of raw) {
    if (candidate === undefined || seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

/** `${base}/api/embed`, ohne doppelten Schraegstrich. */
function embedEndpointOf(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/api/embed`;
}

/**
 * EIN GET auf die Basis-URL, mit eigener kurzer Frist. Rein lesend wie der
 * ganze Befehl: es laedt kein Modell und legt nichts an. Jede HTTP-Antwort —
 * auch 404, auch 500 — beweist, dass der Dienst lebt; nur eine abgelehnte,
 * nicht aufloesbare oder stumme Verbindung beweist das Gegenteil.
 */
async function probeLiveness(view: WorkspaceView, ctx: CommandContext): Promise<LivenessProbeV1> {
  const candidates = livenessCandidates(view);
  let last: LivenessProbeV1 = {
    url: DEFAULT_PROBE_HINT,
    alive: false,
    detail: "the configuration provides no endpoint to probe",
    elapsedMs: 0,
  };
  for (const url of candidates) {
    const startedAt = performance.now();
    const outcome = await withDeadline<number>(
      async (signal) => {
        const response = await fetch(url, { method: "GET", signal });
        // Den Koerper NICHT lesen, aber schliessen: sonst haelt der Socket.
        await response.body?.cancel();
        return response.status;
      },
      LIVENESS_TIMEOUT_MS,
      ctx.signal,
    );
    const elapsedMs = Math.round(performance.now() - startedAt);
    ctx.signal.throwIfAborted();
    if (outcome.ok) {
      return {
        url,
        alive: true,
        elapsedMs,
        detail: `HTTP ${String(outcome.value)} after ${String(elapsedMs)}ms`,
      };
    }
    last = {
      url,
      alive: false,
      elapsedMs,
      detail: outcome.timedOut
        ? `no response within ${String(LIVENESS_TIMEOUT_MS)}ms`
        : errorMessage(outcome.error),
    };
  }
  return last;
}

/**
 * Der Ollama-Test in zwei Stufen.
 *
 * Stufe 1 ist die alte: Bereitschaftsfolge mit der Frist der Oberflaeche.
 * Laeuft sie ab, folgt Stufe 2 — die Unterscheidung, die vorher fehlte.
 * Erst ihr Ergebnis entscheidet, ob hier „antwortet nicht" oder „laedt noch"
 * steht, und ob ueberhaupt weitergewartet wird.
 */
async function checkOllama(
  view: WorkspaceView,
  ctx: CommandContext,
  timeoutMs: number,
  coldStartTimeoutMs: number,
): Promise<CheckResult> {
  const embedder = wireEmbedder(view);
  const startedAt = performance.now();
  const first = await withDeadline<EmbeddingReadinessV1>(
    (signal) => embedder.ensureReady({ signal }),
    timeoutMs,
    ctx.signal,
  );
  ctx.signal.throwIfAborted();
  if (first.ok) {
    return describeReadiness(
      view,
      first.value,
      Math.round(performance.now() - startedAt),
      timeoutMs,
    );
  }
  if (!first.timedOut) {
    return notReady(view, first.error);
  }

  // --- Stufe 2: lebt der Dienst ueberhaupt? -----------------------------
  const liveness = await probeLiveness(view, ctx);
  if (!liveness.alive) {
    return {
      id: "ollama",
      title: "Ollama",
      status: "fail",
      detail:
        `No response within ${String(timeoutMs)}ms; the follow-up identifies why: ` +
        `no sign of life. A simple GET to ${liveness.url} received no ` +
        `usable response (${liveness.detail}). The service is not responding; this differs from ` +
        "a responding service that is still loading.",
      nextStep: `Start Ollama and fetch the model: \`ollama pull ${view.config.embeddings.model}\`.`,
      facts: { endpoint: liveness.url, lebenszeichen: false, fristMs: timeoutMs },
    };
  }

  if (coldStartTimeoutMs <= 0) {
    return stillLoading(view, liveness, Math.round(performance.now() - startedAt), 0);
  }

  // Der Dienst lebt. Weiterwarten ist hier keine Geduldsprobe, sondern die
  // einzige Art, den Kaltstart vom Ausfall zu trennen — und der laufende
  // Ladevorgang wird dabei nicht verworfen (siehe DEFAULT_COLD_START_TIMEOUT_MS).
  note(
    ctx.io,
    `Ollama at ${liveness.url} responds (${liveness.detail}), but the readiness sequence ` +
      `is still running. This is consistent with a cold start; the first model load took ` +
      `31–37 s in measurements. Waiting up to ${String(coldStartTimeoutMs)}ms more; ` +
      "`--cold-start-timeout=0` disables this wait.",
  );
  const second = await withDeadline<EmbeddingReadinessV1>(
    (signal) => embedder.ensureReady({ signal }),
    coldStartTimeoutMs,
    ctx.signal,
  );
  ctx.signal.throwIfAborted();
  const elapsedMs = Math.round(performance.now() - startedAt);
  if (second.ok) return describeReadiness(view, second.value, elapsedMs, timeoutMs);
  if (!second.timedOut) return notReady(view, second.error);
  return stillLoading(view, liveness, elapsedMs, coldStartTimeoutMs);
}

function notReady(view: WorkspaceView, error: unknown): CheckResult {
  return {
    id: "ollama",
    title: "Ollama",
    status: "fail",
    detail: `Not ready: ${errorMessage(error)}`,
    nextStep: `Start Ollama and fetch the model: \`ollama pull ${view.config.embeddings.model}\`.`,
  };
}

/**
 * Der Dienst antwortet, die Bereitschaftsfolge aber nicht. Das wird auch so
 * gesagt: die Ursache ist damit EINGEGRENZT, nicht geklaert — und ein
 * abgebrochener Test bleibt ein Fehlschlag, kein bestandener Test.
 */
function stillLoading(
  view: WorkspaceView,
  liveness: LivenessProbeV1,
  elapsedMs: number,
  coldStartTimeoutMs: number,
): CheckResult {
  return {
    id: "ollama",
    title: "Ollama",
    status: "fail",
    detail:
      `The service at ${liveness.url} RESPONDS (${liveness.detail}), so it is running. ` +
      `However, even after ${String(elapsedMs)}ms it returned no probe embedding. ` +
      "The service is responding but may still be loading or stalled. " +
      "The complete readiness sequence is checked " +
      "(spec.md §9.1), including a probe embedding on /api/embed, the endpoint " +
      "indexing actually uses; an available /api/tags endpoint does not prove this readiness. " +
      "The check was cancelled and therefore did not pass.",
    nextStep:
      coldStartTimeoutMs <= 0
        ? `Allow a cold start: \`untangle doctor --cold-start-timeout=${String(DEFAULT_COLD_START_TIMEOUT_MS)}\`.`
        : `Probe the actual endpoint: \`curl -m 120 -X POST ${embedEndpointOf(liveness.url)} ` +
          `-d '{"model":"${view.config.embeddings.model}","input":["test"]}'\`; if it still gives no response, ` +
          "use `--embedder=offline` for indexing and search in the meantime.",
    facts: {
      endpoint: liveness.url,
      lebenszeichen: true,
      model: view.config.embeddings.model,
      dauerMs: elapsedMs,
    },
  };
}

/**
 * Die bestandene Pruefung — mit der GEMESSENEN Dauer. Hat sie die erste Frist
 * gerissen, steht das dabei: derselbe Lauf ein zweites Mal sieht anders aus,
 * und wer das nicht weiss, haelt den naechsten schnellen Lauf fuer eine
 * Aenderung, die es nie gab.
 */
function describeReadiness(
  view: WorkspaceView,
  readiness: EmbeddingReadinessV1,
  elapsedMs: number,
  firstBudgetMs: number,
): CheckResult {
  if (readiness.dimensions !== view.config.embeddings.dimensions) {
    return {
      id: "ollama",
      title: "Ollama",
      status: "fail",
      detail:
        `Model "${readiness.model}" returns ${String(readiness.dimensions)} dimensions, ` +
        `the configuration specifies ${String(view.config.embeddings.dimensions)}. An index with this ` +
        "mismatch would be unusable (spec.md §4.8).",
      nextStep: `Set \`embeddings.dimensions\` in ${primaryConfigFile(view) ?? "untangle.toml"} to ${String(readiness.dimensions)}.`,
      facts: {
        endpoint: readiness.endpoint,
        model: readiness.model,
        dimensions: readiness.dimensions,
        dauerMs: elapsedMs,
      },
    };
  }

  const overBudget = elapsedMs > firstBudgetMs;
  // Die Kaltstart-Erklaerung wird nur angeboten, wo sie etwas erklaert. Eine
  // gerissene Frist von 5ms ist keine Modellladung, und sie so zu nennen
  // waere dieselbe Sorte Behauptung, gegen die dieser ganze Befund geht.
  const cold = elapsedMs >= COLD_START_HINT_MS;
  return {
    id: "ollama",
    title: "Ollama",
    status: "ok",
    detail: overBudget
      ? `Ready: ${readiness.model} mit ${String(readiness.dimensions)} dimensions, but only ` +
        `after ${String(elapsedMs)}ms, later than the initial deadline of ` +
        `${String(firstBudgetMs)}ms. The service remained reachable and completed the request.` +
        (cold
          ? " The first model load typically takes this long; a second run " +
            "typically answers in a fraction of that time."
          : "")
      : `Ready: ${readiness.model} mit ${String(readiness.dimensions)} dimensions (${String(elapsedMs)}ms).`,
    facts: {
      endpoint: readiness.endpoint,
      model: readiness.model,
      dimensions: readiness.dimensions,
      probedAt: readiness.probedAt,
      dauerMs: elapsedMs,
      ersteFristGerissen: overBudget,
    },
  };
}

async function checkStorage(
  view: WorkspaceView,
  ctx: CommandContext,
  timeoutMs: number,
): Promise<CheckResult[]> {
  let wiring;
  try {
    wiring = wireStorage(view, ctx.env);
  } catch (error) {
    // WP-222: `wireStorage` setzt die gemeinsame Regel aus
    // `cli/vector-store-policy.ts` durch — dieselbe, an die sich `init`
    // haelt. Lehnt sie einen Speicher ab, uebernimmt `doctor` ihre
    // Begruendung und ihren naechsten Schritt WOERTLICH, statt einen eigenen
    // zu erfinden. Genau dieses Erfinden war der Widerspruch: `init`
    // verweigerte den Standardport einer fremden Instanz unter Berufung auf
    // spec.md §3.2, waehrend `doctor` dieselbe Instanz als "[OK ] Qdrant"
    // meldete und empfahl, dorthin zu indizieren.
    return [
      {
        id: "qdrant",
        title: "Qdrant",
        status: "fail",
        detail:
          error instanceof CliError
            ? error.message
            : `Cannot resolve configuration: ${errorMessage(error)}`,
        nextStep:
          error instanceof CliError && error.nextStep !== undefined
            ? error.nextStep
            : `Set \`qdrant.url\` in ${primaryConfigFile(view) ?? "untangle.toml"} to your own instance's address.`,
      },
    ];
  }

  const probe = await withDeadline<boolean>(
    (signal) => wiring.vectorStore.collectionExists(wiring.codeCollection, { signal }),
    timeoutMs,
    ctx.signal,
  );
  ctx.signal.throwIfAborted();
  if (!probe.ok) {
    return [
      {
        id: "qdrant",
        title: "Qdrant",
        status: "fail",
        detail: probe.timedOut
          ? `${wiring.qdrantConfig.url} did not answer within ${String(timeoutMs)}ms without responding; the check was cancelled.`
          : `${wiring.qdrantConfig.url} does not respond: ${errorMessage(probe.error)}`,
        nextStep: `Start an owned Qdrant instance on ${wiring.qdrantConfig.url} with its own volume; a foreign instance on another port is not a substitute (spec.md §3.2).`,
        facts: { url: wiring.qdrantConfig.url, collection: wiring.codeCollection },
      },
    ];
  }
  const exists = probe.value;

  const reachable: CheckResult = {
    id: "qdrant",
    title: "Qdrant",
    status: "ok",
    // Die Herkunft der Adresse steht dabei, nicht nur die Adresse. Ein
    // "[OK ] Qdrant" ohne die Angabe, WESSEN Qdrant, war der halbe Befund.
    detail: `Reachable at ${wiring.qdrantConfig.url} — ${wiring.decision.reason}.`,
    facts: {
      url: wiring.qdrantConfig.url,
      herkunft: wiring.decision.origin,
      collectionPrefix: wiring.qdrantConfig.collectionPrefix,
    },
  };

  if (!exists) {
    return [
      reachable,
      {
        id: "index",
        title: "Indexstand",
        status: "fail",
        detail:
          `Collection "${wiring.codeCollection}" for this embedding profile does not exist. ` +
          "Nothing is indexed; search would inspect no data.",
        // Frueher stand hier „Achtung: dieser Befehl ist noch nicht
        // verfuegbar". Das war seit Welle 5 falsch — `index` ist gebaut und
        // laeuft. Ein Diagnosewerkzeug, das ueber den eigenen Befehlssatz
        // Veraltetes behauptet, ist genau die E4-Klasse an der Oberflaeche:
        // eine Aussage, die nichts mehr deckt.
        nextStep: "Run `untangle index` to create and populate the collection.",
        facts: { collection: wiring.codeCollection },
      },
    ];
  }

  let points = -1;
  const counted = await withDeadline<number>(
    (signal) => wiring.vectorStore.countByFilter(wiring.codeCollection, {}, { signal }),
    timeoutMs,
    ctx.signal,
  );
  ctx.signal.throwIfAborted();
  if (counted.ok) {
    points = counted.value;
  } else {
    // Die Zaehlung ist eine Zusatzangabe, kein Test. Schlaegt sie fehl, bleibt
    // der Indexstand trotzdem „vorhanden" — verschwiegen wird das nicht: die
    // Zahl steht dann als -1 in den Fakten.
  }

  const freshnessProbe = await withDeadline(
    async (signal) => {
      const resolved = await resolveIndexState(
        [
          view.root,
          ...(view.config.repositories ?? []).map((repo) => path.resolve(view.root, repo.path)),
        ],
        view.workspaceId,
      );
      const states =
        resolved.kind === "resolved" || resolved.kind === "ambiguous"
          ? resolved.all.filter(
              ({ state, current }) =>
                current &&
                state.embeddingProfileId === view.profileId &&
                state.collection === wiring.codeCollection &&
                state.qdrantUrl === wiring.qdrantConfig.url,
            )
          : [];
      return inspectIndexFreshness(view, states, { signal, expectedRepoIds: view.repoIds });
    },
    timeoutMs,
    ctx.signal,
  );
  ctx.signal.throwIfAborted();
  const freshness = freshnessProbe.ok ? freshnessProbe.value : undefined;
  const freshnessStatus = freshness?.status ?? "unknown";

  return [
    reachable,
    {
      id: "index",
      title: "Indexstand",
      status: points === 0 ? "warn" : "ok",
      detail:
        points < 0
          ? `Collection "${wiring.codeCollection}" exists; point count could not be queried.`
          : `Collection "${wiring.codeCollection}" with ${String(points)} Punkten.`,
      ...(points === 0
        ? {
            nextStep: "The collection is empty; run `untangle index` to populate it.",
          }
        : {}),
      facts: { collection: wiring.codeCollection, points },
    },
    {
      id: "index-freshness",
      title: "Indexfrische",
      status:
        freshnessStatus === "fresh" ? "ok" : freshnessStatus === "incompatible" ? "fail" : "warn",
      detail: `Content hash check: ${freshnessStatus}. ${freshness?.repositories.map((entry) => `${entry.repoId}/${entry.refId}: ${entry.reason}`).join("; ") ?? "A full source check is unavailable."}`,
      ...(freshnessStatus === "fresh"
        ? {}
        : {
            nextStep: "Run `untangle index` or search with `untangle query <text> --refresh`.",
          }),
      facts: {
        status: freshnessStatus,
        ...(freshness === undefined
          ? {}
          : {
              checkedAt: freshness.checkedAt,
              repositories: freshness.repositories
                .map((entry) => `${entry.repoId}/${entry.refId}: ${entry.reason}`)
                .join("; "),
            }),
      },
    },
  ];
}

async function checkExtensions(ctx: CommandContext): Promise<CheckResult> {
  const { discoverExtensions, resolveExtensionRoots } =
    await import("@untangle-code/extension-runtime");
  const { LocalFileSystem } = await import("@untangle-code/storage-local");
  const os = await import("node:os");

  const roots = resolveExtensionRoots({
    homeDir: os.homedir(),
    platform: process.platform,
    env: ctx.env,
  });
  try {
    const fs = new LocalFileSystem(roots);
    const result = await discoverExtensions(fs, { roots, signal: ctx.signal });
    const rejected = result.rejected.length;
    return {
      id: "extensions",
      title: "Analyzer-Extensions",
      status: rejected > 0 ? "warn" : "ok",
      detail:
        `${String(result.extensions.length)} loaded, ${String(rejected)} rejected, ` +
        `${String(result.ignored.length)} explicitly skipped.`,
      ...(rejected > 0
        ? {
            nextStep: "Run `untangle extensions` for each rejected manifest's reason.",
          }
        : {}),
      facts: { roots: roots.length },
    };
  } catch (error) {
    ctx.signal.throwIfAborted();
    return {
      id: "extensions",
      title: "Analyzer-Extensions",
      status: "warn",
      detail: `Search unavailable: ${errorMessage(error)}`,
      nextStep: "Run `untangle extensions` to see which roots were searched.",
    };
  }
}

/* --------------------------------------------------------------------- */

function symbolFor(status: CheckStatus): string {
  return status === "ok" ? "OK  " : status === "warn" ? "WARN" : "FAIL";
}

function emit(
  ctx: CommandContext,
  checks: readonly CheckResult[],
  format: "text" | "json",
): number {
  const failed = checks.filter((check) => check.status === "fail");

  if (format === "json") {
    line(ctx.io, JSON.stringify({ schemaVersion: 1, ok: failed.length === 0, checks }, null, 2));
    return failed.length === 0 ? EXIT.ok : EXIT.environment;
  }

  for (const check of checks) {
    line(ctx.io, `[${symbolFor(check.status)}] ${check.title}`);
    line(ctx.io, `        ${check.detail}`);
    if (check.facts !== undefined) {
      for (const key of Object.keys(check.facts).sort(compareCodepoints)) {
        line(ctx.io, `        · ${key}: ${String(check.facts[key])}`);
      }
    }
    if (check.nextStep !== undefined) {
      line(ctx.io, `        -> ${check.nextStep}`);
    }
    line(ctx.io);
  }

  if (failed.length === 0) {
    note(ctx.io, "All checks passed.");
    return EXIT.ok;
  }
  note(ctx.io, `${String(failed.length)} check(s) failed.`);
  note(ctx.io, `Next step: ${(failed[0] as CheckResult).nextStep ?? "see above"}`);
  return EXIT.environment;
}
