/**
 * Persisted user-level state for the extension surface.
 *
 * Two files, both in the OS user data directory and never in a project
 * directory (extensions.md §9.2):
 *
 * - `license-acknowledgments.json` — the personal declarations that satisfy
 *   the license gate. Read by the runtime, written here.
 * - `cli-state.json` — which extensions the user enabled, and a summary of
 *   the last run per extension, so `list` can answer "status, last run"
 *   without re-running anything.
 *
 * Both are written temp-then-rename. A half-written acknowledgment file would
 * read back as "nothing acknowledged", which is safe, but a half-written run
 * record would silently lose the previous one.
 */
import { dirname, join } from "node:path";

import type { FileSystemPort } from "@untangle-code/domain";
import { compareCodepoints } from "@untangle-code/domain";
import {
  ACKNOWLEDGMENT_FILE_NAME,
  acknowledgmentFilePath,
  type ExtensionRunV1,
  type LicenseAcknowledgmentFileV1,
  type LicenseAcknowledgmentV1,
} from "@untangle-code/extension-runtime";

/** File name of the CLI's own state, next to the acknowledgment file. */
export const CLI_STATE_FILE_NAME = "cli-state.json";

/** Summary of one finished run — enough for `list`, not a substitute for it. */
export interface LastRunRecordV1 {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  exitStatus: ExtensionRunV1["exitStatus"];
  findingsTotal: number;
  errorCode?: string;
}

export interface CliStateV1 {
  schemaVersion: 1;
  /** Extension ids the user enabled (X1: enabling starts nothing). */
  enabled: string[];
  lastRuns: Record<string, LastRunRecordV1>;
}

export function summarizeRun(run: ExtensionRunV1): LastRunRecordV1 {
  return {
    runId: run.runId,
    startedAt: run.startedAt,
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    exitStatus: run.exitStatus,
    findingsTotal: run.findingsTotal,
    ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
  };
}

export function emptyCliState(): CliStateV1 {
  return { schemaVersion: 1, enabled: [], lastRuns: {} };
}

export function cliStatePath(userDataDirectory: string): string {
  return join(userDataDirectory, "extensions", CLI_STATE_FILE_NAME);
}

/** Result of reading a state file: the state plus anything unreadable (E4). */
export interface LoadedCliStateV1 {
  state: CliStateV1;
  warnings: string[];
}

/**
 * Reads the CLI state. A missing file means "nothing enabled, nothing run" —
 * a valid starting state, not an error. A corrupt file is reported and
 * treated as empty rather than crashing the command (X2).
 */
export async function loadCliState(
  fs: FileSystemPort,
  userDataDirectory: string,
): Promise<LoadedCliStateV1> {
  const path = cliStatePath(userDataDirectory);
  let text: string;
  try {
    text = await fs.readTextFile(path);
  } catch {
    return { state: emptyCliState(), warnings: [] };
  }
  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (cause) {
    return {
      state: emptyCliState(),
      warnings: [
        `"${path}" is not valid JSON (${cause instanceof Error ? cause.message : String(cause)}); ` +
          "enabled flags and last-run records are shown as unknown until the file is repaired",
      ],
    };
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { state: emptyCliState(), warnings: [`"${path}" is not a JSON object; ignored`] };
  }
  const record = document as Record<string, unknown>;
  const enabled = Array.isArray(record["enabled"])
    ? record["enabled"].filter((entry): entry is string => typeof entry === "string")
    : [];
  const lastRuns: Record<string, LastRunRecordV1> = {};
  const rawRuns = record["lastRuns"];
  if (typeof rawRuns === "object" && rawRuns !== null && !Array.isArray(rawRuns)) {
    for (const [id, value] of Object.entries(rawRuns as Record<string, unknown>)) {
      const parsed = readLastRun(value);
      if (parsed !== null) {
        lastRuns[id] = parsed;
      }
    }
  }
  return {
    state: { schemaVersion: 1, enabled: [...enabled].sort(compareCodepoints), lastRuns },
    warnings: [],
  };
}

function readLastRun(value: unknown): LastRunRecordV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const runId = record["runId"];
  const startedAt = record["startedAt"];
  const exitStatus = record["exitStatus"];
  const findingsTotal = record["findingsTotal"];
  if (
    typeof runId !== "string" ||
    typeof startedAt !== "string" ||
    typeof exitStatus !== "string"
  ) {
    return null;
  }
  const finishedAt = record["finishedAt"];
  const errorCode = record["errorCode"];
  return {
    runId,
    startedAt,
    exitStatus: exitStatus as ExtensionRunV1["exitStatus"],
    findingsTotal: typeof findingsTotal === "number" ? findingsTotal : 0,
    ...(typeof finishedAt === "string" ? { finishedAt } : {}),
    ...(typeof errorCode === "string" ? { errorCode } : {}),
  };
}

export async function saveCliState(
  fs: FileSystemPort,
  userDataDirectory: string,
  state: CliStateV1,
): Promise<string> {
  const path = cliStatePath(userDataDirectory);
  const ordered: CliStateV1 = {
    schemaVersion: 1,
    enabled: [...state.enabled].sort(compareCodepoints),
    lastRuns: Object.fromEntries(
      Object.entries(state.lastRuns).sort(([left], [right]) => compareCodepoints(left, right)),
    ),
  };
  await writeJsonAtomic(fs, path, ordered);
  return path;
}

/** Where acknowledgments are written; re-exported so callers need one import. */
export function acknowledgmentPath(userDataDirectory: string): string {
  return acknowledgmentFilePath(userDataDirectory);
}

export { ACKNOWLEDGMENT_FILE_NAME };

/**
 * Writes the acknowledgment file. Entries are ordered by
 * `(extensionId, ruleset)` via codepoint comparison so the file has one
 * canonical form — a diff between two machines shows real changes only.
 */
export async function saveAcknowledgments(
  fs: FileSystemPort,
  userDataDirectory: string,
  acknowledgments: readonly LicenseAcknowledgmentV1[],
): Promise<string> {
  const path = acknowledgmentFilePath(userDataDirectory);
  const document: LicenseAcknowledgmentFileV1 = {
    schemaVersion: 1,
    acknowledgments: [...acknowledgments].sort(
      (left, right) =>
        compareCodepoints(left.extensionId, right.extensionId) ||
        compareCodepoints(left.ruleset ?? "", right.ruleset ?? ""),
    ),
  };
  await writeJsonAtomic(fs, path, document);
  return path;
}

/**
 * Replaces the entry for one `(extensionId, ruleset)` pair, keeping the rest.
 * A repeated acknowledgment updates in place instead of stacking duplicates.
 */
export function upsertAcknowledgment(
  existing: readonly LicenseAcknowledgmentV1[],
  entry: LicenseAcknowledgmentV1,
): LicenseAcknowledgmentV1[] {
  const kept = existing.filter(
    (candidate) =>
      candidate.extensionId !== entry.extensionId ||
      (candidate.ruleset ?? "") !== (entry.ruleset ?? ""),
  );
  return [...kept, entry];
}

/**
 * Marks every acknowledgment for one extension as withdrawn (§9.3).
 *
 * The entry is kept and stamped with `revokedAt` rather than deleted. Both
 * shapes refuse the run, so this is not about safety — it is about what the
 * user can be told afterwards. A deleted row makes "you never acknowledged
 * this" and "you acknowledged this and took it back" indistinguishable, and
 * §9.3 asks `status` to be able to show the gate status `revoked`, which a
 * deleted row can never produce.
 */
export function revokeAcknowledgments(
  existing: readonly LicenseAcknowledgmentV1[],
  extensionId: string,
  revokedAt: string,
): LicenseAcknowledgmentV1[] {
  return existing.map((candidate) =>
    candidate.extensionId === extensionId && candidate.revokedAt === undefined
      ? { ...candidate, revokedAt }
      : candidate,
  );
}

/** Drops every acknowledgment for one extension — used when it is uninstalled. */
export function removeAcknowledgments(
  existing: readonly LicenseAcknowledgmentV1[],
  extensionId: string,
): LicenseAcknowledgmentV1[] {
  return existing.filter((candidate) => candidate.extensionId !== extensionId);
}

async function writeJsonAtomic(fs: FileSystemPort, path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  const bytes = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  await fs.writeFile(temporary, bytes);
  await fs.rename(temporary, path);
}
