/**
 * Abbildung der normalisierten Suchfilter auf einen `PayloadFilter`
 * (spec.md §13.2 Schritt 7: „Payloadfilter direkt in Qdrant anwenden").
 *
 * Zentrale Entscheidung dieses Moduls: Es sagt ausdruecklich, WELCHE Filter
 * es NICHT in den Speicher schieben konnte. Ein Filter, den der Speicher
 * nicht kennt (Pfad-Globs, Findability), muss im Prozess nachgezogen werden —
 * und wenn das niemand tut, faellt es hier auf, statt dass die Suche
 * stillschweigend zu viele Treffer liefert.
 */
import type { FieldCondition, PayloadFilter, SearchFiltersV1 } from "@untangle-code/domain";
import { sortByCodepoints } from "@untangle-code/domain";

/** Ein Filter, der nicht in den Speicher geschoben werden konnte. */
export interface ResidualFilter {
  /** Name des Filters, z. B. "pathGlobs". */
  name: string;
  /** Warum er im Speicher nicht ausdrueckbar ist. */
  reason: string;
}

/**
 * Der GELTUNGSBEREICH einer Suche — Workspace und die Repositories, die das
 * angefragte Ziel ueberhaupt enthaelt.
 *
 * Er steht bewusst NICHT in `SearchFiltersV1`: `workspaceId` ist kein Filter,
 * den ein Nutzer setzt oder weglaesst, sondern die Grenze, innerhalb derer die
 * Anfrage ueberhaupt gilt (spec.md §10.4 fuehrt `workspace_id` als
 * Pflicht-Keyword-Index genau dafuer). Weil er ein PFLICHTPARAMETER dieser
 * Funktion ist, kann ihn kein Aufrufer vergessen — das ist der eigentliche
 * Grund fuer diese Form.
 */
export interface SearchScopeV1 {
  /** Workspace der normalisierten Anfrage; darf nicht leer sein. */
  workspaceId: string;
  /**
   * Repositories, die das Ziel (die Collection) enthaelt
   * (`ProfileTargetV1.repoIds`). Leer heisst „nicht deklariert" und schraenkt
   * dann nichts ein — wie eine leere Filterliste in `SearchFiltersV1`.
   */
  targetRepoIds?: readonly string[];
}

export interface BuiltPayloadFilter {
  filter: PayloadFilter;
  /** Filter, die der Aufrufer NACH dem Abruf selbst anwenden muss. */
  residual: ResidualFilter[];
  /**
   * Die Repositories, aus denen dieses Ziel Treffer liefern KANN: der
   * Durchschnitt aus Anfragefilter und Ziel-Repositories. Leer heisst „nicht
   * eingeschraenkt". Der Aufrufer meldet damit die Herkunft der Ergebnisgruppe,
   * statt die deklarierten Ziel-Repositories ungeprueft zu wiederholen.
   */
  scopeRepoIds: string[];
  /**
   * Gesetzt, wenn der Geltungsbereich LEER ist (die angefragten Repositories
   * liegen saemtlich ausserhalb des Ziels). Dann darf der Aufrufer den Speicher
   * NICHT fragen: eine leere `in`-Liste waere kein Filter, sondern gar keiner —
   * die Suche liefe ueber die ganze Collection. Der Text ist die Begruendung
   * fuer den Skip-Ledger.
   */
  emptyScopeReason?: string;
  /**
   * WP-176: die ANGEFRAGTEN Repositories, die dieses Ziel nicht enthaelt und
   * die deshalb hier nicht durchsucht wurden. Leer heisst „alles Angefragte
   * lag im Ziel". Der Aufrufer MUSS sie melden — sie sind der Unterschied
   * zwischen „in a und b gesucht" und „nur in a gesucht".
   */
  outOfScopeRepoIds: string[];
}

/**
 * Durchschnitt zweier Repo-Listen; leere Liste heisst „keine Einschraenkung".
 *
 * WP-176: `dropped` nennt die ANGEFRAGTEN Repositories, die das Ziel gar nicht
 * enthaelt. Frueher fiel diese Menge lautlos aus dem Durchschnitt heraus und
 * nur der VOLLSTAENDIG leere Fall kam in den Ledger — wer `--repo=a,b` fragte
 * und ein Ziel nur `a` fuehrt, bekam Treffer aus `a` und kein Wort darueber,
 * dass `b` nie durchsucht wurde. Das ist derselbe Fehler wie ein leeres
 * Ergebnis ohne Grund, nur schwerer zu bemerken: er sieht wie ein Erfolg aus.
 */
function intersectRepoIds(
  requested: readonly string[],
  target: readonly string[],
): { repoIds: string[]; dropped: string[]; empty: boolean } {
  if (requested.length === 0) {
    return { repoIds: sortByCodepoints([...target]), dropped: [], empty: false };
  }
  if (target.length === 0) {
    return { repoIds: sortByCodepoints([...requested]), dropped: [], empty: false };
  }
  const targetSet = new Set(target);
  const shared = requested.filter((repoId) => targetSet.has(repoId));
  const dropped = requested.filter((repoId) => !targetSet.has(repoId));
  return {
    repoIds: sortByCodepoints(shared),
    dropped: sortByCodepoints(dropped),
    empty: shared.length === 0,
  };
}

function keywordIn(field: string, values: readonly string[]): FieldCondition | undefined {
  if (values.length === 0) {
    return undefined;
  }
  if (values.length === 1) {
    return { field, match: { eq: values[0] as string } };
  }
  return { field, match: { in: [...values] } };
}

function range(
  field: string,
  min: number | undefined,
  max: number | undefined,
): FieldCondition | undefined {
  if (min === undefined && max === undefined) {
    return undefined;
  }
  return {
    field,
    range: {
      ...(min === undefined ? {} : { gte: min }),
      ...(max === undefined ? {} : { lte: max }),
    },
  };
}

/**
 * Baut den Speicherfilter aus dem Geltungsbereich und den normalisierten Filtern.
 *
 * `point_type = "code_chunk"` steht IMMER drin: eine Code-Collection kann
 * neben Chunks auch andere Punktarten enthalten, und ein Treffer, der kein
 * Chunk ist, hat in einer Trefferliste nichts verloren (spec.md §10.3/§10.4).
 *
 * `workspace_id` steht EBENSO IMMER drin. Eine Collection kann Chunks mehrerer
 * Workspaces tragen — der Dedupe-Schluessel dieses Pakets rechnet selbst damit —
 * und ein Treffer aus einem fremden Workspace waere kein ungenauer Treffer,
 * sondern ein fremder Inhalt, ausgegeben als eigener. Deshalb ist der
 * Geltungsbereich ein Pflichtparameter und keine Option.
 */
export function buildPayloadFilter(
  filters: SearchFiltersV1,
  scope: SearchScopeV1,
): BuiltPayloadFilter {
  const workspaceId = scope.workspaceId.trim();
  if (workspaceId === "") {
    throw new Error(
      "buildPayloadFilter requires a non-empty workspaceId: without it the store filter would span every workspace in the collection",
    );
  }
  const must: FieldCondition[] = [
    { field: "point_type", match: { eq: "code_chunk" } },
    { field: "workspace_id", match: { eq: workspaceId } },
  ];
  const residual: ResidualFilter[] = [];

  const scoped = intersectRepoIds(filters.repoIds, scope.targetRepoIds ?? []);
  if (scoped.empty) {
    return {
      filter: { must },
      residual,
      scopeRepoIds: [],
      outOfScopeRepoIds: scoped.dropped,
      emptyScopeReason: `the requested repositories [${filters.repoIds.join(", ")}] are not part of this target's repositories [${sortByCodepoints([...(scope.targetRepoIds ?? [])]).join(", ")}]; this target was not searched`,
    };
  }

  const conditions = [
    keywordIn("repo_id", scoped.repoIds),
    keywordIn("ref_id", filters.refIds),
    keywordIn("language", filters.languages),
    keywordIn("symbol_name", filters.symbolNames),
    keywordIn("symbol_kind", filters.symbolKinds),
    keywordIn("chunk_kind", filters.chunkKinds),
    filters.commitSha === undefined
      ? undefined
      : ({ field: "commit_sha", match: { eq: filters.commitSha } } satisfies FieldCondition),
  ];
  for (const condition of conditions) {
    if (condition !== undefined) {
      must.push(condition);
    }
  }

  const complexity = filters.complexity;
  const complexityConditions =
    complexity === undefined
      ? []
      : [
          range("cyclomatic_extended", complexity.cyclomaticMin, complexity.cyclomaticMax),
          range("cognitive", complexity.cognitiveMin, complexity.cognitiveMax),
          range("risk_score", complexity.riskMin, complexity.riskMax),
        ];
  for (const condition of complexityConditions) {
    if (condition !== undefined) {
      must.push(condition);
    }
  }

  if (filters.changed !== undefined) {
    const since = Date.parse(filters.changed.since);
    const until =
      filters.changed.until === undefined ? undefined : Date.parse(filters.changed.until);
    // Ein unlesbarer Zeitstempel wuerde als NaN in die Bereichsbedingung
    // wandern; je nach Speicher filtert das dann alles oder nichts, in beiden
    // Faellen ohne Hinweis. Lieber ablehnen (E4).
    if (Number.isNaN(since)) {
      throw new Error(
        `search query filter "changed.since" is not a valid ISO-8601 timestamp: "${filters.changed.since}"`,
      );
    }
    if (until !== undefined && Number.isNaN(until)) {
      throw new Error(
        `search query filter "changed.until" is not a valid ISO-8601 timestamp: "${String(filters.changed.until)}"`,
      );
    }
    // `changed_at_epoch_ms` ist der numerische Index aus spec.md §10.4. Punkte
    // ohne dieses Feld erfuellen eine Bereichsbedingung nicht und fallen damit
    // heraus — das ist gewollt und in der README vermerkt: „seit X geaendert"
    // ist ohne Aenderungsdatum nicht beantwortbar, und ein stilles Durchwinken
    // waere eine falsche Antwort.
    must.push({
      field: "changed_at_epoch_ms",
      range: {
        gte: since,
        ...(until === undefined ? {} : { lt: until }),
      },
    });
  }

  if (filters.pathGlobs.length > 0) {
    residual.push({
      name: "pathGlobs",
      reason:
        "the vector store's payload filter matches exact values and ranges only, not glob patterns",
    });
  }
  if (filters.findability !== undefined) {
    residual.push({
      name: "findability",
      reason: "findability is derived per symbol and is not part of the stored chunk payload",
    });
  }

  return {
    filter: { must },
    residual,
    scopeRepoIds: scoped.repoIds,
    outOfScopeRepoIds: scoped.dropped,
  };
}

/**
 * Zusaetzlicher Filter fuer den Zweig der exakten Symbolnamen: nur Punkte,
 * deren `symbol_name` einem der Kandidaten entspricht.
 */
export function buildSymbolNameFilter(
  base: PayloadFilter,
  symbolNames: readonly string[],
): PayloadFilter | undefined {
  const condition = keywordIn("symbol_name", symbolNames);
  if (condition === undefined) {
    return undefined;
  }
  return { ...base, must: [...(base.must ?? []), condition] };
}
