/**
 * grep-artige Suche ueber den indexierten Inhalt (Nutzerwunsch A4).
 *
 * „Beides — semantisch UND grep-artig — unter einer Oberflaeche" heisst hier
 * woertlich: derselbe Port, dieselben Filter, dieselbe Provenienz je Treffer,
 * derselbe Skip-Ledger. Der Unterschied ist nur, WAS gefragt wird — ein
 * Zeichenmuster statt einer Bedeutung.
 *
 * WICHTIG FUER DIE INTERPRETATION DER ERGEBNISSE: Gesucht wird im INDEX, nicht
 * auf der Platte. Was nicht indexiert ist (uebersprungene Datei, Chunk ohne
 * gespeicherten Inhalt), kann hier nicht gefunden werden. Genau deshalb traegt
 * `GrepResultSetV1` den Skip-Ledger und die Zahl der durchsuchten Chunks mit —
 * „keine Treffer" und „nichts durchsucht" duerfen nicht gleich aussehen (E4).
 *
 * Zeilennummern sind ECHTE Dateizeilen: der Chunk kennt seine `start_line`,
 * und die Zeilenzaehlung setzt darauf auf. Kontextzeilen kommen aus demselben
 * Chunk; reicht der Kontext ueber die Chunkgrenze hinaus, endet er dort. Das
 * ist eine bewusste Grenze (siehe README „Bekannte Grenzen") — die
 * Nachbarzeilen liegen in einem anderen Punkt und muessten einzeln nachgeladen
 * werden.
 */
import type {
  FieldCondition,
  PayloadFilter,
  PortCallOptions,
  SkipLedgerEntryV1,
  ToolWarningV1,
  VectorStore,
} from "@untangle-code/domain";
import { compareCodepoints } from "@untangle-code/domain";

import { assertValidGlobPatterns, isPathSelected } from "./glob.js";
import { SearchSkipLedger } from "./ledger.js";
import { readCodeChunkPayload } from "./payload.js";
import { assertSafeGrepPattern } from "./regex-safety.js";
import type { GrepContextLineV1, GrepMatchV1, GrepRequestV1, GrepResultSetV1 } from "./types.js";

/** Voreinstellungen der Budgets — jede Ueberschreitung ist ein benannter Abbruchgrund. */
export const GREP_DEFAULTS = {
  maxMatches: 200,
  maxMatchesPerFile: 50,
  maxScannedChunks: 5000,
  /** Seitengroesse des Scroll-Laufs ueber die Collection. */
  scrollPageSize: 256,
} as const;

/**
 * Wie viele glob-ausgeschlossene Chunks EINZELN im Ledger stehen.
 *
 * Jeder ausgeschlossene Chunk gehoert in den Ledger (E4) — bei einem Budget
 * von 5000 gescannten Chunks waere eine Liste mit 5000 Eintraegen aber selbst
 * ein Problem fuer den Leser. Also: die ersten `GREP_GLOB_LEDGER_DETAIL_LIMIT`
 * einzeln, danach EIN Sammeleintrag mit der vollstaendigen Zahl. Verschwiegen
 * wird nichts; die Zahl stimmt in jedem Fall.
 */
export const GREP_GLOB_LEDGER_DETAIL_LIMIT = 50;

/**
 * Der Geltungsbereich, in dem grep ueberhaupt suchen darf.
 *
 * Dieselbe Begruendung wie bei `SearchScopeV1` in `filter.ts`: ohne Workspace
 * laeuft eine Mustersuche ueber die Chunks JEDES Workspaces, der zufaellig in
 * derselben Collection liegt, und meldet fremden Code als eigenen.
 */
export interface GrepScopeV1 {
  /** Workspace, falls die Anfrage selbst keinen nennt. */
  workspaceId?: string;
  /** Repositories der durchsuchten Collections; leer heisst „nicht deklariert". */
  repoIds?: readonly string[];
}

/** Maskiert einen Literaltext, damit er als regulaerer Ausdruck sich selbst bedeutet. */
export function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Baut den Suchausdruck.
 *
 * `wholeWord` verwendet bewusst Lookarounds ueber Bezeichnerzeichen statt
 * `\b`: `\b` kennt nur ASCII-Wortzeichen, und ein Bezeichner mit Umlaut oder
 * `$` waere damit an der falschen Stelle „ganzes Wort".
 */
export function buildGrepRegExp(request: GrepRequestV1): RegExp {
  const pattern = request.pattern;
  if (pattern === "") {
    throw new Error("grep pattern must not be empty");
  }
  if (request.regex === true) {
    // Das `i`-Flag geht in die Pruefung ein: `(a|A)+` ist ohne `i` eindeutig
    // und mit `i` mehrdeutig. Wer das Flag hier vergisst, prueft ein anderes
    // Muster als das, das gleich laeuft.
    assertSafeGrepPattern(pattern, { caseInsensitive: request.caseSensitive === false });
  }
  const body = request.regex === true ? pattern : escapeRegExpLiteral(pattern);
  const wrapped =
    request.wholeWord === true ? `(?<![\\p{L}\\p{N}_$])(?:${body})(?![\\p{L}\\p{N}_$])` : body;
  const flags = request.caseSensitive === false ? "gui" : "gu";
  try {
    return new RegExp(wrapped, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`grep pattern is not a valid regular expression: ${message}`);
  }
}

function keywordIn(
  field: string,
  values: readonly string[] | undefined,
): FieldCondition | undefined {
  if (values === undefined || values.length === 0) {
    return undefined;
  }
  const unique = [...new Set(values)].sort(compareCodepoints);
  if (unique.length === 1) {
    return { field, match: { eq: unique[0] as string } };
  }
  return { field, match: { in: unique } };
}

/** Der aufgeloeste Geltungsbereich eines grep-Laufs. */
interface ResolvedGrepScope {
  filter: PayloadFilter;
  /** Gesetzt, wenn der Bereich leer ist; dann wird nicht gesucht. */
  emptyScopeReason?: string;
  /** Gesetzt, wenn kein Workspace bekannt ist (Suche ueber alle Workspaces). */
  unscopedWarning?: string;
  /**
   * WP-177: der wirksame Workspace, GETRIMMT — Grundlage der zweiten
   * Verteidigungslinie im Scan. `undefined` heisst „keiner bekannt"; dann
   * steht auch die Warnung oben.
   */
  workspaceId?: string;
  /**
   * WP-177/WP-178: die wirksam erlaubten Repositories (Deklaration geschnitten
   * mit dem Filter der Anfrage). Leer heisst „nicht eingeschraenkt".
   */
  repoIds: string[];
  /**
   * WP-176: angefragte Repositories, die keine der durchsuchten Collections
   * fuehrt. Sie wurden NICHT durchsucht, und das gehoert ins Ergebnis.
   */
  outOfScopeRepoIds: string[];
}

function buildGrepFilter(request: GrepRequestV1, scope: GrepScopeV1 = {}): ResolvedGrepScope {
  const must: FieldCondition[] = [{ field: "point_type", match: { eq: "code_chunk" } }];
  // WP-190, dieselbe Ursache wie in `normalizeSearchQuery`: getrimmt, damit
  // Speicherfilter und Gegenpruefung denselben Wert benutzen.
  const workspaceId = (request.workspaceId ?? scope.workspaceId)?.trim();
  let unscopedWarning: string | undefined;
  if (workspaceId === undefined || workspaceId === "") {
    // E4: „ueber alles gesucht" und „im eigenen Workspace gesucht" duerfen
    // nicht gleich aussehen.
    unscopedWarning =
      "grep ran without a workspaceId; the scan covers every workspace stored in the searched collections";
  } else {
    must.push({ field: "workspace_id", match: { eq: workspaceId } });
  }

  const requested = request.repositories ?? [];
  const declared = scope.repoIds ?? [];
  let repoIds: string[];
  // WP-176: dieselbe Luecke wie bei `search` — angefragte Repositories, die
  // keine Collection fuehrt, fielen lautlos heraus, solange wenigstens EINES
  // uebrig blieb. Nur der vollstaendig leere Durchschnitt kam in den Ledger.
  let outOfScopeRepoIds: string[] = [];
  if (requested.length === 0) {
    repoIds = [...new Set(declared)].sort(compareCodepoints);
  } else if (declared.length === 0) {
    repoIds = [...new Set(requested)].sort(compareCodepoints);
  } else {
    const declaredSet = new Set(declared);
    repoIds = [...new Set(requested.filter((repoId) => declaredSet.has(repoId)))].sort(
      compareCodepoints,
    );
    outOfScopeRepoIds = [...new Set(requested.filter((repoId) => !declaredSet.has(repoId)))].sort(
      compareCodepoints,
    );
    if (repoIds.length === 0) {
      return {
        filter: { must },
        repoIds,
        outOfScopeRepoIds,
        ...(workspaceId === undefined || workspaceId === "" ? {} : { workspaceId }),
        emptyScopeReason: `the requested repositories [${[...new Set(requested)].sort(compareCodepoints).join(", ")}] are not part of the searched collections [${[...declaredSet].sort(compareCodepoints).join(", ")}]; nothing was scanned`,
        ...(unscopedWarning === undefined ? {} : { unscopedWarning }),
      };
    }
  }

  for (const condition of [
    keywordIn("repo_id", repoIds),
    keywordIn("ref_id", request.refs),
    keywordIn("language", request.languages),
  ]) {
    if (condition !== undefined) {
      must.push(condition);
    }
  }
  return {
    filter: { must },
    repoIds,
    outOfScopeRepoIds,
    ...(workspaceId === undefined || workspaceId === "" ? {} : { workspaceId }),
    ...(unscopedWarning === undefined ? {} : { unscopedWarning }),
  };
}

interface RawMatch extends GrepMatchV1 {
  /** Schluessel zur Deduplizierung ueberlappender Fragmente. */
  key: string;
}

function collectMatchesInChunk(
  expression: RegExp,
  text: string,
  startLine: number,
  contextBefore: number,
  contextAfter: number,
): {
  line: number;
  column: number;
  matchText: string;
  lineText: string;
  before: GrepContextLineV1[];
  after: GrepContextLineV1[];
}[] {
  const lines = text.split("\n");
  const results: {
    line: number;
    column: number;
    matchText: string;
    lineText: string;
    before: GrepContextLineV1[];
    after: GrepContextLineV1[];
  }[] = [];
  lines.forEach((lineText, index) => {
    // `lastIndex` je Zeile zuruecksetzen: der Ausdruck ist global, und ein
    // stehengebliebener Zeiger wuerde Treffer in der naechsten Zeile
    // ueberspringen — ein klassischer, still wirkender Fehler.
    expression.lastIndex = 0;
    let match = expression.exec(lineText);
    while (match !== null) {
      const matchText = match[0];
      results.push({
        line: startLine + index,
        column: match.index + 1,
        matchText,
        lineText,
        before: sliceContext(lines, index - contextBefore, index, startLine),
        after: sliceContext(lines, index + 1, index + 1 + contextAfter, startLine),
      });
      if (matchText === "") {
        // Nulllaengen-Treffer wuerden sonst endlos an derselben Stelle stehen.
        expression.lastIndex += 1;
      }
      if (expression.lastIndex > lineText.length) {
        break;
      }
      match = expression.exec(lineText);
    }
  });
  return results;
}

function sliceContext(
  lines: readonly string[],
  from: number,
  to: number,
  startLine: number,
): GrepContextLineV1[] {
  const begin = Math.max(0, from);
  const end = Math.min(lines.length, to);
  const context: GrepContextLineV1[] = [];
  for (let index = begin; index < end; index += 1) {
    context.push({ line: startLine + index, text: lines[index] as string });
  }
  return context;
}

/**
 * Durchsucht die angegebenen Collections mit einem Muster.
 *
 * Der Ablauf ist bewusst ein Scroll und kein `hybridQuery`: eine Regex-Suche
 * hat kein Ranking-Signal, sie hat einen VOLLSTAENDIGKEITSANSPRUCH. Also wird
 * gefiltert und durchlaufen, bis das Budget greift — und wenn es greift, steht
 * das im Ergebnis.
 */
export async function grepIndexedChunks(
  store: VectorStore,
  collections: readonly string[],
  request: GrepRequestV1,
  options?: PortCallOptions,
  scope: GrepScopeV1 = {},
): Promise<GrepResultSetV1> {
  options?.signal?.throwIfAborted();
  const expression = buildGrepRegExp(request);
  const includeGlobsRaw = request.pathGlob ?? [];
  const excludeGlobsRaw = request.pathExclude ?? [];
  // Vor dem ersten Speicherzugriff pruefen: ein fehlerhaftes Muster ist ein
  // Eingabefehler und darf nicht mitten im Scan als Ausfall erscheinen.
  assertValidGlobPatterns(includeGlobsRaw, "pathGlob");
  assertValidGlobPatterns(excludeGlobsRaw, "pathExclude");
  const resolved = buildGrepFilter(request, scope);
  const filter = resolved.filter;
  const ledger = new SearchSkipLedger();
  const warnings: ToolWarningV1[] = [];
  if (resolved.unscopedWarning !== undefined) {
    warnings.push({ code: "WORKSPACE_UNSCOPED", message: resolved.unscopedWarning });
  }

  const maxMatches = request.maxMatches ?? GREP_DEFAULTS.maxMatches;
  const maxMatchesPerFile = request.maxMatchesPerFile ?? GREP_DEFAULTS.maxMatchesPerFile;
  const maxScannedChunks = request.maxScannedChunks ?? GREP_DEFAULTS.maxScannedChunks;
  const contextBefore = Math.max(0, request.contextLinesBefore ?? 0);
  const contextAfter = Math.max(0, request.contextLinesAfter ?? 0);
  const includeGlobs = includeGlobsRaw;
  const excludeGlobs = excludeGlobsRaw;

  const matches: RawMatch[] = [];
  const seen = new Set<string>();
  const perFileCounts = new Map<string, number>();
  let scannedChunks = 0;
  let truncated = false;
  let truncationReason: GrepResultSetV1["truncationReason"];
  let globExcludedChunks = 0;

  if (resolved.emptyScopeReason !== undefined) {
    ledger.add({
      subjectKind: "chunk",
      reason: "excluded_by_configuration",
      detail: resolved.emptyScopeReason,
      recoverable: true,
    });
  }
  if (resolved.outOfScopeRepoIds.length > 0) {
    const detail = `the requested repositories [${resolved.outOfScopeRepoIds.join(", ")}] are not part of the searched collections; they were NOT scanned`;
    warnings.push({
      code: "REPOSITORY_OUT_OF_SCOPE",
      message: detail,
      details: { repoIds: resolved.outOfScopeRepoIds },
    });
    for (const repoId of resolved.outOfScopeRepoIds) {
      ledger.add({
        subjectKind: "chunk",
        subjectId: repoId,
        repoId,
        reason: "excluded_by_configuration",
        detail,
        recoverable: true,
      });
    }
  }

  scan: for (const collection of resolved.emptyScopeReason === undefined ? collections : []) {
    let offset: string | undefined;
    for (;;) {
      options?.signal?.throwIfAborted();
      const page = await store.scroll(
        collection,
        {
          filter,
          limit: GREP_DEFAULTS.scrollPageSize,
          ...(offset === undefined ? {} : { offset }),
        },
        options,
      );
      for (const point of page.points) {
        // Je Chunk pruefen, nicht nur je Seite: eine Seite sind bis zu 256
        // Punkte, und ein Abbruch, der erst danach wirkt, ist keiner.
        options?.signal?.throwIfAborted();
        if (scannedChunks >= maxScannedChunks) {
          truncated = true;
          truncationReason = "max_scanned_chunks";
          ledger.add({
            subjectKind: "chunk",
            subjectId: point.id,
            reason: "time_budget_exceeded",
            detail: `grep stopped after scanning ${maxScannedChunks} chunks; the remainder of "${collection}" was not searched`,
            recoverable: true,
          });
          break scan;
        }
        scannedChunks += 1;
        const read = readCodeChunkPayload(point.payload);
        if (!read.ok) {
          ledger.add({
            subjectKind: "chunk",
            subjectId: point.id,
            reason: "missing_index_entry",
            detail: `point "${point.id}" could not be read as a code chunk: ${read.reason}`,
          });
          continue;
        }
        const payload = read.payload;
        // WP-177 (E4): DIE ZWEITE VERTEIDIGUNGSLINIE, die grep bisher nicht
        // hatte. `search` prueft den Geltungsbereich nach dem Abruf ein
        // zweites Mal, weil ein Speicher, der den Payloadfilter nicht oder
        // anders auswertet, sonst fremden Inhalt als eigenen ausliefert. Fuer
        // grep galt dieselbe Gefahr und keine Pruefung: ein solcher Speicher
        // haette hier Zeilen aus einem fremden Workspace ausgedruckt, ohne
        // Warnung und ohne Ledger-Eintrag. Das ist kein ungenaues Ergebnis,
        // sondern ein Datenleck.
        if (resolved.workspaceId !== undefined && payload.workspace_id !== resolved.workspaceId) {
          ledger.add({
            subjectKind: "chunk",
            subjectId: payload.chunk_id,
            path: payload.file_path,
            repoId: payload.repo_id,
            refId: payload.ref_id,
            reason: "excluded_by_configuration",
            detail: `chunk belongs to workspace "${payload.workspace_id}", but this grep is scoped to workspace "${resolved.workspaceId}" — the store returned it anyway`,
          });
          continue;
        }
        if (resolved.repoIds.length > 0 && !resolved.repoIds.includes(payload.repo_id)) {
          ledger.add({
            subjectKind: "chunk",
            subjectId: payload.chunk_id,
            path: payload.file_path,
            repoId: payload.repo_id,
            refId: payload.ref_id,
            reason: "excluded_by_configuration",
            detail: `chunk belongs to repository "${payload.repo_id}", which is not among the scanned repositories [${resolved.repoIds.join(", ")}] — the store returned it anyway`,
          });
          continue;
        }
        if (!isPathSelected(payload.file_path, includeGlobs, excludeGlobs)) {
          // E4: derselbe Ausschluss, den search() in den Ledger schreibt,
          // gehoert auch hier hinein. Sonst meldet grep 12 durchsuchte Chunks
          // und einen leeren Ledger, obwohl 4 davon nie angesehen wurden.
          globExcludedChunks += 1;
          if (globExcludedChunks <= GREP_GLOB_LEDGER_DETAIL_LIMIT) {
            ledger.add({
              subjectKind: "chunk",
              subjectId: payload.chunk_id,
              path: payload.file_path,
              repoId: payload.repo_id,
              refId: payload.ref_id,
              reason: "excluded_by_configuration",
              detail: `path "${payload.file_path}" does not pass the include/exclude globs (include: [${includeGlobs.join(", ")}], exclude: [${excludeGlobs.join(", ")}])`,
              recoverable: true,
            });
          }
          continue;
        }
        if (read.substitutedFields.includes("start_line")) {
          // Ohne `start_line` zaehlt der Chunk ab Zeile 1 — die gemeldeten
          // Zeilennummern waeren dann falsch, ohne dass man es sieht.
          ledger.add({
            subjectKind: "chunk",
            subjectId: payload.chunk_id,
            path: payload.file_path,
            repoId: payload.repo_id,
            refId: payload.ref_id,
            reason: "missing_index_entry",
            detail:
              "chunk payload carries no start_line; the reported line numbers of its matches count from line 1 of the chunk, not of the file",
            recoverable: true,
          });
        }
        if (payload.content === "") {
          ledger.add({
            subjectKind: "chunk",
            subjectId: payload.chunk_id,
            path: payload.file_path,
            repoId: payload.repo_id,
            refId: payload.ref_id,
            reason: "missing_index_entry",
            detail: "chunk carries no stored content; a regex search cannot inspect it",
          });
          continue;
        }
        const fileKey = `${payload.repo_id}/${payload.ref_id}/${payload.file_id}`;
        for (const found of collectMatchesInChunk(
          expression,
          payload.content,
          payload.start_line,
          contextBefore,
          contextAfter,
        )) {
          const key = `${fileKey}:${found.line}:${found.column}:${found.matchText}`;
          if (seen.has(key)) {
            // Ueberlappende Fragmente desselben Symbols liefern denselben
            // Treffer mehrfach; er zaehlt einmal.
            continue;
          }
          const perFile = perFileCounts.get(fileKey) ?? 0;
          if (perFile >= maxMatchesPerFile) {
            truncated = true;
            truncationReason = truncationReason ?? "max_matches_per_file";
            ledger.add({
              subjectKind: "file",
              subjectId: payload.file_id,
              path: payload.file_path,
              repoId: payload.repo_id,
              refId: payload.ref_id,
              reason: "excluded_by_configuration",
              detail: `more than maxMatchesPerFile=${maxMatchesPerFile} matches in this file; further matches were not returned`,
              recoverable: true,
            });
            break;
          }
          seen.add(key);
          perFileCounts.set(fileKey, perFile + 1);
          matches.push({
            key,
            repoId: payload.repo_id,
            repoLabel: payload.repo_label,
            refId: payload.ref_id,
            refName: payload.ref_name,
            ...(payload.commit_sha === undefined ? {} : { commitSha: payload.commit_sha }),
            fileId: payload.file_id,
            filePath: payload.file_path,
            language: payload.language,
            chunkId: payload.chunk_id,
            ...(payload.symbol_name === undefined ? {} : { symbolName: payload.symbol_name }),
            line: found.line,
            column: found.column,
            matchText: found.matchText,
            lineText: found.lineText,
            before: found.before,
            after: found.after,
          });
          if (matches.length >= maxMatches) {
            truncated = true;
            truncationReason = "max_matches";
            ledger.add({
              subjectKind: "chunk",
              subjectId: payload.chunk_id,
              path: payload.file_path,
              repoId: payload.repo_id,
              refId: payload.ref_id,
              reason: "excluded_by_configuration",
              detail: `grep stopped at maxMatches=${maxMatches}; further matches exist but were not returned`,
              recoverable: true,
            });
            break scan;
          }
        }
      }
      if (page.nextOffset === undefined) {
        break;
      }
      offset = page.nextOffset;
    }
  }

  if (globExcludedChunks > GREP_GLOB_LEDGER_DETAIL_LIMIT) {
    ledger.add({
      subjectKind: "chunk",
      reason: "excluded_by_configuration",
      detail: `${globExcludedChunks} scanned chunks were excluded by the include/exclude globs; the first ${GREP_GLOB_LEDGER_DETAIL_LIMIT} are listed individually above`,
      recoverable: true,
    });
  }

  if (collections.length === 0) {
    warnings.push({
      code: "NO_COLLECTIONS",
      message:
        "grep ran without a single collection to search; the empty result says nothing about the code",
    });
  }

  const sorted = sortGrepMatches(matches, request.sort ?? "path");
  return {
    schemaVersion: 1,
    pattern: request.pattern,
    isRegex: request.regex === true,
    matches: sorted.map(({ key: _key, ...match }) => match),
    totalMatches: sorted.length,
    truncated,
    ...(truncationReason === undefined ? {} : { truncationReason }),
    scannedChunks,
    skipped: ledger.toArray() as SkipLedgerEntryV1[],
    warnings,
  };
}

/** Sortiert grep-Treffer deterministisch. */
export function sortGrepMatches<T extends GrepMatchV1>(
  matches: readonly T[],
  sort: "path" | "matches-desc",
): T[] {
  const byPath = (a: T, b: T): number => {
    const byRepo = compareCodepoints(a.repoId, b.repoId);
    if (byRepo !== 0) {
      return byRepo;
    }
    const byRef = compareCodepoints(a.refId, b.refId);
    if (byRef !== 0) {
      return byRef;
    }
    const byFile = compareCodepoints(a.filePath, b.filePath);
    if (byFile !== 0) {
      return byFile;
    }
    if (a.line !== b.line) {
      return a.line - b.line;
    }
    return a.column - b.column;
  };
  if (sort === "path") {
    return [...matches].sort(byPath);
  }
  const counts = new Map<string, number>();
  for (const match of matches) {
    const key = `${match.repoId}/${match.refId}/${match.fileId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...matches].sort((a, b) => {
    const countA = counts.get(`${a.repoId}/${a.refId}/${a.fileId}`) ?? 0;
    const countB = counts.get(`${b.repoId}/${b.refId}/${b.fileId}`) ?? 0;
    return countA === countB ? byPath(a, b) : countB - countA;
  });
}
