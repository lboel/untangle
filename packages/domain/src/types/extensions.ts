/**
 * Externe Befunde und Extension-Manifeste (extensions.md §3 X3, §5, §17 X9).
 *
 * Zwei Entscheidungen bestimmen dieses Modul:
 *
 * X3 — Externe Befunde sind NIEMALS Untangle-Metriken. Das ist hier
 * STRUKTURELL durchgesetzt, nicht nur kommentiert: externe Zahlenwerte sind
 * {@link ExternalNumberV1}-Objekte und damit an keiner Stelle einsetzbar, an
 * der eine Untangle-Metrik (`number`) erwartet wird — weder in
 * `ComplexitySnapshotV1` noch in `ComplexitySummaryV1`, `MetricContribution`
 * oder `RiskScoreV1`. Der Uebergang ist nur ueber die Anzeigefunktion
 * {@link formatExternalNumber} vorgesehen; eine Entpackfunktion nach `number`
 * gibt es bewusst nicht. {@link assertUntangleMetricNumber} sichert die
 * Aggregationspfade zusaetzlich zur Laufzeit ab.
 *
 * X9 — Untangle kennt AUSGABEFORMATE, nicht Werkzeuge. Deshalb steht in
 * {@link ExtensionManifestV1} ein `outputFormat` aus einer geschlossenen Menge
 * statt einer werkzeugspezifischen Kennung, und im Quelltext dieses Repositorys
 * steht kein einziger Werkzeugname (E2). Welches Werkzeug ein Manifest
 * beschreibt, ist ausschliesslich Inhalt der Nutzerdaten.
 */
import type { SourceRange } from "./common.js";
import { isProseNumber } from "./prose.js";

// ---------------------------------------------------------------------------
// Externe Zahlenwerte (X3, strukturell)
// ---------------------------------------------------------------------------

declare const EXTERNAL_VALUE_BRAND: unique symbol;

/**
 * Ein Zahlenwert aus einem externen Werkzeug.
 *
 * Bewusst ein OBJEKT, kein `number`: damit ist er an keiner Stelle einsetzbar,
 * an der Untangle eine eigene Metrik erwartet. Der Rohwert bleibt in `value`
 * sichtbar, damit nichts verloren geht (E4) — aber er verlaesst diesen Typ
 * nicht als blanke Zahl.
 */
export interface ExternalNumberV1 {
  /** Laufzeitmarker; unterscheidet den Wert von einem gewoehnlichen Objekt. */
  readonly externalMeasurement: true;
  /** Rohwert wie vom Werkzeug geliefert. */
  readonly value: number;
  /** Einheit laut Werkzeug, z. B. "percent", "count". */
  readonly unit?: string;
  /** Nur zur Uebersetzungszeit vorhanden; nie serialisiert. */
  readonly [EXTERNAL_VALUE_BRAND]?: "external";
}

/** Erzeugt einen externen Zahlenwert; lehnt nicht-endliche Zahlen ab. */
export function makeExternalNumber(value: number, unit?: string): ExternalNumberV1 {
  if (!Number.isFinite(value)) {
    throw new Error(`external measurement must be a finite number, got ${String(value)}`);
  }
  return { externalMeasurement: true, value, ...(unit === undefined ? {} : { unit }) };
}

/** Typwaechter fuer {@link ExternalNumberV1} (auch fuer JSON aus fremder Quelle). */
export function isExternalNumber(value: unknown): value is ExternalNumberV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { externalMeasurement?: unknown }).externalMeasurement === true &&
    typeof (value as { value?: unknown }).value === "number"
  );
}

/**
 * Anzeigeform eines externen Werts. Der EINZIGE vorgesehene Weg aus dem
 * externen Zahlenraum — und er fuehrt in einen String, nicht in eine Metrik.
 */
export function formatExternalNumber(value: ExternalNumberV1): string {
  return value.unit === undefined ? String(value.value) : `${String(value.value)} ${value.unit}`;
}

/**
 * Waechter fuer Untangle-Metrikpfade: gibt `value` als `number` zurueck, wenn
 * es eine gewoehnliche endliche Zahl ist, und wirft, wenn jemand einen
 * externen Wert in eine Untangle-Metrik schieben will (X3).
 */
export function assertUntangleMetricNumber(value: unknown, label: string): number {
  if (isExternalNumber(value)) {
    throw new Error(
      `"${label}" received an external measurement; external findings are evidence, never Untangle metrics (extensions.md X3)`,
    );
  }
  // Dieselbe Trennung nach der anderen Seite (vision.md §1c, WP-217): ein
  // Prosa-Messwert ist keine Code-Metrik. Ohne diese Zeile koennte eine
  // Verweisdichte in eine cognitive-Summe wandern, sobald irgendwo `unknown`
  // durchgereicht wird.
  if (isProseNumber(value)) {
    throw new Error(
      `"${label}" received a prose measurement; prose metrics are their own family and never mix with code metrics (vision.md §1c)`,
    );
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`"${label}" must be a finite number, got ${String(value)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Gemeinsame Basistypen (extensions.md §5.1)
// ---------------------------------------------------------------------------

/** Normalisierte Severity externer Befunde (extensions.md §7.3). */
export const NORMALIZED_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

export type NormalizedSeverity = (typeof NORMALIZED_SEVERITIES)[number];

/** Kategorie einer Extension (extensions.md §5.1). */
export const EXTENSION_CATEGORIES = [
  "sast",
  "lint",
  "complexity",
  "dependencies",
  "sbom",
  "quality-platform",
] as const;

export type ExtensionCategory = (typeof EXTENSION_CATEGORIES)[number];

/** Aufrufart einer Extension (extensions.md §5.1, X4). */
export const EXTENSION_INVOCATION_MODES = ["binary", "container", "http"] as const;

export type ExtensionInvocationMode = (typeof EXTENSION_INVOCATION_MODES)[number];

/**
 * Geschlossene Menge der verstandenen AUSGABEFORMATE (X9).
 *
 * Untangle implementiert Parser fuer genau diese Formate. Ein Werkzeug ohne
 * Standardformat bringt im Manifest einen Vorschaltbefehl mit, der seine
 * Ausgabe nach `generic-findings` oder `generic-metrics` bringt — das ist
 * Sache des Extension-Autors, nicht dieses Repositorys.
 */
export const EXTENSION_OUTPUT_FORMATS = [
  "sarif",
  "junit-xml",
  "generic-findings",
  "generic-metrics",
] as const;

export type ExtensionOutputFormat = (typeof EXTENSION_OUTPUT_FORMATS)[number];

/** Eine Abbildungsregel Werkzeug-Severity → Untangle-Severity. */
export interface SeverityMappingRuleV1 {
  /** Wert des Werkzeugs, unveraendert, z. B. "BLOCKER" oder "warning". */
  from: string;
  to: NormalizedSeverity;
}

/**
 * Deklarative Severity-Abbildung. `fallback` ist Pflicht: ein unbekannter
 * Werkzeugwert darf weder raten noch verschwinden.
 */
export interface SeverityMappingV1 {
  /** Version der Abbildung, z. B. `SEVERITY_MAP_VERSION`. */
  mappingVersion: string;
  rules: SeverityMappingRuleV1[];
  fallback: NormalizedSeverity;
  /** True, wenn beim Vergleich Gross-/Kleinschreibung ignoriert wird. */
  caseInsensitive: boolean;
}

/**
 * Wendet die deklarative Abbildung an. `matched: false` heisst: es griff der
 * Fallback — der Aufrufer MUSS das sichtbar machen (E4), etwa als
 * Skip-Ledger-Eintrag oder Warnung.
 */
export function resolveNormalizedSeverity(
  mapping: SeverityMappingV1,
  originalSeverity: string,
): { normalized: NormalizedSeverity; matched: boolean } {
  const needle = mapping.caseInsensitive ? originalSeverity.toLowerCase() : originalSeverity;
  for (const rule of mapping.rules) {
    const candidate = mapping.caseInsensitive ? rule.from.toLowerCase() : rule.from;
    if (candidate === needle) {
      return { normalized: rule.to, matched: true };
    }
  }
  return { normalized: mapping.fallback, matched: false };
}

/**
 * Herkunft eines externen Befundes (extensions.md §5.1).
 *
 * Abweichung von §5.1 nach X9: statt `adapterVersion` (ein Adapter JE WERKZEUG,
 * dessen Name einen Produktnamen enthielte) traegt die Provenienz die Version
 * des FORMATPARSERS. Welche Extension den Lauf ausgeloest hat, steht in
 * `extensionId` — ein Wert aus den Nutzerdaten, nicht aus dem Quelltext.
 */
export interface ExtensionProvenanceV1 {
  extensionId: string;
  /** Version des benutzten Formatparsers, z. B. "untangle-format-sarif-v1". */
  formatParserVersion: string;
  outputFormat: ExtensionOutputFormat;
  toolVersion: string;
  /** Bei Container-Aufrufen gesetzt: der tatsaechlich laufende Digest (X6). */
  imageDigest?: string;
  invocation: ExtensionInvocationMode;
  /** Zeiger in die Rohausgabe (Pfad oder JSON-Pointer). */
  rawLocation?: string;
}

// ---------------------------------------------------------------------------
// Manifest (extensions.md §5.2, korrigiert durch X9)
// ---------------------------------------------------------------------------

/** Aufruf als eigenstaendiges Programm (Argumentarray, niemals Shell). */
export interface ExtensionBinaryInvocationV1 {
  /** Programmname, ueber PATH aufgeloest; nie ein Shell-String. */
  command: string;
  /** Argumente zur Versionsabfrage, z. B. ["--version"]. */
  versionArgs: string[];
  /** Regulaerer Ausdruck mit genau einer Fanggruppe fuer die Version. */
  versionPattern: string;
  minVersion?: string;
  /**
   * Argumente des ANALYSELAUFS (additiv ergaenzt, damit ein Manifest nicht nur
   * sagt, wie die Version gelesen wird, sondern auch „rufe so auf" — X9).
   * Wie `versionArgs` ein Argumentarray, niemals ein Shell-String (X4).
   * Platzhalter loest die Laufzeit auf; ihre Menge ist geschlossen und
   * dokumentiert.
   */
  analyzeArgs?: string[];
}

/** Portfreigabe eines Containers (nur Loopback, extensions.md §8.1). */
export interface ExtensionContainerPortV1 {
  name: string;
  containerPort: number;
  hostPortDefault: number;
}

/** Benanntes Volume eines Containers. */
export interface ExtensionContainerVolumeV1 {
  name: string;
  mountPath: string;
  readOnly: boolean;
}

/** Healthcheck eines Containers. */
export interface ExtensionHealthcheckV1 {
  kind: "http" | "command";
  /** Bei `kind: "http"`: Pfad gegen den Loopback-Port. */
  httpPath?: string;
  /** Bei `kind: "command"`: Argumentarray im Container. */
  command?: string[];
  intervalMs: number;
  timeoutMs: number;
  retries: number;
}

/** Aufruf als Container (extensions.md §5.2). */
export interface ExtensionContainerInvocationV1 {
  /** Repositoryname OHNE Tag. */
  image: string;
  /** Vollstaendig gepinnter Digest "sha256:…" (X6). */
  digest: string;
  ports: ExtensionContainerPortV1[];
  volumes: ExtensionContainerVolumeV1[];
  workspaceMount: {
    mountPath: string;
    /** MUSS true sein, ausser es gibt einen dokumentierten Grund. */
    readOnly: boolean;
    /** Pflicht, wenn `readOnly` false ist. */
    writableReason?: string;
  };
  healthcheck: ExtensionHealthcheckV1;
  /** Statische, geheimnisfreie Umgebung. */
  environment?: Record<string, string>;
  /** Argumente des Analyselaufs im Container (additiv, siehe `ExtensionBinaryInvocationV1`). */
  analyzeArgs?: string[];
}

/** Aufruf gegen eine bereits laufende HTTP-API. */
export interface ExtensionHttpInvocationV1 {
  defaultUrl?: string;
  /** Verweist auf einen Eintrag in `secrets`. */
  authSecretName?: string;
  /** Pfad des Analyseaufrufs relativ zu `defaultUrl` (additiv, siehe `analyzeArgs`). */
  analyzePath?: string;
  /** HTTP-Methode des Analyseaufrufs; Vorgabe "GET" (additiv). */
  analyzeMethod?: string;
}

/** Ressourcenbedarf, vor der Bereitstellung angezeigt (extensions.md §10.1). */
export interface ExtensionResourcesV1 {
  minMemoryMb: number;
  recommendedMemoryMb: number;
  recommendedCpus: number;
  typicalStartupSeconds?: number;
}

/** Lizenzangabe des Werkzeugs (X5). */
export interface ExtensionLicenseV1 {
  /** SPDX-Kennung, oder "NOASSERTION". */
  spdxId: string;
  usageRestriction: "none" | "restricted";
  /** Pflicht bei `usageRestriction: "restricted"`. */
  restrictionSummary?: string;
  url?: string;
}

/** Geheimnisreferenz; Werte stehen NIE im Manifest. */
export interface ExtensionSecretV1 {
  name: string;
  envVar: string;
  required: boolean;
  purpose: string;
  /** Only passed to the explicit setup process, never to the analyzer. */
  setupOnly?: boolean;
}

/** Herkunft und Lizenz EINES Regelsatzes (extensions.md §9.5). */
export interface ExtensionRulesetSourceV1 {
  ruleset: string;
  source: "registry" | "bundled" | "local";
  license: string;
  usageRestriction: "none" | "restricted";
  restrictionSummary?: string;
}

/** Telemetrieverhalten des Werkzeugs (extensions.md §8.7). */
export interface ExtensionTelemetryV1 {
  sendsTelemetry: boolean;
  /** Flag/Env/Konfigschluessel, den die Laufzeit setzt. */
  disableMechanism?: string;
  /** MUSS true sein, wenn `disableMechanism` existiert. */
  disabledByDefault: boolean;
}

/**
 * Vorschaltbefehl fuer Werkzeuge ohne Standardformat (X9). Bringt die Ausgabe
 * nach `generic-findings`/`generic-metrics`; ebenfalls Argumentarray, nie Shell.
 */
export interface ExtensionPreprocessV1 {
  command: string;
  args: string[];
}

// ---------------------------------------------------------------------------
// Complexity-Signale (extensions.md X3, X8)
// ---------------------------------------------------------------------------

/**
 * Die geschlossene Menge der Bedeutungen, die ein externer Kennwert haben
 * kann.
 *
 * Ohne sie ist ein Messwert ein Schluessel und eine Zahl — `quality_signal`
 * ist 0,45 und `cognitive_complexity` ist 4284, und nichts im System weiss,
 * dass das eine ein herstellereigener Mischwert und das andere dieselbe
 * Groesse ist, die Untangle selbst berechnet. Genau diese Unwissenheit macht
 * den Fehler moeglich, den X3 verbietet: zwei Zahlen nebeneinanderzustellen,
 * die nicht dasselbe messen.
 *
 * `proprietary-composite` ist der ehrliche Platz fuer alles, was ein
 * Hersteller aus mehreren Groessen zusammenrechnet. Ein solcher Wert ist
 * Evidenz ueber die Zeit — er DARF nie gegen eine Untangle-Zahl verglichen
 * werden, weil niemand ausserhalb des Herstellers seine Formel kennt.
 */
export const EXTERNAL_COMPLEXITY_SIGNAL_KINDS = [
  "cognitive",
  "cyclomatic",
  "sloc",
  "duplication",
  "dependency-cycles",
  "dependency-depth",
  "proprietary-composite",
] as const;

export type ExternalComplexitySignalKind = (typeof EXTERNAL_COMPLEXITY_SIGNAL_KINDS)[number];

/** Die Bezugsgroesse einer Messung. Ein Repo-Wert und ein Symbolwert sind nie dasselbe. */
export const EXTERNAL_SIGNAL_SCOPES = ["repository", "file", "symbol"] as const;

export type ExternalSignalScope = (typeof EXTERNAL_SIGNAL_SCOPES)[number];

/**
 * Die Bedeutung, die ein Manifest einem Ausgabeschluessel zuweist.
 *
 * `comparableTo` ist die einzige Tuer, durch die eine fremde Zahl je in die
 * Naehe einer eigenen kommt — und sie ist nur fuer Groessen offen, die
 * definiert dasselbe messen. Fuer `proprietary-composite` bleibt sie
 * verschlossen; das erzwingt {@link validateExtensionManifest}.
 */
export interface ExtensionComplexitySignalV1 {
  /** Ausgabeschluessel des Werkzeugs, unveraendert. */
  key: string;
  kind: ExternalComplexitySignalKind;
  scope: ExternalSignalScope;
  /**
   * Metrikversion, gegen die eine Gegenprobe zulaessig ist (X8), z. B.
   * `"untangle-metrics-v1"`. Fehlt sie, ist der Wert reine Evidenz.
   */
  comparableTo?: string;
}

/** Die Kinds, fuer die eine Gegenprobe ueberhaupt denkbar ist. */
export const COMPARABLE_COMPLEXITY_SIGNAL_KINDS: readonly ExternalComplexitySignalKind[] = [
  "cognitive",
  "cyclomatic",
  "sloc",
  "duplication",
  "dependency-cycles",
  "dependency-depth",
];

/**
 * Existing producers for untangle-metrics-v1, not planned metrics.
 * Cognitive/cyclomatic: calculators and CLI aggregate; SLOC: computeStructural
 * on file/symbol facts; cycles/depth: file-graph queries. No repository SLOC
 * aggregate or native duplication metric exists.
 */
export const UNTANGLE_COMPARABLE_SIGNAL_SCOPES: Readonly<
  Record<ExternalComplexitySignalKind, readonly ExternalSignalScope[]>
> = {
  cognitive: ["repository", "file", "symbol"],
  cyclomatic: ["repository", "file", "symbol"],
  sloc: ["file", "symbol"],
  duplication: [],
  "dependency-cycles": ["repository", "file"],
  "dependency-depth": ["repository", "file"],
  "proprietary-composite": [],
};

/**
 * Deklarative Lesehilfe fuer die `generic-*`-Formate.
 *
 * Steht im Manifest, nicht im Quelltext: ein neues Werkzeug mit eigener
 * Ausgabeform darf keinen neuen Zweig in Untangle erzeugen (X9).
 */
export interface ExtensionOutputMappingV1 {
  /** `entries` (Default) oder `flat-object`. */
  shape?: "entries" | "flat-object";
  /** Punktpfad zur Eintragsliste, wenn sie nicht auf oberster Ebene liegt. */
  container?: string;
  key?: string;
  value?: string;
  unit?: string;
  path?: string;
  severity?: string;
  message?: string;
  ruleId?: string;
}

/**
 * Deklarative Beschreibung eines externen Werkzeugs. Reine Daten — es laeuft
 * kein fremder Code im Untangle-Prozess (X4).
 *
 * Abweichungen von extensions.md §5.2, beide durch X9 (§17) gedeckt, das
 * Abschnitt 5 ausdruecklich korrigiert:
 * 1. `outputFormat` ist eine geschlossene Menge statt einer werkzeugeigenen
 *    Formatkennung.
 * 2. `adapterVersion` entfaellt — es gibt keine Adapter je Werkzeug mehr; die
 *    Version des Formatparsers steht in {@link ExtensionProvenanceV1}.
 * Neu hinzugekommen sind `severityMapping` (die Abbildung wird deklariert,
 * nicht im Quelltext je Werkzeug programmiert) und `preprocess`.
 */
export interface ExtensionManifestV1 {
  schemaVersion: 1;
  /** Kleingeschriebene Kennung; zugleich Verzeichnisname der Extension. */
  id: string;
  /** Anzeigename aus den Nutzerdaten. */
  displayName: string;
  category: ExtensionCategory;
  /** Bevorzugte Aufrufarten; die erste verfuegbare gewinnt (extensions.md §6.1). */
  invocation: ExtensionInvocationMode[];
  binary?: ExtensionBinaryInvocationV1;
  container?: ExtensionContainerInvocationV1;
  http?: ExtensionHttpInvocationV1;
  preprocess?: ExtensionPreprocessV1;
  /** External setup process; emits a secrets-v1 JSON object, never analyzer output. */
  setup?: ExtensionPreprocessV1;
  resources: ExtensionResourcesV1;
  /** Unterstuetzte Sprachen; leere Liste = sprachunabhaengig. */
  languages: string[];
  license: ExtensionLicenseV1;
  /** MUSS true sein, wenn `license.usageRestriction === "restricted"` (X5). */
  requiresLicenseAcknowledgment: boolean;
  secrets: ExtensionSecretV1[];
  defaultRuleset?: string;
  rulesetSources?: ExtensionRulesetSourceV1[];
  /** Format der Werkzeugausgabe aus der geschlossenen Menge (X9). */
  outputFormat: ExtensionOutputFormat;
  /** Deklarative Severity-Abbildung; Pflicht bei befundliefernden Formaten. */
  severityMapping?: SeverityMappingV1;
  /** Deklarative Lesehilfe fuer die `generic-*`-Formate. */
  outputMapping?: ExtensionOutputMappingV1;
  /** Bedeutung einzelner Ausgabeschluessel (X8); ohne Eintrag bleibt ein Wert namenlose Evidenz. */
  complexitySignals?: ExtensionComplexitySignalV1[];
  networkAccess: "none" | "loopback" | "internet";
  /** Pflicht, wenn `networkAccess !== "none"`. */
  networkJustification?: string;
  telemetry: ExtensionTelemetryV1;
}

// ---------------------------------------------------------------------------
// Befunde und Messwerte (extensions.md §5.3, X3)
// ---------------------------------------------------------------------------

/**
 * Ein Befund eines externen Werkzeugs — EVIDENZ, kein Untangle-Messwert (X3).
 *
 * `evidenceOnly` ist ein Pflichtfeld mit dem Literalwert `true`. Es macht die
 * Trennung strukturell: der Typ traegt seinen Status im eigenen Bauplan und
 * passt auf keine Untangle-Metrik- oder Qualitaetsverstoss-Form.
 */
export interface ExternalFindingV1 {
  schemaVersion: 1;
  /** Immer `true` — externe Befunde sind Evidenz, nie Untangle-Metriken. */
  evidenceOnly: true;
  /** Deterministische ID (`buildExternalFindingId`). */
  findingId: string;
  workspaceId: string;
  repoId: string;
  refId: string;
  /** Projekt im Monorepo, sofern aufloesbar. */
  projectId?: string;

  /** Fehlt NUR, wenn die Datei nicht Teil des Index ist. */
  fileId?: string;
  /** Pflicht, wenn `fileId` fehlt (E4). */
  fileIdMissingReason?: string;
  /** "/"-normalisierter, repo-relativer Pfad. */
  filePath: string;
  sourceRange: SourceRange;

  /** Umschliessendes Symbol, sofern aufloesbar (extensions.md §7.2). */
  symbolId?: string;
  symbolFqn?: string;
  symbolResolution: "symbol" | "file_only";
  /** Pflicht bei `file_only` (E4). */
  symbolResolutionNote?: string;

  /** Werkzeugkennung aus den Nutzerdaten (Extension-ID bzw. Werkzeugname). */
  tool: string;
  toolVersion: string;
  /** Regelkennung des Werkzeugs, unveraendert. */
  ruleId: string;
  ruleset?: string;
  rulesetVersion?: string;

  severity: {
    normalized: NormalizedSeverity;
    /** Unveraenderter Wert des Werkzeugs. */
    original: string;
    mappingVersion: string;
    /** False, wenn der Fallback der Abbildung griff (E4). */
    mappingMatched: boolean;
  };

  message: string;
  remediationHint?: string;

  confidence: {
    /** [0, 1]. */
    value: number;
    /** "tool", wenn das Werkzeug selbst eine Confidence liefert, sonst "mapped". */
    basis: "tool" | "mapped";
    /** Unveraenderter Wert des Werkzeugs. */
    original?: string;
  };
  /** True, wenn Regel oder Verfahren ihrer Natur nach heuristisch sind. */
  isHeuristic: boolean;

  /** ISO-8601 des Laufs (ueber den Clock-Port). */
  detectedAt: string;
  extensionRunId: string;
  provenance: ExtensionProvenanceV1;
}

/**
 * Ein Kennwert aus dem Format `generic-metrics`.
 *
 * Der Wert ist ein {@link ExternalNumberV1} und damit strukturell von jeder
 * Untangle-Metrik getrennt (X3). Misst ein Werkzeug dieselbe Groesse wie
 * Untangle, ist das eine GEGENPROBE in der Testsuite (X8) — kein zweiter
 * Anzeigewert neben der eigenen Zahl.
 */
export interface ExternalMeasurementV1 {
  schemaVersion: 1;
  /** Immer `true` — Evidenz, nie Untangle-Metrik. */
  evidenceOnly: true;
  workspaceId: string;
  repoId: string;
  refId: string;
  /** "/"-normalisierter, repo-relativer Pfad, sofern die Groesse dateibezogen ist. */
  filePath?: string;
  symbolId?: string;
  /** Schluessel wie vom Werkzeug geliefert, unveraendert. */
  key: string;
  /**
   * Bedeutung des Schluessels, sofern das Manifest sie deklariert hat. Fehlt
   * sie, bleibt der Wert eine Zahl mit Namen — brauchbar als Zeitreihe
   * desselben Werkzeugs, nie als Vergleich gegen eine Untangle-Groesse.
   */
  signal?: ExtensionComplexitySignalV1;
  value: ExternalNumberV1;
  extensionRunId: string;
  /** ISO-8601 des Laufs (ueber den Clock-Port). */
  measuredAt: string;
  provenance: ExtensionProvenanceV1;
}

// ---------------------------------------------------------------------------
// Manifestpruefung
// ---------------------------------------------------------------------------

/** Ein Befund der Manifestpruefung. */
export interface ExtensionManifestIssue {
  /** Feldpfad im Manifest, z. B. "container.digest". */
  field: string;
  message: string;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Prueft die Kopplungen des Manifests (extensions.md §5.2 „Anforderungen").
 *
 * Bewusst NICHT enthalten: die strukturelle JSON-Schema-Pruefung. Die liegt bei
 * `packages/config` + `schemas/` (Dateibesitz-Matrix, BUILD_PLAN §4). Hier
 * stehen ausschliesslich die semantischen Regeln, die kein JSON-Schema
 * ausdruecken kann.
 */
export function validateExtensionManifest(manifest: ExtensionManifestV1): ExtensionManifestIssue[] {
  const issues: ExtensionManifestIssue[] = [];

  if (!EXTENSION_ID_PATTERN.test(manifest.id)) {
    issues.push({
      field: "id",
      message: `extension id "${manifest.id}" must match ${EXTENSION_ID_PATTERN.source} — it is also a directory name`,
    });
  }
  if (manifest.invocation.length === 0) {
    issues.push({ field: "invocation", message: "at least one invocation mode is required" });
  }
  if (manifest.invocation.includes("binary") && manifest.binary === undefined) {
    issues.push({
      field: "binary",
      message: 'invocation lists "binary" but no binary block exists',
    });
  }
  if (manifest.invocation.includes("http") && manifest.http === undefined) {
    issues.push({ field: "http", message: 'invocation lists "http" but no http block exists' });
  }
  if (manifest.invocation.includes("container")) {
    if (manifest.container === undefined) {
      issues.push({
        field: "container",
        message: 'invocation lists "container" but no container block exists',
      });
    } else {
      if (!DIGEST_PATTERN.test(manifest.container.digest)) {
        issues.push({
          field: "container.digest",
          message: `image must be pinned to a complete sha256 digest (X6), got "${manifest.container.digest}"`,
        });
      }
      const mount = manifest.container.workspaceMount;
      if (!mount.readOnly && (mount.writableReason ?? "") === "") {
        issues.push({
          field: "container.workspaceMount.writableReason",
          message: "a writable workspace mount requires a documented reason",
        });
      }
    }
  }

  if (manifest.license.usageRestriction === "restricted") {
    if (!manifest.requiresLicenseAcknowledgment) {
      issues.push({
        field: "requiresLicenseAcknowledgment",
        message: "restricted usage requires requiresLicenseAcknowledgment = true (X5)",
      });
    }
    if ((manifest.license.restrictionSummary ?? "") === "") {
      issues.push({
        field: "license.restrictionSummary",
        message: "restricted usage requires a restrictionSummary",
      });
    }
  }

  if (manifest.networkAccess !== "none" && (manifest.networkJustification ?? "") === "") {
    issues.push({
      field: "networkJustification",
      message: `networkAccess "${manifest.networkAccess}" requires a justification`,
    });
  }

  if (
    manifest.telemetry.sendsTelemetry &&
    (manifest.telemetry.disableMechanism ?? "") !== "" &&
    !manifest.telemetry.disabledByDefault
  ) {
    issues.push({
      field: "telemetry.disabledByDefault",
      message: "a tool with a disable mechanism must have telemetry disabled by default",
    });
  }

  if (!(EXTENSION_OUTPUT_FORMATS as readonly string[]).includes(manifest.outputFormat)) {
    issues.push({
      field: "outputFormat",
      message: `unknown output format "${manifest.outputFormat}"; Untangle knows output formats, not tools (X9)`,
    });
  }

  const findingFormats: readonly ExtensionOutputFormat[] = ["sarif", "generic-findings"];
  if (findingFormats.includes(manifest.outputFormat) && manifest.severityMapping === undefined) {
    issues.push({
      field: "severityMapping",
      message: `output format "${manifest.outputFormat}" produces findings and therefore requires a severity mapping`,
    });
  }
  if (manifest.severityMapping !== undefined) {
    const mapping = manifest.severityMapping;
    if (mapping.mappingVersion.trim() === "") {
      issues.push({
        field: "severityMapping.mappingVersion",
        message: "severity mapping requires a version",
      });
    }
    const seen = new Set<string>();
    for (const rule of mapping.rules) {
      const key = mapping.caseInsensitive ? rule.from.toLowerCase() : rule.from;
      if (seen.has(key)) {
        issues.push({
          field: "severityMapping.rules",
          message: `duplicate severity mapping for "${rule.from}"`,
        });
      }
      seen.add(key);
    }
  }

  if (manifest.defaultRuleset !== undefined) {
    const declared = (manifest.rulesetSources ?? []).some(
      (source) => source.ruleset === manifest.defaultRuleset,
    );
    if (!declared) {
      issues.push({
        field: "rulesetSources",
        message: `defaultRuleset "${manifest.defaultRuleset}" is not declared in rulesetSources (extensions.md §9.5)`,
      });
    }
  }

  for (const [index, signal] of (manifest.complexitySignals ?? []).entries()) {
    const field = `complexitySignals[${String(index)}]`;
    if (signal.key.trim() === "") {
      issues.push({ field: `${field}.key`, message: "a signal needs the tool's output key" });
    }
    if (!(EXTERNAL_COMPLEXITY_SIGNAL_KINDS as readonly string[]).includes(signal.kind)) {
      issues.push({
        field: `${field}.kind`,
        message:
          `unknown signal kind "${signal.kind}"; Untangle understands ` +
          `${EXTERNAL_COMPLEXITY_SIGNAL_KINDS.join(" | ")}`,
      });
    }
    if (!(EXTERNAL_SIGNAL_SCOPES as readonly string[]).includes(signal.scope)) {
      issues.push({
        field: `${field}.scope`,
        message: `unknown scope "${signal.scope}"; expected ${EXTERNAL_SIGNAL_SCOPES.join(" | ")}`,
      });
    }
    if (
      signal.comparableTo !== undefined &&
      !COMPARABLE_COMPLEXITY_SIGNAL_KINDS.includes(signal.kind)
    ) {
      // Der tragende Satz dieses Vertrags. Ein herstellereigener Mischwert hat
      // keine offengelegte Formel; ihn gegen eine Untangle-Zahl zu stellen
      // waere kein Vergleich, sondern eine Behauptung ueber fremde Mathematik.
      issues.push({
        field: `${field}.comparableTo`,
        message:
          `signal kind "${signal.kind}" must not declare comparableTo: no one outside the ` +
          "vendor knows how the value is composed, so there is nothing to compare it against (X3, X8)",
      });
    }
  }
  for (const [index, signal] of (manifest.complexitySignals ?? []).entries()) {
    if (
      signal.comparableTo !== undefined &&
      COMPARABLE_COMPLEXITY_SIGNAL_KINDS.includes(signal.kind) &&
      (signal.comparableTo !== "untangle-metrics-v1" ||
        !UNTANGLE_COMPARABLE_SIGNAL_SCOPES[signal.kind].includes(signal.scope))
    ) {
      issues.push({
        field: `complexitySignals[${String(index)}].comparableTo`,
        message:
          `Untangle does not produce "${signal.kind}" at scope "${signal.scope}" ` +
          `for "${signal.comparableTo}"; remove comparableTo to keep this value as external evidence`,
      });
    }
  }
  if (
    manifest.setup !== undefined &&
    (manifest.http?.defaultUrl === undefined ||
      manifest.container === undefined ||
      manifest.http.authSecretName === undefined)
  ) {
    issues.push({
      field: "setup",
      message: "setup requires a managed container, an http.defaultUrl and an http.authSecretName",
    });
  }
  if (
    manifest.http?.authSecretName !== undefined &&
    manifest.secrets.some(
      (secret) => secret.name === manifest.http?.authSecretName && secret.setupOnly === true,
    )
  ) {
    issues.push({
      field: "http.authSecretName",
      message: "analyzer authentication must not reference a setupOnly secret",
    });
  }
  const signalKeys = new Set<string>();
  for (const signal of manifest.complexitySignals ?? []) {
    if (signalKeys.has(signal.key)) {
      issues.push({
        field: "complexitySignals",
        message: `duplicate signal declaration for output key "${signal.key}"`,
      });
    }
    signalKeys.add(signal.key);
  }

  if (
    manifest.outputMapping?.shape === "flat-object" &&
    manifest.outputFormat !== "generic-metrics"
  ) {
    issues.push({
      field: "outputMapping.shape",
      message: `shape "flat-object" only applies to generic-metrics, not to "${manifest.outputFormat}"`,
    });
  }

  if (manifest.http?.authSecretName !== undefined) {
    const named = manifest.secrets.some((secret) => secret.name === manifest.http?.authSecretName);
    if (!named) {
      // Ein Verweis ins Leere wuerde die Anfrage still ohne Authorization
      // hinausgehen lassen — und der 401 danach nennt die Ursache nicht.
      issues.push({
        field: "http.authSecretName",
        message: `"${manifest.http.authSecretName}" is not declared in secrets`,
      });
    }
  }

  const secretNames = new Set<string>();
  for (const secret of manifest.secrets) {
    if (secretNames.has(secret.name)) {
      issues.push({ field: "secrets", message: `duplicate secret name "${secret.name}"` });
    }
    secretNames.add(secret.name);
    if (secret.envVar.trim() === "") {
      issues.push({
        field: "secrets",
        message: `secret "${secret.name}" must reference an environment variable`,
      });
    }
  }

  return issues;
}
