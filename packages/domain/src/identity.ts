/**
 * Deterministic identity model (spec.md §5, portfolio.md §5).
 *
 * All primary IDs are UUIDv5 values under a fixed Untangle namespace, or —
 * where the spec says so — plain string compositions (`ref_id`) or SHA-256
 * hashes (`embedding_profile_id`, `rule_fingerprint`). Everything here is a
 * pure function of its inputs: same input, same ID, in every process.
 *
 * Name construction: spec.md §5 writes ID inputs as `a + b + c`. Naive string
 * concatenation is ambiguous ("ab"+"c" === "a"+"bc"), so every UUIDv5 name is
 * built by joining a kind tag plus the components with the ASCII unit
 * separator U+001F, which cannot occur in normalized paths, refs or
 * identifiers. The leading kind tag ("file", "symbol", …) prevents collisions
 * between different ID kinds that would otherwise share the same components.
 */
import { createHash, createHmac } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import type { ChunkKind } from "./types/common.js";
import type { EmbeddingProfile } from "./types/embedding.js";

/**
 * Fixed Untangle identity namespace for all UUIDv5 derivations.
 *
 * Derivation (one-time, documented for reproducibility): this constant is
 * `uuidv5("dev.untangle.identity", NS_DNS)` where NS_DNS is the RFC 4122 DNS
 * namespace `6ba7b810-9dad-11d1-80b4-00c04fd430c8`. The value is frozen here
 * as a literal — it must never change, or every stored ID becomes invalid.
 */
export const UNTANGLE_UUID_NAMESPACE = "f37509b3-6f7a-5b63-a570-f7fcc532468d" as const;

/** ASCII unit separator used to join UUIDv5 name components unambiguously. */
export const ID_COMPONENT_SEPARATOR = "\u001f" as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidToBytes(uuid: string): Uint8Array {
  if (!UUID_PATTERN.test(uuid)) {
    throw new Error(`invalid UUID literal: "${uuid}"`);
  }
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * RFC 4122 UUID version 5 (SHA-1, name-based).
 *
 * @param name - arbitrary UTF-8 name
 * @param namespace - namespace UUID; defaults to {@link UNTANGLE_UUID_NAMESPACE}
 */
export function uuidv5(name: string, namespace: string = UNTANGLE_UUID_NAMESPACE): string {
  const namespaceBytes = uuidToBytes(namespace);
  const hash = createHash("sha1").update(namespaceBytes).update(Buffer.from(name, "utf8")).digest();
  const bytes = Uint8Array.prototype.slice.call(hash, 0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}

/** SHA-256 of a UTF-8 string as lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Keyed SHA-256 for local pseudonymous fingerprints that must resist offline guessing. */
export function hmacSha256Hex(key: Uint8Array, text: string): string {
  if (key.byteLength < 32) {
    throw new Error("HMAC-SHA-256 key must contain at least 32 bytes");
  }
  return createHmac("sha256", key).update(text, "utf8").digest("hex");
}

/**
 * Immutable fingerprint of the complete file-id -> content-hash manifest that
 * a successful index run confirmed. A generation can be resumed and updated;
 * this revision changes whenever the indexed corpus does.
 */
export function buildCorpusRevisionFingerprint(
  manifestHashes: Readonly<Record<string, string>>,
): string {
  const entries = Object.entries(manifestHashes).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [fileId, contentHash] of entries) {
    assertNonEmpty(fileId, "manifest fileId");
    assertNonEmpty(contentHash, `manifest contentHash for ${fileId}`);
  }
  return sha256Hex(canonicalJson({ schemaVersion: 1, entries }));
}

function assertNonEmpty(value: string, label: string): void {
  if (value.length === 0) {
    throw new Error(`identity input "${label}" must not be empty`);
  }
}

function assertNoSeparator(value: string, label: string): void {
  if (value.includes(ID_COMPONENT_SEPARATOR)) {
    throw new Error(`identity input "${label}" must not contain the U+001F component separator`);
  }
}

function joinIdName(kind: string, components: readonly string[]): string {
  for (const [index, component] of components.entries()) {
    assertNoSeparator(component, `${kind}[${index}]`);
  }
  return [kind, ...components].join(ID_COMPONENT_SEPARATOR);
}

/**
 * Normalizes a repository-relative path (spec.md §5.4, architecture.md §23.1):
 * - path separators become `/` (Windows `\` included);
 * - `.` segments and empty segments (duplicate slashes) are removed;
 * - inner `..` segments are resolved;
 * - a trailing slash is removed;
 * - absolute paths (`/x`, `C:\x`, `\\server\x`) and paths escaping their root
 *   via leading `..` are rejected — relative IDs must stay inside the root.
 *
 * Case is preserved: workspaces on case-sensitive file systems must not
 * collide IDs of distinct files.
 */
export function normalizeRelativePath(path: string): string {
  assertNonEmpty(path, "path");
  const forward = path.replace(/\\/g, "/");
  if (/^([a-zA-Z]:|\/)/.test(forward)) {
    throw new Error(`expected a relative path, got absolute path: "${path}"`);
  }
  const segments: string[] = [];
  for (const segment of forward.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error(`relative path escapes its root: "${path}"`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new Error(`relative path resolves to its root, not a file: "${path}"`);
  }
  return segments.join("/");
}

/**
 * Normalizes a ref name for `ref_id` (spec.md §5.3): trims surrounding
 * whitespace and rejects empty values. Case and inner characters are kept —
 * git refs are case-sensitive.
 */
export function normalizeRef(refName: string): string {
  const normalized = refName.trim();
  assertNonEmpty(normalized, "refName");
  return normalized;
}

/**
 * Workspace ID (spec.md §5.1): explicit if configured, otherwise stably
 * derived from the canonical workspace configuration hash.
 */
export function buildWorkspaceId(input: { explicitId?: string; configHash: string }): string {
  if (input.explicitId !== undefined) {
    assertNonEmpty(input.explicitId, "explicitId");
    return input.explicitId;
  }
  assertNonEmpty(input.configHash, "configHash");
  return uuidv5(joinIdName("workspace", [input.configHash]));
}

/**
 * Repository ID (spec.md §5.2): configurable; a canonical-path hash serves as
 * fallback when no explicit id is configured.
 */
export function buildRepoId(input: { explicitId?: string; canonicalPath: string }): string {
  if (input.explicitId !== undefined) {
    assertNonEmpty(input.explicitId, "explicitId");
    return input.explicitId;
  }
  assertNonEmpty(input.canonicalPath, "canonicalPath");
  const canonical = input.canonicalPath.replace(/\\/g, "/");
  return uuidv5(joinIdName("repository", [canonical]));
}

/**
 * Ref ID (spec.md §5.3). NOT a UUID by design:
 * `ref_id = repo_id + ":" + normalized_ref`.
 */
export function buildRefId(repoId: string, refName: string): string {
  assertNonEmpty(repoId, "repoId");
  return `${repoId}:${normalizeRef(refName)}`;
}

/** File ID (spec.md §5.4). `relativePath` is normalized before hashing. */
export function buildFileId(input: {
  workspaceId: string;
  repoId: string;
  refId: string;
  relativePath: string;
}): string {
  assertNonEmpty(input.workspaceId, "workspaceId");
  assertNonEmpty(input.repoId, "repoId");
  assertNonEmpty(input.refId, "refId");
  return uuidv5(
    joinIdName("file", [
      input.workspaceId,
      input.repoId,
      input.refId,
      normalizeRelativePath(input.relativePath),
    ]),
  );
}

/**
 * Symbol ID (spec.md §5.5). Line numbers are deliberately NOT part of the
 * input, so moving a symbol within its file keeps its identity.
 */
export function buildSymbolId(input: {
  workspaceId: string;
  repoId: string;
  refId: string;
  relativePath: string;
  symbolKind: string;
  qualifiedName: string;
  normalizedSignature: string;
}): string {
  assertNonEmpty(input.workspaceId, "workspaceId");
  assertNonEmpty(input.repoId, "repoId");
  assertNonEmpty(input.refId, "refId");
  assertNonEmpty(input.symbolKind, "symbolKind");
  assertNonEmpty(input.qualifiedName, "qualifiedName");
  return uuidv5(
    joinIdName("symbol", [
      input.workspaceId,
      input.repoId,
      input.refId,
      normalizeRelativePath(input.relativePath),
      input.symbolKind,
      input.qualifiedName,
      input.normalizedSignature,
    ]),
  );
}

/**
 * Chunk ID (spec.md §5.6). `scopeId` is the symbol id or — for file-scoped
 * chunks — the file id. Stable as long as the symbol and the chunk structure
 * (ordinal within the scope) and the chunker version are unchanged.
 */
export function buildChunkId(input: {
  scopeId: string;
  chunkKind: ChunkKind | string;
  ordinal: number;
  chunkerVersion: string;
}): string {
  assertNonEmpty(input.scopeId, "scopeId");
  assertNonEmpty(String(input.chunkKind), "chunkKind");
  assertNonEmpty(input.chunkerVersion, "chunkerVersion");
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0) {
    throw new Error(`chunk ordinal must be a non-negative integer, got ${input.ordinal}`);
  }
  return uuidv5(
    joinIdName("chunk", [
      input.scopeId,
      String(input.chunkKind),
      String(input.ordinal),
      input.chunkerVersion,
    ]),
  );
}

/**
 * Embedding profile ID (spec.md §5.7):
 * `SHA256(canonical_json(profile_fields))` over exactly the eight mandatory
 * fields, independent of property order in the input object.
 */
export function buildEmbeddingProfileId(profile: EmbeddingProfile): string {
  return sha256Hex(
    canonicalJson({
      provider: profile.provider,
      model: profile.model,
      dimensions: profile.dimensions,
      queryPrefix: profile.queryPrefix,
      documentPrefix: profile.documentPrefix,
      includePath: profile.includePath,
      normalization: profile.normalization,
      preparedTextVersion: profile.preparedTextVersion,
    }),
  );
}

/**
 * Short form of an embedding profile id for collection names such as
 * `{prefix}code_{profile_short_id}_v1` (spec.md §10.1). The length of 8 hex
 * characters is an Untangle decision (spec leaves it open) — enough to avoid
 * accidental collisions between the handful of profiles a workspace sees.
 */
export function embeddingProfileShortId(profileId: string, length = 8): string {
  assertNonEmpty(profileId, "profileId");
  if (!Number.isInteger(length) || length < 4 || length > profileId.length) {
    throw new Error(`invalid short id length: ${length}`);
  }
  return profileId.slice(0, length);
}

// ---------------------------------------------------------------------------
// Portfolio identities (portfolio.md §5)
// ---------------------------------------------------------------------------

/** `technology_id = UUIDv5(workspace_id + category + ecosystem + canonical_name)`. */
export function buildTechnologyId(input: {
  workspaceId: string;
  category: string;
  /** Missing ecosystem participates as the empty string (documented decision). */
  ecosystem?: string;
  canonicalName: string;
}): string {
  assertNonEmpty(input.workspaceId, "workspaceId");
  assertNonEmpty(input.category, "category");
  assertNonEmpty(input.canonicalName, "canonicalName");
  return uuidv5(
    joinIdName("technology", [
      input.workspaceId,
      input.category,
      input.ecosystem ?? "",
      input.canonicalName,
    ]),
  );
}

/** `tech_record_id = UUIDv5(technology_id + repo_id + ref_id + usage + detector_id)`. */
export function buildTechRecordId(input: {
  technologyId: string;
  repoId: string;
  refId: string;
  usage: string;
  detectorId: string;
}): string {
  return uuidv5(
    joinIdName("tech_record", [
      input.technologyId,
      input.repoId,
      input.refId,
      input.usage,
      input.detectorId,
    ]),
  );
}

/** `repo_profile_id = UUIDv5(workspace_id + repo_id + ref_id + "portfolio_profile")`. */
export function buildRepoProfileId(input: {
  workspaceId: string;
  repoId: string;
  refId: string;
}): string {
  return uuidv5(
    joinIdName("repo_profile", [input.workspaceId, input.repoId, input.refId, "portfolio_profile"]),
  );
}

/** `stack_matrix_id = UUIDv5(workspace_id + "stack_matrix" + generation_id)`. */
export function buildStackMatrixId(input: { workspaceId: string; generationId: string }): string {
  return uuidv5(
    joinIdName("stack_matrix", [input.workspaceId, "stack_matrix", input.generationId]),
  );
}

/**
 * Rule fingerprint (portfolio.md §8.3): SHA-256 of the canonical JSON of the
 * convention rule expression.
 */
export function buildRuleFingerprint(ruleExpression: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(ruleExpression));
}

/** `convention_id = UUIDv5(workspace_id + convention_kind + rule_fingerprint)`. */
export function buildConventionId(input: {
  workspaceId: string;
  conventionKind: string;
  ruleFingerprint: string;
}): string {
  return uuidv5(
    joinIdName("convention", [input.workspaceId, input.conventionKind, input.ruleFingerprint]),
  );
}

/** `archetype_id = UUIDv5(workspace_id + repo_id + ref_id + classifier_version)`. */
export function buildArchetypeId(input: {
  workspaceId: string;
  repoId: string;
  refId: string;
  classifierVersion: string;
}): string {
  return uuidv5(
    joinIdName("archetype", [
      input.workspaceId,
      input.repoId,
      input.refId,
      input.classifierVersion,
    ]),
  );
}

/** `blueprint_id = UUIDv5(workspace_id + blueprint_kind + advisor_version + generation_id)`. */
export function buildBlueprintId(input: {
  workspaceId: string;
  blueprintKind: string;
  advisorVersion: string;
  generationId: string;
}): string {
  return uuidv5(
    joinIdName("blueprint", [
      input.workspaceId,
      input.blueprintKind,
      input.advisorVersion,
      input.generationId,
    ]),
  );
}

/** `recommendation_id = UUIDv5(blueprint_id + topic)`. */
export function buildRecommendationId(input: { blueprintId: string; topic: string }): string {
  return uuidv5(joinIdName("recommendation", [input.blueprintId, input.topic]));
}

/** `radar_entry_id = UUIDv5(workspace_id + technology_id + radar_version)`. */
export function buildRadarEntryId(input: {
  workspaceId: string;
  technologyId: string;
  radarVersion: string;
}): string {
  return uuidv5(
    joinIdName("radar_entry", [input.workspaceId, input.technologyId, input.radarVersion]),
  );
}

// ---------------------------------------------------------------------------
// Abrufkern: Graphkanten, Suchanfragen, Findability, externe Befunde
// ---------------------------------------------------------------------------

/**
 * Kanten-ID des Dateigraphen.
 *
 * Eingaben sind bewusst NUR die Quellseite und der Rohstring: Quelle, Art,
 * Spezifizierer und die laufende Nummer identischer Vorkommen. Das ZIEL geht
 * NICHT ein — sonst bekaeme dieselbe Importzeile eine neue Identitaet, sobald
 * der Resolver besser wird, und jede Verbesserung saehe wie eine Aenderung am
 * Code aus. Zeilennummern gehen ebenfalls nicht ein (gleiche Logik wie
 * spec.md §5.5): eine verschobene Importzeile bleibt dieselbe Kante.
 */
export function buildFileEdgeId(input: {
  workspaceId: string;
  fromFileId: string;
  edgeKind: string;
  rawSpecifier: string;
  occurrenceOrdinal: number;
}): string {
  assertNonEmpty(input.workspaceId, "workspaceId");
  assertNonEmpty(input.fromFileId, "fromFileId");
  assertNonEmpty(input.edgeKind, "edgeKind");
  assertNonEmpty(input.rawSpecifier, "rawSpecifier");
  if (!Number.isInteger(input.occurrenceOrdinal) || input.occurrenceOrdinal < 0) {
    throw new Error(
      `file edge occurrenceOrdinal must be a non-negative integer, got ${input.occurrenceOrdinal}`,
    );
  }
  return uuidv5(
    joinIdName("file_edge", [
      input.workspaceId,
      input.fromFileId,
      input.edgeKind,
      input.rawSpecifier,
      String(input.occurrenceOrdinal),
    ]),
  );
}

/**
 * Kanten-ID des Symbolgraphen. Wie bei der Dateikante geht das aufgeloeste
 * Ziel NICHT ein — nur Quelle, Art, geschriebener Zielname, Qualifizierer und
 * die laufende Nummer identischer Vorkommen.
 */
export function buildSymbolEdgeId(input: {
  workspaceId: string;
  fromSymbolId: string;
  edgeKind: string;
  toName: string;
  /** Fehlender Qualifizierer nimmt als leerer String teil (dokumentiert). */
  toQualifier?: string;
  occurrenceOrdinal: number;
}): string {
  assertNonEmpty(input.workspaceId, "workspaceId");
  assertNonEmpty(input.fromSymbolId, "fromSymbolId");
  assertNonEmpty(input.edgeKind, "edgeKind");
  assertNonEmpty(input.toName, "toName");
  if (!Number.isInteger(input.occurrenceOrdinal) || input.occurrenceOrdinal < 0) {
    throw new Error(
      `symbol edge occurrenceOrdinal must be a non-negative integer, got ${input.occurrenceOrdinal}`,
    );
  }
  return uuidv5(
    joinIdName("symbol_edge", [
      input.workspaceId,
      input.fromSymbolId,
      input.edgeKind,
      input.toName,
      input.toQualifier ?? "",
      String(input.occurrenceOrdinal),
    ]),
  );
}

/**
 * Felder einer normalisierten Suchanfrage, die den Fingerabdruck NICHT
 * beeinflussen — die AUSNAHMELISTE, nicht die Einschlussliste.
 *
 * WARUM AUSNAHMELISTE UND NICHT EINSCHLUSSLISTE: Eine Einschlussliste laesst
 * jedes spaeter ergaenzte Feld stillschweigend heraus. Genau so ist es
 * passiert — `minScore`, `diversify` und `workspaceId` stehen laengst in
 * `SearchQueryV1`, veraendern Treffermenge bzw. Score, und fielen trotzdem aus
 * dem Fingerabdruck, weil sie in der Einschlussliste `{text, filters,
 * rankerVersion}` nicht vorkamen. Zwei materiell verschiedene Anfragen trugen
 * damit denselben Schluessel; ein Cache darauf gibt das Ergebnis der falschen
 * Anfrage zurueck. Umgekehrt kostet ein irrtuemlich MITgezaehltes Feld nur
 * einen Cache-Fehltreffer — der Fehler faellt also auf die harmlose Seite.
 *
 * Was hier steht, aendert die DARSTELLUNG des Ergebnisses, nicht die Frage:
 * wie viele Treffer gezeigt werden (`limit`), wie gross der Kandidatenpool war
 * (`candidateLimit`), und ob Inhalt, Graphkontext oder verknuepfte Artefakte
 * mitgeliefert werden. Nur so vergleicht die Findability-Sonde (vision.md §1d)
 * den Rang desselben Symbols ueber Laeufe hinweg.
 */
export const SEARCH_FINGERPRINT_IGNORED_FIELDS: readonly string[] = [
  "schemaVersion",
  "limit",
  "candidateLimit",
  "includeContent",
  "includeGraphContext",
  "includeLinked",
];

/**
 * Fingerabdruck einer normalisierten Suchanfrage:
 * `SHA256(canonical_json(query ohne {@link SEARCH_FINGERPRINT_IGNORED_FIELDS}))`.
 *
 * Der Aufrufer uebergibt die vollstaendige normalisierte Anfrage. Alles, was
 * nicht ausdruecklich als Darstellungsfeld gelistet ist, geht ein — auch
 * `workspaceId`, `minScore` und `diversify`, die alle drei die Treffermenge
 * oder die Rangfolge veraendern.
 *
 * `rankingOptions` ist ADDITIV ergaenzt: ein Abrufkern darf ueber
 * `SearchRequestV1` hinaus Angaben kennen, die die TREFFERMENGE oder die
 * RANGFOLGE veraendern (Suchmodus, Pfadausschluss, Sortierung,
 * Komplexitaets-Bias). Solche Angaben MUESSEN eingehen, sonst tragen zwei
 * materiell verschiedene Anfragen denselben Fingerabdruck — und zwei
 * Findability-Messungen waeren nicht mehr unterscheidbar (vision.md §1d baut
 * die Provenienz der Messung auf genau diesem Wert auf).
 *
 * `canonicalJson` laesst `undefined`-Eigenschaften fallen; ein nicht gesetztes
 * `minScore` verhaelt sich also wie ein fehlendes Feld.
 *
 * ACHTUNG BEI GESPEICHERTEN WERTEN: Fingerabdruecke aus Laeufen VOR dieser
 * Korrektur sind mit den neuen nicht vergleichbar — der Wert war damals
 * schlicht falsch (er unterschied zwei verschiedene Fragen nicht).
 */
export function buildSearchQueryFingerprint<
  T extends {
    text: string;
    rankerVersion: string;
    /** Ergebnisveraendernde Zusatzangaben eines Abrufkerns; siehe oben. */
    rankingOptions?: unknown;
  },
>(query: T): string {
  assertNonEmpty(query.text, "text");
  const ignored = new Set(SEARCH_FINGERPRINT_IGNORED_FIELDS);
  const record = query as unknown as Record<string, unknown>;
  const material: Record<string, unknown> = {};
  for (const field of Object.keys(record)) {
    if (ignored.has(field)) {
      continue;
    }
    material[field] = record[field];
  }
  return sha256Hex(canonicalJson(material));
}

/**
 * Findability-ID: `UUIDv5(workspace_id + symbol_id + algorithm + ranker_version)`.
 *
 * Ein neuer Algorithmus oder eine neue Rangfolge erzeugt einen NEUEN
 * Datensatz statt den alten stillschweigend umzudeuten. Die Generation geht
 * nicht ein: je Symbol und Algorithmusstand gibt es genau einen aktuellen
 * Findability-Datensatz, der pro Generation ersetzt wird.
 */
export function buildFindabilityId(input: {
  workspaceId: string;
  symbolId: string;
  algorithm: string;
  rankerVersion: string;
}): string {
  assertNonEmpty(input.workspaceId, "workspaceId");
  assertNonEmpty(input.symbolId, "symbolId");
  assertNonEmpty(input.algorithm, "algorithm");
  assertNonEmpty(input.rankerVersion, "rankerVersion");
  return uuidv5(
    joinIdName("findability", [
      input.workspaceId,
      input.symbolId,
      input.algorithm,
      input.rankerVersion,
    ]),
  );
}

/**
 * Befund-ID eines externen Werkzeugs (extensions.md §4.3):
 * `UUIDv5(extension_run_id + tool + rule_id + normalized_file_path +
 * start_byte + ordinal_within_identical_location)`.
 */
export function buildExternalFindingId(input: {
  extensionRunId: string;
  tool: string;
  ruleId: string;
  relativePath: string;
  startByte: number;
  ordinalWithinLocation: number;
}): string {
  assertNonEmpty(input.extensionRunId, "extensionRunId");
  assertNonEmpty(input.tool, "tool");
  assertNonEmpty(input.ruleId, "ruleId");
  if (!Number.isInteger(input.startByte) || input.startByte < 0) {
    throw new Error(`finding startByte must be a non-negative integer, got ${input.startByte}`);
  }
  if (!Number.isInteger(input.ordinalWithinLocation) || input.ordinalWithinLocation < 0) {
    throw new Error(
      `finding ordinalWithinLocation must be a non-negative integer, got ${input.ordinalWithinLocation}`,
    );
  }
  return uuidv5(
    joinIdName("external_finding", [
      input.extensionRunId,
      input.tool,
      input.ruleId,
      normalizeRelativePath(input.relativePath),
      String(input.startByte),
      String(input.ordinalWithinLocation),
    ]),
  );
}

/**
 * Normalisiert eine Befundmeldung fuer den Matching-Schluessel: Zeilenumbrueche
 * und Mehrfach-Leerzeichen werden zu einem Leerzeichen, Raender getrimmt. Die
 * Schreibweise bleibt erhalten — zwei Regeln, die sich nur in der Gross-/
 * Kleinschreibung unterscheiden, sind zwei Regeln.
 */
export function normalizeFindingMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

/**
 * Zeilenunabhaengiger Matching-Schluessel zweier Laeufe (extensions.md §4.3):
 * `tool + rule_id + (symbol_id | normalized_file_path) + SHA256(normalized_message)`.
 *
 * Zeilennummern DUERFEN nicht eingehen, sonst erzeugt jede Verschiebung
 * scheinbar neue Befunde. Die Komponenten werden mit U+001F verbunden.
 */
export function buildFindingMatchKey(input: {
  tool: string;
  ruleId: string;
  symbolId?: string;
  relativePath: string;
  message: string;
}): string {
  assertNonEmpty(input.tool, "tool");
  assertNonEmpty(input.ruleId, "ruleId");
  const anchor =
    input.symbolId !== undefined && input.symbolId !== ""
      ? input.symbolId
      : normalizeRelativePath(input.relativePath);
  return joinIdName("finding_match", [
    input.tool,
    input.ruleId,
    anchor,
    sha256Hex(normalizeFindingMessage(input.message)),
  ]);
}
