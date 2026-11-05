/**
 * Kubernetes YAML adapter (architecture.md §20: "je Dokument eine
 * Ressource, apiVersion/kind/name erhalten").
 *
 * Each `---`-separated YAML document in the file becomes exactly one
 * chunk, kind `"kubernetes_resource"`, spanning that document's full line
 * range — Kubernetes manifests are not sectioned further, since a
 * Deployment's `spec.template` is meaningless read apart from its
 * `metadata`. A document whose YAML fails to parse still gets its full raw
 * span turned into a chunk (kind `"kubernetes_resource_parse_error"`, title
 * carries the reason) rather than aborting the whole file: one malformed
 * manifest in a directory of many must not hide the rest (architecture.md
 * §22.2's cross-repo-search principle, applied at document granularity).
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
  splitYamlDocuments,
  YamlParseError,
} from "../text/yaml-lite.js";

import type { ChunkDraft, SkipLedgerReporter } from "./shared.js";
import { buildChunksReportingSkips, buildDocuments } from "./shared.js";

const YAML_EXTENSION = /\.ya?ml$/i;
const COMPOSE_FILENAME = /(^|\/)(docker-)?compose\.ya?ml$/i;

function kubernetesDrafts(content: string): ChunkDraft[] {
  return splitYamlDocuments(content).map((span): ChunkDraft => {
    try {
      const root = parseYamlNode(span.text);
      const apiVersion = scalarString(mapGet(root, "apiVersion"));
      const kind = scalarString(mapGet(root, "kind"));
      const name = scalarString(mapGet(mapGet(root, "metadata"), "name"));
      const title =
        [apiVersion, kind].filter((part) => part !== undefined).join("/") +
        (name === undefined ? "" : ` ${name}`);
      return {
        kind: "kubernetes_resource",
        startLine: span.startLine,
        endLine: span.endLine,
        ...(title.trim().length === 0 ? {} : { title: title.trim() }),
      };
    } catch (error) {
      const reason = error instanceof YamlParseError ? error.message : "unknown parse error";
      return {
        kind: "kubernetes_resource_parse_error",
        startLine: span.startLine,
        endLine: span.endLine,
        title: `parse error: ${reason}`,
      };
    }
  });
}

export interface KubernetesAdapterOptions {
  /** Overrides how a real skip-ledger finding surfaces from `chunk()` (default: a stderr warning) — see `coverage.ts`'s `SkipLedgerReporter`. */
  onSkipLedgerGap?: SkipLedgerReporter;
}

export function createKubernetesAdapter(options: KubernetesAdapterOptions = {}): ArtifactAdapter {
  return {
    supports(type: string, path: string): boolean {
      // "auto" detection only claims .yaml/.yml files that are not a
      // Compose file (see docker.ts) — every other ambiguous case (a plain
      // config .yaml, an OpenAPI/AsyncAPI file without a name hint) should
      // be configured with an explicit `type`, since path alone cannot
      // disambiguate them (spec.md §19.1's `supports` has no content
      // access — see README "Entscheidungen").
      return (
        type === "kubernetes" ||
        (type === "auto" && YAML_EXTENSION.test(path) && !COMPOSE_FILENAME.test(path))
      );
    },

    async read(input: ArtifactInput): Promise<ArtifactDocument[]> {
      return buildDocuments(input, "kubernetes");
    },

    chunk(document: ArtifactDocument): ArtifactChunk[] {
      return buildChunksReportingSkips(
        document,
        buildLineIndex(document.content),
        kubernetesDrafts(document.content),
        options.onSkipLedgerGap,
      );
    },

    links(): ArtifactLink[] {
      return [];
    },
  };
}
