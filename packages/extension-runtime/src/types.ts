/**
 * Laufzeitvertraege der Extension-Laufzeit (extensions.md §5.4, §5.5).
 *
 * Abweichung von §5.4, gedeckt durch X9 (§17, das Abschnitt 5 ausdruecklich
 * korrigiert): statt `adapterVersion` — ein Adapter JE WERKZEUG, dessen Name
 * einen Produktnamen truege — steht hier `formatParserVersion` plus
 * `runtimeVersion`. Untangle kennt Formate, nicht Werkzeuge (E2).
 */
import type {
  ExtensionInvocationMode,
  ExtensionOutputFormat,
  NormalizedSeverity,
} from "@untangle-code/domain";

/** Wie ein Lauf geendet ist (extensions.md §5.4). */
export const EXTENSION_RUN_EXIT_STATUSES = ["completed", "failed", "timeout", "cancelled"] as const;

export type ExtensionRunExitStatus = (typeof EXTENSION_RUN_EXIT_STATUSES)[number];

/** Eine vom Werkzeug oder von der Laufzeit uebersprungene Datei MIT Grund (E4). */
export interface ExtensionSkippedFileV1 {
  filePath: string;
  reason: string;
}

/** Ein Lauf einer Extension (extensions.md §5.4). */
export interface ExtensionRunV1 {
  schemaVersion: 1;
  runId: string;
  extensionId: string;
  /** Version der Extension-Laufzeit (ersetzt `adapterVersion`, X9). */
  runtimeVersion: string;
  /** Version des benutzten Formatparsers (ersetzt `adapterVersion`, X9). */
  formatParserVersion: string;
  outputFormat: ExtensionOutputFormat;
  toolVersion: string;
  imageDigest?: string;
  invocation?: ExtensionInvocationMode;

  ruleset?: string;
  rulesetVersion?: string;
  /** sha256 ueber den aufgeloesten Regelinhalt (extensions.md §5.4). */
  rulesetHash?: string;
  /**
   * True, wenn weder `rulesetHash` noch `rulesetVersion` bestimmbar waren.
   * Ein solcher Lauf DARF NICHT Vergleichsbasis der Change-Analyse sein
   * (extensions.md §9.2, Nachtrag) — sonst waeren Regelaenderungen von
   * Codeaenderungen nicht mehr unterscheidbar.
   */
  comparabilityLimited?: boolean;
  /** Pflicht, wenn `comparabilityLimited` true ist (E4). */
  comparabilityNote?: string;

  workspaceId: string;
  repoIds: string[];
  refIds: string[];
  projectIds?: string[];
  /** Generation, gegen die normalisiert wurde (extensions.md §10.3). */
  indexGenerationId?: string;

  startedAt: string;
  finishedAt?: string;
  exitStatus: ExtensionRunExitStatus;
  /** Fehlerklasse aus extensions.md §6.8, wenn nicht `completed`. */
  errorCode?: string;

  filesAnalyzed: number;
  /** Jede uebersprungene Datei MIT Grund; leeres Array heisst „nichts uebersprungen". */
  filesSkipped: ExtensionSkippedFileV1[];

  findingCounts: Record<NormalizedSeverity, number>;
  findingsTotal: number;

  resources: {
    wallTimeMs: number;
    maxMemoryMb?: number;
    cpuTimeMs?: number;
  };

  errors: { code: string; message: string }[];
  warnings: string[];
}

/** Zustand einer Extension (extensions.md §5.5). */
export interface ExtensionHealthV1 {
  schemaVersion: 1;
  extensionId: string;
  checkedAt: string;

  available: boolean;
  effectiveInvocation?: ExtensionInvocationMode;
  /** Geheimnisse sind redigiert (extensions.md §8.5). */
  endpoint?: string;
  binaryPath?: string;
  toolVersion?: string;

  imageDigest?: string;
  /** False ⇒ `EXTENSION_IMAGE_MISMATCH` beim Lauf (X6). */
  digestMatchesManifest?: boolean;

  licenseGate: "not_required" | "acknowledged" | "unacknowledged" | "revoked";

  lastSuccessfulRunAt?: string;
  lastError?: { code: string; message: string; at: string };
  /**
   * Warum welcher Aufrufmodus nicht verfuegbar war. Ohne diese Liste waere
   * „nicht verfuegbar" eine Behauptung ohne Beleg (E4).
   */
  unavailableReasons: { invocation: ExtensionInvocationMode; detail: string }[];
}

/** Leere Severity-Zaehlung; alle fuenf Stufen sind immer vorhanden. */
export function emptyFindingCounts(): Record<NormalizedSeverity, number> {
  return { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
}
