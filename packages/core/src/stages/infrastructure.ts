/**
 * Stufe 2 des Indexlaufs (spec.md §11.1 `preparing_infrastructure`).
 *
 * Sie prueft ZUERST den Einbetter und DANN den Speicher — in dieser
 * Reihenfolge, weil die Dimension der Sammlung aus der Bereitschaftsmeldung des
 * Einbetters kommt (spec.md §9.1) und eine Sammlung mit falscher Dimension
 * hinterher nur noch von Hand zu heilen ist.
 *
 * BEIDE FEHLSCHLAEGE SIND FEHLSCHLAEGE, keine Warnungen: ein Lauf ohne
 * erreichbaren Einbetter wuerde einen leeren Index erzeugen und ihn „fertig"
 * nennen. Das ist genau der Fehler, den Welle 4 gefunden hat.
 *
 * Die zurueckgegebenen Endpunkte sind REDIGIERT (spec.md §3.2): der Einbetter
 * liefert seinen Endpunkt bereits ohne Geheimnis, die Speicher-URL wird hier
 * um etwaige Zugangsdaten gekuerzt.
 */
import { UntangleError, type EmbeddingProvider, type PortCallOptions } from "@untangle-code/domain";
import type { InfrastructureStage } from "@untangle-code/jobs";

export interface InfrastructureStageDeps {
  embedder: EmbeddingProvider;
  /** Legt Sammlung und Payload-Indexe an; typischerweise `provisionCodeCollection`. */
  provisionCollection: (options?: PortCallOptions) => Promise<void>;
  /** Basis-URL des Vektorspeichers, roh. */
  storeUrl: string;
  /** Wird nach der Bereitschaftspruefung mit der gemeldeten Dimension aufgerufen. */
  onReady?: ((dimensions: number) => void) | undefined;
}

export function createInfrastructureStage(deps: InfrastructureStageDeps): InfrastructureStage {
  return {
    async ensureReady(options?: PortCallOptions): Promise<{ endpoints: Record<string, string> }> {
      let readiness;
      try {
        readiness = await deps.embedder.ensureReady(options);
      } catch (error) {
        if (error instanceof UntangleError && error.code === "JOB_CANCELLED") throw error;
        throw new UntangleError(
          "EMBEDDING_UNAVAILABLE",
          `The embedder is not ready: ${messageOf(error)}`,
          { retryable: true, operation: "index.prepare", cause: error },
        );
      }
      deps.onReady?.(readiness.dimensions);

      try {
        await deps.provisionCollection(options);
      } catch (error) {
        if (error instanceof UntangleError) throw error;
        throw new UntangleError(
          "QDRANT_UNAVAILABLE",
          `Could not create the collection: ${messageOf(error)}`,
          { retryable: true, operation: "index.prepare", cause: error },
        );
      }

      return {
        endpoints: {
          embedding: readiness.endpoint,
          embeddingModel: readiness.model,
          vectorStore: redactUrl(deps.storeUrl),
        },
      };
    },
  };
}

/** Entfernt Benutzername und Passwort aus einer URL (spec.md §3.2). */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username !== "" || parsed.password !== "") {
      parsed.username = "";
      parsed.password = "";
      return `${parsed.origin}${parsed.pathname}`.replace(/\/$/u, "");
    }
    return url;
  } catch {
    return url;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
