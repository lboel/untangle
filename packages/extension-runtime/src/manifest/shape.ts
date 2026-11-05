/**
 * Strenge Strukturpruefung eines Extension-Manifests (extensions.md §5.2).
 *
 * Traegerformat ist TOML. Ein Manifest ist REINE DATEN — es beschreibt, wie
 * ein externes Werkzeug aufgerufen wird und welches Ausgabeformat es liefert.
 * Es enthaelt keinen Code, und diese Datei enthaelt kein Werkzeugwissen (X9,
 * E2): jeder Zweig hier prueft eine FELDFORM, nie einen Werkzeugnamen.
 *
 * Arbeitsteilung mit `@untangle-code/domain`:
 * - hier die STRUKTUR (welches Feld, welcher Typ, welche geschlossene Menge);
 * - dort `validateExtensionManifest` die SEMANTIK (Digest gepinnt,
 *   Lizenzbestaetigung gekoppelt, Netzbegruendung, Telemetrie aus).
 * `parseExtensionManifest` fuehrt beide zusammen und liefert eine
 * Gesamtbefundliste — nie ein „fast gueltiges" Manifest ohne Hinweis.
 */
import type {
  ExtensionBinaryInvocationV1,
  ExtensionCategory,
  ExtensionComplexitySignalV1,
  ExtensionContainerInvocationV1,
  ExtensionContainerPortV1,
  ExtensionContainerVolumeV1,
  ExtensionHealthcheckV1,
  ExtensionHttpInvocationV1,
  ExtensionInvocationMode,
  ExtensionLicenseV1,
  ExtensionManifestIssue,
  ExtensionManifestV1,
  ExtensionOutputFormat,
  ExtensionOutputMappingV1,
  ExtensionPreprocessV1,
  ExtensionResourcesV1,
  ExtensionRulesetSourceV1,
  ExtensionSecretV1,
  ExtensionTelemetryV1,
  NormalizedSeverity,
  SeverityMappingRuleV1,
  SeverityMappingV1,
} from "@untangle-code/domain";
import {
  EXTENSION_CATEGORIES,
  EXTENSION_INVOCATION_MODES,
  EXTENSION_OUTPUT_FORMATS,
  NORMALIZED_SEVERITIES,
  validateExtensionManifest,
} from "@untangle-code/domain";
import { parse as parseToml, TomlError } from "smol-toml";

import { isRecord } from "../formats/util.js";

/** Ergebnis der Manifestpruefung. */
export interface ManifestParseResultV1 {
  /** Nur gesetzt, wenn KEIN Befund vorliegt. Ein Manifest mit Befunden gilt als ungueltig. */
  manifest: ExtensionManifestV1 | null;
  issues: ExtensionManifestIssue[];
}

/** Sammelt Befunde mit Feldpfad; ein Befund reicht, um das Manifest abzulehnen. */
class IssueList {
  public readonly issues: ExtensionManifestIssue[] = [];

  public add(field: string, message: string): void {
    this.issues.push({ field, message });
  }
}

function requireString(
  source: Record<string, unknown>,
  field: string,
  path: string,
  issues: IssueList,
): string | undefined {
  const value = source[field];
  if (typeof value !== "string" || value.trim() === "") {
    issues.add(path, `expected a non-empty string, got ${describe(value)}`);
    return undefined;
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  field: string,
  path: string,
  issues: IssueList,
): string | undefined {
  const value = source[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    issues.add(path, `expected a non-empty string when present, got ${describe(value)}`);
    return undefined;
  }
  return value;
}

function requireNumber(
  source: Record<string, unknown>,
  field: string,
  path: string,
  issues: IssueList,
): number | undefined {
  const value = source[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.add(path, `expected a finite number, got ${describe(value)}`);
    return undefined;
  }
  return value;
}

function optionalNumber(
  source: Record<string, unknown>,
  field: string,
  path: string,
  issues: IssueList,
): number | undefined {
  const value = source[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.add(path, `expected a finite number when present, got ${describe(value)}`);
    return undefined;
  }
  return value;
}

function requireBoolean(
  source: Record<string, unknown>,
  field: string,
  path: string,
  issues: IssueList,
): boolean | undefined {
  const value = source[field];
  if (typeof value !== "boolean") {
    issues.add(path, `expected a boolean, got ${describe(value)}`);
    return undefined;
  }
  return value;
}

function requireStringArray(
  source: Record<string, unknown>,
  field: string,
  path: string,
  issues: IssueList,
): string[] | undefined {
  const value = source[field];
  if (!Array.isArray(value)) {
    issues.add(path, `expected an array of strings, got ${describe(value)}`);
    return undefined;
  }
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      issues.add(`${path}[${String(index)}]`, `expected a string, got ${describe(entry)}`);
      continue;
    }
    out.push(entry);
  }
  return out;
}

function requireRecord(
  source: Record<string, unknown>,
  field: string,
  path: string,
  issues: IssueList,
): Record<string, unknown> | undefined {
  const value = source[field];
  if (!isRecord(value)) {
    issues.add(path, `expected a table, got ${describe(value)}`);
    return undefined;
  }
  return value;
}

function optionalRecord(
  source: Record<string, unknown>,
  field: string,
  path: string,
  issues: IssueList,
): Record<string, unknown> | undefined {
  const value = source[field];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    issues.add(path, `expected a table when present, got ${describe(value)}`);
    return undefined;
  }
  return value;
}

function optionalRecordArray(
  source: Record<string, unknown>,
  field: string,
  path: string,
  issues: IssueList,
): Record<string, unknown>[] | undefined {
  const value = source[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    issues.add(path, `expected an array of tables when present, got ${describe(value)}`);
    return undefined;
  }
  const out: Record<string, unknown>[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      issues.add(`${path}[${String(index)}]`, `expected a table, got ${describe(entry)}`);
      continue;
    }
    out.push(entry);
  }
  return out;
}

function requireMember<T extends string>(
  source: Record<string, unknown>,
  field: string,
  path: string,
  allowed: readonly T[],
  issues: IssueList,
): T | undefined {
  const value = source[field];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    issues.add(path, `expected one of ${allowed.join(" | ")}, got ${describe(value)}`);
    return undefined;
  }
  return value as T;
}

/** Kurze, redaktionssichere Beschreibung eines Wertes fuer Fehlermeldungen. */
function describe(value: unknown): string {
  if (value === undefined) {
    return "nothing";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `an array of ${String(value.length)} entries`;
  }
  if (typeof value === "object") {
    return "a table";
  }
  if (typeof value === "string") {
    return `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`;
  }
  return String(value);
}

function readResources(
  source: Record<string, unknown>,
  issues: IssueList,
): ExtensionResourcesV1 | undefined {
  const table = requireRecord(source, "resources", "resources", issues);
  if (table === undefined) {
    return undefined;
  }
  const minMemoryMb = requireNumber(table, "minMemoryMb", "resources.minMemoryMb", issues);
  const recommendedMemoryMb = requireNumber(
    table,
    "recommendedMemoryMb",
    "resources.recommendedMemoryMb",
    issues,
  );
  const recommendedCpus = requireNumber(
    table,
    "recommendedCpus",
    "resources.recommendedCpus",
    issues,
  );
  const typicalStartupSeconds = optionalNumber(
    table,
    "typicalStartupSeconds",
    "resources.typicalStartupSeconds",
    issues,
  );
  if (
    minMemoryMb === undefined ||
    recommendedMemoryMb === undefined ||
    recommendedCpus === undefined
  ) {
    return undefined;
  }
  if (recommendedMemoryMb < minMemoryMb) {
    issues.add(
      "resources.recommendedMemoryMb",
      "recommended memory must not be below the declared minimum",
    );
  }
  return {
    minMemoryMb,
    recommendedMemoryMb,
    recommendedCpus,
    ...(typicalStartupSeconds === undefined ? {} : { typicalStartupSeconds }),
  };
}

function readLicense(
  source: Record<string, unknown>,
  issues: IssueList,
): ExtensionLicenseV1 | undefined {
  const table = requireRecord(source, "license", "license", issues);
  if (table === undefined) {
    return undefined;
  }
  const spdxId = requireString(table, "spdxId", "license.spdxId", issues);
  const usageRestriction = requireMember(
    table,
    "usageRestriction",
    "license.usageRestriction",
    ["none", "restricted"] as const,
    issues,
  );
  const restrictionSummary = optionalString(
    table,
    "restrictionSummary",
    "license.restrictionSummary",
    issues,
  );
  const url = optionalString(table, "url", "license.url", issues);
  if (spdxId === undefined || usageRestriction === undefined) {
    return undefined;
  }
  return {
    spdxId,
    usageRestriction,
    ...(restrictionSummary === undefined ? {} : { restrictionSummary }),
    ...(url === undefined ? {} : { url }),
  };
}

function readTelemetry(
  source: Record<string, unknown>,
  issues: IssueList,
): ExtensionTelemetryV1 | undefined {
  const table = requireRecord(source, "telemetry", "telemetry", issues);
  if (table === undefined) {
    return undefined;
  }
  const sendsTelemetry = requireBoolean(
    table,
    "sendsTelemetry",
    "telemetry.sendsTelemetry",
    issues,
  );
  const disabledByDefault = requireBoolean(
    table,
    "disabledByDefault",
    "telemetry.disabledByDefault",
    issues,
  );
  const disableMechanism = optionalString(
    table,
    "disableMechanism",
    "telemetry.disableMechanism",
    issues,
  );
  if (sendsTelemetry === undefined || disabledByDefault === undefined) {
    return undefined;
  }
  return {
    sendsTelemetry,
    disabledByDefault,
    ...(disableMechanism === undefined ? {} : { disableMechanism }),
  };
}

function readSecrets(
  source: Record<string, unknown>,
  issues: IssueList,
): ExtensionSecretV1[] | undefined {
  const entries = optionalRecordArray(source, "secrets", "secrets", issues);
  if (entries === undefined) {
    return source["secrets"] === undefined ? [] : undefined;
  }
  const secrets: ExtensionSecretV1[] = [];
  for (const [index, entry] of entries.entries()) {
    const path = `secrets[${String(index)}]`;
    const name = requireString(entry, "name", `${path}.name`, issues);
    const envVar = requireString(entry, "envVar", `${path}.envVar`, issues);
    const required = requireBoolean(entry, "required", `${path}.required`, issues);
    const purpose = requireString(entry, "purpose", `${path}.purpose`, issues);
    if (
      name === undefined ||
      envVar === undefined ||
      required === undefined ||
      purpose === undefined
    ) {
      continue;
    }
    if ("value" in entry || "token" in entry) {
      // Geheimnisse stehen NIE im Manifest (extensions.md §8.5). Ein Manifest,
      // das es doch versucht, wird abgelehnt statt bereinigt.
      issues.add(path, "a secret must be an env-var reference; the manifest must not carry values");
    }
    const setupOnly =
      entry["setupOnly"] === undefined
        ? undefined
        : requireBoolean(entry, "setupOnly", `${path}.setupOnly`, issues);
    secrets.push({
      name,
      envVar,
      required,
      purpose,
      ...(setupOnly === undefined ? {} : { setupOnly }),
    });
  }
  return secrets;
}

function readSeverityMapping(
  source: Record<string, unknown>,
  issues: IssueList,
): SeverityMappingV1 | undefined {
  const table = optionalRecord(source, "severityMapping", "severityMapping", issues);
  if (table === undefined) {
    return undefined;
  }
  const mappingVersion = requireString(
    table,
    "mappingVersion",
    "severityMapping.mappingVersion",
    issues,
  );
  const fallback = requireMember(
    table,
    "fallback",
    "severityMapping.fallback",
    NORMALIZED_SEVERITIES,
    issues,
  );
  const caseInsensitive = requireBoolean(
    table,
    "caseInsensitive",
    "severityMapping.caseInsensitive",
    issues,
  );
  const ruleTables = optionalRecordArray(table, "rules", "severityMapping.rules", issues) ?? [];
  const rules: SeverityMappingRuleV1[] = [];
  for (const [index, rule] of ruleTables.entries()) {
    const path = `severityMapping.rules[${String(index)}]`;
    const from = requireString(rule, "from", `${path}.from`, issues);
    const to = requireMember<NormalizedSeverity>(
      rule,
      "to",
      `${path}.to`,
      NORMALIZED_SEVERITIES,
      issues,
    );
    if (from === undefined || to === undefined) {
      continue;
    }
    rules.push({ from, to });
  }
  if (mappingVersion === undefined || fallback === undefined || caseInsensitive === undefined) {
    return undefined;
  }
  return { mappingVersion, rules, fallback, caseInsensitive };
}

function readBinary(
  source: Record<string, unknown>,
  issues: IssueList,
): ExtensionBinaryInvocationV1 | undefined {
  const table = optionalRecord(source, "binary", "binary", issues);
  if (table === undefined) {
    return undefined;
  }
  const command = requireString(table, "command", "binary.command", issues);
  const versionArgs = requireStringArray(table, "versionArgs", "binary.versionArgs", issues);
  const versionPattern = requireString(table, "versionPattern", "binary.versionPattern", issues);
  const minVersion = optionalString(table, "minVersion", "binary.minVersion", issues);
  const analyzeArgs =
    table["analyzeArgs"] === undefined
      ? undefined
      : requireStringArray(table, "analyzeArgs", "binary.analyzeArgs", issues);
  if (command !== undefined && /[\s;|&><$`]/.test(command)) {
    // X4: Aufruf ausschliesslich als Argumentarray, nie ueber eine Shell. Ein
    // Kommando mit Shell-Metazeichen waere genau der Weg, den wir ausschliessen.
    issues.add(
      "binary.command",
      "command must be a bare program name; shell metacharacters are rejected (extensions.md X4)",
    );
  }
  if (versionPattern !== undefined) {
    try {
      // Eine Fanggruppe ist Pflicht: ohne sie kann `detect` keine Version lesen.
      if (new RegExp(versionPattern).exec("__probe__") === null && !versionPattern.includes("(")) {
        issues.add("binary.versionPattern", "version pattern must contain one capture group");
      }
    } catch (cause) {
      issues.add(
        "binary.versionPattern",
        `not a valid regular expression: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  if (command === undefined || versionArgs === undefined || versionPattern === undefined) {
    return undefined;
  }
  return {
    command,
    versionArgs,
    versionPattern,
    ...(minVersion === undefined ? {} : { minVersion }),
    ...(analyzeArgs === undefined ? {} : { analyzeArgs }),
  };
}

function readHealthcheck(
  source: Record<string, unknown>,
  issues: IssueList,
): ExtensionHealthcheckV1 | undefined {
  const table = requireRecord(source, "healthcheck", "container.healthcheck", issues);
  if (table === undefined) {
    return undefined;
  }
  const kind = requireMember(
    table,
    "kind",
    "container.healthcheck.kind",
    ["http", "command"] as const,
    issues,
  );
  const intervalMs = requireNumber(table, "intervalMs", "container.healthcheck.intervalMs", issues);
  const timeoutMs = requireNumber(table, "timeoutMs", "container.healthcheck.timeoutMs", issues);
  const retries = requireNumber(table, "retries", "container.healthcheck.retries", issues);
  const httpPath = optionalString(table, "httpPath", "container.healthcheck.httpPath", issues);
  const command = Array.isArray(table["command"])
    ? requireStringArray(table, "command", "container.healthcheck.command", issues)
    : undefined;
  if (kind === "http" && httpPath === undefined) {
    issues.add("container.healthcheck.httpPath", 'healthcheck kind "http" requires an httpPath');
  }
  if (kind === "command" && (command === undefined || command.length === 0)) {
    issues.add(
      "container.healthcheck.command",
      'healthcheck kind "command" requires a non-empty argument array',
    );
  }
  if (
    kind === undefined ||
    intervalMs === undefined ||
    timeoutMs === undefined ||
    retries === undefined
  ) {
    return undefined;
  }
  return {
    kind,
    intervalMs,
    timeoutMs,
    retries,
    ...(httpPath === undefined ? {} : { httpPath }),
    ...(command === undefined ? {} : { command }),
  };
}

/**
 * Prueft eine Image-Referenz gegen X6: Repositoryname, sonst nichts.
 *
 * Ein Doppelpunkt allein ist kein Beweis fuer ein Tag — in
 * `registry.example.invalid:5000/vendor/analyzer` gehoert er zum Registryport.
 * Deshalb wird die Referenz zuerst zerlegt: der erste Abschnitt vor `/` ist
 * eine Registry, wenn er einen Punkt oder Doppelpunkt enthaelt oder
 * `localhost` heisst. Erst im Rest sind `:` und `@` das, wofuer man sie haelt.
 *
 * Gibt die Begruendung zurueck oder `null`, wenn die Referenz zulaessig ist.
 */
function imageReferenceProblem(image: string): string | null {
  const slash = image.indexOf("/");
  const first = slash === -1 ? "" : image.slice(0, slash);
  const isRegistry = first === "localhost" || first.includes(".") || first.includes(":");
  const path = isRegistry ? image.slice(slash + 1) : image;
  if (path === "") {
    return "image must name a repository after the registry (extensions.md X6)";
  }
  if (path.includes("@")) {
    return (
      "image must not embed a digest; the pin belongs in container.digest so it stays " +
      "one checked value (extensions.md X6)"
    );
  }
  if (path.includes(":")) {
    return "image must be the repository name without a tag; the digest pins the version (extensions.md X6)";
  }
  if (first.includes("@")) {
    return "image must not embed a digest; the pin belongs in container.digest (extensions.md X6)";
  }
  return null;
}

function readContainer(
  source: Record<string, unknown>,
  issues: IssueList,
): ExtensionContainerInvocationV1 | undefined {
  const table = optionalRecord(source, "container", "container", issues);
  if (table === undefined) {
    return undefined;
  }
  const image = requireString(table, "image", "container.image", issues);
  const digest = requireString(table, "digest", "container.digest", issues);
  if (image !== undefined) {
    const problem = imageReferenceProblem(image);
    if (problem !== null) {
      issues.add("container.image", problem);
    }
  }

  const ports: ExtensionContainerPortV1[] = [];
  for (const [index, entry] of (
    optionalRecordArray(table, "ports", "container.ports", issues) ?? []
  ).entries()) {
    const path = `container.ports[${String(index)}]`;
    const name = requireString(entry, "name", `${path}.name`, issues);
    const containerPort = requireNumber(entry, "containerPort", `${path}.containerPort`, issues);
    const hostPortDefault = requireNumber(
      entry,
      "hostPortDefault",
      `${path}.hostPortDefault`,
      issues,
    );
    if (name === undefined || containerPort === undefined || hostPortDefault === undefined) {
      continue;
    }
    ports.push({ name, containerPort, hostPortDefault });
  }

  const volumes: ExtensionContainerVolumeV1[] = [];
  for (const [index, entry] of (
    optionalRecordArray(table, "volumes", "container.volumes", issues) ?? []
  ).entries()) {
    const path = `container.volumes[${String(index)}]`;
    const name = requireString(entry, "name", `${path}.name`, issues);
    const mountPath = requireString(entry, "mountPath", `${path}.mountPath`, issues);
    const readOnly = requireBoolean(entry, "readOnly", `${path}.readOnly`, issues);
    if (name === undefined || mountPath === undefined || readOnly === undefined) {
      continue;
    }
    volumes.push({ name, mountPath, readOnly });
  }

  const analyzeArgs =
    table["analyzeArgs"] === undefined
      ? undefined
      : requireStringArray(table, "analyzeArgs", "container.analyzeArgs", issues);
  const mountTable = requireRecord(table, "workspaceMount", "container.workspaceMount", issues);
  const healthcheck = readHealthcheck(table, issues);
  const environmentTable = optionalRecord(table, "environment", "container.environment", issues);
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(environmentTable ?? {})) {
    if (typeof value !== "string") {
      issues.add(`container.environment.${key}`, `expected a string, got ${describe(value)}`);
      continue;
    }
    environment[key] = value;
  }

  if (image === undefined || digest === undefined || mountTable === undefined) {
    return undefined;
  }
  const mountPath = requireString(
    mountTable,
    "mountPath",
    "container.workspaceMount.mountPath",
    issues,
  );
  const readOnly = requireBoolean(
    mountTable,
    "readOnly",
    "container.workspaceMount.readOnly",
    issues,
  );
  const writableReason = optionalString(
    mountTable,
    "writableReason",
    "container.workspaceMount.writableReason",
    issues,
  );
  if (mountPath === undefined || readOnly === undefined || healthcheck === undefined) {
    return undefined;
  }
  return {
    image,
    digest,
    ports,
    volumes,
    workspaceMount: {
      mountPath,
      readOnly,
      ...(writableReason === undefined ? {} : { writableReason }),
    },
    healthcheck,
    ...(environmentTable === undefined ? {} : { environment }),
    ...(analyzeArgs === undefined ? {} : { analyzeArgs }),
  };
}

function readHttp(
  source: Record<string, unknown>,
  issues: IssueList,
): ExtensionHttpInvocationV1 | undefined {
  const table = optionalRecord(source, "http", "http", issues);
  if (table === undefined) {
    return undefined;
  }
  const defaultUrl = optionalString(table, "defaultUrl", "http.defaultUrl", issues);
  const authSecretName = optionalString(table, "authSecretName", "http.authSecretName", issues);
  const analyzePath = optionalString(table, "analyzePath", "http.analyzePath", issues);
  const analyzeMethod = optionalString(table, "analyzeMethod", "http.analyzeMethod", issues);
  return {
    ...(defaultUrl === undefined ? {} : { defaultUrl }),
    ...(authSecretName === undefined ? {} : { authSecretName }),
    ...(analyzePath === undefined ? {} : { analyzePath }),
    ...(analyzeMethod === undefined ? {} : { analyzeMethod }),
  };
}

function readPreprocess(
  source: Record<string, unknown>,
  issues: IssueList,
  field = "preprocess",
): ExtensionPreprocessV1 | undefined {
  const table = optionalRecord(source, field, field, issues);
  if (table === undefined) {
    return undefined;
  }
  const command = requireString(table, "command", `${field}.command`, issues);
  const args = requireStringArray(table, "args", `${field}.args`, issues);
  if (command !== undefined && /[\s;|&><$`]/.test(command)) {
    issues.add(
      `${field}.command`,
      "command must be a bare program name; shell metacharacters are rejected (extensions.md X4)",
    );
  }
  if (command === undefined || args === undefined) {
    return undefined;
  }
  return { command, args };
}

/**
 * Liest `[outputMapping]` — die deklarative Lesehilfe der `generic-*`-Formate.
 *
 * Sie steht im Manifest und nicht im Quelltext: ein Werkzeug mit eigener
 * Ausgabeform darf keinen neuen Zweig in Untangle erzeugen (X9). Bis Welle 11
 * war der Weg zwar im Parser vorhanden, aber von keinem Manifest aus
 * erreichbar — die Lesehilfe existierte nur fuer Aufrufer aus dem Quelltext.
 */
function readOutputMapping(
  source: Record<string, unknown>,
  issues: IssueList,
): ExtensionOutputMappingV1 | undefined {
  const table = optionalRecord(source, "outputMapping", "outputMapping", issues);
  if (table === undefined) {
    return undefined;
  }
  const shape =
    table["shape"] === undefined
      ? undefined
      : requireMember(
          table,
          "shape",
          "outputMapping.shape",
          ["entries", "flat-object"] as const,
          issues,
        );
  const mapping: ExtensionOutputMappingV1 = {
    ...(shape === undefined ? {} : { shape }),
  };
  for (const field of [
    "container",
    "key",
    "value",
    "unit",
    "path",
    "severity",
    "message",
    "ruleId",
  ] as const) {
    if (table[field] === undefined) {
      continue;
    }
    const read = optionalString(table, field, `outputMapping.${field}`, issues);
    if (read !== undefined) {
      mapping[field] = read;
    }
  }
  return mapping;
}

/**
 * Liest `[[complexitySignals]]` — was ein Ausgabeschluessel BEDEUTET.
 *
 * Die Pruefung der geschlossenen Mengen und die Sperre gegen `comparableTo`
 * bei einem herstellereigenen Mischwert liegen in `@untangle-code/domain`,
 * damit es genau eine Wahrheit gibt; hier steht nur die Formpruefung.
 */
function readComplexitySignals(
  source: Record<string, unknown>,
  issues: IssueList,
): ExtensionComplexitySignalV1[] | undefined {
  const entries = optionalRecordArray(source, "complexitySignals", "complexitySignals", issues);
  if (entries === undefined) {
    return undefined;
  }
  const signals: ExtensionComplexitySignalV1[] = [];
  for (const [index, entry] of entries.entries()) {
    const path = `complexitySignals[${String(index)}]`;
    const key = requireString(entry, "key", `${path}.key`, issues);
    const kind = requireString(entry, "kind", `${path}.kind`, issues);
    const scope = requireString(entry, "scope", `${path}.scope`, issues);
    const comparableTo = optionalString(entry, "comparableTo", `${path}.comparableTo`, issues);
    if (key === undefined || kind === undefined || scope === undefined) {
      continue;
    }
    signals.push({
      key,
      kind: kind as ExtensionComplexitySignalV1["kind"],
      scope: scope as ExtensionComplexitySignalV1["scope"],
      ...(comparableTo === undefined ? {} : { comparableTo }),
    });
  }
  return signals;
}

function readRulesetSources(
  source: Record<string, unknown>,
  issues: IssueList,
): ExtensionRulesetSourceV1[] | undefined {
  const entries = optionalRecordArray(source, "rulesetSources", "rulesetSources", issues);
  if (entries === undefined) {
    return undefined;
  }
  const sources: ExtensionRulesetSourceV1[] = [];
  for (const [index, entry] of entries.entries()) {
    const path = `rulesetSources[${String(index)}]`;
    const ruleset = requireString(entry, "ruleset", `${path}.ruleset`, issues);
    const origin = requireMember(
      entry,
      "source",
      `${path}.source`,
      ["registry", "bundled", "local"] as const,
      issues,
    );
    const license = requireString(entry, "license", `${path}.license`, issues);
    const usageRestriction = requireMember(
      entry,
      "usageRestriction",
      `${path}.usageRestriction`,
      ["none", "restricted"] as const,
      issues,
    );
    const restrictionSummary = optionalString(
      entry,
      "restrictionSummary",
      `${path}.restrictionSummary`,
      issues,
    );
    if (
      ruleset === undefined ||
      origin === undefined ||
      license === undefined ||
      usageRestriction === undefined
    ) {
      continue;
    }
    if (usageRestriction === "restricted" && restrictionSummary === undefined) {
      issues.add(
        `${path}.restrictionSummary`,
        "a restricted ruleset requires a restrictionSummary (extensions.md §9.5)",
      );
    }
    sources.push({
      ruleset,
      source: origin,
      license,
      usageRestriction,
      ...(restrictionSummary === undefined ? {} : { restrictionSummary }),
    });
  }
  return sources;
}

/**
 * Liest ein Manifest aus TOML-Text und prueft es strukturell UND semantisch.
 *
 * Ein Manifest gilt nur als gueltig, wenn `issues` leer ist. Das ist Absicht:
 * ein halb gelesenes Manifest beschreibt einen Prozessstart, und ein
 * Prozessstart auf Verdacht ist genau das, was X1 und X4 ausschliessen.
 */
export function parseExtensionManifest(tomlText: string): ManifestParseResultV1 {
  const issues = new IssueList();
  let document: unknown;
  try {
    document = parseToml(tomlText) as unknown;
  } catch (cause) {
    const detail =
      cause instanceof TomlError || cause instanceof Error ? cause.message : String(cause);
    return {
      manifest: null,
      issues: [{ field: "", message: `manifest is not valid TOML: ${detail}` }],
    };
  }
  if (!isRecord(document)) {
    return { manifest: null, issues: [{ field: "", message: "manifest is not a TOML table" }] };
  }

  const schemaVersion = document["schemaVersion"];
  if (schemaVersion !== 1) {
    issues.add("schemaVersion", `expected 1, got ${describe(schemaVersion)}`);
  }
  const id = requireString(document, "id", "id", issues);
  const displayName = requireString(document, "displayName", "displayName", issues);
  const category = requireMember<ExtensionCategory>(
    document,
    "category",
    "category",
    EXTENSION_CATEGORIES,
    issues,
  );
  const invocationRaw = requireStringArray(document, "invocation", "invocation", issues);
  const invocation: ExtensionInvocationMode[] = [];
  for (const [index, mode] of (invocationRaw ?? []).entries()) {
    if (!(EXTENSION_INVOCATION_MODES as readonly string[]).includes(mode)) {
      issues.add(
        `invocation[${String(index)}]`,
        `expected one of ${EXTENSION_INVOCATION_MODES.join(" | ")}, got "${mode}"`,
      );
      continue;
    }
    invocation.push(mode as ExtensionInvocationMode);
  }
  const outputFormat = requireMember<ExtensionOutputFormat>(
    document,
    "outputFormat",
    "outputFormat",
    EXTENSION_OUTPUT_FORMATS,
    issues,
  );
  const networkAccess = requireMember(
    document,
    "networkAccess",
    "networkAccess",
    ["none", "loopback", "internet"] as const,
    issues,
  );
  const networkJustification = optionalString(
    document,
    "networkJustification",
    "networkJustification",
    issues,
  );
  const languages = requireStringArray(document, "languages", "languages", issues);
  const requiresLicenseAcknowledgment = requireBoolean(
    document,
    "requiresLicenseAcknowledgment",
    "requiresLicenseAcknowledgment",
    issues,
  );
  const defaultRuleset = optionalString(document, "defaultRuleset", "defaultRuleset", issues);

  const resources = readResources(document, issues);
  const license = readLicense(document, issues);
  const telemetry = readTelemetry(document, issues);
  const secrets = readSecrets(document, issues);
  const severityMapping = readSeverityMapping(document, issues);
  const binary = readBinary(document, issues);
  const container = readContainer(document, issues);
  const http = readHttp(document, issues);
  const preprocess = readPreprocess(document, issues);
  const setup = readPreprocess(document, issues, "setup");
  const rulesetSources = readRulesetSources(document, issues);
  const outputMapping = readOutputMapping(document, issues);
  const complexitySignals = readComplexitySignals(document, issues);

  if (
    id === undefined ||
    displayName === undefined ||
    category === undefined ||
    outputFormat === undefined ||
    networkAccess === undefined ||
    languages === undefined ||
    requiresLicenseAcknowledgment === undefined ||
    resources === undefined ||
    license === undefined ||
    telemetry === undefined ||
    secrets === undefined
  ) {
    return { manifest: null, issues: issues.issues };
  }

  const manifest: ExtensionManifestV1 = {
    schemaVersion: 1,
    id,
    displayName,
    category,
    invocation,
    ...(binary === undefined ? {} : { binary }),
    ...(container === undefined ? {} : { container }),
    ...(http === undefined ? {} : { http }),
    ...(preprocess === undefined ? {} : { preprocess }),
    ...(setup === undefined ? {} : { setup }),
    resources,
    languages,
    license,
    requiresLicenseAcknowledgment,
    secrets,
    ...(defaultRuleset === undefined ? {} : { defaultRuleset }),
    ...(rulesetSources === undefined ? {} : { rulesetSources }),
    outputFormat,
    ...(severityMapping === undefined ? {} : { severityMapping }),
    ...(outputMapping === undefined ? {} : { outputMapping }),
    ...(complexitySignals === undefined ? {} : { complexitySignals }),
    networkAccess,
    ...(networkJustification === undefined ? {} : { networkJustification }),
    telemetry,
  };

  // Semantische Kopplungen aus `@untangle-code/domain` — nicht hier
  // nachgebaut, damit es genau eine Wahrheit gibt.
  issues.issues.push(...validateExtensionManifest(manifest));

  if (issues.issues.length > 0) {
    return { manifest: null, issues: issues.issues };
  }
  return { manifest, issues: [] };
}
