import path from "node:path";

import { DEFAULT_EMBEDDING_CONFIG, DEFAULT_STORAGE_CONFIG } from "@untangle-code/config";

import { parseArgs } from "../../cli/args.js";
import type { CommandContext } from "../../cli/command.js";
import { EXIT } from "../../cli/exit.js";
import { note } from "../../cli/io.js";
import { canonicalLocalPath, loadWorkspace } from "../../cli/workspace.js";
import { indexCommand } from "../index/index.js";
import { resolveTarget } from "../index/target.js";

import { chooseEmbeddingModel, isRemoteEmbeddingModel } from "./services.js";
import type { InitResultV1 } from "./types.js";

export interface FirstIndexPlan {
  readonly root: string;
  readonly directory: string;
  readonly endpoint: string;
  readonly model: string;
  readonly dimensions: number;
}

export interface FirstIndexDeps {
  loadIndexWorkspace?: typeof loadWorkspace;
  runIndex?: typeof indexCommand.run;
}

function loopbackEndpoint(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    (url.hostname !== "localhost" &&
      url.hostname !== "[::1]" &&
      !/^127(?:\.\d{1,3}){3}$/u.test(url.hostname)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return undefined;
  return url.href.replace(/\/+$/u, "");
}

function indexDirectory(directory: string): string | undefined {
  try {
    return canonicalLocalPath(directory);
  } catch {
    return undefined;
  }
}

export function planFirstIndex(result: InitResultV1): FirstIndexPlan | undefined {
  const { root, storage, ollama } = result.findings;
  if (
    storage?.backend !== "lancedb" ||
    storage.directory === undefined ||
    storage.directoryStatus === "not-directory" ||
    storage.directoryStatus === "unreadable" ||
    ollama.outcome !== "reachable" ||
    ollama.embedProbe.outcome !== "ok" ||
    ollama.embedProbe.dimensions === undefined ||
    ollama.chosenModel === undefined ||
    isRemoteEmbeddingModel(ollama.chosenModel)
  )
    return undefined;
  const endpoint = loopbackEndpoint(ollama.url);
  const directory = indexDirectory(storage.directory);
  return endpoint === undefined || directory === undefined
    ? undefined
    : {
        root,
        directory,
        endpoint,
        model: ollama.chosenModel.name,
        dimensions: ollama.embedProbe.dimensions,
      };
}

function isShellModelName(model: string | undefined): model is string {
  return model !== undefined && /^[a-z0-9][a-z0-9._:/-]*$/iu.test(model);
}

export function firstIndexHelp(result: InitResultV1, preferredModel?: string): string {
  const { storage, ollama } = result.findings;
  const selected = ollama.chosenModel?.name ?? preferredModel;
  const model = isShellModelName(selected) ? selected : DEFAULT_EMBEDDING_CONFIG.model;
  const retry = "Run `untangle init --interactive` again when the local endpoint can embed.";
  if (storage?.directoryStatus === "not-directory" || storage?.directoryStatus === "unreadable")
    return "First index unavailable. Choose a writable directory for LanceDB and rerun setup.";
  if (loopbackEndpoint(ollama.url) === undefined)
    return `Guided indexing requires a loopback Ollama endpoint. Select a local endpoint and retry. ${retry}`;
  if (ollama.chosenModel !== undefined && isRemoteEmbeddingModel(ollama.chosenModel)) {
    const installed = chooseEmbeddingModel(
      ollama.embeddingModels.filter(
        (candidate) => !isRemoteEmbeddingModel(candidate) && isShellModelName(candidate.name),
      ),
    )?.model.name;
    const local = installed ?? DEFAULT_EMBEDDING_CONFIG.model;
    const pull = installed === undefined ? `Run \`ollama pull ${local}\`, then run` : "Run";
    return `Guided indexing requires a local embedding model. ${pull} \`untangle init --interactive --embedding-model=${local}\`.`;
  }
  if (ollama.outcome !== "reachable")
    return `First index unavailable. Install Ollama from https://ollama.com/download if needed, start the Ollama app or run \`ollama serve\`, then run \`ollama pull ${model}\` in another terminal. ${retry}`;
  if (ollama.chosenModel === undefined)
    return `Ollama is running but has no selected embedding model. Run \`ollama pull ${model}\`. ${retry}`;
  return `First index unavailable. Check ${ollama.chosenModel.name} with \`ollama list\` and pull it again if needed with \`ollama pull ${model}\`. ${retry}`;
}

function localEmbeddingFetch(endpoint: string): typeof fetch {
  const origin = new URL(endpoint).origin;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== origin)
      throw new Error("Guided indexing can only use the approved local Ollama endpoint.");
    return fetch(input, { ...init, redirect: "error" });
  };
}

/** Run the normal index command using the same effective config that passed the checks. */
export async function startFirstIndex(
  ctx: CommandContext,
  approved: FirstIndexPlan,
  result: InitResultV1,
  deps: FirstIndexDeps,
): Promise<number> {
  ctx.signal.throwIfAborted();
  const current = planFirstIndex(result);
  const stale = (): number => {
    note(
      ctx.io,
      "Setup applied, but the first index did not start because the approved project, storage or Ollama settings changed. Review the effective settings with `untangle doctor` and rerun `untangle init --interactive`.",
    );
    return EXIT.environment;
  };
  if (
    current === undefined ||
    current.root !== approved.root ||
    current.directory !== approved.directory ||
    current.endpoint !== approved.endpoint ||
    current.model !== approved.model ||
    current.dimensions !== approved.dimensions
  )
    return stale();

  const workspace = (deps.loadIndexWorkspace ?? loadWorkspace)({
    cwd: approved.root,
    env: ctx.env,
    strict: true,
  });
  const { storage, embeddings, repositories } = workspace.config;
  const storagePath = storage.path ?? DEFAULT_STORAGE_CONFIG.path;
  if (
    storage.backend !== "lancedb" ||
    storagePath === undefined ||
    indexDirectory(path.resolve(workspace.root, storagePath)) !== approved.directory ||
    embeddings.provider !== "ollama" ||
    embeddings.mode !== "external" ||
    loopbackEndpoint(embeddings.url) !== approved.endpoint ||
    embeddings.model !== approved.model ||
    embeddings.dimensions !== approved.dimensions ||
    (repositories?.length ?? 0) > 1
  )
    return stale();

  const target = resolveTarget({
    config: workspace.config,
    cwd: ctx.cwd,
    rootFlag: approved.root,
    repoFlag: undefined,
    refFlag: undefined,
    configBaseDir: workspace.load.sources.configBaseDir,
  });
  if (target.rootPath !== approved.root) return stale();
  ctx.signal.throwIfAborted();

  const args = parseArgs([`--root=${approved.root}`, "--embedder=auto"], indexCommand.spec.flags);
  const io = { out: (text: string) => ctx.io.err(text), err: (text: string) => ctx.io.err(text) };
  note(ctx.io, `Building the LanceDB index at ${approved.directory} with local Ollama.`);
  return (deps.runIndex ?? indexCommand.run)({ ...ctx, io }, args, {
    workspace,
    embeddingFetch: localEmbeddingFetch(approved.endpoint),
  });
}
