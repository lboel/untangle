/**
 * OpenAPI adapter (architecture.md §20: "je Operation ein Abschnitt,
 * Operation-IDs erhalten").
 *
 * Parses the document with the package's YAML subset parser
 * (`text/yaml-lite.ts`) and emits one chunk per `paths.<path>.<method>`
 * operation, titled with the HTTP method, path and (when present)
 * `operationId` — never dropped even when absent from the title, since
 * `content` is always the exact raw YAML block, `operationId` field
 * included. A malformed document degrades to a single whole-document
 * `"openapi_parse_error"` chunk (architecture.md §22.2) rather than
 * throwing — the raw content is still fully preserved in that chunk.
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

const OPENAPI_NAME_HINT = /openapi/i;
const YAML_OR_JSON_EXTENSION = /\.(ya?ml|json)$/i;

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

function openApiDrafts(root: YamlNode | null): ChunkDraft[] {
  if (root === null || root.kind !== "map") return [];
  const drafts: ChunkDraft[] = [];

  const info = mapGet(root, "info");
  if (info !== undefined) {
    const title = scalarString(mapGet(info, "title"));
    drafts.push({
      kind: "openapi_info",
      startLine: info.startLine,
      endLine: info.endLine,
      ...(title === undefined ? {} : { title: `info: ${title}` }),
    });
  }

  const paths = mapGet(root, "paths");
  if (paths !== undefined && paths.kind === "map") {
    for (const pathEntry of paths.entries) {
      if (pathEntry.value.kind !== "map") continue;
      for (const methodEntry of pathEntry.value.entries) {
        const method = methodEntry.key.toLowerCase();
        if (!(HTTP_METHODS as readonly string[]).includes(method)) continue;
        const operationId = scalarString(mapGet(methodEntry.value, "operationId"));
        const title =
          operationId === undefined
            ? `${method.toUpperCase()} ${pathEntry.key}`
            : `${method.toUpperCase()} ${pathEntry.key} (${operationId})`;
        drafts.push({
          kind: "openapi_operation",
          startLine: methodEntry.value.startLine,
          endLine: methodEntry.value.endLine,
          title,
        });
      }
    }
  }
  return drafts;
}

function operationIdOf(chunk: ArtifactChunk): string | undefined {
  if (chunk.kind !== "openapi_operation" || chunk.title === undefined) return undefined;
  const match = /\(([^()]+)\)$/.exec(chunk.title);
  return match?.[1];
}

function draftsFor(document: ArtifactDocument): ChunkDraft[] {
  try {
    return openApiDrafts(parseYamlNode(document.content));
  } catch (error) {
    const reason = error instanceof YamlParseError ? error.message : "unknown parse error";
    return [
      wholeDocumentDraft(
        "openapi_parse_error",
        buildLineIndex(document.content),
        `parse error: ${reason}`,
      ),
    ];
  }
}

export interface OpenApiAdapterOptions {
  /** Overrides how a real skip-ledger finding surfaces from `chunk()` (default: a stderr warning) — see `coverage.ts`'s `SkipLedgerReporter`. */
  onSkipLedgerGap?: SkipLedgerReporter;
}

export function createOpenApiAdapter(options: OpenApiAdapterOptions = {}): ArtifactAdapter {
  return {
    supports(type: string, path: string): boolean {
      return (
        type === "openapi" ||
        (type === "auto" && OPENAPI_NAME_HINT.test(path) && YAML_OR_JSON_EXTENSION.test(path))
      );
    },

    async read(input: ArtifactInput): Promise<ArtifactDocument[]> {
      return buildDocuments(input, "openapi");
    },

    chunk(document: ArtifactDocument): ArtifactChunk[] {
      return buildChunksReportingSkips(
        document,
        buildLineIndex(document.content),
        draftsFor(document),
        options.onSkipLedgerGap,
      );
    },

    /**
     * Heuristic (architecture.md §20's canonical example): assumes the
     * common REST-codegen convention that a controller method is named
     * after the operation's `operationId`. No AST/symbol table is
     * consulted here — `targetId` stays unset; a later graph-linking stage
     * resolves `targetName` against real symbols, if any match.
     */
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
          note: `naming-convention guess: OpenAPI operationId "${operationId}" → a controller method of the same name`,
        });
      }
      return links;
    },
  };
}
