/**
 * Fehlerkonstruktion der Extension-Laufzeit (extensions.md §6.8).
 *
 * Alle fuenf Codes stehen bereits im gemeinsamen `ERROR_CODES`-Enum von
 * `@untangle-code/domain`; hier stehen nur die Konstruktoren, damit
 * `retryable` und `details.reason` nicht an jeder Aufrufstelle neu erfunden
 * werden.
 *
 * X2 — eine fehlende Extension ist NIE ein Fehler des Kerns. Die Codes
 * beschreiben eine SICHTBARE Degradation: der Aufrufer einer Leseoperation
 * fuehrt die Extension in `extensionsUnavailable[]` und arbeitet weiter
 * (spec.md §25.2). Nur ein ausdrueckliches `extensions run` macht daraus
 * einen Abbruch.
 */
import { UntangleError } from "@untangle-code/domain";

/** Ursachen eines gescheiterten Laufs (`details.reason`, extensions.md §6.4–§6.5). */
export const EXTENSION_FAILURE_REASONS = [
  "exit_status",
  "memory_limit_exceeded",
  "output_parse_failed",
  "output_too_large",
  "process_error",
  "http_error",
  "digest_mismatch",
] as const;

export type ExtensionFailureReason = (typeof EXTENSION_FAILURE_REASONS)[number];

/** Die Extension ist nicht auffindbar, nicht startbar oder dauerhaft rot. */
export function extensionUnavailable(
  extensionId: string,
  detail: string,
  context: Record<string, unknown> = {},
): UntangleError {
  return new UntangleError(
    "EXTENSION_UNAVAILABLE",
    `extension "${extensionId}" is unavailable: ${detail}`,
    { retryable: true, operation: "extensions", context: { extensionId, detail, ...context } },
  );
}

/** Der Lauf startete, scheiterte aber; `reason` unterscheidet die Ursache. */
export function extensionFailed(
  extensionId: string,
  reason: ExtensionFailureReason,
  detail: string,
  context: Record<string, unknown> = {},
): UntangleError {
  return new UntangleError(
    "EXTENSION_FAILED",
    `extension "${extensionId}" failed (${reason}): ${detail}`,
    {
      // Ein Ausgabefehler wiederholt sich; ein Prozessfehler kann verschwinden.
      retryable: reason === "process_error" || reason === "http_error",
      operation: "extensions",
      context: { extensionId, reason, detail, ...context },
    },
  );
}

/** Das Zeitbudget des Laufs wurde ueberschritten (extensions.md §10.2). */
export function extensionTimeout(
  extensionId: string,
  timeoutMs: number,
  context: Record<string, unknown> = {},
): UntangleError {
  return new UntangleError(
    "EXTENSION_TIMEOUT",
    `extension "${extensionId}" exceeded its time budget of ${String(timeoutMs)} ms`,
    { retryable: true, operation: "extensions", context: { extensionId, timeoutMs, ...context } },
  );
}

/** Lizenz- oder Regelsatz-Gate nicht bestaetigt (X5, extensions.md §9). */
export function extensionLicenseUnacknowledged(
  extensionId: string,
  detail: string,
  /** Der exakte Befehl, der die Bestaetigung erteilen wuerde (extensions.md §9.5). */
  acknowledgeCommand: string,
  context: Record<string, unknown> = {},
): UntangleError {
  return new UntangleError(
    "EXTENSION_LICENSE_UNACKNOWLEDGED",
    `extension "${extensionId}" is not acknowledged: ${detail}. Run: ${acknowledgeCommand}`,
    {
      retryable: false,
      operation: "extensions",
      context: { extensionId, detail, acknowledgeCommand, ...context },
    },
  );
}

/** Der laufende Container traegt einen anderen Digest als das Manifest (X6). */
export function extensionImageMismatch(
  extensionId: string,
  expectedDigest: string,
  actualDigest: string,
): UntangleError {
  return new UntangleError(
    "EXTENSION_IMAGE_MISMATCH",
    `extension "${extensionId}" runs image digest ${actualDigest}, manifest pins ${expectedDigest}`,
    {
      retryable: false,
      operation: "extensions",
      context: { extensionId, expectedDigest, actualDigest },
    },
  );
}
