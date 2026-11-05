/**
 * Schluessel der inhaltsadressierten Analyse-Caches (WP-100,
 * docs/INDEX-SHARING.md §5).
 *
 * WARUM DAS HIER STEHT UND NICHT IM CACHE: Den Schluessel bauen ZWEI Seiten —
 * `@untangle-code/core` schlaegt damit nach, `@untangle-code/storage-local`
 * legt damit ab. Zwei Kopien derselben Ableitung waeren die sicherste Art,
 * eines Tages im falschen Eintrag zu landen. Also genau eine, im Paket, das
 * ohnehin jede Identitaet und jede Versionskonstante besitzt.
 *
 * DIE REGEL, DIE ALLES TRAEGT: In den Schluessel gehoert ALLES, wovon der
 * gespeicherte Wert abhaengt. Ein fehlender Bestandteil erzeugt keinen
 * Fehler — er erzeugt ein falsches, unauffaelliges Ergebnis, und das ist die
 * schlimmste Form von E4. Deshalb steht in jedem Schluessel nicht nur die
 * offensichtliche Versionskonstante, sondern jede weitere Eingabe der
 * Berechnung (siehe die einzelnen Begruendungen unten).
 *
 * GRENZE, DIE MAN KENNEN MUSS — DIE IDENTITAET STEHT IM SCHLUESSEL:
 * Die gespeicherten Werte enthalten heute ref-gebundene Bezeichner
 * (`AstRegion.scopeId`, `RawCall.callerScopeId`, `CodeChunkDraft.chunkId`;
 * Ableitung in spec.md §5.5 und §5.6). Sie sind damit NICHT zwischen zwei
 * Refs oder zwei Worktrees teilbar, und der Schluessel sagt das, indem er
 * einen Identitaets-Fingerabdruck traegt. Ein zweiter Lauf ueber DENSELBEN
 * Worktree trifft vollstaendig. Das Teilen ueber Worktrees hinweg verlangt die
 * ref-freie Chunk-Identitaet aus docs/INDEX-SHARING.md §3 (WP-102/WP-103) und
 * wird hier NICHT vorgetaeuscht.
 */
import { sha256Hex } from "./identity.js";

/** Die drei Arten von Zwischenergebnis, die inhaltsadressiert gehalten werden. */
export const ANALYSIS_CACHE_KINDS = ["parse", "chunk", "metrics"] as const;

export type AnalysisCacheKind = (typeof ANALYSIS_CACHE_KINDS)[number];

/**
 * Der Identitaets-Fingerabdruck, der in JEDEN Schluessel gehoert, solange
 * Chunk- und Symbolbezeichner ref-gebunden sind (spec.md §5.5, §5.6).
 */
export interface AnalysisIdentityKeyPartsV1 {
  workspaceId: string;
  repoId: string;
  refId: string;
  fileId: string;
  /** Repo-relativer Pfad, mit Schraegstrichen normalisiert. */
  filePath: string;
  languageId: string;
}

/**
 * Trennzeichen der Schluesselbestandteile. Ein Leerzeichen kommt in keinem
 * Bestandteil vor (Hashes sind hex, Versionen sind Bezeichner, der
 * Identitaetsanteil ist selbst ein Hash), also kann keine Verschiebung
 * zwischen zwei Feldern denselben Schluessel ergeben.
 */
const KEY_SEPARATOR = " ";

function identityFingerprint(identity: AnalysisIdentityKeyPartsV1): string {
  return sha256Hex(
    [
      identity.workspaceId,
      identity.repoId,
      identity.refId,
      identity.fileId,
      identity.filePath,
      identity.languageId,
    ].join(KEY_SEPARATOR),
  );
}

function joinKey(kind: AnalysisCacheKind, parts: readonly string[]): string {
  return [kind, ...parts].join(KEY_SEPARATOR);
}

/** `content_hash + parser_version` plus Sprache und Identitaet (siehe Kopf). */
export function buildParseCacheKey(input: {
  contentHash: string;
  parserVersion: string;
  identity: AnalysisIdentityKeyPartsV1;
}): string {
  return joinKey("parse", [
    input.parserVersion,
    input.contentHash,
    identityFingerprint(input.identity),
  ]);
}

/**
 * `content_hash + chunker_version` — PLUS `parser_version`, weil die Chunks aus
 * den Regionen und Symbolen des Parsers entstehen: eine Parseraenderung
 * veraendert die Chunks, ohne die Chunker-Version zu beruehren. Fehlte sie
 * hier, lieferte der Cache nach einem Parser-Wechsel stillschweigend veraltete
 * Chunks. PLUS ein Fingerabdruck der wirksamen Chunker-Konfiguration
 * (Token-Budget, Kopfzeilen-Kontext, Minified-Erkennung), weil auch sie den
 * Zuschnitt und den vorbereiteten Text veraendert.
 */
export function buildChunkCacheKey(input: {
  contentHash: string;
  chunkerVersion: string;
  parserVersion: string;
  configFingerprint: string;
  identity: AnalysisIdentityKeyPartsV1;
}): string {
  return joinKey("chunk", [
    input.chunkerVersion,
    input.parserVersion,
    input.configFingerprint,
    input.contentHash,
    identityFingerprint(input.identity),
  ]);
}

/**
 * `content_hash + metrics_version` — PLUS `parser_version` (die Fakten kommen
 * aus dem Syntaxbaum) und PLUS die Kennung des Kognitiv-Algorithmus, weil
 * beide den gemessenen Wert veraendern, ohne `METRICS_VERSION` zu beruehren.
 */
export function buildMetricsCacheKey(input: {
  contentHash: string;
  metricsVersion: string;
  parserVersion: string;
  cognitiveAlgorithmId: string;
  identity: AnalysisIdentityKeyPartsV1;
}): string {
  return joinKey("metrics", [
    input.metricsVersion,
    input.parserVersion,
    input.cognitiveAlgorithmId,
    input.contentHash,
    identityFingerprint(input.identity),
  ]);
}
