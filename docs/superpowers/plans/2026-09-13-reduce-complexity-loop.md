# `untangle reduce-complexity` — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Loop `start → propose → select → verify → report` als CLI-Befehl, der aus dem stehenden Index eine Fähigkeitskarte baut, Kandidaten vorschlägt und nach einem Reindex fail-closed urteilt, ob Komplexität bei erhaltener Fähigkeitsabdeckung gesunken ist.

**Architecture:** Ein neues Paket `packages/capability-map` (reine Datenfunktionen: Karte, Wiederfinden, Kandidaten, Ratsche, Sitzungsautomat) über Domain-Verträgen in `packages/domain`. Persistenz erbt die Journey-Maschinerie: der bestehende `LocalSearchJourneyStore` wird zu einem generischen `LocalRevisionedRecordStore<T>` verallgemeinert, den Journeys, Reduce-Sitzungen und Karten gemeinsam benutzen. Die CLI verdrahtet Index-Zustand, Qdrant, Graphen und Speicher in einem `ReduceContext`; die Unterbefehle sind Funktionen über diesem Kontext und damit mit In-Memory-Ports testbar.

**Tech Stack:** TypeScript 5.9 (ESM, `composite` project references), vitest 3, pnpm-Workspace, bestehende Ports (`VectorStore`, `GraphStore`, `FileSystemPort`, `LockProvider`), `@untangle-code/testkit` In-Memory-Doubles.

**Spec:** `docs/superpowers/specs/2026-09-08-reduce-complexity-loop-design.md`

## Global Constraints

- **E4 — kein stilles Überspringen.** Jeder nicht eingegangene Gegenstand steht mit Grund in einem Skip-Ledger (Spec §4.6, §8).
- **X3 — externe Befunde gehen in keine Zahl ein.** `corroborated` ist ausschließlich ein Sortierzuschlag (Spec §5).
- **B25 — jeder Vertrag trägt `schemaVersion: 1`** und liegt in `@untangle-code/domain`; die Karte trägt `algorithm: "untangle-capability-map-v1"`.
- **Determinismus:** alle Listen codepoint-sortiert (`compareCodepoints` aus `@untangle-code/domain`); Gleichstände über Codepoint-Ordnung entschieden (Spec §4.1, §4.5).
- **Keine zweite Persistenzschicht** (Spec §3): atomar, Modus `0600`, CAS-Revision, 32 MiB je Record (Karten: 256 MiB), 10.000 Records je Store.
- **Fail-closed** (Spec §3, §6, §8): unvollständige Bindung, gleiche Generation, anderes Embedding-Profil, fehlender Testbericht ⇒ `blocked` mit genanntem Grund, nie ein Urteil aus Teilwissen.
- **Keine Patch-Erzeugung, keine Testausführung** (L5, L7).
- **Schwellen-Startwerte** (Spec §11): `k = 32`, `edgeThreshold = 0.82`, `matchThreshold = 0.90`, `redundancyThreshold = 0.95`, `densityFactor = 3.0`, `cohesionFloor = 0.60`, `maxClusterShare = 0.15`. Jede Ausgabe nennt die Schwellen.
- **Node ≥ 22.12**, Lizenz AGPL-3.0-only, neues Paket muss `pnpm check-publishable` bestehen (LICENSE, NOTICE, README mit Lizenzabschnitt, THIRD_PARTY_LICENSES.md).
- **Commits:** deutsche Betreffzeile im Stil des Repos (`feat: …`, `test: …`), abschließend die Attributionszeilen aus der Sitzung (`Co-Authored-By: …`, `Claude-Session: …`).
- **Vor jedem Commit:** `pnpm -s typecheck && pnpm -s lint && npx vitest run <betroffene Pfade>` grün.
- Im untangle-Repo wird mit `untangle query` gesucht, nicht mit grep; Nichtfinden ist ein Befund.

---

## Dateistruktur

**Neu — `packages/domain`:**
- `src/types/capability.ts` — `CapabilityV1`, `CapabilityMapV1`, `CapabilityThresholdsV1`, `ReduceComplexitySessionV1`, `ReduceCandidateV1`, `RatchetVerdictV1`, `DEFAULT_CAPABILITY_THRESHOLDS`, Validierer.
- `src/versions.ts` — `CAPABILITY_MAP_ALGORITHM_ID` (Ergänzung).
- `src/errors.ts` — `REDUCE_SESSION_NOT_FOUND`, `REDUCE_SESSION_CONFLICT`, `REDUCE_SESSION_INVALID_STATE` (Ergänzung).

**Refactor — `packages/storage-local`:**
- `src/revisioned-record-store.ts` — `LocalRevisionedRecordStore<T>` (extrahiert aus `search-journey-store.ts`).
- `src/search-journey-store.ts` — delegiert; behält `getOrCreateFingerprintKey`.
- `src/reduce-complexity-store.ts` — `LocalReduceComplexityStore` (Sitzungen + Karten).
- `src/layout.ts`, `src/storage.ts`, `src/index.ts` — Verzeichnisse und Verdrahtung.

**Neu — `packages/capability-map`:**
- `src/vectors.ts` — Cosinus, Mittelwert, Base64-Float32.
- `src/collect.ts` — Symbolzentroide und Kosten aus Punkten.
- `src/neighbors.ts` — `NeighborSource` (brute force, vector-store).
- `src/components.ts` — Gegenseitigkeitsgraph, Komponenten, Medoid, Kohäsion, Verteilung.
- `src/map.ts` — `buildCapabilityMap`.
- `src/match.ts` — Wiederfinden (§4.5).
- `src/propose.ts` — Kandidaten (§5).
- `src/test-report.ts` — JUnit-Zusammenfassung.
- `src/ratchet.ts` — Urteil (§6).
- `src/session.ts` — Zustandsübergänge.
- `src/index.ts`.

**Neu — `apps/cli/src/commands/reduce-complexity/`:**
- `context.ts` — `ReduceContext` (Ports) und `openReduceContext` (reale Verdrahtung).
- `map-loader.ts` — Karte je Generation laden oder bauen.
- `verbs.ts` — `runStart`, `runPropose`, `runSelect`, `runVerify`, `runReport`, `runAbandon` über `ReduceContext`.
- `render.ts` — Textausgabe.
- `index.ts` — `reduceComplexityCommand` (Flags, Dispatch).
- `apps/cli/src/index.ts` — Registrierung.

**Docs:** `docs/REDUCE-COMPLEXITY.md` (Kalibrierung, Grenzen), `README.md` (Befehlstabelle), `docs/PARITY.md` (B30/B31/B39), `docs/BUILD_PLAN.md` (Nachtrag).

---

### Task 1: Domain-Verträge

**Files:**
- Create: `packages/domain/src/types/capability.ts`
- Modify: `packages/domain/src/versions.ts` (nach `DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID`)
- Modify: `packages/domain/src/errors.ts:10-31` (`CORE_ERROR_CODES`)
- Modify: `packages/domain/src/index.ts` (Export)
- Test: `packages/domain/src/types/capability.test.ts`

**Interfaces:**
- Produces: alle Typen unten; `DEFAULT_CAPABILITY_THRESHOLDS`; `reduceComplexitySessionValidationIssue(value: unknown): string | null`; `capabilityMapValidationIssue(value: unknown): string | null`; `CAPABILITY_MAP_ALGORITHM_ID = "untangle-capability-map-v1"`.

- [ ] **Step 1: Failing Test schreiben**

```ts
// packages/domain/src/types/capability.test.ts
import { describe, expect, it } from "vitest";

import { CAPABILITY_MAP_ALGORITHM_ID } from "../versions.js";
import {
  DEFAULT_CAPABILITY_THRESHOLDS,
  capabilityMapValidationIssue,
  reduceComplexitySessionValidationIssue,
  type CapabilityMapV1,
  type ReduceComplexitySessionV1,
} from "./capability.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const MAP_ID = "22222222-2222-5222-8222-222222222222";

function session(overrides: Partial<ReduceComplexitySessionV1> = {}): ReduceComplexitySessionV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    sessionId: SESSION_ID,
    workspaceId: "ws",
    status: "open",
    scope: [],
    createdAt: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T10:00:00.000Z",
    baseline: {
      repoId: "repo",
      refId: "repo:main",
      generationId: "33333333-3333-4333-8333-333333333333",
      corpusRevisionFingerprint: "a".repeat(64),
      embeddingProfileId: "b".repeat(64),
      mapId: MAP_ID,
      corpusCognitive: 10,
      testCount: null,
      testReportMissingReason: "kein --test-report bei start",
    },
    ...overrides,
  };
}

function map(overrides: Partial<CapabilityMapV1> = {}): CapabilityMapV1 {
  return {
    schemaVersion: 1,
    algorithm: CAPABILITY_MAP_ALGORITHM_ID,
    mapId: MAP_ID,
    workspaceId: "ws",
    repoId: "repo",
    refId: "repo:main",
    generationId: "33333333-3333-4333-8333-333333333333",
    corpusRevisionFingerprint: "a".repeat(64),
    embeddingProfileId: "b".repeat(64),
    scope: [],
    thresholds: DEFAULT_CAPABILITY_THRESHOLDS,
    capabilities: [],
    distribution: { count: 0, median: 0, p90: 0, max: 0, largestShare: 0 },
    chained: false,
    corpusCognitive: 0,
    cycleSignatures: { symbol: [], file: [] },
    skipped: [],
    determinism: "artifact",
    createdAt: "2026-09-13T10:00:00.000Z",
    ...overrides,
  };
}

describe("DEFAULT_CAPABILITY_THRESHOLDS", () => {
  it("traegt die Startwerte aus Spec §11", () => {
    expect(DEFAULT_CAPABILITY_THRESHOLDS).toEqual({
      k: 32,
      edgeThreshold: 0.82,
      matchThreshold: 0.9,
      redundancyThreshold: 0.95,
      densityFactor: 3,
      cohesionFloor: 0.6,
      maxClusterShare: 0.15,
    });
  });
});

describe("reduceComplexitySessionValidationIssue", () => {
  it("akzeptiert eine gueltige Sitzung", () => {
    expect(reduceComplexitySessionValidationIssue(session())).toBeNull();
  });
  it("nennt einen unbekannten Status", () => {
    expect(reduceComplexitySessionValidationIssue({ ...session(), status: "done" })).toBe(
      'status "done" is not one of open, proposed, selected, verified, closed, abandoned',
    );
  });
  it("verlangt eine ganzzahlige Revision", () => {
    expect(reduceComplexitySessionValidationIssue({ ...session(), revision: 1.5 })).toBe(
      "revision must be a non-negative integer",
    );
  });
  it("verlangt eine vollstaendige Baseline", () => {
    const broken = session();
    expect(
      reduceComplexitySessionValidationIssue({
        ...broken,
        baseline: { ...broken.baseline, generationId: "" },
      }),
    ).toBe("baseline.generationId must be a non-empty string");
  });
  it("verlangt bei testCount null einen Grund", () => {
    const broken = session();
    const { testReportMissingReason: _omit, ...baseline } = broken.baseline;
    expect(reduceComplexitySessionValidationIssue({ ...broken, baseline })).toBe(
      "baseline.testReportMissingReason is required when baseline.testCount is null",
    );
  });
  it("lehnt Nicht-Objekte ab", () => {
    expect(reduceComplexitySessionValidationIssue(null)).toBe("record is not an object");
  });
});

describe("capabilityMapValidationIssue", () => {
  it("akzeptiert eine leere Karte", () => {
    expect(capabilityMapValidationIssue(map())).toBeNull();
  });
  it("verlangt den Algorithmus", () => {
    expect(capabilityMapValidationIssue({ ...map(), algorithm: "other" })).toBe(
      'algorithm must be "untangle-capability-map-v1"',
    );
  });
  it("verlangt Determinismus-Marke artifact", () => {
    expect(capabilityMapValidationIssue({ ...map(), determinism: "recompute" })).toBe(
      'determinism must be "artifact"',
    );
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run packages/domain/src/types/capability.test.ts`
Expected: FAIL — `Cannot find module './capability.js'`

- [ ] **Step 3: Version, Fehlercodes, Verträge schreiben**

In `packages/domain/src/versions.ts` nach `DYNAMIC_SEARCH_COMPLEXITY_ALGORITHM_ID` einfügen:

```ts
/**
 * Version der Faehigkeitskarte (Spec `2026-09-08-reduce-complexity-loop-design.md`
 * §4). Sie steht auf jeder persistierten Karte: eine andere Nachbarschafts-
 * oder Komponentenregel erzeugt neue Karten statt alte umzudeuten.
 */
export const CAPABILITY_MAP_ALGORITHM_ID = "untangle-capability-map-v1" as const;
export type CapabilityMapAlgorithmId = typeof CAPABILITY_MAP_ALGORITHM_ID;
```

In `packages/domain/src/errors.ts` an `CORE_ERROR_CODES` anhängen (nach `"SEARCH_SESSION_INVALID_STATE"`):

```ts
  "REDUCE_SESSION_NOT_FOUND",
  "REDUCE_SESSION_CONFLICT",
  "REDUCE_SESSION_INVALID_STATE",
```

`packages/domain/src/types/capability.ts`:

```ts
/**
 * Vertraege des Loops `untangle reduce-complexity` (Spec
 * docs/superpowers/specs/2026-09-08-reduce-complexity-loop-design.md, §7).
 *
 * Eine FAEHIGKEIT ist ein Cluster semantisch aehnlicher Symbole — kein
 * Feature im Produktsinn (§10). Ihr Anker ist das Medoid-Symbol, ihre
 * Geometrie der Zentroid (L2). Alle Listen sind codepoint-sortiert.
 */
import type { CAPABILITY_MAP_ALGORITHM_ID } from "../versions.js";

import type { QualityImprovementV1 } from "./quality.js";

/** Schwellen der Karte (§11). Jede Ausgabe nennt sie. */
export interface CapabilityThresholdsV1 {
  /** Nachbarn je Symbolzentroid (§4.1 Schritt 2). */
  k: number;
  /** Mindest-Cosinus fuer eine Gegenseitigkeitskante (§4.1 Schritt 3). */
  edgeThreshold: number;
  /** Mindest-Cosinus fuer geometrisches Wiederfinden (§4.5). */
  matchThreshold: number;
  /** Zentroid-Cosinus, ab dem zwei Faehigkeiten als redundant gelten (§5). */
  redundancyThreshold: number;
  /** Vielfaches des Median-cognitive je Symbol fuer `cost_density` (§5). */
  densityFactor: number;
  /** Kohaesion, unter der `low_cohesion` greift (§5). */
  cohesionFloor: number;
  /** Anteil des groessten Clusters am Korpus, ab dem die Karte `chained` ist (§4.2). */
  maxClusterShare: number;
}

export const DEFAULT_CAPABILITY_THRESHOLDS: CapabilityThresholdsV1 = Object.freeze({
  k: 32,
  edgeThreshold: 0.82,
  matchThreshold: 0.9,
  redundancyThreshold: 0.95,
  densityFactor: 3,
  cohesionFloor: 0.6,
  maxClusterShare: 0.15,
});

/** Kosten einer Faehigkeit, alle `untangle-metrics-v1` (§4.4). */
export interface CapabilityCostV1 {
  metricsVersion: string;
  cognitive: number;
  cyclomaticClassic: number;
  cyclomaticExtended: number;
  sloc: number;
}

export interface CapabilityV1 {
  schemaVersion: 1;
  /** `cap:<medoidSymbolId>` — innerhalb einer Karte eindeutig. */
  capabilityId: string;
  medoidSymbolId: string;
  medoidSymbolFqn: string;
  medoidFilePath: string;
  /** Zentroid als Base64 von Float32 little-endian (§4.4). */
  centroid: string;
  dimensions: number;
  /** Codepoint-sortiert. */
  memberSymbolIds: string[];
  /** Mittlerer Cosinus der Mitglieder zum Zentroid; 1 bei einem Mitglied. */
  cohesion: number;
  symbols: number;
  /** Codepoint-sortierte, eindeutige Dateipfade der Mitglieder. */
  files: string[];
  /** Aufgeloeste Kanten von Nicht-Mitgliedern auf Mitglieder. */
  inDegree: number;
  /** Aufgeloeste Kanten von Mitgliedern auf Nicht-Mitglieder. */
  outDegree: number;
  /** BFS-Tiefe der Callee-Erreichbarkeit ab den Mitgliedern, gedeckelt. */
  maxDepth: number;
  /** Zahl der Symbol-SCCs (Groesse > 1 oder Selbstschleife), die ein Mitglied enthalten. */
  cyclesTouched: number;
  /** Symbole aus Testdateien, die ein Mitglied aufrufen (Heuristik, siehe README). */
  testIds: string[];
  /** IDs externer Befunde an Mitgliedern — Evidenz, nie Zahl (X3). */
  externalFindingIds: string[];
  cost: CapabilityCostV1;
  /** Mitglieder ohne Metrik — sie zaehlen mit 0 und stehen im Ledger. */
  membersWithoutMetrics: number;
}

export interface CapabilitySizeDistributionV1 {
  count: number;
  median: number;
  p90: number;
  max: number;
  /** Anteil des groessten Clusters an allen eingegangenen Symbolen. */
  largestShare: number;
}

export type CapabilityMapSkipKind =
  | "symbol_without_embedding"
  | "chunk_without_symbol"
  | "excluded_by_scope"
  | "symbol_without_metrics"
  | "symbol_not_in_graph";

export interface CapabilityMapSkipEntryV1 {
  kind: CapabilityMapSkipKind;
  /** Symbol-ID, Chunk-ID oder Pfad. */
  id: string;
  detail: string;
}

export interface CapabilityMapV1 {
  schemaVersion: 1;
  algorithm: typeof CAPABILITY_MAP_ALGORITHM_ID;
  /** uuidv5 aus Generation und Scope; ein Artefakt je Generation (§4.3). */
  mapId: string;
  workspaceId: string;
  repoId: string;
  refId: string;
  generationId: string;
  corpusRevisionFingerprint: string;
  embeddingProfileId: string;
  /** Globs aus `--scope`; leer = ganzes Repository. */
  scope: string[];
  thresholds: CapabilityThresholdsV1;
  /** Codepoint-sortiert nach `capabilityId`. */
  capabilities: CapabilityV1[];
  distribution: CapabilitySizeDistributionV1;
  /** `largestShare > thresholds.maxClusterShare` (§4.2). */
  chained: boolean;
  /** Summe cognitive ueber eindeutige `metrics_scope_id` aller eingegangenen Symbole (§16.10). */
  corpusCognitive: number;
  /** Zyklen als sortierte Mitgliederlisten, mit "|" verbunden; Basis fuer „neue Zyklen" (L8). */
  cycleSignatures: { symbol: string[]; file: string[] };
  skipped: CapabilityMapSkipEntryV1[];
  /** Determinismus gilt fuer das Artefakt, nicht fuer die Wiederberechnung (§4.3). */
  determinism: "artifact";
  createdAt: string;
}

export type ReduceCandidateSignal = "redundancy" | "cost_density" | "low_cohesion";
export type ReduceCandidateDirection = "merge" | "simplify" | "split";

export interface ReduceCandidateV1 {
  capabilityId: string;
  medoidSymbolFqn: string;
  medoidFilePath: string;
  /** Mitglieder — die Stellen, an denen die Aenderung ansetzt. */
  targetSymbolIds: string[];
  cost: CapabilityCostV1;
  signal: ReduceCandidateSignal;
  direction: ReduceCandidateDirection;
  /** Klartext, z. B. "cognitive 84 ueber 4 Symbole; Median je Symbol 5". */
  rationale: string;
  /** Nur bei `redundancy`: die zweite Faehigkeit und der Zentroid-Cosinus. */
  partnerCapabilityId?: string;
  similarity?: number;
  /** Sortierzuschlag, keine Zahl (X3). */
  corroborated: boolean;
  corroboratingFindingIds: string[];
}

export type ReduceComplexitySessionStatus =
  | "open"
  | "proposed"
  | "selected"
  | "verified"
  | "closed"
  | "abandoned";

export const REDUCE_COMPLEXITY_SESSION_STATUSES: readonly ReduceComplexitySessionStatus[] = [
  "open",
  "proposed",
  "selected",
  "verified",
  "closed",
  "abandoned",
];

export interface ReduceComplexityBaselineV1 {
  repoId: string;
  refId: string;
  generationId: string;
  corpusRevisionFingerprint: string;
  embeddingProfileId: string;
  mapId: string;
  corpusCognitive: number;
  /** Testfaelle laut JUnit-Bericht bei `start`; null, wenn keiner uebergeben wurde. */
  testCount: number | null;
  /** Pflicht bei `testCount: null` (E4). */
  testReportMissingReason?: string;
}

export type RatchetStageName = "preconditions" | "coverage" | "target" | "improvement";
export type RatchetStageStatus = "passed" | "blocked" | "skipped" | "reported";

export interface RatchetStageV1 {
  stage: RatchetStageName;
  status: RatchetStageStatus;
  /** Bei `blocked` mindestens ein Grund; bei `skipped` der Grund des Ueberspringens. */
  reasons: string[];
}

export interface LostCapabilityV1 {
  capabilityId: string;
  medoidSymbolFqn: string;
  lastMedoidSymbolId: string;
  /** Bester erreichter Zentroid-Cosinus; null, wenn die neue Karte leer ist. */
  bestCosine: number | null;
}

export interface RatchetVerdictV1 {
  schemaVersion: 1;
  verdict: "passed" | "blocked";
  stages: RatchetStageV1[];
  lostCapabilities: LostCapabilityV1[];
  recoveredCount: number;
  corpusCognitive: { base: number; head: number; delta: number };
  improvements: QualityImprovementV1[];
  caveats: string[];
  thresholds: CapabilityThresholdsV1;
}

export interface ReduceComplexityVerificationV1 {
  generationId: string;
  corpusRevisionFingerprint: string;
  mapId: string;
  verifiedAt: string;
  verdict: RatchetVerdictV1;
  /** Deklarierte Testentfernung (L6), wenn `--removed-tests` angegeben war. */
  removedTestsReason?: string;
}

export interface ReduceComplexitySessionV1 {
  schemaVersion: 1;
  /** Monotoner CAS-Zaehler, wie bei Search Journeys. */
  revision: number;
  sessionId: string;
  workspaceId: string;
  status: ReduceComplexitySessionStatus;
  goal?: string;
  scope: string[];
  createdAt: string;
  updatedAt: string;
  baseline: ReduceComplexityBaselineV1;
  candidates?: ReduceCandidateV1[];
  selected?: { capabilityId: string; selectedAt: string };
  verification?: ReduceComplexityVerificationV1;
  abandonReason?: string;
}

// ---------------------------------------------------------------------------
// Validierung — strukturell, fuer die Persistenz. Kein Fachurteil.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function baselineIssue(value: unknown): string | null {
  if (!isRecord(value)) return "baseline must be an object";
  for (const key of [
    "repoId",
    "refId",
    "generationId",
    "corpusRevisionFingerprint",
    "embeddingProfileId",
    "mapId",
  ] as const) {
    if (!nonEmptyString(value[key])) return `baseline.${key} must be a non-empty string`;
  }
  if (!isFiniteNumber(value["corpusCognitive"])) return "baseline.corpusCognitive must be a number";
  const testCount = value["testCount"];
  if (testCount !== null && !isNonNegativeInteger(testCount)) {
    return "baseline.testCount must be null or a non-negative integer";
  }
  if (testCount === null && !nonEmptyString(value["testReportMissingReason"])) {
    return "baseline.testReportMissingReason is required when baseline.testCount is null";
  }
  return null;
}

/** Null = strukturell gueltig; sonst der erste Befund als Text. */
export function reduceComplexitySessionValidationIssue(value: unknown): string | null {
  if (!isRecord(value)) return "record is not an object";
  if (value["schemaVersion"] !== 1) return "schemaVersion must be 1";
  if (!isNonNegativeInteger(value["revision"])) return "revision must be a non-negative integer";
  if (!nonEmptyString(value["sessionId"])) return "sessionId must be a non-empty string";
  if (!nonEmptyString(value["workspaceId"])) return "workspaceId must be a non-empty string";
  const status = value["status"];
  if (
    typeof status !== "string" ||
    !(REDUCE_COMPLEXITY_SESSION_STATUSES as readonly string[]).includes(status)
  ) {
    return `status "${String(status)}" is not one of ${REDUCE_COMPLEXITY_SESSION_STATUSES.join(", ")}`;
  }
  if (!isStringArray(value["scope"])) return "scope must be a string array";
  if (!nonEmptyString(value["createdAt"])) return "createdAt must be a non-empty string";
  if (!nonEmptyString(value["updatedAt"])) return "updatedAt must be a non-empty string";
  const baseline = baselineIssue(value["baseline"]);
  if (baseline !== null) return baseline;
  if (value["candidates"] !== undefined && !Array.isArray(value["candidates"])) {
    return "candidates must be an array when present";
  }
  if (value["selected"] !== undefined) {
    const selected = value["selected"];
    if (!isRecord(selected) || !nonEmptyString(selected["capabilityId"])) {
      return "selected.capabilityId must be a non-empty string";
    }
  }
  if (value["verification"] !== undefined) {
    const verification = value["verification"];
    if (!isRecord(verification) || !isRecord(verification["verdict"])) {
      return "verification.verdict must be an object";
    }
  }
  return null;
}

/** Null = strukturell gueltig; sonst der erste Befund als Text. */
export function capabilityMapValidationIssue(value: unknown): string | null {
  if (!isRecord(value)) return "record is not an object";
  if (value["schemaVersion"] !== 1) return "schemaVersion must be 1";
  if (value["algorithm"] !== "untangle-capability-map-v1") {
    return 'algorithm must be "untangle-capability-map-v1"';
  }
  for (const key of [
    "mapId",
    "workspaceId",
    "repoId",
    "refId",
    "generationId",
    "corpusRevisionFingerprint",
    "embeddingProfileId",
    "createdAt",
  ] as const) {
    if (!nonEmptyString(value[key])) return `${key} must be a non-empty string`;
  }
  if (!isStringArray(value["scope"])) return "scope must be a string array";
  if (!isRecord(value["thresholds"])) return "thresholds must be an object";
  if (!Array.isArray(value["capabilities"])) return "capabilities must be an array";
  if (!isRecord(value["distribution"])) return "distribution must be an object";
  if (typeof value["chained"] !== "boolean") return "chained must be a boolean";
  if (!isFiniteNumber(value["corpusCognitive"])) return "corpusCognitive must be a number";
  const cycles = value["cycleSignatures"];
  if (!isRecord(cycles) || !isStringArray(cycles["symbol"]) || !isStringArray(cycles["file"])) {
    return "cycleSignatures must carry symbol and file string arrays";
  }
  if (!Array.isArray(value["skipped"])) return "skipped must be an array";
  if (value["determinism"] !== "artifact") return 'determinism must be "artifact"';
  return null;
}
```

In `packages/domain/src/index.ts` neben den anderen `types/*`-Exporten ergänzen (gleiche Form wie `export * from "./types/quality.js";`):

```ts
export * from "./types/capability.js";
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npx vitest run packages/domain/src/types/capability.test.ts packages/domain/src/errors.test.ts packages/domain/src/versions.test.ts`
Expected: PASS. Falls `versions.test.ts` eine Liste aller Versionskonstanten prüft, `CAPABILITY_MAP_ALGORITHM_ID` dort ergänzen.

- [ ] **Step 5: Typecheck, Lint, Commit**

```bash
pnpm -s typecheck && pnpm -s lint
git add packages/domain
git commit -m "feat(domain): Vertraege fuer Faehigkeitskarte, Reduce-Sitzung und Ratsche"
```

---

### Task 2: `LocalRevisionedRecordStore<T>` aus dem Journey-Store extrahieren

**Files:**
- Create: `packages/storage-local/src/revisioned-record-store.ts`
- Modify: `packages/storage-local/src/search-journey-store.ts` (delegiert; behält Konstanten und `getOrCreateFingerprintKey`)
- Modify: `packages/storage-local/src/index.ts` (Export)
- Test: bestehende `packages/storage-local/src/search-journey-store.test.ts` bleibt **unverändert** grün — das ist der Treuebeweis.

**Interfaces:**
- Produces:
```ts
export interface RevisionedRecordStoreConfig<T> {
  /** Menschlicher Name in Meldungen, z. B. "search journey". */
  label: string;
  /** Praefix der `operation`-Felder, z. B. "search_journey". */
  operationPrefix: string;
  /** Praefix der Lock-Schluessel, z. B. "search-journey". */
  lockPrefix: string;
  idOf: (record: T) => string;
  validate: (value: unknown) => string | null;
  codes: { notFound: ErrorCode; conflict: ErrorCode; invalidState: ErrorCode };
  compare: (left: T, right: T) => number;
  limits?: { maxRecordBytes?: number; maxFiles?: number; maxListBytes?: number };
}
export class LocalRevisionedRecordStore<T extends { revision: number }> {
  constructor(fs: FileSystemPort, dir: string, random: Random, locks: LockProvider, clock: Pick<Clock, "nowEpochMs">, config: RevisionedRecordStoreConfig<T>);
  get(id: string, options?: PortCallOptions): Promise<T | null>;
  put(record: T, options: PortCallOptions & { expectedRevision: number | null }): Promise<void>;
  list(keep: (record: T) => boolean, options?: PortCallOptions): Promise<T[]>;
}
export const RECORD_ID_PATTERN: RegExp;  // die bisherige SESSION_ID-Regex (UUID)
export const DEFAULT_RECORD_LIMITS = { maxRecordBytes: 32 * 1024 * 1024, maxFiles: 10_000, maxListBytes: 128 * 1024 * 1024 };
export const RECORD_LOCK_LEASE_MS = 30_000;
export class RenewingLease { … }               // unveraendert verschoben
export async function verifyLeasesForCommit(…)  // unveraendert verschoben
```

- [ ] **Step 1: Bestehende Tests als Baseline laufen lassen**

Run: `npx vitest run packages/storage-local/src/search-journey-store.test.ts`
Expected: PASS (Zahl der Tests notieren).

- [ ] **Step 2: Generischen Store anlegen**

`packages/storage-local/src/revisioned-record-store.ts`: Inhalt = die heutigen Klassen/Funktionen `RenewingLease`, `verifyLeasesForCommit`, `encode`, `signalOptions`, sowie `read`/`parse`/`get`/`put`/`list` aus `LocalSearchJourneyStore` (Zeilen 199–640 der heutigen Datei), mit diesen Ersetzungen:

- `SearchJourneyV1` → `T`; `session.sessionId` → `this.config.idOf(record)`.
- `searchJourneyValidationIssue(parsed)` → `this.config.validate(parsed)`; die Prüfung `validated.sessionId !== sessionId` → `this.config.idOf(validated) !== id` mit Meldung `"record id mismatch"`.
- Jede Meldung `search journey …` → `` `${this.config.label} …` `` — Wortlaut sonst identisch: `` `${label} "${id}" is corrupted` ``, `` `${label} writes require an expected revision` ``, `` `${label} revision ${…} does not follow expected revision ${…}` ``, `` `${label} exceeds the ${…} byte record limit` ``, `` `${label} "${id}" changed concurrently` ``, `` `${label} store reached its limit of ${…} records` ``, `` `${label} store contains ${…} records; limit is ${…}` ``, `` `${label} record "${…}" disappeared during snapshot preflight` ``, `` `${label} record "${…}" is corrupted` ``, `` `${label} snapshot exceeds the ${…} byte aggregate read limit` ``, `` `${label} record "${…}" exceeds its byte limit during snapshot read` ``, `` `${label} record "${…}" changed during snapshot read` ``.
- `operation: "search_journey_read"` etc. → `` `${this.config.operationPrefix}_read` `` (ebenso `_put`, `_get`, `_list`, `_list_budget`, `_list_read`, `_store`).
- Lock-Schlüssel `"search-journey:create"` → `` `${this.config.lockPrefix}:create` ``; `` `search-journey:${id}` `` → `` `${this.config.lockPrefix}:${id}` ``.
- Fehlercodes: `"SEARCH_SESSION_INVALID_STATE"` → `this.config.codes.invalidState`; `"SEARCH_SESSION_CONFLICT"` → `this.config.codes.conflict`; `"SEARCH_SESSION_NOT_FOUND"` (in `assertSessionId`) → `this.config.codes.notFound` mit Meldung `` `invalid ${label} session id` `` und `context: { sessionId }` (Feldname bleibt, damit bestehende Assertions gelten). `"INDEX_INCOMPLETE"` bleibt wörtlich.
- Grenzen: `MAX_SEARCH_JOURNEY_RECORD_BYTES` → `this.limits.maxRecordBytes` usw., aufgelöst als `{ ...DEFAULT_RECORD_LIMITS, ...config.limits }`.
- `list(workspaceId)` → `list(keep)`: statt `if (session.workspaceId === workspaceId)` → `if (keep(record))`; Sortierung über `this.config.compare`.
- `.tmp`-Pfade, `mode: 0o600`, `mkdir`, `verifyLeasesForCommit` unverändert übernehmen.

- [ ] **Step 3: Journey-Store auf Delegation umstellen**

`search-journey-store.ts` behält: die exportierten Konstanten als Re-Export (`export const MAX_SEARCH_JOURNEY_RECORD_BYTES = DEFAULT_RECORD_LIMITS.maxRecordBytes;`, `MAX_SEARCH_JOURNEY_FILES`, `MAX_SEARCH_JOURNEY_LIST_BYTES`, `SEARCH_JOURNEY_LOCK_LEASE_MS = RECORD_LOCK_LEASE_MS`, `SEARCH_JOURNEY_LOCK_RENEW_INTERVAL_MS = Math.floor(RECORD_LOCK_LEASE_MS / 3)`), `FINGERPRINT_KEY`, `getOrCreateFingerprintKey` (nutzt `RenewingLease` und `RECORD_LOCK_LEASE_MS` aus dem generischen Modul). Die Klasse:

```ts
export class LocalSearchJourneyStore implements SearchJourneyStorePort {
  private readonly records: LocalRevisionedRecordStore<SearchJourneyV1>;
  private readonly fingerprintKeyPath: string;

  public constructor(
    private readonly fs: FileSystemPort,
    private readonly sessionsDir: string,
    private readonly random: Random,
    private readonly locks: LockProvider,
    private readonly clock: Pick<Clock, "nowEpochMs">,
  ) {
    this.fingerprintKeyPath = path.join(path.dirname(sessionsDir), "fingerprint.key");
    this.records = new LocalRevisionedRecordStore<SearchJourneyV1>(
      fs, sessionsDir, random, locks, clock,
      {
        label: "search journey",
        operationPrefix: "search_journey",
        lockPrefix: "search-journey",
        idOf: (session) => session.sessionId,
        validate: searchJourneyValidationIssue,
        codes: {
          notFound: "SEARCH_SESSION_NOT_FOUND",
          conflict: "SEARCH_SESSION_CONFLICT",
          invalidState: "SEARCH_SESSION_INVALID_STATE",
        },
        compare: (left, right) =>
          compareCodepoints(left.createdAt, right.createdAt) ||
          compareCodepoints(left.sessionId, right.sessionId),
      },
    );
  }

  public get(sessionId: string, options?: PortCallOptions): Promise<SearchJourneyV1 | null> {
    return this.records.get(sessionId, options);
  }
  public put(
    session: SearchJourneyV1,
    options: PortCallOptions & { expectedRevision: number | null },
  ): Promise<void> {
    return this.records.put(session, options);
  }
  public list(workspaceId: string, options?: PortCallOptions): Promise<SearchJourneyV1[]> {
    return this.records.list((session) => session.workspaceId === workspaceId, options);
  }
  // getOrCreateFingerprintKey: unveraendert
}
```

In `index.ts`: `export * from "./revisioned-record-store.js";` vor dem Journey-Export.

- [ ] **Step 4: Treuebeweis**

Run: `npx vitest run packages/storage-local`
Expected: PASS mit derselben Testzahl wie in Step 1; keine Änderung an `search-journey-store.test.ts`.

- [ ] **Step 5: Typecheck, Lint, Commit**

```bash
pnpm -s typecheck && pnpm -s lint
git add packages/storage-local
git commit -m "refactor(storage-local): revisionierter Record-Store als gemeinsame Persistenz der Journeys"
```

---

### Task 3: `LocalReduceComplexityStore` (Sitzungen + Karten) und Layout

**Files:**
- Create: `packages/storage-local/src/reduce-complexity-store.ts`
- Modify: `packages/storage-local/src/layout.ts` (neuer Zweig `reduceComplexity`)
- Modify: `packages/storage-local/src/storage.ts` (Feld `reduceComplexity`)
- Modify: `packages/storage-local/src/index.ts`
- Test: `packages/storage-local/src/reduce-complexity-store.test.ts`, `packages/storage-local/src/layout.test.ts` (Ergänzung)

**Interfaces:**
- Consumes: `LocalRevisionedRecordStore` (Task 2), `reduceComplexitySessionValidationIssue`, `capabilityMapValidationIssue` (Task 1).
- Produces:
```ts
export const MAX_CAPABILITY_MAP_RECORD_BYTES = 256 * 1024 * 1024;
export type StoredCapabilityMapV1 = CapabilityMapV1 & { revision: number };
export class LocalReduceComplexityStore {
  constructor(fs, sessionsDir: string, mapsDir: string, random, locks, clock);
  readonly sessions: LocalRevisionedRecordStore<ReduceComplexitySessionV1>;
  readonly maps: LocalRevisionedRecordStore<StoredCapabilityMapV1>;
}
// layout.reduceComplexity = { root, sessions, maps }
// LocalStorage.reduceComplexity: LocalReduceComplexityStore
```
Karten tragen im Store `revision: 0`, weil der Store CAS verlangt; eine Karte wird nie überschrieben (`put` nur mit `expectedRevision: null`).

- [ ] **Step 1: Failing Test schreiben**

```ts
// packages/storage-local/src/reduce-complexity-store.test.ts
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CAPABILITY_MAP_ALGORITHM_ID,
  DEFAULT_CAPABILITY_THRESHOLDS,
  UntangleError,
  type ReduceComplexitySessionV1,
} from "@untangle-code/domain";
import { DeterministicRandom, FakeClock, InMemoryLockProvider } from "@untangle-code/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalFileSystem } from "./local-file-system.js";
import {
  LocalReduceComplexityStore,
  type StoredCapabilityMapV1,
} from "./reduce-complexity-store.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const MAP_ID = "22222222-2222-5222-8222-222222222222";

function session(overrides: Partial<ReduceComplexitySessionV1> = {}): ReduceComplexitySessionV1 {
  return {
    schemaVersion: 1,
    revision: 0,
    sessionId: SESSION_ID,
    workspaceId: "ws",
    status: "open",
    scope: [],
    createdAt: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T10:00:00.000Z",
    baseline: {
      repoId: "repo",
      refId: "repo:main",
      generationId: "33333333-3333-4333-8333-333333333333",
      corpusRevisionFingerprint: "a".repeat(64),
      embeddingProfileId: "b".repeat(64),
      mapId: MAP_ID,
      corpusCognitive: 10,
      testCount: 3,
    },
    ...overrides,
  };
}

function storedMap(): StoredCapabilityMapV1 {
  return {
    revision: 0,
    schemaVersion: 1,
    algorithm: CAPABILITY_MAP_ALGORITHM_ID,
    mapId: MAP_ID,
    workspaceId: "ws",
    repoId: "repo",
    refId: "repo:main",
    generationId: "33333333-3333-4333-8333-333333333333",
    corpusRevisionFingerprint: "a".repeat(64),
    embeddingProfileId: "b".repeat(64),
    scope: [],
    thresholds: DEFAULT_CAPABILITY_THRESHOLDS,
    capabilities: [],
    distribution: { count: 0, median: 0, p90: 0, max: 0, largestShare: 0 },
    chained: false,
    corpusCognitive: 0,
    cycleSignatures: { symbol: [], file: [] },
    skipped: [],
    determinism: "artifact",
    createdAt: "2026-09-13T10:00:00.000Z",
  };
}

describe("LocalReduceComplexityStore", () => {
  let root: string;
  let store: LocalReduceComplexityStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "untangle-reduce-"));
    const clock = new FakeClock(1_000);
    const random = new DeterministicRandom(7);
    store = new LocalReduceComplexityStore(
      new LocalFileSystem([root]),
      path.join(root, "sessions"),
      path.join(root, "maps"),
      random,
      new InMemoryLockProvider(clock, random),
      clock,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("schreibt eine Sitzung atomar mit Modus 0600 und liest sie zurueck", async () => {
    await store.sessions.put(session(), { expectedRevision: null });
    expect((await store.sessions.get(SESSION_ID))?.status).toBe("open");
    const mode = (await stat(path.join(root, "sessions", `${SESSION_ID}.json`))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("verlangt CAS: veraltete Revision scheitert mit REDUCE_SESSION_CONFLICT", async () => {
    await store.sessions.put(session(), { expectedRevision: null });
    await store.sessions.put(session({ revision: 1, status: "proposed" }), { expectedRevision: 0 });
    await expect(
      store.sessions.put(session({ revision: 1, status: "selected" }), { expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: "REDUCE_SESSION_CONFLICT" });
  });

  it("lehnt eine strukturell ungueltige Sitzung mit REDUCE_SESSION_INVALID_STATE ab", async () => {
    await expect(
      store.sessions.put({ ...session(), status: "done" as "open" }, { expectedRevision: null }),
    ).rejects.toMatchObject({ code: "REDUCE_SESSION_INVALID_STATE" });
  });

  it("listet nach Filter, sortiert nach createdAt und sessionId", async () => {
    await store.sessions.put(session(), { expectedRevision: null });
    await store.sessions.put(
      session({ sessionId: "44444444-4444-4444-8444-444444444444", workspaceId: "other" }),
      { expectedRevision: null },
    );
    const own = await store.sessions.list((record) => record.workspaceId === "ws");
    expect(own.map((record) => record.sessionId)).toEqual([SESSION_ID]);
  });

  it("legt eine Karte genau einmal ab und liest sie unter ihrer mapId", async () => {
    await store.maps.put(storedMap(), { expectedRevision: null });
    await expect(store.maps.put(storedMap(), { expectedRevision: null })).rejects.toBeInstanceOf(
      UntangleError,
    );
    expect((await store.maps.get(MAP_ID))?.algorithm).toBe(CAPABILITY_MAP_ALGORITHM_ID);
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run packages/storage-local/src/reduce-complexity-store.test.ts`
Expected: FAIL — Modul fehlt.

- [ ] **Step 3: Store, Layout, Verdrahtung schreiben**

`packages/storage-local/src/reduce-complexity-store.ts`:

```ts
/**
 * Persistenz des Loops `untangle reduce-complexity` unter
 * `.untangle/reduce-complexity/{sessions,maps}/`.
 *
 * Keine zweite Persistenzschicht (Spec §3): beide Stores sind Instanzen des
 * revisionierten Record-Stores, den auch die Search Journeys benutzen —
 * atomar, 0600, CAS, begrenzt. Karten sind unveraenderlich: `revision` ist
 * immer 0, ein zweites `put` derselben `mapId` ist ein Konflikt.
 */
import {
  capabilityMapValidationIssue,
  compareCodepoints,
  reduceComplexitySessionValidationIssue,
  type CapabilityMapV1,
  type Clock,
  type FileSystemPort,
  type LockProvider,
  type Random,
  type ReduceComplexitySessionV1,
} from "@untangle-code/domain";

import { LocalRevisionedRecordStore } from "./revisioned-record-store.js";

/** Karten tragen Zentroide je Faehigkeit; 32 MiB reichen bei ~9.000 Singletons nicht. */
export const MAX_CAPABILITY_MAP_RECORD_BYTES = 256 * 1024 * 1024;
export const MAX_CAPABILITY_MAP_LIST_BYTES = 512 * 1024 * 1024;

export type StoredCapabilityMapV1 = CapabilityMapV1 & { revision: number };

function storedMapValidationIssue(value: unknown): string | null {
  const issue = capabilityMapValidationIssue(value);
  if (issue !== null) return issue;
  if ((value as { revision?: unknown }).revision !== 0) {
    return "capability maps are immutable; revision must be 0";
  }
  return null;
}

export class LocalReduceComplexityStore {
  public readonly sessions: LocalRevisionedRecordStore<ReduceComplexitySessionV1>;
  public readonly maps: LocalRevisionedRecordStore<StoredCapabilityMapV1>;

  public constructor(
    fs: FileSystemPort,
    sessionsDir: string,
    mapsDir: string,
    random: Random,
    locks: LockProvider,
    clock: Pick<Clock, "nowEpochMs">,
  ) {
    this.sessions = new LocalRevisionedRecordStore<ReduceComplexitySessionV1>(
      fs,
      sessionsDir,
      random,
      locks,
      clock,
      {
        label: "reduce-complexity session",
        operationPrefix: "reduce_session",
        lockPrefix: "reduce-session",
        idOf: (record) => record.sessionId,
        validate: reduceComplexitySessionValidationIssue,
        codes: {
          notFound: "REDUCE_SESSION_NOT_FOUND",
          conflict: "REDUCE_SESSION_CONFLICT",
          invalidState: "REDUCE_SESSION_INVALID_STATE",
        },
        compare: (left, right) =>
          compareCodepoints(left.createdAt, right.createdAt) ||
          compareCodepoints(left.sessionId, right.sessionId),
      },
    );
    this.maps = new LocalRevisionedRecordStore<StoredCapabilityMapV1>(
      fs,
      mapsDir,
      random,
      locks,
      clock,
      {
        label: "capability map",
        operationPrefix: "capability_map",
        lockPrefix: "capability-map",
        idOf: (record) => record.mapId,
        validate: storedMapValidationIssue,
        codes: {
          notFound: "REDUCE_SESSION_NOT_FOUND",
          conflict: "REDUCE_SESSION_CONFLICT",
          invalidState: "REDUCE_SESSION_INVALID_STATE",
        },
        compare: (left, right) => compareCodepoints(left.mapId, right.mapId),
        limits: {
          maxRecordBytes: MAX_CAPABILITY_MAP_RECORD_BYTES,
          maxListBytes: MAX_CAPABILITY_MAP_LIST_BYTES,
        },
      },
    );
  }
}
```

`layout.ts`: im `StateDirLayout`-Interface nach `productComplexity` ergänzen `reduceComplexity: { root: string; sessions: string; maps: string }`; in `buildStateDirLayout` `const reduceComplexityRoot = path.join(root, "reduce-complexity")` und `reduceComplexity: { root: reduceComplexityRoot, sessions: path.join(reduceComplexityRoot, "sessions"), maps: path.join(reduceComplexityRoot, "maps") }`; in der Verzeichnisliste von `ensureStateDirLayout` die drei Pfade anhängen. In `layout.test.ts` einen Fall ergänzen: `expect(layout.reduceComplexity.maps).toBe(path.join(root, "reduce-complexity", "maps"))`.

`storage.ts`: Feld `reduceComplexity: LocalReduceComplexityStore` in `LocalStorage`; in `openLocalStorage` nach `searchJourneys`:

```ts
  const reduceComplexity = new LocalReduceComplexityStore(
    fs,
    layout.reduceComplexity.sessions,
    layout.reduceComplexity.maps,
    options.random,
    locks,
    options.clock,
  );
  return {
    layout, fs, embeddingCache, analysisCache, checkpoints, locks, searchJourneys, reduceComplexity,
  };
```

`index.ts`: `export * from "./reduce-complexity-store.js";`

- [ ] **Step 4: Tests laufen lassen**

Run: `npx vitest run packages/storage-local`
Expected: PASS.

- [ ] **Step 5: Typecheck, Lint, Commit**

```bash
pnpm -s typecheck && pnpm -s lint
git add packages/storage-local
git commit -m "feat(storage-local): Sitzungen und Karten des Reduce-Loops im revisionierten Store"
```

---

### Task 4: Paket `capability-map` anlegen, Vektorhelfer

**Files:**
- Create: `packages/capability-map/package.json`, `tsconfig.json`, `tsconfig.typecheck.json`, `vitest.config.ts`, `README.md`, `LICENSE`, `NOTICE`, `THIRD_PARTY_LICENSES.md`
- Create: `packages/capability-map/src/index.ts`, `src/vectors.ts`
- Modify: `tsconfig.json` (Root-Referenz nach `packages/search`)
- Test: `packages/capability-map/src/vectors.test.ts`

**Interfaces:**
- Produces:
```ts
export function cosine(a: Float32Array, b: Float32Array): number;   // 0 bei Nullvektor, wirft bei Dimensionsmix
export function meanVector(vectors: readonly Float32Array[]): Float32Array; // wirft bei leerer Liste oder Dimensionsmix
export function encodeFloat32(vector: Float32Array): string;         // Base64, little-endian
export function decodeFloat32(encoded: string): Float32Array;
export function toFloat32(values: readonly number[]): Float32Array;
```

- [ ] **Step 1: Gerüst anlegen**

`package.json` (Vorlage `packages/symbol-graph/package.json`):

```json
{
  "name": "@untangle-code/capability-map",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "description": "Untangle capability map and complexity ratchet: clusters embedded symbols into capabilities, recovers them across index generations, proposes reduction candidates and judges whether complexity fell without losing coverage (reduce-complexity loop design, 2026-09-08).",
  "license": "AGPL-3.0-only",
  "homepage": "https://github.com/lboel/untangle",
  "bugs": { "url": "https://github.com/lboel/untangle/issues" },
  "repository": { "type": "git", "url": "git+https://github.com/lboel/untangle.git", "directory": "packages/capability-map" },
  "publishConfig": { "access": "public" },
  "engines": { "node": ">=22.12.0" },
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": ["dist", "!dist/**/*.test.*", "!dist/**/test-support.*", "src", "!src/**/*.test.ts", "!src/**/test-support.ts", "LICENSE", "NOTICE", "README.md", "THIRD_PARTY_LICENSES.md"],
  "scripts": {
    "prepack": "node ../../scripts/prepack-guard.mjs",
    "build": "node ../../scripts/tsc-build.mjs tsconfig.json",
    "typecheck": "tsc -p tsconfig.typecheck.json",
    "test": "vitest run",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "dependencies": {
    "@untangle-code/domain": "workspace:*",
    "@untangle-code/extension-runtime": "workspace:*",
    "@untangle-code/file-graph": "workspace:*",
    "@untangle-code/symbol-graph": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "22.19.7",
    "@untangle-code/testkit": "workspace:*",
    "typescript": "5.9.3",
    "vitest": "3.2.7"
  }
}
```

`tsconfig.json` wie `packages/symbol-graph/tsconfig.json` mit `references`: `../domain`, `../extension-runtime`, `../file-graph`, `../symbol-graph`. `tsconfig.typecheck.json` wie `packages/search/tsconfig.typecheck.json` mit denselben Referenzen plus `../testkit`. `vitest.config.ts` wörtlich wie `packages/symbol-graph/vitest.config.ts`. Root-`tsconfig.json`: `{ "path": "packages/capability-map" }` nach `packages/search` einfügen.

`README.md` — Abschnitte: Zweck (die drei Achsen; L1–L8 je ein Absatz), Was die Karte ist und nicht ist (§10), Heuristik `testIds` (Symbole aus Testdateien nach `DEFAULT_TEST_PATH_MARKERS`, die ein Mitglied aufrufen — keine Coverage-Messung), Schwellen (§11-Tabelle), Abschnitt `## Lizenz` mit dem Satz „AGPL-3.0-only (siehe `LICENSE`)".

Dann: `pnpm install`, `pnpm sync-licenses`, `pnpm third-party-licenses`.

- [ ] **Step 2: Failing Test schreiben**

```ts
// packages/capability-map/src/vectors.test.ts
import { describe, expect, it } from "vitest";

import { cosine, decodeFloat32, encodeFloat32, meanVector, toFloat32 } from "./vectors.js";

describe("cosine", () => {
  it("ist 1 fuer gleiche Richtung und 0 fuer orthogonale Vektoren", () => {
    expect(cosine(toFloat32([1, 0]), toFloat32([2, 0]))).toBeCloseTo(1, 6);
    expect(cosine(toFloat32([1, 0]), toFloat32([0, 3]))).toBeCloseTo(0, 6);
  });
  it("liefert 0 bei einem Nullvektor statt NaN", () => {
    expect(cosine(toFloat32([0, 0]), toFloat32([1, 1]))).toBe(0);
  });
  it("wirft bei Dimensionsmix", () => {
    expect(() => cosine(toFloat32([1]), toFloat32([1, 2]))).toThrow(
      "cosine: dimension mismatch (1 vs 2)",
    );
  });
});

describe("meanVector", () => {
  it("mittelt komponentenweise", () => {
    expect([...meanVector([toFloat32([1, 3]), toFloat32([3, 5])])]).toEqual([2, 4]);
  });
  it("wirft bei leerer Liste", () => {
    expect(() => meanVector([])).toThrow("meanVector needs at least one vector");
  });
  it("wirft bei gemischten Dimensionen", () => {
    expect(() => meanVector([toFloat32([1]), toFloat32([1, 2])])).toThrow(
      "meanVector: dimension mismatch (1 vs 2)",
    );
  });
});

describe("encodeFloat32/decodeFloat32", () => {
  it("ist verlustfrei fuer Float32", () => {
    const vector = toFloat32([0.5, -1.25, 3]);
    expect([...decodeFloat32(encodeFloat32(vector))]).toEqual([0.5, -1.25, 3]);
  });
  it("lehnt eine Laenge ab, die kein Vielfaches von 4 Bytes ist", () => {
    expect(() => decodeFloat32("AAA=")).toThrow("encoded vector has 2 bytes, not a multiple of 4");
  });
});
```

- [ ] **Step 3: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run packages/capability-map/src/vectors.test.ts`
Expected: FAIL — Modul fehlt.

- [ ] **Step 4: Implementieren**

```ts
// packages/capability-map/src/vectors.ts
/**
 * Vektorhelfer der Faehigkeitskarte. Float32, damit ein Zentroid im Artefakt
 * 4 Bytes je Dimension kostet (Spec §4.3: die Karte ist das persistierte
 * Artefakt; 9.000 Singletons x 1.024 Dimensionen muessen hineinpassen).
 */
import { Buffer } from "node:buffer";

export function toFloat32(values: readonly number[]): Float32Array {
  return Float32Array.from(values);
}

/** Cosinus-Aehnlichkeit; 0, wenn eine Seite der Nullvektor ist (kein NaN). */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dimension mismatch (${String(a.length)} vs ${String(b.length)})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

export function meanVector(vectors: readonly Float32Array[]): Float32Array {
  const first = vectors[0];
  if (first === undefined) throw new Error("meanVector needs at least one vector");
  const sum = new Float64Array(first.length);
  for (const vector of vectors) {
    if (vector.length !== first.length) {
      throw new Error(
        `meanVector: dimension mismatch (${String(first.length)} vs ${String(vector.length)})`,
      );
    }
    for (let i = 0; i < vector.length; i += 1) sum[i] = (sum[i] ?? 0) + (vector[i] ?? 0);
  }
  const mean = new Float32Array(first.length);
  for (let i = 0; i < mean.length; i += 1) mean[i] = (sum[i] ?? 0) / vectors.length;
  return mean;
}

export function encodeFloat32(vector: Float32Array): string {
  const bytes = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i += 1) bytes.writeFloatLE(vector[i] ?? 0, i * 4);
  return bytes.toString("base64");
}

export function decodeFloat32(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length % 4 !== 0) {
    throw new Error(`encoded vector has ${String(bytes.length)} bytes, not a multiple of 4`);
  }
  const vector = new Float32Array(bytes.length / 4);
  for (let i = 0; i < vector.length; i += 1) vector[i] = bytes.readFloatLE(i * 4);
  return vector;
}
```

`src/index.ts` vorerst: `export * from "./vectors.js";`

- [ ] **Step 5: Tests, Publishability, Commit**

Run: `npx vitest run packages/capability-map && pnpm -s typecheck && pnpm -s lint && pnpm -s check-publishable`
Expected: alles grün; das neue Paket erscheint unter „veroeffentlicht (21)".

```bash
git add packages/capability-map tsconfig.json pnpm-lock.yaml
git commit -m "feat(capability-map): Paketgeruest und Vektorhelfer"
```

---

### Task 5: Symbolzentroide und Kosten aus Punkten (`collect.ts`)

**Files:**
- Create: `packages/capability-map/src/collect.ts`
- Test: `packages/capability-map/src/collect.test.ts`

**Interfaces:**
- Consumes: `VectorPointV1` (`@untangle-code/domain`), `meanVector`/`toFloat32` (Task 4).
- Produces:
```ts
export interface SymbolEntryV1 {
  symbolId: string; symbolFqn: string; filePath: string;
  centroid: Float32Array; chunkCount: number;
  cost: CapabilityCostV1 | null;
  /** Eindeutige metrics_scope_ids, aus denen `cost` summiert wurde. */
  metricsScopeIds: string[];
}
export interface CollectedSymbolsV1 { entries: SymbolEntryV1[]; skipped: CapabilityMapSkipEntryV1[]; dimensions: number | null; }
export interface CollectOptions { scope: readonly string[]; matchesScope: (filePath: string) => boolean; }
export function collectSymbolEntries(points: readonly VectorPointV1[], options: CollectOptions): CollectedSymbolsV1;
```

- [ ] **Step 1: Failing Test schreiben**

```ts
// packages/capability-map/src/collect.test.ts
import type { VectorPointV1 } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { collectSymbolEntries } from "./collect.js";

function point(
  overrides: Record<string, unknown> & { id: string; dense?: number[] },
): VectorPointV1 {
  const { id, dense, ...payload } = overrides;
  return {
    id,
    dense: dense ?? [1, 0],
    payload: {
      point_type: "code_chunk",
      file_path: "src/a.ts",
      symbol_id: "sym-a",
      symbol_fqn: "a",
      metrics_scope: "symbol",
      metrics_scope_id: "scope-a",
      metrics_version: "untangle-metrics-v1",
      cognitive: 4,
      cyclomatic_classic: 2,
      cyclomatic_extended: 3,
      sloc: 10,
      ...payload,
    },
  };
}

const everything = { scope: [] as string[], matchesScope: () => true };

describe("collectSymbolEntries", () => {
  it("mittelt die Chunks eines Symbols zu einem Zentroid", () => {
    const result = collectSymbolEntries(
      [point({ id: "1", dense: [1, 0] }), point({ id: "2", dense: [0, 1] })],
      everything,
    );
    expect(result.entries).toHaveLength(1);
    expect([...(result.entries[0]?.centroid ?? [])]).toEqual([0.5, 0.5]);
    expect(result.entries[0]?.chunkCount).toBe(2);
    expect(result.dimensions).toBe(2);
  });

  it("summiert Kosten einmal je metrics_scope_id", () => {
    const result = collectSymbolEntries(
      [
        point({ id: "1" }),
        point({ id: "2" }),
        point({ id: "3", metrics_scope_id: "scope-b", cognitive: 6 }),
      ],
      everything,
    );
    expect(result.entries[0]?.cost).toEqual({
      metricsVersion: "untangle-metrics-v1",
      cognitive: 10,
      cyclomaticClassic: 4,
      cyclomaticExtended: 6,
      sloc: 20,
    });
    expect(result.entries[0]?.metricsScopeIds).toEqual(["scope-a", "scope-b"]);
  });

  it("legt Chunks ohne symbol_id mit Grund ins Ledger", () => {
    const result = collectSymbolEntries([point({ id: "1", symbol_id: undefined })], everything);
    expect(result.entries).toHaveLength(0);
    expect(result.skipped).toEqual([
      { kind: "chunk_without_symbol", id: "1", detail: "chunk carries no symbol_id (file src/a.ts)" },
    ]);
  });

  it("legt Symbole ohne Vektor mit Grund ins Ledger", () => {
    const withoutDense: VectorPointV1 = { id: "1", payload: point({ id: "1" }).payload };
    const result = collectSymbolEntries([withoutDense], everything);
    expect(result.skipped).toEqual([
      {
        kind: "symbol_without_embedding",
        id: "sym-a",
        detail: "no chunk of symbol a carries a dense vector",
      },
    ]);
  });

  it("markiert Symbole ohne Metrik, nimmt sie aber auf", () => {
    const result = collectSymbolEntries([point({ id: "1", cognitive: undefined })], everything);
    expect(result.entries[0]?.cost).toBeNull();
    expect(result.skipped).toEqual([
      {
        kind: "symbol_without_metrics",
        id: "sym-a",
        detail: "no chunk of symbol a carries cognitive complexity",
      },
    ]);
  });

  it("schliesst Dateien ausserhalb des Scopes mit Grund aus", () => {
    const result = collectSymbolEntries([point({ id: "1" })], {
      scope: ["packages/**"],
      matchesScope: () => false,
    });
    expect(result.entries).toHaveLength(0);
    expect(result.skipped).toEqual([
      { kind: "excluded_by_scope", id: "src/a.ts", detail: "outside --scope packages/**" },
    ]);
  });

  it("sortiert Eintraege nach symbolId", () => {
    const result = collectSymbolEntries(
      [point({ id: "1", symbol_id: "z" }), point({ id: "2", symbol_id: "a" })],
      everything,
    );
    expect(result.entries.map((entry) => entry.symbolId)).toEqual(["a", "z"]);
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run packages/capability-map/src/collect.test.ts`
Expected: FAIL — Modul fehlt.

- [ ] **Step 3: Implementieren**

```ts
// packages/capability-map/src/collect.ts
/**
 * Schritt 1 der Karte (Spec §4.1): je Symbol der Mittelwert der Vektoren
 * seiner Chunks. Kosten werden je eindeutiger `metrics_scope_id` summiert
 * (spec.md §16.10 — keine Doppelzaehlung von Fragmenten desselben Scopes).
 * Alles, was nicht eingeht, steht mit Grund im Ledger (§4.6).
 */
import {
  compareCodepoints,
  type CapabilityCostV1,
  type CapabilityMapSkipEntryV1,
  type VectorPointV1,
} from "@untangle-code/domain";

import { meanVector, toFloat32 } from "./vectors.js";

export interface SymbolEntryV1 {
  symbolId: string;
  symbolFqn: string;
  filePath: string;
  centroid: Float32Array;
  chunkCount: number;
  cost: CapabilityCostV1 | null;
  metricsScopeIds: string[];
}

export interface CollectedSymbolsV1 {
  entries: SymbolEntryV1[];
  skipped: CapabilityMapSkipEntryV1[];
  dimensions: number | null;
}

export interface CollectOptions {
  scope: readonly string[];
  matchesScope: (filePath: string) => boolean;
}

interface ScopeCost {
  version: string;
  cognitive: number;
  classic: number;
  extended: number;
  sloc: number;
}

interface Accumulator {
  symbolFqn: string;
  filePath: string;
  vectors: Float32Array[];
  chunkCount: number;
  scopes: Map<string, ScopeCost>;
}

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function num(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function collectSymbolEntries(
  points: readonly VectorPointV1[],
  options: CollectOptions,
): CollectedSymbolsV1 {
  const skipped: CapabilityMapSkipEntryV1[] = [];
  const bySymbol = new Map<string, Accumulator>();
  const excludedFiles = new Set<string>();

  for (const point of points) {
    const payload = point.payload;
    const filePath = str(payload, "file_path") ?? "";
    if (options.scope.length > 0 && !options.matchesScope(filePath)) {
      if (!excludedFiles.has(filePath)) {
        excludedFiles.add(filePath);
        skipped.push({
          kind: "excluded_by_scope",
          id: filePath,
          detail: `outside --scope ${options.scope.join(", ")}`,
        });
      }
      continue;
    }
    const symbolId = str(payload, "symbol_id");
    if (symbolId === undefined) {
      skipped.push({
        kind: "chunk_without_symbol",
        id: point.id,
        detail: `chunk carries no symbol_id (file ${filePath})`,
      });
      continue;
    }
    let acc = bySymbol.get(symbolId);
    if (acc === undefined) {
      acc = {
        symbolFqn: str(payload, "symbol_fqn") ?? str(payload, "symbol_name") ?? symbolId,
        filePath,
        vectors: [],
        chunkCount: 0,
        scopes: new Map(),
      };
      bySymbol.set(symbolId, acc);
    }
    acc.chunkCount += 1;
    if (point.dense !== undefined && point.dense.length > 0) {
      acc.vectors.push(toFloat32(point.dense));
    }
    const scopeId = str(payload, "metrics_scope_id");
    const cognitive = num(payload, "cognitive");
    if (scopeId !== undefined && cognitive !== undefined && !acc.scopes.has(scopeId)) {
      acc.scopes.set(scopeId, {
        version: str(payload, "metrics_version") ?? "unknown",
        cognitive,
        classic: num(payload, "cyclomatic_classic") ?? 0,
        extended: num(payload, "cyclomatic_extended") ?? 0,
        sloc: num(payload, "sloc") ?? 0,
      });
    }
  }

  const entries: SymbolEntryV1[] = [];
  let dimensions: number | null = null;
  const sorted = [...bySymbol.entries()].sort((a, b) => compareCodepoints(a[0], b[0]));
  for (const [symbolId, acc] of sorted) {
    if (acc.vectors.length === 0) {
      skipped.push({
        kind: "symbol_without_embedding",
        id: symbolId,
        detail: `no chunk of symbol ${acc.symbolFqn} carries a dense vector`,
      });
      continue;
    }
    const centroid = meanVector(acc.vectors);
    dimensions ??= centroid.length;
    let cost: CapabilityCostV1 | null = null;
    if (acc.scopes.size > 0) {
      cost = { metricsVersion: "unknown", cognitive: 0, cyclomaticClassic: 0, cyclomaticExtended: 0, sloc: 0 };
      for (const scope of acc.scopes.values()) {
        cost.metricsVersion = scope.version;
        cost.cognitive += scope.cognitive;
        cost.cyclomaticClassic += scope.classic;
        cost.cyclomaticExtended += scope.extended;
        cost.sloc += scope.sloc;
      }
    } else {
      skipped.push({
        kind: "symbol_without_metrics",
        id: symbolId,
        detail: `no chunk of symbol ${acc.symbolFqn} carries cognitive complexity`,
      });
    }
    entries.push({
      symbolId,
      symbolFqn: acc.symbolFqn,
      filePath: acc.filePath,
      centroid,
      chunkCount: acc.chunkCount,
      cost,
      metricsScopeIds: [...acc.scopes.keys()].sort(compareCodepoints),
    });
  }
  return { entries, skipped, dimensions };
}
```

`index.ts`: `export * from "./collect.js";`

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npx vitest run packages/capability-map/src/collect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm -s typecheck && pnpm -s lint
git add packages/capability-map
git commit -m "feat(capability-map): Symbolzentroide und Kosten je metrics_scope_id"
```

---

### Task 6: Nachbarschaft (`neighbors.ts`)

**Files:**
- Create: `packages/capability-map/src/neighbors.ts`
- Test: `packages/capability-map/src/neighbors.test.ts`

**Interfaces:**
- Consumes: `SymbolEntryV1` (Task 5), `VectorStore`, `PayloadFilter`, `PortCallOptions` (`@untangle-code/domain`).
- Produces:
```ts
export interface NeighborSource {
  /** Die k naechsten ANDEREN Symbole, absteigend nach Aehnlichkeit; nie das Symbol selbst. */
  neighborsOf(entry: SymbolEntryV1, k: number, options?: PortCallOptions): Promise<string[]>;
}
export function createBruteForceNeighborSource(entries: readonly SymbolEntryV1[]): NeighborSource;
export interface VectorStoreNeighborSourceInput {
  vectorStore: VectorStore; collection: string; filter: PayloadFilter;
  entriesById: ReadonlyMap<string, SymbolEntryV1>;
  /** Ueberabfrage, weil Treffer Chunks sind, nicht Symbole. Vorgabe 4. */
  oversample?: number;
}
export function createVectorStoreNeighborSource(input: VectorStoreNeighborSourceInput): NeighborSource;
```

- [ ] **Step 1: Failing Test schreiben**

```ts
// packages/capability-map/src/neighbors.test.ts
import { InMemoryVectorStore } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import type { SymbolEntryV1 } from "./collect.js";
import { createBruteForceNeighborSource, createVectorStoreNeighborSource } from "./neighbors.js";
import { toFloat32 } from "./vectors.js";

function entry(symbolId: string, centroid: number[]): SymbolEntryV1 {
  return {
    symbolId,
    symbolFqn: symbolId,
    filePath: `src/${symbolId}.ts`,
    centroid: toFloat32(centroid),
    chunkCount: 1,
    cost: null,
    metricsScopeIds: [],
  };
}

const ENTRIES = [
  entry("a", [1, 0, 0]),
  entry("b", [0.9, 0.1, 0]),
  entry("c", [0, 1, 0]),
  entry("d", [0, 0, 1]),
];
const A = ENTRIES[0] as SymbolEntryV1;

describe("createBruteForceNeighborSource", () => {
  it("liefert die k naechsten anderen Symbole absteigend nach Cosinus", async () => {
    const source = createBruteForceNeighborSource(ENTRIES);
    expect(await source.neighborsOf(A, 2)).toEqual(["b", "c"]);
  });
  it("entscheidet Gleichstand ueber die Codepoint-Ordnung der Symbol-IDs", async () => {
    // c und d haben zu a beide Cosinus 0.
    const source = createBruteForceNeighborSource(ENTRIES);
    expect(await source.neighborsOf(A, 3)).toEqual(["b", "c", "d"]);
  });
});

describe("createVectorStoreNeighborSource", () => {
  it("bildet Chunk-Treffer auf eindeutige Symbole ab und laesst das eigene Symbol weg", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection({
      name: "code",
      denseDimensions: 3,
      denseDistance: "Cosine",
      sparseBm25: false,
      onDiskPayload: false,
    });
    await store.upsert("code", [
      { id: "a1", dense: [1, 0, 0], payload: { point_type: "code_chunk", symbol_id: "a" } },
      { id: "a2", dense: [1, 0.05, 0], payload: { point_type: "code_chunk", symbol_id: "a" } },
      { id: "b1", dense: [0.9, 0.1, 0], payload: { point_type: "code_chunk", symbol_id: "b" } },
      { id: "c1", dense: [0, 1, 0], payload: { point_type: "code_chunk", symbol_id: "c" } },
      { id: "x1", dense: [0.95, 0.05, 0], payload: { point_type: "code_chunk" } },
    ]);
    const source = createVectorStoreNeighborSource({
      vectorStore: store,
      collection: "code",
      filter: { must: [{ field: "point_type", match: { eq: "code_chunk" } }] },
      entriesById: new Map(ENTRIES.map((e) => [e.symbolId, e])),
    });
    expect(await source.neighborsOf(A, 2)).toEqual(["b", "c"]);
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run packages/capability-map/src/neighbors.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementieren**

```ts
// packages/capability-map/src/neighbors.ts
/**
 * Schritt 2 der Karte (Spec §4.1): je Symbolzentroid die k naechsten
 * Nachbarn. Zwei Quellen mit demselben Vertrag:
 *
 * - brute force ueber die gesammelten Eintraege — fuer Tests, Fixtures und
 *   kleine Korpora exakt;
 * - der Vektorspeicher — approximativ (ANN), dafuer ohne den paarweisen
 *   Vergleich, den §4.1 fuer ~9.000 Symbole ausschliesst. Treffer sind
 *   CHUNKS; sie werden auf eindeutige Symbole abgebildet, weshalb mehr
 *   Kandidaten angefragt werden als k.
 *
 * Die Kante selbst entsteht spaeter aus dem in-process berechneten
 * Zentroid-Cosinus (`components.ts`), nicht aus dem Score des Speichers.
 */
import {
  compareCodepoints,
  type PayloadFilter,
  type PortCallOptions,
  type VectorStore,
} from "@untangle-code/domain";

import type { SymbolEntryV1 } from "./collect.js";
import { cosine } from "./vectors.js";

export interface NeighborSource {
  neighborsOf(entry: SymbolEntryV1, k: number, options?: PortCallOptions): Promise<string[]>;
}

function rank(candidates: { id: string; score: number }[], k: number): string[] {
  candidates.sort((a, b) => b.score - a.score || compareCodepoints(a.id, b.id));
  return candidates.slice(0, k).map((hit) => hit.id);
}

export function createBruteForceNeighborSource(
  entries: readonly SymbolEntryV1[],
): NeighborSource {
  return {
    neighborsOf(entry, k) {
      const scored = entries
        .filter((other) => other.symbolId !== entry.symbolId)
        .map((other) => ({ id: other.symbolId, score: cosine(entry.centroid, other.centroid) }));
      return Promise.resolve(rank(scored, k));
    },
  };
}

export interface VectorStoreNeighborSourceInput {
  vectorStore: VectorStore;
  collection: string;
  filter: PayloadFilter;
  entriesById: ReadonlyMap<string, SymbolEntryV1>;
  oversample?: number;
}

export function createVectorStoreNeighborSource(
  input: VectorStoreNeighborSourceInput,
): NeighborSource {
  const oversample = input.oversample ?? 4;
  return {
    async neighborsOf(entry, k, options) {
      const hits = await input.vectorStore.hybridQuery(
        input.collection,
        { dense: [...entry.centroid], filter: input.filter, limit: k * oversample, withPayload: true },
        options,
      );
      const seen = new Set<string>();
      const candidates: { id: string; score: number }[] = [];
      for (const hit of hits) {
        const symbolId = hit.payload?.["symbol_id"];
        if (typeof symbolId !== "string" || symbolId === entry.symbolId || seen.has(symbolId)) {
          continue;
        }
        const other = input.entriesById.get(symbolId);
        if (other === undefined) continue;
        seen.add(symbolId);
        candidates.push({ id: symbolId, score: cosine(entry.centroid, other.centroid) });
      }
      return rank(candidates, k);
    },
  };
}
```

`index.ts`: `export * from "./neighbors.js";`

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npx vitest run packages/capability-map/src/neighbors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm -s typecheck && pnpm -s lint
git add packages/capability-map
git commit -m "feat(capability-map): Nachbarschaft brute force und ueber den Vektorspeicher"
```

---

### Task 7: Komponenten, Medoid, Kohäsion, Verteilung (`components.ts`)

**Files:**
- Create: `packages/capability-map/src/components.ts`
- Test: `packages/capability-map/src/components.test.ts`

**Interfaces:**
- Consumes: `SymbolEntryV1`, `NeighborSource`, `cosine`, `meanVector`.
- Produces:
```ts
export interface ComponentV1 { memberSymbolIds: string[]; medoidSymbolId: string; centroid: Float32Array; cohesion: number; }
export async function buildMutualNeighborGraph(entries: readonly SymbolEntryV1[], source: NeighborSource, thresholds: Pick<CapabilityThresholdsV1, "k" | "edgeThreshold">, options?: PortCallOptions): Promise<Map<string, string[]>>;  // ungerichtet, je Liste codepoint-sortiert
export function connectedComponents(entries: readonly SymbolEntryV1[], adjacency: ReadonlyMap<string, readonly string[]>): ComponentV1[];  // sortiert nach medoidSymbolId
export function sizeDistribution(sizes: readonly number[], totalSymbols: number): CapabilitySizeDistributionV1;
```

- [ ] **Step 1: Failing Test schreiben**

```ts
// packages/capability-map/src/components.test.ts
import { describe, expect, it } from "vitest";

import type { SymbolEntryV1 } from "./collect.js";
import { buildMutualNeighborGraph, connectedComponents, sizeDistribution } from "./components.js";
import { createBruteForceNeighborSource } from "./neighbors.js";
import { toFloat32 } from "./vectors.js";

function entry(symbolId: string, centroid: number[]): SymbolEntryV1 {
  return {
    symbolId,
    symbolFqn: symbolId,
    filePath: "f.ts",
    centroid: toFloat32(centroid),
    chunkCount: 1,
    cost: null,
    metricsScopeIds: [],
  };
}

// a und b dicht beieinander, c dazwischen, d orthogonal.
const ENTRIES = [
  entry("a", [1, 0]),
  entry("b", [0.98, 0.2]),
  entry("c", [0.9, 0.44]),
  entry("d", [0, 1]),
];

describe("buildMutualNeighborGraph", () => {
  it("verbindet nur gegenseitige Nachbarn oberhalb der Schwelle", async () => {
    const graph = await buildMutualNeighborGraph(ENTRIES, createBruteForceNeighborSource(ENTRIES), {
      k: 1,
      edgeThreshold: 0.9,
    });
    // a→b und b→a (gegenseitig); c→b, aber b→a; d→c, aber c→b.
    expect(Object.fromEntries(graph)).toEqual({ a: ["b"], b: ["a"], c: [], d: [] });
  });
  it("laesst eine gegenseitige Kante unter der Schwelle weg", async () => {
    const graph = await buildMutualNeighborGraph(ENTRIES, createBruteForceNeighborSource(ENTRIES), {
      k: 1,
      edgeThreshold: 0.99,
    });
    expect(graph.get("a")).toEqual([]);
  });
});

describe("connectedComponents", () => {
  it("bildet Komponenten und waehlt den Medoid am naechsten zum Zentroid", () => {
    const adjacency = new Map<string, string[]>([
      ["a", ["b", "c"]],
      ["b", ["a"]],
      ["c", ["a"]],
      ["d", []],
    ]);
    const components = connectedComponents(ENTRIES, adjacency);
    expect(components.map((c) => c.memberSymbolIds)).toEqual([["a", "b", "c"], ["d"]]);
    expect(components[0]?.medoidSymbolId).toBe("b");
    expect(components[0]?.cohesion).toBeGreaterThan(0.9);
    expect(components[1]?.cohesion).toBe(1);
  });
  it("entscheidet Medoid-Gleichstand ueber die Codepoint-Ordnung", () => {
    const twins = [entry("y", [1, 0]), entry("x", [1, 0])];
    const components = connectedComponents(twins, new Map([["x", ["y"]], ["y", ["x"]]]));
    expect(components[0]?.medoidSymbolId).toBe("x");
  });
});

describe("sizeDistribution", () => {
  it("rechnet Anzahl, Median, p90, Maximum und Anteil des groessten Clusters", () => {
    expect(sizeDistribution([1, 1, 2, 3, 13], 20)).toEqual({
      count: 5,
      median: 2,
      p90: 13,
      max: 13,
      largestShare: 0.65,
    });
  });
  it("ist bei leerer Karte 0", () => {
    expect(sizeDistribution([], 0)).toEqual({ count: 0, median: 0, p90: 0, max: 0, largestShare: 0 });
  });
});
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run packages/capability-map/src/components.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementieren**

```ts
// packages/capability-map/src/components.ts
/**
 * Schritte 3 und 4 der Karte (Spec §4.1): Kante nur bei GEGENSEITIGKEIT und
 * oberhalb `edgeThreshold`; Zusammenhangskomponenten sind die Faehigkeiten;
 * Medoid ist das Mitglied mit dem geringsten Abstand zum Zentroid, bei
 * Gleichstand die Codepoint-Ordnung.
 *
 * Bekannter Schwachpunkt (§4.2): Komponenten ketten. Deshalb liefert
 * `sizeDistribution` die Groessenverteilung, aus der die Karte `chained`
 * ableitet — sichtbar statt still.
 */
import {
  compareCodepoints,
  type CapabilitySizeDistributionV1,
  type CapabilityThresholdsV1,
  type PortCallOptions,
} from "@untangle-code/domain";

import type { SymbolEntryV1 } from "./collect.js";
import type { NeighborSource } from "./neighbors.js";
import { cosine, meanVector } from "./vectors.js";

export interface ComponentV1 {
  memberSymbolIds: string[];
  medoidSymbolId: string;
  centroid: Float32Array;
  cohesion: number;
}

export async function buildMutualNeighborGraph(
  entries: readonly SymbolEntryV1[],
  source: NeighborSource,
  thresholds: Pick<CapabilityThresholdsV1, "k" | "edgeThreshold">,
  options?: PortCallOptions,
): Promise<Map<string, string[]>> {
  const byId = new Map(entries.map((entry) => [entry.symbolId, entry]));
  const neighbors = new Map<string, Set<string>>();
  for (const entry of entries) {
    options?.signal?.throwIfAborted();
    neighbors.set(entry.symbolId, new Set(await source.neighborsOf(entry, thresholds.k, options)));
  }
  const adjacency = new Map<string, string[]>();
  for (const entry of entries) {
    const mine = neighbors.get(entry.symbolId) ?? new Set<string>();
    const mutual: string[] = [];
    for (const otherId of mine) {
      const other = byId.get(otherId);
      if (other === undefined) continue;
      if (!(neighbors.get(otherId)?.has(entry.symbolId) ?? false)) continue;
      if (cosine(entry.centroid, other.centroid) < thresholds.edgeThreshold) continue;
      mutual.push(otherId);
    }
    adjacency.set(entry.symbolId, mutual.sort(compareCodepoints));
  }
  return adjacency;
}

export function connectedComponents(
  entries: readonly SymbolEntryV1[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): ComponentV1[] {
  const byId = new Map(entries.map((entry) => [entry.symbolId, entry]));
  const seen = new Set<string>();
  const components: ComponentV1[] = [];
  for (const startId of entries.map((entry) => entry.symbolId).sort(compareCodepoints)) {
    if (seen.has(startId)) continue;
    const members: string[] = [];
    const stack = [startId];
    seen.add(startId);
    while (stack.length > 0) {
      const id = stack.pop() as string;
      members.push(id);
      for (const next of adjacency.get(id) ?? []) {
        if (!seen.has(next) && byId.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    members.sort(compareCodepoints);
    const centroid = meanVector(members.map((id) => (byId.get(id) as SymbolEntryV1).centroid));
    let medoidSymbolId = members[0] as string;
    let best = -Infinity;
    let cohesionSum = 0;
    for (const id of members) {
      const similarity = cosine((byId.get(id) as SymbolEntryV1).centroid, centroid);
      cohesionSum += similarity;
      if (similarity > best || (similarity === best && compareCodepoints(id, medoidSymbolId) < 0)) {
        best = similarity;
        medoidSymbolId = id;
      }
    }
    components.push({
      memberSymbolIds: members,
      medoidSymbolId,
      centroid,
      cohesion: members.length === 1 ? 1 : cohesionSum / members.length,
    });
  }
  return components.sort((a, b) => compareCodepoints(a.medoidSymbolId, b.medoidSymbolId));
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function sizeDistribution(
  sizes: readonly number[],
  totalSymbols: number,
): CapabilitySizeDistributionV1 {
  const sorted = [...sizes].sort((a, b) => a - b);
  const max = sorted.length === 0 ? 0 : (sorted[sorted.length - 1] ?? 0);
  return {
    count: sorted.length,
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    max,
    largestShare: totalSymbols === 0 ? 0 : max / totalSymbols,
  };
}
```

`index.ts`: `export * from "./components.js";`

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npx vitest run packages/capability-map/src/components.test.ts`
Expected: PASS (Median `[1,1,2,3,13]`: Index `ceil(2.5)-1 = 2` → 2; p90: `ceil(4.5)-1 = 4` → 13).

- [ ] **Step 5: Commit**

```bash
pnpm -s typecheck && pnpm -s lint
git add packages/capability-map
git commit -m "feat(capability-map): Gegenseitigkeitsgraph, Komponenten, Medoid und Groessenverteilung"
```

---

### Task 8: Die Karte (`map.ts`)

**Files:**
- Create: `packages/capability-map/src/map.ts`
- Test: `packages/capability-map/src/map.test.ts`, Golden-Datei `packages/capability-map/src/__golden__/small-corpus.json`

**Interfaces:**
- Consumes: Tasks 5–7; `SymbolGraphV1`, `createSymbolGraphIndex`, `DEFAULT_TEST_PATH_MARKERS` (`@untangle-code/symbol-graph`); `RestoredFileGraph`, `stronglyConnectedComponents` (`@untangle-code/file-graph`); `ExternalFindingV1`, `uuidv5`, `CAPABILITY_MAP_ALGORITHM_ID` (`@untangle-code/domain`); `encodeFloat32`.
- Produces:
```ts
export interface CapabilityMapBinding { workspaceId; repoId; refId; generationId; corpusRevisionFingerprint; embeddingProfileId }
export interface BuildCapabilityMapInput {
  points: readonly VectorPointV1[];
  neighbors: NeighborSource;
  symbolGraph: SymbolGraphV1 | null;   // null ⇒ ontologische Achse 0, Ledger "symbol_not_in_graph" je Symbol
  fileGraph: RestoredFileGraph | null;
  findings: readonly ExternalFindingV1[];
  binding: CapabilityMapBinding;
  scope: readonly string[];
  matchesScope: (filePath: string) => boolean;
  thresholds: CapabilityThresholdsV1;
  now: string;
  maxDepthCap?: number;                // Vorgabe 32
}
export function capabilityMapId(generationId: string, scope: readonly string[]): string; // uuidv5(`capability-map|${generationId}|${[...scope].sort().join("")}`)
export function cycleSignature(members: readonly string[]): string;  // sortiert, mit "|" verbunden
export async function buildCapabilityMap(input: BuildCapabilityMapInput, options?: PortCallOptions): Promise<CapabilityMapV1>;
```

Ontologische Felder je Komponente (über `createSymbolGraphIndex(symbolGraph)`; nur Bindungen mit `resolution` `exact` oder `heuristic` zählen):
- `inDegree` = Zahl der `callers(m)` aller Mitglieder `m`, deren `symbolId` kein Mitglied ist; `outDegree` analog über `callees(m)`.
- `maxDepth` = BFS-Tiefe über `callees` ab allen Mitgliedern (Ebene 0), Abbruch bei `maxDepthCap`.
- Symbol-SCCs: `stronglyConnectedComponents(nodeIds, forward)` mit `forward` = codepoint-sortierte, deduplizierte `callees` je Knoten; ein SCC zählt bei Größe > 1 oder Selbstschleife. `cyclesTouched` = Zahl zählender SCCs mit mindestens einem Mitglied. `cycleSignatures.symbol` = Signaturen aller zählenden SCCs; `cycleSignatures.file` = Signaturen von `fileGraph.metrics().cycles`.
- `testIds` = `callers(m)`-Symbol-IDs, deren Knoten-`filePath` (kleingeschrieben) einen Marker aus `DEFAULT_TEST_PATH_MARKERS` enthält; dedupliziert, sortiert.
- `externalFindingIds` = `findingId` aller `findings` mit `symbolId` unter den Mitgliedern; dedupliziert, sortiert.
- Symbol im Index, aber nicht im Symbolgraphen ⇒ Ledger `symbol_not_in_graph` mit `` `symbol ${fqn} is absent from the symbol graph of this generation` ``; ohne Symbolgraph ⇒ je Symbol `"no symbol graph was available; degrees, depth, cycles and tests are 0"`.
- `corpusCognitive` = Summe `cost.cognitive` über Einträge, wobei ein Symbol nur zählt, wenn keine seiner `metricsScopeIds` bereits gezählt wurde (globale Dedupe über `seenScopes`).
- Ledger sortiert nach `(kind, id)`.

- [ ] **Step 1: Failing Test schreiben**

```ts
// packages/capability-map/src/map.test.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExternalFindingV1, VectorPointV1 } from "@untangle-code/domain";
import { DEFAULT_CAPABILITY_THRESHOLDS } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { collectSymbolEntries } from "./collect.js";
import { buildCapabilityMap, capabilityMapId, cycleSignature } from "./map.js";
import { createBruteForceNeighborSource } from "./neighbors.js";

const BINDING = {
  workspaceId: "ws",
  repoId: "repo",
  refId: "repo:main",
  generationId: "33333333-3333-4333-8333-333333333333",
  corpusRevisionFingerprint: "a".repeat(64),
  embeddingProfileId: "b".repeat(64),
};

function point(
  id: string,
  symbolId: string,
  dense: number[],
  cognitive: number,
  filePath = `src/${symbolId}.ts`,
): VectorPointV1 {
  return {
    id,
    dense,
    payload: {
      point_type: "code_chunk",
      file_path: filePath,
      symbol_id: symbolId,
      symbol_fqn: symbolId,
      metrics_scope: "symbol",
      metrics_scope_id: `scope-${symbolId}`,
      metrics_version: "untangle-metrics-v1",
      cognitive,
      cyclomatic_classic: 1,
      cyclomatic_extended: 1,
      sloc: 5,
    },
  };
}

const POINTS = [
  point("1", "a", [1, 0, 0], 4),
  point("2", "b", [0.99, 0.1, 0], 6),
  point("3", "c", [0, 1, 0], 2),
  point("4", "t", [0, 0.99, 0.1], 1, "src/c.test.ts"),
];

type Input = Parameters<typeof buildCapabilityMap>[0];

function build(overrides: Partial<Input> = {}) {
  const points = overrides.points ?? POINTS;
  const entries = collectSymbolEntries(points, { scope: [], matchesScope: () => true }).entries;
  return buildCapabilityMap({
    points,
    neighbors: createBruteForceNeighborSource(entries),
    symbolGraph: null,
    fileGraph: null,
    findings: [],
    binding: BINDING,
    scope: [],
    matchesScope: () => true,
    thresholds: { ...DEFAULT_CAPABILITY_THRESHOLDS, k: 2, edgeThreshold: 0.9 },
    now: "2026-09-13T10:00:00.000Z",
    ...overrides,
  });
}

describe("capabilityMapId", () => {
  it("ist deterministisch aus Generation und Scope", () => {
    expect(capabilityMapId("g", ["a/**"])).toBe(capabilityMapId("g", ["a/**"]));
    expect(capabilityMapId("g", [])).not.toBe(capabilityMapId("g", ["a/**"]));
    expect(capabilityMapId("g", [])).toMatch(/^[0-9a-f-]{36}$/u);
  });
});

describe("cycleSignature", () => {
  it("sortiert und verbindet", () => {
    expect(cycleSignature(["b", "a"])).toBe("a|b");
  });
});

describe("buildCapabilityMap", () => {
  it("bildet a+b als eine Faehigkeit und c, t als Singletons", async () => {
    const map = await build();
    expect(map.capabilities.map((c) => c.memberSymbolIds)).toEqual([["a", "b"], ["c"], ["t"]]);
    expect(map.capabilities[0]?.capabilityId).toBe(`cap:${map.capabilities[0]?.medoidSymbolId ?? ""}`);
    expect(map.capabilities[0]?.cost.cognitive).toBe(10);
    expect(map.corpusCognitive).toBe(13);
    expect(map.distribution).toEqual({ count: 3, median: 1, p90: 2, max: 2, largestShare: 0.5 });
    expect(map.chained).toBe(true); // 0.5 > 0.15 — sichtbar, nicht still
    expect(map.determinism).toBe("artifact");
    expect(map.mapId).toBe(capabilityMapId(BINDING.generationId, []));
  });

  it("ohne Symbolgraph stehen alle Symbole mit Grund im Ledger und die Grade sind 0", async () => {
    const map = await build();
    expect(map.skipped.filter((s) => s.kind === "symbol_not_in_graph")).toHaveLength(4);
    expect(map.capabilities[0]?.inDegree).toBe(0);
  });

  it("haengt externe Befunde an Mitglieder, ohne eine Zahl zu aendern", async () => {
    const finding = { findingId: "f1", symbolId: "a" } as ExternalFindingV1;
    const map = await build({ findings: [finding] });
    expect(map.capabilities[0]?.externalFindingIds).toEqual(["f1"]);
    expect(map.capabilities[0]?.cost.cognitive).toBe(10);
  });

  it("uebernimmt das Ledger aus dem Sammeln", async () => {
    const orphan: VectorPointV1 = {
      id: "9",
      dense: [1, 1, 1],
      payload: { point_type: "code_chunk", file_path: "x.ts" },
    };
    const map = await build({ points: [...POINTS, orphan] });
    expect(map.skipped.some((s) => s.kind === "chunk_without_symbol" && s.id === "9")).toBe(true);
  });

  it("ist bytegleich zur goldenen Karte (Spec §9)", async () => {
    const map = await build();
    const goldenPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "__golden__",
      "small-corpus.json",
    );
    expect(JSON.stringify(map, null, 2)).toBe(readFileSync(goldenPath, "utf8"));
  });
});
```

Zweiter Testblock `describe("buildCapabilityMap mit Symbolgraph")` — baue ein `SymbolGraphV1`-Literal (Form: `packages/symbol-graph/src/types.ts:152`; Knoten nach `packages/domain/src/types/symbol.ts:30`, Kanten nach `packages/domain/src/types/symbol-graph.ts:120`; `metrics` über `computeSymbolGraphMetrics` aus `@untangle-code/symbol-graph`, `skipped` als leeres `SkipLedgerV1`) mit den Knoten `a`, `b`, `t` (`t.filePath = "src/c.test.ts"`) und exakten Kanten `t → a`, `a → b`, `b → a`. Erwartung für die Fähigkeit `[a,b]`: `testIds: ["t"]`, `inDegree: 1`, `outDegree: 0`, `cyclesTouched: 1`, `maxDepth: 0`; `map.cycleSignatures.symbol` enthält `cycleSignature(["a","b"])`; Ledger hat `symbol_not_in_graph` nur für `c`.

Golden-Datei: beim ersten grünen Lauf der übrigen Tests mit `JSON.stringify(map, null, 2)` erzeugen (kleines Skript oder `writeFileSync` einmalig im Test, dann entfernen) und einchecken; danach ist sie eingefroren.

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run packages/capability-map/src/map.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementieren**

```ts
// packages/capability-map/src/map.ts
/**
 * Die Faehigkeitskarte (Spec §4): Symbolzentroide → Gegenseitigkeitsgraph →
 * Komponenten → je Faehigkeit drei Achsen. Determinismus gilt fuer das
 * ARTEFAKT (§4.3): der Aufrufer persistiert die Karte je Generation.
 */
import {
  CAPABILITY_MAP_ALGORITHM_ID,
  compareCodepoints,
  uuidv5,
  type CapabilityMapSkipEntryV1,
  type CapabilityMapV1,
  type CapabilityThresholdsV1,
  type CapabilityV1,
  type ExternalFindingV1,
  type PortCallOptions,
  type VectorPointV1,
} from "@untangle-code/domain";
import { stronglyConnectedComponents, type RestoredFileGraph } from "@untangle-code/file-graph";
import {
  DEFAULT_TEST_PATH_MARKERS,
  createSymbolGraphIndex,
  type SymbolGraphIndex,
  type SymbolGraphV1,
} from "@untangle-code/symbol-graph";

import { collectSymbolEntries, type SymbolEntryV1 } from "./collect.js";
import { buildMutualNeighborGraph, connectedComponents, sizeDistribution } from "./components.js";
import type { NeighborSource } from "./neighbors.js";
import { encodeFloat32 } from "./vectors.js";

export interface CapabilityMapBinding {
  workspaceId: string;
  repoId: string;
  refId: string;
  generationId: string;
  corpusRevisionFingerprint: string;
  embeddingProfileId: string;
}

export interface BuildCapabilityMapInput {
  points: readonly VectorPointV1[];
  neighbors: NeighborSource;
  symbolGraph: SymbolGraphV1 | null;
  fileGraph: RestoredFileGraph | null;
  findings: readonly ExternalFindingV1[];
  binding: CapabilityMapBinding;
  scope: readonly string[];
  matchesScope: (filePath: string) => boolean;
  thresholds: CapabilityThresholdsV1;
  now: string;
  maxDepthCap?: number;
}

export function capabilityMapId(generationId: string, scope: readonly string[]): string {
  return uuidv5(`capability-map|${generationId}|${[...scope].sort(compareCodepoints).join("")}`);
}

export function cycleSignature(members: readonly string[]): string {
  return [...members].sort(compareCodepoints).join("|");
}

const RESOLVED = new Set(["exact", "heuristic"]);

function callees(index: SymbolGraphIndex, id: string): string[] {
  return index.callees(id).filter((b) => RESOLVED.has(b.resolution)).map((b) => b.symbolId);
}

function callers(index: SymbolGraphIndex, id: string): string[] {
  return index.callers(id).filter((b) => RESOLVED.has(b.resolution)).map((b) => b.symbolId);
}

function isTestPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return DEFAULT_TEST_PATH_MARKERS.some((marker) => lower.includes(marker));
}

function countingSymbolCycles(index: SymbolGraphIndex): string[][] {
  const nodeIds = index.nodes().map((node) => node.id);
  const forward = new Map<string, string[]>();
  for (const id of nodeIds) forward.set(id, [...new Set(callees(index, id))].sort(compareCodepoints));
  return stronglyConnectedComponents(nodeIds, forward).filter((component) => {
    const only = component[0] ?? "";
    return component.length > 1 || (forward.get(only)?.includes(only) ?? false);
  });
}

function maxDepthFrom(index: SymbolGraphIndex, members: readonly string[], cap: number): number {
  const seen = new Set(members);
  let frontier = [...members];
  let depth = 0;
  while (frontier.length > 0 && depth < cap) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const callee of callees(index, id)) {
        if (!seen.has(callee)) {
          seen.add(callee);
          next.push(callee);
        }
      }
    }
    if (next.length === 0) break;
    depth += 1;
    frontier = next;
  }
  return depth;
}

function dedupedCorpusCognitive(entries: readonly SymbolEntryV1[]): number {
  const seenScopes = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    if (entry.cost === null) continue;
    const fresh = entry.metricsScopeIds.filter((scopeId) => !seenScopes.has(scopeId));
    if (fresh.length === entry.metricsScopeIds.length) total += entry.cost.cognitive;
    for (const scopeId of fresh) seenScopes.add(scopeId);
  }
  return total;
}

export async function buildCapabilityMap(
  input: BuildCapabilityMapInput,
  options?: PortCallOptions,
): Promise<CapabilityMapV1> {
  const collected = collectSymbolEntries(input.points, {
    scope: input.scope,
    matchesScope: input.matchesScope,
  });
  const skipped: CapabilityMapSkipEntryV1[] = [...collected.skipped];
  const entries = collected.entries;
  const byId = new Map(entries.map((entry) => [entry.symbolId, entry]));

  const adjacency = await buildMutualNeighborGraph(entries, input.neighbors, input.thresholds, options);
  const components = connectedComponents(entries, adjacency);

  const index = input.symbolGraph === null ? null : createSymbolGraphIndex(input.symbolGraph);
  const symbolCycles = index === null ? [] : countingSymbolCycles(index);
  const cycleOf = new Map<string, number>();
  symbolCycles.forEach((component, position) => {
    for (const id of component) cycleOf.set(id, position);
  });
  for (const entry of entries) {
    if (index === null) {
      skipped.push({
        kind: "symbol_not_in_graph",
        id: entry.symbolId,
        detail: "no symbol graph was available; degrees, depth, cycles and tests are 0",
      });
    } else if (index.node(entry.symbolId) === null) {
      skipped.push({
        kind: "symbol_not_in_graph",
        id: entry.symbolId,
        detail: `symbol ${entry.symbolFqn} is absent from the symbol graph of this generation`,
      });
    }
  }

  const findingsBySymbol = new Map<string, string[]>();
  for (const finding of input.findings) {
    if (finding.symbolId === undefined) continue;
    const list = findingsBySymbol.get(finding.symbolId) ?? [];
    list.push(finding.findingId);
    findingsBySymbol.set(finding.symbolId, list);
  }

  const capabilities: CapabilityV1[] = components.map((component) => {
    const members = new Set(component.memberSymbolIds);
    const medoid = byId.get(component.medoidSymbolId) as SymbolEntryV1;
    const cost = { metricsVersion: "unknown", cognitive: 0, cyclomaticClassic: 0, cyclomaticExtended: 0, sloc: 0 };
    let membersWithoutMetrics = 0;
    let inDegree = 0;
    let outDegree = 0;
    const files = new Set<string>();
    const testIds = new Set<string>();
    const touched = new Set<number>();
    const findingIds = new Set<string>();
    for (const id of component.memberSymbolIds) {
      const entry = byId.get(id) as SymbolEntryV1;
      files.add(entry.filePath);
      if (entry.cost === null) membersWithoutMetrics += 1;
      else {
        cost.metricsVersion = entry.cost.metricsVersion;
        cost.cognitive += entry.cost.cognitive;
        cost.cyclomaticClassic += entry.cost.cyclomaticClassic;
        cost.cyclomaticExtended += entry.cost.cyclomaticExtended;
        cost.sloc += entry.cost.sloc;
      }
      for (const findingId of findingsBySymbol.get(id) ?? []) findingIds.add(findingId);
      if (index === null) continue;
      for (const caller of callers(index, id)) {
        if (!members.has(caller)) inDegree += 1;
        const node = index.node(caller);
        if (node !== null && isTestPath(node.filePath)) testIds.add(caller);
      }
      for (const callee of callees(index, id)) if (!members.has(callee)) outDegree += 1;
      const cycle = cycleOf.get(id);
      if (cycle !== undefined) touched.add(cycle);
    }
    return {
      schemaVersion: 1,
      capabilityId: `cap:${component.medoidSymbolId}`,
      medoidSymbolId: component.medoidSymbolId,
      medoidSymbolFqn: medoid.symbolFqn,
      medoidFilePath: medoid.filePath,
      centroid: encodeFloat32(component.centroid),
      dimensions: component.centroid.length,
      memberSymbolIds: component.memberSymbolIds,
      cohesion: component.cohesion,
      symbols: component.memberSymbolIds.length,
      files: [...files].sort(compareCodepoints),
      inDegree,
      outDegree,
      maxDepth:
        index === null ? 0 : maxDepthFrom(index, component.memberSymbolIds, input.maxDepthCap ?? 32),
      cyclesTouched: touched.size,
      testIds: [...testIds].sort(compareCodepoints),
      externalFindingIds: [...findingIds].sort(compareCodepoints),
      cost,
      membersWithoutMetrics,
    };
  });
  capabilities.sort((a, b) => compareCodepoints(a.capabilityId, b.capabilityId));

  const distribution = sizeDistribution(capabilities.map((c) => c.symbols), entries.length);
  const fileCycles = input.fileGraph === null ? [] : input.fileGraph.metrics().cycles;

  return {
    schemaVersion: 1,
    algorithm: CAPABILITY_MAP_ALGORITHM_ID,
    mapId: capabilityMapId(input.binding.generationId, input.scope),
    ...input.binding,
    scope: [...input.scope],
    thresholds: { ...input.thresholds },
    capabilities,
    distribution,
    chained: distribution.largestShare > input.thresholds.maxClusterShare,
    corpusCognitive: dedupedCorpusCognitive(entries),
    cycleSignatures: {
      symbol: symbolCycles.map(cycleSignature).sort(compareCodepoints),
      file: fileCycles.map((cycle) => cycleSignature(cycle)).sort(compareCodepoints),
    },
    skipped: skipped.sort(
      (a, b) => compareCodepoints(a.kind, b.kind) || compareCodepoints(a.id, b.id),
    ),
    determinism: "artifact",
    createdAt: input.now,
  };
}
```

`index.ts`: `export * from "./map.js";`

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `npx vitest run packages/capability-map/src/map.test.ts`
Expected: PASS (Golden-Datei nach dem ersten grünen Lauf der übrigen Fälle eingefroren).

- [ ] **Step 5: Commit**

```bash
pnpm -s typecheck && pnpm -s lint
git add packages/capability-map
git commit -m "feat(capability-map): die Karte — Faehigkeiten mit drei Achsen, Verteilung und Ledger"
```

---

### Task 9: Wiederfinden (`match.ts`, Spec §4.5)

**Files:**
- Create: `packages/capability-map/src/match.ts`
- Test: `packages/capability-map/src/match.test.ts`

**Interfaces:**
- Consumes: `CapabilityMapV1`, `CapabilityV1`, `LostCapabilityV1` (Task 1); `cosine`, `decodeFloat32` (Task 4).
- Produces:
```ts
export interface RecoveredCapabilityV1 { baselineCapabilityId: string; headCapabilityId: string; via: "medoid" | "centroid"; cosine: number | null; }
export interface CapabilityMatchResultV1 { recovered: RecoveredCapabilityV1[]; lost: LostCapabilityV1[]; }
export function matchCapabilities(baseline: CapabilityMapV1, head: CapabilityMapV1, matchThreshold: number): CapabilityMatchResultV1;
```

- [ ] **Step 1: Failing Test schreiben**

Test-Hilfen im Testfile:

```ts
function cap(id: string, members: string[], centroid: number[]): CapabilityV1 {
  return {
    schemaVersion: 1,
    capabilityId: `cap:${id}`,
    medoidSymbolId: id,
    medoidSymbolFqn: id,
    medoidFilePath: `src/${id}.ts`,
    centroid: encodeFloat32(toFloat32(centroid)),
    dimensions: centroid.length,
    memberSymbolIds: [...members].sort(),
    cohesion: 1,
    symbols: members.length,
    files: [],
    inDegree: 0,
    outDegree: 0,
    maxDepth: 0,
    cyclesTouched: 0,
    testIds: [],
    externalFindingIds: [],
    cost: { metricsVersion: "untangle-metrics-v1", cognitive: 1, cyclomaticClassic: 1, cyclomaticExtended: 1, sloc: 1 },
    membersWithoutMetrics: 0,
  };
}
function mapOf(capabilities: CapabilityV1[], generationId = "g1"): CapabilityMapV1 { /* wie map() in Task 1, mit capabilities und generationId */ }
```

Fälle (jeweils `matchThreshold: 0.9`):
1. **Umbenennen des Medoids:** Baseline `cap("a", ["a","b"], [1,0])`, Kopf `cap("a2", ["a2","b"], [1,0])` ⇒ `recovered: [{ baselineCapabilityId: "cap:a", headCapabilityId: "cap:a2", via: "centroid", cosine: 1 }]`, `lost: []`. (Hinweis: `b` ist Mitglied — der schnelle Weg greift nur über das MEDOID `a`, das fehlt.)
2. **Schneller Weg:** Kopf `cap("z", ["a","z"], [0,1])` ⇒ `via: "medoid"`, `headCapabilityId: "cap:z"`, `cosine: null`.
3. **Zusammenlegen:** Baseline `cap:a` `[a]` und `cap:b` `[b]`, Kopf `cap("a", ["a","b"], [1,0])` ⇒ beide via `medoid` auf `cap:a`.
4. **Verloren:** Baseline `cap:a` `[1,0]`, Kopf nur `cap("c", ["c"], [0,1])` ⇒ `lost: [{ capabilityId: "cap:a", medoidSymbolFqn: "a", lastMedoidSymbolId: "a", bestCosine: 0 }]`.
5. **Greedy-Exklusivität:** Baseline `cap:a` `[1,0]` und `cap:b` `[0.99,0.14]`; Kopf `cap("x", ["x"], [1,0])` ⇒ `cap:a` → `cap:x` via `centroid`; `cap:b` lost mit `bestCosine ≈ 0.990` (`toBeCloseTo(0.99, 2)`).
6. **Leere Kopfkarte:** `bestCosine: null`.
7. **Ordnung:** `recovered` nach `baselineCapabilityId` sortiert.

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `npx vitest run packages/capability-map/src/match.test.ts`

- [ ] **Step 3: Implementieren**

```ts
// packages/capability-map/src/match.ts
/**
 * Spec §4.5: erst der schnelle Weg ueber das Medoid-Symbol (nicht exklusiv —
 * zwei Baseline-Faehigkeiten duerfen in derselben neuen aufgehen), dann der
 * geometrische Weg (exklusiv, greedy in absteigender Aehnlichkeit; Gleichstand
 * ueber Codepoint-Ordnung der Baseline-IDs, dann der Kopf-IDs).
 */
import {
  compareCodepoints,
  type CapabilityMapV1,
  type LostCapabilityV1,
} from "@untangle-code/domain";

import { cosine, decodeFloat32 } from "./vectors.js";

export interface RecoveredCapabilityV1 {
  baselineCapabilityId: string;
  headCapabilityId: string;
  via: "medoid" | "centroid";
  cosine: number | null;
}

export interface CapabilityMatchResultV1 {
  recovered: RecoveredCapabilityV1[];
  lost: LostCapabilityV1[];
}

interface Pending {
  id: string;
  medoid: string;
  fqn: string;
  vector: Float32Array;
}

export function matchCapabilities(
  baseline: CapabilityMapV1,
  head: CapabilityMapV1,
  matchThreshold: number,
): CapabilityMatchResultV1 {
  const headBySymbol = new Map<string, string>();
  for (const capability of head.capabilities) {
    for (const member of capability.memberSymbolIds) headBySymbol.set(member, capability.capabilityId);
  }
  const headCentroids = head.capabilities.map((c) => ({
    id: c.capabilityId,
    vector: decodeFloat32(c.centroid),
  }));

  const recovered: RecoveredCapabilityV1[] = [];
  const pending: Pending[] = [];
  const ordered = [...baseline.capabilities].sort((a, b) =>
    compareCodepoints(a.capabilityId, b.capabilityId),
  );
  for (const capability of ordered) {
    const fast = headBySymbol.get(capability.medoidSymbolId);
    if (fast !== undefined) {
      recovered.push({
        baselineCapabilityId: capability.capabilityId,
        headCapabilityId: fast,
        via: "medoid",
        cosine: null,
      });
      continue;
    }
    pending.push({
      id: capability.capabilityId,
      medoid: capability.medoidSymbolId,
      fqn: capability.medoidSymbolFqn,
      vector: decodeFloat32(capability.centroid),
    });
  }

  const pairs: { baselineId: string; headId: string; cosine: number }[] = [];
  const best = new Map<string, number>();
  for (const candidate of pending) {
    for (const target of headCentroids) {
      const similarity =
        target.vector.length === candidate.vector.length
          ? cosine(candidate.vector, target.vector)
          : -1;
      best.set(candidate.id, Math.max(best.get(candidate.id) ?? -Infinity, similarity));
      if (similarity >= matchThreshold) {
        pairs.push({ baselineId: candidate.id, headId: target.id, cosine: similarity });
      }
    }
  }
  pairs.sort(
    (a, b) =>
      b.cosine - a.cosine ||
      compareCodepoints(a.baselineId, b.baselineId) ||
      compareCodepoints(a.headId, b.headId),
  );
  const assignedBaseline = new Set<string>();
  const assignedHead = new Set<string>();
  for (const pair of pairs) {
    if (assignedBaseline.has(pair.baselineId) || assignedHead.has(pair.headId)) continue;
    assignedBaseline.add(pair.baselineId);
    assignedHead.add(pair.headId);
    recovered.push({
      baselineCapabilityId: pair.baselineId,
      headCapabilityId: pair.headId,
      via: "centroid",
      cosine: pair.cosine,
    });
  }

  const lost: LostCapabilityV1[] = pending
    .filter((candidate) => !assignedBaseline.has(candidate.id))
    .map((candidate) => {
      const value = best.get(candidate.id);
      return {
        capabilityId: candidate.id,
        medoidSymbolFqn: candidate.fqn,
        lastMedoidSymbolId: candidate.medoid,
        bestCosine: value === undefined || value === -Infinity ? null : value,
      };
    });
  recovered.sort((a, b) => compareCodepoints(a.baselineCapabilityId, b.baselineCapabilityId));
  return { recovered, lost };
}
```

`index.ts`: `export * from "./match.js";`

- [ ] **Step 4: Tests grün** — `npx vitest run packages/capability-map`

- [ ] **Step 5: Commit**

```bash
pnpm -s typecheck && pnpm -s lint
git add packages/capability-map
git commit -m "feat(capability-map): Wiederfinden ueber Medoid und Zentroid"
```

---

### Task 10: Kandidaten (`propose.ts`, Spec §5)

**Files:**
- Create: `packages/capability-map/src/propose.ts`
- Test: `packages/capability-map/src/propose.test.ts`

**Interfaces:**
- Consumes: `CapabilityMapV1`, `ReduceCandidateV1` (Task 1); `cosine`, `decodeFloat32`.
- Produces:
```ts
export function proposeCandidates(map: CapabilityMapV1, options: { limit: number }): ReduceCandidateV1[];
```

Regeln:
- **Median je Symbol** = Median über `cost.cognitive / (symbols - membersWithoutMetrics)` aller Fähigkeiten mit positivem Nenner. **Median der Fähigkeitskosten** = Median über `cost.cognitive`. Median = mittleres Element der aufsteigend sortierten Liste (bei gerader Länge Mittel der beiden mittleren); leere Liste ⇒ 0.
- `redundancy`: für alle Paare `(i<j)` in codepoint-Ordnung der `capabilityId` mit gleichem `dimensions` und `cosine(centroid_i, centroid_j) ≥ redundancyThreshold` ⇒ ein Kandidat für `i` mit `partnerCapabilityId = j`, `similarity`, `direction: "merge"`, `targetSymbolIds` = Mitglieder beider (sortiert), `cost` = Kosten von `i`, `corroborated` = eine der beiden hat Befunde, `corroboratingFindingIds` = Vereinigung.
- `cost_density`: `(symbols - membersWithoutMetrics) > 0` und `cost.cognitive / (symbols - membersWithoutMetrics) ≥ densityFactor × medianPerSymbol` und `medianPerSymbol > 0` ⇒ `direction: "simplify"`, `targetSymbolIds` = Mitglieder.
- `low_cohesion`: `symbols > 1 && cohesion ≤ cohesionFloor && cost.cognitive > medianCapabilityCost` ⇒ `direction: "split"`.
- `rationale` exakt: `redundancy` → `` `Zentroid-Cosinus ${similarity.toFixed(3)} zu ${partner.medoidSymbolFqn}; zusammen ${n} Symbole, cognitive ${sum}` ``; `cost_density` → `` `cognitive ${cognitive} ueber ${measured} gemessene Symbole = ${perSymbol.toFixed(1)} je Symbol; Median je Symbol ${median.toFixed(1)}, Faktor ${factor}` ``; `low_cohesion` → `` `Kohaesion ${cohesion.toFixed(3)} <= ${floor}; cognitive ${cognitive} ueber dem Median ${median}` ``.
- Sortierung: `corroborated` (true zuerst), dann `cost.cognitive` absteigend, dann `capabilityId`, dann `signal`. Dann `slice(0, limit)`.
- Keine erwartete Ersparnis (§5).

- [ ] **Step 1: Failing Test schreiben** — Hilfe `cap()` wie in Task 9, erweitert um `cognitive`, `cohesion`, `findings: string[]`. Fälle:
  (a) zwei Fähigkeiten mit Zentroid-Cosinus 1 ⇒ genau ein `redundancy`-Kandidat, `partnerCapabilityId` gesetzt, `targetSymbolIds` = Vereinigung;
  (b) eine Fähigkeit mit cognitive 30 auf 1 Symbol neben fünf mit je 2 (paarweise orthogonale Zentroide) ⇒ `cost_density` genau für sie, `rationale` beginnt mit `"cognitive 30 ueber 1 gemessene Symbole = 30.0 je Symbol"`;
  (c) Kohäsion 0,5 bei 2 Symbolen und Kosten über Median ⇒ `low_cohesion`; Kohäsion 0,5 mit Kosten unter Median ⇒ kein Kandidat;
  (d) `corroborated` sortiert einen billigeren Kandidaten vor einen teureren;
  (e) `limit: 1` schneidet;
  (f) `cost.cognitive` eines Kandidaten ist unverändert die Fähigkeitskosten (X3).

- [ ] **Step 2: Test fehlschlagen sehen** · **Step 3: Implementieren nach den Regeln oben** (`index.ts`: `export * from "./propose.js";`) · **Step 4: Tests grün**

- [ ] **Step 5: Commit**

```bash
pnpm -s typecheck && pnpm -s lint
git add packages/capability-map
git commit -m "feat(capability-map): Kandidaten aus Redundanz, Kostendichte und Kohaesion"
```

---

### Task 11: Testbericht lesen (`test-report.ts`, L6/L7)

**Files:**
- Create: `packages/capability-map/src/test-report.ts`
- Test: `packages/capability-map/src/test-report.test.ts`

**Interfaces:**
- Consumes: `parseJUnitXml`, `FormatParseError` (`@untangle-code/extension-runtime`).
- Produces:
```ts
export interface TestReportSummaryV1 {
  testCount: number;
  failures: number;
  /** Eintraege, die der Parser nicht lesen konnte — sperren (fail-closed). */
  unreadable: string[];
}
export type TestReportRead =
  | { kind: "ok"; summary: TestReportSummaryV1 }
  | { kind: "unreadable"; reason: string };
export function readTestReport(text: string): TestReportRead;
```
Regeln: `testCount = result.entriesSeen`; `failures = result.findings.length + issues.filter(i => i.reason === "no_location").length` (ein `failure`/`error` ohne `file`-Attribut landet beim Parser als `no_location`-Issue, ist aber ein Fehlschlag); `unreadable = issues.filter(i => i.reason === "invalid_entry").map(i => `${i.rawLocation}: ${i.detail}`)`; wirft der Parser `FormatParseError` ⇒ `{ kind: "unreadable", reason: error.message }`.

- [ ] **Step 1: Failing Test schreiben** — vier XML-Strings:
  1. `<testsuites><testsuite name="s"><testcase name="a" file="x.ts"/><testcase name="b" file="x.ts"/><testcase name="c" file="x.ts"/></testsuite></testsuites>` ⇒ `{ kind: "ok", summary: { testCount: 3, failures: 0, unreadable: [] } }`;
  2. ein Testcase mit `<failure message="boom"/>` und `file` ⇒ `failures: 1`;
  3. ein Testcase mit `<error/>` ohne `file` ⇒ `failures: 1`;
  4. `<html/>` ⇒ `kind: "unreadable"`, `reason` enthält `"neither <testsuites> nor <testsuite>"`.

- [ ] **Step 2–4:** fehlschlagen sehen, implementieren (`index.ts`: `export * from "./test-report.js";`), grün.

- [ ] **Step 5: Commit** — `git commit -m "feat(capability-map): JUnit-Zusammenfassung fuer die Teststufe"`

---

### Task 12: Die Ratsche (`ratchet.ts`, Spec §6)

**Files:**
- Create: `packages/capability-map/src/ratchet.ts`
- Test: `packages/capability-map/src/ratchet.test.ts`

**Interfaces:**
- Consumes: `matchCapabilities` (Task 9), `TestReportRead` (Task 11), `RatchetVerdictV1`, `RatchetStageV1`, `QualityImprovementV1` (Task 1).
- Produces:
```ts
export interface RatchetInput {
  baseline: { map: CapabilityMapV1; testCount: number | null; testReportMissingReason?: string };
  head: {
    map: CapabilityMapV1;
    indexOutcome: "running" | "completed" | "cancelled" | "failed";
    testReport: TestReportRead | null;
  };
  removedTestsReason?: string;
}
export function judgeRatchet(input: RatchetInput): RatchetVerdictV1;
```

Stufe 1 `preconditions` — jeder Grund eigenständig, alle gesammelt:
- `head.indexOutcome !== "completed"` ⇒ `"head index generation is not completed"`
- `head.map.corpusRevisionFingerprint === ""` ⇒ `"head corpus binding is incomplete"`
- `head.map.generationId === baseline.map.generationId` ⇒ `"head generation equals baseline generation; nothing was reindexed"`
- `head.map.embeddingProfileId !== baseline.map.embeddingProfileId` ⇒ `"embedding profile changed; maps are not comparable"`
- `baseline.testCount === null` ⇒ `` `baseline test report missing: ${testReportMissingReason ?? "unknown"}` ``
- `head.testReport === null` ⇒ `"no --test-report was given for verify"`; `kind === "unreadable"` ⇒ `` `test report unreadable: ${reason}` ``; `summary.failures > 0` ⇒ `` `${failures} test failures or errors` ``; `summary.unreadable.length > 0` ⇒ `` `test report has ${n} unreadable entries` ``
- beide Testzahlen bekannt und `head < baseline` und `removedTestsReason === undefined` ⇒ `` `test count fell from ${baseline} to ${head} without --removed-tests` ``
- neue Zyklen: `head.map.cycleSignatures.symbol` minus Baseline-Menge ⇒ `` `${n} new symbol cycles: ${erste drei, mit ", "}` ``; analog `` `${n} new file cycles: …` ``.

Ist Stufe 1 `blocked`, stehen `coverage`, `target` und `improvement` auf `skipped` mit Grund `"an earlier stage blocked"`.
Stufe 2 `coverage`: `matchCapabilities(baseline.map, head.map, head.map.thresholds.matchThreshold)`; `lost.length === 0` ⇒ `passed`; sonst `blocked` mit je `` `lost capability ${id} (medoid ${fqn}, best cosine ${bestCosine === null ? "none" : bestCosine.toFixed(3)})` ``. Ist sie `blocked`, sind `target` und `improvement` `skipped`.
Stufe 3 `target`: `head.map.corpusCognitive <= baseline.map.corpusCognitive` ⇒ `passed`; sonst `blocked` mit `` `corpus cognitive rose from ${base} to ${head}` ``. Ist sie `blocked`, ist `improvement` `skipped`.
Stufe 4 `improvement` (`reported`, nie `blocked`): je `recovered`-Paar mit `headCost.cognitive < baseCost.cognitive` ein `QualityImprovementV1 { rule: "cognitive_reduced", scope: "symbol", scopeId: headCapabilityId, filePath: head.medoidFilePath, symbolFqn: head.medoidSymbolFqn, metric: "cognitive", baseValue, headValue, message: \`cognitive ${base} -> ${head} (${base - head} abgebaut)\` }`; bei `delta < 0` zusätzlich `{ rule: "corpus_cognitive_reduced", scope: "workspace", scopeId: head.map.generationId, metric: "cognitive", baseValue, headValue, message: \`corpus cognitive ${base} -> ${head} (${base - head} abgebaut)\` }`. `reasons` der Stufe: `` [`${n} improvements`] ``.
Caveats immer: `"coverage is a clustering heuristic at the named thresholds"`; bei `baseline.map.chained || head.map.chained`: `"a map is chained (largest cluster above maxClusterShare); coverage may hide merges"`; bei `removedTestsReason`: `` `tests were removed by declaration: ${reason}` ``.
`recoveredCount = recovered.length` (0, wenn `coverage` übersprungen); `lostCapabilities = lost` (leer, wenn übersprungen); `corpusCognitive = { base, head, delta: head - base }`; `thresholds = head.map.thresholds`; `verdict = stages.some(s => s.status === "blocked") ? "blocked" : "passed"`.

- [ ] **Step 1: Failing Tests (Mutationsproben, Spec §9)** — Hilfe `scenario(overrides)` baut Baseline- und Kopfkarte (Kopf: `generationId: "g2"`, gleiche `embeddingProfileId`, `corpusRevisionFingerprint: "c".repeat(64)`) mit `cap:a` (cognitive 10) und `cap:b` (cognitive 5), Baseline `testCount: 5`, Kopf `testReport: { kind: "ok", summary: { testCount: 5, failures: 0, unreadable: [] } }`, `indexOutcome: "completed"`. Fälle:
  1. identische Generation ⇒ `blocked`, `preconditions.reasons` enthält „nothing was reindexed", `coverage`/`target`/`improvement` sind `skipped`.
  2. neue Generation, alles gleich ⇒ `passed`, `improvements: []`, `recoveredCount: 2`.
  3. Kopf ohne `cap:b` ⇒ `coverage` blocked, Grund beginnt mit `lost capability cap:b`.
  4. Kopf `corpusCognitive + 1` ⇒ `target` blocked mit `corpus cognitive rose from 15 to 16`.
  5. Kopf `cap:a` cognitive 7, `corpusCognitive` 12 ⇒ `passed`, `improvements[0].message === "cognitive 10 -> 7 (3 abgebaut)"`, `improvements[1].rule === "corpus_cognitive_reduced"`.
  6. Kopf `testCount: 4` ⇒ blocked „test count fell from 5 to 4 without --removed-tests"; mit `removedTestsReason: "doppelter Test"` ⇒ passed und Caveat `tests were removed by declaration: doppelter Test`.
  7. `testReport: null` ⇒ blocked „no --test-report was given for verify".
  8. Baseline `testCount: null, testReportMissingReason: "x"` ⇒ blocked „baseline test report missing: x".
  9. Kopf `cycleSignatures.symbol: ["a|b"]` ⇒ blocked „1 new symbol cycles: a|b".
  10. `chained: true` in der Baseline ⇒ Caveat vorhanden, Urteil sonst `passed`.
  11. `indexOutcome: "running"` ⇒ blocked „head index generation is not completed".

- [ ] **Step 2–4:** fehlschlagen sehen, implementieren (`index.ts`: `export * from "./ratchet.js";`), grün.

- [ ] **Step 5: Commit** — `git commit -m "feat(capability-map): die Ratsche — vier Stufen, fail-closed"`

---

### Task 13: Sitzungsautomat (`session.ts`, Spec §3)

**Files:**
- Create: `packages/capability-map/src/session.ts`
- Test: `packages/capability-map/src/session.test.ts`
- Modify: `packages/capability-map/src/index.ts` (vollständige Exportliste)

**Interfaces:**
```ts
export class ReduceSessionTransitionError extends Error {
  readonly from: ReduceComplexitySessionStatus;
  readonly verb: string;
  constructor(from: ReduceComplexitySessionStatus, verb: string);   // message: `cannot ${verb} a session in status "${from}"`
}
export function openSession(input: { sessionId: string; workspaceId: string; goal?: string; scope: string[]; baseline: ReduceComplexityBaselineV1; now: string }): ReduceComplexitySessionV1;  // revision 0, status open, createdAt = updatedAt = now
export function withCandidates(session, candidates: ReduceCandidateV1[], now: string): ReduceComplexitySessionV1;   // open|proposed → proposed
export function withSelection(session, capabilityId: string, now: string): ReduceComplexitySessionV1;   // proposed → selected; capabilityId muss in candidates stehen, sonst Error `capability "${id}" is not among the proposed candidates`
export function withVerification(session, verification: ReduceComplexityVerificationV1, now: string): ReduceComplexitySessionV1; // selected → verified (verdict blocked) | closed (verdict passed)
export function withAbandon(session, reason: string, now: string): ReduceComplexitySessionV1;  // aus open|proposed|selected|verified → abandoned
```
Jede Übergangsfunktion gibt ein neues Objekt mit `revision + 1`, `updatedAt: now` zurück; das Eingabeobjekt bleibt unverändert. `withVerification` aus `verified` (zweiter Versuch nach `blocked`) ist **erlaubt** (`verified → verified|closed`), damit ein Agent nach einem gesperrten Urteil nachbessern und erneut verifizieren kann; ein zweites `select` bleibt verboten (Spec §3).

- [ ] **Step 1: Failing Test** — alle Übergänge der Tabelle, beide Fehlerpfade, Revision monoton, Unveränderlichkeit der Eingabe (`Object.isFrozen` nicht nötig — `toEqual` gegen Kopie), `verified` bei `blocked` und `closed` bei `passed`, erneutes `withVerification` aus `verified`, Abandon aus `open`/`proposed`/`selected`/`verified`, nicht aus `closed`/`abandoned` (Fehlermeldung wörtlich prüfen).
- [ ] **Step 2–4:** fehlschlagen sehen, implementieren, grün.
- [ ] **Step 5:** `index.ts` vollständig: `vectors`, `collect`, `neighbors`, `components`, `map`, `match`, `propose`, `test-report`, `ratchet`, `session`. Commit `feat(capability-map): Sitzungsautomat des Loops`.

---

### Task 14: CLI-Kontext und Kartenlader

**Files:**
- Create: `apps/cli/src/commands/reduce-complexity/context.ts`
- Create: `apps/cli/src/commands/reduce-complexity/map-loader.ts`
- Modify: `apps/cli/package.json` (dependency `"@untangle-code/capability-map": "workspace:*"`), `apps/cli/tsconfig.json` (Referenz `../../packages/capability-map`)
- Test: `apps/cli/src/commands/reduce-complexity/map-loader.test.ts`

**Interfaces:**
```ts
// context.ts
export interface ReduceIndexState {
  repoId: string; refId: string; generationId: string; corpusRevisionFingerprint: string;
  embeddingProfileId: string; collection: string; outcome: IndexStateOutcome;
}
export interface ReduceContext {
  workspaceId: string;
  root: string;
  state: ReduceIndexState;
  vectorStore: VectorStore;
  store: LocalReduceComplexityStore;
  symbolGraph: SymbolGraphV1 | null;
  fileGraph: RestoredFileGraph | null;
  thresholds: CapabilityThresholdsV1;
  clock: Clock;
  random: Random;
  signal: AbortSignal;
  readTextFile: (absolutePath: string) => Promise<string>;
}
export async function openReduceContext(ctx: CommandContext, args: ParsedArgs): Promise<ReduceContext>;
```
`openReduceContext`: `root = args.flags.root ? path.resolve(ctx.cwd, String(args.flags.root)) : ctx.cwd`; `loadWorkspace({ cwd: root, env: ctx.env, strict: true })`; `resolveIndexState([view.root], view.workspaceId)`: `kind !== "resolved"` ⇒ `EnvironmentError("Kein eindeutiger, vollstaendiger Indexzustand fuer dieses Repository.", "Fuehre `untangle index` aus.")`; Zustand ohne `generationId` oder `corpusRevisionFingerprint` oder `outcome !== "completed"` ⇒ `EnvironmentError("Die Korpusbindung des Index ist unvollstaendig — der Loop urteilt nicht aus Teilwissen (Spec §3).", "Fuehre `untangle index` vollstaendig aus.")`. `wireStorage(view, ctx.env)` ⇒ `vectorStore`, `collection = state.collection`. `openLocalStorage(stateRootOf(view.root), { clock: systemClock, random: systemRandom }, { signal })` ⇒ `local.reduceComplexity`. `loadGraphs({ cwd: ctx.cwd, env: ctx.env, signal, root })` in `try/catch`: `EnvironmentError` ⇒ Graphen `null` mit `note(io, …)`-Hinweis auf stderr (die Karte bleibt vollständig, ontologische Achse 0 — E4 über das Ledger); `graphs.generationId !== state.generationId` ⇒ `EnvironmentError(\`Graph-Generation ${g} passt nicht zur Index-Generation ${s}.\`, "Fuehre `untangle index` aus.")`. `thresholds`: `DEFAULT_CAPABILITY_THRESHOLDS`, überschrieben durch `UNTANGLE_CAPABILITY_EDGE_THRESHOLD` (Zahl in `(0,1)`; sonst `UsageError`), mit stderr-Hinweis. `readTextFile` = `fs.readFile(path, "utf8")`.

```ts
// map-loader.ts
export function codePointFilter(state: ReduceIndexState, workspaceId: string): PayloadFilter;
// { must: [point_type eq "code_chunk", workspace_id eq, repo_id eq, ref_id eq, generation_id eq] }
export async function scrollAllCodePoints(vectorStore: VectorStore, collection: string, filter: PayloadFilter, signal: AbortSignal): Promise<VectorPointV1[]>;  // Seiten zu 256, withVectors: true, bis nextOffset fehlt
export async function readFindingsFile(readTextFile: (p: string) => Promise<string>, absolutePath: string): Promise<ExternalFindingV1[]>;  // JSON mit top-level `findings: []` (Ausgabe von `extensions run --format=json`); sonst OperationalError mit nextStep
export interface LoadMapInput { context: ReduceContext; scope: readonly string[]; findings: readonly ExternalFindingV1[]; }
export async function loadOrBuildMap(input: LoadMapInput, io: Io): Promise<{ map: CapabilityMapV1; built: boolean }>;
```
`loadOrBuildMap`: `mapId = capabilityMapId(state.generationId, scope)`; `store.maps.get(mapId)` ⇒ `{ map, built: false }`; sonst Punkte scrollen, `entries = collectSymbolEntries(points, { scope, matchesScope })` (nur für `entriesById`), `matchesScope = (p) => matchesAnyGlob(p, scope)` aus `@untangle-code/search`, `createVectorStoreNeighborSource({ vectorStore, collection, filter, entriesById })`, `buildCapabilityMap({ … , now: clock.nowIso() })`, `store.maps.put({ ...map, revision: 0 }, { expectedRevision: null, signal })`; bei `UntangleError` mit Code `REDUCE_SESSION_CONFLICT` (ein paralleler Lauf war schneller) ⇒ erneut `get` und zurückgeben. `note(io, …)`: Punkte, Symbole, Fähigkeiten, `chained`, Ledger-Zahl, Dauer in ms.

- [ ] **Step 1: Failing Test `map-loader.test.ts`** — Kontext-Literal mit `InMemoryVectorStore` (Punkte wie Task 8 plus Filter-Payloadfelder `workspace_id`, `repo_id`, `ref_id`, `generation_id`), `LocalReduceComplexityStore` auf `mkdtemp`, `FakeClock`, `DeterministicRandom`, Graphen `null`, `thresholds` mit `k: 2`, `edgeThreshold: 0.9`. Fälle: (a) erster Aufruf baut und persistiert (`built: true`, Datei `maps/<mapId>.json` existiert); (b) zweiter Aufruf liest (`built: false`, gleiches `createdAt` trotz vorgerückter Uhr); (c) `readFindingsFile` mit `{ "findings": [] }` liefert `[]`, mit `{}` wirft `OperationalError`; (d) `scrollAllCodePoints` liefert 300 Punkte über zwei Seiten; (e) `codePointFilter` hat fünf `eq`-Bedingungen.
- [ ] **Step 2–4:** fehlschlagen sehen, implementieren, grün. `pnpm install` nach der `package.json`-Änderung.
- [ ] **Step 5: Commit** — `feat(cli): Reduce-Kontext und Kartenlader je Indexgeneration`

---

### Task 15: Die Verben und der Befehl

**Files:**
- Create: `apps/cli/src/commands/reduce-complexity/verbs.ts`, `render.ts`, `index.ts`
- Modify: `apps/cli/src/cli/args.ts` (`rejectForeignFlags` aus `commands/extensions.ts` hierher heben und dort importieren)
- Modify: `apps/cli/src/index.ts:23-66` (Import + `COMMANDS`-Eintrag nach `scanCommand`)
- Test: `apps/cli/src/commands/reduce-complexity/verbs.test.ts`; `apps/cli/src/command-wiring.test.ts` und `apps/cli/src/index.test.ts` müssen grün bleiben (prüft `index.test.ts` die Befehlsliste der Hilfe, dort `reduce-complexity` ergänzen).

**Interfaces:**
```ts
// verbs.ts — Signatur je Verb: (context: ReduceContext, io: Io, format: "text" | "json", input) => Promise<number>
export interface StartInput { scope: string[]; goal?: string; testReportPath?: string; findingsPath?: string }
export interface ProposeInput { sessionId: string; limit: number; findingsPath?: string }
export interface SelectInput { sessionId: string; capabilityId: string }
export interface VerifyInput { sessionId: string; testReportPath?: string; removedTestsReason?: string }
export interface ReportInput { sessionId: string }
export interface AbandonInput { sessionId: string; reason: string }
export function runStart(…); runPropose(…); runSelect(…); runVerify(…); runReport(…); runAbandon(…)
// render.ts
export function renderSession(session: ReduceComplexitySessionV1, map: CapabilityMapV1 | null): string[];
export function renderCandidates(candidates: readonly ReduceCandidateV1[], thresholds: CapabilityThresholdsV1): string[];
export function renderVerdict(verdict: RatchetVerdictV1): string[];
// index.ts
export const reduceComplexityCommand: Command;
```

Verhalten je Verb (Pfade relativ zu `context.root` auflösen):
- **start**: `findings = findingsPath ? readFindingsFile(...) : []`; `loadOrBuildMap({ context, scope, findings })`; Testbericht: Pfad gegeben ⇒ `readTestReport(text)`; `unreadable` ⇒ `OperationalError(\`Der Testbericht ist nicht lesbar: ${reason}\`, "JUnit-XML uebergeben, z. B. `vitest run --reporter=junit --outputFile=…`.")`; `failures > 0` ⇒ `OperationalError` („Baseline mit roten Tests ist keine Baseline"); Pfad fehlt ⇒ `testCount: null`, `testReportMissingReason: "kein --test-report bei start"`. `openSession({ sessionId: random.uuid(), workspaceId, goal, scope, baseline: { repoId, refId, generationId, corpusRevisionFingerprint, embeddingProfileId, mapId: map.mapId, corpusCognitive: map.corpusCognitive, testCount, testReportMissingReason }, now })`; `store.sessions.put(session, { expectedRevision: null, signal })`. Text: Session-ID, Generation, Fähigkeiten/Symbole, `chained`, `corpusCognitive`, Testzahl oder Grund, Schwellen, „Naechster Schritt: `untangle reduce-complexity propose <id>`". JSON: `{ session, map: { mapId, distribution, chained, corpusCognitive, thresholds, skippedCount } }`.
- **propose**: Sitzung laden (`null` ⇒ `OperationalError(\`Sitzung ${id} ist unbekannt.\`, "…report/list…")`); Karte per `store.maps.get(baseline.mapId)` (fehlt ⇒ `EnvironmentError("Die Karte der Baseline fehlt.", "Neue Sitzung mit `start`.")`); Findings optional nur zur Anzeige nicht nötig — die Karte trägt sie bereits; `candidates = proposeCandidates(map, { limit })`; `withCandidates`; `put` mit `expectedRevision: session.revision`. Text: `renderCandidates` (Rang, Signal, Richtung, Medoid, Datei, cognitive, Symbole, corroborated, Rationale) + Schwellen + nächster Schritt `select <id> --capability=<capId>`.
- **select**: `withSelection`; Text: gewählter Kandidat, dann „Aendere den Code, fuehre `untangle index` aus und dann `verify <id> --test-report=<pfad>`".
- **verify**: Sitzung laden; `context.state` ist der Kopf; Kopfkarte `loadOrBuildMap({ context, scope: session.scope, findings: [] })`; Baseline-Karte `store.maps.get(baseline.mapId)` (fehlt ⇒ `EnvironmentError`); Testbericht: Pfad ⇒ `readTestReport`, sonst `null`; `verdict = judgeRatchet({ baseline: { map, testCount, testReportMissingReason }, head: { map, indexOutcome: state.outcome, testReport }, removedTestsReason })`; `withVerification({ generationId, corpusRevisionFingerprint, mapId, verifiedAt: now, verdict, removedTestsReason })`; `put`. Text: `renderVerdict` (je Stufe Status + Gründe, verlorene Fähigkeiten, Improvements, Caveats, Schwellen). Exit `EXIT.ok` bei `passed`, `EXIT.gate` bei `blocked`.
- **report**: Sitzung laden; Text `renderSession` (Status, Baseline, Kandidatenzahl, Auswahl, Urteil falls vorhanden); JSON: die Sitzung.
- **abandon**: `withAbandon(session, reason, now)`; `put`.
- Alle Verben: `ReduceSessionTransitionError` ⇒ `UsageError(error.message, \`untangle reduce-complexity report ${id} zeigt den Zustand.\`)`; `UntangleError` mit `code === "REDUCE_SESSION_CONFLICT"` ⇒ `OperationalError("Die Sitzung wurde parallel geaendert.", "Erneut ausfuehren.")`.

`index.ts` (Befehl): `name: "reduce-complexity"`, `implementedBy: "commands/reduce-complexity/index.js"`, `summary: "Komplexitaet senken bei erhaltener Faehigkeitsabdeckung — Loop mit Ratsche"`, `usage: "untangle reduce-complexity <start|propose|select|verify|report|abandon> [sessionId] [optionen]"`. Flags: `root` (string), `format` (`text|json`), `scope` (list, „start: Globs; leer = ganzes Repository"), `goal` (string), `test-report` (string, PFAD), `removed-tests` (string, GRUND), `findings` (string, PFAD — „JSON mit `findings` aus `extensions run --format=json`"), `limit` (number, Vorgabe 10), `capability` (string, ID), `reason` (string). `ALLOWED_FLAGS` je Verb: start `root,format,scope,goal,test-report,findings`; propose `root,format,limit`; select `root,format,capability`; verify `root,format,test-report,removed-tests`; report `root,format`; abandon `root,format,reason`. Positional `sessionId` Pflicht bei allen außer `start` (sonst `UsageError`). `details`: je ein Absatz zu Spec §1 (drei Achsen), §3 (Absicht vor Änderung — warum `select` vor der Änderung liegt), L5/L7 (keine Patches, keine Testausführung; JUnit-XML des Aufrufers), §10 (Struktur und Ähnlichkeit, nicht Verhalten), Persistenz (`.untangle/reduce-complexity/`, 0600). `examples`: die fünf Aufrufe aus Spec §3. `exitCodes`: `[EXIT.ok, "Verb lief; bei verify: Ratsche bestanden."]`, `[EXIT.operational, "Sitzung unbekannt, Bericht unlesbar, Speicher warf."]`, `[EXIT.usage, "Aufruffehler oder unzulaessiger Zustandsuebergang."]`, `[EXIT.environment, "Kein vollstaendiger Index oder Korpusbindung unvollstaendig."]`, `[EXIT.gate, "verify: die Ratsche sperrt — Gruende im Urteil."]`, `[EXIT.cancelled, "Abgebrochen."]`.

- [ ] **Step 1: Failing Test `verbs.test.ts`** — Aufbau wie Task 14 (In-Memory-Kontext, Store auf `mkdtemp`, `BufferIo`; ein JUnit-XML mit 3 grünen Testcases im Temp-Verzeichnis). Fälle:
  (a) `runStart` ohne Testbericht ⇒ Exit 0, Sitzung `open`, `baseline.testCount === null`, stdout enthält die Session-ID;
  (b) `runStart` mit Testbericht ⇒ `testCount: 3`;
  (c) `runPropose` ⇒ `proposed`, `candidates.length ≥ 1` (mit `k: 2`, `edgeThreshold: 0.9`; Punkte so wählen, dass `cap:a` Kostendichte über dem Median hat — z. B. `a` cognitive 30, übrige 2);
  (d) `runSelect` mit unbekannter ID ⇒ `UsageError`; mit gültiger ⇒ `selected`;
  (e) `runVerify` gegen dieselbe Generation ⇒ Exit 5, Sitzung `verified`, `verdict.stages[0].reasons` enthält „nothing was reindexed";
  (f) `runVerify` mit im Kontext geänderter `state.generationId` (neues Kontext-Objekt, gleicher Store), Baseline ohne Testbericht ⇒ Exit 5 mit „baseline test report missing";
  (g) kompletter Durchlauf mit Testbericht bei `start` und `verify`, neue Generation, gleiche Punkte ⇒ Exit 0, Status `closed`, `recoveredCount === 3`;
  (h) `runAbandon` aus `closed` ⇒ `UsageError`; aus `open` ⇒ `abandoned`;
  (i) `runReport` mit `format: "json"` gibt die Sitzung als JSON aus (`JSON.parse(stdout).sessionId`).
- [ ] **Step 2: fehlschlagen sehen** · **Step 3: implementieren** · **Step 4:** `npx vitest run apps/cli` grün.
- [ ] **Step 5: Build und Hilfe prüfen**

Run: `pnpm -s build && node apps/cli/dist/index.js reduce-complexity --help && node apps/cli/dist/index.js --help | grep reduce-complexity`
Expected: Hilfe mit allen Verben, Flags codepoint-sortiert, Exit-Codes; Befehl in der Übersicht.

- [ ] **Step 6: Commit** — `feat(cli): untangle reduce-complexity — start, propose, select, verify, report, abandon`

---

### Task 16: Kalibrierung am eigenen Repo und Dokumentation (Spec §11)

**Files:**
- Create: `docs/REDUCE-COMPLEXITY.md`
- Modify: `README.md` (Befehlstabelle nach `untangle scan`), `docs/PARITY.md` (B30, B31, B39, Änderungsprotokoll), `docs/BUILD_PLAN.md` (Nachtrag), `docs/superpowers/specs/2026-09-08-reduce-complexity-loop-design.md` (Statuszeile)

- [ ] **Step 1: Live-Lauf mit Messprotokoll**

```bash
untangle doctor
untangle index
npx vitest run --reporter=junit --outputFile=/tmp/untangle-junit.xml
untangle reduce-complexity start --test-report=/tmp/untangle-junit.xml --format=json > /tmp/rc-start.json
```
Aus `/tmp/rc-start.json` notieren: Fähigkeiten, `distribution` (median, p90, max, largestShare), `chained`, `corpusCognitive`, Dauer, Ledger je `kind`.

Kalibrierung (§11): Kriterium `largestShare < 0.15` und Median 3–30 Symbole. Ist `chained: true`, `UNTANGLE_CAPABILITY_EDGE_THRESHOLD` in Schritten von 0,02 anheben (jede Probe mit `abandon` schließen; jede Probe erzeugt eine eigene Karte, weil die Schwellen Teil der Karte sind — dafür `capabilityMapId` in Task 8 um `thresholds.edgeThreshold` erweitern: `uuidv5(\`capability-map|${generationId}|${scope}|${edgeThreshold}\`)`, Test in Task 8 entsprechend), bis das Kriterium hält; den Wert als neuen Default in `DEFAULT_CAPABILITY_THRESHOLDS` eintragen und den Test aus Task 1 anpassen. Ist der Median < 3, `edgeThreshold` senken. Alle Messwerte in die Tabelle unten.

`propose --limit=20`: manuelle Sichtung — jeder verworfene Kandidat mit Begründung in die Doku; bei Verwerfungen `densityFactor`/`cohesionFloor` gemäß §11 anpassen und erneut messen.

Wiederfinde-Probe (§11 `matchThreshold`): eine Funktion umbenennen (z. B. `toFloat32` → `asFloat32` samt Aufrufern), `untangle index`, `verify` mit frischem JUnit ⇒ erwartet `passed`, `recoveredCount` = Fähigkeitenzahl; Umbenennung zurücknehmen. Entfernen-Probe: eine Test-Hilfsfunktion vorübergehend löschen, reindizieren ⇒ erwartet `blocked` mit `lost capability`; zurücknehmen.

- [ ] **Step 2: `docs/REDUCE-COMPLEXITY.md` schreiben** — Abschnitte: Zweck und die fünf Verben mit Beispielaufruf; Messprotokoll (Datum, Commit, Generation, Zahlen aus Step 1); Kalibrierung (Tabelle Schwelle / Startwert / gemessen / entschieden); Kandidatensichtung; Wiederfinde- und Entfernen-Probe mit Urteilen; Grenzen (§10 wörtlich: Struktur und Ähnlichkeit, nicht Verhalten; `testIds` ist Heuristik; `externalMeasurementKeys` aus Spec §4.4 fehlt, weil externe Messwerte bisher repo-weit ohne Symbolbezug sind — B26 offen; kein MCP-Tool in dieser Welle; Nachbarschaft ist ANN, Determinismus gilt für das Artefakt).

- [ ] **Step 3: README, PARITY, BUILD_PLAN, Spec-Status**

README-Zeile nach `untangle scan`: `` | `untangle reduce-complexity` | Loop aus Absicht, Kandidaten, Auswahl und fail-closed Urteil: Fähigkeitskarte aus dem Index, Ratsche über Abdeckung und cognitive. [Details](docs/REDUCE-COMPLEXITY.md). | 0 / 4 / 5 | ``. PARITY: B30 `gebaut` (Äquivalenz über Fähigkeitsabdeckung, L1 — nicht über die Symboloberfläche), B31 `gebaut`; B39 bleibt `offen` mit Vermerk „Change/Verifier/Before-after gebaut; Real-use-Feedback offen". Änderungsprotokoll: Welle 14, Datum, Zahlen aus Step 1, Vitest-Gesamtlauf. BUILD_PLAN: `## Nachtrag Welle 14 — reduce-complexity (Datum)` mit L1–L8, Abweichung von WP-90/91, Messwerten, offenen Punkten. Spec: Statuszeile → „gebaut, kalibriert am <Datum>; Kalibrierung in docs/REDUCE-COMPLEXITY.md".

- [ ] **Step 4: Vollständige Abnahme**

Run: `pnpm -s build && pnpm -s typecheck && pnpm -s lint && pnpm -s format:check && npx vitest run --maxWorkers=2 && pnpm -s check-licenses && pnpm -s check-publishable && pnpm -s e2e:smoke`
Expected: alles grün; Testzahl in PARITY eintragen.

- [ ] **Step 5: Commit**

```bash
git add docs README.md packages apps
git commit -m "feat: Welle 14 — untangle reduce-complexity, kalibriert am eigenen Repo"
```

---

## Self-Review

**Spec-Abdeckung.** §1/§2 L1–L4 → Tasks 7–9, 12 (Abdeckung semantisch, Medoid/Zentroid, Sperren, ein Paket); L5 → nirgends Patch-Erzeugung; L6/L7 → Tasks 11, 12, 15; L8 → Task 8 (`cycleSignatures` beider Graphen) + Task 12. §3 Verben/Zustände/Persistenz/Baseline-Bindung → Tasks 2, 3, 13, 14, 15. §4.1–4.6 → Tasks 5–8. §5 → Task 10. §6 → Task 12. §7 → Task 1. §8 → Tasks 12, 14, 15 (fail-closed; `EnvironmentError` bei fehlendem Store/Generation; `AbortSignal` über `PortCallOptions` in allen Port-Aufrufen und `throwIfAborted` in der Nachbarschleife). §9: goldene Karte → Task 8; Mutationsproben → Task 12; Kettenbildung → Task 8 (`chained`) + Task 12 (Caveat); Testzahl-Regel → Task 12 (6); fehlender Bericht → Task 12 (7, 8); Wiederfinden → Task 9 + Task 16 Live-Probe. §10 → Docs. §11 → Task 16 (inkl. Schwellen-Override). §12 → Docs.

**Abweichung von der Spec, bewusst:** `withVerification` erlaubt `verified → verified|closed` (erneuter `verify` nach `blocked`), damit der Agent nachbessern kann; ein zweites `select` bleibt verboten. `externalMeasurementKeys` (§4.4) entfällt, bis B26 einen Symbolbezug externer Messwerte liefert. Beides steht in `docs/REDUCE-COMPLEXITY.md`.

**Platzhalter.** Tasks 10–13 tragen Regeln und aufgezählte Testfälle statt vollständigem Code; die Regeln sind vollständig (Formeln, Meldungstexte, Übergangstabelle). Kein „TBD", kein „handle edge cases".

**Typkonsistenz.** `CapabilityCostV1` in Tasks 1, 5, 8, 10; `SymbolEntryV1` in 5–8, 14; `NeighborSource.neighborsOf(entry, k, options)` in 6–8; `LostCapabilityV1` in 1, 9, 12; `TestReportRead` in 11, 12, 15; `ReduceContext.thresholds` in 14 und 15; `StoredCapabilityMapV1` in 3 und 14; `capabilityMapId` in 8, 14, 15 (Task 16 erweitert die Signatur um die Kantenschwelle — beim Ausführen von Task 8 gleich `capabilityMapId(generationId, scope, edgeThreshold)` bauen und die Aufrufer in 14/15 entsprechend schreiben).
