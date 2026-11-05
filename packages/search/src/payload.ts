/**
 * Lesen und Pruefen des gespeicherten Chunk-Payloads (spec.md §10.3).
 *
 * Der `VectorStore`-Port liefert `payload?: Record<string, unknown>` — also
 * ungetypte Daten aus dem Speicher. Sie hier EINMAL zu pruefen und danach mit
 * `CodeChunkPayloadV1` weiterzuarbeiten ist der Unterschied zwischen einem
 * Treffer, dem man ansieht warum er unvollstaendig ist, und einem `undefined`,
 * das drei Stufen spaeter als leeres Feld auftaucht.
 *
 * E4: Ein Punkt mit unbrauchbarem Payload wird NICHT stillschweigend
 * uebersprungen. `readCodeChunkPayload` liefert den Grund als Text zurueck,
 * und der Aufrufer schreibt ihn in den Skip-Ledger.
 */
import type { CodeChunkPayloadV1, ParseQuality, ScoredPointV1 } from "@untangle-code/domain";
import { sortByCodepoints } from "@untangle-code/domain";

/** Pflichtfelder, ohne die ein Treffer keine belastbare Provenienz hat. */
const REQUIRED_STRING_FIELDS = [
  "point_type",
  "workspace_id",
  "repo_id",
  "ref_id",
  "file_id",
  "file_path",
  "chunk_id",
  "metrics_scope_id",
] as const;

const PARSE_QUALITIES: readonly ParseQuality[] = ["complete", "partial", "failed"];

/**
 * Ergebnis des Payload-Lesens: entweder ein Chunk oder ein benannter Grund.
 *
 * `substitutedFields` ist der zweite Teil der Ehrlichkeit (E4): ein Payload
 * kann LESBAR sein und trotzdem Felder vermissen lassen, die dann durch
 * dokumentierte Ersatzwerte gefuellt werden. Ohne diese Liste sieht der
 * Treffer in jedem Feld vollstaendig aus — und genau das ist die stille
 * Beschoenigung, die E4 verbietet. Die Liste ist nach Codepoints sortiert und
 * leer, wenn nichts ersetzt wurde.
 */
export type PayloadReadResult =
  | { ok: true; payload: CodeChunkPayloadV1; substitutedFields: string[] }
  | { ok: false; reason: string };

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Prueft einen rohen Payload auf die Felder, die der Abrufkern braucht, und
 * fuellt fehlende OPTIONALE Felder mit dokumentierten Ersatzwerten:
 * `repo_label` faellt auf `repo_id` zurueck, `ref_name` auf `ref_id`,
 * `language` auf `"unknown"`, `parse_quality` auf `"failed"` (nicht auf
 * `"complete"` — eine unbekannte Parsequalitaet als vollstaendig auszugeben
 * waere genau die stille Beschoenigung, die BUILD_PLAN E4 verbietet).
 *
 * JEDER dieser Ersatzwerte wird in `substitutedFields` genannt. Der Aufrufer
 * traegt die Liste weiter (`SearchHitV1.incompletePayloadFields`), damit ein
 * Leser den geratenen Wert vom gespeicherten unterscheiden kann.
 *
 * Der BEREICH ist davon ausgenommen: ein fehlendes `end_line` faellt auf
 * `start_line` zurueck, ein fehlendes `end_byte` auf `start_byte` — nie auf 0,
 * denn ein `SourceRange` mit `endByte < startByte` ist nicht ungenau, sondern
 * UNGUELTIG; wer damit eine Datei aufschneidet, bekommt die falsche Stelle.
 * Ist ein Bereich im gespeicherten Payload selbst ungueltig, wird der Punkt
 * abgelehnt statt zurechtgebogen.
 */
export function readCodeChunkPayload(raw: Record<string, unknown> | undefined): PayloadReadResult {
  if (raw === undefined) {
    return { ok: false, reason: "point carries no payload (query ran with withPayload=false?)" };
  }
  const missing = REQUIRED_STRING_FIELDS.filter((field) => readString(raw, field) === undefined);
  if (missing.length > 0) {
    return { ok: false, reason: `payload is missing required field(s): ${missing.join(", ")}` };
  }
  const pointType = readString(raw, "point_type") as string;
  if (pointType !== "code_chunk") {
    return { ok: false, reason: `payload point_type is "${pointType}", expected "code_chunk"` };
  }
  const substituted: string[] = [];
  const parseQualityRaw = readString(raw, "parse_quality");
  const parseQuality: ParseQuality = PARSE_QUALITIES.includes(parseQualityRaw as ParseQuality)
    ? (parseQualityRaw as ParseQuality)
    : "failed";
  if (parseQualityRaw === undefined || parseQuality !== parseQualityRaw) {
    substituted.push("parse_quality");
  }
  const repoId = readString(raw, "repo_id") as string;
  const refId = readString(raw, "ref_id") as string;

  const range = readSourceRange(raw, substituted);
  if (!range.ok) {
    return { ok: false, reason: range.reason };
  }
  const { startLine, endLine, startByte, endByte } = range;

  // Pflichtfelder zuerst, Optionale danach EINZELN zuweisen: eine Kette aus
  // bedingten Spreads erzeugt unter `exactOptionalPropertyTypes` einen
  // Uniontyp, den der Compiler ab etwa einem Dutzend Feldern nicht mehr
  // darstellen kann (TS2590). Die Zuweisungsform ist ausserdem leichter zu
  // lesen und laesst keinen Zweifel, welches Feld optional ist.
  const payload: CodeChunkPayloadV1 = {
    schema_version: 1,
    point_type: "code_chunk",
    workspace_id: readString(raw, "workspace_id") as string,
    repo_id: repoId,
    repo_label: stringOrSubstitute(raw, "repo_label", repoId, substituted),
    ref_id: refId,
    ref_name: stringOrSubstitute(raw, "ref_name", refId, substituted),
    file_id: readString(raw, "file_id") as string,
    file_path: readString(raw, "file_path") as string,
    file_hash: stringOrSubstitute(raw, "file_hash", "", substituted),
    language: stringOrSubstitute(raw, "language", "unknown", substituted),
    parse_quality: parseQuality,
    chunk_id: readString(raw, "chunk_id") as string,
    chunk_kind: stringOrSubstitute(raw, "chunk_kind", "fallback_lines", substituted),
    chunk_ordinal: numberOrSubstitute(raw, "chunk_ordinal", 0, substituted),
    start_line: startLine,
    end_line: endLine,
    start_byte: startByte,
    end_byte: endByte,
    content: stringOrSubstitute(raw, "content", "", substituted),
    content_hash: stringOrSubstitute(raw, "content_hash", "", substituted),
    parser_version: stringOrSubstitute(raw, "parser_version", "", substituted),
    chunker_version: stringOrSubstitute(raw, "chunker_version", "", substituted),
    metrics_version: stringOrSubstitute(raw, "metrics_version", "unknown", substituted),
    embedding_profile_id: stringOrSubstitute(raw, "embedding_profile_id", "", substituted),
    // Altindizes bleiben lesbar, aber der Ersatz steht sichtbar im
    // Unvollstaendigkeitsledger. Fuer die echte Trefferprovenienz liest der
    // Abrufkern weiterhin das unveraenderte `raw`-Objekt; "unknown" wird
    // dadurch nie als gespeicherte Generation ausgegeben.
    generation_id: stringOrSubstitute(raw, "generation_id", "unknown", substituted),
    embedding_truncated: raw["embedding_truncated"] === true,
    metrics_scope: stringOrSubstitute(
      raw,
      "metrics_scope",
      "chunk",
      substituted,
    ) as CodeChunkPayloadV1["metrics_scope"],
    metrics_scope_id: readString(raw, "metrics_scope_id") as string,
  };

  assignOptionalString(payload, "commit_sha", readString(raw, "commit_sha"));
  assignOptionalString(payload, "symbol_id", readString(raw, "symbol_id"));
  assignOptionalString(payload, "symbol_name", readString(raw, "symbol_name"));
  assignOptionalString(payload, "symbol_fqn", readString(raw, "symbol_fqn"));
  assignOptionalString(payload, "symbol_kind", readString(raw, "symbol_kind"));
  assignOptionalString(payload, "signature", readString(raw, "signature"));
  assignOptionalString(payload, "ast_hash", readString(raw, "ast_hash"));
  assignOptionalNumber(payload, "fragment_index", readNumber(raw, "fragment_index"));
  assignOptionalNumber(payload, "fragment_count", readNumber(raw, "fragment_count"));
  assignOptionalNumber(payload, "cyclomatic_classic", readNumber(raw, "cyclomatic_classic"));
  assignOptionalNumber(payload, "cyclomatic_extended", readNumber(raw, "cyclomatic_extended"));
  assignOptionalNumber(payload, "cognitive", readNumber(raw, "cognitive"));
  assignOptionalNumber(payload, "max_nesting", readNumber(raw, "max_nesting"));
  assignOptionalNumber(payload, "sloc", readNumber(raw, "sloc"));
  assignOptionalNumber(payload, "halstead_volume", readNumber(raw, "halstead_volume"));
  assignOptionalNumber(payload, "maintainability_index", readNumber(raw, "maintainability_index"));
  assignOptionalNumber(payload, "risk_score", readNumber(raw, "risk_score"));

  return { ok: true, payload, substitutedFields: sortByCodepoints(substituted) };
}

/**
 * Liest den Quellbereich und lehnt einen ungueltigen ab.
 *
 * Fehlende Enden werden auf den ANFANG gesetzt (leerer, aber gueltiger
 * Bereich) und gemeldet; ein gespeichertes Ende VOR dem Anfang ist dagegen
 * kaputte Provenienz und wird nicht stillschweigend repariert.
 */
function readSourceRange(
  raw: Record<string, unknown>,
  substituted: string[],
):
  | { ok: true; startLine: number; endLine: number; startByte: number; endByte: number }
  | { ok: false; reason: string } {
  const startLine = numberOrSubstitute(raw, "start_line", 1, substituted);
  const startByte = numberOrSubstitute(raw, "start_byte", 0, substituted);
  const endLine = numberOrSubstitute(raw, "end_line", startLine, substituted);
  const endByte = numberOrSubstitute(raw, "end_byte", startByte, substituted);
  // WP-191: „nicht ganzzahlig" und „liegt vor dem Anfang" sind ZWEI Befunde,
  // und der Ledger nennt den, der wirklich zutrifft. Zusammengefasst meldete
  // ein `end_line` von 12.5 bei `start_line` 3 „12.5 is before start_line 3" —
  // eine Begruendung, die der Zahl offen widerspricht. Wer so etwas liest,
  // sucht den Fehler an der falschen Stelle, und genau dafuer ist ein Ledger
  // nicht da.
  if (!Number.isInteger(startLine)) {
    return {
      ok: false,
      reason: `payload has a non-integer start_line (${startLine}); line numbers are whole numbers`,
    };
  }
  if (startLine < 1) {
    return {
      ok: false,
      reason: `payload has an invalid start_line (${startLine}); lines are 1-based`,
    };
  }
  if (!Number.isInteger(startByte)) {
    return {
      ok: false,
      reason: `payload has a non-integer start_byte (${startByte}); byte offsets are whole numbers`,
    };
  }
  if (startByte < 0) {
    return { ok: false, reason: `payload has an invalid start_byte (${startByte})` };
  }
  if (!Number.isInteger(endLine)) {
    return {
      ok: false,
      reason: `payload has a non-integer end_line (${endLine}); line numbers are whole numbers`,
    };
  }
  if (endLine < startLine) {
    return {
      ok: false,
      reason: `payload has an invalid source range: end_line ${endLine} is before start_line ${startLine}`,
    };
  }
  if (!Number.isInteger(endByte)) {
    return {
      ok: false,
      reason: `payload has a non-integer end_byte (${endByte}); byte offsets are whole numbers`,
    };
  }
  if (endByte < startByte) {
    return {
      ok: false,
      reason: `payload has an invalid source range: end_byte ${endByte} is before start_byte ${startByte}`,
    };
  }
  return { ok: true, startLine, endLine, startByte, endByte };
}

/** Liest ein Textfeld oder nennt den Ersatzwert beim Namen. */
function stringOrSubstitute(
  raw: Record<string, unknown>,
  key: string,
  fallback: string,
  substituted: string[],
): string {
  const value = readString(raw, key);
  if (value === undefined) {
    substituted.push(key);
    return fallback;
  }
  return value;
}

/** Liest ein Zahlenfeld oder nennt den Ersatzwert beim Namen. */
function numberOrSubstitute(
  raw: Record<string, unknown>,
  key: string,
  fallback: number,
  substituted: string[],
): number {
  const value = readNumber(raw, key);
  if (value === undefined) {
    substituted.push(key);
    return fallback;
  }
  return value;
}

type OptionalStringKey = {
  [K in keyof CodeChunkPayloadV1]-?: string | undefined extends CodeChunkPayloadV1[K] ? K : never;
}[keyof CodeChunkPayloadV1];

type OptionalNumberKey = {
  [K in keyof CodeChunkPayloadV1]-?: number | undefined extends CodeChunkPayloadV1[K] ? K : never;
}[keyof CodeChunkPayloadV1];

function assignOptionalString(
  payload: CodeChunkPayloadV1,
  key: OptionalStringKey,
  value: string | undefined,
): void {
  if (value !== undefined) {
    (payload as unknown as Record<string, unknown>)[key] = value;
  }
}

function assignOptionalNumber(
  payload: CodeChunkPayloadV1,
  key: OptionalNumberKey,
  value: number | undefined,
): void {
  if (value !== undefined) {
    (payload as unknown as Record<string, unknown>)[key] = value;
  }
}

/**
 * Ein Kandidat des Abrufkerns: gepruefter Payload plus die Rohsignale, mit
 * denen ihn der Speicher geliefert hat.
 */
export interface SearchCandidate {
  /** Punkt-ID im Vektorspeicher. */
  pointId: string;
  payload: CodeChunkPayloadV1;
  /**
   * Der rohe Payload, unveraendert. `CodeChunkPayloadV1` beschreibt die
   * Pflichtfelder aus spec.md §10.3; Felder, die spec.md §10.4 zusaetzlich
   * indiziert (etwa `changed_at_epoch_ms`) oder die eine spaetere Generation
   * hinzufuegt (`generation_id`), gehen dadurch NICHT verloren.
   */
  raw: Record<string, unknown>;
  /** Cosine-Score des dichten Zweigs, sofern der Kandidat dort auftauchte. */
  denseScore?: number;
  /** 1-basierter Rang im dichten Zweig. */
  denseRank?: number;
  /** Roher BM25-Wert des lexikalischen Zweigs (in diesem Paket berechnet). */
  lexicalScore?: number;
  /** 1-basierter Rang im lexikalischen Zweig. */
  lexicalRank?: number;
  /** 1-basierter Rang im Zweig der exakten Symbolnamen-Treffer. */
  symbolRank?: number;
  /** Staerke des Symbolnamen-Treffers in [0, 1] (siehe `symbol-match.ts`). */
  symbolMatchStrength?: number;
  /** Beleg des Symbolnamen-Treffers, z. B. `symbol_name == "charge"`. */
  symbolMatchEvidence?: string;
  /**
   * Payload-Felder, die im Speicher fehlten und durch Ersatzwerte gefuellt
   * wurden (siehe {@link PayloadReadResult}). Leer heisst „nichts ersetzt".
   */
  substitutedFields: string[];
}

/** Baut aus einem Speicherpunkt einen Kandidaten oder nennt den Grund. */
export function candidateFromPoint(
  point: ScoredPointV1,
): { ok: true; candidate: SearchCandidate } | { ok: false; reason: string } {
  const read = readCodeChunkPayload(point.payload);
  if (!read.ok) {
    return { ok: false, reason: read.reason };
  }
  return {
    ok: true,
    candidate: {
      pointId: point.id,
      payload: read.payload,
      raw: point.payload ?? {},
      substitutedFields: read.substitutedFields,
    },
  };
}

/** Liest ein zusaetzliches Zahlenfeld aus dem rohen Payload (z. B. `changed_at_epoch_ms`). */
export function readRawNumber(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Liest ein zusaetzliches Textfeld aus dem rohen Payload (z. B. `generation_id`). */
export function readRawString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Der Text, gegen den der lexikalische Zweig rankt. Bewusst mehr als nur der
 * Inhalt: Pfad und Symbolnamen gehoeren zum Suchgegenstand, sonst findet
 * „PaymentService charge" den Treffer nur, wenn beide Woerter zufaellig im
 * Rumpf stehen (spec.md §8.6 nennt fuer den BM25-Text genau diese Bestand-
 * teile: Code, Pfad, Symbolnamen, Bezeichner).
 */
export function lexicalDocumentText(payload: CodeChunkPayloadV1): string {
  const parts = [
    payload.file_path,
    payload.symbol_name ?? "",
    payload.symbol_fqn ?? "",
    payload.signature ?? "",
    payload.content,
  ];
  return parts.filter((part) => part !== "").join("\n");
}
