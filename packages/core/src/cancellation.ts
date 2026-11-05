/**
 * Die Uebersetzung „abgebrochen" an der Naht zwischen Adaptern und Laeufer.
 *
 * DAS PROBLEM, DAS SIE LOEST — und es war ein echtes: Der `IndexJobRunner`
 * unterscheidet Abbruch von Fehlschlag ausschliesslich am Fehler-CODE. Nur ein
 * `UntangleError` mit `JOB_CANCELLED` fuehrt auf den Abbruchpfad
 * (Checkpoint speichern, `job_cancelled`, Exit-Code 130); alles andere ist ein
 * Fehlschlag. Die Adapter darunter werfen aber, was ihre Laufzeit wirft: die
 * HTTP-Schicht wirft eine `DOMException` namens `AbortError` („The operation
 * was aborted"), das Dateisystem ebenso. Ohne Uebersetzung meldete ein STRG-C
 * mitten im Lauf `INDEX_INCOMPLETE` und Exit-Code 1 — also einen DEFEKT, wo
 * der Nutzer selbst abgebrochen hat. Gemessen, nicht vermutet.
 *
 * Die Uebersetzung sitzt hier und nicht in jeder Stufe einzeln, weil sie sonst
 * an genau der Stelle fehlen wuerde, an der sie das naechste Mal gebraucht
 * wird. Sie behauptet nie einen Abbruch, den es nicht gab: sie greift NUR,
 * wenn das Signal tatsaechlich ausgeloest hat oder der Fehler sich selbst als
 * Abbruch bezeichnet.
 */
import { isUntangleError, UntangleError, type PortCallOptions } from "@untangle-code/domain";
import type { IndexJobStages } from "@untangle-code/jobs";

/** True, wenn dieser Fehler ein Abbruch IST (nicht: sein koennte). */
export function isAbortLikeError(error: unknown): boolean {
  if (isUntangleError(error)) return error.code === "JOB_CANCELLED";
  if (error instanceof Error) return error.name === "AbortError";
  // `DOMException` ist in Node eine Error-Unterklasse; der Zweig darunter
  // faengt Umgebungen ab, in denen sie es nicht ist.
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/** Macht aus einem Abbruch den Fehler, den der Laeufer als Abbruch erkennt. */
export function asCancellation(error: unknown, operation: string): unknown {
  if (isUntangleError(error) && error.code === "JOB_CANCELLED") return error;
  return new UntangleError("JOB_CANCELLED", `The run was cancelled during "${operation}".`, {
    retryable: false,
    operation,
    cause: error,
  });
}

/**
 * Fuehrt `work` aus und uebersetzt einen Abbruch. Ein Fehler, der KEIN Abbruch
 * ist, geht unveraendert weiter — ein Abbruch waere hier die bequeme Luege,
 * die einen echten Defekt als Nutzerabbruch tarnt.
 */
async function guard<T>(
  operation: string,
  options: PortCallOptions | undefined,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (options?.signal?.aborted === true || isAbortLikeError(error)) {
      throw asCancellation(error, operation);
    }
    throw error;
  }
}

/** Legt die Uebersetzung um JEDE Stufe des Jobs. */
export function withCancellationTranslation(stages: IndexJobStages): IndexJobStages {
  return {
    infrastructure: {
      ensureReady: (options) =>
        guard("index.prepare", options, () => stages.infrastructure.ensureReady(options)),
    },
    discovery: {
      discover: (options) =>
        guard("index.discover", options, () => stages.discovery.discover(options)),
    },
    analysis: {
      analyze: (file, options) =>
        guard("index.analyze", options, () => stages.analysis.analyze(file, options)),
    },
    embedding: {
      embedBatch: (batch, options) =>
        guard("index.embed", options, () => stages.embedding.embedBatch(batch, options)),
    },
    storage: {
      upsertBatch: (batch, options) =>
        guard("index.store", options, () => stages.storage.upsertBatch(batch, options)),
    },
    graphs: {
      buildGraphs: (options) =>
        guard("index.graphs", options, () => stages.graphs.buildGraphs(options)),
    },
    ...(stages.context === undefined
      ? {}
      : {
          context: {
            indexContext: (options) =>
              guard("index.context", options, () =>
                (stages.context as NonNullable<IndexJobStages["context"]>).indexContext(options),
              ),
          },
        }),
    commit: {
      commit: (input, options) =>
        guard("index.commit", options, () => stages.commit.commit(input, options)),
    },
  };
}
