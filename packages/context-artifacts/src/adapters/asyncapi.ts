/**
 * AsyncAPI adapter (architecture.md §20: "je Channel ein Abschnitt,
 * Operation-IDs erhalten").
 *
 * AsyncAPI v2's shape (`channels.<channel>.subscribe`/`.publish`, each
 * optionally carrying `operationId`) is what this adapter targets — one
 * chunk per channel operation, kind `"asyncapi_operation"`, titled
 * `"<channel> <subscribe|publish> (<operationId>)"`. A channel with
 * neither `subscribe` nor `publish` (rare, but not invalid AsyncAPI) still
 * gets a whole-channel `"asyncapi_channel"` chunk rather than being
 * dropped. Malformed documents degrade the same way `openapi.ts` does.
 */
import type {
  ArtifactAdapter,
  ArtifactChunk,
  ArtifactDocument,
  ArtifactInput,
  ArtifactLink,
} from "@untangle-code/domain";

import { buildLineIndex } from "../text/line-index.js";
import {
  mapGet,
  parseYamlNode,
  scalarString,
  YamlParseError,
  type YamlNode,
} from "../text/yaml-lite.js";

import type { ChunkDraft, SkipLedgerReporter } from "./shared.js";
import {
  buildChunks,
  buildChunksReportingSkips,
  buildDocuments,
  wholeDocumentDraft,
} from "./shared.js";

const ASYNCAPI_NAME_HINT = /asyncapi/i;
const YAML_OR_JSON_EXTENSION = /\.(ya?ml|json)$/i;

const OPERATION_KEYS = ["subscribe", "publish"] as const;

function asyncApiDrafts(root: YamlNode | null): ChunkDraft[] {
  if (root === null || root.kind !== "map") return [];
  const drafts: ChunkDraft[] = [];
  const channels = mapGet(root, "channels");
  if (channels === undefined || channels.kind !== "map") return drafts;

  for (const channelEntry of channels.entries) {
    if (channelEntry.value.kind !== "map") continue;
    let foundOperation = false;
    for (const operationKey of OPERATION_KEYS) {
      const operation = mapGet(channelEntry.value, operationKey);
      if (operation === undefined) continue;
      foundOperation = true;
      const operationId = scalarString(mapGet(operation, "operationId"));
      const title =
        operationId === undefined
          ? `${channelEntry.key} ${operationKey}`
          : `${channelEntry.key} ${operationKey} (${operationId})`;
      drafts.push({
        kind: "asyncapi_operation",
        startLine: operation.startLine,
        endLine: operation.endLine,
        title,
      });
    }
    if (!foundOperation) {
      drafts.push({
        kind: "asyncapi_channel",
        startLine: channelEntry.value.startLine,
        endLine: channelEntry.value.endLine,
        title: channelEntry.key,
      });
    }
  }
  return drafts;
}

function operationIdOf(chunk: ArtifactChunk): string | undefined {
  if (chunk.kind !== "asyncapi_operation" || chunk.title === undefined) return undefined;
  const match = /\(([^()]+)\)$/.exec(chunk.title);
  return match?.[1];
}

function draftsFor(document: ArtifactDocument): ChunkDraft[] {
  try {
    return asyncApiDrafts(parseYamlNode(document.content));
  } catch (error) {
    const reason = error instanceof YamlParseError ? error.message : "unknown parse error";
    return [
      wholeDocumentDraft(
        "asyncapi_parse_error",
        buildLineIndex(document.content),
        `parse error: ${reason}`,
      ),
    ];
  }
}

export interface AsyncApiAdapterOptions {
  /** Overrides how a real skip-ledger finding surfaces from `chunk()` (default: a stderr warning) — see `coverage.ts`'s `SkipLedgerReporter`. */
  onSkipLedgerGap?: SkipLedgerReporter;
}

export function createAsyncApiAdapter(options: AsyncApiAdapterOptions = {}): ArtifactAdapter {
  return {
    supports(type: string, path: string): boolean {
      return (
        type === "asyncapi" ||
        (type === "auto" && ASYNCAPI_NAME_HINT.test(path) && YAML_OR_JSON_EXTENSION.test(path))
      );
    },

    async read(input: ArtifactInput): Promise<ArtifactDocument[]> {
      return buildDocuments(input, "asyncapi");
    },

    chunk(document: ArtifactDocument): ArtifactChunk[] {
      return buildChunksReportingSkips(
        document,
        buildLineIndex(document.content),
        draftsFor(document),
        options.onSkipLedgerGap,
      );
    },

    /** Heuristic, same convention as the OpenAPI adapter's `operationId` link. */
    links(document: ArtifactDocument): ArtifactLink[] {
      const chunks = buildChunks(document, buildLineIndex(document.content), draftsFor(document));
      const links: ArtifactLink[] = [];
      for (const chunk of chunks) {
        const operationId = operationIdOf(chunk);
        if (operationId === undefined) continue;
        links.push({
          fromChunkId: chunk.chunkId,
          targetKind: "symbol",
          targetName: operationId,
          heuristic: true,
          confidence: 0.5,
          note: `naming-convention guess: AsyncAPI operationId "${operationId}" → a handler method of the same name`,
        });
      }
      return links;
    },
  };
}
