/**
 * Der lokale Indexzustand: welches Einbettungsprofil welchen Repo/Ref-Index
 * gebaut hat.
 *
 * Seit Welle 9 ist das keine Singleton-Datei mehr. Eine physische
 * Repository-Wurzel kann mehrere konfigurierte Repo-IDs, Refs und
 * Einbettungsprofile tragen. Jeder dieser Zustaende liegt deshalb in einem
 * eigenen, aus seiner kanonischen Identitaet gehashten Datensatz. Ein
 * separater, generationsgebundener Pointer pro Repo/Ref bezeichnet das
 * Profil des letzten gestarteten Laufs fuer `--embedder=auto`.
 *
 * `index-state.json` bleibt als lesbarer Migrations-Fallback erhalten. Sobald
 * die Registry dieselbe logische Identitaet kennt, gewinnt jedoch immer ihr
 * Datensatz; der Singleton wird dann nicht ein zweites Mal ausgegeben.
 *
 * Alle Dateinamen entstehen ausschliesslich aus SHA-256-Hashes. Registry und
 * Datensaetze sind hart begrenzt. Korrupte, uebergrosse oder unbeschraenkte
 * Registry-Inhalte werden nicht teilweise als gesund behandelt.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Welcher Einbetter einen Index gebaut hat. */
export type EmbedderChoice = "service" | "offline";

/** Lifecycle persisted for query routing and index-completeness provenance. */
export type IndexStateOutcome = "running" | "completed" | "cancelled" | "failed";

/** Der Zustand eines indizierten Repositories. Reine Daten. */
export interface IndexStateV1 {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly repoId: string;
  readonly refId: string;
  readonly refName: string;
  /** `service` = der konfigurierte Dienst, `offline` = netzlos im Prozess. */
  readonly embedder: EmbedderChoice;
  readonly embeddingProfileId: string;
  readonly collection: string;
  /** Legacy Qdrant endpoint. Absent for embedded records. */
  readonly qdrantUrl?: string;
  readonly storageBackend?: "lancedb" | "qdrant";
  readonly storeUrl?: string;
  /** Generation des Indexlaufs; fehlt nur in vor Welle 9 geschriebenen Zuständen. */
  readonly generationId?: string;
  /** SHA-256 fingerprint of the complete confirmed file/content manifest. */
  readonly corpusRevisionFingerprint?: string;
  /** Completion time, indexing configuration and lexical format of this snapshot. */
  readonly indexedAt?: string;
  readonly indexConfigFingerprint?: string;
  readonly lexicalTokenizerVersion?: string;
  /** Ergebnis des Laufs, der diesen Zustand geschrieben hat. */
  readonly outcome: IndexStateOutcome;
}

/** Identitaet eines Registry-Datensatzes. Collection/URL duerfen sich aendern. */
export type IndexStateRecordIdentity = Pick<
  IndexStateV1,
  "workspaceId" | "repoId" | "refId" | "embeddingProfileId"
> &
  StorageStateIdentity;

/** Identitaet des aktuellen Profils eines Repo/Ref-Paares. */
interface StorageStateIdentity {
  readonly storageBackend?: "lancedb" | "qdrant";
  readonly storeUrl?: string;
}

export type IndexStateCurrentIdentity = Pick<IndexStateV1, "workspaceId" | "repoId" | "refId"> &
  StorageStateIdentity;

/**
 * Index-Report-Daten, aus denen der CLI-Adapter einen persistierbaren Zustand
 * ableitet. Ein Readiness-Fehler vor der Generation darf einen nutzbaren
 * Zustand nicht ueberschreiben. Ein spaeter Fehler muss ihn invalidieren.
 */
export type IndexStateAfterRunInput = Omit<IndexStateV1, "generationId" | "outcome"> & {
  readonly generationId: string | null;
  readonly outcome: Exclude<IndexStateOutcome, "running">;
};

export function indexStateAfterRun(input: IndexStateAfterRunInput): IndexStateV1 | null {
  const { generationId, corpusRevisionFingerprint, ...state } = input;
  if (state.outcome === "failed" && generationId === null) return null;
  return {
    ...state,
    ...(generationId === null ? {} : { generationId }),
    ...(state.outcome === "completed" && corpusRevisionFingerprint !== undefined
      ? { corpusRevisionFingerprint }
      : {}),
  };
}

/** Alter Singleton-Name unterhalb von `.untangle/`. Nur noch Lesefallback. */
export const INDEX_STATE_FILE = "index-state.json";
export const INDEX_STATE_REGISTRY_DIR = "index-states-v1";
export const INDEX_STATE_RECORDS_DIR = "records";
export const INDEX_STATE_CURRENT_DIR = "current";

/** Harte Ressourcenlimits fuer lokal kontrollierbare Registry-Lesevorgaenge. */
export const MAX_INDEX_STATE_FILE_BYTES = 64 * 1024;
export const MAX_INDEX_STATE_REGISTRY_ENTRIES = 512;
const MAX_INDEX_STATE_FIELD_LENGTH = 8 * 1024;

const HASH_FILE_PATTERN = /^[0-9a-f]{64}\.json$/u;
const TEMP_FILE_PATTERN = /^[0-9a-f]{64}\.json\.[0-9a-f-]{36}\.tmp$/u;
const READ_ONLY_NO_FOLLOW = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;

/** `<repoRoot>/.untangle` — dasselbe Verzeichnis, das `untangle index` anlegt. */
export function stateRootOf(repoRoot: string): string {
  return path.join(repoRoot, ".untangle");
}

/** Der alte Singleton-Pfad. Externe Hinweise und Migration duerfen ihn weiter nennen. */
export function indexStatePath(stateRoot: string): string {
  return path.join(stateRoot, INDEX_STATE_FILE);
}

export function indexStateRecordKey(identity: IndexStateRecordIdentity): string {
  return hashCanonical([
    "untangle-index-state-record-v1",
    identity.workspaceId,
    identity.repoId,
    identity.refId,
    identity.embeddingProfileId,
    ...storageIdentitySuffix(identity),
  ]);
}

export function indexStateCurrentKey(identity: IndexStateCurrentIdentity): string {
  return hashCanonical([
    "untangle-index-state-current-v1",
    identity.workspaceId,
    identity.repoId,
    identity.refId,
    ...storageIdentitySuffix(identity),
  ]);
}

/** Preserve old Qdrant keys; embedded paths get independent publication namespaces. */
function storageIdentitySuffix(identity: StorageStateIdentity): string[] {
  return identity.storageBackend === "lancedb" ? ["lancedb", identity.storeUrl ?? ""] : [];
}

/** Lock key shared by every profile publication for one repo/ref/backend pointer. */
export function indexStateLockKey(identity: IndexStateCurrentIdentity): string {
  return `index-state:${indexStateCurrentKey(identity)}`;
}

export function indexStateRecordPath(
  stateRoot: string,
  identity: IndexStateRecordIdentity,
): string {
  return path.join(
    stateRoot,
    INDEX_STATE_REGISTRY_DIR,
    INDEX_STATE_RECORDS_DIR,
    `${indexStateRecordKey(identity)}.json`,
  );
}

export function indexStateCurrentPath(
  stateRoot: string,
  identity: IndexStateCurrentIdentity,
): string {
  return path.join(
    stateRoot,
    INDEX_STATE_REGISTRY_DIR,
    INDEX_STATE_CURRENT_DIR,
    `${indexStateCurrentKey(identity)}.json`,
  );
}

export type IndexStateWriteResult =
  | { ok: true; path: string }
  | {
      ok: false;
      error: unknown;
      path: string;
      /** `true` means an earlier state cannot still masquerade as this run. */
      previousStateInvalidated: boolean;
      invalidationError?: unknown;
    };

export type TerminalIndexStateWriteResult =
  (IndexStateWriteResult & { superseded: false }) | { ok: true; path: string; superseded: true };

/** Owner check supplied by the renewable publication lease. */
export interface IndexStatePublicationOptions {
  /** Must reject after lease ownership was lost. Called directly before every live rename. */
  readonly assertOwnership?: () => Promise<void>;
}

interface CurrentPointerV1 extends StorageStateIdentity {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly repoId: string;
  readonly refId: string;
  readonly embeddingProfileId: string;
  readonly generationId: string;
  readonly recordKey: string;
}

/**
 * Publiziert einen Registry-Datensatz und macht ihn zum aktuellen Profil des
 * Repo/Ref-Paares. Beide Dateien werden einzeln atomar ersetzt. Der Aufrufer
 * serialisiert die kurze Sequenz mit {@link indexStateLockKey}.
 *
 * Misslingt ein Teil, werden der neue Datensatz, der current-Pointer und ein
 * passender Legacy-Fallback invalidiert. Damit kann ein neuer Lauf nie einen
 * alten `completed`-Hinweis gesund aussehen lassen.
 */
export async function writeIndexState(
  stateRoot: string,
  state: IndexStateV1,
  options: IndexStatePublicationOptions = {},
): Promise<IndexStateWriteResult> {
  const recordTarget = indexStateRecordPath(stateRoot, state);
  const serializedState = serializeRegistryState(state);
  if (serializedState === null) {
    const error = new Error("Registry index states require a valid generation-bound state.");
    const invalidated = await invalidateAfterFailure(stateRoot, state, "unconditional", options);
    return failedWrite(recordTarget, error, invalidated);
  }

  try {
    await atomicWrite(recordTarget, serializedState, options.assertOwnership);
  } catch (error) {
    const invalidated = await invalidateAfterFailure(stateRoot, state, "unconditional", options);
    return failedWrite(recordTarget, error, invalidated);
  }

  const pointerTarget = indexStateCurrentPath(stateRoot, state);
  const pointer = currentPointerFor(state);
  try {
    await atomicWrite(
      pointerTarget,
      `${JSON.stringify(pointer, null, 2)}\n`,
      options.assertOwnership,
    );
    return { ok: true, path: recordTarget };
  } catch (error) {
    const invalidated = await invalidateAfterFailure(stateRoot, state, "unconditional", options);
    return failedWrite(pointerTarget, error, invalidated);
  }
}

/**
 * Replaces exactly one `running` registry record while its generation still
 * matches. The current pointer is deliberately not republished: if another
 * profile became current while this run finished, a late terminal write may
 * archive its own result but cannot steal `auto` routing back.
 */
export async function replaceRunningIndexState(
  stateRoot: string,
  terminalState: IndexStateV1,
  options: IndexStatePublicationOptions = {},
): Promise<TerminalIndexStateWriteResult> {
  const target = indexStateRecordPath(stateRoot, terminalState);
  const current = await readExactRegistryRecord(target, terminalState);
  if (current.kind === "absent") {
    return { ok: true, path: target, superseded: true };
  }
  if (current.kind === "invalid") {
    const invalidated = await invalidateAfterFailure(stateRoot, terminalState, "matching", options);
    return {
      ...failedWrite(target, new Error(current.message), invalidated),
      superseded: false,
    };
  }
  if (!isRunningStateFor(current.state, terminalState)) {
    return { ok: true, path: target, superseded: true };
  }

  const serializedState = serializeRegistryState(terminalState);
  if (serializedState === null) {
    const error = new Error("Terminal registry states require the running generation identity.");
    const invalidated = await invalidateAfterFailure(stateRoot, terminalState, "matching", options);
    return { ...failedWrite(target, error, invalidated), superseded: false };
  }
  try {
    await atomicWrite(target, serializedState, options.assertOwnership);
    return { ok: true, path: target, superseded: false };
  } catch (error) {
    const invalidated = await invalidateAfterFailure(stateRoot, terminalState, "matching", options);
    return { ...failedWrite(target, error, invalidated), superseded: false };
  }
}

function isRunningStateFor(current: IndexStateV1, terminal: IndexStateV1): boolean {
  return (
    current.outcome === "running" &&
    terminal.outcome !== "running" &&
    current.workspaceId === terminal.workspaceId &&
    current.repoId === terminal.repoId &&
    current.refId === terminal.refId &&
    current.refName === terminal.refName &&
    current.embedder === terminal.embedder &&
    current.embeddingProfileId === terminal.embeddingProfileId &&
    current.collection === terminal.collection &&
    (current.storageBackend ?? "qdrant") === (terminal.storageBackend ?? "qdrant") &&
    (current.storeUrl ?? current.qdrantUrl) === (terminal.storeUrl ?? terminal.qdrantUrl) &&
    current.generationId !== undefined &&
    current.generationId === terminal.generationId
  );
}

/**
 * Compatibility reader for old callers. It returns a state only when exactly
 * one current repo/ref state exists below this physical root; callers needing
 * every context use {@link resolveIndexState}.
 */
export async function readIndexState(stateRoot: string): Promise<IndexStateV1 | null> {
  const registry = await readLocalRegistry(stateRoot);
  if (registry.kind === "invalid") return null;
  const current = registry.entries.filter((entry) => entry.current);
  return current.length === 1 ? (current[0]?.state ?? null) : null;
}

/** The parser remains public for legacy migration and focused tests. */
export function parseIndexState(text: string): IndexStateV1 | null {
  if (Buffer.byteLength(text, "utf8") > MAX_INDEX_STATE_FILE_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record["schemaVersion"] !== 1) return null;
  const embedder = record["embedder"];
  if (embedder !== "service" && embedder !== "offline") return null;
  const outcome = record["outcome"];
  if (
    outcome !== "running" &&
    outcome !== "completed" &&
    outcome !== "cancelled" &&
    outcome !== "failed"
  ) {
    return null;
  }

  const strings = [
    "workspaceId",
    "repoId",
    "refId",
    "refName",
    "embeddingProfileId",
    "collection",
  ] as const;
  const values: Record<string, string> = {};
  for (const key of strings) {
    const value = record[key];
    if (!isBoundedString(value)) return null;
    values[key] = value;
  }
  const storage = parseStorageIdentity(record, true);
  if (storage === null) return null;
  const generationId = record["generationId"];
  if (generationId !== undefined && !isBoundedString(generationId)) return null;
  const corpusRevisionFingerprint = record["corpusRevisionFingerprint"];
  if (
    corpusRevisionFingerprint !== undefined &&
    (typeof corpusRevisionFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/u.test(corpusRevisionFingerprint))
  ) {
    return null;
  }
  const indexedAt = record["indexedAt"];
  const indexConfigFingerprint = record["indexConfigFingerprint"];
  const lexicalTokenizerVersion = record["lexicalTokenizerVersion"];
  if (
    indexedAt !== undefined &&
    (typeof indexedAt !== "string" || !Number.isFinite(Date.parse(indexedAt)))
  )
    return null;
  if (
    indexConfigFingerprint !== undefined &&
    (typeof indexConfigFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(indexConfigFingerprint))
  )
    return null;
  if (lexicalTokenizerVersion !== undefined && !isBoundedString(lexicalTokenizerVersion))
    return null;

  return {
    schemaVersion: 1,
    workspaceId: values["workspaceId"] as string,
    repoId: values["repoId"] as string,
    refId: values["refId"] as string,
    refName: values["refName"] as string,
    embedder,
    embeddingProfileId: values["embeddingProfileId"] as string,
    collection: values["collection"] as string,
    ...storage,
    ...(generationId === undefined ? {} : { generationId }),
    ...(corpusRevisionFingerprint === undefined ? {} : { corpusRevisionFingerprint }),
    ...(indexedAt === undefined ? {} : { indexedAt }),
    ...(indexConfigFingerprint === undefined ? {} : { indexConfigFingerprint }),
    ...(lexicalTokenizerVersion === undefined ? {} : { lexicalTokenizerVersion }),
    outcome,
  };
}

/** Ein gefundener Zustand samt Herkunft und Auto-Routing-Rolle. */
export interface FoundIndexState {
  readonly repoRoot: string;
  readonly statePath: string;
  readonly source: "registry" | "legacy";
  readonly current: boolean;
  readonly state: IndexStateV1;
}

/** Optional query scope applied before states can influence auto-routing. */
export interface IndexStateScope {
  readonly repoIds?: readonly string[];
  /** Accepts human ref names as well as canonical repo-qualified ref IDs. */
  readonly refs?: readonly string[];
  readonly storageBackend?: "lancedb" | "qdrant";
  readonly storeUrl?: string;
}

export interface IndexStateDiagnostic {
  readonly code:
    "INDEX_STATE_CORRUPT" | "INDEX_STATE_IO" | "INDEX_STATE_OVERSIZED" | "INDEX_STATE_UNBOUNDED";
  readonly path: string;
  readonly message: string;
}

/**
 * `all` contains every selected profile record. `found`/`current` only use
 * the generation-checked current pointer and therefore drive `auto` routing.
 */
export type IndexStateResolution =
  | {
      readonly kind: "resolved";
      readonly embedder: EmbedderChoice;
      readonly found: FoundIndexState;
      readonly current: readonly FoundIndexState[];
      readonly all: readonly FoundIndexState[];
    }
  | { readonly kind: "none" }
  | {
      readonly kind: "ambiguous";
      readonly found: readonly FoundIndexState[];
      readonly all: readonly FoundIndexState[];
    }
  | {
      readonly kind: "invalid";
      readonly diagnostics: readonly IndexStateDiagnostic[];
      /** Valid states from other roots are exposed for diagnosis, never auto-used. */
      readonly all: readonly FoundIndexState[];
    };

/**
 * Enumerates every bounded registry under the candidate physical roots.
 * Roots are de-duplicated, records are not: one root can legitimately contain
 * multiple repo IDs, refs and profiles.
 */
export async function resolveIndexState(
  candidateRoots: readonly string[],
  workspaceId: string,
  scope: IndexStateScope = {},
): Promise<IndexStateResolution> {
  const collected = await collectScopedIndexStates(candidateRoots, workspaceId, scope);
  collected.found.sort(compareFoundStates);
  if (collected.diagnostics.length > 0) {
    collected.diagnostics.sort(
      (a, b) => compareText(a.path, b.path) || compareText(a.code, b.code),
    );
    return { kind: "invalid", diagnostics: collected.diagnostics, all: collected.found };
  }
  return resolveCollectedStates(collected.found);
}

async function collectScopedIndexStates(
  candidateRoots: readonly string[],
  workspaceId: string,
  scope: IndexStateScope,
): Promise<{ found: FoundIndexState[]; diagnostics: IndexStateDiagnostic[] }> {
  const selectedRepoIds = new Set(scope.repoIds ?? []);
  const selectedRefs = new Set(scope.refs ?? []);
  const seenRoots = new Set<string>();
  const found: FoundIndexState[] = [];
  const diagnostics: IndexStateDiagnostic[] = [];

  for (const candidateRoot of candidateRoots) {
    const repoRoot = path.resolve(candidateRoot);
    if (seenRoots.has(repoRoot)) continue;
    seenRoots.add(repoRoot);
    const registry = await readLocalRegistry(stateRootOf(repoRoot));
    if (registry.kind === "invalid") {
      diagnostics.push(...registry.diagnostics);
      continue;
    }
    for (const entry of registry.entries) {
      if (!stateMatchesScope(entry.state, workspaceId, selectedRepoIds, selectedRefs, scope))
        continue;
      found.push({ repoRoot, ...entry });
    }
  }
  return { found, diagnostics };
}

function stateMatchesScope(
  state: IndexStateV1,
  workspaceId: string,
  selectedRepoIds: ReadonlySet<string>,
  selectedRefs: ReadonlySet<string>,
  scope: IndexStateScope,
): boolean {
  return (
    state.workspaceId === workspaceId &&
    (scope.storageBackend === undefined ||
      (state.storageBackend ?? "qdrant") === scope.storageBackend) &&
    (scope.storeUrl === undefined || (state.storeUrl ?? state.qdrantUrl) === scope.storeUrl) &&
    (selectedRepoIds.size === 0 || selectedRepoIds.has(state.repoId)) &&
    (selectedRefs.size === 0 || selectedRefs.has(state.refId) || selectedRefs.has(state.refName))
  );
}

function resolveCollectedStates(found: readonly FoundIndexState[]): IndexStateResolution {
  if (found.length === 0) return { kind: "none" };

  const current = found.filter((entry) => entry.current);
  if (current.length === 0) {
    return {
      kind: "invalid",
      diagnostics: [
        {
          code: "INDEX_STATE_CORRUPT",
          path: found[0]?.statePath ?? "(index-state registry)",
          message: "The selected registry states have no valid current pointer.",
        },
      ],
      all: found,
    };
  }
  const first = current[0] as FoundIndexState;
  if (current.some((entry) => entry.state.embedder !== first.state.embedder)) {
    return { kind: "ambiguous", found: current, all: found };
  }
  return { kind: "resolved", embedder: first.state.embedder, found: first, current, all: found };
}

interface LocalRegistryEntry {
  readonly statePath: string;
  readonly source: "registry" | "legacy";
  readonly current: boolean;
  readonly state: IndexStateV1;
}

type LocalRegistryRead =
  | { readonly kind: "valid"; readonly entries: readonly LocalRegistryEntry[] }
  | { readonly kind: "invalid"; readonly diagnostics: readonly IndexStateDiagnostic[] };
type InvalidRegistryRead = Extract<LocalRegistryRead, { readonly kind: "invalid" }>;

type RegistryPartRead<Value> =
  | { readonly kind: "valid"; readonly value: Value }
  | { readonly kind: "invalid"; readonly diagnostics: readonly IndexStateDiagnostic[] };

type RegistryRecordMap = Map<string, { state: IndexStateV1; statePath: string }>;

async function readLocalRegistry(stateRoot: string): Promise<LocalRegistryRead> {
  const recordsDirectory = path.join(stateRoot, INDEX_STATE_REGISTRY_DIR, INDEX_STATE_RECORDS_DIR);
  const currentDirectory = path.join(stateRoot, INDEX_STATE_REGISTRY_DIR, INDEX_STATE_CURRENT_DIR);
  const recordsListing = await listRegistryFiles(recordsDirectory);
  if (recordsListing.kind === "invalid") return recordsListing;
  const currentListing = await listRegistryFiles(currentDirectory);
  if (currentListing.kind === "invalid") return currentListing;

  const recordRead = await readRegistryRecords(recordsListing.paths);
  if (recordRead.kind === "invalid") return recordRead;
  const currentRead = await readCurrentPointers(currentListing.paths, recordRead.value);
  if (currentRead.kind === "invalid") return currentRead;
  const missingPointer = firstRecordWithoutCurrent(recordRead.value, currentRead.value);
  if (missingPointer !== null) return missingPointer;

  const entries = registryEntries(recordRead.value, currentRead.value);
  const legacyMerge = await mergeLegacyState(
    stateRoot,
    recordRead.value,
    currentRead.value,
    entries,
  );
  if (legacyMerge !== null) return legacyMerge;

  entries.sort((a, b) => compareStateEntries(a, b));
  return { kind: "valid", entries };
}

async function readRegistryRecords(
  paths: readonly string[],
): Promise<RegistryPartRead<RegistryRecordMap>> {
  const records: RegistryRecordMap = new Map();
  for (const recordPath of paths) {
    const read = await readBoundedRegularFile(recordPath);
    if (read.kind === "absent") {
      return invalidRegistry(recordPath, "Registry record disappeared while being read.");
    }
    if (read.kind === "invalid") return invalidFileRead(recordPath, read);
    const state = parseIndexState(read.text);
    if (state === null || state.generationId === undefined) {
      return invalidRegistry(recordPath, "Registry record is invalid or has no generation.");
    }
    const key = indexStateRecordKey(state);
    if (path.basename(recordPath) !== `${key}.json`) {
      return invalidRegistry(
        recordPath,
        "Registry filename does not match the canonical identity.",
      );
    }
    records.set(key, { state, statePath: recordPath });
  }
  return { kind: "valid", value: records };
}

async function readCurrentPointers(
  paths: readonly string[],
  records: RegistryRecordMap,
): Promise<RegistryPartRead<Map<string, string>>> {
  const currentByGroup = new Map<string, string>();
  for (const pointerPath of paths) {
    const read = await readBoundedRegularFile(pointerPath);
    if (read.kind === "absent") {
      return invalidRegistry(pointerPath, "Current pointer disappeared while being read.");
    }
    if (read.kind === "invalid") return invalidFileRead(pointerPath, read);
    const parsed = validateCurrentPointer(pointerPath, read.text, records, currentByGroup);
    if (parsed.kind === "invalid") return parsed;
    currentByGroup.set(parsed.value.currentKey, parsed.value.recordKey);
  }
  return { kind: "valid", value: currentByGroup };
}

function validateCurrentPointer(
  pointerPath: string,
  text: string,
  records: RegistryRecordMap,
  currentByGroup: ReadonlyMap<string, string>,
): RegistryPartRead<{ currentKey: string; recordKey: string }> {
  const pointer = parseCurrentPointer(text);
  if (pointer === null) return invalidRegistry(pointerPath, "Current pointer is invalid.");
  const currentKey = indexStateCurrentKey(pointer);
  if (path.basename(pointerPath) !== `${currentKey}.json`) {
    return invalidRegistry(
      pointerPath,
      "Pointer filename does not match the repository/ref identity.",
    );
  }
  const pointed = records.get(pointer.recordKey);
  if (pointed === undefined || !pointerMatchesState(pointer, pointed.state)) {
    return invalidRegistry(
      pointerPath,
      "Current pointer does not reference the same profile- and generation-bound record.",
    );
  }
  if (currentByGroup.has(currentKey)) {
    return invalidRegistry(pointerPath, "Repository/ref has more than one current pointer.");
  }
  return { kind: "valid", value: { currentKey, recordKey: pointer.recordKey } };
}

function firstRecordWithoutCurrent(
  records: RegistryRecordMap,
  currentByGroup: ReadonlyMap<string, string>,
): LocalRegistryRead | null {
  for (const { state, statePath } of records.values()) {
    if (!currentByGroup.has(indexStateCurrentKey(state))) {
      return invalidRegistry(
        statePath,
        "Registry record belongs to a repository/ref without a current pointer.",
      );
    }
  }
  return null;
}

function registryEntries(
  records: RegistryRecordMap,
  currentByGroup: ReadonlyMap<string, string>,
): LocalRegistryEntry[] {
  return [...records.entries()].map(([recordKey, { state, statePath }]) => ({
    state,
    statePath,
    source: "registry",
    current: currentByGroup.get(indexStateCurrentKey(state)) === recordKey,
  }));
}

async function mergeLegacyState(
  stateRoot: string,
  records: RegistryRecordMap,
  currentByGroup: ReadonlyMap<string, string>,
  entries: LocalRegistryEntry[],
): Promise<LocalRegistryRead | null> {
  const legacyPath = indexStatePath(stateRoot);
  const legacyRead = await readBoundedRegularFile(legacyPath);
  if (legacyRead.kind === "absent") return null;
  if (legacyRead.kind === "invalid") return invalidFileRead(legacyPath, legacyRead);
  const legacyState = parseIndexState(legacyRead.text);
  if (legacyState === null) {
    return invalidRegistry(legacyPath, "Legacy index state is invalid.");
  }
  if (records.has(indexStateRecordKey(legacyState))) return null;
  entries.push({
    state: legacyState,
    statePath: legacyPath,
    source: "legacy",
    current: !currentByGroup.has(indexStateCurrentKey(legacyState)),
  });
  return null;
}

type DirectoryListing =
  | { readonly kind: "valid"; readonly paths: readonly string[] }
  | { readonly kind: "invalid"; readonly diagnostics: readonly IndexStateDiagnostic[] };

async function listRegistryFiles(directory: string): Promise<DirectoryListing> {
  try {
    const information = await lstat(directory);
    if (!information.isDirectory()) {
      return {
        kind: "invalid",
        diagnostics: [
          diagnostic(
            "INDEX_STATE_CORRUPT",
            directory,
            "Registry directory is not a regular local directory.",
          ),
        ],
      };
    }
  } catch (error) {
    if (isNotFound(error)) return { kind: "valid", paths: [] };
    return {
      kind: "invalid",
      diagnostics: [
        diagnostic("INDEX_STATE_IO", directory, `Cannot inspect registry: ${errorText(error)}`),
      ],
    };
  }

  let handle;
  try {
    handle = await opendir(directory);
  } catch (error) {
    if (isNotFound(error)) return { kind: "valid", paths: [] };
    return {
      kind: "invalid",
      diagnostics: [
        diagnostic("INDEX_STATE_IO", directory, `Cannot read registry: ${errorText(error)}`),
      ],
    };
  }

  const names: string[] = [];
  try {
    for await (const entry of handle) {
      names.push(entry.name);
      if (names.length > MAX_INDEX_STATE_REGISTRY_ENTRIES) {
        return {
          kind: "invalid",
          diagnostics: [
            diagnostic(
              "INDEX_STATE_UNBOUNDED",
              directory,
              `Registry contains more than ${String(MAX_INDEX_STATE_REGISTRY_ENTRIES)} Eintraege.`,
            ),
          ],
        };
      }
      if (TEMP_FILE_PATTERN.test(entry.name) && entry.isFile()) continue;
      if (!HASH_FILE_PATTERN.test(entry.name) || !entry.isFile()) {
        return {
          kind: "invalid",
          diagnostics: [
            diagnostic(
              "INDEX_STATE_CORRUPT",
              path.join(directory, entry.name),
              "Registry accepts only regular JSON records with canonical filenames.",
            ),
          ],
        };
      }
    }
  } catch (error) {
    return {
      kind: "invalid",
      diagnostics: [
        diagnostic("INDEX_STATE_IO", directory, `Registry read failed: ${errorText(error)}`),
      ],
    };
  } finally {
    await handle.close().catch(() => undefined);
  }

  return {
    kind: "valid",
    paths: names
      .filter((name) => HASH_FILE_PATTERN.test(name))
      .sort(compareText)
      .map((name) => path.join(directory, name)),
  };
}

type BoundedFileRead =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly text: string }
  | {
      readonly kind: "invalid";
      readonly reason: "io" | "oversized" | "not_regular";
      readonly message: string;
    };

async function readBoundedRegularFile(filePath: string): Promise<BoundedFileRead> {
  try {
    const information = await lstat(filePath);
    if (!information.isFile()) {
      return { kind: "invalid", reason: "not_regular", message: "Path is not a regular file." };
    }
    if (information.size > MAX_INDEX_STATE_FILE_BYTES) {
      return {
        kind: "invalid",
        reason: "oversized",
        message: `File exceeds ${String(MAX_INDEX_STATE_FILE_BYTES)} Bytes.`,
      };
    }
  } catch (error) {
    if (isNotFound(error)) return { kind: "absent" };
    return { kind: "invalid", reason: "io", message: errorText(error) };
  }

  let handle;
  try {
    // `lstat` rejects an existing symlink; O_NOFOLLOW also closes the race in
    // which that path is swapped between the check and open.
    handle = await open(filePath, READ_ONLY_NO_FOLLOW);
    const buffer = Buffer.alloc(MAX_INDEX_STATE_FILE_BYTES + 1);
    let totalBytesRead = 0;
    while (totalBytesRead < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytesRead,
        buffer.length - totalBytesRead,
        totalBytesRead,
      );
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
    }
    if (totalBytesRead > MAX_INDEX_STATE_FILE_BYTES) {
      return {
        kind: "invalid",
        reason: "oversized",
        message: `File exceeds ${String(MAX_INDEX_STATE_FILE_BYTES)} Bytes.`,
      };
    }
    return { kind: "valid", text: buffer.subarray(0, totalBytesRead).toString("utf8") };
  } catch (error) {
    if (isNotFound(error)) return { kind: "absent" };
    return { kind: "invalid", reason: "io", message: errorText(error) };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Embedded state identities must be canonical absolute local file URLs. */
function isLocalStoreUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "file:" &&
      url.hostname === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.href === value &&
      !url.pathname.includes("%00")
    );
  } catch {
    return false;
  }
}

function parseStorageIdentity(
  record: Record<string, unknown>,
  requireEndpoint: boolean,
): (StorageStateIdentity & { qdrantUrl?: string }) | null {
  const backend = record["storageBackend"];
  const storeUrl = record["storeUrl"];
  const qdrantUrl = record["qdrantUrl"];
  if (backend !== undefined && backend !== "qdrant" && backend !== "lancedb") return null;
  if (backend === "lancedb") {
    if (!isBoundedString(storeUrl) || !isLocalStoreUrl(storeUrl)) return null;
    if (qdrantUrl !== undefined) return null;
    return { storageBackend: "lancedb", storeUrl };
  }
  if (storeUrl !== undefined && (!isBoundedString(storeUrl) || storeUrl !== qdrantUrl)) return null;
  if (requireEndpoint && !isBoundedString(qdrantUrl)) return null;
  if (qdrantUrl !== undefined && !isBoundedString(qdrantUrl)) return null;
  return {
    ...(backend === undefined ? {} : { storageBackend: backend }),
    ...(storeUrl === undefined ? {} : { storeUrl }),
    ...(qdrantUrl === undefined ? {} : { qdrantUrl }),
  };
}

function parseCurrentPointer(text: string): CurrentPointerV1 | null {
  if (Buffer.byteLength(text, "utf8") > MAX_INDEX_STATE_FILE_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record["schemaVersion"] !== 1) return null;
  const storage = parseStorageIdentity(record, false);
  if (storage === null) return null;
  const workspaceId = record["workspaceId"];
  const repoId = record["repoId"];
  const refId = record["refId"];
  const embeddingProfileId = record["embeddingProfileId"];
  const generationId = record["generationId"];
  const recordKey = record["recordKey"];
  if (
    !isBoundedString(workspaceId) ||
    !isBoundedString(repoId) ||
    !isBoundedString(refId) ||
    !isBoundedString(embeddingProfileId) ||
    !isBoundedString(generationId) ||
    typeof recordKey !== "string" ||
    !/^[0-9a-f]{64}$/u.test(recordKey)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    ...storage,
    workspaceId,
    repoId,
    refId,
    embeddingProfileId,
    generationId,
    recordKey,
  };
}

function currentPointerFor(state: IndexStateV1): CurrentPointerV1 {
  if (state.generationId === undefined) {
    throw new Error("A current pointer requires a generation id.");
  }
  return {
    schemaVersion: 1,
    workspaceId: state.workspaceId,
    repoId: state.repoId,
    refId: state.refId,
    embeddingProfileId: state.embeddingProfileId,
    generationId: state.generationId,
    recordKey: indexStateRecordKey(state),
    ...(state.storageBackend === "lancedb"
      ? ({ storageBackend: "lancedb", storeUrl: state.storeUrl } as const)
      : {}),
  };
}

function pointerMatchesState(pointer: CurrentPointerV1, state: IndexStateV1): boolean {
  return (
    pointer.workspaceId === state.workspaceId &&
    pointer.repoId === state.repoId &&
    pointer.refId === state.refId &&
    pointer.embeddingProfileId === state.embeddingProfileId &&
    pointer.generationId === state.generationId &&
    pointer.recordKey === indexStateRecordKey(state) &&
    indexStateCurrentKey(pointer) === indexStateCurrentKey(state)
  );
}

type ExactRecordRead =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly state: IndexStateV1 }
  | { readonly kind: "invalid"; readonly message: string };

async function readExactRegistryRecord(
  target: string,
  identity: IndexStateRecordIdentity,
): Promise<ExactRecordRead> {
  const read = await readBoundedRegularFile(target);
  if (read.kind === "absent") return read;
  if (read.kind === "invalid") return { kind: "invalid", message: read.message };
  const state = parseIndexState(read.text);
  if (
    state === null ||
    state.generationId === undefined ||
    indexStateRecordKey(state) !== indexStateRecordKey(identity)
  ) {
    return { kind: "invalid", message: "Registry record does not match its key." };
  }
  return { kind: "valid", state };
}

async function atomicWrite(
  target: string,
  text: string,
  assertOwnership?: () => Promise<void>,
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await assertOwnership?.();
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function serializeRegistryState(state: IndexStateV1): string | null {
  if (state.generationId === undefined) return null;
  const text = `${JSON.stringify(state, null, 2)}\n`;
  const parsed = parseIndexState(text);
  if (parsed === null || parsed.generationId === undefined) return null;
  return text;
}

type PointerInvalidation = "unconditional" | "matching";

async function invalidateAfterFailure(
  stateRoot: string,
  state: IndexStateV1,
  pointerInvalidation: PointerInvalidation,
  options: IndexStatePublicationOptions,
): Promise<{ ok: boolean; error?: unknown }> {
  if (options.assertOwnership !== undefined) {
    try {
      // Never let a writer that already lost its lease remove a successor's
      // record or pointer. The surviving running marker remains fail-closed.
      await options.assertOwnership();
    } catch (error) {
      return { ok: false, error };
    }
  }
  return invalidatePublication(stateRoot, state, pointerInvalidation);
}

async function invalidatePublication(
  stateRoot: string,
  state: IndexStateV1,
  pointerInvalidation: PointerInvalidation,
): Promise<{ ok: boolean; error?: unknown }> {
  const errors: unknown[] = [];
  await removeAndCollect(indexStateRecordPath(stateRoot, state), errors);
  await invalidateCurrentPointer(stateRoot, state, pointerInvalidation, errors);
  await invalidateLegacyFallback(stateRoot, state, pointerInvalidation, errors);
  return errors.length === 0 ? { ok: true } : { ok: false, error: errors[0] };
}

async function invalidateCurrentPointer(
  stateRoot: string,
  state: IndexStateV1,
  pointerInvalidation: PointerInvalidation,
  errors: unknown[],
): Promise<void> {
  const pointerPath = indexStateCurrentPath(stateRoot, state);
  if (pointerInvalidation === "unconditional") {
    await removeAndCollect(pointerPath, errors);
    return;
  }
  const pointerRead = await readBoundedRegularFile(pointerPath);
  if (pointerRead.kind === "invalid") {
    await removeAndCollect(pointerPath, errors);
    return;
  }
  if (pointerRead.kind !== "valid") return;
  const pointer = parseCurrentPointer(pointerRead.text);
  if (pointer === null || pointerIdentifiesState(pointer, state)) {
    await removeAndCollect(pointerPath, errors);
  }
}

function pointerIdentifiesState(pointer: CurrentPointerV1, state: IndexStateV1): boolean {
  return (
    pointer.recordKey === indexStateRecordKey(state) && pointer.generationId === state.generationId
  );
}

async function invalidateLegacyFallback(
  stateRoot: string,
  state: IndexStateV1,
  pointerInvalidation: PointerInvalidation,
  errors: unknown[],
): Promise<void> {
  const legacyPath = indexStatePath(stateRoot);
  const legacyRead = await readBoundedRegularFile(legacyPath);
  if (legacyRead.kind !== "valid") return;
  const legacy = parseIndexState(legacyRead.text);
  if (legacy !== null && legacyMustBeInvalidated(legacy, state, pointerInvalidation)) {
    await removeAndCollect(legacyPath, errors);
  }
}

function legacyMustBeInvalidated(
  legacy: IndexStateV1,
  state: IndexStateV1,
  pointerInvalidation: PointerInvalidation,
): boolean {
  const sameGroup = indexStateCurrentKey(legacy) === indexStateCurrentKey(state);
  return (
    sameGroup &&
    (pointerInvalidation === "unconditional" ||
      legacy.embeddingProfileId === state.embeddingProfileId)
  );
}

async function removeAndCollect(target: string, errors: unknown[]): Promise<void> {
  try {
    await rm(target, { force: true });
  } catch (error) {
    errors.push(error);
  }
}

function failedWrite(
  target: string,
  error: unknown,
  invalidated: { ok: boolean; error?: unknown },
): Extract<IndexStateWriteResult, { ok: false }> {
  return {
    ok: false,
    error,
    path: target,
    previousStateInvalidated: invalidated.ok,
    ...(invalidated.error === undefined ? {} : { invalidationError: invalidated.error }),
  };
}

function invalidFileRead(
  filePath: string,
  read: Extract<BoundedFileRead, { kind: "invalid" }>,
): InvalidRegistryRead {
  return {
    kind: "invalid",
    diagnostics: [
      diagnostic(
        read.reason === "oversized"
          ? "INDEX_STATE_OVERSIZED"
          : read.reason === "io"
            ? "INDEX_STATE_IO"
            : "INDEX_STATE_CORRUPT",
        filePath,
        read.message,
      ),
    ],
  };
}

function invalidRegistry(filePath: string, message: string): InvalidRegistryRead {
  return {
    kind: "invalid",
    diagnostics: [diagnostic("INDEX_STATE_CORRUPT", filePath, message)],
  };
}

function diagnostic(
  code: IndexStateDiagnostic["code"],
  filePath: string,
  message: string,
): IndexStateDiagnostic {
  return { code, path: filePath, message };
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= MAX_INDEX_STATE_FIELD_LENGTH
  );
}

function hashCanonical(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

function compareFoundStates(left: FoundIndexState, right: FoundIndexState): number {
  return compareText(left.repoRoot, right.repoRoot) || compareStateEntries(left, right);
}

function compareStateEntries(
  left: Pick<LocalRegistryEntry, "statePath" | "state">,
  right: Pick<LocalRegistryEntry, "statePath" | "state">,
): number {
  return (
    compareText(left.state.repoId, right.state.repoId) ||
    compareText(left.state.refId, right.state.refId) ||
    compareText(left.state.embeddingProfileId, right.state.embeddingProfileId) ||
    compareText(left.statePath, right.statePath)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
