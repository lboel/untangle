import { stat } from "node:fs/promises";

import { OFFLINE_EMBEDDING_PROFILE } from "@untangle-code/core";
import { buildEmbeddingProfileId, embeddingProfileShortId } from "@untangle-code/domain";
import { codeCollectionName } from "@untangle-code/storage-qdrant";

import type { IndexStateResolution } from "../cli/index-state.js";
import type { StorageWiring, WorkspaceView } from "../cli/workspace.js";

import type { CheckResult } from "./doctor.js";

/** Diagnose the same single current embedding space that automatic local queries select. */
export function selectLanceIndexProfile(
  view: WorkspaceView,
  wiring: StorageWiring,
  resolution: IndexStateResolution,
):
  | { view: WorkspaceView; collection: string; embedder: "service" | "offline" }
  | { check: CheckResult } {
  if (resolution.kind === "none")
    return { view, collection: wiring.codeCollection, embedder: "service" };
  const fail = (detail: string): { check: CheckResult } => ({
    check: {
      id: "index-profile",
      title: "Current local index profile",
      status: "fail",
      detail,
      nextStep:
        "Rerun the affected indexing job with one embedding profile before retrying `untangle doctor`.",
    },
  });
  if (resolution.kind === "invalid")
    return fail(
      `The local index state is invalid; no embedding profile was guessed. ${resolution.diagnostics.map((item) => `${item.path}: ${item.message}`).join("; ")}`,
    );
  if (resolution.kind === "ambiguous")
    return fail(
      "Current local repository/ref states use different embedders; no profile was guessed.",
    );
  if (
    new Set(
      resolution.current.map(({ state }) => `${state.embeddingProfileId}:${state.collection}`),
    ).size !== 1
  )
    return fail(
      "Current local repository/ref states use different embedding profiles or collections; no partial profile was chosen.",
    );
  const state = resolution.found.state;
  if (resolution.current.some(({ state }) => state.outcome !== "completed"))
    return fail(
      "The current local indexing run did not complete. Existing points do not prove a usable completed index.",
    );
  let selectedView = view;
  if (state.embedder === "offline") {
    const profileId = buildEmbeddingProfileId(OFFLINE_EMBEDDING_PROFILE);
    selectedView = {
      ...view,
      profile: OFFLINE_EMBEDDING_PROFILE,
      profileId,
      profileShortId: embeddingProfileShortId(profileId),
    };
  }
  const collection = codeCollectionName(wiring.collectionPrefix, selectedView.profileShortId);
  if (state.embeddingProfileId !== selectedView.profileId || state.collection !== collection)
    return fail(
      "The current local index profile does not match the configured service or the supported offline profile; it was not silently adopted.",
    );
  return { view: selectedView, collection, embedder: state.embedder };
}

/** A local storage diagnosis must not open a database merely to discover a missing directory. */
export async function inspectLanceDirectory(
  directory: string,
  signal: AbortSignal,
): Promise<{
  check: CheckResult;
  exists: boolean;
}> {
  signal.throwIfAborted();
  try {
    const info = await stat(directory);
    signal.throwIfAborted();
    if (!info.isDirectory())
      return {
        exists: false,
        check: {
          id: "lancedb",
          title: "LanceDB",
          status: "fail",
          detail: `The local storage path is not a directory: ${directory}.`,
          nextStep: "Set storage.path to an accessible local directory before indexing.",
          facts: { backend: "lancedb", path: directory, directoryExists: false },
        },
      };
    return {
      exists: true,
      check: {
        id: "lancedb",
        title: "LanceDB",
        status: "ok",
        detail: `Local storage directory exists at ${directory}. No database service is required.`,
        facts: { backend: "lancedb", path: directory, directoryExists: true },
      },
    };
  } catch (error) {
    signal.throwIfAborted();
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      exists: false,
      check: {
        id: "lancedb",
        title: "LanceDB",
        status: missing ? "ok" : "fail",
        detail: missing
          ? `Local storage is configured at ${directory}; its directory has not been created. Doctor created no files.`
          : `Cannot inspect local storage directory ${directory}: ${error instanceof Error ? error.message : String(error)}.`,
        ...(missing
          ? {}
          : { nextStep: "Check read permissions for storage.path and rerun `untangle doctor`." }),
        facts: { backend: "lancedb", path: directory, directoryExists: false },
      },
    };
  }
}
