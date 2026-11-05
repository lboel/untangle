/**
 * Lizenz-Gate und Regelsatz-Gate (extensions.md §9, X5).
 *
 * Warum es das gibt: Untangle darf niemanden unwissentlich in eine
 * Lizenzverletzung laufen lassen. Werkzeuge mit einschraenkenden
 * Nutzungsbedingungen — und Regelsaetze unter fremder Lizenz — verlangen eine
 * ausdrueckliche, persoenliche Bestaetigung, BEVOR das erste Mal etwas
 * gestartet oder heruntergeladen wird.
 *
 * Zwei Gates, getrennt (extensions.md §9.5):
 * - das WERKZEUG-Gate aus `manifest.license`;
 * - das REGELSATZ-Gate je verwendetem Regelsatz. Es greift auch dann, wenn
 *   das Werkzeug selbst unbeschraenkt ist. Rein lokale Regeldateien loesen
 *   KEIN Gate aus: die stellt der Nutzer selbst bereit.
 *
 * Speicherort der Bestaetigung ist das NUTZER-Datenverzeichnis, nie das
 * Projekt (§9.2). Eine gleichnamige Datei im Projekt wird nie gelesen und als
 * Warnung gemeldet — sie waere sonst committet und wuerde eine persoenliche
 * Erklaerung an das ganze Team vererben.
 */
import { join } from "node:path";

import type { ExtensionManifestV1, FileSystemPort } from "@untangle-code/domain";
import { compareCodepoints, sha256Hex } from "@untangle-code/domain";

import type { LoadedExtensionV1 } from "./manifest/load.js";
import { isProjectLocalManifest } from "./paths.js";

/** Dateiname der Bestaetigungsdatei (extensions.md §9.2). */
export const ACKNOWLEDGMENT_FILE_NAME = "license-acknowledgments.json";

/** Gate-Status je Werkzeug bzw. je Regelsatz (extensions.md §5.5, §9.3). */
export const LICENSE_GATE_STATUSES = [
  "not_required",
  "acknowledged",
  "unacknowledged",
  "revoked",
] as const;

export type LicenseGateStatus = (typeof LICENSE_GATE_STATUSES)[number];

/** Eine persistierte Bestaetigung (extensions.md §9.2). */
export interface LicenseAcknowledgmentV1 {
  extensionId: string;
  /** Gesetzt, wenn die Bestaetigung einem REGELSATZ gilt (§9.5). */
  ruleset?: string;
  spdxId: string;
  /** sha256 der `restrictionSummary` zum Zeitpunkt der Bestaetigung. */
  restrictionSummarySha256?: string;
  acknowledgedAt: string;
  /** OS-Benutzername — die Erklaerung ist persoenlich. */
  acknowledgedBy: string;
  /** Gesetzt nach `disable --revoke-license`; der Status wird `revoked`. */
  revokedAt?: string;
}

/** Inhalt der Bestaetigungsdatei. */
export interface LicenseAcknowledgmentFileV1 {
  schemaVersion: 1;
  acknowledgments: LicenseAcknowledgmentV1[];
}

/** Ergebnis eines Gates. */
export interface GateOutcomeV1 {
  status: LicenseGateStatus;
  /** Warum der Status so ist — auch bei `acknowledged` lesbar. */
  reason: string;
  /** Der exakte Befehl, der die Bestaetigung erteilen wuerde (§9.5). */
  acknowledgeCommand?: string;
}

/** Gesamtentscheidung ueber Werkzeug- und Regelsatz-Gate. */
export interface LicenseGateDecisionV1 {
  extensionId: string;
  tool: GateOutcomeV1;
  rulesets: (GateOutcomeV1 & { ruleset: string })[];
  /** True, wenn ein Start zulaessig ist. */
  allowed: boolean;
  /** Alle offenen Bestaetigungsbefehle, deterministisch sortiert. */
  acknowledgeCommands: string[];
}

export interface LicenseGateInput {
  extension: LoadedExtensionV1;
  acknowledgments: readonly LicenseAcknowledgmentV1[];
  /** Effektiver Regelsatz des Laufs (Instanzkonfiguration oder `defaultRuleset`). */
  ruleset?: string;
  /**
   * Rein lokale Regeldateien. Sind sie gesetzt und ist KEIN Registry-Regelsatz
   * im Spiel, entfaellt das Regelsatz-Gate (extensions.md §9.5).
   */
  localRulesetPaths?: readonly string[];
}

/** Pfad der Bestaetigungsdatei im Nutzer-Datenverzeichnis. */
export function acknowledgmentFilePath(userDataDirectory: string): string {
  return join(userDataDirectory, "extensions", ACKNOWLEDGMENT_FILE_NAME);
}

function matchesTool(entry: LicenseAcknowledgmentV1, extensionId: string): boolean {
  return entry.extensionId === extensionId && entry.ruleset === undefined;
}

/** Wertet das WERKZEUG-Gate aus (extensions.md §9.1–§9.3). */
function evaluateToolGate(
  manifest: ExtensionManifestV1,
  restrictionSummarySha256: string | undefined,
  acknowledgments: readonly LicenseAcknowledgmentV1[],
): GateOutcomeV1 {
  const command = `untangle extensions enable ${manifest.id} --acknowledge-license`;
  if (!manifest.requiresLicenseAcknowledgment && manifest.license.usageRestriction === "none") {
    return {
      status: "not_required",
      reason: `license ${manifest.license.spdxId} carries no usage restriction`,
    };
  }
  const entry = acknowledgments.find((candidate) => matchesTool(candidate, manifest.id));
  if (entry === undefined) {
    return {
      status: "unacknowledged",
      reason: `license ${manifest.license.spdxId} requires an explicit acknowledgment before the first run`,
      acknowledgeCommand: command,
    };
  }
  if (entry.revokedAt !== undefined) {
    return {
      status: "revoked",
      reason: `acknowledgment was revoked at ${entry.revokedAt}`,
      acknowledgeCommand: command,
    };
  }
  if (entry.spdxId !== manifest.license.spdxId) {
    return {
      status: "unacknowledged",
      reason: `acknowledgment covers license "${entry.spdxId}", the manifest now declares "${manifest.license.spdxId}"`,
      acknowledgeCommand: command,
    };
  }
  if (entry.restrictionSummarySha256 !== restrictionSummarySha256) {
    // §9.2: aendert sich `restrictionSummary`, verfaellt die Bestaetigung.
    return {
      status: "unacknowledged",
      reason: "the manifest's restrictionSummary changed since the acknowledgment was given",
      acknowledgeCommand: command,
    };
  }
  return { status: "acknowledged", reason: `acknowledged at ${entry.acknowledgedAt}` };
}

/** Wertet das REGELSATZ-Gate aus (extensions.md §9.5). */
function evaluateRulesetGate(
  manifest: ExtensionManifestV1,
  ruleset: string,
  acknowledgments: readonly LicenseAcknowledgmentV1[],
): GateOutcomeV1 & { ruleset: string } {
  const command = `untangle extensions enable ${manifest.id} --acknowledge-ruleset ${ruleset}`;
  const declared = (manifest.rulesetSources ?? []).find((source) => source.ruleset === ruleset);
  if (declared !== undefined && declared.source === "local") {
    return {
      ruleset,
      status: "not_required",
      reason: "local rule files are provided by the user; no gate applies",
    };
  }
  if (declared !== undefined && declared.usageRestriction === "none") {
    return {
      ruleset,
      status: "not_required",
      reason: `ruleset license ${declared.license} carries no usage restriction`,
    };
  }
  const entry = acknowledgments.find(
    (candidate) => candidate.extensionId === manifest.id && candidate.ruleset === ruleset,
  );
  const undeclaredNote =
    declared === undefined
      ? " (the ruleset is not declared in rulesetSources and is therefore treated as restricted)"
      : "";
  if (entry === undefined) {
    return {
      ruleset,
      status: "unacknowledged",
      reason: `ruleset "${ruleset}" requires an explicit acknowledgment${undeclaredNote}`,
      acknowledgeCommand: command,
    };
  }
  if (entry.revokedAt !== undefined) {
    return {
      ruleset,
      status: "revoked",
      reason: `ruleset acknowledgment was revoked at ${entry.revokedAt}`,
      acknowledgeCommand: command,
    };
  }
  const declaredLicense = declared?.license;
  if (declaredLicense !== undefined && entry.spdxId !== declaredLicense) {
    // §9.5: aendert sich die Lizenz eines Regelsatzes, verfaellt die Bestaetigung.
    return {
      ruleset,
      status: "unacknowledged",
      reason: `acknowledgment covers ruleset license "${entry.spdxId}", the manifest now declares "${declaredLicense}"`,
      acknowledgeCommand: command,
    };
  }
  return { ruleset, status: "acknowledged", reason: `acknowledged at ${entry.acknowledgedAt}` };
}

/**
 * Wertet beide Gates aus. Reine Funktion: kein I/O, keine Uhr — die
 * Bestaetigungen kommen als Daten herein.
 */
export function evaluateLicenseGate(input: LicenseGateInput): LicenseGateDecisionV1 {
  const manifest = input.extension.manifest;
  const tool = evaluateToolGate(
    manifest,
    input.extension.restrictionSummarySha256,
    input.acknowledgments,
  );

  const rulesets: (GateOutcomeV1 & { ruleset: string })[] = [];
  const effectiveRuleset = input.ruleset ?? manifest.defaultRuleset;
  const onlyLocalRules = (input.localRulesetPaths ?? []).length > 0 && input.ruleset === undefined;
  if (effectiveRuleset !== undefined && !onlyLocalRules) {
    rulesets.push(evaluateRulesetGate(manifest, effectiveRuleset, input.acknowledgments));
  }

  const open = [tool, ...rulesets].filter(
    (outcome) => outcome.status === "unacknowledged" || outcome.status === "revoked",
  );
  const commands = [
    ...new Set(
      open
        .map((outcome) => outcome.acknowledgeCommand)
        .filter((command): command is string => command !== undefined),
    ),
  ].sort(compareCodepoints);

  return {
    extensionId: manifest.id,
    tool,
    rulesets,
    allowed: open.length === 0,
    acknowledgeCommands: commands,
  };
}

/** Ergebnis des Ladens der Bestaetigungsdatei. */
export interface LoadedAcknowledgmentsV1 {
  acknowledgments: LicenseAcknowledgmentV1[];
  /** Sichtbare Hinweise: ignorierte Projektdatei, kaputte Datei (E4). */
  warnings: string[];
}

function readAcknowledgmentEntry(value: unknown): LicenseAcknowledgmentV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const extensionId = record["extensionId"];
  const spdxId = record["spdxId"];
  const acknowledgedAt = record["acknowledgedAt"];
  const acknowledgedBy = record["acknowledgedBy"];
  if (
    typeof extensionId !== "string" ||
    typeof spdxId !== "string" ||
    typeof acknowledgedAt !== "string" ||
    typeof acknowledgedBy !== "string"
  ) {
    return null;
  }
  const ruleset = record["ruleset"];
  const hash = record["restrictionSummarySha256"];
  const revokedAt = record["revokedAt"];
  return {
    extensionId,
    ...(typeof ruleset === "string" ? { ruleset } : {}),
    spdxId,
    ...(typeof hash === "string" ? { restrictionSummarySha256: hash } : {}),
    acknowledgedAt,
    acknowledgedBy,
    ...(typeof revokedAt === "string" ? { revokedAt } : {}),
  };
}

/**
 * Liest die Bestaetigungen aus dem NUTZER-Datenverzeichnis.
 *
 * `projectRoots` dient nur der Kontrolle: liegt der uebergebene Pfad in einem
 * Projekt, wird NICHT gelesen, sondern gewarnt (extensions.md §9.2). Eine
 * fehlende Datei ist kein Fehler — sie bedeutet „noch nichts bestaetigt".
 */
export async function loadLicenseAcknowledgments(
  fs: FileSystemPort,
  options: {
    userDataDirectory: string;
    projectRoots?: readonly string[];
    signal?: AbortSignal;
  },
): Promise<LoadedAcknowledgmentsV1> {
  const path = acknowledgmentFilePath(options.userDataDirectory);
  const warnings: string[] = [];
  if (isProjectLocalManifest(path, options.projectRoots ?? [])) {
    return {
      acknowledgments: [],
      warnings: [
        `ignored "${path}": license acknowledgments are never read from a project directory ` +
          "(extensions.md §9.2) — they are a personal declaration, not shareable project state",
      ],
    };
  }

  let text: string;
  try {
    text = await fs.readTextFile(
      path,
      options.signal === undefined ? {} : { signal: options.signal },
    );
  } catch {
    // Keine Datei = nichts bestaetigt. Das ist ein gueltiger Zustand.
    return { acknowledgments: [], warnings };
  }

  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (cause) {
    return {
      acknowledgments: [],
      warnings: [
        `"${path}" is not valid JSON (${cause instanceof Error ? cause.message : String(cause)}); ` +
          "every gate is treated as unacknowledged until the file is repaired",
      ],
    };
  }
  const rawEntries =
    typeof document === "object" && document !== null && !Array.isArray(document)
      ? (document as Record<string, unknown>)["acknowledgments"]
      : undefined;
  if (!Array.isArray(rawEntries)) {
    return {
      acknowledgments: [],
      warnings: [
        `"${path}" has no "acknowledgments" array; every gate is treated as unacknowledged`,
      ],
    };
  }

  const acknowledgments: LicenseAcknowledgmentV1[] = [];
  for (const [index, entry] of rawEntries.entries()) {
    const parsed = readAcknowledgmentEntry(entry);
    if (parsed === null) {
      // E4: ein unlesbarer Eintrag verschwindet nicht, er wird gemeldet.
      warnings.push(
        `acknowledgment entry ${String(index)} in "${path}" is malformed and was not applied`,
      );
      continue;
    }
    acknowledgments.push(parsed);
  }
  return { acknowledgments, warnings };
}

/**
 * Baut einen Bestaetigungseintrag. `acknowledgedAt` kommt vom Clock-Port des
 * Aufrufers — diese Funktion ruft keine Uhr auf.
 */
export function buildAcknowledgment(input: {
  manifest: ExtensionManifestV1;
  ruleset?: string;
  acknowledgedAt: string;
  acknowledgedBy: string;
}): LicenseAcknowledgmentV1 {
  const rulesetLicense =
    input.ruleset === undefined
      ? undefined
      : (input.manifest.rulesetSources ?? []).find((source) => source.ruleset === input.ruleset);
  const summary = input.manifest.license.restrictionSummary;
  return {
    extensionId: input.manifest.id,
    ...(input.ruleset === undefined ? {} : { ruleset: input.ruleset }),
    spdxId: rulesetLicense?.license ?? input.manifest.license.spdxId,
    ...(input.ruleset === undefined && summary !== undefined
      ? { restrictionSummarySha256: sha256Hex(summary) }
      : {}),
    acknowledgedAt: input.acknowledgedAt,
    acknowledgedBy: input.acknowledgedBy,
  };
}
