/**
 * Die stabile Library-Fassade aus spec.md §22.
 *
 * Dieses Modul ist absichtlich eine duenne Anwendungsgrenze. Es baut keine
 * CLI-Konfiguration und waehlt keine Adapter aus: jede bereits vorhandene
 * Faehigkeit kommt als benannter Use-Case-Port herein. Ein nicht verdrahteter
 * Port ist kein leeres Ergebnis und kein vermeintlicher Erfolg, sondern der
 * typisierte Fehler `FEATURE_UNAVAILABLE`.
 */
import type { QualityGateConfig } from "@untangle-code/config";
import {
  type ChangeEventV1,
  type ComplexitySnapshotV1,
  type JobEvent,
  type QualityGateResultV1,
  type Revision,
  type SearchRequestV1,
  type SearchResponseV1,
  type SearchResultSetV1,
  type SkipLedgerEntryV1,
  type SymbolEdgeV1,
  type SymbolNodeV1,
} from "@untangle-code/domain";
import type { ImpactResultV1 } from "@untangle-code/symbol-graph";

import { asCancellation, isAbortLikeError } from "./cancellation.js";

/** Alle einzeln verdrahtbaren Faehigkeiten der Fassade. */
export const UNTANGLE_ENGINE_CAPABILITIES = [
  "index",
  "update",
  "search",
  "getSymbol",
  "impact",
  "complexity",
  "analyzeChanges",
  "qualityGate",
] as const;

export type UntangleEngineCapability = (typeof UNTANGLE_ENGINE_CAPABILITIES)[number];

/** Nachlaufoption fuer jede potentiell lang laufende oeffentliche Methode. */
export interface EngineCallOptions {
  signal?: AbortSignal;
}

/** Gemeinsame Auswahl eines Workspace-Ausschnitts. */
export interface WorkspaceSelectionRequest {
  workspaceId: string;
  repoIds?: string[];
  refs?: string[];
}

/** Vollindex eines Workspace-Ausschnitts. */
export interface IndexRequest extends WorkspaceSelectionRequest {
  /** Erzwingt eine Neuberechnung auch fuer unveraenderte Dateien. */
  full?: boolean;
  /** Vorhandenen sicheren Checkpoint weiterverwenden; Vorgabe ist true. */
  resume?: boolean;
}

/** Inkrementelle Aktualisierung eines Workspace-Ausschnitts. */
export interface UpdateRequest extends WorkspaceSelectionRequest {
  /** Optional bekannte, workspace-relative Aenderungen; der Port darf selbst entdecken. */
  changedPaths?: string[];
}

/** Ein Symbol wird entweder ueber seine stabile ID oder seinen qualifizierten Namen gewaehlt. */
export type SymbolRequest = WorkspaceSelectionRequest &
  ({ symbolId: string; qualifiedName?: never } | { qualifiedName: string; symbolId?: never });

/** Ein gefundener Symbolkontext oder ein ausdruecklich begruendeter Fehltreffer. */
export type SymbolResponse =
  | {
      schemaVersion: 1;
      found: true;
      symbol: SymbolNodeV1;
      incoming: SymbolEdgeV1[];
      outgoing: SymbolEdgeV1[];
      warnings: string[];
    }
  | {
      schemaVersion: 1;
      found: false;
      reason: "SYMBOL_NOT_FOUND";
      detail: string;
      warnings: string[];
    };

/** Rueckwaertstraversierung ab einem oder mehreren geaenderten Symbolen. */
export interface ImpactRequest extends WorkspaceSelectionRequest {
  rootSymbolIds: string[];
  minConfidence?: number;
  limits?: {
    maxDepth: number;
    maxNodes: number;
    maxEdges: number;
    maxWallTimeMs: number;
  };
}

/** Der bestehende, erklaerbare Symbolgraph-Impactvertrag. */
export type ImpactResponse = ImpactResultV1;

/** Auswahl fuer gespeicherte Komplexitaetsmessungen. */
export interface ComplexityRequest extends WorkspaceSelectionRequest {
  filePaths?: string[];
  symbolIds?: string[];
  /** Obergrenze nach der vom Use Case gewaehlten deterministischen Sortierung. */
  limit?: number;
  includeContributions?: boolean;
}

/** Sichtbares Ergebnis einschliesslich aller ausgelassenen Bereiche. */
export interface ComplexityResponse {
  schemaVersion: 1;
  workspaceId: string;
  snapshots: ComplexitySnapshotV1[];
  skipped: SkipLedgerEntryV1[];
  truncated: boolean;
  warnings: string[];
}

/** Zwei Revisionen eines Repositories, die die Change Engine vergleichen soll. */
export interface ChangeRequest {
  workspaceId: string;
  repoId: string;
  base: Revision;
  head: Revision;
}

/**
 * Bericht der Change Engine.
 *
 * `spec.md` benennt `ChangeReportV1`, definiert aber nur seine einzelnen
 * `ChangeEventV1`-Eintraege. Die Huelle hier haelt daher nur Identitaet,
 * Abdeckung und sichtbare Einschraenkungen fest; fachliche Details bleiben in
 * den versionierten Events.
 */
export interface ChangeReportV1 {
  schemaVersion: 1;
  workspaceId: string;
  repoId: string;
  base: string;
  head: string;
  changes: ChangeEventV1[];
  analysisCoverage: {
    filesChanged: number;
    filesAnalyzed: number;
    symbolsChanged: number;
    parseFailures: number;
  };
  caveats: string[];
}

/** Der Gate-Evaluator ist rein: Bericht und wirksame Policy sind die ganze Anfrage. */
export interface QualityGateRequest {
  report: ChangeReportV1;
  policy: QualityGateConfig;
}

export interface IndexUseCasePort {
  index(request: IndexRequest, options?: EngineCallOptions): AsyncIterable<JobEvent>;
}

export interface UpdateUseCasePort {
  update(request: UpdateRequest, options?: EngineCallOptions): AsyncIterable<JobEvent>;
}

export interface SearchUseCasePort {
  search(request: SearchRequestV1, options?: EngineCallOptions): Promise<SearchResponse>;
}

export interface GetSymbolUseCasePort {
  getSymbol(request: SymbolRequest, options?: EngineCallOptions): Promise<SymbolResponse>;
}

export interface ImpactUseCasePort {
  impact(request: ImpactRequest, options?: EngineCallOptions): Promise<ImpactResponse>;
}

export interface ComplexityUseCasePort {
  complexity(request: ComplexityRequest, options?: EngineCallOptions): Promise<ComplexityResponse>;
}

export interface AnalyzeChangesUseCasePort {
  analyzeChanges(request: ChangeRequest, options?: EngineCallOptions): Promise<ChangeReportV1>;
}

export interface QualityGateUseCasePort {
  qualityGate(
    request: QualityGateRequest,
    options?: EngineCallOptions,
  ): Promise<QualityGateResultV1>;
}

/** Lebenszyklus der gemeinsam injizierten Adapter, genau einmal geschlossen. */
export interface EngineLifecyclePort {
  close(options?: EngineCallOptions): Promise<void>;
}

/** Injizierte Use Cases; jeder Eintrag ist optional und dadurch ehrlich pruefbar. */
export interface UntangleEngineOptions {
  index?: IndexUseCasePort;
  update?: UpdateUseCasePort;
  search?: SearchUseCasePort;
  getSymbol?: GetSymbolUseCasePort;
  impact?: ImpactUseCasePort;
  complexity?: ComplexityUseCasePort;
  analyzeChanges?: AnalyzeChangesUseCasePort;
  qualityGate?: QualityGateUseCasePort;
  lifecycle?: EngineLifecyclePort;
}

/** Maschinenlesbarer Fehler fuer eine nicht verdrahtete Faehigkeit. */
export class FeatureUnavailableError extends Error {
  public readonly code = "FEATURE_UNAVAILABLE" as const;
  public readonly retryable = false;

  public constructor(public readonly feature: UntangleEngineCapability) {
    super(`The Untangle capability "${feature}" is not available in this engine instance.`);
    this.name = "FeatureUnavailableError";
  }

  public toEnvelopeError(): {
    code: "FEATURE_UNAVAILABLE";
    message: string;
    retryable: false;
    details: { feature: UntangleEngineCapability };
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: { feature: this.feature },
    };
  }
}

/** Ein geschlossener Engine-Handle nimmt keine neue Arbeit mehr an. */
export class EngineClosedError extends Error {
  public readonly code = "ENGINE_CLOSED" as const;
  public readonly retryable = false;

  public constructor(public readonly operation: UntangleEngineCapability) {
    super(`The Untangle engine is closed; "${operation}" cannot be started.`);
    this.name = "EngineClosedError";
  }
}

export interface UntangleEngine {
  index(request: IndexRequest, options?: EngineCallOptions): AsyncIterable<JobEvent>;
  update(request: UpdateRequest, options?: EngineCallOptions): AsyncIterable<JobEvent>;
  search(request: SearchRequestV1, options?: EngineCallOptions): Promise<SearchResponse>;
  getSymbol(request: SymbolRequest, options?: EngineCallOptions): Promise<SymbolResponse>;
  impact(request: ImpactRequest, options?: EngineCallOptions): Promise<ImpactResponse>;
  complexity(request: ComplexityRequest, options?: EngineCallOptions): Promise<ComplexityResponse>;
  analyzeChanges(request: ChangeRequest, options?: EngineCallOptions): Promise<ChangeReportV1>;
  qualityGate(
    request: QualityGateRequest,
    options?: EngineCallOptions,
  ): Promise<QualityGateResultV1>;
  close(options?: EngineCallOptions): Promise<void>;
}

type PromiseCapability = Exclude<UntangleEngineCapability, "index" | "update">;

class DefaultUntangleEngine implements UntangleEngine {
  private closePromise: Promise<void> | undefined;
  private closing = false;

  public constructor(private readonly ports: UntangleEngineOptions) {}

  public index(request: IndexRequest, options?: EngineCallOptions): AsyncIterable<JobEvent> {
    this.assertOpen("index");
    throwIfAlreadyAborted(options?.signal, "index");
    const port = this.ports.index;
    if (port === undefined) throw new FeatureUnavailableError("index");
    try {
      return abortableIterable(port.index(request, options), options?.signal, "index");
    } catch (error) {
      throw translateCancellation(error, options?.signal, "index");
    }
  }

  public update(request: UpdateRequest, options?: EngineCallOptions): AsyncIterable<JobEvent> {
    this.assertOpen("update");
    throwIfAlreadyAborted(options?.signal, "update");
    const port = this.ports.update;
    if (port === undefined) throw new FeatureUnavailableError("update");
    try {
      return abortableIterable(port.update(request, options), options?.signal, "update");
    } catch (error) {
      throw translateCancellation(error, options?.signal, "update");
    }
  }

  public search(request: SearchRequestV1, options?: EngineCallOptions): Promise<SearchResponse> {
    return this.runPromise("search", this.ports.search, request, options);
  }

  public getSymbol(request: SymbolRequest, options?: EngineCallOptions): Promise<SymbolResponse> {
    return this.runPromise("getSymbol", this.ports.getSymbol, request, options);
  }

  public impact(request: ImpactRequest, options?: EngineCallOptions): Promise<ImpactResponse> {
    return this.runPromise("impact", this.ports.impact, request, options);
  }

  public complexity(
    request: ComplexityRequest,
    options?: EngineCallOptions,
  ): Promise<ComplexityResponse> {
    return this.runPromise("complexity", this.ports.complexity, request, options);
  }

  public analyzeChanges(
    request: ChangeRequest,
    options?: EngineCallOptions,
  ): Promise<ChangeReportV1> {
    return this.runPromise("analyzeChanges", this.ports.analyzeChanges, request, options);
  }

  public qualityGate(
    request: QualityGateRequest,
    options?: EngineCallOptions,
  ): Promise<QualityGateResultV1> {
    return this.runPromise("qualityGate", this.ports.qualityGate, request, options);
  }

  public close(options?: EngineCallOptions): Promise<void> {
    if (this.closePromise === undefined) {
      try {
        throwIfAlreadyAborted(options?.signal, "close");
        this.closing = true;
        this.closePromise = this.startClose(options);
      } catch (error) {
        return Promise.reject(translateCancellation(error, options?.signal, "close"));
      }
    }
    return waitWithAbort(this.closePromise, options?.signal, "close");
  }

  private runPromise<Operation extends PromiseCapability, Request, Response>(
    operation: Operation,
    port:
      | {
          [Key in Operation]: (request: Request, options?: EngineCallOptions) => Promise<Response>;
        }
      | undefined,
    request: Request,
    options: EngineCallOptions | undefined,
  ): Promise<Response> {
    try {
      this.assertOpen(operation);
      throwIfAlreadyAborted(options?.signal, operation);
      if (port === undefined) return Promise.reject(new FeatureUnavailableError(operation));
      const work = port[operation](request, options);
      return waitWithAbort(work, options?.signal, operation);
    } catch (error) {
      return Promise.reject(translateCancellation(error, options?.signal, operation));
    }
  }

  private async startClose(options: EngineCallOptions | undefined): Promise<void> {
    if (this.ports.lifecycle === undefined) return;
    try {
      await this.ports.lifecycle.close(options);
    } catch (error) {
      throw translateCancellation(error, options?.signal, "close");
    }
  }

  private assertOpen(operation: UntangleEngineCapability): void {
    if (this.closing) throw new EngineClosedError(operation);
  }
}

/** Erstellt die stabile Library-Fassade ohne CLI-Parsing oder Adapterwahl. */
export function createUntangle(options: UntangleEngineOptions): UntangleEngine {
  return new DefaultUntangleEngine(options);
}

/** Architektur-kompatibler Name; beide Fabriken sind dieselbe Implementierung. */
export const createUntangleEngine = createUntangle;

function throwIfAlreadyAborted(
  signal: AbortSignal | undefined,
  operation: UntangleEngineCapability | "close",
): void {
  if (signal?.aborted === true) throw asCancellation(signal.reason, operation);
}

function translateCancellation(
  error: unknown,
  signal: AbortSignal | undefined,
  operation: UntangleEngineCapability | "close",
): unknown {
  if (signal?.aborted === true || isAbortLikeError(error)) {
    return asCancellation(error, operation);
  }
  return error;
}

function waitWithAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  operation: UntangleEngineCapability | "close",
): Promise<T> {
  if (signal === undefined) {
    return work.catch((error: unknown) => {
      throw translateCancellation(error, undefined, operation);
    });
  }
  if (signal.aborted) return Promise.reject(asCancellation(signal.reason, operation));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (continuation: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      continuation();
    };
    const onAbort = (): void => {
      finish(() => reject(asCancellation(signal.reason, operation)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(translateCancellation(error, signal, operation))),
    );
  });
}

async function* abortableIterable<T>(
  iterable: AsyncIterable<T>,
  signal: AbortSignal | undefined,
  operation: UntangleEngineCapability,
): AsyncIterable<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      throwIfAlreadyAborted(signal, operation);
      const item = await waitWithAbort(Promise.resolve(iterator.next()), signal, operation);
      if (item.done === true) {
        completed = true;
        return;
      }
      yield item.value;
    }
  } catch (error) {
    throw translateCancellation(error, signal, operation);
  } finally {
    if (!completed && iterator.return !== undefined) {
      try {
        const cleanup = Promise.resolve(iterator.return());
        if (signal?.aborted === true) {
          // Ein unkooperativer Port darf die sichtbare Abbruchantwort nicht
          // durch eine haengende `return()`-Implementierung blockieren.
          void cleanup.catch(() => undefined);
        } else {
          await cleanup;
        }
      } catch {
        // Der Iterator wurde bereits verlassen. Ein Cleanup-Fehler darf den
        // eigentlichen Abschluss oder Abbruch nicht nachtraeglich ersetzen.
      }
    }
  }
}

/**
 * Produktiver Suchvertrag. §22 verwendet noch den aelteren Namen
 * `SearchResponseV1`; die Fassade konvertiert den heute vollstaendigeren
 * `SearchResultSetV1` nicht verlustbehaftet zurueck.
 */
export type SearchResponse = SearchResultSetV1;

/** Der alte §22-Vertrag bleibt als additiver Typ-Export erreichbar. */
export type { JobEvent, QualityGateResultV1, SearchRequestV1, SearchResponseV1, SearchResultSetV1 };
