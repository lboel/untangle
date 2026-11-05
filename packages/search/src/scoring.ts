/**
 * Score-Zerlegung (spec.md §13.3).
 *
 * Das ist keine Debug-Ausgabe. Die Zerlegung ist oeffentliche API und die
 * Grundlage der Findability-Diagnose (vision.md §1d): ohne sie laesst sich
 * „der richtige Treffer rankt niedrig" nicht von „es gibt keinen Treffer"
 * unterscheiden, und genau diese Unterscheidung ist die Aussage ueber den
 * Code, nicht ueber die Suche.
 *
 * Aufbau:
 *
 *     final = base_hybrid
 *           + exact_symbol_boost + exact_path_boost + repo_priority_boost
 *           + graph_proximity_boost + recency_boost
 *           + complexity_modifier
 *           - duplicate_penalty
 *
 * Jeder Bestandteil traegt `rawValue` (das normalisierte Signal), `weight`
 * (das Gewicht aus der Konfiguration) und `contribution = rawValue * weight`.
 * `validateScoreBreakdown()` aus der Domain prueft genau diese Identitaet und
 * die Summenprobe — die Tests dieses Pakets rufen sie auf jedem erzeugten
 * Treffer auf.
 *
 * BEGRENZUNG DER BOOSTS (spec.md §13.3: „Heuristische Boosts DUERFEN
 * Dense/BM25 nicht vollstaendig ueberstimmen"): Uebersteigt die Summe der
 * Betraege aller Nicht-Basis-Bestandteile den Anteil {@link MAX_BOOST_SHARE}
 * des Basisbetrags, werden ALLE Nicht-Basis-Gewichte mit demselben Faktor
 * verkleinert und `clamped`/`clampReason` gesetzt. Verkleinert wird das
 * GEWICHT, nicht der Beitrag: nur so bleibt `contribution = rawValue * weight`
 * wahr und das Signal (`rawValue`) sichtbar.
 */
import type { CodeChunkPayloadV1, ScoreBreakdownV1, ScoreComponentV1 } from "@untangle-code/domain";
import { RANKER_VERSION } from "@untangle-code/domain";

import type { FusionResult } from "./fusion.js";
import type { SearchCandidate } from "./payload.js";
import { readRawNumber } from "./payload.js";
import { matchSymbolName } from "./symbol-match.js";
import type { ComplexityBias } from "./types.js";

/**
 * Hoechster zulaessiger Anteil aller Boosts/Strafen am Basisscore.
 *
 * 0.5 heisst: die Heuristik darf einen Treffer um hoechstens die Haelfte
 * seines Basisscores verschieben. Damit bleibt der Basisanteil (`baseShare`
 * aus `validateScoreBreakdown`) immer bei mindestens 1/1.5 ≈ 0.667 — der
 * Basiszweig behaelt also strukturell die Mehrheit. Der Wert ist eine
 * Politik-Entscheidung dieses Pakets und hier bewusst als benannte Konstante
 * sichtbar statt als Zahl im Code verstreut.
 */
export const MAX_BOOST_SHARE = 0.5;

/**
 * Referenzwert der kognitiven Komplexitaet fuer den Komplexitaets-Modifikator.
 * 25 ist der Punkt, ab dem der Modifikator seinen vollen Ausschlag erreicht;
 * er ist eine Skalierungsgroesse fuer die Rangfolge und ausdruecklich KEINE
 * Qualitaetsschwelle (Schwellen gehoeren in die Quality Gate, spec.md §18).
 */
export const COMPLEXITY_REFERENCE_COGNITIVE = 25;

/** Gewichte der additiven Score-Bestandteile (Form aus `SearchConfig`). */
export interface BoostWeights {
  exactSymbol: number;
  exactPath: number;
  repoPriority: number;
  graphProximity: number;
  recency: number;
  duplicatePenalty: number;
}

/** Gewicht des Komplexitaets-Modifikators, wenn die Anfrage ihn anfordert. */
export const COMPLEXITY_MODIFIER_WEIGHT = 0.1;

/** Alles, was zur Bewertung eines einzelnen Kandidaten gebraucht wird. */
export interface ScoringContext {
  queryText: string;
  weights: BoostWeights;
  complexityBias: ComplexityBias;
  /** Repo-Prioritaet in [0, 1] je `repo_id`; fehlt = kein Bestandteil. */
  repoPriorities: Readonly<Record<string, number>>;
  /** Graph-Naehe in [0, 1] je `symbol_id`; fehlt = kein Bestandteil. */
  graphProximity: ReadonlyMap<string, number>;
  /** „Jetzt" in Epoch-Millisekunden, ueber den Clock-Port bezogen. */
  nowEpochMs?: number;
  /** Halbwertszeit des Recency-Boosts in Tagen. */
  recencyHalfLifeDays: number;
}

function pathBoost(payload: CodeChunkPayloadV1, queryText: string): ScoreComponentV1 | null {
  const query = queryText.trim();
  if (query === "") {
    return null;
  }
  const path = payload.file_path;
  const segments = path.split("/");
  if (path === query) {
    return raw("exact_path_boost", 1, `file_path == "${path}"`);
  }
  if (segments.includes(query)) {
    return raw("exact_path_boost", 0.75, `path segment == "${query}"`);
  }
  if (path.includes(query)) {
    return raw("exact_path_boost", 0.5, `file_path contains "${query}"`);
  }
  return null;
}

function raw(kind: ScoreComponentV1["kind"], rawValue: number, evidence: string): ScoreComponentV1 {
  // `weight` wird erst in `assembleScoreBreakdown` gesetzt; hier steht das
  // rohe Signal mit seinem Beleg.
  return { kind, rawValue, weight: 0, contribution: 0, evidence };
}

/** Zeitzerfall in [0, 1]: 1 heisst „gerade eben", 0.5 nach einer Halbwertszeit. */
export function recencyDecay(ageMs: number, halfLifeDays: number): number {
  if (ageMs <= 0) {
    return 1;
  }
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
  if (halfLifeMs <= 0) {
    return 0;
  }
  return Math.pow(0.5, ageMs / halfLifeMs);
}

/**
 * Komplexitaets-Modifikator in [-1, 1]. Positiv, wenn der Treffer der
 * angeforderten Richtung entspricht.
 */
export function complexityModifierRawValue(
  payload: CodeChunkPayloadV1,
  bias: ComplexityBias,
): number | null {
  if (bias === "none") {
    return null;
  }
  const cognitive = payload.cognitive;
  if (cognitive === undefined) {
    return null;
  }
  const normalized = Math.min(cognitive / COMPLEXITY_REFERENCE_COGNITIVE, 1);
  return bias === "prefer-simple" ? 1 - 2 * normalized : 2 * normalized - 1;
}

/**
 * Baut die vollstaendige Score-Zerlegung eines Kandidaten.
 *
 * `duplicatePenaltyRawValue` kommt aus der Diversifizierung (siehe
 * `diversify.ts`) und ist bereits in [0, 1]; das Vorzeichen setzt diese
 * Funktion, damit die Strafe an genau EINER Stelle negativ wird.
 */
export function assembleScoreBreakdown(
  candidate: SearchCandidate,
  fusion: FusionResult,
  context: ScoringContext,
  duplicatePenaltyRawValue = 0,
): ScoreBreakdownV1 {
  const { payload } = candidate;
  const base: ScoreComponentV1 = {
    kind: "base_hybrid",
    rawValue: fusion.normalized,
    weight: 1,
    contribution: fusion.normalized,
    evidence: describeBranches(fusion),
  };

  const boosts: ScoreComponentV1[] = [];

  const symbolMatch = matchSymbolName(payload, context.queryText);
  if (symbolMatch !== null) {
    boosts.push(
      withWeight(
        raw("exact_symbol_boost", symbolMatch.strength, symbolMatch.evidence),
        context.weights.exactSymbol,
      ),
    );
  }

  const pathComponent = pathBoost(payload, context.queryText);
  if (pathComponent !== null) {
    boosts.push(withWeight(pathComponent, context.weights.exactPath));
  }

  const priority = context.repoPriorities[payload.repo_id];
  if (priority !== undefined && priority !== 0) {
    boosts.push(
      withWeight(
        raw("repo_priority_boost", priority, `configured priority of repo "${payload.repo_id}"`),
        context.weights.repoPriority,
      ),
    );
  }

  const proximity =
    payload.symbol_id === undefined ? undefined : context.graphProximity.get(payload.symbol_id);
  if (proximity !== undefined && proximity !== 0) {
    boosts.push(
      withWeight(
        raw(
          "graph_proximity_boost",
          proximity,
          `graph proximity of symbol "${payload.symbol_id ?? ""}"`,
        ),
        context.weights.graphProximity,
      ),
    );
  }

  const changedAt = readRawNumber(candidate.raw, "changed_at_epoch_ms");
  if (changedAt !== undefined && context.nowEpochMs !== undefined) {
    const decay = recencyDecay(context.nowEpochMs - changedAt, context.recencyHalfLifeDays);
    if (decay > 0) {
      boosts.push(
        withWeight(
          raw("recency_boost", decay, `changed_at_epoch_ms = ${changedAt}`),
          context.weights.recency,
        ),
      );
    }
  }

  const complexityRaw = complexityModifierRawValue(payload, context.complexityBias);
  if (complexityRaw !== null) {
    boosts.push(
      withWeight(
        raw(
          "complexity_modifier",
          complexityRaw,
          `cognitive = ${String(payload.cognitive)} (bias "${context.complexityBias}", reference ${COMPLEXITY_REFERENCE_COGNITIVE})`,
        ),
        COMPLEXITY_MODIFIER_WEIGHT,
      ),
    );
  }

  if (duplicatePenaltyRawValue > 0) {
    boosts.push(
      withWeight(
        raw(
          "duplicate_penalty",
          duplicatePenaltyRawValue,
          `file "${payload.file_path}" is already represented higher in the ranking`,
        ),
        -context.weights.duplicatePenalty,
      ),
    );
  }

  const clamp = clampBoosts(base, boosts);
  const components = [base, ...clamp.boosts];
  const final = components.reduce((sum, component) => sum + component.contribution, 0);

  return {
    schemaVersion: 1,
    final,
    components,
    inputs: {
      ...(candidate.denseScore === undefined ? {} : { dense: candidate.denseScore }),
      ...(candidate.denseRank === undefined ? {} : { denseRank: candidate.denseRank }),
      ...(candidate.lexicalRank === undefined
        ? {}
        : { sparseRank: candidate.lexicalRank, lexicalRank: candidate.lexicalRank }),
      ...(candidate.lexicalScore === undefined ? {} : { lexicalScore: candidate.lexicalScore }),
      ...(candidate.symbolRank === undefined ? {} : { symbolRank: candidate.symbolRank }),
      rrf: fusion.rrf,
    },
    rankerVersion: RANKER_VERSION,
    clamped: clamp.clamped,
    ...(clamp.reason === undefined ? {} : { clampReason: clamp.reason }),
  };
}

function withWeight(component: ScoreComponentV1, weight: number): ScoreComponentV1 {
  return { ...component, weight, contribution: component.rawValue * weight };
}

function describeBranches(fusion: FusionResult): string {
  const parts: string[] = [];
  for (const branch of ["dense", "lexical", "symbol"] as const) {
    const rank = fusion.ranks[branch];
    if (rank !== undefined) {
      const weight = fusion.weights?.[branch];
      parts.push(
        weight === undefined ? `${branch}#${rank}` : `${branch}#${rank} x weight ${weight}`,
      );
    }
  }
  return parts.length === 0 ? "no branch contributed" : `RRF over ${parts.join(", ")}`;
}

interface ClampResult {
  boosts: ScoreComponentV1[];
  clamped: boolean;
  reason?: string;
}

/** Setzt {@link MAX_BOOST_SHARE} durch (siehe Modulkommentar). */
export function clampBoosts(
  base: ScoreComponentV1,
  boosts: readonly ScoreComponentV1[],
): ClampResult {
  const boostMagnitude = boosts.reduce(
    (sum, component) => sum + Math.abs(component.contribution),
    0,
  );
  const baseMagnitude = Math.abs(base.contribution);
  const budget = baseMagnitude * MAX_BOOST_SHARE;
  if (boostMagnitude <= budget || boostMagnitude === 0) {
    return { boosts: [...boosts], clamped: false };
  }
  const factor = budget / boostMagnitude;
  return {
    boosts: boosts.map((component) => ({
      ...component,
      weight: component.weight * factor,
      contribution: component.contribution * factor,
    })),
    clamped: true,
    reason: `boost magnitude ${boostMagnitude.toFixed(6)} exceeded ${MAX_BOOST_SHARE} of the base score ${baseMagnitude.toFixed(6)}; all non-base weights scaled by ${factor.toFixed(6)} (spec.md §13.3)`,
  };
}
