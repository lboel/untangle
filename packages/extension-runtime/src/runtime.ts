/**
 * Der Lebenszyklus einer Extension: `detect → run → collect → normalize`
 * (extensions.md §6).
 *
 * Drei Eigenschaften bestimmen den Aufbau:
 *
 * - **X1, strikt opt-in.** Nichts hier startet von selbst. `detectExtension`
 *   liest hoechstens eine Versionsangabe; `runExtension` verlangt ein
 *   erfuelltes Lizenz-Gate und einen ausdruecklichen Aufruf.
 * - **X2, Untangle bleibt ohne Extension voll funktionsfaehig.** Keine
 *   Funktion hier wirft, weil ein Werkzeug fehlt. Sie liefern einen
 *   `ExtensionRunV1` mit `exitStatus` und `errorCode` — der Aufrufer
 *   entscheidet, ob das eine sichtbare Degradation (Leseoperation) oder ein
 *   Fehler (`extensions run`) ist.
 * - **X9, keine Werkzeugnamen.** Jede werkzeugspezifische Angabe kommt aus dem
 *   Manifest, also aus Nutzerdaten. Der Quelltext kennt Aufrufarten und
 *   Ausgabeformate (E2).
 */
import type {
  ExtensionInvocationMode,
  ExtensionManifestV1,
  ExternalFindingV1,
  ExternalMeasurementV1,
  SeverityMappingV1,
  SkipLedgerEntryV1,
  Clock,
  Random,
} from "@untangle-code/domain";
import { ID_COMPONENT_SEPARATOR, SEVERITY_MAP_VERSION, uuidv5 } from "@untangle-code/domain";

import {
  extensionFailed,
  extensionImageMismatch,
  extensionLicenseUnacknowledged,
  extensionTimeout,
  extensionUnavailable,
} from "./errors.js";
import type { OutputFormatOptions } from "./formats/index.js";
import { parseOutputFormat } from "./formats/index.js";
import { FormatParseError } from "./formats/types.js";
import type { LicenseGateDecisionV1 } from "./license-gate.js";
import type { LoadedExtensionV1 } from "./manifest/load.js";
import type { FileResolver, SymbolResolver } from "./normalize.js";
import { normalizeFindings } from "./normalize.js";
import type { PositionResolver } from "./positions.js";
import type {
  HttpRunnerPort,
  ProcessLimitsV1,
  ProcessResultV1,
  ProcessRunnerPort,
} from "./process/types.js";
import { defaultProcessLimits, isLoopbackUrl, redactSecrets } from "./process/types.js";
import type { ExtensionHealthV1, ExtensionRunV1 } from "./types.js";
import { emptyFindingCounts } from "./types.js";
import { EXTENSION_RUNTIME_VERSION, formatParserVersion } from "./versions.js";

/**
 * Geschlossene Menge der Platzhalter in `analyzeArgs`. Geschlossen, damit ein
 * Manifest nicht beliebige Werte aus der Laufzeit ziehen kann.
 */
export const INVOCATION_PLACEHOLDERS = ["{workspace}", "{target}", "{ruleset}"] as const;

export type InvocationPlaceholder = (typeof INVOCATION_PLACEHOLDERS)[number];

/** Ersetzt Platzhalter; nennt jeden, fuer den kein Wert vorliegt. */
export function resolvePlaceholders(
  args: readonly string[],
  values: Partial<Record<InvocationPlaceholder, string>>,
): { args: string[]; missing: InvocationPlaceholder[] } {
  const missing: InvocationPlaceholder[] = [];
  const resolved = args.map((argument) => {
    let out = argument;
    for (const placeholder of INVOCATION_PLACEHOLDERS) {
      if (!out.includes(placeholder)) {
        continue;
      }
      const value = values[placeholder];
      if (value === undefined) {
        if (!missing.includes(placeholder)) {
          missing.push(placeholder);
        }
        continue;
      }
      out = out.split(placeholder).join(value);
    }
    return out;
  });
  return { args: resolved, missing };
}

/**
 * Lauf-ID nach extensions.md §4.2. Der `runNonce` kommt ueber den
 * `Random`-Port: ein Lauf ist ein EREIGNIS, keine Ableitung aus Inhalt — zwei
 * Laeufe ueber identischen Inhalt sind zwei Laeufe.
 */
export function buildExtensionRunId(input: {
  workspaceId: string;
  extensionId: string;
  runtimeVersion: string;
  startedAtIso: string;
  runNonce: string;
}): string {
  return uuidv5(
    [
      "extension_run",
      input.workspaceId,
      input.extensionId,
      input.runtimeVersion,
      input.startedAtIso,
      input.runNonce,
    ].join(ID_COMPONENT_SEPARATOR),
  );
}

/** Von der Laufzeit benoetigte Ports. */
export interface ExtensionRuntimeDeps {
  clock: Clock;
  random: Random;
  processRunner: ProcessRunnerPort;
  /** Nur noetig fuer den Modus `http`. */
  httpRunner?: HttpRunnerPort;
  /**
   * Optionale Sonde einer Container-Laufzeit. Ohne sie gilt der Modus
   * `container` als nicht verfuegbar — Untangle bringt keine Container-
   * Laufzeit mit und startet erst recht keine (X1, §6.1).
   */
  containerProbe?: (
    extension: LoadedExtensionV1,
    options: { signal?: AbortSignal },
  ) => Promise<{ available: boolean; imageDigest?: string; detail: string }>;
}

export interface DetectExtensionInput {
  extension: LoadedExtensionV1;
  /**
   * Status des Lizenz-Gates. `unacknowledged` und `revoked` beenden `detect`
   * sofort: die Versionsabfrage und die Endpunktprobe sind selbst schon ein
   * Zugriff auf das fremde Werkzeug (X5).
   */
  licenseGate: ExtensionHealthV1["licenseGate"];
  /** Endpunkt fuer den Modus `http` (Instanzkonfiguration schlaegt Manifest). */
  httpUrl?: string;
  /** Zusaetzliche HTTP-Header, etwa aus {@link buildHttpAuthHeaders}. */
  httpHeaders?: Readonly<Record<string, string>>;
  /** Umgebung fuer die Versionsabfrage; MUSS `PATH` enthalten. */
  env?: Readonly<Record<string, string>>;
  /** Werte, die aus jeder Ausgabe redigiert werden (§8.5). */
  secretValues?: readonly string[];
  limits?: ProcessLimitsV1;
  signal?: AbortSignal;
}

/** Vergleicht zwei punktgetrennte Versionen numerisch; fehlende Stellen = 0. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    (/\d+(?:\.\d+)*/.exec(value)?.[0] ?? "0").split(".").map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Baut die Authorization-Header einer HTTP-Extension.
 *
 * `authSecretName` stand seit dem ersten Entwurf im Manifest und hatte keine
 * Wirkung: die HTTP-Grenze kann Header senden, aber nichts verband beides. Eine
 * Extension gegen eine tokengeschuetzte API war damit nicht betreibbar.
 *
 * extensions.md liess das Schema offen; hier ist es festgelegt:
 * `Authorization: Bearer <wert>`. Der Wert kommt aus der Umgebung des
 * Aufrufers, nie aus dem Manifest (§8.5) — diese Funktion liest keine Umgebung
 * selbst, sie bekommt sie uebergeben. Ein fehlendes oder leeres Geheimnis
 * ergibt KEINEN Header: ein leerer Bearer waere eine Anfrage, die vorgibt,
 * authentifiziert zu sein.
 */
export function buildHttpAuthHeaders(
  manifest: ExtensionManifestV1,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const name = manifest.http?.authSecretName;
  if (name === undefined) {
    return {};
  }
  const secret = manifest.secrets.find((candidate) => candidate.name === name);
  if (secret === undefined) {
    return {};
  }
  const value = env[secret.envVar];
  if (value === undefined || value === "") {
    return {};
  }
  return { Authorization: `Bearer ${value}` };
}

/**
 * Uebersetzt `[outputMapping]` in die Optionen der Formatparser.
 *
 * Die Felder heissen im Manifest wie im Parser; die Trennung nach Format
 * verhindert, dass ein Befund-Mapping stillschweigend auf Kennzahlen wirkt
 * oder umgekehrt.
 */
export function formatOptionsFromManifest(manifest: ExtensionManifestV1): OutputFormatOptions {
  const mapping = manifest.outputMapping;
  if (mapping === undefined) {
    return {};
  }
  if (manifest.outputFormat === "generic-metrics") {
    return {
      metricFields: {
        ...(mapping.shape === undefined ? {} : { shape: mapping.shape }),
        ...(mapping.container === undefined ? {} : { container: mapping.container }),
        ...(mapping.key === undefined ? {} : { key: mapping.key }),
        ...(mapping.value === undefined ? {} : { value: mapping.value }),
        ...(mapping.unit === undefined ? {} : { unit: mapping.unit }),
        ...(mapping.path === undefined ? {} : { path: mapping.path }),
      },
    };
  }
  if (manifest.outputFormat === "generic-findings") {
    return {
      findingFields: {
        ...(mapping.path === undefined ? {} : { path: mapping.path }),
        ...(mapping.severity === undefined ? {} : { severity: mapping.severity }),
        ...(mapping.message === undefined ? {} : { message: mapping.message }),
        ...(mapping.ruleId === undefined ? {} : { ruleId: mapping.ruleId }),
      },
    };
  }
  // sarif und junit-xml tragen ihre Struktur selbst; ein Mapping waere wirkungslos.
  return {};
}

/**
 * Bestimmt die Verfuegbarkeit je Aufrufmodus in der Praeferenzreihenfolge des
 * Manifests (extensions.md §6.1).
 *
 * DARF NICHT Container starten oder Images ziehen. Die Versionsabfrage eines
 * Programms ist der einzige Prozessstart hier — und sie ist genau der Grund,
 * warum `detect` ueberhaupt existiert.
 *
 * Und genau deshalb steht das Lizenz-Gate VOR der Schleife und nicht nur vor
 * `runExtension`: eine Versionsabfrage startet das fremde Programm, eine
 * Endpunktprobe spricht den fremden Dienst an. X5 erlaubt beides erst nach
 * einer ausdruecklichen Bestaetigung — „ohne Bestaetigung darf nicht einmal
 * gepullt werden". Vorher war das nur die Reihenfolge im Aufrufer; jeder
 * weitere Aufrufer (`status`, MCP, ein Job) haette die Regel neu brechen
 * koennen. Sie gehoert an die Grenze, nicht in die Disziplin des Aufrufers.
 */
export async function detectExtension(
  deps: ExtensionRuntimeDeps,
  input: DetectExtensionInput,
): Promise<ExtensionHealthV1> {
  const manifest = input.extension.manifest;
  const secrets = input.secretValues ?? [];
  const limits = input.limits ?? { ...defaultProcessLimits(), timeoutMs: 30_000 };
  const unavailableReasons: ExtensionHealthV1["unavailableReasons"] = [];
  const health: ExtensionHealthV1 = {
    schemaVersion: 1,
    extensionId: manifest.id,
    checkedAt: deps.clock.nowIso(),
    available: false,
    licenseGate: input.licenseGate,
    unavailableReasons,
  };

  if (input.licenseGate === "unacknowledged" || input.licenseGate === "revoked") {
    // X5: kein Prozessstart, keine Endpunktprobe, kein Pull ohne Bestaetigung.
    // Der Grund steht im Klartext, damit „nicht verfuegbar" belegt ist (E4).
    for (const mode of manifest.invocation) {
      unavailableReasons.push({
        invocation: mode,
        detail:
          `the license gate is ${input.licenseGate}; Untangle probed nothing — ` +
          "neither a version query, an endpoint request nor an image pull happens " +
          "before the terms are acknowledged (extensions.md X5)",
      });
    }
    return health;
  }

  for (const mode of manifest.invocation) {
    if (mode === "binary") {
      const binary = manifest.binary;
      if (binary === undefined) {
        unavailableReasons.push({ invocation: mode, detail: "manifest has no binary block" });
        continue;
      }
      const result = await deps.processRunner.run(
        {
          command: binary.command,
          args: binary.versionArgs,
          ...(input.env === undefined ? {} : { env: input.env }),
        },
        limits,
        input.signal === undefined ? {} : { signal: input.signal },
      );
      if (result.outcome !== "completed" || (result.exitCode ?? 1) !== 0) {
        unavailableReasons.push({
          invocation: mode,
          detail: redactSecrets(
            `version probe failed (${result.outcome}, exit ${String(result.exitCode)}): ` +
              `${result.failureDetail ?? result.stderr.slice(0, 200)}`,
            secrets,
          ),
        });
        continue;
      }
      const probeText = `${result.stdout}\n${result.stderr}`;
      let version: string | undefined;
      try {
        version = new RegExp(binary.versionPattern).exec(probeText)?.[1];
      } catch (cause) {
        unavailableReasons.push({
          invocation: mode,
          detail: `versionPattern is not a valid regular expression: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        });
        continue;
      }
      if (version === undefined) {
        unavailableReasons.push({
          invocation: mode,
          detail: "versionPattern did not match the version output",
        });
        continue;
      }
      if (binary.minVersion !== undefined && compareVersions(version, binary.minVersion) < 0) {
        unavailableReasons.push({
          invocation: mode,
          detail: `version ${version} is below the required minimum ${binary.minVersion}`,
        });
        continue;
      }
      health.available = true;
      health.effectiveInvocation = mode;
      health.toolVersion = version;
      health.binaryPath = binary.command;
      return health;
    }

    if (mode === "container") {
      if (deps.containerProbe === undefined) {
        unavailableReasons.push({
          invocation: mode,
          detail:
            "no container runtime probe is configured; Untangle neither ships nor starts a " +
            "container runtime on its own (extensions.md §6.1)",
        });
        continue;
      }
      const probe = await deps.containerProbe(
        input.extension,
        input.signal === undefined ? {} : { signal: input.signal },
      );
      if (!probe.available) {
        unavailableReasons.push({ invocation: mode, detail: probe.detail });
        continue;
      }
      const expected = manifest.container?.digest;
      if (probe.imageDigest !== undefined) {
        health.imageDigest = probe.imageDigest;
        health.digestMatchesManifest = probe.imageDigest === expected;
        if (!health.digestMatchesManifest) {
          // X6: ein wanderndes Image aendert stillschweigend Befunde.
          unavailableReasons.push({
            invocation: mode,
            detail: `running image digest ${probe.imageDigest} differs from the pinned ${String(expected)}`,
          });
          continue;
        }
      }
      health.available = true;
      health.effectiveInvocation = mode;
      return health;
    }

    // mode === "http"
    const url = input.httpUrl ?? manifest.http?.defaultUrl;
    if (url === undefined) {
      unavailableReasons.push({ invocation: mode, detail: "no endpoint is configured" });
      continue;
    }
    if (manifest.networkAccess === "loopback" && !isLoopbackUrl(url)) {
      unavailableReasons.push({
        invocation: mode,
        detail: `manifest declares networkAccess "loopback" but the endpoint "${url}" is not loopback`,
      });
      continue;
    }
    if (deps.httpRunner === undefined) {
      unavailableReasons.push({ invocation: mode, detail: "no HTTP runner is configured" });
      continue;
    }
    const response = await deps.httpRunner.request(
      {
        url,
        method: "GET",
        ...(input.httpHeaders === undefined ? {} : { headers: input.httpHeaders }),
      },
      limits,
      input.signal === undefined ? {} : { signal: input.signal },
    );
    if (
      response.outcome !== "completed" ||
      (response.status ?? 500) >= 500 ||
      isAuthenticationRefusal(response.status)
    ) {
      unavailableReasons.push({
        invocation: mode,
        detail: redactSecrets(
          `endpoint probe failed (${response.outcome}, status ${String(response.status)}): ` +
            `${
              response.failureDetail ??
              (isAuthenticationRefusal(response.status)
                ? "the service refused the request for lack of valid credentials"
                : "")
            }`,
          secrets,
        ),
      });
      continue;
    }
    health.available = true;
    health.effectiveInvocation = mode;
    health.endpoint = redactSecrets(url, secrets);
    return health;
  }

  return health;
}

export interface RunExtensionInput {
  extension: LoadedExtensionV1;
  /** Ergebnis von `detectExtension`. */
  health: ExtensionHealthV1;
  /** Ergebnis von `evaluateLicenseGate`. */
  gate: LicenseGateDecisionV1;

  workspaceId: string;
  repoId: string;
  refId: string;
  repoIds?: readonly string[];
  refIds?: readonly string[];
  projectIds?: readonly string[];
  indexGenerationId?: string;

  /** Wurzel des Arbeitsbereichs; Wert fuer `{workspace}`. */
  workspacePath: string;
  /** Analysiertes Ziel; Wert fuer `{target}`, Vorgabe `workspacePath`. */
  target?: string;
  ruleset?: string;
  rulesetVersion?: string;
  rulesetHash?: string;

  /** Umgebung des Werkzeugs; MUSS `PATH` enthalten. Geheimnisse NUR hier. */
  env?: Readonly<Record<string, string>>;
  secretValues?: readonly string[];
  limits?: ProcessLimitsV1;
  httpUrl?: string;
  /** Zusaetzliche HTTP-Header, etwa aus {@link buildHttpAuthHeaders}. */
  httpHeaders?: Readonly<Record<string, string>>;

  resolveFile: FileResolver;
  resolvePosition: PositionResolver;
  resolveSymbol?: SymbolResolver;
  /** Feld-Mapping der `generic-*`-Formate aus dem Manifest bzw. der Konfiguration. */
  formatOptions?: OutputFormatOptions;
  /** Ueberschreibt die Severity-Abbildung des Manifests (selten noetig). */
  severityMapping?: SeverityMappingV1;
  signal?: AbortSignal;
}

/** Ergebnis eines Laufs — Befunde UND Rechenschaft ueber das Uebersprungene. */
export interface ExtensionRunResultV1 {
  run: ExtensionRunV1;
  findings: ExternalFindingV1[];
  measurements: ExternalMeasurementV1[];
  /** E4: alles, was nicht uebernommen wurde, MIT Grund. */
  skipped: SkipLedgerEntryV1[];
  /**
   * Gesetzt, wenn der Lauf nicht `completed` ist. Der Aufrufer entscheidet:
   * eine Leseoperation degradiert sichtbar, `extensions run` wirft (X2).
   */
  error?: Error;
}

/**
 * Beschreibt, WIE ein Werkzeugprozess geendet hat — oder `undefined`, wenn er
 * sauber mit Status 0 endete.
 *
 * `exitCode ?? 0` waere hier ein Defekt: ein durch ein Signal getoetetes
 * Werkzeug (OOM-Kill, externes SIGKILL) liefert `exitCode: null` und saehe
 * damit wie ein erfolgreicher Lauf aus.
 */
export function describeAbnormalExit(result: ProcessResultV1): string | undefined {
  if (result.signal !== null) {
    return `the tool was terminated by signal ${result.signal}`;
  }
  if (result.exitCode === null) {
    return "the tool ended without reporting an exit code";
  }
  if (result.exitCode !== 0) {
    return `the tool exited with status ${String(result.exitCode)}`;
  }
  return undefined;
}

/** Erste Zeilen von stderr, redigiert und gekuerzt — als Beleg, nicht als Roman. */
function stderrExcerpt(text: string, secrets: readonly string[]): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    return "";
  }
  const excerpt = trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
  return redactSecrets(excerpt, secrets);
}

/**
 * True fuer eine erfolgreiche HTTP-Antwort (RFC 9110 §15.3).
 *
 * Alles andere ist eine Absage des Dienstes: 401 heisst „deine Zugangsdaten
 * greifen nicht", 404 „diesen Pfad gibt es nicht". Beides als Lauf mit null
 * Befunden zu melden, waere die schaedlichste Form von E4 — der Nutzer
 * schliesst aus „0 Befunde" auf eine saubere Codebasis.
 */
function isSuccessfulHttpStatus(status: number | null): boolean {
  return status !== null && status >= 200 && status <= 299;
}

/**
 * Status, die eine Verfuegbarkeitspruefung endgueltig scheitern lassen.
 *
 * Ein `404` auf der Wurzel-URL ist bei APIs normal, die nur Unterpfade
 * bedienen — der Dienst ANTWORTET ja. `401`/`403` dagegen bedeuten nach
 * RFC 9110 §15.5.2/§15.5.4, dass der Dienst die Anfrage mangels (oder wegen
 * unzureichender) Berechtigung ablehnt; kein Pfad dieses Dienstes wird ohne
 * gueltige Zugangsdaten antworten.
 */
function isAuthenticationRefusal(status: number | null): boolean {
  return status === 401 || status === 403;
}

/** Severity-Abbildung, wenn das Manifest keine mitbringt (nur Fallback). */
const FALLBACK_SEVERITY_MAPPING: SeverityMappingV1 = {
  mappingVersion: SEVERITY_MAP_VERSION,
  rules: [],
  fallback: "medium",
  caseInsensitive: true,
};

function baseRun(
  input: RunExtensionInput,
  runId: string,
  startedAt: string,
  invocation: ExtensionInvocationMode | undefined,
): ExtensionRunV1 {
  const manifest = input.extension.manifest;
  return {
    schemaVersion: 1,
    runId,
    extensionId: manifest.id,
    runtimeVersion: EXTENSION_RUNTIME_VERSION,
    formatParserVersion: formatParserVersion(manifest.outputFormat),
    outputFormat: manifest.outputFormat,
    toolVersion: input.health.toolVersion ?? "unknown",
    ...(input.health.imageDigest === undefined ? {} : { imageDigest: input.health.imageDigest }),
    ...(invocation === undefined ? {} : { invocation }),
    ...(input.ruleset === undefined ? {} : { ruleset: input.ruleset }),
    ...(input.rulesetVersion === undefined ? {} : { rulesetVersion: input.rulesetVersion }),
    ...(input.rulesetHash === undefined ? {} : { rulesetHash: input.rulesetHash }),
    ...(input.ruleset !== undefined &&
    input.rulesetVersion === undefined &&
    input.rulesetHash === undefined
      ? {
          comparabilityLimited: true,
          comparabilityNote:
            `ruleset "${input.ruleset}" resolved to neither a version nor a content hash; this ` +
            "run must not serve as a comparison base (extensions.md §9.2 addendum)",
        }
      : {}),
    workspaceId: input.workspaceId,
    repoIds: [...(input.repoIds ?? [input.repoId])],
    refIds: [...(input.refIds ?? [input.refId])],
    ...(input.projectIds === undefined ? {} : { projectIds: [...input.projectIds] }),
    ...(input.indexGenerationId === undefined
      ? {}
      : { indexGenerationId: input.indexGenerationId }),
    startedAt,
    exitStatus: "failed",
    filesAnalyzed: 0,
    filesSkipped: [],
    findingCounts: emptyFindingCounts(),
    findingsTotal: 0,
    resources: { wallTimeMs: 0 },
    errors: [],
    warnings: [],
  };
}

/** Beendet einen Lauf mit Fehlerklasse, ohne dass ein Prozess gestartet wurde. */
function refuse(
  run: ExtensionRunV1,
  clock: Clock,
  status: ExtensionRunV1["exitStatus"],
  error: Error & { code?: string },
): ExtensionRunResultV1 {
  run.exitStatus = status;
  run.finishedAt = clock.nowIso();
  if (error.code !== undefined) {
    run.errorCode = error.code;
    run.errors.push({ code: error.code, message: error.message });
  }
  return { run, findings: [], measurements: [], skipped: [], error };
}

/**
 * Fuehrt eine Extension aus und normalisiert ihre Ausgabe.
 *
 * Reihenfolge der Verweigerungsgruende ist bewusst: Lizenz-Gate VOR jeder
 * Verfuegbarkeitspruefung und erst recht vor jedem Prozessstart — ohne
 * Bestaetigung darf nicht einmal gepullt werden (X5, §9.2).
 */
export async function runExtension(
  deps: ExtensionRuntimeDeps,
  input: RunExtensionInput,
): Promise<ExtensionRunResultV1> {
  const manifest = input.extension.manifest;
  const startedAt = deps.clock.nowIso();
  const startedAtMs = deps.clock.nowEpochMs();
  const runId = buildExtensionRunId({
    workspaceId: input.workspaceId,
    extensionId: manifest.id,
    runtimeVersion: EXTENSION_RUNTIME_VERSION,
    startedAtIso: startedAt,
    runNonce: deps.random.uuid(),
  });
  const invocationMode = input.health.effectiveInvocation;
  const run = baseRun(input, runId, startedAt, invocationMode);
  const secrets = input.secretValues ?? [];
  const limits = input.limits ?? defaultProcessLimits();

  if (!input.gate.allowed) {
    const reasons = [input.gate.tool, ...input.gate.rulesets]
      .filter((outcome) => outcome.status !== "acknowledged" && outcome.status !== "not_required")
      .map((outcome) => outcome.reason)
      .join("; ");
    return refuse(
      run,
      deps.clock,
      "failed",
      extensionLicenseUnacknowledged(
        manifest.id,
        reasons,
        input.gate.acknowledgeCommands.join(" && "),
      ),
    );
  }

  if (input.health.digestMatchesManifest === false) {
    return refuse(
      run,
      deps.clock,
      "failed",
      extensionImageMismatch(
        manifest.id,
        manifest.container?.digest ?? "(none)",
        input.health.imageDigest ?? "(unknown)",
      ),
    );
  }

  if (!input.health.available || invocationMode === undefined) {
    const detail = input.health.unavailableReasons
      .map((reason) => `${reason.invocation}: ${reason.detail}`)
      .join("; ");
    return refuse(
      run,
      deps.clock,
      "failed",
      extensionUnavailable(manifest.id, detail === "" ? "no invocation mode is available" : detail),
    );
  }

  // --- run + collect ------------------------------------------------------
  let rawOutput: string;
  let processResult: ProcessResultV1 | undefined;
  if (invocationMode === "http") {
    const base = input.httpUrl ?? manifest.http?.defaultUrl;
    if (base === undefined || deps.httpRunner === undefined) {
      return refuse(
        run,
        deps.clock,
        "failed",
        extensionUnavailable(manifest.id, "http invocation without an endpoint or an HTTP runner"),
      );
    }
    const url =
      manifest.http?.analyzePath === undefined ? base : `${base}${manifest.http.analyzePath}`;
    const response = await deps.httpRunner.request(
      {
        url,
        method: manifest.http?.analyzeMethod ?? "GET",
        ...(input.httpHeaders === undefined ? {} : { headers: input.httpHeaders }),
      },
      limits,
      input.signal === undefined ? {} : { signal: input.signal },
    );
    run.resources.wallTimeMs = response.wallTimeMs;
    if (response.outcome === "timeout") {
      return refuse(run, deps.clock, "timeout", extensionTimeout(manifest.id, limits.timeoutMs));
    }
    if (response.outcome === "cancelled") {
      return refuse(
        run,
        deps.clock,
        "cancelled",
        extensionFailed(manifest.id, "process_error", "the run was cancelled"),
      );
    }
    if (response.outcome !== "completed") {
      return refuse(
        run,
        deps.clock,
        "failed",
        extensionFailed(
          manifest.id,
          response.outcome === "output_limit_exceeded" ? "output_too_large" : "http_error",
          redactSecrets(response.failureDetail ?? `status ${String(response.status)}`, secrets),
        ),
      );
    }
    if (!isSuccessfulHttpStatus(response.status)) {
      // Der Dienst hat GEANTWORTET, aber nicht mit einem Ergebnis. Den Koerper
      // trotzdem zu parsen liefert null Befunde und verschweigt den Grund.
      return refuse(
        run,
        deps.clock,
        "failed",
        extensionFailed(
          manifest.id,
          "http_error",
          redactSecrets(
            `the service answered ${url} with HTTP status ${String(response.status)}` +
              `${response.body.trim() === "" ? "" : `: ${stderrExcerpt(response.body, secrets)}`}`,
            secrets,
          ),
        ),
      );
    }
    if (response.bodyTruncated) {
      run.warnings.push("the response body was truncated at the configured output limit");
    }
    rawOutput = response.body;
  } else {
    const args =
      invocationMode === "container"
        ? manifest.container?.analyzeArgs
        : manifest.binary?.analyzeArgs;
    const command = invocationMode === "container" ? undefined : manifest.binary?.command;
    if (args === undefined || command === undefined) {
      // Ohne `analyzeArgs` beschreibt das Manifest keinen Analyselauf. Wir
      // raten keinen Aufruf — das waere Werkzeugwissen im Quelltext (X9).
      return refuse(
        run,
        deps.clock,
        "failed",
        extensionUnavailable(
          manifest.id,
          invocationMode === "container"
            ? "container runs require a container runtime adapter; this runtime only pins and checks the digest"
            : "manifest declares no analyzeArgs; Untangle never guesses a tool invocation (extensions.md X9)",
        ),
      );
    }
    const placeholders = resolvePlaceholders(args, {
      "{workspace}": input.workspacePath,
      "{target}": input.target ?? input.workspacePath,
      ...(input.ruleset === undefined ? {} : { "{ruleset}": input.ruleset }),
    });
    if (placeholders.missing.length > 0) {
      return refuse(
        run,
        deps.clock,
        "failed",
        extensionFailed(
          manifest.id,
          "process_error",
          `analyzeArgs reference unresolved placeholder(s): ${placeholders.missing.join(", ")}`,
        ),
      );
    }
    processResult = await deps.processRunner.run(
      {
        command,
        args: placeholders.args,
        cwd: input.workspacePath,
        ...(input.env === undefined ? {} : { env: input.env }),
      },
      limits,
      input.signal === undefined ? {} : { signal: input.signal },
    );
    run.resources.wallTimeMs = processResult.wallTimeMs;
    if (processResult.outcome === "timeout") {
      return refuse(run, deps.clock, "timeout", extensionTimeout(manifest.id, limits.timeoutMs));
    }
    if (processResult.outcome === "cancelled") {
      return refuse(
        run,
        deps.clock,
        "cancelled",
        extensionFailed(manifest.id, "process_error", "the run was cancelled"),
      );
    }
    if (processResult.outcome === "output_limit_exceeded") {
      return refuse(
        run,
        deps.clock,
        "failed",
        extensionFailed(
          manifest.id,
          "output_too_large",
          redactSecrets(processResult.failureDetail ?? "output limit exceeded", secrets),
        ),
      );
    }
    if (processResult.outcome === "spawn_failed") {
      return refuse(
        run,
        deps.clock,
        "failed",
        extensionUnavailable(
          manifest.id,
          redactSecrets(processResult.failureDetail ?? "the program could not be started", secrets),
        ),
      );
    }
    // WP-183 (E4): Der `ProcessRunner` ist ein PORT. Der mitgelieferte
    // Node-Runner bricht bei gerissener Ausgabegrenze mit
    // `output_limit_exceeded` ab — ein anderer Runner darf aber
    // `completed` melden und `stdoutTruncated` setzen, und genau dann wurde
    // hier eine ABGESCHNITTENE Ausgabe geparst. Bei JSON und XML faellt das
    // noch als Parsefehler auf; bei zeilenweisen Formaten entsteht lautlos
    // eine Teilmenge der Befunde, die wie das vollstaendige Ergebnis aussieht.
    if (processResult.stdoutTruncated) {
      return refuse(
        run,
        deps.clock,
        "failed",
        extensionFailed(
          manifest.id,
          "output_too_large",
          redactSecrets(
            `stdout was truncated at the configured output limit after ${String(processResult.stdoutBytes)} bytes; ` +
              "the remaining output was never read, so any findings in it would be silently missing",
            secrets,
          ),
        ),
      );
    }
    rawOutput = processResult.stdout;
  }

  // Optionaler Vorschaltbefehl: bringt die Ausgabe in ein bekanntes Format.
  if (manifest.preprocess !== undefined) {
    const pre = await deps.processRunner.run(
      {
        command: manifest.preprocess.command,
        args: manifest.preprocess.args,
        cwd: input.workspacePath,
        stdin: rawOutput,
        ...(input.env === undefined ? {} : { env: input.env }),
      },
      limits,
      input.signal === undefined ? {} : { signal: input.signal },
    );
    if (pre.outcome !== "completed" || (pre.exitCode ?? 1) !== 0) {
      return refuse(
        run,
        deps.clock,
        "failed",
        extensionFailed(
          manifest.id,
          // WP-183: `output_limit_exceeded` ist kein Parsefehler. Der
          // Vorschaltbefehl hat nicht unlesbar geschrieben, er hat ZU VIEL
          // geschrieben — und der Unterschied entscheidet, wo man sucht.
          pre.outcome === "output_limit_exceeded" ? "output_too_large" : "output_parse_failed",
          redactSecrets(
            `preprocess command failed (${pre.outcome}, exit ${String(pre.exitCode)}): ` +
              `${pre.failureDetail ?? pre.stderr.slice(0, 200)}`,
            secrets,
          ),
        ),
      );
    }
    // WP-183: dieselbe Luecke wie beim Werkzeug — und hier sogar noch stiller,
    // weil der Vorschaltbefehl mit Exit 0 endet und trotzdem eine gekuerzte
    // Ausgabe weitergibt.
    if (pre.stdoutTruncated) {
      return refuse(
        run,
        deps.clock,
        "failed",
        extensionFailed(
          manifest.id,
          "output_too_large",
          redactSecrets(
            `the preprocess command's stdout was truncated at the configured output limit after ${String(pre.stdoutBytes)} bytes; ` +
              "the remaining output was never read, so any findings in it would be silently missing",
            secrets,
          ),
        ),
      );
    }
    if (pre.stderrTruncated) {
      run.warnings.push(
        "the preprocess command's stderr was truncated at the configured output limit",
      );
    }
    rawOutput = pre.stdout;
  }

  // Ein von Null verschiedener Exit-Status ist bei vielen Werkzeugen die
  // Meldung „ich habe etwas gefunden". Deshalb wird die AUSGABE zuerst
  // gelesen; erst wenn sie unbrauchbar ist, zaehlt der Exit-Status.
  let parsed;
  try {
    // Das Manifest ist die Quelle der Lesehilfe; `input.formatOptions` bleibt
    // die Ausnahme fuer Aufrufer, die eine Ausgabe ohne Manifest lesen. Vor
    // Welle 11 gab es nur die Ausnahme — ein Manifest konnte seine eigene
    // Ausgabeform nicht beschreiben (X9).
    parsed = parseOutputFormat(
      manifest.outputFormat,
      rawOutput,
      input.formatOptions ?? formatOptionsFromManifest(manifest),
    );
  } catch (cause) {
    if (cause instanceof FormatParseError) {
      const abnormal =
        processResult === undefined ? undefined : describeAbnormalExit(processResult);
      const exitDetail =
        abnormal === undefined || processResult === undefined
          ? ""
          : ` (${abnormal}: ${stderrExcerpt(processResult.stderr, secrets)})`;
      return refuse(
        run,
        deps.clock,
        "failed",
        extensionFailed(manifest.id, "output_parse_failed", `${cause.message}${exitDetail}`),
      );
    }
    throw cause;
  }

  // E4: nicht uebernommene Eintraege der Rohausgabe bleiben sichtbar — auch
  // dann, wenn der Lauf gleich darauf als gescheitert endet.
  for (const issue of parsed.issues) {
    run.errors.push({
      code:
        issue.reason === "tool_reported_failure" ? "TOOL_REPORTED_FAILURE" : "OUTPUT_ENTRY_SKIPPED",
      message: `${issue.rawLocation}: ${issue.reason} — ${issue.detail}`,
    });
  }

  // Ein von Null verschiedener Exit-Status ist bei vielen Werkzeugen die
  // Meldung „ich habe etwas gefunden" — das rechtfertigt, den Lauf nicht
  // scheitern zu lassen, aber NICHT, den Fehlschlag zu verschlucken. Er wird
  // deshalb immer festgehalten; und wenn die Ausgabe ausserdem KEINEN einzigen
  // Eintrag enthielt, gibt es keinerlei Beleg fuer eine durchgefuehrte Analyse:
  // dann ist der Lauf gescheitert, nicht „sauber" (E4).
  if (processResult !== undefined) {
    const abnormal = describeAbnormalExit(processResult);
    if (abnormal !== undefined) {
      const excerpt = stderrExcerpt(processResult.stderr, secrets);
      const detail = `${abnormal}${excerpt === "" ? "" : `: ${excerpt}`}`;
      // WP-199: „kein Eintrag" ist nicht gleich „kein Bericht". Wer einen
      // gueltigen, leeren Bericht abliefert, hat nachweislich gearbeitet und
      // nichts gefunden — den Lauf mit der Begruendung „die Ausgabe enthielt
      // ueberhaupt keine Eintraege, der Lauf belegt also keine durchgefuehrte
      // Analyse" scheitern zu lassen, war eine falsche Tatsachenbehauptung
      // ueber genau diese Ausgabe. Verschluckt wird trotzdem nichts: der
      // Widerspruch zwischen Exit-Status und leerem Bericht steht als eigener
      // Fehler im Lauf.
      if (parsed.entriesSeen === 0 && parsed.recognizedReport !== true) {
        return refuse(
          run,
          deps.clock,
          "failed",
          extensionFailed(
            manifest.id,
            "exit_status",
            `${detail}; its output contained no entries at all and was not recognizable as a ` +
              `${manifest.outputFormat} report, so the run is no evidence of a completed analysis`,
          ),
        );
      }
      run.errors.push({ code: "TOOL_EXIT_NONZERO", message: detail });
      if (parsed.entriesSeen === 0) {
        run.errors.push({
          code: "EMPTY_REPORT_AFTER_NONZERO_EXIT",
          message:
            `the tool exited abnormally but delivered a well-formed, EMPTY ${manifest.outputFormat} ` +
            "report; exit status and report contradict each other, and this run reports no findings",
        });
      }
    }
  }

  // --- normalize ----------------------------------------------------------
  const normalization = normalizeFindings(parsed, {
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    refId: input.refId,
    extensionRunId: runId,
    extensionId: manifest.id,
    // Die Werkzeugkennung kommt aus den Nutzerdaten: bevorzugt der Name aus
    // der Ausgabe, sonst die Extension-ID (E2).
    tool: parsed.toolNameHint ?? manifest.id,
    toolVersion: parsed.toolVersionHint ?? input.health.toolVersion ?? "unknown",
    detectedAt: startedAt,
    outputFormat: manifest.outputFormat,
    invocation: invocationMode,
    ...(input.health.imageDigest === undefined ? {} : { imageDigest: input.health.imageDigest }),
    severityMapping: input.severityMapping ?? manifest.severityMapping ?? FALLBACK_SEVERITY_MAPPING,
    ...(manifest.complexitySignals === undefined
      ? {}
      : { complexitySignals: manifest.complexitySignals }),
    ...(input.ruleset === undefined ? {} : { ruleset: input.ruleset }),
    ...(input.rulesetVersion === undefined ? {} : { rulesetVersion: input.rulesetVersion }),
    resolveFile: input.resolveFile,
    resolvePosition: input.resolvePosition,
    ...(input.resolveSymbol === undefined ? {} : { resolveSymbol: input.resolveSymbol }),
  });

  for (const finding of normalization.findings) {
    run.findingCounts[finding.severity.normalized] += 1;
  }
  run.findingsTotal = normalization.findings.length;
  run.filesAnalyzed = new Set(normalization.findings.map((finding) => finding.filePath)).size;
  run.filesSkipped = normalization.skipped
    .filter((entry) => entry.path !== undefined)
    .map((entry) => ({
      filePath: entry.path as string,
      reason: `${entry.reason}: ${entry.detail}`,
    }));
  run.warnings.push(...normalization.warnings);
  if (parsed.toolVersionHint !== undefined) {
    run.toolVersion = parsed.toolVersionHint;
  }
  if (processResult !== undefined && processResult.stderrTruncated) {
    run.warnings.push("stderr was truncated at the configured output limit");
  }

  run.exitStatus = "completed";
  run.finishedAt = deps.clock.nowIso();
  run.resources.wallTimeMs = deps.clock.nowEpochMs() - startedAtMs;

  return {
    run,
    findings: normalization.findings,
    measurements: normalization.measurements,
    skipped: normalization.skipped,
  };
}
