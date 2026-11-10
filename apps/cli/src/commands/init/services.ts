/**
 * Probing the two pieces of infrastructure Untangle needs.
 *
 * READ-ONLY, ON PURPOSE. `HttpProbePort` can issue a GET and nothing else, so
 * `init` is structurally incapable of changing a service it finds — which is
 * what spec.md §3.2 demands of External Infrastructure mode ("Untangle DARF in
 * diesem Modus keine fremden Prozesse oder Container verändern").
 *
 * WHICH URLS ARE PROBED AT ALL IS NOT DECIDED HERE ANY MORE (WP-222). That
 * rule lives in `cli/vector-store-policy.ts` and is the SAME rule
 * `untangle doctor` obeys. It used to be written out twice — once here, once
 * (by omission) in `doctor` — and the two disagreed: `init` refused upstream's
 * default port 6333 citing spec.md §3.2, while `doctor` fell back onto it,
 * found the foreign instance living there and reported it as healthy. Two
 * commands of one tool, two answers to a safety question. One rule, one
 * file, one answer.
 *
 * NOT FINDING EITHER SERVICE IS NOT AN ERROR (WP-125): the configuration is
 * written regardless, and the command names exactly one next step.
 */

import { DEFAULT_EMBEDDING_CONFIG } from "@untangle-code/config";
import { compareCodepoints } from "@untangle-code/domain";

import { MANAGED_QDRANT_URL, qdrantProbePlan } from "../../cli/vector-store-policy.js";

import type {
  EmbeddingModelInfoV1,
  HttpProbePort,
  InitLimitsV1,
  OllamaFindingsV1,
  QdrantFindingsV1,
} from "./types.js";

/** Native Ollama probe target (spec.md §3.1). */
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

/**
 * Managed Qdrant REST port (spec.md §3.1) — re-exported, NOT redefined. The
 * value belongs to the shared policy; a second copy here is exactly how the
 * two commands drifted apart in the first place.
 */
export const DEFAULT_QDRANT_URL = MANAGED_QDRANT_URL;

interface OllamaModelDetails {
  context_length?: unknown;
  embedding_length?: unknown;
}

interface OllamaModel {
  name?: unknown;
  capabilities?: unknown;
  details?: OllamaModelDetails;
  remote_host?: unknown;
  remote_model?: unknown;
}

function isRequestedModel(name: string, requested: string): boolean {
  return name === requested || name === `${requested}:latest`;
}

export function isRemoteEmbeddingModel(model: EmbeddingModelInfoV1): boolean {
  return model.remote === true || /[:-]cloud$/iu.test(model.name);
}

/**
 * Reads the embedding candidates from `/api/tags`. Explicit capabilities
 * take precedence because chat models may also report an embedding width.
 *
 * Older or sparse responses may omit capabilities and dimensions. Keep the
 * known default and explicitly selected installed tag as probe candidates.
 * The caller still checks the selected candidate with a real embedding.
 */
export function readEmbeddingModels(
  payload: unknown,
  preferredModel?: string,
): EmbeddingModelInfoV1[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    return [];
  }
  const found: EmbeddingModelInfoV1[] = [];
  for (const raw of models as OllamaModel[]) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const name = typeof raw.name === "string" ? raw.name : undefined;
    if (name === undefined || name.length === 0) {
      continue;
    }
    const details = typeof raw.details === "object" && raw.details !== null ? raw.details : {};
    const dimensions = positiveInteger(details.embedding_length);
    const contextLength = positiveInteger(details.context_length);
    const isEmbedding = Array.isArray(raw.capabilities)
      ? raw.capabilities.includes("embedding")
      : dimensions !== undefined ||
        isRequestedModel(name, DEFAULT_EMBEDDING_CONFIG.model) ||
        (preferredModel !== undefined && isRequestedModel(name, preferredModel));
    if (!isEmbedding) {
      continue;
    }
    found.push({
      name,
      ...(dimensions === undefined ? {} : { dimensions }),
      ...(contextLength === undefined ? {} : { contextLength }),
      ...(readString(raw, "remote_host") || readString(raw, "remote_model")
        ? { remote: true }
        : {}),
    });
  }
  found.sort((a, b) => compareCodepoints(a.name, b.name));
  return found;
}

export interface ModelChoiceV1 {
  model: EmbeddingModelInfoV1;
  reason: string;
}

/**
 * Chooses one embedding model out of what the provider actually has.
 *
 * The rule, in order: the widest context window first, because a code chunk
 * that does not fit is a chunk that gets truncated; then the widest vector,
 * because that is the model with more to say; then codepoint order, so the
 * decision never depends on the order the provider happened to list its
 * models in. `preferred` (an explicit user choice) short-circuits all of it.
 *
 * Deliberately NOT "whatever the product default is called": on a machine
 * that has three embedding models and not the default one, silently falling
 * back to a name that is not installed produces a configuration that fails on
 * first use.
 */
export function chooseEmbeddingModel(
  models: readonly EmbeddingModelInfoV1[],
  preferred?: string,
): ModelChoiceV1 | undefined {
  if (models.length === 0) {
    return undefined;
  }
  if (preferred !== undefined) {
    const exact =
      models.find((model) => model.name === preferred) ??
      models.find((model) => isRequestedModel(model.name, preferred));
    if (exact !== undefined) {
      return { model: exact, reason: "explicitly requested (--embedding-model)" };
    }
  }
  const ranked = [...models].sort((a, b) => {
    const contextDelta = (b.contextLength ?? 0) - (a.contextLength ?? 0);
    if (contextDelta !== 0) {
      return contextDelta;
    }
    const dimensionDelta = (b.dimensions ?? 0) - (a.dimensions ?? 0);
    if (dimensionDelta !== 0) {
      return dimensionDelta;
    }
    return compareCodepoints(a.name, b.name);
  });
  const model = ranked[0] as EmbeddingModelInfoV1;
  return {
    model,
    reason:
      models.length === 1
        ? "the provider's only reported embedding model"
        : `largest context window among ${String(models.length)} reported embedding models`,
  };
}

export interface ProbeInput {
  http: HttpProbePort;
  limits: InitLimitsV1;
  /** `UNTANGLE_OLLAMA_URL` when set. */
  ollamaUrl: string;
  /** `UNTANGLE_QDRANT_URL` when set — probed BEFORE the managed default. */
  qdrantUrls: readonly string[];
  /** Model name from `--embedding-model`, when given. */
  preferredModel?: string;
}

/**
 * WP-228: Erreichbarkeit heisst NICHT „benutzbar".
 *
 * Bis hierher fragte `init` nur `/api/version` und `/api/tags` — zwei
 * Endpunkte, die der Indexlauf nie anfasst. Auf dem Rechner, an dem das
 * gemessen wurde, antworteten beide sofort, waehrend `/api/embed` haengte:
 * die geschriebene Konfiguration versprach einen Dienst, der keinen einzigen
 * Chunk einbetten konnte. Deshalb wird jetzt der Endpunkt geprueft, den das
 * Produkt WIRKLICH benutzt — mit kurzer Frist, und ein Fristablauf ist ein
 * Befund, keine bestandene Pruefung.
 */
export async function probeOllama(input: ProbeInput): Promise<OllamaFindingsV1> {
  const { http, limits, ollamaUrl } = input;
  const notProbed = (detail: string): OllamaFindingsV1["embedProbe"] => ({
    outcome: "not-probed",
    timeoutMs: limits.embedProbeTimeoutMs,
    detail,
  });

  const version = await http.getJson(`${trimSlash(ollamaUrl)}/api/version`, limits.probeTimeoutMs);
  if (version === null) {
    return {
      outcome: "unreachable",
      url: ollamaUrl,
      embeddingModels: [],
      embedProbe: notProbed("the provider was already unreachable"),
    };
  }
  const versionString = readString(version, "version");
  const tags = await http.getJson(`${trimSlash(ollamaUrl)}/api/tags`, limits.probeTimeoutMs);
  const embeddingModels = readEmbeddingModels(tags, input.preferredModel);
  const choice = chooseEmbeddingModel(embeddingModels, input.preferredModel);

  const embedProbe =
    choice === undefined
      ? notProbed("the provider reports no embedding model")
      : await runEmbedProbe(http, ollamaUrl, choice.model.name, limits.embedProbeTimeoutMs);

  return {
    outcome: "reachable",
    url: ollamaUrl,
    ...(versionString === undefined ? {} : { version: versionString }),
    embeddingModels,
    ...(choice === undefined ? {} : { chosenModel: choice.model, chosenReason: choice.reason }),
    embedProbe,
  };
}

/** Ein winziges Probe-Embedding, mit Frist. Wirft nie — es antwortet. */
async function runEmbedProbe(
  http: HttpProbePort,
  ollamaUrl: string,
  model: string,
  timeoutMs: number,
): Promise<OllamaFindingsV1["embedProbe"]> {
  const result = await http.probeEmbedding(trimSlash(ollamaUrl), model, timeoutMs);
  if (result.ok) {
    return { outcome: "ok", timeoutMs, dimensions: result.dimensions };
  }
  return {
    outcome: result.timedOut ? "timeout" : "failed",
    timeoutMs,
    detail: result.detail,
  };
}

export async function probeQdrant(input: ProbeInput): Promise<QdrantFindingsV1> {
  const { http, limits, qdrantUrls } = input;
  const probedUrls = [...qdrantUrls];
  // The skipped list — with its reason — comes from the shared policy, so it
  // can never claim something other than what the policy actually enforces.
  const skippedUrls = qdrantProbePlan({}).skipped.filter(
    (candidate) => !probedUrls.includes(candidate.url),
  );

  for (const url of probedUrls) {
    const payload = await http.getJson(`${trimSlash(url)}/`, limits.probeTimeoutMs);
    if (payload === null) {
      continue;
    }
    const version = readString(payload, "version");
    return {
      outcome: "reachable",
      probedUrls,
      url,
      ...(version === undefined ? {} : { version }),
      skippedUrls,
    };
  }
  return { outcome: "unreachable", probedUrls, skippedUrls };
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function readString(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
